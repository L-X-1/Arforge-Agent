export * as SessionRunner from "./index"

import type { LLMError } from "@arforge-ai/llm"
import { Context, Effect } from "effect"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { ToolOutputStore } from "../../tool-output-store"
import type * as RuntimeBilling from "../../runtime/billing"
import { ActionGateway } from "../../action-gateway"
import { DurableAction } from "../../runtime/durable-action"
import * as RunnerInvariants from "./invariants"
import type { StructuredOutput } from "../../tool/structured-output"
import type { TurnToolCarrier } from "../../tool/turn-carrier"
import type { Tool } from "../../tool/tool"
import type { RunnerSettlementCollector, RunnerSettlementObserver } from "./history"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { SubagentChildExecutor } from "../../runtime/subagent-child-executor"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error
  | ActionGateway.BlockedError
  | ActionGateway.AlreadySettledError
  | ActionGateway.RecoveryRequiredError
  | ActionGateway.PostProcessingError
  | ActionGateway.ActionInProgressError
  | ActionGateway.ActionIntentMismatchError
  | ActionGateway.InvalidSubjectError
  | DurableAction.CorruptHistoryError
  | StructuredOutput.InvalidSchemaError
  | TurnToolCarrier.InvalidCarrierError
  | Tool.RegistrationError
  | RunnerInvariants.InvariantError

/** Request-scoped external context participates in the existing semantic epoch. */
export const ExternalContext = Context.Reference<
  ((sessionID: SessionSchema.ID, agent: string) => Effect.Effect<SystemContext.SystemContext>) | undefined
>("@arforge/v2/SessionRunner/external-context", { defaultValue: () => undefined })

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    /** Reuse a child attempt already owned by SubagentChildExecutor; never settle it here. */
    readonly childAttempt?: {
      readonly childRunID: AgentRuntime.RunID
      readonly execution: Pick<SubagentChildExecutor.ChildExecution, "attempt" | "ownerID" | "leaseID">
    }
    /** Optional verified, currency-bound runtime billing policy for this run. */
    readonly billing?: RuntimeBilling.RunConfig
    readonly personalJob?: AgentRuntime.SessionRunAdmission["personalJob"]
    /** Bounded same-provider transport retries before the turn becomes terminal. */
    readonly retry?: { readonly maxTransportRetries?: number }
    /** Optional trusted, metadata-only hook invoked after committed terminal history validation. */
    readonly onSettled?: RunnerSettlementObserver
    /** Optional trusted parity/replay hook over the exact committed rows already validated. */
    readonly settlementCollector?: RunnerSettlementCollector
    /**
     * Canonical Core scheduled-task tool. The same tool handles scheduled
     * and model-initiated children without a separate compatibility executor.
     */
    readonly scheduledTaskTool?: Tool.AnyTool
    /** Expose the same canonical task tool to ordinary model calls. */
    readonly modelTaskCalls?: boolean
  }) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SessionRunner") {}

/** Product source adapter only; Core owns materialization, policy and execution. */
export type ExternalToolResolver = (input: {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly modelID: string
  readonly providerID: string
}) => Effect.Effect<Readonly<Record<string, Tool.AnyTool>>>

export const ExternalTools = Context.Reference<ExternalToolResolver | undefined>(
  "@arforge/v2/SessionRunner/external-tools",
  { defaultValue: () => undefined },
)

/** Shared metadata-only semantic projection used to compare runner adapters. */
export * as Parity from "./parity"
export * as ParityMatrix from "./parity-matrix"
export * as Evidence from "./evidence"
export * as History from "./history"
