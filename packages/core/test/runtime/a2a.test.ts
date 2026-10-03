import { describe, expect, test } from "bun:test"
import { A2A } from "@arforge-ai/schema/a2a"
import { Agent } from "@arforge-ai/schema/agent"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import {
  assertCapabilityNarrower,
  assertIdempotentReplay,
  decodeResultReceipt,
  decodeTaskEnvelope,
  idempotencyIdentityDigest,
  resultReceiptDigest,
  taskEnvelopeDigest,
} from "@arforge-ai/core/runtime/a2a"

const future = Date.now() + 60_000
const sender = Agent.ID.make("agt_sender")
const recipient = Agent.ID.make("agt_recipient")
const taskID = "a2a_task_" + "1".repeat(32)
const requestID = "a2a_req_" + "2".repeat(32)
const grantDigest = "3".repeat(64)

const rawEnvelope = () => ({
  version: 1,
  taskID,
  requestID,
  idempotencyKey: "idem-1",
  nonce: "nonce-1",
  sender: { agentID: sender, tenantID: "ten_local", principalID: "usr_sender", channelID: "chan-1" },
  recipient: { agentID: recipient, tenantID: "ten_local", principalID: "usr_recipient", channelID: "chan-1" },
  parentRunID: AgentRuntime.RunID.make("run_parent"),
  objective: "Run the bounded remote analysis",
  capability: {
    referenceID: "cap_remote_analysis",
    grantDigest,
    issuer: sender,
    action: "analysis.read",
    resources: ["workspace:read"],
    access: "read",
    expiresAt: future,
  },
  budget: { maxAttempts: 1, maxDurationMs: 30_000, maxCostMicros: 100, maxTokens: 100 },
  deadlineAt: future,
  channel: {
    channelID: "chan-1",
    transport: "tls",
    authentication: "mtls",
    purpose: "a2a-private-v1",
    allowedEgress: [],
  },
  signature: { algorithm: "ed25519", keyID: "key-sender", payloadDigest: "0".repeat(64), value: "signed" },
})

const envelope = () => {
  const draft = Schema.decodeUnknownSync(A2A.TaskEnvelope)(rawEnvelope())
  return {
    ...draft,
    signature: { ...draft.signature, payloadDigest: taskEnvelopeDigest(draft) },
  }
}

const resignEnvelope = (value: A2A.TaskEnvelope) => ({
  ...value,
  signature: { ...value.signature, payloadDigest: taskEnvelopeDigest(value) },
})

describe("private A2A V1 contract", () => {
  test("accepts a signed bounded envelope and derives stable idempotency identity", () => {
    const value = decodeTaskEnvelope(envelope(), { nowMs: Date.now() })
    expect(value.taskID).toBe(taskID)
    expect(value.capability.access).toBe("read")
    expect(idempotencyIdentityDigest(value)).toMatch(/^[a-f0-9]{64}$/)
    expect(idempotencyIdentityDigest(value)).toBe(idempotencyIdentityDigest(value))
    expect(assertIdempotentReplay(value, value)).toBe(true)
  })

  test("fails closed for extra local tokens, tampered payloads, expired deadlines, and channel mismatch", () => {
    expect(() =>
      decodeTaskEnvelope({ ...envelope(), filesystemToken: "local-secret" }, { nowMs: Date.now() }),
    ).toThrow()

    const tampered = { ...envelope(), objective: "different objective" }
    expect(() => decodeTaskEnvelope(tampered, { nowMs: Date.now() })).toThrow("payload digest")
    expect(() => decodeTaskEnvelope(resignEnvelope(tampered), { nowMs: Date.now() })).not.toThrow()
    expect(() => assertIdempotentReplay(envelope(), resignEnvelope(tampered))).toThrow("different envelope")

    expect(() =>
      decodeTaskEnvelope(resignEnvelope({ ...envelope(), deadlineAt: Date.now() - 1 }), { nowMs: Date.now() }),
    ).toThrow("deadline has passed")

    expect(() =>
      decodeTaskEnvelope(
        resignEnvelope({ ...envelope(), recipient: { ...envelope().recipient, channelID: "other-channel" } }),
        {
          nowMs: Date.now(),
        },
      ),
    ).toThrow("share one channel ID")
  })

  test("prevents delegated capability escalation while allowing a narrower read scope", () => {
    const value = decodeTaskEnvelope(envelope(), { nowMs: Date.now() })
    expect(() =>
      assertCapabilityNarrower(
        value.capability,
        { ...value.capability, referenceID: "cap_child", access: "write" },
        Date.now(),
      ),
    ).toThrow("cannot delegate write")
    expect(() =>
      assertCapabilityNarrower(
        { ...value.capability, resources: ["*"] },
        { ...value.capability, referenceID: "cap_child", resources: ["workspace:read"] },
        Date.now(),
      ),
    ).not.toThrow()
    expect(() =>
      assertCapabilityNarrower(
        value.capability,
        { ...value.capability, referenceID: "cap_child", resources: ["workspace:write"] },
        Date.now(),
      ),
    ).toThrow("resources exceed")
  })

  test("accepts only verifier-bound result receipts and binds them to the task", () => {
    const task = decodeTaskEnvelope(envelope(), { nowMs: Date.now() })
    const raw = {
      version: 1,
      taskID,
      requestID,
      status: "completed",
      resultDigest: "4".repeat(64),
      summary: "Remote analysis completed",
      artifactRefs: ["art_result"],
      evidenceRefs: ["evd_result"],
      usage: { attempts: 1, durationMs: 100, costMicros: 10, tokens: 20 },
      verification: { mode: "local-verifier", verifierID: "local:workflow", evidenceDigest: "5".repeat(64) },
      createdAt: future,
      signature: { algorithm: "ed25519", keyID: "key-recipient", payloadDigest: "0".repeat(64), value: "signed" },
    }
    const draft = Schema.decodeUnknownSync(A2A.ResultReceipt)(raw)
    const signed = { ...draft, signature: { ...draft.signature, payloadDigest: resultReceiptDigest(draft) } }
    expect(decodeResultReceipt(signed, task).verification.mode).toBe("local-verifier")
    expect(() =>
      decodeResultReceipt(
        resignReceipt(signed, undefined, undefined, { ...signed.usage, costMicros: 101 }),
        task,
      ),
    ).toThrow("usage exceeds")
    expect(() =>
      decodeResultReceipt(
        { ...resignReceipt(signed, { ...signed.verification, verifierID: "remote:untrusted" }) },
        task,
      ),
    ).toThrow("local-verifier receipts")
    expect(() => decodeResultReceipt(resignReceipt(signed, undefined, "a2a_task_" + "9".repeat(32)), task)).toThrow(
      "task and request identity",
    )
  })
})

const resignReceipt = (
  value: A2A.ResultReceipt,
  verification = value.verification,
  taskID = value.taskID,
  usage = value.usage,
) => {
  const next = { ...value, taskID, usage, verification }
  return { ...next, signature: { ...next.signature, payloadDigest: resultReceiptDigest(next) } }
}
