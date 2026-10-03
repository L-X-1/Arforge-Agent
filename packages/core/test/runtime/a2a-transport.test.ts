import { describe, expect } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { A2A } from "@arforge-ai/schema/a2a"
import { Agent } from "@arforge-ai/schema/agent"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { type Config, RuntimeA2ATransport, validateConfig } from "@arforge-ai/core/runtime/a2a-transport"
import {
  cancelRequestDigest,
  resultReceiptDigest,
  revokeRequestDigest,
  statusEventDigest,
  taskEnvelopeDigest,
} from "@arforge-ai/core/runtime/a2a"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"

const keyPair = () => generateKeyPairSync("ed25519")
const senderKeys = keyPair()
const localKeys = keyPair()
const sender = Agent.ID.make("agt_a2a_sender")
const local = Agent.ID.make("agt_a2a_local")
const channel: A2A.ChannelPolicy = {
  channelID: "a2a-loopback-1",
  transport: "tls",
  authentication: "mtls",
  purpose: "a2a-private-v1",
  allowedEgress: [],
}
const senderIdentity: A2A.PeerIdentity = {
  agentID: sender,
  tenantID: "ten_local",
  principalID: "usr_sender",
  channelID: channel.channelID,
}
const localIdentity: A2A.PeerIdentity = {
  agentID: local,
  tenantID: "ten_local",
  principalID: "usr_local",
  channelID: channel.channelID,
}
const project = ProjectID.global
const location = AbsolutePath.make("/a2a-transport-test")
const capabilityKey = (parentRunID: AgentRuntime.RunID, referenceID: string) => `${parentRunID}:${referenceID}`
const capabilityRegistry = new Map<string, A2A.CapabilityReference>()

const config: Config = {
  local: {
    identity: localIdentity,
    keyID: "key-local",
    publicKey: localKeys.publicKey,
    privateKey: localKeys.privateKey,
  },
  peers: [{ identity: senderIdentity, keyID: "key-sender", publicKey: senderKeys.publicKey }],
  channel,
  verifier: {
    verifierIDs: ["local:test"],
    verify: () => Effect.succeed(true),
  },
  capabilityResolver: {
    resolve: ({ parentRunID, reference }) =>
      Effect.succeed(capabilityRegistry.get(capabilityKey(parentRunID, reference.referenceID))),
  },
}

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.globalNode, RuntimeA2ATransport.node(config)]),
)
const it = testEffect(runtimeLayer)
let recoveryNow = Date.now()
const recoveryConfig: Config = { ...config, nowMs: () => recoveryNow }
const recoveryIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, DurableRun.globalNode, RuntimeA2ATransport.node(recoveryConfig)]),
  ),
)

