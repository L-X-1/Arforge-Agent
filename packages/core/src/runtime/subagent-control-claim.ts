/**
 * Canonical ActionGateway/ControlClaimIndex material for parent-scoped
 * subagent control.
 *
 * This module is deliberately a codec/adapter, not another executor.  It
 * seals the control intent as a durable ControlRun while keeping prompt and
 * cancellation-reason bytes out of the claim payload.  Prompt bytes remain
 * owned by SessionInput; the eventual worker must still use the direct-parent
 * lease checks in SubagentControl before it changes a child run.
 */

export * as SubagentControlClaim from "./subagent-control-claim"

import * as ActionGateway from "../action-gateway"
import * as ControlClaimIndex from "./control-claim-index"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { canonicalHash } from "../util/canonical-hash"
import { Schema } from "effect"

export const Operation = Schema.Literals(["steer", "followup", "wait", "cancel"] as const)
export type Operation = typeof Operation.Type

export class InvalidClaimRequestError extends Schema.TaggedErrorClass<InvalidClaimRequestError>()(
  "SubagentControlClaim.InvalidClaimRequestError",
  { reason: Schema.String },
) {}

/**
 * Metadata-only control request.  There is intentionally no `prompt` or raw
 * cancellation reason field here.  A steer/followup request references the
 * already admitted SessionInput message by digest and ID; a cancel request
 * carries only a digest of the human-readable reason.
 */
export type Input = {
  readonly operation: Operation
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: SessionSchema.ID
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly messageID?: SessionMessage.ID
  readonly promptDigest?: string
  readonly delivery?: SessionInput.Delivery
  readonly reasonDigest?: string
  readonly timeoutMs?: number
  readonly recursive?: boolean
}

export interface Envelope {
  readonly schemaVersion: 1
  readonly operation: Operation
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: SessionSchema.ID
  readonly messageID?: SessionMessage.ID
  readonly promptDigest?: string
  readonly delivery?: SessionInput.Delivery
  readonly reasonDigest?: string
  readonly timeoutMs?: number
  readonly recursive?: boolean
  readonly envelopeDigest: string
}

export interface Material {
  readonly envelope: Envelope
  readonly inputDigest: string
  readonly actionID: AgentRuntime.ActionID
  readonly resources: ReadonlyArray<string>
  readonly semantics: AgentRuntime.EffectSemantics
  readonly reasonSummary: string
  readonly authorization: ActionGateway.AuthorizationPlan
  readonly gateway: Extract<ActionGateway.Input, { readonly kind: "control-plane" }>
  readonly claim: ControlClaimIndex.ClaimInput
}

const DIGEST = /^[a-f0-9]{64}$/i
const MAX_IDENTIFIER = 512

const fail = (reason: string): never => {
  throw new InvalidClaimRequestError({ reason })
}

