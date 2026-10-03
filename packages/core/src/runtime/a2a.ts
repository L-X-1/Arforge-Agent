/**
 * Private A2A V1 contract checks.
 *
 * This module validates envelopes and receipts only.  It never turns a remote
 * message into a local filesystem/tool capability and never executes a remote
 * task.  A transport adapter must authenticate the channel and bind the
 * validated capability reference to a local DurableRun/ActionGateway policy.
 */

export * as RuntimeA2A from "./a2a"

import { A2A } from "@arforge-ai/schema/a2a"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { canonicalHash } from "../util/canonical-hash"

export type A2AProtocolErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_SIGNATURE"
  | "INVALID_CHANNEL"
  | "EXPIRED_DELEGATION"
  | "CAPABILITY_ESCALATION"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_RESULT"
  | "INVALID_CONTROL_REQUEST"

export class A2AProtocolError extends Error {
  constructor(
    readonly code: A2AProtocolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "A2AProtocolError"
  }
}

const digestPattern = /^[a-f0-9]{64}$/i
const secretPattern = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i

const decodeStrict = <A>(schema: Schema.Decoder<A, never>, input: unknown, label: string): A => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new A2AProtocolError("INVALID_ENVELOPE", `${label} does not satisfy the strict A2A schema: ${String(error)}`)
  }
}

const digestOf = (value: unknown, label: string) => {
  const digest = canonicalHash(value)
  if (!digest || !digestPattern.test(digest)) throw new A2AProtocolError("INVALID_ENVELOPE", `${label} is not hashable`)
  return digest
}

const millis = (value: number) => value

const identity = (value: A2A.PeerIdentity) => ({
  agentID: value.agentID,
  tenantID: value.tenantID,
  principalID: value.principalID,
  channelID: value.channelID,
})

const capability = (value: A2A.CapabilityReference) => ({
  referenceID: value.referenceID,
  grantDigest: value.grantDigest,
  issuer: value.issuer,
  action: value.action,
  resources: [...value.resources],
  access: value.access,
  expiresAt: millis(value.expiresAt),
})

const channel = (value: A2A.ChannelPolicy) => ({
  channelID: value.channelID,
  transport: value.transport,
  authentication: value.authentication,
  purpose: value.purpose,
  allowedEgress: [...value.allowedEgress],
})

const unsignedTaskEnvelope = (value: A2A.TaskEnvelope) => ({
  version: value.version,
  taskID: value.taskID,
  requestID: value.requestID,
  idempotencyKey: value.idempotencyKey,
  nonce: value.nonce,
  sender: identity(value.sender),
  recipient: identity(value.recipient),
  parentRunID: value.parentRunID,
  objective: value.objective,
  capability: capability(value.capability),
  budget: value.budget,
  deadlineAt: millis(value.deadlineAt),
  channel: channel(value.channel),
})

const unsignedResultReceipt = (value: A2A.ResultReceipt) => ({
  version: value.version,
  taskID: value.taskID,
  requestID: value.requestID,
  status: value.status,
  resultDigest: value.resultDigest,
  summary: value.summary,
  artifactRefs: [...value.artifactRefs],
  evidenceRefs: [...value.evidenceRefs],
  usage: value.usage,
  verification: value.verification,
  createdAt: millis(value.createdAt),
})

const unsignedStatusEvent = (value: A2A.StatusEvent) => ({
  version: value.version,
  taskID: value.taskID,
  sequence: value.sequence,
  status: value.status,
  actor: identity(value.actor),
  summary: value.summary,
  resultDigest: value.resultDigest,
  artifactRefs: [...value.artifactRefs],
  evidenceRefs: [...value.evidenceRefs],
  createdAt: millis(value.createdAt),
})

const unsignedCancelRequest = (value: A2A.CancelRequest) => ({
  version: value.version,
  taskID: value.taskID,
  requestID: value.requestID,
  nonce: value.nonce,
  actor: identity(value.actor),
  reason: value.reason,
  channel: channel(value.channel),
})

const unsignedRevokeRequest = (value: A2A.RevokeRequest) => ({
  version: value.version,
  taskID: value.taskID,
  requestID: value.requestID,
  nonce: value.nonce,
  actor: identity(value.actor),
  capabilityGrantDigest: value.capabilityGrantDigest,
  reason: value.reason,
  channel: channel(value.channel),
})

const assertSignature = (payload: unknown, signature: A2A.Signature, label: string) => {
  const expected = digestOf(payload, `${label} payload`)
  if (signature.payloadDigest !== expected)
    throw new A2AProtocolError("INVALID_SIGNATURE", `${label} signature payload digest does not match the canonical payload`)
}

