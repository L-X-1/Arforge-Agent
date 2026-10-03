import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolOutput,
  isContextOverflowFailure,
  type Model as LLMModel,
  type ProviderErrorEvent,
  type Usage,
} from "@arforge-ai/llm"
import { Cause, DateTime, Effect, Exit, Fiber, FiberSet, Layer, Option, Ref, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { ActionGateway } from "../../action-gateway"
import { BackgroundJob } from "../../background-job"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { SkillV2 } from "../../skill"
import { ReferenceGuidance } from "../../reference/guidance"
import { GoalGuidance } from "../../goal/guidance"
import { GoalV2 } from "../../goal"
import { PersonalJobV2 } from "../../personal-job"
import { ToolRegistry } from "../../tool/registry"
import { StructuredOutput } from "../../tool/structured-output"
import { TurnToolCarrier } from "../../tool/turn-carrier"
import type { Tool } from "../../tool/tool"
import { DeferredTools } from "../../tool/deferred"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionCompactionCheckpoint } from "../compaction-checkpoint"
import { ResultPruner } from "../result-pruner"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionTable } from "../sql"
import { SessionMessage } from "../message"
import { SessionStore } from "../store"
import { ExternalContext, ExternalTools, type Interface, type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import * as SessionRunnerHistory from "./history"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { PrimaryDeliveryState } from "../../primary-delivery-state"
import { MemoryV2 } from "../../memory"
import { LearningV2 } from "../../learning"
import { EvolutionV2 } from "../../evolution"
import { RuntimeInsight, billingStorageValues, digest, type ContextLayerReport } from "../../runtime/insight"
import { SessionRunUsageTable } from "../../runtime/sql"
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm"
import * as RuntimeBilling from "../../runtime/billing"
import { Billing } from "@arforge-ai/schema/billing"
import * as RuntimeRetry from "../../runtime/retry"
import * as RuntimeInvariants from "../../runtime/invariants"
import { DurableRun } from "../../runtime/durable-run"
import { SubagentChildExecutor } from "../../runtime/subagent-child-executor"
import { DurableAction } from "../../runtime/durable-action"
import { durableSettlementChecks, summarize } from "../../runtime/verifier"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Prompt } from "@arforge-ai/schema/prompt"
import * as RuntimeCompiler from "../../runtime/compiler"
import * as RuntimeStrategy from "../../runtime/strategy"
import { createHash, randomUUID } from "node:crypto"
import { ContextFirewall } from "../../context-firewall"
import { Token } from "../../util/token"
import * as SessionCheckpoint from "../checkpoint"
import * as RepeatGuard from "../repeat-guard"
import * as RunnerInvariants from "./invariants"
import {
  assertRequestEnvelope,
  createRequestEnvelope,
  assertPreparedRequestEnvelope,
  parseRequestEnvelopeJson,
  rebuildRequest,
  requestEnvelopeJson,
} from "../request-envelope"
import { PromptSystem } from "../prompt-system"
import * as TitleGeneration from "../title-generation"
import * as SessionTitle from "../title"

const durableProcessID = `worker_${process.pid}_${randomUUID()}`
const durableLeaseTtlMs = 30_000
const durableHeartbeatMs = 10_000
const defaultProviderOutputTokenLimit = 32_000

// Private codec for the existing Action result, not a second event/queue.
const TitleReceipt = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
  expectedTitle: Schema.String,
  title: Schema.String,
  // Older settled results remain readable without inventing a usage source.
  usage: Schema.optional(Billing.TokenUsage),
})
type TitleReceipt = typeof TitleReceipt.Type

type ScheduledTaskRuntime = { readonly tool: Tool.AnyTool; readonly modelCalls?: boolean }

const usageCounter = (value: number | undefined) => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value ?? 0)))
}

const sessionCostMicrosTotal = (cost: number | undefined) => usageCounter(Math.max(0, cost ?? 0) * 1_000_000)

const sessionTokenTotal = (
  tokens:
    | {
        readonly input: number
        readonly output: number
        readonly reasoning: number
        readonly cache: { readonly read: number; readonly write: number }
      }
    | undefined,
) =>
  usageCounter(
    (tokens?.input ?? 0) +
      (tokens?.output ?? 0) +
      (tokens?.reasoning ?? 0) +
      (tokens?.cache.read ?? 0) +
      (tokens?.cache.write ?? 0),
  )

const sessionUsageBaseline = (session: SessionSchema.Info) =>
  AgentRuntime.RunUsageBaseline.make({
    costMicros: sessionCostMicrosTotal(session.cost),
    tokens: sessionTokenTotal(session.tokens),
  })

const boundedAttemptUsage = (
  run: { readonly budget: AgentRuntime.Budget },
  input: { readonly durationMs: number; readonly costMicros: number; readonly tokens: number },
) => ({
  durationMs: Math.min(
    usageCounter(input.durationMs),
    Math.max(0, run.budget.maxDurationMs - run.budget.durationMsUsed),
  ),
  costMicros: Math.min(
    usageCounter(input.costMicros),
    Math.max(0, run.budget.maxCostMicros - run.budget.costMicrosUsed),
  ),
  tokens: Math.min(usageCounter(input.tokens), Math.max(0, run.budget.maxTokens - run.budget.tokensUsed)),
})

