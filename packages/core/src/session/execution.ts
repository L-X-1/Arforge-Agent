export * as SessionExecution from "./execution"

import { Context, Effect, Layer, Schema } from "effect"
import type { SessionMessage } from "./message"
import type { ModelV2 } from "../model"
import type { PromptInput } from "@arforge-ai/schema/prompt-input"
import type { Prompt } from "./prompt"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { Credential } from "@arforge-ai/schema/credential"
import { SessionRunner } from "./runner/index"
import type { RunnerSettlementCollector, RunnerSettlementObserver } from "./runner/history"
import { SessionSchema } from "./schema"
import type * as RuntimeBilling from "../runtime/billing"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export interface RunOptions {
  readonly personalJob?: AgentRuntime.SessionRunAdmission["personalJob"]
  /** Credentials allowed for this run; omitted means use the normal session integration policy. */
  readonly credentialIDs: ReadonlyArray<Credential.ID>
  /** Optional verified, currency-bound usage policy for this run. */
  readonly billing?: RuntimeBilling.RunConfig
  /** Optional trusted metadata-only notification after terminal history validation. */
  readonly onSettled?: RunnerSettlementObserver
  /** Optional trusted parity/replay hook over the committed terminal rows. */
  readonly settlementCollector?: RunnerSettlementCollector
}

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("SessionExecution.OperationError", {
  operation: Schema.String,
  reason: Schema.Literals(["invalid", "conflict", "busy", "unavailable"]),
  message: Schema.String,
}) {}

export type ShellInput = {
  readonly sessionID: SessionSchema.ID
  readonly id?: SessionMessage.ID
  readonly command: string
  readonly agent?: string
  readonly model?: ModelV2.Ref
}

export type CompactInput = {
  readonly sessionID: SessionSchema.ID
  readonly model?: ModelV2.Ref
  /** Exact server context projection captured by a preview, checked under the execution slot. */
  readonly expectedContext?: string
  readonly expectedDirectory?: string
}

export type ValidateCommandModel = (model: ModelV2.Ref) => Effect.Effect<ModelV2.Ref, OperationError>

export type CommandValidation = {
  readonly validateAgent?: (agent: string) => Effect.Effect<void, OperationError>
  readonly validateModel?: ValidateCommandModel
}

export interface Interface {
  /** Product adapters reuse their existing direct Shell owner, including its exclusive slot and L3 gateway. */
  readonly shell?: (input: ShellInput) => Effect.Effect<void, OperationError>
  /** Resolve named commands before durable admission, for both idle and queued submission. */
  readonly preparePrompt?: (input: CommandValidation & {
    readonly sessionID: SessionSchema.ID
    readonly id: SessionMessage.ID
    readonly prompt: PromptInput.Prompt
  }) => Effect.Effect<Prompt, OperationError>
  /** Manual compaction must settle through the Core transaction/checkpoint owner before returning. */
  readonly compact?: (input: CompactInput) => Effect.Effect<void, OperationError>
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** One-off work shares the session owner; false means busy without executing work. */
  readonly exclusive: (
    sessionID: SessionSchema.ID,
    work: Effect.Effect<void>,
    beforeInterrupt?: Effect.Effect<void>,
  ) => Effect.Effect<boolean, SessionRunner.RunError>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Starts execution with a one-run credential scope that is never inherited by wakeups. */
  readonly resumeWith: (input: {
    readonly sessionID: SessionSchema.ID
    readonly options: RunOptions
  }) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Registers newly recorded work and waits for the execution generation guaranteed to observe it. */
  readonly wakeAndWait: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    exclusive: () => Effect.die(new Error("Session execution is unavailable")),
    resume: () => Effect.void,
    resumeWith: () => Effect.void,
    wake: () => Effect.void,
    wakeAndWait: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