const assertChannel = (sender: A2A.PeerIdentity, recipient: A2A.PeerIdentity, policy: A2A.ChannelPolicy, signature: A2A.Signature) => {
  if (sender.channelID !== policy.channelID || recipient.channelID !== policy.channelID)
    throw new A2AProtocolError("INVALID_CHANNEL", "sender, recipient, and channel policy must share one channel ID")
  if (sender.tenantID !== recipient.tenantID)
    throw new A2AProtocolError("INVALID_CHANNEL", "cross-tenant A2A delegation is not enabled by the private protocol")
  if (sender.agentID === recipient.agentID)
    throw new A2AProtocolError("INVALID_CHANNEL", "an A2A task must have distinct sender and recipient agents")
  if (policy.authentication === "mtls" && policy.transport !== "tls")
    throw new A2AProtocolError("INVALID_CHANNEL", "mTLS authentication requires a TLS transport")
  if (policy.authentication === "mtls" && signature.algorithm !== "ed25519")
    throw new A2AProtocolError("INVALID_CHANNEL", "mTLS A2A channels require an ed25519 envelope signature")
}

const assertSafeText = (value: string, label: string) => {
  if (secretPattern.test(value)) throw new A2AProtocolError("INVALID_ENVELOPE", `${label} contains a secret-like value`)
}

export const taskEnvelopeDigest = (value: A2A.TaskEnvelope) => digestOf(unsignedTaskEnvelope(value), "task envelope")

/** Canonical identity of the local metadata resolved for a capability reference. */
export const capabilityReferenceDigest = (value: A2A.CapabilityReference) =>
  digestOf(capability(value), "capability reference")

export const decodeTaskEnvelope = (input: unknown, options?: { readonly nowMs?: number }) => {
  const value = decodeStrict(A2A.TaskEnvelope, input, "task envelope")
  assertChannel(value.sender, value.recipient, value.channel, value.signature)
  assertSignature(unsignedTaskEnvelope(value), value.signature, "task envelope")
  assertSafeText(value.objective, "task objective")
  const nowMs = options?.nowMs ?? Date.now()
  if (millis(value.deadlineAt) <= nowMs) throw new A2AProtocolError("EXPIRED_DELEGATION", "task deadline has passed")
  if (millis(value.capability.expiresAt) > millis(value.deadlineAt))
    throw new A2AProtocolError("EXPIRED_DELEGATION", "capability expiry cannot exceed task deadline")
  if (value.capability.issuer !== value.sender.agentID)
    throw new A2AProtocolError("CAPABILITY_ESCALATION", "capability issuer must be the authenticated sender")
  return value
}

export const idempotencyIdentityDigest = (value: A2A.TaskEnvelope) =>
  digestOf(
    {
      protocol: "a2a-private-v1",
      sender: value.sender.agentID,
      recipient: value.recipient.agentID,
      taskID: value.taskID,
      idempotencyKey: value.idempotencyKey,
    },
    "A2A idempotency identity",
  )

/** Return true for an exact replay; reject a changed payload under one key. */
export const assertIdempotentReplay = (existing: A2A.TaskEnvelope, presented: A2A.TaskEnvelope) => {
  if (idempotencyIdentityDigest(existing) !== idempotencyIdentityDigest(presented)) return false
  if (taskEnvelopeDigest(existing) !== taskEnvelopeDigest(presented))
    throw new A2AProtocolError("IDEMPOTENCY_CONFLICT", "A2A idempotency identity was replayed with a different envelope")
  return true
}

export const assertCapabilityNarrower = (
  parent: A2A.CapabilityReference,
  requested: A2A.CapabilityReference,
  nowMs = Date.now(),
) => {
  if (millis(parent.expiresAt) <= nowMs || millis(requested.expiresAt) <= nowMs)
    throw new A2AProtocolError("EXPIRED_DELEGATION", "parent and requested capabilities must both be live")
  if (requested.issuer !== parent.issuer)
    throw new A2AProtocolError("CAPABILITY_ESCALATION", "delegated capability issuer cannot change")
  if (parent.access === "read" && requested.access === "write")
    throw new A2AProtocolError("CAPABILITY_ESCALATION", "read capability cannot delegate write access")
  if (millis(requested.expiresAt) > millis(parent.expiresAt))
    throw new A2AProtocolError("CAPABILITY_ESCALATION", "delegated capability cannot outlive its parent")
  if (parent.action !== "*" && requested.action !== parent.action)
    throw new A2AProtocolError("CAPABILITY_ESCALATION", "delegated action is outside the parent capability")
  const parentResources = new Set(parent.resources)
  if (requested.resources.some((resource) => !parentResources.has("*") && !parentResources.has(resource)))
    throw new A2AProtocolError("CAPABILITY_ESCALATION", "delegated resources exceed the parent capability")
  return requested
}