const required = (value: string, label: string, max = MAX_IDENTIFIER) => {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`)
  if (value.length > max) fail(`${label} exceeds the ${max}-character bound`)
}

const digest = (value: string | undefined, label: string) => {
  if (value === undefined || !DIGEST.test(value)) fail(`${label} must be a 64-character hexadecimal digest`)
}

const canonicalDigest = (value: unknown, reason: string): string => {
  const result = canonicalHash(value)
  if (result === undefined) throw new InvalidClaimRequestError({ reason })
  return result
}

const controlAction = (operation: Operation) => `subagent.control.${operation}`

const reasonSummary = (operation: Operation) => {
  switch (operation) {
    case "steer":
      return "Parent requested a deterministic child-session steering input"
    case "followup":
      return "Parent queued a deterministic child-session follow-up input"
    case "wait":
      return "Parent requested a bounded observation of a delegated child"
    case "cancel":
      return "Parent requested cancellation of a delegated child"
  }
}

const effectSemantics = (operation: Operation) =>
  AgentRuntime.EffectSemantics.make({
    // Parent-scoped control is already authenticated by the parent's active
    // durable lease.  These operations only submit/read the existing child
    // session and therefore use the gateway's automatic L1 path; routing
    // them through a second human-approval tier would duplicate authority
    // and make an otherwise idempotent HTTP request depend on an operator UI.
    riskTier: "L1",
    authority: "automatic",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "not_applicable",
    filesystemScope: [],
    networkScope: [],
    secretScope: [],
    externalServices: [],
    expectedArtifacts: [`subagent-control:${operation}`],
    successCriteria: ["control intent is durably sealed", "direct-parent execution policy is preserved"],
  })

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: 60_000,
  // Keep the same positive sentinel convention as other one-shot control
  // operations.  No model cost is charged by this metadata-only claim.
  maxCostMicros: 1,
  maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const metadata = (input: Input): Omit<Envelope, "envelopeDigest"> => {
  required(input.requestID, "requestID", 512)
  required(input.parentRunID, "parentRunID")
  required(input.childRunID, "childRunID")
  required(input.sessionID, "sessionID")
  if (input.parentRunID === input.childRunID) fail("parentRunID and childRunID must be different")

  if (input.operation === "steer" || input.operation === "followup") {
    if (!input.messageID) fail(`${input.operation} requires the admitted messageID`)
    if (!input.promptDigest) fail(`${input.operation} requires the admitted promptDigest`)
    digest(input.promptDigest, "promptDigest")
    const expectedDelivery: SessionInput.Delivery = input.operation === "steer" ? "steer" : "queue"
    if (input.delivery !== expectedDelivery)
      fail(`${input.operation} must use SessionInput delivery ${expectedDelivery}`)
    if (input.reasonDigest !== undefined || input.timeoutMs !== undefined || input.recursive !== undefined)
      fail(`${input.operation} cannot carry wait/cancel controls`)
  } else if (input.operation === "wait") {
    if (input.messageID || input.promptDigest || input.delivery || input.reasonDigest !== undefined)
      fail("wait cannot carry prompt or cancellation metadata")
    if (input.recursive !== undefined) fail("wait cannot carry recursive cancellation metadata")
  } else {
    if (input.messageID || input.promptDigest || input.delivery) fail("cancel cannot carry prompt metadata")
    if (!input.reasonDigest) fail("cancel requires a reasonDigest")
    digest(input.reasonDigest, "reasonDigest")
  }

  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 60_000)
  )
    fail("timeoutMs must be an integer between 0 and 60000")
  if (input.recursive !== undefined && typeof input.recursive !== "boolean") fail("recursive must be boolean")

  return {
    schemaVersion: 1,
    operation: input.operation,
    requestID: input.requestID,
    parentRunID: input.parentRunID,
    childRunID: input.childRunID,
    sessionID: input.sessionID,
    ...(input.messageID === undefined ? {} : { messageID: input.messageID }),
    ...(input.promptDigest === undefined ? {} : { promptDigest: input.promptDigest }),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    ...(input.reasonDigest === undefined ? {} : { reasonDigest: input.reasonDigest }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.recursive === undefined ? {} : { recursive: input.recursive }),
  }
}

/**
 * Build the one canonical claim material used by ActionGateway and
 * ControlClaimIndex.  `requestID` is part of the material on purpose: each
 * distinct steer/followup/cancel request is a distinct immutable operation;
 * retrying the same request ID is the only idempotent replay.
 */
export const make = (input: Input): Material => {
  const unsigned = metadata(input)
  const envelopeDigest = canonicalDigest(unsigned, "control request metadata is not canonically hashable")
  const envelope = { ...unsigned, envelopeDigest } satisfies Envelope
  // ControlClaimIndex derives the durable ActionGateway identity from the
  // exact `input` value it receives.  Keep this digest equal to the envelope
  // digest rather than hashing a second wrapper that the claim index cannot
  // see; otherwise the sealed action ID and replay identity would diverge.
  const inputDigest = canonicalDigest(envelope, "control request input is not canonically hashable")

  const name = controlAction(input.operation)
  const resources = [
    `subagent:parent:${input.parentRunID}`,
    `subagent:child:${input.childRunID}`,
    `session:${input.sessionID}`,
  ]
  const semantics = effectSemantics(input.operation)
  const authorization = ActionGateway.canonicalPlan({
    requests: [{ action: name, resources }],
    metadata: {
      schemaVersion: 1,
      operation: input.operation,
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      sessionID: input.sessionID,
      requestID: input.requestID,
      envelopeDigest,
    },
  })
  const gatewayBase = {
    kind: "control-plane" as const,
    controlPlane: input.subject,
    name,
    resources,
    semantics,
    reasonSummary: reasonSummary(input.operation),
    initiator: "user" as const,
    traceID: `subagent-control:${input.subject.id}:${input.subject.requestID}`,
    inputDigest,
  }
  const actionID = ActionGateway.stableControlPlaneActionID({
    subject: input.subject,
    name,
    resources,
    inputDigest,
    policyVersion: ActionGateway.POLICY_VERSION,
  })
  const gateway: Extract<ActionGateway.Input, { readonly kind: "control-plane" }> = {
    ...gatewayBase,
    actionID,
  }
  const claim: ControlClaimIndex.ClaimInput = {
    subject: input.subject,
    gateway: gatewayBase,
    authorization,
    // The exact durable payload contains only metadata/digests.  A worker
    // loads the admitted SessionInput row by messageID when needed.
    input: envelope,
    operation: { kind: name, payload: envelope },
    // Keep request aliases from conflating two different child-control
    // messages.  This still allows the same request ID to replay exactly.
    claimMaterial: { input: envelope, payload: envelope },
    run: {
      initiator: "user",
      authority: "automatic",
      riskTier: "L1",
      reasonSummary: reasonSummary(input.operation),
      budget,
      traceID: gatewayBase.traceID,
      visibility: "details",
    },
  }
  return {
    envelope,
    inputDigest,
    actionID,
    resources,
    semantics,
    reasonSummary: reasonSummary(input.operation),
    authorization,
    gateway,
    claim,
  }
}
