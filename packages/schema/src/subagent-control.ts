/**
 * Wire contracts for parent-scoped delegated-child control.
 *
 * These schemas are intentionally separate from the Core service's internal
 * lease input.  A client identifies a parent/child and a request; the server
 * resolves execution ownership and never asks the client to forge or carry a
 * provider payload.  Claim envelopes are metadata-only; prompt bytes remain
 * in the durable SessionInput pipeline.
 */

export * as SubagentControl from "./subagent-control"

import { AgentRuntime } from "./agent-runtime"
import { PromptInput } from "./prompt-input"
import { SessionInput } from "./session-input"
import { SessionMessage } from "./session-message"
import { optional } from "./schema"
import { Schema } from "effect"

export const Operation = Schema.Literals(["steer", "followup", "wait", "cancel"] as const).annotate({
  identifier: "SubagentControl.Operation",
})
export type Operation = typeof Operation.Type

const Scope = {
  parentRunID: AgentRuntime.RunID,
  childRunID: AgentRuntime.RunID,
  requestID: AgentRuntime.ControlPlaneRequestID,
}

const RequestIdentity = {
  requestID: AgentRuntime.ControlPlaneRequestID,
}

export const SteerPayload = Schema.Struct({
  ...RequestIdentity,
  prompt: PromptInput.Prompt,
}).annotate({ identifier: "SubagentControl.SteerPayload", parseOptions: { onExcessProperty: "error" } })
export interface SteerPayload extends Schema.Schema.Type<typeof SteerPayload> {}

export const FollowupPayload = Schema.Struct({
  ...RequestIdentity,
  prompt: PromptInput.Prompt,
}).annotate({ identifier: "SubagentControl.FollowupPayload", parseOptions: { onExcessProperty: "error" } })
export interface FollowupPayload extends Schema.Schema.Type<typeof FollowupPayload> {}

export const WaitPayload = Schema.Struct({
  ...RequestIdentity,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })).pipe(optional),
}).annotate({ identifier: "SubagentControl.WaitPayload", parseOptions: { onExcessProperty: "error" } })
export interface WaitPayload extends Schema.Schema.Type<typeof WaitPayload> {}

export const CancelPayload = Schema.Struct({
  ...RequestIdentity,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  recursive: Schema.Boolean.pipe(optional),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })).pipe(optional),
}).annotate({ identifier: "SubagentControl.CancelPayload", parseOptions: { onExcessProperty: "error" } })
export interface CancelPayload extends Schema.Schema.Type<typeof CancelPayload> {}

export const SteerRequest = Schema.Struct({
  ...Scope,
  prompt: PromptInput.Prompt,
}).annotate({ identifier: "SubagentControl.SteerRequest", parseOptions: { onExcessProperty: "error" } })
export interface SteerRequest extends Schema.Schema.Type<typeof SteerRequest> {}

export const FollowupRequest = Schema.Struct({
  ...Scope,
  prompt: PromptInput.Prompt,
}).annotate({ identifier: "SubagentControl.FollowupRequest", parseOptions: { onExcessProperty: "error" } })
export interface FollowupRequest extends Schema.Schema.Type<typeof FollowupRequest> {}

export const WaitRequest = Schema.Struct({
  ...Scope,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })).pipe(optional),
}).annotate({ identifier: "SubagentControl.WaitRequest", parseOptions: { onExcessProperty: "error" } })
export interface WaitRequest extends Schema.Schema.Type<typeof WaitRequest> {}

export const CancelRequest = Schema.Struct({
  ...Scope,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  recursive: Schema.Boolean.pipe(optional),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })).pipe(optional),
}).annotate({ identifier: "SubagentControl.CancelRequest", parseOptions: { onExcessProperty: "error" } })
export interface CancelRequest extends Schema.Schema.Type<typeof CancelRequest> {}

export const Request = Schema.Union([SteerRequest, FollowupRequest, WaitRequest, CancelRequest]).annotate({
  identifier: "SubagentControl.Request",
})
export type Request = typeof Request.Type

/** Metadata-only reference returned after a steer/followup admission. */
export const Admission = Schema.Struct({
  messageID: SessionMessage.ID,
  sessionID: SessionInput.Admitted.fields.sessionID,
  delivery: SessionInput.Delivery,
  promptDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  envelopeDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
}).annotate({ identifier: "SubagentControl.Admission", parseOptions: { onExcessProperty: "error" } })
export interface Admission extends Schema.Schema.Type<typeof Admission> {}

/**
 * Safe projection shared by HTTP, CLI and UI.  It deliberately omits lease
 * owner IDs, prompt text, cancellation reason, provider payloads and durable
 * checkpoints.  A claim run ID is optional because the local parent path may
 * perform an already-authorized operation without a detached control worker.
 */
export const ResultReceiptStatus = Schema.Literals(["pending", "missing", "present", "not-required"]).annotate({
  identifier: "SubagentControl.ResultReceiptStatus",
  description:
    "pending: execution is not terminal; missing: completed/failed without a durable result receipt; present: receipt exists, not a delivery or acceptance guarantee; not-required: cancelled. Absent on older servers means unknown, never ready.",
})
export type ResultReceiptStatus = typeof ResultReceiptStatus.Type

export const Response = Schema.Struct({
  operation: Operation,
  parentRunID: AgentRuntime.RunID,
  childRunID: AgentRuntime.RunID,
  status: AgentRuntime.RunStatus,
  timedOut: Schema.Boolean,
  resultReceiptStatus: ResultReceiptStatus.pipe(optional),
  requestID: AgentRuntime.ControlPlaneRequestID.pipe(optional),
  admission: Admission.pipe(optional),
  controlRunID: AgentRuntime.RunID.pipe(optional),
  actionID: AgentRuntime.ActionID.pipe(optional),
  claim: Schema.Literals(["claimed", "existing"] as const).pipe(optional),
}).annotate({ identifier: "SubagentControl.Response", parseOptions: { onExcessProperty: "error" } })
export interface Response extends Schema.Schema.Type<typeof Response> {}

/** Metadata-only child discovery projection used before a control action. */
export const ChildSummary = Schema.Struct({
  childRunID: AgentRuntime.RunID,
  sessionID: SessionInput.Admitted.fields.sessionID,
  status: AgentRuntime.RunStatus,
  resultReceiptStatus: ResultReceiptStatus.pipe(optional),
  depth: Schema.Int,
  objectiveDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
}).annotate({ identifier: "SubagentControl.ChildSummary", parseOptions: { onExcessProperty: "error" } })
export interface ChildSummary extends Schema.Schema.Type<typeof ChildSummary> {}

export const ChildrenResponse = Schema.Struct({
  parentRunID: AgentRuntime.RunID,
  /** Snapshot hint only; every control request must still revalidate authority and lease. */
  controlAvailable: Schema.Boolean.pipe(optional),
  children: Schema.Array(ChildSummary),
}).annotate({ identifier: "SubagentControl.ChildrenResponse", parseOptions: { onExcessProperty: "error" } })
export interface ChildrenResponse extends Schema.Schema.Type<typeof ChildrenResponse> {}