export const resultReceiptDigest = (value: A2A.ResultReceipt) => digestOf(unsignedResultReceipt(value), "result receipt")

/** Canonical digest signed by the local node for every durable status event. */
export const statusEventDigest = (value: A2A.StatusEvent) => digestOf(unsignedStatusEvent(value), "status event")

/** Digest of a bounded status page; useful for lookup/replay verification. */
export const statusStreamDigest = (value: {
  readonly taskID: A2A.TaskID
  readonly afterSequence: number
  readonly nextSequence: number
  readonly complete: boolean
  readonly events: ReadonlyArray<A2A.StatusEvent>
}) => digestOf(value, "status stream")

export const cancelRequestDigest = (value: A2A.CancelRequest) => digestOf(unsignedCancelRequest(value), "cancel request")

export const revokeRequestDigest = (value: A2A.RevokeRequest) => digestOf(unsignedRevokeRequest(value), "revoke request")

export const decodeResultReceipt = (input: unknown, envelope: A2A.TaskEnvelope) => {
  const value = decodeStrict(A2A.ResultReceipt, input, "result receipt")
  if (value.taskID !== envelope.taskID || value.requestID !== envelope.requestID)
    throw new A2AProtocolError("INVALID_RESULT", "result receipt task and request identity do not match the envelope")
  assertSignature(unsignedResultReceipt(value), value.signature, "result receipt")
  assertSafeText(value.summary, "result summary")
  if (value.createdAt > envelope.deadlineAt)
    throw new A2AProtocolError("INVALID_RESULT", "result receipt was created after the task deadline")
  if (
    value.usage.attempts > envelope.budget.maxAttempts ||
    value.usage.durationMs > envelope.budget.maxDurationMs ||
    value.usage.costMicros > envelope.budget.maxCostMicros ||
    value.usage.tokens > (envelope.budget.maxTokens ?? AgentRuntime.DEFAULT_MAX_TOKENS)
  )
    throw new A2AProtocolError("INVALID_RESULT", "result usage exceeds the delegated task budget")
  if (value.status !== "cancelled" && value.usage.attempts === 0)
    throw new A2AProtocolError("INVALID_RESULT", "completed or failed results must report at least one attempt")
  if (value.verification.mode === "local-verifier" && !value.verification.verifierID.startsWith("local:"))
    throw new A2AProtocolError("INVALID_RESULT", "local-verifier receipts must name a local verifier")
  if (value.verification.mode === "trusted-receipt" && !value.verification.verifierID.startsWith("trusted:"))
    throw new A2AProtocolError("INVALID_RESULT", "trusted receipts must name an allowlisted trusted verifier")
  return value
}

export const decodeCancelRequest = (input: unknown, envelope: A2A.TaskEnvelope) => {
  const value = decodeStrict(A2A.CancelRequest, input, "cancel request")
  if (value.taskID !== envelope.taskID) throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "cancel task identity does not match")
  if (value.requestID !== envelope.requestID)
    throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "cancel request identity does not match the task")
  if (value.actor.agentID !== envelope.sender.agentID || value.actor.channelID !== envelope.sender.channelID)
    throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "cancel actor is not the authenticated task sender")
  assertChannel(value.actor, envelope.recipient, value.channel, value.signature)
  assertSignature(unsignedCancelRequest(value), value.signature, "cancel request")
  assertSafeText(value.reason, "cancel reason")
  return value
}

export const decodeRevokeRequest = (input: unknown, envelope: A2A.TaskEnvelope) => {
  const value = decodeStrict(A2A.RevokeRequest, input, "revoke request")
  if (value.taskID !== envelope.taskID) throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "revoke task identity does not match")
  if (value.requestID !== envelope.requestID)
    throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "revoke request identity does not match the task")
  if (value.capabilityGrantDigest !== envelope.capability.grantDigest)
    throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "revoke request does not bind the delegated grant")
  if (value.actor.agentID !== envelope.sender.agentID || value.actor.channelID !== envelope.sender.channelID)
    throw new A2AProtocolError("INVALID_CONTROL_REQUEST", "revoke actor is not the authenticated task sender")
  assertChannel(value.actor, envelope.recipient, value.channel, value.signature)
  assertSignature(unsignedRevokeRequest(value), value.signature, "revoke request")
  assertSafeText(value.reason, "revoke reason")
  return value
}
