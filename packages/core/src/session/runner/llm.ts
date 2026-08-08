import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@arforge-ai/llm"
import { Cause, DateTime, Effect, Exit, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
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
import { ReferenceGuidance } from "../../reference/guidance"
import { GoalGuidance } from "../../goal/guidance"
import { GoalV2 } from "../../goal"
import { ToolRegistry } from "../../tool/registry"
import { DeferredTools } from "../../tool/deferred"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type Interface, type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
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
import { RuntimeInsight, type ContextLayerReport } from "../../runtime/insight"
import * as RuntimeCompiler from "../../runtime/compiler"
import * as RuntimeStrategy from "../../runtime/strategy"
import { createHash } from "node:crypto"

/** Prepared evolution exposure per session, reused across the steps of one user turn. */
const evolutionContextCache = new Map<
  string,
  { userMessageID: string; prepared: EvolutionV2.PreparedContext }
>()

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
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
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
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
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
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
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
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
        [systemContext.load(), skillGuidance.load(agent), referenceGuidance.load(), goalGuidance.load(sessionID)],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(session.id, agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(session.id, agent), session.id))
      const model = yield* models.resolve(session)
      const goalDeliveryLocked =
        (yield* goals.list({ sessionID: session.id, includeHistory: false })).active?.status === "running"
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const latestUserMessage = context.findLast((message) => message.type === "user")
      const latestRequest = latestUserMessage?.text
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
      const injectedLearningBytes = new TextEncoder().encode(learningContext).byteLength
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions, session.id)
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
            ...(memoryContext ? [{ layer: "L5", name: "memory", text: memoryContext }] : []),
            ...(learningContext ? [{ layer: "L4", name: "learning", text: learningContext }] : []),
            ...(evolutionContext.text ? [{ layer: "L4", name: "evolution", text: evolutionContext.text }] : []),
            ...(routedSkills ? [{ layer: "L4", name: "routedSkills", text: routedSkills }] : []),
            ...(strategyLayer ? [{ layer: "L4", name: "strategy", text: strategyLayer }] : []),
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
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: compiledParts.map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
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
          bridgeProtocol: "arforge.bridge/1.2",
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
            runtime: "python-sidecar",
            status: evolutionPreparation.status,
            contextDigest: digest(evolutionContext.text),
            injectedBytes: bytes[2]!,
            activeCandidateCount: evolutionContext.activeCandidateIDs.length,
            injectedCandidateCount: evolutionContext.injectedCandidateIDs.length,
          },
        })
      }
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
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
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const toolsUsed = new Set<string>()
      const providerStream = llm.stream(request).pipe(
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
            if (event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
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
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
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
          const terminal = !needsContinuation || primaryDelivered || publisher.hasProviderError()
          if (terminal)
            yield* maintain(
              !publisher.hasProviderError() && settled._tag === "Success",
              publisher.hasProviderError() ? "ProviderError" : settled._tag === "Failure" ? "ToolSettlementError" : "",
              publisher.hasProviderError()
                ? (overflowFailure?.message ?? "Provider returned an error")
                : settled._tag === "Failure"
                  ? String(Cause.squash(settled.cause))
                  : "",
            )
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation && !primaryDelivered,
            step: currentStep,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runLoop = Effect.fn("SessionRunner.runLoop")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
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

    const run: Interface["run"] = (input) => {
      const runID = `run_${input.sessionID}_${Date.now()}`
      try {
        RuntimeInsight.runBegin(input.sessionID, runID)
      } catch (error) {
        console.error("runtime: runBegin failed", error)
      }
      const effect = deferredTools.withinRun(
        input.sessionID,
        primaryDeliveries.withinRun(input.sessionID, runLoop(input)),
      )
      return Effect.onExit(effect, (exit) =>
        Effect.gen(function* () {
          yield* settleRunningGoal(input.sessionID, exit)
          try {
            RuntimeInsight.runFinish(runID, Exit.isSuccess(exit) ? "completed" : "failed", {
              error: Exit.isSuccess(exit) ? undefined : Cause.pretty(exit.cause).slice(0, 500),
            })
          } catch (error) {
            console.error("runtime: runFinish failed", error)
          }
        }),
      )
    }

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
  ],
})