const parentBudget = AgentRuntime.Budget.make({
  maxAttempts: 4,
  maxDurationMs: 60_000,
  maxCostMicros: 10_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const runningParent = (runtime: DurableRun.Interface) =>
  Effect.gen(function* () {
    const parent = yield* runtime.create({
      sessionID: SessionSchema.ID.create(),
      initiator: "user",
      authority: "automatic",
      riskTier: "L1",
      reasonSummary: "A2A transport parent",
      budget: parentBudget,
      traceID: "a2a-parent-trace",
      visibility: "audit",
      project,
      location,
      delegableCapabilities: [{ action: "analysis.read", resources: ["workspace:read"], access: "read" }],
    })
    yield* runtime.transition({ runID: parent.run.id, to: "preflight", reason: "A2A test preflight" })
    yield* runtime.transition({ runID: parent.run.id, to: "queued", reason: "A2A test queued" })
    yield* runtime.transition({ runID: parent.run.id, to: "running", reason: "A2A test running" })
    return parent
  })

const taskID = (suffix: string) => `a2a_task_${suffix.repeat(32)}`
const requestID = (suffix: string) => `a2a_req_${suffix.repeat(32)}`

const envelopeFor = (parentRunID: AgentRuntime.RunID, suffix = "1") => {
  const future = Date.now() + 60_000
  const draft = Schema.decodeUnknownSync(A2A.TaskEnvelope)({
    version: 1,
    taskID: taskID(suffix),
    requestID: requestID(suffix),
    idempotencyKey: `idem-${suffix}`,
    nonce: `nonce-${suffix}`,
    sender: senderIdentity,
    recipient: localIdentity,
    parentRunID,
    objective: "Run the bounded local remote analysis",
    capability: {
      referenceID: `cap_a2a_${suffix}`,
      grantDigest: "3".repeat(64),
      issuer: sender,
      action: "analysis.read",
      resources: ["workspace:read"],
      access: "read",
      expiresAt: future,
    },
    budget: { maxAttempts: 1, maxDurationMs: 30_000, maxCostMicros: 100, maxTokens: 100 },
    deadlineAt: future,
    channel,
    signature: { algorithm: "ed25519", keyID: "key-sender", payloadDigest: "0".repeat(64), value: "pending" },
  })
  capabilityRegistry.set(capabilityKey(parentRunID, draft.capability.referenceID), draft.capability)
  const payloadDigest = taskEnvelopeDigest(draft)
  return {
    ...draft,
    signature: {
      ...draft.signature,
      payloadDigest,
      value: sign(null, Buffer.from(payloadDigest, "utf8"), senderKeys.privateKey).toString("base64url"),
    },
  }
}

const signCancel = (request: A2A.CancelRequest) => {
  const digest = cancelRequestDigest(request)
  return {
    ...request,
    signature: {
      ...request.signature,
      payloadDigest: digest,
      value: sign(null, Buffer.from(digest, "utf8"), senderKeys.privateKey).toString("base64url"),
    },
  }
}

const signRevoke = (request: A2A.RevokeRequest) => {
  const digest = revokeRequestDigest(request)
  return {
    ...request,
    signature: {
      ...request.signature,
      payloadDigest: digest,
      value: sign(null, Buffer.from(digest, "utf8"), senderKeys.privateKey).toString("base64url"),
    },
  }
}

const localReceiptFor = (
  envelope: A2A.TaskEnvelope,
  overrides: Partial<Pick<A2A.ResultReceipt, "status" | "resultDigest" | "summary" | "usage">> = {},
) => {
  const draft = Schema.decodeUnknownSync(A2A.ResultReceipt)({
    version: 1,
    taskID: envelope.taskID,
    requestID: envelope.requestID,
    status: overrides.status ?? "completed",
    resultDigest: overrides.resultDigest ?? "4".repeat(64),
    summary: overrides.summary ?? "Verified local result",
    artifactRefs: [],
    evidenceRefs: [],
    usage: overrides.usage ?? { attempts: 1, durationMs: 25, costMicros: 10, tokens: 20 },
    verification: { mode: "local-verifier", verifierID: "local:test", evidenceDigest: "5".repeat(64) },
    createdAt: Date.now(),
    signature: { algorithm: "ed25519", keyID: "key-local", payloadDigest: "0".repeat(64), value: "pending" },
  })
  const digest = resultReceiptDigest(draft)
  return {
    ...draft,
    signature: {
      ...draft.signature,
      payloadDigest: digest,
      value: sign(null, Buffer.from(digest, "utf8"), localKeys.privateKey).toString("base64url"),
    },
  }
}

const localStatusFor = (
  envelope: A2A.TaskEnvelope,
  sequence: number,
  status: A2A.TaskStatus,
  receipt?: A2A.ResultReceipt,
) => {
  const draft = Schema.decodeUnknownSync(A2A.StatusEvent)({
    version: 1,
    taskID: envelope.taskID,
    sequence,
    status,
    actor: localIdentity,
    summary: receipt?.summary ?? `local ${status}`,
    ...(receipt ? { resultDigest: receipt.resultDigest } : {}),
    artifactRefs: receipt?.artifactRefs ?? [],
    evidenceRefs: receipt?.evidenceRefs ?? [],
    createdAt: receipt?.createdAt ?? Date.now(),
    signature: { algorithm: "ed25519", keyID: "key-local", payloadDigest: "0".repeat(64), value: "pending" },
  })
  const digest = statusEventDigest(draft)
  return {
    ...draft,
    signature: {
      ...draft.signature,
      payloadDigest: digest,
      value: sign(null, Buffer.from(digest, "utf8"), localKeys.privateKey).toString("base64url"),
    },
  }
}

const resignEnvelope = (envelope: A2A.TaskEnvelope) => {
  const digest = taskEnvelopeDigest(envelope)
  return {
    ...envelope,
    signature: {
      ...envelope.signature,
      payloadDigest: digest,
      value: sign(null, Buffer.from(digest, "utf8"), senderKeys.privateKey).toString("base64url"),
    },
  }
}

describe("local A2A transport", () => {
  it.effect("rejects ambiguous peer and verifier configuration", () =>
    Effect.sync(() => {
      expect(() => validateConfig({ ...config, peers: [config.peers[0]!, config.peers[0]!] })).toThrow(
        "peer agent IDs must be unique",
      )
      expect(() => validateConfig({ ...config, verifier: { ...config.verifier, verifierIDs: [] } })).toThrow(
        "verifier IDs",
      )
    }),
  )

  it.effect("authenticates, durably accepts, queues, looks up, and replays a task", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id)

      const first = yield* transport.submit(envelope)
      const replay = yield* transport.submit(envelope)
      const stream = yield* transport.lookup({ taskID: envelope.taskID, requester: senderIdentity })
      const children = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      expect(first.replayed).toBe(false)
      expect(replay.replayed).toBe(true)
      expect(stream.events.map((event) => event.status)).toEqual(["accepted"])
      expect(children).toHaveLength(1)
      expect(children[0]?.run.status).toBe("queued")
    }),
  )

  it.effect("keeps result verification local and binds result identity to the task", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "2")
      yield* transport.submit(envelope)

      const receipt = localReceiptFor(envelope)
      const accepted = yield* transport.result(receipt)
      const replay = yield* transport.result(receipt)
      const stream = yield* transport.lookup({ taskID: envelope.taskID, requester: localIdentity })
      const children = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      expect(accepted.resultDigest).toBe(receipt.resultDigest)
      expect(replay.resultDigest).toBe(receipt.resultDigest)
      expect(stream.events.at(-1)?.status).toBe("completed")
      expect(children[0]?.run.status).toBe("completed")
      expect(children[0]?.run.childResult?.usage).toEqual(receipt.usage)
    }),
  )

  it.effect("cancels and revokes only with an authenticated sender nonce", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "3")
      yield* transport.submit(envelope)
      const cancel = signCancel({
        version: 1,
        taskID: envelope.taskID,
        requestID: envelope.requestID,
        nonce: "cancel-nonce",
        actor: senderIdentity,
        reason: "sender cancelled the delegated task",
        channel,
        signature: { algorithm: "ed25519", keyID: "key-sender", payloadDigest: "0".repeat(64), value: "pending" },
      })
      const cancelled = yield* transport.cancel(cancel)
      const replay = yield* transport.cancel(cancel)
      const children = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      expect(cancelled.replayed).toBe(false)
      expect(replay.replayed).toBe(true)
      expect(children[0]?.run.status).toBe("cancelled")
      expect(children[0]?.run.childResult?.status).toBe("cancelled")

      const secondParent = yield* runningParent(runtime)
      const second = envelopeFor(secondParent.run.id, "4")
      yield* transport.submit(second)
      const revoke = signRevoke({
        version: 1,
        taskID: second.taskID,
        requestID: second.requestID,
        nonce: "revoke-nonce",
        actor: senderIdentity,
        capabilityGrantDigest: second.capability.grantDigest,
        reason: "sender revoked the delegated grant",
        channel,
        signature: { algorithm: "ed25519", keyID: "key-sender", payloadDigest: "0".repeat(64), value: "pending" },
      })
      const revoked = yield* transport.revoke(revoke)
      const revokedStream = yield* transport.lookup({ taskID: second.taskID, requester: senderIdentity })

      expect(revoked.replayed).toBe(false)
      expect(revokedStream.events.at(-1)?.status).toBe("revoked")
    }),
  )

  it.effect("materializes failed retries and zero-attempt cancellation from verified receipts", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const failedParent = yield* runningParent(runtime)
      const failedEnvelope = resignEnvelope({
        ...envelopeFor(failedParent.run.id, "b"),
        budget: { maxAttempts: 2, maxDurationMs: 30_000, maxCostMicros: 100, maxTokens: 100 },
      })
      yield* transport.submit(failedEnvelope)
      const failedReceipt = localReceiptFor(failedEnvelope, {
        status: "failed",
        summary: "Verified remote failure",
        usage: { attempts: 2, durationMs: 40, costMicros: 20, tokens: 30 },
      })
      yield* transport.result(failedReceipt)
      const failedChildren = yield* runtime.listChildren({
        parentRunID: failedParent.run.id,
        includeTerminal: true,
      })

      expect(failedChildren[0]?.run.status).toBe("failed")
      expect(failedChildren[0]?.run.budget.attemptsUsed).toBe(2)
      expect(failedChildren[0]?.run.childResult?.usage).toEqual(failedReceipt.usage)

      const cancelledParent = yield* runningParent(runtime)
      const cancelledEnvelope = envelopeFor(cancelledParent.run.id, "c")
      yield* transport.submit(cancelledEnvelope)
      const cancelledReceipt = localReceiptFor(cancelledEnvelope, {
        status: "cancelled",
        summary: "Verified remote cancellation",
        usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
      })
      yield* transport.result(cancelledReceipt)
      const cancelledChildren = yield* runtime.listChildren({
        parentRunID: cancelledParent.run.id,
        includeTerminal: true,
      })

      expect(cancelledChildren[0]?.run.status).toBe("cancelled")
      expect(cancelledChildren[0]?.run.budget.attemptsUsed).toBe(0)
      expect(cancelledChildren[0]?.run.childResult?.usage).toEqual(cancelledReceipt.usage)
    }),
  )

  it.effect("fails closed for unknown peers and divergent idempotency payloads", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "5")
      const unknown = {
        ...envelope,
        sender: { ...senderIdentity, agentID: Agent.ID.make("agt_unknown") },
        capability: { ...envelope.capability, issuer: Agent.ID.make("agt_unknown") },
        signature: {
          ...envelope.signature,
          payloadDigest: taskEnvelopeDigest({
            ...envelope,
            sender: { ...senderIdentity, agentID: Agent.ID.make("agt_unknown") },
            capability: { ...envelope.capability, issuer: Agent.ID.make("agt_unknown") },
          }),
        },
      }
      const unknownExit = yield* transport.submit(unknown).pipe(Effect.exit)
      expect(String(unknownExit)).toContain("PEER_NOT_ALLOWED")

      yield* transport.submit(envelope)
      const divergent = {
        ...envelope,
        objective: "different objective",
        signature: {
          ...envelope.signature,
          payloadDigest: taskEnvelopeDigest({ ...envelope, objective: "different objective" }),
        },
      }
      const divergentExit = yield* transport.submit(divergent).pipe(Effect.exit)
      expect(String(divergentExit)).toContain("SIGNATURE_INVALID")

      const reusedNonce = resignEnvelope({ ...envelopeFor(parent.run.id, "6"), nonce: envelope.nonce })
      const reusedNonceExit = yield* transport.submit(reusedNonce).pipe(Effect.exit)
      const children = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })
      expect(String(reusedNonceExit)).toContain("IDEMPOTENCY_CONFLICT")
      expect(children).toHaveLength(1)
    }),
  )

  it.effect("requires an exact local capability reference before claiming a nonce or creating a child", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "8")
      const key = capabilityKey(parent.run.id, envelope.capability.referenceID)
      const registered = capabilityRegistry.get(key)
      capabilityRegistry.delete(key)

      const unresolved = yield* transport.submit(envelope).pipe(Effect.exit)
      expect(String(unresolved)).toContain("CAPABILITY_REFERENCE_INVALID")

      if (!registered) throw new Error("expected the test capability to be registered")
      capabilityRegistry.set(key, registered)
      const forged = resignEnvelope({
        ...envelope,
        capability: { ...envelope.capability, grantDigest: "9".repeat(64) },
      })
      const mismatched = yield* transport.submit(forged).pipe(Effect.exit)
      const childrenBeforeRetry = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      expect(String(mismatched)).toContain("CAPABILITY_REFERENCE_INVALID")
      expect(childrenBeforeRetry).toHaveLength(0)

      const accepted = yield* transport.submit(envelope)
      const childrenAfterRetry = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })
      expect(accepted.replayed).toBe(false)
      expect(childrenAfterRetry).toHaveLength(1)
    }),
  )

  it.effect("rejects a signed but invalid durable status transition", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "9")
      yield* transport.submit(envelope)
      const invalidStatus = localStatusFor(envelope, 2, "accepted")
      yield* events.publish(
        A2A.Event.TaskStatusRecorded,
        { taskID: envelope.taskID, status: invalidStatus },
        { expectedSequence: 0 },
      )

      const lookup = yield* transport
        .lookup({ taskID: envelope.taskID, requester: senderIdentity })
        .pipe(Effect.exit)
      expect(String(lookup)).toContain("TRANSPORT_CONFLICT")
      expect(String(lookup)).toContain("accepted -> accepted")
    }),
  )

  it.effect("recovers a committed result after a crash before child settlement", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "a")
      yield* transport.submit(envelope)
      const receipt = localReceiptFor(envelope)
      const status = localStatusFor(envelope, 2, receipt.status, receipt)
      yield* events.publish(
        A2A.Event.TaskResultRecorded,
        { taskID: envelope.taskID, requestID: envelope.requestID, receipt, status },
        { expectedSequence: 0 },
      )
      const before = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      const repaired = yield* transport.recover()
      const after = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      expect(before[0]?.run.status).toBe("queued")
      expect(repaired).toBe(1)
      expect(after[0]?.run.status).toBe("completed")
      expect(after[0]?.run.childResult?.resultDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(after[0]?.run.childResult?.usage).toEqual(receipt.usage)
    }),
  )

  it.effect("rejects invalid status paging at the local transport boundary", () =>
    Effect.gen(function* () {
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "7")
      yield* transport.submit(envelope)

      const invalidCursor = yield* transport
        .lookup({ taskID: envelope.taskID, requester: senderIdentity, afterSequence: Number.NaN })
        .pipe(Effect.exit)
      const invalidLimit = yield* transport
        .lookup({ taskID: envelope.taskID, requester: senderIdentity, limit: 0 })
        .pipe(Effect.exit)

      expect(String(invalidCursor)).toContain("INVALID_ENVELOPE")
      expect(String(invalidLimit)).toContain("INVALID_ENVELOPE")
    }),
  )

  recoveryIt.effect("fails and settles an accepted task that expires before a verified result", () =>
    Effect.gen(function* () {
      recoveryNow = Date.now()
      const transport = yield* RuntimeA2ATransport.Service
      const runtime = yield* DurableRun.Service
      const parent = yield* runningParent(runtime)
      const envelope = envelopeFor(parent.run.id, "d")
      yield* transport.submit(envelope)
      recoveryNow = envelope.deadlineAt + 1

      const repaired = yield* transport.recover()
      const stream = yield* transport.lookup({ taskID: envelope.taskID, requester: senderIdentity })
      const children = yield* runtime.listChildren({ parentRunID: parent.run.id, includeTerminal: true })

      expect(repaired).toBe(1)
      expect(stream.events.at(-1)?.status).toBe("failed")
      expect(children[0]?.run.status).toBe("cancelled")
      expect(children[0]?.run.childResult?.status).toBe("cancelled")
    }),
  )
})