/** Prepared evolution exposure per session, reused across the steps of one user turn. */
const evolutionContextCache = new Map<string, { userMessageID: string; prepared: EvolutionV2.PreparedContext }>()

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [x] Fence execution with an expiring durable owner lease shared by local and clustered backends.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@arforge-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Bind and consume one prepared provider request per send.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Consume the preparation verified against the committed envelope for each provider turn.
 * Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const deferredTools = yield* DeferredTools.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const goalGuidance = yield* GoalGuidance.Service
    const goals = yield* GoalV2.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const primaryDeliveries = yield* PrimaryDeliveryState.Service
    const memory = yield* MemoryV2.Service
    const learning = yield* LearningV2.Service
    const evolution = yield* EvolutionV2.Service
    const durableRuns = yield* DurableRun.Service
    const durableActions = yield* DurableAction.Service
    const actions = yield* ActionGateway.Service
    const background = yield* BackgroundJob.Service
    const invariants = yield* RuntimeInvariants.Service
    RunnerInvariants.registerInvariants(invariants)
    const database = yield* Database.Service
    const db = database.db
    // Bind every checkpoint to the execution that entered this Runner, not a
    // newly loaded attempt or lease belonging to a replacement worker.
    type ExecutionLease = DurableRun.CheckpointExecution
    const lockBillingSession = Effect.fnUntraced(function* (
      transaction: Database.Transaction,
      sessionID: SessionSchema.ID,
    ) {
      // All billing writers use session -> run lock order. Preserve timestamps:
      // obtaining serialization is not a user-visible session activity.
      const locked = yield* transaction
        .update(SessionTable)
        .set({ id: sql`${SessionTable.id}`, time_updated: sql`${SessionTable.time_updated}` })
        .where(eq(SessionTable.id, sessionID))
        .returning({ id: SessionTable.id })
        .pipe(Effect.orDie)
      if (locked.length !== 1)
        yield* Effect.die(new RuntimeBilling.BudgetStateError("Billing session is missing or inaccessible"))
    })
    const persistBillingSettlement = Effect.fnUntraced(function* (input: {
      runID: AgentRuntime.RunID
      sessionID: SessionSchema.ID
      providerID: string
      modelID: string
      requestDigest: string
      prepared: RuntimeBilling.PreparedCall
      before: Billing.BudgetState
      settled: RuntimeBilling.SettledCall
      pendingReceipt: ReturnType<typeof RuntimeBilling.encodeReservationReceipt>
      onSettlement?: RuntimeBilling.SettlementObserver
      executionLease: ExecutionLease
    }) {
      const principal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
      const record = {
        billingID: input.prepared.reservation.id,
        runID: input.runID,
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: input.modelID,
        ...input.settled,
        recordedAt: Date.now(),
      }
      yield* database
        .transactionAsPrincipal(principal, (transaction) =>
          Effect.gen(function* () {
            yield* lockBillingSession(transaction, input.sessionID)
            yield* durableRuns
              .validateLease({ runID: input.runID, ...input.executionLease, transaction })
              .pipe(Effect.orDie)
            const updated = yield* transaction
              .update(SessionRunUsageTable)
              .set({
                ...billingStorageValues(record),
                billing_receipt: RuntimeBilling.encodeReceipt(input),
                tenant_id: principal.tenantID,
                owner_user_id: principal.userID,
              })
              .where(
                and(
                  eq(SessionRunUsageTable.id, record.billingID),
                  eq(SessionRunUsageTable.run_id, input.runID),
                  eq(SessionRunUsageTable.session_id, input.sessionID),
                  eq(SessionRunUsageTable.tenant_id, principal.tenantID),
                  eq(SessionRunUsageTable.owner_user_id, principal.userID),
                  isNull(SessionRunUsageTable.settlement_reservation_id),
                  eq(SessionRunUsageTable.billing_receipt, input.pendingReceipt),
                ),
              )
              .returning({ id: SessionRunUsageTable.id })
              .pipe(Effect.orDie)
            if (updated.length !== 1)
              yield* Effect.die(
                new RuntimeBilling.BudgetStateError("Pending billing reservation changed before settlement"),
              )
          }),
        )
        .pipe(Effect.orDie)
      const costMicros = input.settled.charge.amountMinor * 10 ** (6 - input.prepared.catalog.minorUnit)
      RuntimeInsight.recordBilling(record, { persist: false })
      input.onSettlement?.({
        runID: input.runID,
        providerID: input.providerID,
        modelID: input.modelID,
        ...input.settled,
        costMicros,
      })
      return costMicros
    })
    const persistBillingReservation = Effect.fnUntraced(function* (input: {
      runID: AgentRuntime.RunID
      sessionID: SessionSchema.ID
      providerID: string
      modelID: string
      modelCallDigest: string
      billing: RuntimeBilling.RunScope | undefined
      billingCall: RuntimeBilling.PreparedCall | undefined
      executionLease: ExecutionLease
      onReserved: (receipt: ReturnType<typeof RuntimeBilling.encodeReservationReceipt> | undefined) => void
    }) {
      const { runID, modelCallDigest, billing, billingCall, executionLease } = input
      const principal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
      const reservedReceipt = yield* database
        .transactionAsPrincipal(principal, (transaction) =>
          Effect.gen(function* () {
            yield* lockBillingSession(transaction, input.sessionID)
            yield* durableRuns.validateLease({ runID, ...executionLease, transaction }).pipe(Effect.orDie)
            const unresolved = yield* transaction
              .select()
              .from(SessionRunUsageTable)
              .where(
                and(
                  eq(SessionRunUsageTable.session_id, input.sessionID),
                  eq(SessionRunUsageTable.tenant_id, principal.tenantID),
                  eq(SessionRunUsageTable.owner_user_id, principal.userID),
                  isNull(SessionRunUsageTable.settlement_reservation_id),
                  isNotNull(SessionRunUsageTable.billing_receipt),
                ),
              )
              .limit(1)
              .all()
              .pipe(Effect.orDie)
            const pending = unresolved[0]
            if (pending) {
              RuntimeBilling.decodeReservationReceipt(pending.billing_receipt, {
                runID: pending.run_id,
                reservationID: pending.id,
                providerID: pending.provider_id,
                modelID: pending.model_id,
              })
              return yield* Effect.die(
                new RuntimeBilling.BudgetStateError(
                  "Unsettled billing reservation requires reconciliation before another provider call",
                ),
              )
            }
            if (billing && billingCall) {
              const receipt = RuntimeBilling.encodeReservationReceipt({
                prepared: billingCall,
                state: billing.state,
                providerID: input.providerID,
                modelID: input.modelID,
                requestDigest: modelCallDigest,
              })
              const stored = yield* transaction
                .select()
                .from(SessionRunUsageTable)
                .where(
                  and(
                    eq(SessionRunUsageTable.run_id, runID),
                    eq(SessionRunUsageTable.session_id, input.sessionID),
                    eq(SessionRunUsageTable.tenant_id, principal.tenantID),
                    eq(SessionRunUsageTable.owner_user_id, principal.userID),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              const persisted = RuntimeBilling.makeRunScope({ runID, config: billing.config, receipts: stored })
              RuntimeBilling.resumeReservation(persisted, receipt, {
                runID,
                reservationID: billingCall.reservation.id,
                providerID: input.providerID,
                modelID: input.modelID,
              })
              yield* transaction
                .insert(SessionRunUsageTable)
                .values({
                  ...billingStorageValues({
                    billingID: billingCall.reservation.id,
                    runID,
                    sessionID: input.sessionID,
                    providerID: input.providerID,
                    modelID: input.modelID,
                    usage: billingCall.estimatedUsage,
                    recordedAt: Date.now(),
                  }),
                  billing_receipt: receipt,
                  tenant_id: principal.tenantID,
                  owner_user_id: principal.userID,
                })
                .run()
                .pipe(Effect.orDie)
              return receipt
            }
            return undefined
          }),
        )
        .pipe(Effect.orDie)
      // Retain the durable receipt before restoring interruptibility. Otherwise
      // cancellation after COMMIT can look like no reservation to the finalizer.
      input.onReserved(reservedReceipt)
      return reservedReceipt
    }, Effect.uninterruptible)
    const settleBillingCall = Effect.fnUntraced(function* (input: {
      runID: AgentRuntime.RunID
      sessionID: SessionSchema.ID
      providerID: string
      modelID: string
      modelCallDigest: string
      billing: RuntimeBilling.RunScope | undefined
      billingCall: RuntimeBilling.PreparedCall | undefined
      pendingBillingReceipt: ReturnType<typeof RuntimeBilling.encodeReservationReceipt> | undefined
      usage: Billing.TokenUsage | undefined
      stream: Exit.Exit<unknown, unknown>
      executionLease: ExecutionLease
      sendStarted: boolean
    }) {
      const { runID, modelCallDigest, billing, billingCall, pendingBillingReceipt, stream, executionLease } = input
      if (billing && billingCall && !pendingBillingReceipt) {
        // No confirmed reservation reached the send boundary. Do not invent a provider charge.
        billing.state = RuntimeBilling.settle(billing.state, billingCall.reservation, 0).state
        return { billingSettlement: undefined, billingCostMicros: 0 }
      }
      const reconcileUsage = input.sendStarted ? billing?.config.reconcileUsage : undefined
      const reconciliation =
        billingCall && stream._tag === "Failure" && reconcileUsage
          ? yield* Effect.tryPromise({
              try: () =>
                Promise.resolve(
                  reconcileUsage({
                    runID,
                    reservationID: billingCall.reservation.id,
                    providerID: input.providerID,
                    modelID: input.modelID,
                    requestDigest: modelCallDigest,
                    failureCategory: RuntimeRetry.classifyFailure(
                      Option.getOrUndefined(Cause.findErrorOption(stream.cause)),
                    ),
                  }),
                ),
              catch: (error) => error,
            }).pipe(Effect.interruptible, Effect.timeoutOption("5 seconds"), Effect.exit)
          : undefined
      if (reconciliation && Exit.isSuccess(reconciliation) && Option.isNone(reconciliation.value))
        return yield* Effect.die(
          new RuntimeBilling.ReconciliationPendingError(
            "Usage reconciliation timed out; billing reservation remains unresolved",
          ),
        )
      if (reconciliation && Exit.isFailure(reconciliation) && Cause.hasInterrupts(reconciliation.cause))
        return yield* Effect.failCause(reconciliation.cause).pipe(Effect.orDie)
      if (reconciliation && Exit.isFailure(reconciliation)) {
        RuntimeInsight.auditRecord({
          actor: "runtime",
          action: "billing.usage-reconciliation.failed",
          resource: `${input.providerID}/${input.modelID}`,
          reason: "Provider-side usage reconciliation failed; conservative estimate retained",
          metadata: { runID, sessionID: input.sessionID, billingID: billingCall!.reservation.id },
        })
      }
      const reconciledUsage =
        reconciliation && Exit.isSuccess(reconciliation) ? Option.getOrUndefined(reconciliation.value) : undefined
      const settlementUsage = !input.sendStarted
        ? RuntimeBilling.estimateCallUsage({ inputText: "", outputTokens: 0 })
        : (reconciledUsage ??
          input.usage ??
          billingCall?.estimatedUsage ??
          RuntimeBilling.fromStepTokens({
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }))
      const beforeSettlement = billing?.state
      const billingSettlement =
        billing && billingCall ? RuntimeBilling.settleCall(billing, billingCall, settlementUsage) : undefined
      const billingCostMicros =
        billingSettlement && billingCall!.catalog.minorUnit <= 6
          ? billingSettlement.charge.amountMinor * 10 ** (6 - billingCall!.catalog.minorUnit)
          : 0
      if (billingSettlement) {
        yield* persistBillingSettlement({
          runID,
          sessionID: input.sessionID,
          providerID: input.providerID,
          modelID: input.modelID,
          requestDigest: modelCallDigest,
          prepared: billingCall!,
          before: beforeSettlement!,
          settled: billingSettlement,
          pendingReceipt: pendingBillingReceipt!,
          onSettlement: billing?.config.onSettlement,
          executionLease,
        })
      }
      return { billingSettlement, billingCostMicros }
    })
    const executeCompactionProvider =
      (
        runID: AgentRuntime.RunID,
        sessionID: SessionSchema.ID,
        billing: RuntimeBilling.RunScope | undefined,
        executionLease: ExecutionLease,
        validateExecution: Effect.Effect<void>,
      ): SessionCompaction.ExecuteProvider =>
      (input) =>
        Effect.gen(function* () {
          yield* validateExecution
          const providerID = String(input.request.model.provider)
          const modelID = String(input.request.model.id)
          const modelCallDigest = input.requestDigest
          const billingCall = billing
            ? RuntimeBilling.prepareCall(billing, {
                reservationID: `billing_${runID}_compaction_${randomUUID()}`,
                providerID,
                modelID,
                inputText: JSON.stringify({
                  system: input.request.system,
                  messages: input.request.messages,
                  tools: input.request.tools,
                }),
                outputTokens: input.request.generation?.maxTokens ?? 0,
              })
            : undefined
          let pendingBillingReceipt: ReturnType<typeof RuntimeBilling.encodeReservationReceipt> | undefined
          let costMicros = 0
          let sendStarted = false
          yield* Effect.gen(function* () {
            yield* SessionRunnerModel.validateCredential(input.request.model)
            yield* persistBillingReservation({
              runID,
              sessionID,
              providerID,
              modelID,
              modelCallDigest,
              billing,
              billingCall,
              executionLease,
              onReserved: (receipt) => {
                pendingBillingReceipt = receipt
              },
            })
            yield* validateExecution
            yield* SessionRunnerModel.validateCredential(input.request.model)
            sendStarted = true
            yield* input.execute
          }).pipe(
            Effect.onExit((stream) =>
              Effect.gen(function* () {
                const usage = input.usage()
                const result = yield* settleBillingCall({
                  runID,
                  sessionID,
                  providerID,
                  modelID,
                  modelCallDigest,
                  billing,
                  billingCall,
                  pendingBillingReceipt,
                  executionLease,
                  stream,
                  sendStarted,
                  usage: usage === undefined ? undefined : RuntimeBilling.fromProviderUsage(usage),
                })
                costMicros = result.billingCostMicros
              }).pipe(Effect.uninterruptible, Effect.forkChild, Effect.flatMap(Fiber.join)),
            ),
          )
          return costMicros / 1_000_000
        })
    const compaction = SessionCompaction.make({
      db,
      events,
      llm,
      invariants,
      config: yield* config.entries(),
      checkpoints: {
        append: (sessionID, checkpoint) => SessionCompactionCheckpoint.append(db, sessionID, checkpoint, invariants),
        reconcile: (sessionID, operationID) =>
          SessionCompactionCheckpoint.reconcile(db, sessionID, operationID, invariants),
        recoverPublished: (sessionID) =>
          SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants),
      },
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const publishTitle = Effect.fn("SessionRunner.publishTitle")(function* (receipt: TitleReceipt) {
      yield* events.publish(SessionEvent.TitleGenerated, {
        sessionID: receipt.sessionID,
        messageID: receipt.messageID,
        expectedTitle: receipt.expectedTitle,
        title: receipt.title,
        timestamp: yield* DateTime.now,
      })
    })
    const restoreTitle = Effect.fn("SessionRunner.restoreTitle")(function* (session: SessionSchema.Info) {
      if (!SessionTitle.canReplace({ expected: session.title, current: session.title, parentID: session.parentID }))
        return
      if (!(yield* agents.get(AgentV2.ID.make("title")))) return
      const context = yield* getContext(session.id)
      const first = context.find((message) => message.type === "user")
      const assistant = context.find((message) => message.type === "assistant")
      if (!first || !assistant) return
      const actionID = ActionGateway.stableActionID({
        sessionID: session.id,
        assistantMessageID: assistant.id,
        toolCallID: "session.title",
      })
      const saved = yield* durableActions
        .load(actionID)
        .pipe(Effect.catchTag("DurableAction.NotFoundError", () => Effect.succeed(undefined)))
      if (
        !saved ||
        saved.action.status !== "settled" ||
        saved.observation?.status !== "succeeded" ||
        !saved.modelRequest ||
        !saved.observation.output
      )
        return
      const subject = saved.action.subject
      if (
        saved.action.name !== "session.title" ||
        subject?.type !== "session" ||
        subject.sessionID !== session.id ||
        subject.agent !== "title" ||
        subject.assistantMessageID !== assistant.id ||
        subject.toolCallID !== "session.title"
      )
        return yield* Effect.die(new Error("Title result identity does not match its session"))
      const receipt = Schema.decodeUnknownSync(TitleReceipt)(saved.observation.output.value)
      if (
        receipt.sessionID !== session.id ||
        receipt.messageID !== first.id ||
        SessionTitle.normalizeGenerated(receipt.title) !== receipt.title
      )
        return yield* Effect.die(new Error("Title result has invalid projection bindings"))
      if (
        !SessionTitle.canReplace({
          expected: receipt.expectedTitle,
          current: session.title,
          parentID: session.parentID,
        })
      )
        return
      yield* publishTitle(receipt)
    })
    const scheduleTitle = Effect.fn("SessionRunner.scheduleTitle")(function* (
      sessionID: SessionSchema.ID,
      billing: RuntimeBilling.RunScope | undefined,
    ) {
      const session = yield* getSession(sessionID)
      if (!SessionTitle.canReplace({ expected: session.title, current: session.title, parentID: session.parentID }))
        return
      const context = yield* getContext(sessionID)
      const first = context.find((message) => message.type === "user")
      const assistant = context.find((message) => message.type === "assistant")
      if (!first || first.type !== "user" || !assistant) return
      if (!first.text?.trim() && !first.files?.length) return
      const agent = yield* agents.get(AgentV2.ID.make("title"))
      if (!agent) return
      // Strict, currency-bound jobs must not gain an unreserved maintenance
      // allowance. Keep this explicit until shared maintenance allocation is wired.
      if (billing) {
        yield* Effect.logWarning("Automatic title requires a reserved maintenance budget", { sessionID })
        return
      }
      const identity = { sessionID, assistantMessageID: assistant.id, toolCallID: "session.title" }
      const actionID = ActionGateway.stableActionID(identity)
      // Product adapters may provide their existing instance-scoped facade.
      // Use it so title work participates in the same list/wait/cancel registry.
      const jobs = Option.getOrElse(yield* Effect.serviceOption(BackgroundJob.Service), () => background)
      yield* jobs.start({
        id: String(actionID),
        type: "session-title",
        title: "Generate conversation title",
        metadata: { sessionId: sessionID },
        run: Effect.gen(function* () {
          const current = yield* getSession(sessionID)
          if (!SessionTitle.canReplace({ expected: session.title, current: current.title, parentID: current.parentID }))
            return "Title no longer needs generation"
          const small =
            !agent.model && models.resolveSmall
              ? yield* models.resolveSmall(current, ["text", ...(first.files ?? []).map((file) => file.mime)])
              : undefined
          const model = small ?? (yield* models.resolve({ ...current, model: agent.model ?? current.model }))
          const [message] = toLLMMessages([first], model)
          if (!message) return yield* Effect.die(new Error("Initial user message could not be converted"))
          const common = TitleGeneration.prepare({ content: message.content, model, agent, execution: {} })
          const request = rebuildRequest(common, model, SessionRunnerModel.credentialIdentity(model))
          const prepared = yield* llm.prepare(request).pipe(Effect.timeout("30 seconds"))
          const envelope = createRequestEnvelope({
            request,
            execution: { ...common.execution, credential_identity: SessionRunnerModel.credentialIdentity(model) },
            transmission: prepared.transmission,
          })
          assertPreparedRequestEnvelope(envelope, prepared)
          let reported: Usage | undefined
          let estimated: Billing.TokenUsage | undefined
          const receipt = yield* actions.execute(
            {
              ...identity,
              actionID,
              agent: agent.id,
              name: "session.title",
              resources: [`${model.provider}/${model.id}`],
              inputDigest: envelope.request_digest,
              reasonSummary: "Generate a title for the initial user request",
              semantics: AgentRuntime.EffectSemantics.make({
                riskTier: "L1",
                authority: ActionGateway.authorityFor("L1"),
                idempotency: "non_idempotent",
                retryability: "never",
                reversibility: "not_applicable",
                filesystemScope: [],
                networkScope: [],
                secretScope: [],
                externalServices: [String(model.provider)],
                expectedArtifacts: [],
                successCriteria: ["A valid conversation title is generated"],
              }),
            },
            {
              estimatedTokens: Token.estimate(JSON.stringify(envelope.request)) + TitleGeneration.outputTokenLimit,
              tokens: () =>
                reported?.totalTokens ??
                (estimated ? Object.values(estimated.tokens).reduce((sum, value) => sum + value, 0) : undefined),
              // No verified monetary receipt exists in the ordinary unmetered
              // session path. Omit it rather than recording a fictitious zero.
              durableResult: {
                encode: (receipt: TitleReceipt) => receipt,
                decode: Schema.decodeUnknownSync(TitleReceipt),
              },
              execute: (_capability, operation) =>
                TitleGeneration.generate({
                  envelope,
                  prepared,
                  model,
                  credentialIdentity: SessionRunnerModel.credentialIdentity(model),
                  authorizeAndRecord: (request) =>
                    Effect.gen(function* () {
                      if (!operation) return yield* Effect.die(new Error("Missing title Action execution context"))
                      yield* operation.recordModelRequest(request)
                      const stored = yield* durableActions.load(actionID)
                      if (!stored.modelRequest) return yield* Effect.die(new Error("Missing committed title request"))
                      const committed = parseRequestEnvelopeJson(stored.modelRequest.envelope)
                      if (
                        committed.request_digest !== envelope.request_digest ||
                        stored.action.inputDigest !== committed.request_digest
                      )
                        return yield* Effect.die(new Error("Committed title request differs from its Action"))
                      assertPreparedRequestEnvelope(committed, prepared)
                      yield* SessionRunnerModel.validateCredential(model)
                    }),
                  onUsage: (usage) => {
                    reported = usage
                  },
                  streamPrepared: llm.streamPrepared,
                }).pipe(
                  Effect.map((result) => {
                    // Only a complete, valid response can use the existing
                    // named pre-call estimate. Missing receipts on failed or
                    // interrupted requests still require reconciliation.
                    const usage = reported
                      ? RuntimeBilling.fromProviderUsage(reported)
                      : (estimated = RuntimeBilling.estimateCallUsage({
                          inputText: JSON.stringify(envelope.request),
                          outputTokens: TitleGeneration.outputTokenLimit,
                        }))
                    return TitleReceipt.make({
                      version: 1,
                      sessionID,
                      messageID: first.id,
                      expectedTitle: session.title,
                      title: result.title,
                      usage,
                    })
                  }),
                ),
            },
          )
          yield* publishTitle(receipt)
          return "Conversation title generated"
        }).pipe(
          Effect.interruptible,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.fail(new Error("Conversation title generation failed")),
          ),
        ),
      })
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
      cancelledScheduledRunID?: AgentRuntime.RunID,
    ) {
      const context = yield* getContext(sessionID)
      const scheduledCallIDs = new Set(
        context.flatMap((message) =>
          message.type === "user" ? (message.scheduledTasks ?? []).map((task) => task.id) : [],
        ),
      )
      for (const message of context) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          // Canonical scheduled tasks are recovered by the same native tool
          // with the same assistant/call identity. Marking them failed here
          // would discard the only safe ActionGateway replay path and could
          // cause a replacement worker to mint a duplicate child action.
          const scheduled = tool.name === TurnToolCarrier.scheduledTaskName && scheduledCallIDs.has(tool.id)
          if (scheduled) {
            if (!cancelledScheduledRunID) continue
            const action = yield* durableActions
              .load(
                ActionGateway.stableActionID({
                  sessionID,
                  assistantMessageID: message.id,
                  toolCallID: tool.id,
                }),
              )
              .pipe(Effect.option)
            // Only project a terminal failure already recorded by the owning
            // Gateway. An interrupted execution is blocked rather than
            // falsely labelled cancelled after crossing the side-effect boundary.
            // Recoverable prefixes and other runs stay untouched.
            if (
              Option.isNone(action) ||
              action.value.action.runID !== cancelledScheduledRunID ||
              !["blocked", "cancelled"].includes(action.value.action.status)
            )
              continue
          } else if (cancelledScheduledRunID) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
          if (scheduled)
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID,
              timestamp: yield* DateTime.now,
              assistantMessageID: message.id,
              error: { type: "unknown", message: "Scheduled task interrupted" },
            })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (sessionID: SessionSchema.ID, agent: AgentV2.Selection) =>
      Effect.all(
        [
          systemContext.load(),
          skillGuidance.load(agent),
          referenceGuidance.load(),
          goalGuidance.load(sessionID),
          Effect.flatMap(ExternalContext, (load) =>
            load ? load(sessionID, String(agent.id)) : Effect.succeed(SystemContext.empty),
          ),
        ],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.map(SystemContext.combine))

    type ScheduledTask = NonNullable<Prompt["scheduledTasks"]>[number]

    const scheduledTaskAssistantID = (sessionID: SessionSchema.ID, taskID: string) =>
      SessionMessage.ID.make(
        `msg_${createHash("sha256").update(`${sessionID}\u0000${taskID}`).digest("hex").slice(0, 32)}`,
      )

    const scheduledTaskInput = (task: ScheduledTask): Record<string, unknown> => ({
      prompt: task.prompt,
      description: task.description,
      subagent_type: task.agent,
      ...(task.command === undefined ? {} : { command: task.command }),
    })

    const executeScheduledTask = Effect.fn("SessionRunner.executeScheduledTask")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly runID: AgentRuntime.RunID
      readonly task: ScheduledTask
      readonly runtime: ScheduledTaskRuntime | undefined
      readonly parentModel: LLMModel
    }) {
      const assistantMessageID = scheduledTaskAssistantID(input.sessionID, input.task.id)
      const context = yield* getContext(input.sessionID)
      const existingAssistant = context.find(
        (message): message is SessionMessage.Assistant =>
          message.type === "assistant" && message.id === assistantMessageID,
      )
      const existingTool = existingAssistant?.content.find(
        (part): part is SessionMessage.AssistantTool =>
          part.type === "tool" && part.id === input.task.id && part.name === TurnToolCarrier.scheduledTaskName,
      )
      if (existingTool?.state.status === "completed" || existingTool?.state.status === "error") return false

      const args = scheduledTaskInput(input.task)
      if (!existingAssistant)
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          agent: input.task.agent,
          model:
            input.task.model ??
            ModelV2.Ref.make({
              id: ModelV2.ID.make(input.parentModel.id),
              providerID: ProviderV2.ID.make(input.parentModel.provider),
            }),
        })
      if (!existingTool)
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          name: TurnToolCarrier.scheduledTaskName,
        })
      if (!existingTool || existingTool.state.status === "pending")
        yield* events.publish(SessionEvent.Tool.Input.Ended, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          text: JSON.stringify(args),
        })
      if (!existingTool || existingTool.state.status === "pending")
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          tool: TurnToolCarrier.scheduledTaskName,
          input: args,
          provider: { executed: false },
        })

      if (!input.runtime) {
        const message =
          "The delegated task runtime is unavailable. No child task was started; retry after restoring the task runtime."
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          error: { type: "unknown", message },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          error: { type: "unknown", message },
        })
        return yield* new TurnToolCarrier.InvalidCarrierError({ carrier: "scheduled-task" })
      }

      const materialized = yield* tools.materialize([], input.sessionID, {
        includeRegistered: false,
        scheduledTaskTool: input.runtime.tool,
      })
      const actionID = ActionGateway.stableActionID({
        sessionID: input.sessionID,
        assistantMessageID,
        toolCallID: input.task.id,
      })
      const existingAction = yield* durableActions.load(actionID).pipe(Effect.option)
      const actionRunID = Option.isSome(existingAction) ? existingAction.value.action.runID : input.runID
      const exit = yield* materialized
        .settle({
          ...(actionRunID ? { runID: actionRunID } : {}),
          sessionID: input.sessionID,
          agent: AgentV2.ID.make(input.task.agent),
          assistantMessageID,
          call: {
            type: "tool-call",
            id: input.task.id,
            name: TurnToolCarrier.scheduledTaskName,
            input: args,
          },
        })
        .pipe(Effect.exit)

      if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          error: {
            type: "unknown",
            message: `Scheduled task failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          provider: { executed: false },
        })
      } else if (exit.value.result.type === "error") {
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          error: { type: "unknown", message: String(exit.value.result.value) },
          result: exit.value.result,
          provider: { executed: false },
        })
      } else {
        const output = exit.value.output ?? ToolOutput.fromResultValue(exit.value.result)
        if (!output) return yield* Effect.die("Scheduled task returned an unsupported tool result")
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: input.task.id,
          structured:
            typeof output.structured === "object" && output.structured !== null && !Array.isArray(output.structured)
              ? Object.fromEntries(Object.entries(output.structured))
              : { value: output.structured },
          content: [...output.content],
          ...(exit.value.artifactRefs?.length ? { artifactRefs: exit.value.artifactRefs } : {}),
          ...(!exit.value.artifactRefs?.length && exit.value.outputPaths?.length
            ? { outputPaths: exit.value.outputPaths }
            : {}),
          provider: { executed: false },
        })
      }

      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      return true
    })

    type RunTurnResult = {
      readonly needsContinuation: boolean
      readonly step: number
      /** The durable semantic binding for the request that just settled. */
      readonly lastTurn: SessionCheckpoint.TurnBinding
    }
    type RunTurnAttempt = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runID: AgentRuntime.RunID,
      traceID: string,
      billing: RuntimeBilling.RunScope | undefined,
      maxTransportRetries: number,
      repeatGuard: RepeatGuard.Interface,
      executionLease: ExecutionLease,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
      modelOverride?: LLMModel,
      scheduledTaskRuntime?: ScheduledTaskRuntime,
      checkpointExecution?: DurableRun.CheckpointExecution,
      inheritedBillingCostMicros?: number,
    ) => Effect.Effect<RunTurnResult, RunError>

    const runTurnAttempt: RunTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runID: AgentRuntime.RunID,
      traceID: string,
      billing: RuntimeBilling.RunScope | undefined,
      maxTransportRetries: number,
      repeatGuard: RepeatGuard.Interface,
      executionLease: ExecutionLease,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
      modelOverride?: LLMModel,
      scheduledTaskRuntime?: ScheduledTaskRuntime,
      checkpointExecution?: DurableRun.CheckpointExecution,
      inheritedBillingCostMicros = 0,
    ) {
      const validateChildExecution = checkpointExecution
        ? SubagentChildExecutor.validateExecution({
            childRunID: runID,
            sessionID,
            execution: checkpointExecution,
          }).pipe(Effect.provideService(DurableRun.Service, durableRuns), Effect.orDie)
        : Effect.void
      const validateExecution = durableRuns
        .validateLease({ runID, ...executionLease })
        .pipe(Effect.orDie, Effect.andThen(validateChildExecution))
      yield* validateExecution
      const entrySnapshot = yield* durableRuns.load(runID).pipe(Effect.orDie)
      const entryCheckpoint = entrySnapshot.checkpoint
        ? SessionCheckpoint.fromContainer(entrySnapshot.checkpoint.state, sessionID)
        : undefined
      const recoveryDispatch =
        entryCheckpoint &&
        !entryCheckpoint.legacy &&
        entryCheckpoint.kind === SessionCheckpoint.KIND &&
        entryCheckpoint.dispatch &&
        entryCheckpoint.dispatch.attempt !== executionLease.attempt
          ? entryCheckpoint.dispatch
          : undefined
      const recoveryRequest = recoveryDispatch
        ? yield* Effect.gen(function* () {
            if (recoveryDispatch.phase !== "prepared" || recoveryDispatch.attempt >= executionLease.attempt)
              throw new SessionCheckpoint.RecoveryRequiredError(
                "The prior request may already have been sent; automatic replay is blocked until its outcome is reconciled.",
              )
            const rows = yield* EventV2.readSerialized(db, {
              aggregateIDs: [sessionID],
              types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
            })
            const event = rows.find((row) => row.id === recoveryDispatch.requestEventID)
            if (!event) throw new Error("Missing request event")
            const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(event.data)
            const envelope = parseRequestEnvelopeJson(data.envelope)
            if (
              data.sessionID !== sessionID ||
              data.runID !== runID ||
              data.turnStep !== recoveryDispatch.turnStep ||
              data.attempt === undefined ||
              data.attempt > recoveryDispatch.attempt ||
              data.attempt !== envelope.execution.attempt ||
              data.schemaVersion !== envelope.schema_version ||
              data.requestDigest !== recoveryDispatch.requestDigest ||
              envelope.request_digest !== recoveryDispatch.requestDigest ||
              envelope.execution.run_id !== runID ||
              envelope.execution.turn_step !== recoveryDispatch.turnStep
            )
              throw new Error("Request event binding mismatch")
            return { event, envelope }
          }).pipe(
            Effect.catchDefect(() =>
              Effect.die(
                new SessionCheckpoint.RecoveryRequiredError(
                  "The prepared request cannot be verified from its original record. Recovery is paused; no replacement request was sent.",
                ),
              ),
            ),
          )
        : undefined
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(session.id, agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      type LocalToolOutcome = {
        readonly id: string
        readonly name: string
        readonly input: unknown
        readonly outputPaths: ReadonlyArray<string>
        readonly artifactRefs: ReadonlyArray<AgentRuntime.OpaqueArtifactRef>
        readonly exit: Exit.Exit<ToolRegistry.Settlement, ToolOutputStore.Error>
      }
      // Tool calls may execute in parallel, but the model-visible terminal
      // events are committed in provider call order. This is the durable
      // barrier between a rolling execution pool and the next model turn.
      const localToolOutcomes = new Map<number, LocalToolOutcome>()
      let nextToolSequence = 0
      let needsContinuation = false
      let currentStep = step
      const currentRun = (yield* durableRuns.load(runID).pipe(Effect.orDie)).run
      const personalJob = "admission" in currentRun ? currentRun.admission?.personalJob : undefined
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer" && !personalJob)
          promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(
            yield* SessionInput.promoteNextQueued(db, events, session.id, personalJob?.occurrence.messageID),
          )
          if (!personalJob) promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(session.id, agent), session.id))
      // Bind every provider request to the immutable SkillV2 materialization
      // that was observed for this turn.  Compatibility fixtures may omit the
      // optional Core registry; production compositions provide it through the
      // SkillGuidance node.  If present, snapshot failures remain fatal rather
      // than silently widening the request identity.
      const skillService = yield* Effect.serviceOption(SkillV2.Service)
      const skillSnapshotDigest = Option.isNone(skillService)
        ? undefined
        : (yield* skillService.value.snapshot()).digest
      const model = modelOverride ?? (yield* models.resolve(session))
      const goalDeliveryLocked =
        (yield* goals.list({ sessionID: session.id, includeHistory: false })).active?.status === "running"
      let entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      let context = entries.map((entry) => entry.message)
      let latestUserMessage = context.findLast((message) => message.type === "user")
      let admittedPrompt = latestUserMessage ? (yield* SessionInput.find(db, latestUserMessage.id))?.prompt : undefined
      let latestPrompt = admittedPrompt ?? (latestUserMessage ? Prompt.fromUserMessage(latestUserMessage) : undefined)
      const scheduledTasks = [
        ...new Map(
          context
            .flatMap((message) => (message.type === "user" ? (message.scheduledTasks ?? []) : []))
            .map((task) => [task.id, task] as const),
        ).values(),
      ]
      if (scheduledTasks.length > 0) {
        const latestTaskUserIndex = context.findLastIndex(
          (message) => message.type === "user" && (message.scheduledTasks?.length ?? 0) > 0,
        )
        const scheduledAssistantIDs = new Set(
          scheduledTasks.map((task) => scheduledTaskAssistantID(session.id, task.id)),
        )
        const assistantsAfterUser = context
          .slice(latestTaskUserIndex + 1)
          .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        const providerAlreadyRan = assistantsAfterUser.some((message) => !scheduledAssistantIDs.has(message.id))
        if (!providerAlreadyRan) {
          const settledPrefix = scheduledTasks.filter((task) => {
            const assistantID = scheduledTaskAssistantID(session.id, task.id)
            return assistantsAfterUser
              .find((message) => message.id === assistantID)
              ?.content.some(
                (part) =>
                  part.type === "tool" &&
                  part.id === task.id &&
                  (part.state.status === "completed" || part.state.status === "error"),
              )
          }).length
          currentStep = Math.max(currentStep, 1 + settledPrefix)
        }

        let projected = false
        for (const task of [...scheduledTasks].reverse()) {
          const settled = yield* executeScheduledTask({
            sessionID: session.id,
            runID,
            task,
            runtime: scheduledTaskRuntime,
            parentModel: model,
          })
          if (!settled) continue
          projected = true
          currentStep++
        }
        if (projected) {
          entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
          context = entries.map((entry) => entry.message)
          latestUserMessage = context.findLast((message) => message.type === "user")
          admittedPrompt = latestUserMessage ? (yield* SessionInput.find(db, latestUserMessage.id))?.prompt : undefined
          latestPrompt = admittedPrompt ?? (latestUserMessage ? Prompt.fromUserMessage(latestUserMessage) : undefined)
        }
      }
      const latestRequest = latestPrompt?.text
      const requestSystemLayer = latestUserMessage
        ? PromptSystem.layer({ messageID: latestUserMessage.id, system: latestPrompt?.system })
        : undefined
      const structuredFormat = latestPrompt?.format?.type === "json_schema" ? latestPrompt.format : undefined
      const structuredRetryCount = structuredFormat?.retryCount ?? 2
      const latestUserIndex = context.findLastIndex((message) => message.type === "user")
      // Count only prior failed finalization attempts. Ordinary tool-only
      // research/action steps do not consume the user's structured retry
      // budget, while prose-only and invalid/mixed StructuredOutput steps do.
      const structuredRetriesUsed = structuredFormat
        ? context.slice(latestUserIndex + 1).filter((message) => {
            if (message.type !== "assistant" || message.structured !== undefined) return false
            const toolNames = message.content
              .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
              .map((part) => part.name)
            return toolNames.length === 0 || toolNames.includes(StructuredOutput.name)
          }).length
        : 0
      const [routedSkills, memoryPreparation, learningPreparation] =
        latestRequest === undefined
          ? ([undefined, undefined, undefined] as const)
          : yield* Effect.all(
              [
                skillGuidance.route(agent, latestRequest),
                memory.prepareContext(latestRequest).pipe(
                  Effect.map((prepared) => ({ status: "prepared" as const, prepared })),
                  Effect.catch(() => Effect.succeed({ status: "unavailable" as const })),
                ),
                learning.context(latestRequest).pipe(
                  Effect.map((text) => ({ status: "prepared" as const, text })),
                  Effect.catch(() => Effect.succeed({ status: "unavailable" as const, text: "" })),
                ),
              ],
              { concurrency: "unbounded" },
            )
      // Evolution exposure is prepared once per user turn and reused across its
      // steps, so multi-step turns settle a single exposure at the terminal step
      // instead of leaving intermediate exposures permanently pending.
      let evolutionPreparation:
        | { status: "prepared"; prepared: EvolutionV2.PreparedContext }
        | { status: "unavailable"; prepared: EvolutionV2.PreparedContext }
        | undefined
      if (latestRequest !== undefined && latestUserMessage) {
        const cached = evolutionContextCache.get(session.id)
        if (cached?.userMessageID === latestUserMessage.id) {
          evolutionPreparation = { status: "prepared", prepared: cached.prepared }
        } else {
          const prepared = yield* evolution
            .prepare({
              userInput: latestRequest,
              cohortKey: EvolutionV2.cohortKeyForSession(session.id),
              source: {
                sessionID: session.id,
                userMessageID: latestUserMessage.id,
                turnStep: currentStep,
              },
            })
            .pipe(
              Effect.map((value) => ({ status: "prepared" as const, prepared: value })),
              Effect.catch(() =>
                Effect.succeed({ status: "unavailable" as const, prepared: EvolutionV2.emptyContext }),
              ),
            )
          if (prepared.status === "prepared")
            evolutionContextCache.set(session.id, { userMessageID: latestUserMessage.id, prepared: prepared.prepared })
          evolutionPreparation = prepared
        }
      } else {
        evolutionPreparation = undefined
      }
      const memoryContext = memoryPreparation?.status === "prepared" ? memoryPreparation.prepared.text : ""
      const learningContext = learningPreparation?.text ?? ""
      const evolutionContext = evolutionPreparation?.prepared ?? EvolutionV2.emptyContext
      const memoryModelContext = memoryContext ? ContextFirewall.untrusted("memory", memoryContext) : ""
      const learningModelContext = learningContext ? ContextFirewall.untrusted("document", learningContext) : ""
      const evolutionModelContext = evolutionContext.text
        ? ContextFirewall.untrusted("document", evolutionContext.text)
        : ""
      const injectedLearningBytes = new TextEncoder().encode(learningContext).byteLength
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const externalSource = yield* ExternalTools
      const externalTools =
        !isLastStep && externalSource
          ? yield* externalSource({
              sessionID: session.id,
              agent: String(agent.id),
              modelID: String(model.id),
              providerID: String(model.provider),
            })
          : undefined
      const modelTaskOptions =
        scheduledTaskRuntime?.modelCalls && !isLastStep ? { modelTaskTool: scheduledTaskRuntime.tool } : {}
      const toolMaterialization = structuredFormat
        ? yield* tools.materialize(agent.info?.permissions, session.id, {
            includeRegistered: !isLastStep,
            structuredOutput: structuredFormat.schema,
            ...modelTaskOptions,
            externalTools,
          })
        : isLastStep
          ? undefined
          : yield* tools.materialize(agent.info?.permissions, session.id, { ...modelTaskOptions, externalTools })
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      if (latestRequest !== undefined) {
        try {
          RuntimeInsight.recordRoutingDecision({
            timestamp: Date.now(),
            sessionID: session.id,
            task: latestRequest.slice(0, 200),
            providerID: String((model as { providerID?: string }).providerID ?? ""),
            modelID: model.id,
            inputCost: Number((model as { cost?: { input?: number } }).cost?.input ?? 0),
            outputCost: Number((model as { cost?: { output?: number } }).cost?.output ?? 0),
            reason: "会话/默认模型选择",
            candidates: [],
          })
        } catch (error) {
          console.error("runtime: routing record failed", error)
        }
      }
      const strategyLayer =
        latestRequest !== undefined && RuntimeStrategy.selectStrategy(latestRequest).id === "hypothesis-test"
          ? RuntimeStrategy.strategyPrompt(latestRequest)
          : ""
      let compiledParts: string[] = []
      let compiledLayers: ContextLayerReport[] = []
      try {
        const compiled = RuntimeCompiler.compileContext(
          [
            ...(agent.info?.system ? [{ layer: "L1", name: "agent", text: agent.info.system }] : []),
            ...(system.baseline ? [{ layer: "L3", name: "baseline", text: system.baseline }] : []),
            ...(memoryModelContext ? [{ layer: "L5", name: "memory", text: memoryModelContext }] : []),
            ...(learningModelContext ? [{ layer: "L4", name: "learning", text: learningModelContext }] : []),
            ...(evolutionModelContext ? [{ layer: "L4", name: "evolution", text: evolutionModelContext }] : []),
            ...(routedSkills ? [{ layer: "L4", name: "routedSkills", text: routedSkills }] : []),
            ...(strategyLayer ? [{ layer: "L4", name: "strategy", text: strategyLayer }] : []),
            ...(structuredFormat
              ? [
                  {
                    layer: "L1",
                    name: "structuredOutput",
                    text: StructuredOutput.systemPrompt({
                      retriesUsed: structuredRetriesUsed,
                      retryCount: structuredRetryCount,
                    }),
                  },
                ]
              : []),
            ...(requestSystemLayer ? [requestSystemLayer] : []),
          ],
          null,
        )
        compiledParts = compiled.parts as string[]
        compiledLayers = compiled.layers as ContextLayerReport[]
        RuntimeInsight.recordContextLayers({
          sessionID: session.id,
          timestamp: Date.now(),
          model: `${(model as { providerID?: string }).providerID ?? ""}/${model.id}`,
          totalTokens: compiled.totalTokens,
          layers: compiledLayers,
        })
      } catch (error) {
        console.error("runtime: compile failed", error)
      }
      const rawRequestMessages = [
        ...toLLMMessages(context, model),
        ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
      ]
      const configuredOutputTokens = model.defaults?.generation?.maxTokens ?? model.route.defaults.generation?.maxTokens
      const provisionalOutputTokens = Math.max(
        1,
        Math.floor(
          configuredOutputTokens ??
            model.defaults?.limits?.output ??
            model.route.defaults.limits?.output ??
            defaultProviderOutputTokenLimit,
        ),
      )
      const provisionalRequest = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: compiledParts.map(SystemPart.make),
        messages: rawRequestMessages,
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: structuredFormat ? "required" : isLastStep ? "none" : undefined,
        generation: { maxTokens: provisionalOutputTokens },
      })
      const projectedToolResults = compaction.pruneToolResultsIfNeeded({ model, request: provisionalRequest })
      const requestMessages = projectedToolResults?.messages ?? rawRequestMessages
      const providerInputText = [
        compiledParts.join("\n"),
        ...requestMessages.map((message) => JSON.stringify(message) ?? ""),
      ].join("\n")
      const outputTokenSnapshot = yield* durableRuns.load(runID).pipe(Effect.orDie)
      if (!("sessionID" in outputTokenSnapshot.run) || outputTokenSnapshot.run.sessionID !== session.id)
        return yield* Effect.die(new Error(`Durable run ${runID} is not bound to Session ${session.id}`))
      if (!outputTokenSnapshot.activeAttempt)
        return yield* Effect.die(new Error(`Durable run ${runID} has no active attempt for a provider call`))
      const activeAttempt = outputTokenSnapshot.activeAttempt
      const budgetOutputTokens = DurableRun.providerOutputTokenAllowance({
        snapshot: outputTokenSnapshot,
        cumulativeSessionTokens: sessionTokenTotal(session.tokens),
        estimatedInputTokens: Token.estimate(providerInputText),
        modelMaxOutputTokens:
          model.defaults?.limits?.output ?? model.route.defaults.limits?.output ?? defaultProviderOutputTokenLimit,
      })
      // A model/route generation default is a user-visible contract, not just
      // metadata. Keep the durable budget allowance as the upper bound while
      // preserving that configured maxTokens in the exact provider request.
      const maxOutputTokens =
        configuredOutputTokens === undefined
          ? budgetOutputTokens
          : Math.min(budgetOutputTokens, Math.max(0, Math.floor(configuredOutputTokens)))
      if (maxOutputTokens < 1)
        return yield* Effect.die(
          new DurableRun.BudgetExhaustedError({
            runID,
            attemptsUsed: outputTokenSnapshot.run.budget.attemptsUsed,
            maxAttempts: outputTokenSnapshot.run.budget.maxAttempts,
            reason: `Token budget cannot admit another provider request (${outputTokenSnapshot.run.budget.tokensUsed}/${outputTokenSnapshot.run.budget.maxTokens} settled tokens).`,
          }),
        )
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: compiledParts.map(SystemPart.make),
        messages: requestMessages,
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: structuredFormat ? "required" : isLastStep ? "none" : undefined,
        generation: { maxTokens: maxOutputTokens },
      })
      // The envelope is the deterministic boundary between Core assembly and
      // the provider. It binds the normalized request to the run/step and
      // revision identities without persisting any credential value.
      if (
        !recoveryRequest &&
        (yield* compaction
          .compactIfNeeded({
            sessionID: session.id,
            runID,
            turnStep: currentStep,
            attempt: activeAttempt.attempt,
            entries,
            model,
            request,
            surfaceEpoch: system.baselineSeq,
            executeProvider: executeCompactionProvider(runID, session.id, billing, executionLease, validateExecution),
          })
          .pipe(Effect.tap(() => validateExecution)))
      )
        return yield* Effect.die(continueAfterCompaction(currentStep))
      let providerPrepared = yield* llm.prepare(request)
      let preparationConsumed = false
      const requestEnvelope = createRequestEnvelope({
        request,
        transmission: providerPrepared.transmission,
        execution: {
          run_id: runID,
          turn_step: currentStep,
          attempt: activeAttempt.attempt,
          prompt_digest: latestPrompt === undefined ? undefined : PromptSystem.promptDigest(latestPrompt),
          context_digest: digest(providerInputText),
          compiler_revision: "context-compiler/v1",
          ...(skillSnapshotDigest === undefined ? {} : { skill_snapshot_digest: skillSnapshotDigest }),
          credential_identity: SessionRunnerModel.credentialIdentity(model),
          tool_set_revision: digest(toolMaterialization?.definitions ?? []),
          route_config_revision: digest({
            id: model.route.id,
            protocol: String(model.route.protocol),
            endpoint: {
              baseURL: model.route.endpoint.baseURL,
              query: model.route.endpoint.query,
              path: typeof model.route.endpoint.path === "string" ? model.route.endpoint.path : "dynamic",
            },
          }),
        },
      })
      assertRequestEnvelope(requestEnvelope, request)
      assertPreparedRequestEnvelope(requestEnvelope, providerPrepared)
      if (recoveryRequest) {
        // Re-resolve current context, tools, model and authorization, but retain
        // the original request identity. A changed request is not cold replay.
        const current = createRequestEnvelope({
          request,
          transmission: providerPrepared.transmission,
          execution: { ...requestEnvelope.execution, attempt: recoveryRequest.envelope.execution.attempt },
        })
        if (current.request_digest !== recoveryRequest.envelope.request_digest)
          throw new SessionCheckpoint.RecoveryRequiredError(
            "The prepared request no longer matches current context, tools, model or credentials. Recovery is paused; restore the original configuration or start a separate request.",
          )
      }
      // This projection does not rewrite Session history. Record it only
      // after compaction declines so the exact pruned bytes below are the
      // request that will actually cross the provider boundary.
      if (projectedToolResults?.changed) {
        RuntimeInsight.auditRecord({
          actor: "runtime",
          action: "context.tool-result.pruned",
          resource: `session:${session.id}`,
          reason: "deterministic provider request projection",
          metadata: {
            revision: projectedToolResults.revision,
            results: projectedToolResults.pruned.length,
            charsRemoved: projectedToolResults.charsRemoved,
            thresholdChars: projectedToolResults.config.thresholdChars,
            headChars: projectedToolResults.config.headChars,
            tailChars: projectedToolResults.config.tailChars,
          },
        })
        RuntimeInsight.recordMetric({
          name: "context.tool_result_pruned",
          value: projectedToolResults.charsRemoved,
          unit: "count",
          attributes: {
            sessionID: session.id,
            revision: projectedToolResults.revision,
            results: projectedToolResults.pruned.length,
            measure: "unicode-code-points",
          },
        })
      }
      if (latestRequest !== undefined && latestUserMessage && memoryPreparation) {
        const prepared = memoryPreparation.status === "prepared" ? memoryPreparation.prepared : undefined
        yield* events.publish(SessionEvent.MemoryContextPrepared, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          userMessageID: latestUserMessage.id,
          turnStep: currentStep,
          queryDigest: createHash("sha256").update(latestRequest).digest("hex"),
          contextDigest: createHash("sha256")
            .update(prepared?.text ?? "")
            .digest("hex"),
          injectedBytes: new TextEncoder().encode(prepared?.text ?? "").byteLength,
          status: memoryPreparation.status,
          algorithm: "hybrid_bm25_hashing_vector",
          localOnly: true,
          candidates:
            prepared?.results.items.map((hit, index) => ({
              memoryID: hit.memory.id,
              rank: index + 1,
              score: hit.score,
              lexicalScore: hit.lexicalScore,
              vectorScore: hit.vectorScore,
            })) ?? [],
        })
      }
      if (
        latestRequest !== undefined &&
        latestUserMessage &&
        memoryPreparation &&
        learningPreparation &&
        evolutionPreparation
      ) {
        const memoryPrepared = memoryPreparation.status === "prepared" ? memoryPreparation.prepared : undefined
        const fusionContexts = [memoryContext, learningContext, evolutionContext.text]
        const bytes = fusionContexts.map((text) => new TextEncoder().encode(text).byteLength)
        const digest = (text: string) => createHash("sha256").update(text).digest("hex")
        yield* events.publish(SessionEvent.ContextFusionPrepared, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          userMessageID: latestUserMessage.id,
          turnStep: currentStep,
          queryDigest: digest(latestRequest),
          combinedContextDigest: digest(fusionContexts.join("\0")),
          totalInjectedBytes: bytes.reduce((sum, value) => sum + value, 0),
          providerCallReady: true,
          degraded:
            memoryPreparation.status === "unavailable" ||
            learningPreparation.status === "unavailable" ||
            evolutionPreparation.status === "unavailable",
          assemblyProtocol: "arforge.context/2",
          runtimeTopology: "typescript-single-runtime",
          memory: {
            runtime: "typescript-core",
            status: memoryPreparation.status,
            contextDigest: digest(memoryContext),
            injectedBytes: bytes[0]!,
            candidateCount: memoryPrepared?.results.items.length ?? 0,
          },
          learning: {
            runtime: "typescript-core",
            status: learningPreparation.status,
            contextDigest: digest(learningContext),
            injectedBytes: bytes[1]!,
          },
          evolution: {
            runtime: "typescript-core",
            status: evolutionPreparation.status,
            contextDigest: digest(evolutionContext.text),
            injectedBytes: bytes[2]!,
            activeCandidateCount: evolutionContext.activeCandidateIDs.length,
            injectedCandidateCount: evolutionContext.injectedCandidateIDs.length,
          },
        })
      }
      // Persist the exact normalized request only after any compaction decision
      // has settled. This is the EventV2 reconstruction boundary; provider
      // credentials are rejected during envelope serialization.
      // Read the exact committed event, retaining its publication identity.
      // Parsing our local serialized string would not verify database state.
      const committedRequest =
        recoveryRequest?.event ??
        (yield* Effect.gen(function* () {
          const requestPublication = yield* events.publish(SessionEvent.RequestEnvelopePrepared, {
            sessionID: session.id,
            timestamp: yield* DateTime.now,
            runID,
            turnStep: currentStep,
            attempt: outputTokenSnapshot.activeAttempt!.attempt,
            schemaVersion: requestEnvelope.schema_version,
            requestDigest: requestEnvelope.request_digest,
            envelope: requestEnvelopeJson(requestEnvelope),
          })
          return yield* EventV2.readCommitted(db, SessionEvent.RequestEnvelopePrepared, requestPublication)
        }))
      const committedRequestData = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(
        committedRequest.data,
      )
      const persistedRequestEnvelope = parseRequestEnvelopeJson(committedRequestData.envelope)
      assertRequestEnvelope(persistedRequestEnvelope, request)
      assertPreparedRequestEnvelope(persistedRequestEnvelope, providerPrepared)
      const turnBinding: SessionCheckpoint.TurnBinding = {
        turnStep: currentStep,
        requestDigest: persistedRequestEnvelope.request_digest,
        contextDigest: persistedRequestEnvelope.execution.context_digest ?? digest(providerInputText),
        toolSetRevision:
          persistedRequestEnvelope.execution.tool_set_revision ?? digest(toolMaterialization?.definitions ?? []),
        routeConfigRevision:
          persistedRequestEnvelope.execution.route_config_revision ??
          digest({
            id: model.route.id,
            protocol: String(model.route.protocol),
            endpoint: {
              baseURL: model.route.endpoint.baseURL,
              query: model.route.endpoint.query,
              path: typeof model.route.endpoint.path === "string" ? model.route.endpoint.path : "dynamic",
            },
          }),
        compilerRevision: persistedRequestEnvelope.execution.compiler_revision ?? "context-compiler/v1",
      }
      // The same metadata-only projection contract used by parity acceptance
      // is checked at the live formal provider boundary. Missing optional
      // envelope fields are represented as invalid sentinels so the invariant
      // fails closed instead of silently widening the request identity.
      yield* RunnerInvariants.assert(invariants, {
        kind: "request-projection",
        sessionID: String(session.id),
        runtime: "formal",
        projection: {
          schemaVersion: 1,
          runID: persistedRequestEnvelope.execution.run_id ?? "",
          turnStep: persistedRequestEnvelope.execution.turn_step ?? 0,
          attempt: persistedRequestEnvelope.execution.attempt ?? 0,
          requestDigest: persistedRequestEnvelope.request_digest,
          contextDigest: persistedRequestEnvelope.execution.context_digest ?? "",
          toolSetRevision: persistedRequestEnvelope.execution.tool_set_revision ?? "",
          routeConfigRevision: persistedRequestEnvelope.execution.route_config_revision ?? "",
          compilerRevision: persistedRequestEnvelope.execution.compiler_revision ?? "",
        },
      })
      const providerRequest = rebuildRequest(
        persistedRequestEnvelope,
        model,
        SessionRunnerModel.credentialIdentity(model),
      )
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        runID,
        requestDigest: persistedRequestEnvelope.request_digest,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
        textSuppressed: () => goalDeliveryLocked || primaryDeliveries.delivered(session.id),
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (
        event: LLMEvent,
        outputPaths: ReadonlyArray<string> = [],
        artifactRefs: ReadonlyArray<AgentRuntime.OpaqueArtifactRef> = [],
      ) => withPublication(publisher.publish(event, outputPaths, artifactRefs))
      const quiesceTools = Effect.fnUntraced(function* (reason: string) {
        const result = toolMaterialization?.quiesce
          ? yield* toolMaterialization.quiesce()
          : ({ status: "quiescent", active: 0 } as const)
        if (result.status !== "timed_out") return
        // A timed-out drain is evidence that a child did not reach the
        // scheduler release boundary. Do not start a continuation or retry;
        // the model receives an explicit unknown-outcome reminder and the
        // durable action remains the reconciliation authority.
        RuntimeInsight.auditRecord({
          actor: "runtime",
          action: "tool.quiescence.timeout",
          resource: `session:${session.id}`,
          reason,
          metadata: {
            runID,
            sessionID: session.id,
            traceID,
            activeExecutions: result.active,
          },
        })
        RuntimeInsight.recordMetric({
          name: "tool.quiescence.timeout",
          value: result.active,
          unit: "count",
          attributes: { runID, sessionID: session.id, traceID },
        })
        yield* withPublication(
          publisher.failUnsettledTools(
            "Tool execution did not quiesce; its outcome is unknown and it was not retried. Reconcile before trying again.",
          ),
        )
      })
      let overflowFailure: ProviderErrorEvent | undefined
      const toolsUsed = new Set<string>()
      const providerToolCalls: string[] = []
      const prepareBillingCall = () =>
        billing
          ? RuntimeBilling.prepareCall(billing, {
              reservationID: `billing_${runID}_${currentStep}_${randomUUID()}`,
              providerID: String(model.provider),
              modelID: String(model.id),
              inputText: providerInputText,
              outputTokens: request.generation?.maxTokens ?? 0,
            })
          : undefined
      let billingCall = prepareBillingCall()
      const makeProviderStream = () => {
        assertPreparedRequestEnvelope(persistedRequestEnvelope, providerPrepared)
        providerSendStarted = true
        preparationConsumed = true
        return llm.streamPrepared(providerPrepared).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (overflowFailure || publisher.hasProviderError()) return
              if (LLMEvent.is.providerError(event)) {
                if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                  overflowFailure = event
                  return
                }
              }
              yield* publish(event)
              if (event.type !== "tool-call") return
              toolsUsed.add(event.name)
              providerToolCalls.push(event.name)
              if (event.providerExecuted) return
              if (!toolMaterialization) {
                yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
                return
              }
              needsContinuation = true
              const toolSequence = nextToolSequence++
              const assistantMessageID = yield* publisher.assistantMessageID(event.id)
              const repeatDecision = repeatGuard.observe({ name: event.name, input: event.input })
              if (repeatDecision.kind === "blocked") {
                // Keep the guard at the Session Runner boundary: the tool call
                // is already represented durably as Tool.Called, but no
                // ActionGateway/ToolRegistry effect is started. The ordered
                // synthetic error below becomes the durable Tool.Failed
                // reminder that the next provider request can observe.
                RuntimeInsight.auditRecord({
                  actor: "runtime",
                  action: "tool.repeat-guard.blocked",
                  resource: `tool:${repeatDecision.name}`,
                  reason:
                    repeatDecision.reason === "previous-failure"
                      ? "Exact canonical tool call already failed; unchanged retry blocked"
                      : "Exact canonical tool-call repeat bound reached",
                  metadata: {
                    runID,
                    sessionID: session.id,
                    traceID,
                    callID: event.id,
                    inputDigest: repeatDecision.digest,
                    repeatCount: repeatDecision.repeatCount,
                    maxRepeats: repeatDecision.maxRepeats,
                    blockReason: repeatDecision.reason,
                  },
                })
                RuntimeInsight.recordMetric({
                  name: "tool.repeat_guard.blocked",
                  value: 1,
                  unit: "count",
                  attributes: {
                    runID,
                    sessionID: session.id,
                    traceID,
                    tool: repeatDecision.name,
                    inputDigest: repeatDecision.digest,
                  },
                })
                localToolOutcomes.set(toolSequence, {
                  id: event.id,
                  name: event.name,
                  input: event.input,
                  outputPaths: [],
                  artifactRefs: [],
                  exit: Exit.succeed({
                    result: { type: "error", value: repeatDecision.message },
                  }),
                })
                return
              }
              yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const interruptedOutput = yield* Ref.make<ToolOutputStore.BoundResult | undefined>(undefined)
                  return yield* restore(
                    toolMaterialization
                      .settle({
                        runID,
                        sessionID: session.id,
                        agent: agent.id,
                        assistantMessageID,
                        call: event,
                        interruptedOutput,
                      })
                      .pipe(
                        Effect.onExit((exit) =>
                          Effect.gen(function* () {
                            const partial = yield* Ref.get(interruptedOutput)
                            if (partial) publisher.retainInterruptedOutput(event.id, partial)
                            localToolOutcomes.set(toolSequence, {
                              id: event.id,
                              name: event.name,
                              input: event.input,
                              outputPaths: Exit.isSuccess(exit) ? (exit.value.outputPaths ?? []) : [],
                              artifactRefs: Exit.isSuccess(exit) ? (exit.value.artifactRefs ?? []) : [],
                              exit,
                            })
                          }),
                        ),
                      ),
                  )
                }),
              ).pipe(FiberSet.run(toolFibers))
            }),
          ),
          Effect.ensuring(withPublication(publisher.flush())),
        )
      }
      const publishCompletedToolResults = Effect.fn("SessionRunner.publishCompletedToolResults")(function* () {
        for (let sequence = 0; sequence < nextToolSequence; sequence++) {
          const outcome = localToolOutcomes.get(sequence)
          if (!outcome) continue
          if (Exit.isSuccess(outcome.exit)) {
            yield* publish(
              LLMEvent.toolResult({
                id: outcome.id,
                name: outcome.name,
                result: outcome.exit.value.result,
                output: outcome.exit.value.output,
              }),
              outcome.outputPaths,
              outcome.artifactRefs,
            )
            repeatGuard.recordOutcome(
              { name: outcome.name, input: outcome.input },
              outcome.exit.value.result.type === "error",
            )
            continue
          }
          // Non-interrupting settlement errors are model-visible in the same
          // ordered lane. Interrupts remain pending so the quiescence path
          // below can emit the canonical interrupted failure exactly once.
          if (!Cause.hasInterrupts(outcome.exit.cause) && !isUserDeclined(outcome.exit.cause)) {
            const failure = Cause.squash(outcome.exit.cause)
            yield* publish(
              LLMEvent.toolError({
                id: outcome.id,
                name: outcome.name,
                message: `Tool execution failed: ${failure instanceof Error ? failure.message : String(failure)}`,
              }),
            )
            repeatGuard.recordOutcome({ name: outcome.name, input: outcome.input }, true)
          }
        }
      })
      // A provider call is an automatic, idempotent durable Action. Each
      // transport retry gets a fresh action identity so a blocked attempt can
      // never be silently replayed; the request digest keeps the identity
      // bound to the exact model/context contract without persisting content.
      const modelCallDigest = persistedRequestEnvelope.request_digest
      const modelCallSemantics = AgentRuntime.EffectSemantics.make({
        riskTier: "L0",
        authority: "automatic",
        idempotency: "idempotent",
        retryability: "never",
        reversibility: "not_applicable",
        filesystemScope: [],
        networkScope: [`provider:${String(model.provider)}`],
        secretScope: [],
        externalServices: [String(model.provider)],
        expectedArtifacts: [],
        successCriteria: ["Provider stream settled"],
      })
      let providerAttempt = 0
      const recordRequestDispatch = (phase: SessionCheckpoint.RequestDispatch["phase"]) =>
        durableRuns
          .checkpoint({
            runID,
            state: (current) =>
              SessionCheckpoint.withRequestDispatch(current, {
                sessionID: session.id,
                turn: turnBinding,
                dispatch: {
                  version: 1,
                  requestEventID: committedRequest.id,
                  requestDigest: persistedRequestEnvelope.request_digest,
                  turnStep: currentStep,
                  attempt: executionLease.attempt,
                  providerAttempt,
                  phase,
                },
              }),
            execution: executionLease,
          })
          .pipe(Effect.orDie)
      let providerBilling:
        | { billingSettlement: RuntimeBilling.SettledCall | undefined; billingCostMicros: number }
        | undefined
      let pendingBillingReceipt: ReturnType<typeof RuntimeBilling.encodeReservationReceipt> | undefined
      let providerSendStarted = false
      const executeProviderStream = Effect.fnUntraced(function* () {
        yield* validateExecution
        yield* SessionRunnerModel.validateCredential(model)
        // A retry gets a fresh one-shot handle, but must reproduce the same
        // committed transmission before reserving budget or sending anything.
        if (preparationConsumed) providerPrepared = yield* llm.prepare(providerRequest)
        assertPreparedRequestEnvelope(persistedRequestEnvelope, providerPrepared)
        yield* recordRequestDispatch("prepared")
        yield* persistBillingReservation({
          runID,
          sessionID: session.id,
          providerID: String(model.provider),
          modelID: String(model.id),
          modelCallDigest,
          billing,
          billingCall,
          executionLease,
          onReserved: (receipt) => {
            pendingBillingReceipt = receipt
          },
        })
        yield* durableRuns.validateLease({ runID, ...executionLease }).pipe(Effect.orDie)
        yield* SessionRunnerModel.validateCredential(model)
        yield* recordRequestDispatch("dispatching")
        yield* validateExecution
        yield* SessionRunnerModel.validateCredential(model)
        return yield* makeProviderStream()
      })
      const runProviderStream = () => {
        pendingBillingReceipt = undefined
        providerSendStarted = false
        providerBilling = undefined
        const attempt = providerAttempt++
        const startedAt = Date.now()
        const mode = modelOverride === undefined ? (attempt === 0 ? "primary" : "retry") : "fallback"
        let actionID: AgentRuntime.ActionID | undefined
        // Keep the ordinary first provider turn on the existing hot path. A
        // durable Action is required for recovery-producing retries and
        // fallback calls; this avoids adding gateway scheduling latency to
        // every normal session wake while still making every recovery branch
        // durable.
        const effect =
          attempt === 0 && modelOverride === undefined
            ? executeProviderStream()
            : (() => {
                const assistantMessageID = SessionMessage.ID.make(`msg_llm_${modelCallDigest.slice(0, 24)}`)
                const toolCallID = `model-call-${modelCallDigest.slice(0, 24)}-${attempt}`
                actionID = ActionGateway.stableActionID({
                  runID,
                  sessionID: session.id,
                  assistantMessageID,
                  toolCallID,
                })
                return actions.execute(
                  {
                    actionID,
                    runID,
                    name: "llm.provider-call",
                    resources: [`provider:${String(model.provider)}`, `model:${String(model.id)}`],
                    semantics: modelCallSemantics,
                    reasonSummary: "Execute one bounded provider model call",
                    initiator: "agent",
                    traceID,
                    inputDigest: modelCallDigest,
                    sessionID: session.id,
                    agent: agent.id,
                    assistantMessageID,
                    toolCallID,
                  },
                  {
                    execute: () => executeProviderStream(),
                    successSummary: () => "Provider model call settled",
                  },
                )
              })()
        return effect.pipe(
          Effect.onExit((exit) =>
            settleProviderBilling(exit, billingCall).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  providerBilling = result
                }),
              ),
              // Keep asynchronous settlement out of the already interrupted stream
              // fiber, but join it before leaving this attempt; never detach billing.
              Effect.uninterruptible,
              Effect.forkChild,
              Effect.flatMap(Fiber.join),
            ),
          ),
          Effect.withSpan("Arforge.ModelCall", {
            attributes: {
              "arforge.run_id": runID,
              "arforge.session_id": session.id,
              "arforge.trace_id": traceID,
              "arforge.provider_id": String(model.provider),
              "arforge.model_id": String(model.id),
              "arforge.request_digest": modelCallDigest,
              "arforge.attempt": attempt,
              "arforge.mode": mode,
            },
          }),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const finishedAt = Date.now()
              const failure = Exit.isFailure(exit)
                ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                : undefined
              const status = Exit.isSuccess(exit)
                ? "succeeded"
                : Cause.hasInterruptsOnly(exit.cause)
                  ? "interrupted"
                  : "failed"
              RuntimeInsight.recordModelCall({
                runID,
                sessionID: session.id,
                traceID,
                ...(actionID ? { actionID } : {}),
                providerID: String(model.provider),
                modelID: String(model.id),
                requestDigest: modelCallDigest,
                mode,
                attempt,
                status,
                category: RuntimeRetry.classifyFailure(failure),
                outputStarted: publisher.hasAssistantStarted(),
                toolCallStarted: toolsUsed.size > 0,
                startedAt,
                finishedAt,
                durationMs: finishedAt - startedAt,
              })
              RuntimeInsight.recordMetric({
                name: "llm.call",
                value: 1,
                unit: "count",
                attributes: {
                  runID,
                  sessionID: session.id,
                  traceID,
                  providerID: String(model.provider),
                  modelID: String(model.id),
                  mode,
                  status,
                  category: RuntimeRetry.classifyFailure(failure),
                },
              })
              RuntimeInsight.recordMetric({
                name: "llm.latency",
                value: finishedAt - startedAt,
                unit: "milliseconds",
                attributes: {
                  runID,
                  sessionID: session.id,
                  traceID,
                  providerID: String(model.provider),
                  modelID: String(model.id),
                },
              })
            }),
          ),
        )
      }

      const settleProviderBilling = (
        stream: Exit.Exit<unknown, unknown>,
        billingCall: RuntimeBilling.PreparedCall | undefined,
      ) => {
        const stepSettlement = publisher.stepSettlement()
        return settleBillingCall({
          runID,
          sessionID: session.id,
          providerID: String(model.provider),
          modelID: String(model.id),
          modelCallDigest,
          billing,
          billingCall,
          pendingBillingReceipt,
          stream,
          executionLease,
          sendStarted: providerSendStarted,
          usage: stepSettlement?.usage === undefined ? undefined : RuntimeBilling.fromStepTokens(stepSettlement.tokens),
        })
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let transportRetriesUsed = 0
          let priorBillingCostMicros = inheritedBillingCostMicros
          let stream = yield* Effect.suspend(() => restore(runProviderStream()).pipe(Effect.exit))
          while (stream._tag === "Failure") {
            const failure = Option.getOrUndefined(Cause.findErrorOption(stream.cause))
            const decision = RuntimeRetry.decide({
              failure,
              outputStarted: publisher.hasAssistantStarted(),
              toolCallStarted: toolsUsed.size > 0,
              transportRetriesUsed,
              maxTransportRetries,
              fallbackAvailable: false,
            })
            if (decision.action !== "retry") break
            // Every attempted send has its own reservation and settlement.
            // A billable failure must consume budget before authorizing another send.
            if (!providerBilling) return yield* Effect.failCause(stream.cause)
            priorBillingCostMicros += providerBilling.billingCostMicros
            billingCall = prepareBillingCall()
            transportRetriesUsed += 1
            RuntimeInsight.auditRecord({
              actor: "runtime",
              action: "llm.retry",
              resource: `${String(model.provider)}/${String(model.id)}`,
              reason: decision.reason,
              metadata: {
                runID,
                sessionID: session.id,
                traceID,
                category: decision.category,
                retryNumber: transportRetriesUsed,
              },
            })
            RuntimeInsight.recordMetric({
              name: "llm.retry",
              value: 1,
              unit: "count",
              attributes: {
                runID,
                sessionID: session.id,
                traceID,
                providerID: String(model.provider),
                modelID: String(model.id),
              },
            })
            stream = yield* Effect.suspend(() => restore(runProviderStream()).pipe(Effect.exit))
          }
          // A completed provider stream may leave local tools running. Persist
          // the semantic continuation before awaiting those tools so an
          // explicit interrupt cannot fall back to a pre-turn or missing
          // checkpoint. The same cursor is overwritten by the ordinary loop
          // settlement after all tools complete.
          if (stream._tag === "Success" && needsContinuation && providerToolCalls.length > 0) {
            const interruptedCheckpoint = SessionCheckpoint.make({
              sessionID: session.id,
              nextStep: SessionCheckpoint.nextStepAfterInterruption({
                turnStep: currentStep,
                providerOutputObserved: true,
              }),
              nextPromotion: "steer",
              needsContinuation: true,
              lastTurn: turnBinding,
            })
            yield* RunnerInvariants.assert(invariants, {
              kind: "checkpoint-cursor",
              sessionID: String(session.id),
              runID: String(runID),
              checkpoint: SessionCheckpoint.decode(interruptedCheckpoint, session.id),
              restoringContinuation: true,
            })
            yield* durableRuns
              .checkpoint({
                runID,
                state: (current) => SessionCheckpoint.intoContainer(current, interruptedCheckpoint, session.id),
                execution: executionLease,
              })
              .pipe(Effect.orDie)
          }
          if (!providerBilling) {
            if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
            return yield* Effect.die(
              new RuntimeBilling.BudgetStateError("Provider call ended without billing settlement"),
            )
          }
          const finalBilling = providerBilling
          const billingSettlement = finalBilling.billingSettlement
          const billingCostMicros = priorBillingCostMicros + finalBilling.billingCostMicros
          if (
            stream._tag === "Failure" &&
            !publisher.hasAssistantStarted() &&
            toolsUsed.size === 0 &&
            !publisher.hasProviderError() &&
            session.model === undefined &&
            modelOverride === undefined &&
            models.resolveFallback
          ) {
            const failure = Option.getOrUndefined(Cause.findErrorOption(stream.cause))
            const decision = RuntimeRetry.decide({
              failure,
              outputStarted: false,
              toolCallStarted: false,
              transportRetriesUsed,
              maxTransportRetries,
              fallbackAvailable: true,
            })
            if (decision.action === "fallback") {
              const fallbackModel = yield* models.resolveFallback(session, model, decision.category)
              if (fallbackModel && (fallbackModel.provider !== model.provider || fallbackModel.id !== model.id)) {
                RuntimeInsight.auditRecord({
                  actor: "runtime",
                  action: "llm.fallback",
                  resource: `${String(model.provider)}/${String(model.id)}->${String(fallbackModel.provider)}/${String(fallbackModel.id)}`,
                  reason: decision.reason,
                  metadata: {
                    runID,
                    sessionID: session.id,
                    category: decision.category,
                    originalProviderID: String(model.provider),
                    originalModelID: String(model.id),
                    fallbackProviderID: String(fallbackModel.provider),
                    fallbackModelID: String(fallbackModel.id),
                  },
                })
                RuntimeInsight.recordMetric({
                  name: "llm.fallback",
                  value: 1,
                  unit: "count",
                  attributes: {
                    runID,
                    sessionID: session.id,
                    traceID,
                    providerID: String(fallbackModel.provider),
                    modelID: String(fallbackModel.id),
                  },
                })
                return yield* runTurnAttempt(
                  sessionID,
                  promotion,
                  currentStep,
                  runID,
                  traceID,
                  billing,
                  maxTransportRetries,
                  repeatGuard,
                  executionLease,
                  recoverOverflow,
                  fallbackModel,
                  scheduledTaskRuntime,
                  checkpointExecution,
                  billingCostMicros,
                )
              }
            }
          }
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(
              validateExecution.pipe(
                Effect.andThen(
                  durableRuns
                    .checkpoint({
                      runID,
                      state: (current) =>
                        SessionCheckpoint.intoContainer(
                          current,
                          SessionCheckpoint.make({
                            sessionID: session.id,
                            nextStep: currentStep,
                            needsContinuation: true,
                            lastTurn: turnBinding,
                          }),
                          session.id,
                        ),
                      execution: executionLease,
                    })
                    .pipe(Effect.orDie),
                ),
                Effect.andThen(
                  recoverOverflow({
                    sessionID: session.id,
                    runID,
                    turnStep: currentStep,
                    attempt: activeAttempt.attempt,
                    entries,
                    model,
                    request,
                    surfaceEpoch: system.baselineSeq,
                    executeProvider: executeCompactionProvider(
                      runID,
                      session.id,
                      billing,
                      executionLease,
                      validateExecution,
                    ),
                  }).pipe(Effect.tap(() => validateExecution)),
                ),
              ),
            ))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          // A tool may have finished before a sibling or the provider turn;
          // commit all completed outcomes through one ordered barrier before
          // marking anything still pending as interrupted/failed.
          yield* publishCompletedToolResults()
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* quiesceTools("User declined the tool permission while the execution lane was draining")
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* quiesceTools("Provider turn interruption required the tool execution lane to drain")
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
            // Durable partial output is continued, never replayed as the same
            // request. Tools have drained and their interrupted results above
            // are committed; unresolved billing still gates the next run.
            if (publisher.hasAssistantStarted())
              yield* durableRuns
                .checkpoint({
                  runID,
                  state: (current) =>
                    SessionCheckpoint.intoContainer(
                      current,
                      SessionCheckpoint.make({
                        sessionID: session.id,
                        nextStep: SessionCheckpoint.nextStepAfterInterruption({
                          turnStep: currentStep,
                          providerOutputObserved: true,
                        }),
                        nextPromotion: "steer",
                        needsContinuation: true,
                        lastTurn: turnBinding,
                      }),
                      session.id,
                    ),
                  execution: executionLease,
                })
                .pipe(Effect.orDie)
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const structuredCandidates = Array.from(localToolOutcomes.values()).filter(
            (outcome) => outcome.name === StructuredOutput.name,
          )
          const structuredCandidate =
            providerToolCalls.length === 1 &&
            providerToolCalls[0] === StructuredOutput.name &&
            structuredCandidates.length === 1
              ? structuredCandidates[0]
              : undefined
          const structuredValue =
            structuredCandidate &&
            Exit.isSuccess(structuredCandidate.exit) &&
            structuredCandidate.exit.value.result.type !== "error" &&
            typeof structuredCandidate.input === "object" &&
            structuredCandidate.input !== null &&
            !Array.isArray(structuredCandidate.input)
              ? (structuredCandidate.input as NonNullable<SessionMessage.Assistant["structured"]>)
              : undefined
          let structuredFailureMessage: string | undefined
          const contentFiltered = publisher.stepSettlement()?.finish === "content-filter"
          if (structuredFormat && !contentFiltered && !publisher.hasProviderError() && stream._tag === "Success") {
            if (structuredValue !== undefined) {
              // A successful final projection is terminal even though every
              // local tool call normally requests another provider turn.
              needsContinuation = false
            } else {
              const completedPreFinalWork =
                !isLastStep && providerToolCalls.some((tool) => tool !== StructuredOutput.name)
              if (completedPreFinalWork) {
                needsContinuation = true
              } else if (structuredRetriesUsed < structuredRetryCount) {
                needsContinuation = true
              } else {
                needsContinuation = false
                structuredFailureMessage = StructuredOutput.exhaustedMessage(structuredRetryCount)
                yield* withPublication(publisher.failAssistant(structuredFailureMessage))
              }
            }
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            if (!billingSettlement)
              RuntimeInsight.recordBilling({
                billingID: `billing_${randomUUID()}`,
                runID,
                sessionID: session.id,
                providerID: String(model.provider),
                modelID: String(model.id),
                usage: RuntimeBilling.fromStepTokens(stepSettlement.tokens),
              })
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            if (!structuredFailureMessage)
              yield* withPublication(
                events.publish(SessionEvent.Step.Ended, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  // StructuredOutput is a semantic terminal projection. Keep
                  // the provider's `tool-calls` transport reason out of the
                  // user-facing session state so the formal runner and the
                  // mature Prompt adapter share one terminal contract.
                  finish: structuredValue !== undefined ? "stop" : stepSettlement.finish,
                  cost: billingCostMicros / 1_000_000,
                  tokens: stepSettlement.tokens,
                  snapshot: endSnapshot,
                  files,
                  structured: structuredValue,
                }),
              )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          const maintain = (success: boolean, errorType = "", errorMessage = "") => {
            if (!latestRequest) return Effect.void
            const tokens = publisher.stepSettlement()?.tokens
            const tokenCount = tokens
              ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
              : 0
            const learningMaintenance = learning
              .record({
                sessionID: session.id,
                turnIndex: currentStep,
                userInput: latestRequest,
                route: "agentic",
                tools: [...toolsUsed],
                success,
                errorType,
                errorMessage,
                tokenCount: Math.max(0, Math.trunc(tokenCount)),
                injectedContextSize: injectedLearningBytes,
                tags: ["runtime"],
              })
              .pipe(
                Effect.andThen(learning.proposalCandidates()),
                Effect.flatMap((patterns) =>
                  patterns.length > 0 ? evolution.syncLearningPatterns(patterns) : Effect.void,
                ),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    console.warn(`runtime: learning sync failed for ${session.id}:`, error)
                    RuntimeInsight.auditRecord({
                      actor: "runtime",
                      action: "learning.sync.failed",
                      resource: session.id,
                      reason: error instanceof Error ? error.message : String(error),
                    })
                  }),
                ),
              )
            const evolutionMaintenance =
              evolutionContext.activeCandidateIDs.length > 0 && evolutionContext.exposureID
                ? publisher.startAssistant().pipe(
                    Effect.flatMap((assistantMessageID) =>
                      evolution.recordOutcome({
                        exposureID: evolutionContext.exposureID!,
                        success,
                        stopReason: success ? "completed" : `${errorType}: ${errorMessage}`,
                        assistantMessageID,
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        console.warn(`runtime: evolution outcome record failed for ${session.id}:`, error)
                        RuntimeInsight.auditRecord({
                          actor: "runtime",
                          action: "evolution.outcome.record.failed",
                          resource: session.id,
                          reason: error instanceof Error ? error.message : String(error),
                        })
                      }),
                    ),
                  )
                : Effect.void
            return Effect.all(
              [learningMaintenance, memory.extract(latestRequest).pipe(Effect.ignore), evolutionMaintenance],
              { concurrency: "unbounded", discard: true },
            )
          }
          if (stream._tag === "Failure") {
            // Cancellation is not a task outcome. Recording it as a learning
            // failure changes the next assembly and poisons exact recovery of
            // a request that has not even reached the provider.
            if (Cause.hasInterruptsOnly(stream.cause)) return yield* Effect.failCause(stream.cause)
            yield* maintain(
              false,
              failure instanceof Error ? failure.constructor.name : "ProviderError",
              overflowFailure?.message ??
                (failure instanceof Error ? failure.message : failure === undefined ? "" : String(failure)),
            )
            return yield* Effect.failCause(stream.cause)
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          const primaryDelivered = primaryDeliveries.consume(session.id)
          const terminal = contentFiltered || !needsContinuation || primaryDelivered || publisher.hasProviderError()
          if (terminal)
            yield* maintain(
              !contentFiltered &&
                !publisher.hasProviderError() &&
                settled._tag === "Success" &&
                !structuredFailureMessage,
              publisher.hasProviderError()
                ? "ProviderError"
                : contentFiltered
                  ? "ContentFilterError"
                  : structuredFailureMessage
                    ? "StructuredOutputError"
                    : settled._tag === "Failure"
                      ? "ToolSettlementError"
                      : "",
              publisher.hasProviderError()
                ? (overflowFailure?.message ?? "Provider returned an error")
                : contentFiltered
                  ? "The response was blocked by the provider's content filter"
                  : structuredFailureMessage
                    ? structuredFailureMessage
                    : settled._tag === "Failure"
                      ? String(Cause.squash(settled.cause))
                      : "",
            )
          return {
            needsContinuation:
              !contentFiltered && !publisher.hasProviderError() && needsContinuation && !primaryDelivered,
            step: currentStep,
            lastTurn: turnBinding,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      runID: AgentRuntime.RunID,
      traceID: string,
      billing: RuntimeBilling.RunScope | undefined,
      maxTransportRetries: number,
      repeatGuard: RepeatGuard.Interface,
      executionLease: ExecutionLease,
      modelOverride: LLMModel | undefined,
      scheduledTaskRuntime: ScheduledTaskRuntime | undefined,
      checkpointExecution?: DurableRun.CheckpointExecution,
    ) => Effect.Effect<RunTurnResult, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (
        sessionID,
        promotion,
        step,
        runID,
        traceID,
        billing,
        maxTransportRetries,
        repeatGuard,
        executionLease,
        modelOverride,
        scheduledTaskRuntime,
        checkpointExecution,
      ) {
        return yield* runTurnAttempt(
          sessionID,
          promotion,
          step,
          runID,
          traceID,
          billing,
          maxTransportRetries,
          repeatGuard,
          executionLease,
          undefined,
          modelOverride,
          scheduledTaskRuntime,
          checkpointExecution,
        ).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                sessionID,
                undefined,
                defect.transition.step,
                runID,
                traceID,
                billing,
                maxTransportRetries,
                repeatGuard,
                executionLease,
                modelOverride,
                scheduledTaskRuntime,
                checkpointExecution,
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(
      function* (
        sessionID,
        promotion,
        step,
        runID,
        traceID,
        billing,
        maxTransportRetries,
        repeatGuard,
        executionLease,
        modelOverride,
        scheduledTaskRuntime,
        checkpointExecution,
      ) {
        return yield* runTurnAttempt(
          sessionID,
          promotion,
          step,
          runID,
          traceID,
          billing,
          maxTransportRetries,
          repeatGuard,
          executionLease,
          compaction.compactAfterOverflow,
          modelOverride,
          scheduledTaskRuntime,
          checkpointExecution,
        ).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              yield* Effect.yieldNow
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* runAfterOverflowCompaction(
                  sessionID,
                  undefined,
                  defect.transition.step,
                  runID,
                  traceID,
                  billing,
                  maxTransportRetries,
                  repeatGuard,
                  executionLease,
                  modelOverride,
                  scheduledTaskRuntime,
                  checkpointExecution,
                )
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                runID,
                traceID,
                billing,
                maxTransportRetries,
                repeatGuard,
                executionLease,
                modelOverride,
                scheduledTaskRuntime,
                checkpointExecution,
              )
            }),
          ),
        )
      },
    )

    const runLoop = Effect.fn("SessionRunner.runLoop")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly runID: AgentRuntime.RunID
      readonly executionLease: ExecutionLease
      readonly traceID: string
      readonly billing: RuntimeBilling.RunScope | undefined
      readonly maxTransportRetries: number
      readonly scheduledTaskRuntime?: ScheduledTaskRuntime
      /** A recoverable run may have a semantic cursor that must be consumed. */
      readonly resumeFromCheckpoint: boolean
      readonly childAttempt?: Parameters<Interface["run"]>[0]["childAttempt"]
    }) {
      const principal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
      const billingRows = yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(
          and(
            eq(SessionRunUsageTable.run_id, input.runID),
            eq(SessionRunUsageTable.session_id, input.sessionID),
            eq(SessionRunUsageTable.tenant_id, principal.tenantID),
            eq(SessionRunUsageTable.owner_user_id, principal.userID),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (input.billing) {
        const pendingRows = billingRows.filter(
          (row) => row.settlement_reservation_id === null && row.billing_receipt !== null,
        )
        if (pendingRows.length > 1)
          yield* Effect.die(
            new RuntimeBilling.BudgetStateError(
              "Multiple unresolved billing reservations require explicit reconciliation",
            ),
          )
        const scope = RuntimeBilling.makeRunScope({
          runID: input.runID,
          config: input.billing.config,
          receipts: billingRows.filter((row) => !pendingRows.includes(row)),
        })
        const pending = pendingRows[0]
        if (pending) {
          const reconcile = input.billing.config.reconcileUsage
          if (!reconcile)
            return yield* Effect.die(
              new RuntimeBilling.ReconciliationPendingError(
                "Unsettled billing reservation requires reconciliation before budget recovery",
              ),
            )
          const prepared = RuntimeBilling.resumeReservation(scope, pending.billing_receipt, {
            runID: input.runID,
            reservationID: pending.id,
            providerID: pending.provider_id,
            modelID: pending.model_id,
          })
          const saved = RuntimeBilling.decodeReservationReceipt(pending.billing_receipt, {
            runID: input.runID,
            reservationID: pending.id,
            providerID: pending.provider_id,
            modelID: pending.model_id,
          })
          // Bind recovery to the execution that entered this loop. Loading the
          // current lease here could silently adopt a replacement worker's lease.
          const lease = { runID: input.runID, ...input.executionLease }
          yield* durableRuns.validateLease(lease).pipe(Effect.orDie)
          const lookup = yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                reconcile({
                  runID: input.runID,
                  reservationID: pending.id,
                  providerID: pending.provider_id,
                  modelID: pending.model_id,
                  requestDigest: saved.requestDigest,
                  failureCategory: "recovery",
                }),
              ),
            catch: () =>
              new RuntimeBilling.ReconciliationPendingError(
                "Usage reconciliation unavailable; billing reservation remains unresolved",
              ),
          }).pipe(Effect.timeoutOption("5 seconds"), Effect.orDie)
          const usage = Option.getOrUndefined(lookup)
          if (!usage || usage.source !== "provider")
            return yield* Effect.die(
              new RuntimeBilling.ReconciliationPendingError(
                "Confirmed provider usage is required to recover an unresolved reservation",
              ),
            )
          yield* durableRuns.validateLease(lease).pipe(Effect.orDie)
          if (input.childAttempt)
            yield* SubagentChildExecutor.validateExecution({ ...input.childAttempt, sessionID: input.sessionID }).pipe(
              Effect.provideService(DurableRun.Service, durableRuns),
              Effect.orDie,
            )
          const before = scope.state
          const settled = RuntimeBilling.settleCall(scope, prepared, Billing.TokenUsage.make(usage))
          yield* persistBillingSettlement({
            runID: input.runID,
            sessionID: input.sessionID,
            providerID: pending.provider_id,
            modelID: pending.model_id,
            requestDigest: saved.requestDigest,
            prepared,
            before,
            settled,
            pendingReceipt: RuntimeBilling.encodeReservationReceipt({
              prepared,
              state: before,
              providerID: pending.provider_id,
              modelID: pending.model_id,
              requestDigest: saved.requestDigest,
            }),
            onSettlement: input.billing.config.onSettlement,
            executionLease: input.executionLease,
          })
        }
        input.billing.state = scope.state
      } else if (billingRows.some((row) => row.billing_receipt !== null)) {
        yield* Effect.die(new RuntimeBilling.BudgetStateError("Recovered billed run requires its billing policy"))
      }
      const durableSnapshot = yield* durableRuns.load(input.runID).pipe(Effect.orDie)
      const personalJob = "admission" in durableSnapshot.run ? durableSnapshot.run.admission?.personalJob : undefined
      const ownedInput = personalJob ? yield* SessionInput.find(db, personalJob.occurrence.messageID) : undefined
      const hasSteer = personalJob ? false : yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = personalJob
        ? ownedInput !== undefined && ownedInput.promotedSeq === undefined
        : hasSteer
          ? false
          : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      yield* failInterruptedTools(input.sessionID)

      // DurableRun owns persistence and integrity (event sequence, state digest,
      // resume token). SessionCheckpoint owns the semantic meaning of that
      // state. Keep the two responsibilities separate and fail closed when a
      // checkpoint is malformed instead of silently restarting at step one.
      const checkpoint = durableSnapshot.checkpoint
        ? SessionCheckpoint.fromContainer(durableSnapshot.checkpoint.state, input.sessionID)
        : undefined
      const dispatch =
        checkpoint && !checkpoint.legacy && checkpoint.kind === SessionCheckpoint.KIND ? checkpoint.dispatch : undefined
      if (input.resumeFromCheckpoint && dispatch?.phase === "dispatching")
        return yield* Effect.die(
          new SessionCheckpoint.RecoveryRequiredError(
            "The prior request may already have been sent; automatic replay is blocked until its outcome is reconciled.",
          ),
        )
      if (input.resumeFromCheckpoint && dispatch && (hasSteer || hasQueue))
        return yield* Effect.die(
          new SessionCheckpoint.RecoveryRequiredError(
            "The prepared request has newer pending input. Recovery is paused before promoting or executing it; review the pending input before continuing.",
          ),
        )
      const restoringContinuation =
        input.resumeFromCheckpoint && (checkpoint?.needsContinuation === true || dispatch !== undefined)
      yield* RunnerInvariants.assert(invariants, {
        kind: "checkpoint-cursor",
        sessionID: String(input.sessionID),
        runID: String(input.runID),
        checkpoint,
        restoringContinuation,
      })
      if (!input.force && !hasSteer && !hasQueue && !restoringContinuation) return

      let promotion: SessionInput.Delivery | undefined = hasSteer
        ? "steer"
        : hasQueue
          ? "queue"
          : restoringContinuation
            ? checkpoint?.nextPromotion
            : undefined
      let shouldRun = input.force || hasSteer || hasQueue || restoringContinuation
      let firstCycle = true
      while (shouldRun) {
        // Keep one exact-repeat streak across continuation steps for the same
        // user cycle. A queued cycle gets a fresh guard below; a steer also
        // resets the streak before the promoted input is handled.
        const repeatGuard = RepeatGuard.make()
        let needsContinuation = true
        let step = firstCycle && restoringContinuation ? (dispatch?.turnStep ?? checkpoint?.nextStep ?? 1) : 1
        firstCycle = false
        let queuedNextCycle = false
        while (needsContinuation) {
          if (input.childAttempt)
            yield* SubagentChildExecutor.validateExecution({ ...input.childAttempt, sessionID: input.sessionID }).pipe(
              Effect.provideService(DurableRun.Service, durableRuns),
              Effect.orDie,
            )
          const result = yield* runTurn(
            input.sessionID,
            promotion,
            step,
            input.runID,
            input.traceID,
            input.billing,
            input.maxTransportRetries,
            repeatGuard,
            input.executionLease,
            undefined,
            input.scheduledTaskRuntime,
            input.childAttempt?.execution,
          ).pipe(
            Effect.withSpan("Arforge.Step", {
              attributes: {
                "arforge.run_id": input.runID,
                "arforge.session_id": input.sessionID,
                "arforge.trace_id": input.traceID,
                "arforge.step": step,
              },
            }),
          )

          const hasPendingSteer = personalJob ? false : yield* SessionInput.hasPending(db, input.sessionID, "steer")
          const pendingSteer = result.needsContinuation || hasPendingSteer
          if (pendingSteer) {
            if (hasPendingSteer) repeatGuard.reset()
            needsContinuation = true
            step = result.step + 1
            promotion = "steer"
          } else {
            // Queue promotion is a second user turn. Record that promotion
            // before mutating the durable input queue so a crash between the
            // two operations still has an unambiguous recovery cursor.
            queuedNextCycle = personalJob ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
            needsContinuation = queuedNextCycle
            step = queuedNextCycle ? 1 : result.step + 1
            promotion = queuedNextCycle ? "queue" : undefined
          }
          const checkpointState = SessionCheckpoint.make({
            sessionID: input.sessionID,
            nextStep: step,
            nextPromotion: promotion,
            needsContinuation,
            lastTurn: result.lastTurn,
          })
          yield* RunnerInvariants.assert(invariants, {
            kind: "checkpoint-cursor",
            sessionID: String(input.sessionID),
            runID: String(input.runID),
            checkpoint: SessionCheckpoint.decode(checkpointState, input.sessionID),
            restoringContinuation: needsContinuation,
          })
          yield* durableRuns
            .checkpoint({
              runID: input.runID,
              state: (current) => SessionCheckpoint.intoContainer(current, checkpointState, input.sessionID),
              execution: input.executionLease,
            })
            .pipe(Effect.orDie)
          if (queuedNextCycle) break
        }
        shouldRun = queuedNextCycle
      }
    })

    const settleRunningGoal = Effect.fn("SessionRunner.settleRunningGoal")(function* (
      sessionID: SessionSchema.ID,
      exit: Exit.Exit<void, RunError>,
    ) {
      const active = (yield* goals.list({ sessionID, includeHistory: false })).active
      if (!active || active.status !== "running") return
      const error = Exit.isSuccess(exit)
        ? "Session settled without explicitly completing or blocking the active goal"
        : `Session execution failed: ${Cause.pretty(exit.cause)}`
      yield* goals
        .block({
          sessionID,
          goalID: active.id,
          expectedRevision: active.revision,
          error,
        })
        .pipe(Effect.ignore)
    })

    const run: Interface["run"] = (input) =>
      Effect.gen(function* () {
        if ("scheduledTask" in input)
          return yield* new TurnToolCarrier.InvalidCarrierError({
            carrier: "scheduled-task-retired-use-scheduledTaskTool",
          })
        const scheduledTaskRuntime: ScheduledTaskRuntime | undefined = input.scheduledTaskTool
          ? { tool: input.scheduledTaskTool, modelCalls: input.modelTaskCalls }
          : undefined
        const rawMaxTransportRetries = input.retry?.maxTransportRetries ?? 0
        yield* RunnerInvariants.assert(invariants, {
          kind: "execution-input",
          sessionID: String(input.sessionID),
          force: input.force,
          maxTransportRetries: rawMaxTransportRetries,
        })
        if (input.childAttempt) {
          if (input.personalJob)
            return yield* Effect.die(new Error("A PersonalJob occurrence cannot take ownership of a child attempt"))
          if (input.onSettled || input.settlementCollector)
            return yield* Effect.die(new Error("Child settlement remains owned by SubagentChildExecutor"))
          const borrowed = yield* SubagentChildExecutor.validateExecution({
            ...input.childAttempt,
            sessionID: input.sessionID,
          }).pipe(Effect.provideService(DurableRun.Service, durableRuns), Effect.orDie)
          const runID = input.childAttempt.childRunID
          return yield* deferredTools.withinRun(
            input.sessionID,
            primaryDeliveries.withinRun(
              input.sessionID,
              runLoop({
                ...input,
                runID,
                traceID: borrowed.run.traceID,
                executionLease: input.childAttempt.execution,
                billing: input.billing ? RuntimeBilling.makeRunScope({ runID, config: input.billing }) : undefined,
                maxTransportRetries: rawMaxTransportRetries,
                scheduledTaskRuntime,
                resumeFromCheckpoint: borrowed.checkpoint !== undefined,
              }),
            ),
          )
        }
        // A lease owner identifies one execution attempt, not the whole process.
        // This fences accidental concurrent calls inside the same desktop process too.
        const durableWorkerID = `${durableProcessID}_${randomUUID()}`
        const session = yield* getSession(input.sessionID)
        const sessionRuns = yield* durableRuns
          .list({
            sessionID: input.sessionID,
            limit: Number.MAX_SAFE_INTEGER,
          })
          .pipe(Effect.orDie)
        if (input.personalJob) {
          const { jobID, occurrence } = input.personalJob
          const originalInput = yield* SessionInput.find(db, occurrence.messageID)
          if (
            !originalInput ||
            originalInput.sessionID !== input.sessionID ||
            originalInput.delivery !== "queue" ||
            !SessionInput.equivalent(originalInput, {
              sessionID: input.sessionID,
              delivery: "queue",
              prompt: Prompt.make({ text: originalInput.prompt.text }),
            }) ||
            occurrence.digest !==
              PersonalJobV2.occurrenceDigest(
                { id: jobID, sessionID: input.sessionID, prompt: originalInput.prompt.text },
                occurrence.messageID,
              )
          )
            return yield* Effect.die(
              new SessionCheckpoint.RecoveryRequiredError(
                "The PersonalJob input no longer matches its original occurrence; no execution was started.",
              ),
            )
          const bound = sessionRuns.filter(
            ({ run }) =>
              "admission" in run &&
              run.admission?.personalJob?.jobID === jobID &&
              run.admission.personalJob.occurrence.messageID === occurrence.messageID,
          )
          if (
            bound.length > 1 ||
            bound.some(
              ({ run }) => !("admission" in run) || digest(run.admission!.personalJob) !== digest(input.personalJob),
            )
          )
            return yield* Effect.die(
              new SessionCheckpoint.RecoveryRequiredError(
                "The PersonalJob occurrence has conflicting run identities; reconcile its original execution before resuming.",
              ),
            )
          if (bound.some(({ run }) => ["completed", "failed", "cancelled"].includes(run.status)))
            return yield* Effect.die(
              new SessionCheckpoint.RecoveryRequiredError(
                "This PersonalJob occurrence already has a terminal run. Recover its recorded result instead of executing it again.",
              ),
            )
          if (bound.length === 0 && originalInput.promotedSeq !== undefined)
            return yield* Effect.die(
              new SessionCheckpoint.RecoveryRequiredError(
                "The PersonalJob input was already consumed without a verifiable run binding; automatic re-execution is blocked.",
              ),
            )
        }
        const unfinishedChild = sessionRuns.find(
          (snapshot) =>
            "child" in snapshot.run &&
            snapshot.run.child &&
            !["completed", "failed", "cancelled"].includes(snapshot.run.status),
        )
        if (unfinishedChild)
          return yield* Effect.die(
            new Error(
              `Child run ${unfinishedChild.run.id} requires its ChildExecutor attempt; a root Session wake cannot take ownership`,
            ),
          )
        const prior = (yield* durableRuns.recoverable(input.sessionID)).at(0)
        if (
          !prior &&
          input.force &&
          sessionRuns[0]?.lastTransition?.reason === DurableRun.REQUEST_ABANDONED_REASON &&
          !(yield* SessionInput.hasPending(db, input.sessionID, "steer")) &&
          !(yield* SessionInput.hasPending(db, input.sessionID, "queue"))
        )
          return yield* Effect.die(
            new SessionCheckpoint.RecoveryRequiredError(
              "The previous unknown request was explicitly abandoned. Submit a new request; resuming must not resend the abandoned task.",
            ),
          )
        const credentialIDs = yield* SessionRunnerModel.CredentialScope
        const admission = AgentRuntime.SessionRunAdmission.make({
          version: 1,
          owner: "session-runner",
          personalJob: input.personalJob,
          credentialIDs: credentialIDs ? [...new Set(credentialIDs)].sort() : null,
          billing: input.billing
            ? {
                budget: input.billing.budget,
                estimatorID: (input.billing.estimator ?? RuntimeBilling.CharacterEstimator).id,
              }
            : null,
        })
        if (
          !prior &&
          !input.force &&
          !(yield* SessionInput.hasPending(db, input.sessionID, "steer")) &&
          !(yield* SessionInput.hasPending(db, input.sessionID, "queue"))
        ) {
          // A redundant wake may repair already-settled metadata, but must not
          // allocate another run, budget, attempt, or model request.
          yield* restoreTitle(session).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Could not restore conversation title", { sessionID: input.sessionID }),
            ),
          )
          return
        }
        // A paused run is a user-visible stop, not abandoned execution. Its
        // semantic continuation remains recoverable for explicit resume or new
        // admitted input, but a redundant/background wake must not restart it.
        if (
          prior?.run.status === "paused" &&
          !input.force &&
          !(yield* SessionInput.hasPending(db, input.sessionID, "steer")) &&
          !(yield* SessionInput.hasPending(db, input.sessionID, "queue"))
        )
          return
        // A no-op wake of a paused run needs no execution policy. An actual
        // continuation must validate the original admission before any mutation.
        if (prior?.run.admission) {
          const original = prior.run.admission
          if (
            prior.run.project !== session.projectID ||
            prior.run.location !== session.location.directory ||
            prior.run.authority !== "automatic" ||
            prior.run.riskTier !== "L0"
          )
            return yield* Effect.die(
              new SessionCheckpoint.RecoveryRequiredError(
                "The unfinished run's workspace or authority no longer matches this root execution. Restore its original execution scope before resuming; the original task has not been changed.",
              ),
            )
          yield* Effect.sync(() => RuntimeBilling.assertRecoveryBudget(original.billing?.budget, input.billing?.budget))
          const encode = Schema.encodeSync(AgentRuntime.SessionRunAdmission)
          if (digest(encode(original)) !== digest(encode(admission)))
            return yield* Effect.die(
              new SessionCheckpoint.RecoveryRequiredError(
                "The unfinished run has different credential or estimator constraints. Resume with its original credential scope and billing budget; the original task has not been changed.",
              ),
            )
        }
        let runID: AgentRuntime.RunID
        let claimed: DurableRun.Snapshot
        if (prior) {
          runID = prior.run.id
          claimed = yield* durableRuns
            .acquireLease({ runID, ownerID: durableWorkerID, ttlMs: durableLeaseTtlMs })
            .pipe(Effect.orDie)
          if (!claimed.lease) return yield* Effect.die(new Error(`Durable recovery lease missing for ${runID}`))
          if (prior.activeAttempt) {
            const recoveredAt = yield* DateTime.now
            const recoveredSession = yield* getSession(input.sessionID)
            const baseline =
              prior.activeAttempt.usageBaseline ?? AgentRuntime.RunUsageBaseline.make({ costMicros: 0, tokens: 0 })
            if (!prior.activeAttempt.usageBaseline)
              yield* Effect.logWarning("Recovering a legacy Session attempt without a persisted usage baseline", {
                runID,
                attempt: prior.activeAttempt.attempt,
              })
            const recoveredUsage = boundedAttemptUsage(prior.run, {
              durationMs: DateTime.toEpochMillis(recoveredAt) - DateTime.toEpochMillis(prior.activeAttempt.startedAt),
              costMicros: sessionCostMicrosTotal(recoveredSession.cost) - baseline.costMicros,
              tokens: sessionTokenTotal(recoveredSession.tokens) - baseline.tokens,
            })
            yield* durableRuns
              .finishAttempt({
                runID,
                attempt: prior.activeAttempt.attempt,
                execution: {
                  leaseID: claimed.lease.id,
                  ownerID: durableWorkerID,
                  attempt: prior.activeAttempt.attempt,
                },
                outcome: "interrupted",
                ...recoveredUsage,
              })
              .pipe(Effect.orDie)
          }
          const recovered = yield* durableRuns.load(runID).pipe(Effect.orDie)
          if (!["draft", "preflight", "queued"].includes(recovered.run.status)) {
            const execution = {
              leaseID: claimed.lease.id,
              ownerID: durableWorkerID,
              attempt: recovered.run.budget.attemptsUsed,
            }
            if (recovered.run.status !== "recovering")
              yield* durableRuns
                .transition({
                  runID,
                  to: "recovering",
                  reason: "Session resumed with durable state available",
                  execution,
                })
                .pipe(Effect.orDie)
            yield* durableRuns
              .transition({
                runID,
                to: "running",
                reason: "Session worker resumed from the latest checkpoint",
                execution,
              })
              .pipe(Effect.orDie)
          }
        } else {
          const created = yield* durableRuns.create(
            {
              sessionID: input.sessionID,
              admission,
              initiator: "user",
              authority: "automatic",
              riskTier: "L0",
              reasonSummary: "Run the accepted session work until it settles",
              budget: AgentRuntime.Budget.make({
                maxAttempts: 3,
                maxDurationMs: 60 * 60 * 1_000,
                maxCostMicros: 5_000_000,
                maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
                attemptsUsed: 0,
                durationMsUsed: 0,
                costMicrosUsed: 0,
                tokensUsed: 0,
              }),
              traceID: `trace_${input.sessionID}_${Date.now()}`,
              visibility: "details",
              project: session.projectID,
              location: session.location.directory,
              delegableCapabilities: [{ action: "*", resources: ["*"], access: "write" }],
            },
            { exclusiveSession: true, initialLease: { ownerID: durableWorkerID, ttlMs: durableLeaseTtlMs } },
          )
          runID = created.run.id
          claimed = created
        }
        if (!claimed.lease) return yield* Effect.die(new Error(`Durable admission lease missing for ${runID}`))
        // Resume only the stages that have not committed. All transitions use
        // the lease acquired before admission, including execution attempt zero.
        let admitted = yield* durableRuns.load(runID).pipe(Effect.orDie)
        const admissionExecution = {
          leaseID: claimed.lease.id,
          ownerID: durableWorkerID,
          attempt: admitted.run.budget.attemptsUsed,
        }
        for (const [from, to, reason] of [
          ["draft", "preflight", "Session and execution scope are available"],
          ["preflight", "queued", "Tool actions will be authorized individually by risk"],
          ["queued", "running", "Session worker started"],
        ] as const) {
          if (admitted.run.status !== from) continue
          admitted = yield* durableRuns
            .transition({ runID, to, reason, execution: admissionExecution })
            .pipe(Effect.orDie)
        }
        const billing = input.billing ? RuntimeBilling.makeRunScope({ runID, config: input.billing }) : undefined
        const maxTransportRetries = Math.max(0, Math.min(3, Math.floor(input.retry?.maxTransportRetries ?? 0)))
        const durableSnapshot = yield* durableRuns.load(runID).pipe(Effect.orDie)
        const leaseID = claimed.lease.id
        const usageBaseline = sessionUsageBaseline(yield* getSession(input.sessionID))
        const startedAttempt = yield* durableRuns
          .beginAttempt({ runID, usageBaseline, execution: admissionExecution })
          .pipe(Effect.orDie)
        const attempt = startedAttempt.activeAttempt?.attempt ?? startedAttempt.run.budget.attemptsUsed
        const attemptStartedAt = Date.now()
        RuntimeInsight.runBegin(input.sessionID, runID, { traceID: durableSnapshot.run.traceID })

        const effect = deferredTools.withinRun(
          input.sessionID,
          primaryDeliveries.withinRun(
            input.sessionID,
            runLoop({
              ...input,
              scheduledTaskRuntime,
              runID,
              traceID: durableSnapshot.run.traceID,
              executionLease: { leaseID, ownerID: durableWorkerID, attempt },
              billing,
              maxTransportRetries,
              resumeFromCheckpoint: prior !== undefined,
            }),
          ),
        )
        const heartbeat = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(`${durableHeartbeatMs} millis`)
            yield* durableRuns
              .heartbeat({
                runID,
                leaseID,
                ownerID: durableWorkerID,
                ttlMs: durableLeaseTtlMs,
              })
              .pipe(Effect.orDie)
          }
        })
        const runEffect = Effect.raceFirst(effect, heartbeat).pipe(
          Effect.withSpan("Arforge.Run", {
            attributes: {
              "arforge.run_id": runID,
              "arforge.session_id": input.sessionID,
              "arforge.trace_id": durableSnapshot.run.traceID,
            },
          }),
        )
        return yield* Effect.onExit(runEffect, (exit) =>
          Effect.gen(function* () {
            const current = yield* durableRuns.load(runID).pipe(Effect.orDie)
            if (
              current.lease?.id !== leaseID ||
              current.lease.ownerID !== durableWorkerID ||
              current.activeAttempt?.attempt !== attempt
            ) {
              RuntimeInsight.runFinish(runID, "interrupted", {
                error: "Execution lease or attempt ownership was lost; stale worker settlement was fenced.",
              })
              return
            }
            const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
            const billingPending =
              Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof RuntimeBilling.ReconciliationPendingError
            const recoveryPending =
              Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof SessionCheckpoint.RecoveryRequiredError
            // The lease fence above excludes stale workers. Child/Gateway
            // finalizers have settled before this parent projection runs.
            if (interrupted) yield* failInterruptedTools(input.sessionID, runID)
            let status: "completed" | "paused" | "failed"
            let reason: string
            if (Exit.isSuccess(exit)) {
              const verificationStartedAt = Date.now()
              const actionSnapshots = yield* durableActions.list({ runID, limit: 500 })
              const checks = durableSettlementChecks({
                runID,
                checkpoint: current.checkpoint,
                actions: actionSnapshots.map((action) => ({
                  actionID: action.action.id,
                  status: action.action.status,
                  observationStatus: action.observation?.status,
                })),
                digest,
              })
              const verification = summarize(checks)
              RuntimeInsight.recordVerification({
                timestamp: Date.now(),
                sessionID: input.sessionID,
                toolCallID: runID,
                claim: "Run checkpoint and durable side-effect actions satisfy completion conditions",
                commands: checks.map((check) => check.command),
                results: checks,
                passed: verification.passed,
                durationMs: Date.now() - verificationStartedAt,
              })
              status = verification.passed ? "completed" : "failed"
              reason = verification.passed
                ? "Session checkpoint and durable side-effect actions verified"
                : `Independent verification failed: ${verification.failedChecks.join(", ")}`
            } else {
              status = interrupted || billingPending || recoveryPending ? "paused" : "failed"
              reason = billingPending
                ? "Provider usage reconciliation remains pending; resume after usage is available"
                : recoveryPending
                  ? String(Cause.squash(exit.cause)).slice(0, 500)
                  : interrupted
                    ? "Execution interrupted and can be resumed from its latest checkpoint"
                    : Cause.pretty(exit.cause).slice(0, 500)
            }
            if (!interrupted && !billingPending && !recoveryPending) yield* settleRunningGoal(input.sessionID, exit)
            yield* RunnerInvariants.assert(invariants, {
              kind: "terminal",
              sessionID: String(input.sessionID),
              runID: String(runID),
              status,
              leaseMatches: true,
              attempt,
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Session runner terminal invariant failed after ownership check", {
                  sessionID: input.sessionID,
                  runID,
                  phase: error.phase,
                }),
              ),
            )
            const sessionAfter = yield* getSession(input.sessionID)
            const attemptUsage = boundedAttemptUsage(current.run, {
              durationMs: Date.now() - attemptStartedAt,
              costMicros: sessionCostMicrosTotal(sessionAfter.cost) - usageBaseline.costMicros,
              tokens: sessionTokenTotal(sessionAfter.tokens) - usageBaseline.tokens,
            })
            yield* durableRuns
              .finishAttempt({
                runID,
                attempt,
                outcome: status === "completed" ? "completed" : status === "paused" ? "interrupted" : "failed",
                ...attemptUsage,
              })
              .pipe(Effect.orDie)
            if (Exit.isSuccess(exit))
              yield* durableRuns
                .transition({ runID, to: "verifying", reason: "Independently verifying checkpoint and side effects" })
                .pipe(Effect.orDie)
            yield* durableRuns.transition({ runID, to: status, reason }).pipe(Effect.orDie)
            yield* durableRuns
              .releaseLease({
                runID,
                leaseID,
                ownerID: durableWorkerID,
                reason: `Run settled as ${status}`,
              })
              .pipe(Effect.orDie)
            // Rebuild the terminal boundary from committed EventV2 rows after
            // settlement. This is an audit-only check: a read/decoding issue
            // must not reopen a run or overwrite its durable status, but it
            // must remain visible without exposing event payloads.
            const terminalHistory = yield* SessionRunnerHistory.collectTerminalHistoryWithSource(
              SessionRunnerHistory.runnerEventRowSourceFromEventV2(events),
              { sessionID: input.sessionID, runID: String(runID) },
              { status, attempt, requireCheckpoint: status === "completed" },
            ).pipe(Effect.exit)
            if (Exit.isSuccess(terminalHistory)) {
              if (input.onSettled !== undefined)
                yield* input.onSettled(terminalHistory.value.summary).pipe(
                  Effect.catchCause(() =>
                    Effect.logWarning("Session runner settlement observer failed", {
                      sessionID: input.sessionID,
                      runID,
                      status,
                      attempt,
                    }),
                  ),
                )
              if (input.settlementCollector !== undefined)
                yield* input
                  .settlementCollector({
                    query: { sessionID: input.sessionID, runID: String(runID) },
                    summary: terminalHistory.value.summary,
                    source: terminalHistory.value.source,
                  })
                  .pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Session runner settlement collector failed", {
                        sessionID: input.sessionID,
                        runID,
                        status,
                        attempt,
                      }),
                    ),
                  )
            } else {
              yield* Effect.logWarning("Session runner terminal history validation failed", {
                sessionID: input.sessionID,
                runID,
                status,
                attempt,
              })
            }
            RuntimeInsight.runFinish(runID, status === "paused" ? "interrupted" : status, {
              error: status === "failed" ? reason : undefined,
            })
            if (status === "completed")
              yield* scheduleTitle(input.sessionID, billing).pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("Could not schedule conversation title", { sessionID: input.sessionID }),
                ),
              )
          }),
        )
      })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    DeferredTools.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    GoalV2.node,
    GoalGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    PrimaryDeliveryState.node,
    MemoryV2.node,
    LearningV2.node,
    EvolutionV2.node,
    DurableRun.node,
    DurableAction.node,
    ActionGateway.node,
    BackgroundJob.node,
    RuntimeInvariants.node,
  ],
})
