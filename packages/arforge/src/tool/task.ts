import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import type { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import {
  childCapabilityAllows,
  childCapabilityContractError,
  deriveSubagentSessionPermission,
} from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Context, DateTime, Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@arforge-ai/core/database/database"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { reasoningProfile } from "@arforge-ai/core/reasoning-profile"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import {
  customAgentRuntimeAdmissionEvidence,
  isCanonicalRuntimeTool,
  type CustomAgentRuntimeMetadata,
} from "@arforge-ai/core/custom-agent-profile"

export interface TaskPromptOps {
  /** Admission and wake only; notifications must not wait on the parent loop. */
  notify?(input: SessionPrompt.PromptInput): Effect.Effect<void>
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(
    input: SessionPrompt.PromptInput,
    childAttempt?: {
      readonly childRunID: AgentRuntime.RunID
      readonly execution: SubagentChildExecutor.ChildExecution
    },
  ): Effect.Effect<SessionV1.WithParts>
}

/**
 * The semantic TaskTool boundary shared by the legacy Mature adapter and the
 * Core-native scheduled-task tool.  The child lifecycle, permissions and
 * prompt operation are explicit values here; neither caller needs to invent
 * a second Tool.Definition or an opaque carrier context.
 */
export interface TaskExecutionContext {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly agent: string
  readonly sandboxProfile?: SandboxPolicy.Profile
  readonly abort: AbortSignal
  readonly callID?: string
  readonly parentAction?: {
    readonly actionID: AgentRuntime.ActionID
    readonly runID?: AgentRuntime.RunID
    readonly authority?: AgentRuntime.Authority
  }
  readonly nativeParent?: TaskNativeParent
  readonly bypassAgentCheck?: boolean
  /** Internal recovery delivery; never part of the model-facing parameters. */
  readonly restoreBackground?: boolean
  readonly promptOps: TaskPromptOps
  readonly metadata: (input: {
    readonly title?: string
    readonly metadata?: Record<string, unknown>
  }) => Effect.Effect<void>
  readonly ask: (input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.Effect<void>
}

/**
 * Parent routing facts supplied by the Core scheduled-task adapter. They are
 * read from durable Core session/task state, so TaskTool never needs a
 * synthetic Mature assistant message merely to discover its model.
 */
export type TaskNativeParent = Readonly<{
  modelID: string
  providerID: string
  variant?: string
}>

function nativeParentFrom(extra: Tool.Context["extra"]): TaskNativeParent | undefined {
  const value = extra?.nativeParent
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const modelID = "modelID" in value ? value.modelID : undefined
  const providerID = "providerID" in value ? value.providerID : undefined
  const variant = "variant" in value ? value.variant : undefined
  if (typeof modelID !== "string" || typeof providerID !== "string") return
  if (variant !== undefined && typeof variant !== "string") return
  return { modelID, providerID, ...(variant ? { variant } : {}) }
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  capabilities: Schema.optional(Schema.Array(AgentRuntime.ChildCapability)).annotate({
    description: "Explicit child action/resource capabilities; omitted means read-only.",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

const RecoveryIntent = Schema.Struct({
  version: Schema.Literal(1),
  childRunID: AgentRuntime.RunID,
  parentRunID: AgentRuntime.RunID,
  parentActionID: AgentRuntime.ActionID,
  childSessionID: SessionID,
  childMessageID: Schema.optional(MessageID),
  parentSessionID: SessionID,
  parentMessageID: MessageID,
  callID: Schema.String,
  parentAgent: Schema.String,
  childAgent: Schema.String,
  model: Schema.Struct({ modelID: Schema.String, providerID: Schema.String, variant: Schema.optional(Schema.String) }),
  directory: Schema.String,
  permissionDigest: Schema.String,
  sandboxProfile: SandboxPolicy.ProfileSchema,
  parameters: Parameters,
})

/** Frozen admission data, not permission to run. Recovery must revalidate policy and ownership. */
export function readRecoveryIntent(child: DurableRun.ChildSnapshot) {
  const envelope = child.checkpoint?.state.taskRecovery
  const decoded = Schema.decodeUnknownSync(Schema.Struct({ intent: RecoveryIntent, digest: Schema.String }))(envelope)
  const intent = decoded.intent
  if (
    canonicalHash(intent) !== decoded.digest ||
    intent.childRunID !== child.run.id ||
    intent.parentRunID !== child.run.child.parentRunID ||
    intent.childSessionID !== child.run.sessionID ||
    intent.callID !== child.run.child.idempotencyKey ||
    intent.parameters.prompt !== child.run.child.delegatedObjective
  )
    throw new Error("Task recovery intent does not match its immutable child binding")
  return intent
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

const CHILD_MAX_DURATION_MS = 15 * 60 * 1_000
const CHILD_MAX_COST_MICROS = 1_000_000
const CHILD_MAX_TOKENS = 250_000
const CHILD_MAX_ATTEMPTS = 2

const TaskNotification = Schema.Struct({
  messageID: MessageID,
  delivered: Schema.Boolean,
  payload: Schema.optional(Schema.Struct({ agent: Schema.String, text: Schema.String })),
})

export function hasPendingTaskNotification(child: DurableRun.ChildSnapshot) {
  const envelope = child.checkpoint?.state.taskRecovery
  if (!envelope || typeof envelope !== "object" || !("notification" in envelope)) return false
  return !Schema.decodeUnknownSync(TaskNotification)(envelope.notification).delivered
}

/** Admission is durable; coordinator wake is not. Reconcile against the original inbox. */
export const taskNotificationParentToWake = Effect.fn("TaskTool.notificationParentToWake")(function* (
  child: DurableRun.ChildSnapshot,
) {
  const envelope = child.checkpoint?.state.taskRecovery
  if (!envelope || typeof envelope !== "object" || !("notification" in envelope)) return
  const notification = Schema.decodeUnknownSync(TaskNotification)(envelope.notification)
  if (!notification.delivered || !notification.payload) return
  const intent = readRecoveryIntent(child)
  const database = yield* Database.Service
  const input = yield* SessionInput.find(database.db, SessionMessage.ID.make(notification.messageID))
  if (
    !input ||
    !SessionInput.equivalent(input, {
      sessionID: SessionSchema.ID.make(intent.parentSessionID),
      delivery: "steer",
      prompt: Prompt.make({ text: notification.payload.text, route: { agent: notification.payload.agent } }),
    })
  )
    return yield* Effect.die("Delivered task notification does not match its durable input")
  if (input.promotedSeq !== undefined) return
  const runs = yield* DurableRun.Service
  const latest = (yield* runs.list({ sessionID: intent.parentSessionID, limit: 1 }).pipe(Effect.orDie))[0]
  // Reconciliation is not an explicit resume or authorization decision.
  if (latest && ["paused", "cancelled", "awaiting_authorization"].includes(latest.run.status)) return
  return intent.parentSessionID
})

const setTaskNotification = Effect.fn("TaskTool.setNotification")(function* (
  runID: AgentRuntime.RunID,
  notification: typeof TaskNotification.Type,
) {
  const runs = yield* DurableRun.Service
  yield* runs.checkpoint({
    runID,
    state: (state) => {
      const envelope = state?.taskRecovery
      if (!state || !envelope || typeof envelope !== "object") throw new Error("Missing task recovery envelope")
      const previous =
        "notification" in envelope ? Schema.decodeUnknownSync(TaskNotification)(envelope.notification) : undefined
      if (
        previous &&
        (previous.messageID !== notification.messageID ||
          (previous.payload &&
            notification.payload &&
            canonicalHash(previous.payload) !== canonicalHash(notification.payload)))
      )
        throw new Error("Task notification identity or payload changed")
      return {
        ...state,
        taskRecovery: {
          ...envelope,
          notification: {
            ...previous,
            ...notification,
            ...(previous?.payload ? { payload: previous.payload } : {}),
            delivered: notification.delivered || previous?.delivered === true,
          },
        },
      }
    },
  })
})

const registerTaskNotification = Effect.fn("TaskTool.registerNotification")(function* (runID: AgentRuntime.RunID) {
  const runs = yield* DurableRun.Service
  const current = yield* runs.load(runID)
  const envelope = current.checkpoint?.state.taskRecovery
  if (!envelope || typeof envelope !== "object") return yield* Effect.die("Missing task recovery envelope")
  if ("notification" in envelope) {
    Schema.decodeUnknownSync(TaskNotification)(envelope.notification)
    return
  }
  yield* setTaskNotification(runID, {
    messageID: MessageID.make(`msg_task_notice_${canonicalHash(runID)}`),
    delivered: false,
  })
})

/** Reuses the original child checkpoint and SessionInput; no independent delivery queue. */
export const deliverTaskNotification = Effect.fn("TaskTool.deliverNotification")(function* (
  runID: AgentRuntime.RunID,
  notify: NonNullable<TaskPromptOps["notify"]>,
) {
  const runs = yield* DurableRun.Service
  const sessions = yield* Session.Service
  const snapshot = yield* runs.load(runID)
  if (!("sessionID" in snapshot.run) || !snapshot.run.child)
    return yield* Effect.die("Notification requires a child run")
  const child = snapshot as DurableRun.ChildSnapshot
  if (!hasPendingTaskNotification(child)) return
  const intent = readRecoveryIntent(child)
  const envelope = child.checkpoint!.state.taskRecovery as Record<string, unknown>
  const notification = Schema.decodeUnknownSync(TaskNotification)(envelope.notification)
  const siblings = (yield* runs.list({ sessionID: child.run.sessionID, limit: Number.MAX_SAFE_INTEGER })).filter(
    (item) => "sessionID" in item.run && item.run.child,
  )
  if (siblings.some((item) => !["completed", "failed", "cancelled"].includes(item.run.status))) return
  const targetRunID =
    "notificationTailRunID" in envelope
      ? Schema.decodeUnknownSync(AgentRuntime.RunID)(envelope.notificationTailRunID)
      : runID
  const latest = siblings.find((item) => item.run.id === targetRunID)
  if (!latest || !("sessionID" in latest.run)) return
  if (latest.run.status === "cancelled") {
    yield* setTaskNotification(runID, { ...notification, delivered: true })
    return
  }
  if (!latest.run.childResult) return yield* Effect.die("Terminal task result is missing")
  const state = latest.run.status === "completed" ? "completed" : "error"
  const parent = yield* sessions.get(intent.parentSessionID)
  const payload = notification.payload ?? {
    agent: parent.agent ?? intent.parentAgent,
    text: renderOutput({
      sessionID: intent.childSessionID,
      state,
      summary: `Background task ${state === "completed" ? "completed" : "failed"}: ${intent.parameters.description}`,
      text: latest.run.childResult.summary,
    }),
  }
  if (!notification.payload) yield* setTaskNotification(runID, { ...notification, payload })
  yield* notify({
    messageID: notification.messageID,
    sessionID: intent.parentSessionID,
    agent: payload.agent,
    parts: [{ type: "text", synthetic: true, text: payload.text }],
  })
  yield* setTaskNotification(runID, { ...notification, payload, delivered: true })
})

function customAgentRuntimeMetadata(agent: Agent.Info): CustomAgentRuntimeMetadata | undefined {
  const value = agent.options.custom_profile
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schema_version !== 1 || record.provider !== "in-process") return undefined
  if (
    typeof record.role !== "string" ||
    typeof record.profile_path !== "string" ||
    typeof record.descriptor_digest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.descriptor_digest) ||
    typeof record.max_steps !== "number" ||
    !Number.isSafeInteger(record.max_steps) ||
    record.max_steps < 1 ||
    record.max_steps > 25 ||
    typeof record.max_tokens !== "number" ||
    !Number.isSafeInteger(record.max_tokens) ||
    record.max_tokens < 256 ||
    record.max_tokens > 16_000 ||
    typeof record.timeout_seconds !== "number" ||
    !Number.isSafeInteger(record.timeout_seconds) ||
    record.timeout_seconds < 10 ||
    record.timeout_seconds > 600 ||
    !Array.isArray(record.canonical_tools) ||
    record.canonical_tools.length === 0 ||
    new Set(record.canonical_tools).size !== record.canonical_tools.length ||
    !record.canonical_tools.every((item) => typeof item === "string" && isCanonicalRuntimeTool(item))
  )
    return undefined
  const admissionEvidence =
    record.admission_evidence === undefined ? undefined : customAgentRuntimeAdmissionEvidence(record.admission_evidence)
  if (admissionEvidence !== undefined && (!admissionEvidence.valid || admissionEvidence.decision !== "admitted"))
    return undefined
  return value as CustomAgentRuntimeMetadata
}

export function boundChildBudgetForCustomAgent(
  budget: AgentRuntime.Budget,
  profile: CustomAgentRuntimeMetadata,
): AgentRuntime.Budget {
  return AgentRuntime.Budget.make({
    ...budget,
    maxDurationMs: Math.min(budget.maxDurationMs, profile.timeout_seconds * 1_000),
    maxTokens: Math.min(budget.maxTokens, profile.max_tokens),
  })
}

const sessionCostMicrosTotal = (cost: number | undefined) => Math.max(0, Math.round(Math.max(0, cost ?? 0) * 1_000_000))
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
  Math.max(
    0,
    Math.round(
      (tokens?.input ?? 0) +
        (tokens?.output ?? 0) +
        (tokens?.reasoning ?? 0) +
        (tokens?.cache.read ?? 0) +
        (tokens?.cache.write ?? 0),
    ),
  )
const sessionTokenDelta = (before: number, after: number) => Math.max(0, Math.round(after - before))
function childBudgetFor(input: {
  readonly parent: DurableRun.SessionSnapshot
  readonly sessionCostMicros: number
  readonly sessionTokens: number
  readonly nowMs: number
}) {
  const run = input.parent.run
  const reserved = run.childBudgetReserved ?? { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 }
  const active = input.parent.activeAttempt
  // New attempts persist an exact baseline. For a legacy active attempt,
  // zero is deliberately conservative: all projected session usage counts
  // against the remaining parent budget instead of being silently ignored.
  const baseline = active?.usageBaseline ?? { costMicros: 0, tokens: 0 }
  const inFlightDuration = active ? Math.max(0, input.nowMs - DateTime.toEpochMillis(active.startedAt)) : 0
  const inFlightCostMicros = active ? Math.max(0, input.sessionCostMicros - baseline.costMicros) : 0
  const inFlightTokens = active ? Math.max(0, input.sessionTokens - baseline.tokens) : 0
  const remaining = {
    attempts: run.budget.maxAttempts - run.budget.attemptsUsed - reserved.attempts,
    durationMs: run.budget.maxDurationMs - run.budget.durationMsUsed - reserved.durationMs - inFlightDuration,
    costMicros: run.budget.maxCostMicros - run.budget.costMicrosUsed - reserved.costMicros - inFlightCostMicros,
    tokens: run.budget.maxTokens - run.budget.tokensUsed - reserved.tokens - inFlightTokens,
  }
  return AgentRuntime.Budget.make({
    maxAttempts: Math.max(0, Math.min(CHILD_MAX_ATTEMPTS, remaining.attempts)),
    maxDurationMs: Math.max(0, Math.min(CHILD_MAX_DURATION_MS, remaining.durationMs)),
    maxCostMicros: Math.max(0, Math.min(CHILD_MAX_COST_MICROS, remaining.costMicros)),
    maxTokens: Math.max(0, Math.min(CHILD_MAX_TOKENS, remaining.tokens)),
    attemptsUsed: 0,
    durationMsUsed: 0,
    costMicrosUsed: 0,
    tokensUsed: 0,
  })
}

export const TaskRuntime = Effect.gen(function* () {
  const agent = yield* Agent.Service
  const background = yield* BackgroundJob.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const scope = yield* Scope.Scope
  const flags = yield* RuntimeFlags.Service
  const database = yield* Database.Service
  // The provider adapter is optional during the legacy compatibility window.
  // Durable child runs resolve it from the invocation context; legacy
  // unmetered tasks keep their existing behavior without widening the layer's
  // error contract or taking a snapshot before AppRuntime is assembled.
  const childExecutor = yield* SubagentChildExecutor.Service

  const run = Effect.fn("TaskTool.execute")(function* (
    params: Schema.Schema.Type<typeof Parameters>,
    ctx: TaskExecutionContext,
  ) {
    const cfg = yield* config.get()
    const subagentProvider = Option.getOrUndefined(
      yield* Effect.contextWith((context: Context.Context<never>) =>
        Effect.succeed(Context.getOption(context, SubagentProvider.Service)),
      ),
    )
    const durableRunsOption = yield* Effect.serviceOption(DurableRun.Service)
    const durableRuns = Option.getOrUndefined(durableRunsOption)
    const runInBackground = params.background === true || ctx.restoreBackground === true
    if (runInBackground && !ctx.restoreBackground && !flags.experimentalBackgroundSubagents) {
      return yield* Effect.fail(
        new Error("Background subagents require ARFORGE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
      )
    }

    const parent = yield* sessions.get(ctx.sessionID)
    let current = parent
    let depth = 0
    while (current.parentID) {
      depth++
      current = yield* sessions.get(current.parentID)
    }
    if (depth >= (cfg.subagent_depth ?? 1)) {
      return yield* Effect.fail(
        new Error(
          `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
        ),
      )
    }

    const nativeParent = ctx.nativeParent
    const msg = nativeParent
      ? undefined
      : yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.orDie,
        )
    if (msg && msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
    const legacyParent = msg?.info.role === "assistant" ? msg.info : undefined
    const variant = nativeParent?.variant ?? legacyParent?.variant
    const allowedCapabilities: ReadonlyArray<AgentRuntime.ChildCapability> =
      params.capabilities && params.capabilities.length > 0
        ? params.capabilities
        : [{ action: "*", resources: ["*"], access: "read" as const }]
    const capabilityError = childCapabilityContractError(allowedCapabilities)
    if (capabilityError) return yield* Effect.fail(new Error(capabilityError))

    const parentRunID = ctx.parentAction?.runID
    const deterministicChildRunID =
      durableRuns && parentRunID && ctx.callID ? DurableRun.childRunIDFor(parentRunID, ctx.callID) : undefined
    const existingDurableChild =
      durableRuns && deterministicChildRunID
        ? yield* durableRuns.load(deterministicChildRunID).pipe(
            Effect.flatMap((snapshot) =>
              "sessionID" in snapshot.run && snapshot.run.child
                ? Effect.succeed(snapshot as DurableRun.ChildSnapshot)
                : Effect.fail(new Error("The deterministic Task child identity belongs to a non-child run")),
            ),
            Effect.catchTag("DurableRun.NotFoundError", () => Effect.succeed(undefined)),
          )
        : undefined
    const recovery =
      existingDurableChild?.checkpoint && "taskRecovery" in existingDurableChild.checkpoint.state
        ? yield* Effect.try({
            try: () => readRecoveryIntent(existingDurableChild),
            catch: () => new Error("Invalid frozen Task recovery intent"),
          })
        : undefined
    if (
      recovery &&
      (recovery.parentSessionID !== ctx.sessionID ||
        recovery.parentMessageID !== ctx.messageID ||
        recovery.parentActionID !== ctx.parentAction?.actionID ||
        recovery.parentAgent !== ctx.agent ||
        canonicalHash(recovery.parameters) !== canonicalHash(params))
    )
      return yield* Effect.fail(new Error("Task replay does not match its frozen admission"))
    const parentRunSnapshot =
      durableRuns && parentRunID
        ? yield* durableRuns
            .load(parentRunID)
            .pipe(
              Effect.flatMap((snapshot) =>
                "sessionID" in snapshot.run
                  ? Effect.succeed(snapshot as DurableRun.SessionSnapshot)
                  : Effect.fail(new Error("Task delegation requires a SessionRun parent")),
              ),
            )
        : undefined
    const nowMs = Date.now()
    const childBudget = existingDurableChild
      ? existingDurableChild.run.budget
      : parentRunSnapshot
        ? childBudgetFor({
            parent: parentRunSnapshot,
            sessionCostMicros: sessionCostMicrosTotal(parent.cost),
            sessionTokens: sessionTokenTotal(parent.tokens),
            nowMs,
          })
        : undefined
    if (
      childBudget &&
      (childBudget.maxAttempts === 0 ||
        childBudget.maxDurationMs === 0 ||
        childBudget.maxCostMicros === 0 ||
        childBudget.maxTokens === 0)
    )
      return yield* Effect.fail(new Error("Parent run has no remaining attempt, time, cost, or token budget"))

    const parentAgent = yield* agent.get(ctx.agent)
    if (!parentAgent) {
      return yield* Effect.fail(new Error(`Unknown parent agent type: ${ctx.agent}`))
    }
    const next = yield* agent.get(params.subagent_type)
    if (!next) {
      return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
    }

    const customProfile = customAgentRuntimeMetadata(next)
    if (customProfile && (next.steps ?? customProfile.max_steps) !== customProfile.max_steps)
      return yield* Effect.fail(new Error("Custom agent runtime metadata does not match its step limit"))
    if (
      customProfile &&
      existingDurableChild &&
      existingDurableChild.run.child.runtimeDescriptorDigest !== customProfile.descriptor_digest
    )
      return yield* Effect.fail(
        new Error("Custom agent runtime descriptor changed; recovery requires a fresh child run"),
      )
    if (customProfile && !childBudget)
      return yield* Effect.fail(
        new Error("Custom agent profiles require a durable child run with bounded budget and recovery state"),
      )
    const effectiveChildBudget =
      customProfile && childBudget ? boundChildBudgetForCustomAgent(childBudget, customProfile) : childBudget
    if (
      effectiveChildBudget &&
      (effectiveChildBudget.maxAttempts === 0 ||
        effectiveChildBudget.maxDurationMs === 0 ||
        effectiveChildBudget.maxCostMicros === 0 ||
        effectiveChildBudget.maxTokens === 0)
    )
      return yield* Effect.fail(new Error("Parent run has no remaining attempt, time, cost, or token budget"))

    if (!ctx.bypassAgentCheck) {
      yield* ctx.ask({
        permission: id,
        patterns: [params.subagent_type],
        always: ["*"],
        metadata: {
          description: params.description,
          subagent_type: params.subagent_type,
          capability_mode: params.capabilities && params.capabilities.length > 0 ? "explicit" : "default-read-only",
          capabilities: allowedCapabilities.map((capability) => ({
            action: capability.action,
            resources: [...capability.resources],
            access: capability.access,
          })),
          budget_mode: effectiveChildBudget ? "durable" : "legacy-unmetered",
          ...(effectiveChildBudget
            ? {
                budget: {
                  maxAttempts: effectiveChildBudget.maxAttempts,
                  maxDurationMs: effectiveChildBudget.maxDurationMs,
                  maxCostMicros: effectiveChildBudget.maxCostMicros,
                  maxTokens: effectiveChildBudget.maxTokens,
                },
              }
            : {}),
        },
      })
    }

    const session = recovery
      ? yield* sessions.get(recovery.childSessionID)
      : params.task_id
        ? yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
        : undefined
    // A task ID is a continuation handle, not authority to adopt another
    // session or replace its permission/sandbox contract.
    if (session && session.parentID !== ctx.sessionID)
      return yield* Effect.fail(new Error("Task continuation must target a direct child of the current session"))
    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: [...parentAgent.permission, ...(parent.permission ?? [])],
      subagent: next,
      capabilities: allowedCapabilities,
    })
    const childToolDenies = [
      ...(childCapabilityAllows(allowedCapabilities, "todowrite")
        ? []
        : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
      ...(childCapabilityAllows(allowedCapabilities, id)
        ? []
        : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
      ...(cfg.experimental?.primary_tools?.map((permission) => ({
        permission,
        pattern: "*" as const,
        action: "deny" as const,
      })) ?? []),
    ]
    const persistedChildPermission = [
      ...childPermission,
      ...childToolDenies.filter(
        (deny) =>
          !childPermission.some(
            (rule) =>
              rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
          ),
      ),
    ]
    if (
      recovery &&
      (!session ||
        recovery.childAgent !== next.name ||
        recovery.directory !== session.directory ||
        recovery.permissionDigest !== canonicalHash(session.permission ?? []) ||
        recovery.permissionDigest !== canonicalHash(persistedChildPermission) ||
        canonicalHash(recovery.sandboxProfile) !== canonicalHash(SandboxPolicy.profileFromMetadata(session.metadata)) ||
        canonicalHash(recovery.sandboxProfile) !== canonicalHash(ctx.sandboxProfile ?? SandboxPolicy.DefaultProfile))
    )
      return yield* Effect.fail(new Error("Task replay policy or workspace changed; explicit readmission is required"))
    const nextSession =
      session ??
      (yield* sessions.create({
        parentID: ctx.sessionID,
        title: params.description + ` (@${next.name} subagent)`,
        agent: next.name,
        metadata: SandboxPolicy.setProfileMetadata(undefined, ctx.sandboxProfile ?? SandboxPolicy.DefaultProfile),
        permission: persistedChildPermission,
      }))
    if (session && !recovery) {
      // A resumed task may predate DurableRun capability materialization.
      // Replace legacy/broad rules with the bounded contract. Repeated
      // recovery is idempotent and cannot grow the persisted ruleset.
      yield* sessions.setPermission({
        sessionID: session.id,
        permission: persistedChildPermission,
      })
      yield* sessions.setSandboxProfile({
        sessionID: session.id,
        profile: ctx.sandboxProfile ?? SandboxPolicy.DefaultProfile,
      })
    }

    const taskCallID = ctx.callID ?? `task:${ctx.messageID}:${nextSession.id}`
    if (existingDurableChild && existingDurableChild.run.sessionID !== nextSession.id)
      return yield* Effect.fail(new Error("The recovered Task child is bound to a different child Session"))
    const ops = ctx.promptOps
    const durableChild =
      durableRuns && parentRunID && parentRunSnapshot && effectiveChildBudget
        ? (existingDurableChild ??
          (yield* Effect.gen(function* () {
            const project = parentRunSnapshot.run.project ?? ProjectID.global
            const location = parentRunSnapshot.run.location ?? AbsolutePath.make(parent.directory)
            const now = yield* DateTime.now
            const child = yield* durableRuns.createChild({
              parentRunID,
              sessionID: nextSession.id,
              idempotencyKey: taskCallID,
              delegatedObjective: params.prompt,
              allowedCapabilities,
              project,
              location,
              expectedDeliverable: {
                summaryRequired: true,
                artifactKinds: [],
                evidenceKinds: [],
                verifier: "parent-run",
              },
              ...(customProfile ? { runtimeDescriptorDigest: customProfile.descriptor_digest } : {}),
              ...(customProfile?.admission_evidence
                ? {
                    runtimeAdmission: {
                      evidence: customProfile.admission_evidence,
                      evidenceRefs: [],
                    },
                  }
                : {}),
              deadlineAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + effectiveChildBudget.maxDurationMs),
              initiator: "agent",
              authority: "automatic",
              riskTier: "L0",
              reasonSummary: `Task tool delegation: ${params.description}`,
              budget: effectiveChildBudget,
              traceID: `${taskCallID}:child`,
              parentTraceID: parentRunID,
              visibility: "details",
            })
            return child
          })))
        : undefined

    const model =
      recovery?.model ??
      next.model ??
      (nativeParent
        ? { modelID: nativeParent.modelID, providerID: nativeParent.providerID }
        : { modelID: legacyParent!.modelID, providerID: legacyParent!.providerID })
    const metadata = {
      parentSessionId: ctx.sessionID,
      sessionId: nextSession.id,
      model,
      reasoningLevel: reasoningProfile(recovery ? recovery.model.variant : variant).level,
      ...(durableChild ? { durableRunID: durableChild.run.id } : {}),
      ...(runInBackground ? { background: true } : {}),
    }

    const childMessageID = recovery?.childMessageID ?? MessageID.ascending()
    if (durableChild && durableRuns && parentRunID && !existingDurableChild) {
      const intent = Schema.decodeUnknownSync(RecoveryIntent)({
        version: 1,
        childRunID: durableChild.run.id,
        parentRunID,
        parentActionID: ctx.parentAction!.actionID,
        childSessionID: nextSession.id,
        childMessageID,
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        callID: taskCallID,
        parentAgent: ctx.agent,
        childAgent: next.name,
        model: {
          modelID: String(model.modelID),
          providerID: String(model.providerID),
          ...(next.model ? {} : variant ? { variant } : {}),
        },
        directory: nextSession.directory,
        permissionDigest: canonicalHash(persistedChildPermission),
        sandboxProfile: ctx.sandboxProfile ?? SandboxPolicy.DefaultProfile,
        parameters: params,
      })
      yield* durableRuns.checkpoint({
        runID: durableChild.run.id,
        state: (state) => {
          if (state && "taskRecovery" in state) {
            const current = state.taskRecovery
            if (
              !current ||
              typeof current !== "object" ||
              !("intent" in current) ||
              !("digest" in current) ||
              current.digest !== canonicalHash(intent) ||
              canonicalHash(current.intent) !== canonicalHash(intent)
            )
              throw new Error("Concurrent task recovery identity changed")
            return state
          }
          return { ...state, phase: "subagent-provider", taskRecovery: { intent, digest: canonicalHash(intent) } }
        },
      })
    }

    // Reconcile terminal receipts through the existing owner before admitting
    // a background job. A missing intent is not a runnable task or a new
    // execution failure, and must not create notification/checkpoint churn.
    if (
      durableChild &&
      (durableChild.run.status === "completed" || durableChild.run.status === "failed") &&
      !durableChild.run.childResult
    )
      yield* childExecutor.prepare({
        childRunID: durableChild.run.id,
        sessionID: String(nextSession.id),
        readUsage: () => Effect.die("Terminal settlement must not start another attempt"),
      })

    yield* ctx.metadata({
      title: params.description,
      metadata,
    })

    let promptTokenTotal = 0
    let ownsBackgroundNotification = false
    let notificationOwnerRunID: AgentRuntime.RunID | undefined

    const runTask = Effect.fn("TaskTool.runTask")(function* () {
      if (notificationOwnerRunID && durableChild && durableRuns) {
        const tailRunID = durableChild.run.id
        yield* durableRuns.checkpoint({
          runID: notificationOwnerRunID,
          state: (state) => {
            const envelope = state?.taskRecovery
            if (!state || !envelope || typeof envelope !== "object") throw new Error("Missing notification owner")
            return { ...state, taskRecovery: { ...envelope, notificationTailRunID: tailRunID } }
          },
        })
      }
      if (ownsBackgroundNotification && durableChild && durableRuns)
        yield* registerTaskNotification(durableChild.run.id).pipe(
          Effect.provideService(DurableRun.Service, durableRuns),
        )
      if (!durableChild || !durableRuns || !effectiveChildBudget) {
        const result = yield* promptEffect(undefined)
        return result
      }
      const permissionDigest = canonicalHash(persistedChildPermission)
      if (!permissionDigest) return yield* Effect.fail(new Error("Unable to derive the child permission digest"))
      return yield* childExecutor.execute({
        childRunID: durableChild.run.id,
        sessionID: String(nextSession.id),
        readUsage: () =>
          sessions.get(nextSession.id).pipe(
            Effect.map((childSession) => ({
              costMicros: sessionCostMicrosTotal(childSession.cost),
              tokens: sessionTokenTotal(childSession.tokens),
            })),
          ),
        ...(subagentProvider
          ? {
              provider: {
                provider: "in-process" as const,
                executionID: String(durableChild.run.id),
                sessionID: String(nextSession.id),
                modelID: String(model.modelID),
                modelProviderID: String(model.providerID),
                childRunID: String(durableChild.run.id),
                ...(parentRunID === undefined ? {} : { parentRunID: String(parentRunID) }),
              },
              permissionDigest,
              readPermissionDigest: () =>
                sessions
                  .get(nextSession.id)
                  .pipe(Effect.map((childSession) => canonicalHash(childSession.permission ?? []))),
            }
          : {}),
        promptTokens: () => promptTokenTotal,
        resultEvidenceRefs: durableChild.run.child.runtimeAdmission?.evidenceRefs,
        operation: (execution) => promptEffect(execution),
        onTerminal: (terminal) =>
          terminal.status === "completed"
            ? Effect.succeed(terminal.summary)
            : Effect.fail(new Error(`Task child is already ${terminal.status}`)),
        summarizeSuccess: (value) => value,
        summarizeFailure: (cause) => Cause.pretty(cause),
      })
    })

    const promptEffect = (execution: SubagentChildExecutor.ChildExecution | undefined) =>
      Effect.gen(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt(
          {
            messageID: childMessageID,
            sessionID: nextSession.id,
            ...(durableChild ? { runID: durableChild.run.id } : {}),
            model: {
              modelID: ModelV2.ID.make(String(model.modelID)),
              providerID: ProviderV2.ID.make(String(model.providerID)),
            },
            variant: recovery ? recovery.model.variant : next.model ? undefined : variant,
            agent: next.name,
            parts,
          },
          execution && durableChild ? { childRunID: durableChild.run.id, execution } : undefined,
        )
        promptTokenTotal = sessionTokenTotal("tokens" in result.info ? result.info.tokens : undefined)
        if (execution && durableChild && durableRuns) {
          const current = (yield* durableRuns.load(durableChild.run.id)) as DurableRun.ChildSnapshot
          const childSession = yield* sessions.get(nextSession.id)
          const observed = {
            costMicros: Math.max(0, sessionCostMicrosTotal(childSession.cost) - execution.costMicrosBefore),
            tokens: Math.max(
              sessionTokenDelta(execution.tokensBefore, sessionTokenTotal(childSession.tokens)),
              promptTokenTotal,
            ),
          }
          const remaining = {
            costMicros: Math.max(0, current.run.budget.maxCostMicros - current.run.budget.costMicrosUsed),
            tokens: Math.max(0, current.run.budget.maxTokens - current.run.budget.tokensUsed),
          }
          if (observed.costMicros > remaining.costMicros || observed.tokens > remaining.tokens)
            return yield* Effect.fail(
              new Error(
                `Child provider usage exceeded its durable budget: observed ${observed.costMicros} cost micros and ${observed.tokens} tokens; remaining ${remaining.costMicros} cost micros and ${remaining.tokens} tokens.`,
              ),
            )
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

    const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (state: "completed" | "error", text: string) {
      if (durableChild && durableRuns && ops.notify) {
        yield* deliverTaskNotification(durableChild.run.id, ops.notify).pipe(
          Effect.provideService(DurableRun.Service, durableRuns),
          Effect.provideService(Session.Service, sessions),
          Effect.orDie,
        )
        return
      }
      const currentParent = yield* sessions.get(ctx.sessionID)
      yield* (ops.notify ?? ((input) => ops.prompt(input).pipe(Effect.asVoid)))({
        sessionID: ctx.sessionID,
        agent: currentParent.agent ?? ctx.agent,
        variant,
        parts: [
          {
            type: "text",
            synthetic: true,
            text: renderOutput({
              sessionID: nextSession.id,
              state,
              summary:
                state === "completed"
                  ? `Background task completed: ${params.description}`
                  : `Background task failed: ${params.description}`,
              text,
            }),
          },
        ],
      }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

    const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
      if (durableChild && durableRuns)
        yield* registerTaskNotification(durableChild.run.id).pipe(
          Effect.provideService(DurableRun.Service, durableRuns),
        )
      yield* background.wait({ id: jobID }).pipe(
        Effect.flatMap((result) => {
          if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
          if (result.info?.status === "error") return inject("error", result.info.error ?? "")
          return Effect.void
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    const previousJob = yield* background.get(nextSession.id)
    if (previousJob?.status === "running" && previousJob.metadata?.durableRunID)
      notificationOwnerRunID = Schema.decodeUnknownSync(AgentRuntime.RunID)(previousJob.metadata.durableRunID)
    if (
      yield* background.extend({
        id: nextSession.id,
        run: runTask(),
        ...(durableChild && durableRuns && parentRunID
          ? {
              onDiscard: durableRuns
                .cancelChild({
                  parentRunID,
                  childRunID: durableChild.run.id,
                  reason: "Background queue closed before the task continuation started",
                  recursive: true,
                })
                .pipe(Effect.asVoid, Effect.orDie),
            }
          : {}),
      })
    ) {
      return {
        title: params.description,
        metadata: {
          ...metadata,
          background: true,
          jobId: nextSession.id,
        },
        output: renderOutput({
          sessionID: nextSession.id,
          state: "running",
          summary: "Background task updated",
          text: BACKGROUND_UPDATED,
        }),
      }
    }

    ownsBackgroundNotification = runInBackground
    const info = yield* background.start({
      id: nextSession.id,
      type: id,
      title: params.description,
      metadata,
      onPromote: Effect.all([
        ctx.metadata({
          title: params.description,
          metadata: { ...metadata, background: true, jobId: nextSession.id },
        }),
        notify(nextSession.id),
      ]).pipe(Effect.asVoid, Effect.orDie),
      run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
    })

    function backgroundResult() {
      return {
        title: params.description,
        metadata: {
          ...metadata,
          background: true,
          jobId: info.id,
        },
        output: renderOutput({
          sessionID: nextSession.id,
          state: "running",
          summary: "Background task started",
          text: BACKGROUND_STARTED,
        }),
      }
    }

    if (runInBackground) {
      yield* notify(info.id)
      return backgroundResult()
    }

    const runCancel = yield* EffectBridge.make()
    const cancel =
      durableChild && parentRunID
        ? Effect.gen(function* () {
            const reason = SubagentProvider.validateDirectParentControl({
              operation: "cancel",
              callerRunID: parentRunID,
              childParentRunID: durableChild.run.child.parentRunID,
              childRunID: durableChild.run.id,
            })
            if (reason) return yield* Effect.fail(new Error(reason))
            yield* ops.cancel(nextSession.id)
          })
        : ops.cancel(nextSession.id)

    function onAbort() {
      // The background job owns the child fiber even when its prompt uses
      // Core rather than the legacy SessionRunState coordinator.
      runCancel.fork(cancel.pipe(Effect.ensuring(background.cancel(nextSession.id))))
    }

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        ctx.abort.addEventListener("abort", onAbort)
      }),
      () =>
        Effect.gen(function* () {
          const result = yield* Effect.raceFirst(
            background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
            background.waitForPromotion(nextSession.id),
          )
          if (result?.metadata?.background === true) return backgroundResult()
          if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
          if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
          return {
            title: params.description,
            metadata,
            output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
          }
        }),
      (_, exit) =>
        Effect.gen(function* () {
          if (Exit.hasInterrupts(exit))
            yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.abort.removeEventListener("abort", onAbort)
            }),
          ),
        ),
    )
  })

  return {
    description: flags.experimentalBackgroundSubagents
      ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
      : DESCRIPTION,
    parameters: Parameters,
    jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
    execute: run,
  }
})

export type TaskRuntimeValue = Effect.Success<typeof TaskRuntime>

export const TaskTool = Tool.define(
  id,
  TaskRuntime.pipe(
    Effect.map((runtime) => ({
      ...runtime,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => {
        const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!promptOps) return Effect.die(new Error("TaskTool requires promptOps in ctx.extra"))
        return runtime
          .execute(params, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
            ...(ctx.sandboxProfile ? { sandboxProfile: ctx.sandboxProfile } : {}),
            abort: ctx.abort,
            ...(ctx.callID ? { callID: ctx.callID } : {}),
            ...(ctx.parentAction ? { parentAction: ctx.parentAction } : {}),
            nativeParent: nativeParentFrom(ctx.extra),
            bypassAgentCheck: ctx.extra?.bypassAgentCheck === true,
            promptOps,
            metadata: (input) => ctx.metadata(input as Parameters<Tool.Context["metadata"]>[0]),
            ask: ctx.ask,
          })
          .pipe(Effect.orDie)
      },
    })),
  ),
)
