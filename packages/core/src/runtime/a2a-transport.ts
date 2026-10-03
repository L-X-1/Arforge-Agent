/**
 * Local, trusted transport adapter for private A2A V1.
 *
 * This adapter is deliberately narrower than the wire contract:
 * - the recipient must be this node;
 * - the sender must be a fixed ed25519 allowlist entry;
 * - the parentRunID must resolve to a local SessionRun;
 * - the delegated capability is admitted again by DurableRun;
 * - result receipts use the local verifier only;
 * - task state is an EventV2 aggregate, never a process-local pending map.
 *
 * The HTTP group is not mounted by this module.  A future server adapter can
 * bind authenticated request context to these methods without widening the
 * local capability boundary.
 */

export * as RuntimeA2ATransport from "./a2a-transport"

import { A2A } from "@arforge-ai/schema/a2a"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { verify, sign, type KeyObject } from "node:crypto"
import { like } from "drizzle-orm"
import { DurableEventManifest } from "@arforge-ai/schema/durable-event-manifest"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventSequenceTable } from "../event/sql"
import { makeGlobalNode } from "../effect/app-node"
import { canonicalHash } from "../util/canonical-hash"
import { DurableRun } from "./durable-run"
import {
  A2AProtocolError,
  assertIdempotentReplay,
  capabilityReferenceDigest,
  cancelRequestDigest,
  decodeCancelRequest,
  decodeRevokeRequest,
  decodeResultReceipt,
  decodeTaskEnvelope,
  resultReceiptDigest,
  revokeRequestDigest,
  statusEventDigest,
  statusStreamDigest,
  taskEnvelopeDigest,
} from "./a2a"
import type { A2AProtocolErrorCode } from "./a2a"

export type A2ATransportErrorCode =
  | A2AProtocolErrorCode
  | "PEER_NOT_ALLOWED"
  | "SIGNATURE_INVALID"
  | "LOCAL_RECIPIENT_REQUIRED"
  | "PARENT_RUN_REQUIRED"
  | "CAPABILITY_REFERENCE_INVALID"
  | "TASK_NOT_FOUND"
  | "RESULT_NOT_VERIFIED"
  | "TASK_TERMINAL"
  | "TRANSPORT_CONFLICT"
  | "RECOVERY_FAILED"

export class A2ATransportError extends Error {
  readonly _tag = "RuntimeA2ATransport.Error"

  constructor(
    readonly code: A2ATransportErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`)
    this.name = "A2ATransportError"
  }
}

export interface PeerKey {
  readonly identity: A2A.PeerIdentity
  readonly keyID: string
  readonly publicKey: KeyObject
}

export interface LocalPeer extends PeerKey {
  readonly privateKey: KeyObject
}

export interface LocalResultVerificationInput {
  readonly envelope: A2A.TaskEnvelope
  readonly receipt: A2A.ResultReceipt
}

export interface LocalResultVerifier {
  /** Return true only after this node has checked the referenced evidence. */
  readonly verify: (input: LocalResultVerificationInput) => Effect.Effect<boolean>
  /** Exact local verifier allowlist in addition to the schema's `local:` prefix. */
  readonly verifierIDs: ReadonlyArray<string>
}

export interface LocalCapabilityResolutionInput {
  readonly parentRunID: AgentRuntime.RunID
  readonly sender: A2A.PeerIdentity
  readonly recipient: A2A.PeerIdentity
  readonly reference: A2A.CapabilityReference
}

export interface LocalCapabilityResolver {
  /** Resolve the exact locally-authorized metadata; undefined fails closed. */
  readonly resolve: (
    input: LocalCapabilityResolutionInput,
  ) => Effect.Effect<A2A.CapabilityReference | undefined, unknown>
}

export interface Config {
  readonly local: LocalPeer
  readonly peers: ReadonlyArray<PeerKey>
  readonly channel: A2A.ChannelPolicy
  readonly verifier: LocalResultVerifier
  readonly capabilityResolver: LocalCapabilityResolver
  readonly nowMs?: () => number
}

type TaskAcceptedData = {
  readonly taskID: A2A.TaskID
  readonly requestID: A2A.RequestID
  readonly envelope: A2A.TaskEnvelope
  readonly childRunID: AgentRuntime.RunID
  readonly status: A2A.StatusEvent
}

type TaskStatusData = {
  readonly taskID: A2A.TaskID
  readonly status: A2A.StatusEvent
}

type TaskResultData = {
  readonly taskID: A2A.TaskID
  readonly requestID: A2A.RequestID
  readonly receipt: A2A.ResultReceipt
  readonly status: A2A.StatusEvent
}

type TaskControlData = {
  readonly taskID: A2A.TaskID
  readonly requestID: A2A.RequestID
  readonly kind: "cancel" | "revoke"
  readonly nonce: A2A.Nonce
  readonly requestDigest: string
  readonly status: A2A.StatusEvent
}

type NonceClaimData = {
  readonly nonceDigest: string
  readonly nonce: A2A.Nonce
  readonly taskID: A2A.TaskID
  readonly requestID: A2A.RequestID
  readonly envelopeDigest: string
  readonly sender: A2A.PeerIdentity
  readonly recipient: A2A.PeerIdentity
}

interface ControlRecord {
  readonly kind: "cancel" | "revoke"
  readonly requestID: A2A.RequestID
  readonly nonce: A2A.Nonce
  readonly requestDigest: string
  readonly status: A2A.StatusEvent
}

interface TaskState {
  readonly envelope: A2A.TaskEnvelope
  readonly childRunID: AgentRuntime.RunID
  readonly statuses: ReadonlyArray<A2A.StatusEvent>
  readonly controls: ReadonlyArray<ControlRecord>
  readonly receipt?: A2A.ResultReceipt
  readonly eventCount: number
}

export interface Interface {
  readonly submit: (input: unknown) => Effect.Effect<A2A.Accepted, unknown>
  readonly lookup: (input: {
    readonly taskID: A2A.TaskID
    readonly requester: A2A.PeerIdentity
    readonly afterSequence?: number
    readonly limit?: number
  }) => Effect.Effect<A2A.StatusStream, unknown>
  readonly result: (input: unknown) => Effect.Effect<A2A.ResultReceipt, unknown>
  readonly cancel: (input: unknown) => Effect.Effect<A2A.Accepted, unknown>
  readonly revoke: (input: unknown) => Effect.Effect<A2A.Accepted, unknown>
  /** Re-queues accepted tasks whose child aggregate survived a crash gap. */
  readonly recover: () => Effect.Effect<number, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/RuntimeA2ATransport") {}

const zeroDigest = "0".repeat(64)
const terminalStatuses = new Set<A2A.TaskStatus>(["completed", "failed", "cancelled", "revoked"])
const childTerminalStatuses = new Set<AgentRuntime.RunStatus>(["completed", "failed", "cancelled"])
const allowedStatusTransitions: Readonly<Record<A2A.TaskStatus, ReadonlySet<A2A.TaskStatus>>> = {
  submitted: new Set(["accepted", "failed", "cancelled", "revoked"]),
  accepted: new Set(["running", "paused", "completed", "failed", "cancelled", "revoked"]),
  running: new Set(["paused", "completed", "failed", "cancelled", "revoked"]),
  paused: new Set(["running", "failed", "cancelled", "revoked"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  revoked: new Set(),
}

const sameIdentity = (left: A2A.PeerIdentity, right: A2A.PeerIdentity) =>
  left.agentID === right.agentID &&
  left.tenantID === right.tenantID &&
  left.principalID === right.principalID &&
  left.channelID === right.channelID

const sameChannel = (left: A2A.ChannelPolicy, right: A2A.ChannelPolicy) =>
  left.channelID === right.channelID &&
  left.transport === right.transport &&
  left.authentication === right.authentication &&
  left.purpose === right.purpose &&
  left.allowedEgress.length === right.allowedEgress.length &&
  left.allowedEgress.every((value, index) => value === right.allowedEgress[index])

const configError = (message: string) => new A2ATransportError("INVALID_CHANNEL", `A2A transport config: ${message}`)

const requireKeyID = (value: string, label: string) => {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 256) throw configError(`${label} keyID must contain 1-256 characters`)
  return normalized
}

const requireEd25519Key = (key: KeyObject, type: "public" | "private", label: string) => {
  if (key.type !== type || key.asymmetricKeyType !== "ed25519")
    throw configError(`${label} must be an ed25519 ${type} key`)
}

export const validateConfig = (config: Config) => {
  let channel: A2A.ChannelPolicy
  let localIdentity: A2A.PeerIdentity
  try {
    channel = Schema.decodeUnknownSync(A2A.ChannelPolicy, { onExcessProperty: "error" })(config.channel)
    localIdentity = Schema.decodeUnknownSync(A2A.PeerIdentity, { onExcessProperty: "error" })(config.local.identity)
  } catch {
    throw configError("channel or local peer identity is invalid")
  }
  if (!sameChannel(channel, config.channel) || localIdentity.channelID !== channel.channelID)
    throw configError("local identity must bind the exact configured channel")
  requireKeyID(config.local.keyID, "local")
  requireEd25519Key(config.local.publicKey, "public", "local publicKey")
  requireEd25519Key(config.local.privateKey, "private", "local privateKey")
  const challenge = Buffer.from("arforge-a2a-config-v1", "utf8")
  const signature = sign(null, challenge, config.local.privateKey)
  if (!verify(null, challenge, config.local.publicKey, signature))
    throw configError("local public and private keys do not form one key pair")
  if (config.peers.length === 0 || config.peers.length > 256)
    throw configError("peer allowlist must contain between 1 and 256 entries")
  const peerIDs = new Set<string>()
  for (const peer of config.peers) {
    let identity: A2A.PeerIdentity
    try {
      identity = Schema.decodeUnknownSync(A2A.PeerIdentity, { onExcessProperty: "error" })(peer.identity)
    } catch {
      throw configError("peer identity is invalid")
    }
    if (identity.channelID !== channel.channelID || identity.tenantID !== localIdentity.tenantID)
      throw configError("every peer must bind the local channel and tenant")
    if (identity.agentID === localIdentity.agentID || peerIDs.has(identity.agentID))
      throw configError("peer agent IDs must be unique and distinct from the local agent")
    peerIDs.add(identity.agentID)
    requireKeyID(peer.keyID, `peer ${identity.agentID}`)
    requireEd25519Key(peer.publicKey, "public", `peer ${identity.agentID} publicKey`)
  }
  if (
    config.verifier.verifierIDs.length === 0 ||
    config.verifier.verifierIDs.length > 256 ||
    new Set(config.verifier.verifierIDs).size !== config.verifier.verifierIDs.length ||
    config.verifier.verifierIDs.some((id) => !id.startsWith("local:") || id.length > 256)
  )
    throw configError("local verifier IDs must be a unique, non-empty bounded allowlist")
  if (typeof config.verifier.verify !== "function" || typeof config.capabilityResolver.resolve !== "function")
    throw configError("local verifier and capability resolver functions are required")
  if (config.nowMs !== undefined && typeof config.nowMs !== "function") throw configError("nowMs must be a function")
  return config
}

const appendStoredStatus = (statuses: A2A.StatusEvent[], status: A2A.StatusEvent) => {
  const previous = statuses.at(-1)
  if (!previous || status.sequence !== previous.sequence + 1)
    throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A status sequence is not contiguous")
  if (!allowedStatusTransitions[previous.status].has(status.status))
    throw new A2ATransportError(
      "TRANSPORT_CONFLICT",
      `A2A status transition ${previous.status} -> ${status.status} is invalid`,
    )
  if (status.createdAt < previous.createdAt)
    throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A status time moved backwards")
  statuses.push(status)
}

const protocolGuard = <A>(label: string, thunk: () => A) =>
  Effect.try({
    try: thunk,
    catch: (error) =>
      error instanceof A2ATransportError
        ? error
        : error instanceof A2AProtocolError
          ? new A2ATransportError(error.code, `${label}: ${error.message}`)
          : new A2ATransportError("INVALID_ENVELOPE", `${label} could not be validated`),
  })

const fail = (code: A2ATransportErrorCode, message: string) => Effect.fail(new A2ATransportError(code, message))

const normalizeStatusCursor = (value: number | undefined) => {
  const cursor = value ?? 0
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new A2ATransportError("INVALID_ENVELOPE", "A2A status cursor must be a non-negative safe integer")
  return cursor
}

const normalizeStatusLimit = (value: number | undefined) => {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new A2ATransportError("INVALID_ENVELOPE", "A2A status page size must be between 1 and 100")
  return limit
}

const hashRequired = (value: unknown, label: string) => {
  const digest = canonicalHash(value)
  if (!digest) throw new A2ATransportError("INVALID_ENVELOPE", `${label} is not canonically hashable`)
  return digest
}

const inputField = (input: unknown, key: string) =>
  input !== null && typeof input === "object" ? Reflect.get(input, key) : undefined

const verifyEd25519 = (peer: PeerKey, signature: A2A.Signature, expectedDigest: string) => {
  if (signature.algorithm !== "ed25519")
    throw new A2ATransportError("SIGNATURE_INVALID", "the local transport accepts ed25519 signatures only")
  if (signature.keyID !== peer.keyID)
    throw new A2ATransportError("SIGNATURE_INVALID", "the signature key is not the allowlisted peer key")
  let valid = false
  try {
    valid = verify(null, Buffer.from(expectedDigest, "utf8"), peer.publicKey, Buffer.from(signature.value, "base64url"))
  } catch {
    valid = false
  }
  if (!valid) throw new A2ATransportError("SIGNATURE_INVALID", "the envelope signature did not verify")
}

const signStatus = (local: LocalPeer, draft: A2A.StatusEvent): A2A.StatusEvent => {
  const payloadDigest = statusEventDigest(draft)
  const value = sign(null, Buffer.from(payloadDigest, "utf8"), local.privateKey).toString("base64url")
  return {
    ...draft,
    signature: {
      algorithm: "ed25519",
      keyID: local.keyID,
      payloadDigest,
      value,
    },
  }
}

const makeStatus = (
  local: LocalPeer,
  input: {
    readonly taskID: A2A.TaskID
    readonly sequence: number
    readonly status: A2A.TaskStatus
    readonly summary: string
    readonly resultDigest?: string
    readonly artifactRefs?: ReadonlyArray<AgentRuntime.ArtifactID>
    readonly evidenceRefs?: ReadonlyArray<AgentRuntime.EvidenceID>
    readonly createdAt: number
  },
): A2A.StatusEvent =>
  signStatus(local, {
    version: 1,
    taskID: input.taskID,
    sequence: input.sequence,
    status: input.status,
    actor: local.identity,
    summary: input.summary,
    ...(input.resultDigest ? { resultDigest: input.resultDigest } : {}),
    artifactRefs: [...(input.artifactRefs ?? [])],
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    createdAt: input.createdAt,
    signature: {
      algorithm: "ed25519",
      keyID: local.keyID,
      payloadDigest: zeroDigest,
      value: "pending",
    },
  })

const acceptedFor = (state: TaskState, replayed: boolean): A2A.Accepted => {
  const first = state.statuses[0]
  if (!first) throw new A2ATransportError("TRANSPORT_CONFLICT", "accepted task aggregate has no accepted status")
  return {
    version: 1,
    taskID: state.envelope.taskID,
    requestID: state.envelope.requestID,
    status: "accepted",
    replayed,
    statusSequence: first.sequence,
    receiptDigest: statusEventDigest(first),
    acceptedAt: first.createdAt,
  }
}

const assertExactReplay = (existing: A2A.TaskEnvelope, presented: A2A.TaskEnvelope) => {
  if (!assertIdempotentReplay(existing, presented))
    throw new A2ATransportError("IDEMPOTENCY_CONFLICT", "the task ID was reused with a different idempotency identity")
}

const asAcceptedData = (value: unknown): TaskAcceptedData =>
  Schema.decodeUnknownSync(A2A.Event.TaskAccepted.data, { onExcessProperty: "error" })(value)
const asStatusData = (value: unknown): TaskStatusData =>
  Schema.decodeUnknownSync(A2A.Event.TaskStatusRecorded.data, { onExcessProperty: "error" })(value)
const asResultData = (value: unknown): TaskResultData =>
  Schema.decodeUnknownSync(A2A.Event.TaskResultRecorded.data, { onExcessProperty: "error" })(value)
const asControlData = (value: unknown): TaskControlData =>
  Schema.decodeUnknownSync(A2A.Event.TaskControlApplied.data, { onExcessProperty: "error" })(value)
const asNonceData = (value: unknown): NonceClaimData =>
  Schema.decodeUnknownSync(A2A.Event.NonceClaimed.data, { onExcessProperty: "error" })(value)

const makeLayer = (config: Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* protocolGuard("A2A transport configuration", () => validateConfig(config))
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const durableRun = yield* DurableRun.Service
      const peers = new Map(config.peers.map((peer) => [peer.identity.agentID, peer]))
      const now = () => {
        const value = config.nowMs?.() ?? Date.now()
        if (!Number.isSafeInteger(value) || value <= 0) throw configError("nowMs returned an invalid epoch value")
        return value
      }

      const localPeer = () => config.local

      const resolvePeer = (identity: A2A.PeerIdentity): PeerKey => {
        if (sameIdentity(identity, config.local.identity)) return config.local
        const peer = peers.get(identity.agentID)
        if (!peer || !sameIdentity(identity, peer.identity))
          throw new A2ATransportError("PEER_NOT_ALLOWED", "the peer identity is not in the local allowlist")
        return peer
      }

      const assertChannel = (channel: A2A.ChannelPolicy) => {
        if (!sameChannel(channel, config.channel))
          throw new A2ATransportError("INVALID_CHANNEL", "the envelope channel does not match local policy")
      }

      const authenticateEnvelope = (input: unknown) =>
        Effect.gen(function* () {
          const envelope = yield* protocolGuard("task envelope", () => decodeTaskEnvelope(input, { nowMs: now() }))
          yield* protocolGuard("A2A channel authentication", () => assertChannel(envelope.channel))
          if (!sameIdentity(envelope.recipient, config.local.identity))
            return yield* fail(
              "LOCAL_RECIPIENT_REQUIRED",
              "the local transport accepts tasks addressed to this node only",
            )
          const sender = yield* protocolGuard("A2A peer authentication", () => {
            const peer = resolvePeer(envelope.sender)
            verifyEd25519(peer, envelope.signature, taskEnvelopeDigest(envelope))
            return peer
          })
          return { envelope, sender }
        })

      const authenticateControl = (input: unknown, envelope: A2A.TaskEnvelope, kind: "cancel" | "revoke") =>
        Effect.gen(function* () {
          const request =
            kind === "cancel"
              ? yield* protocolGuard("cancel request", () => decodeCancelRequest(input, envelope))
              : yield* protocolGuard("revoke request", () => decodeRevokeRequest(input, envelope))
          yield* protocolGuard("A2A control channel authentication", () => assertChannel(request.channel))
          yield* protocolGuard("A2A control peer authentication", () => {
            const actor = resolvePeer(request.actor)
            verifyEd25519(
              actor,
              request.signature,
              kind === "cancel"
                ? cancelRequestDigest(request as A2A.CancelRequest)
                : revokeRequestDigest(request as A2A.RevokeRequest),
            )
          })
          return request
        })

      const readTask = (taskID: A2A.TaskID): Effect.Effect<TaskState | undefined, unknown> =>
        EventV2.readAggregate<A2A.DurableEvent>(db, {
          aggregateID: taskID,
          limit: 2_000,
          strict: true,
          manifest: {
            definitions: DurableEventManifest.Durable,
            schema: A2A.DurableEvent,
          },
        }).pipe(
          Effect.map(({ events: aggregateEvents }) => {
            if (aggregateEvents.length === 0) return undefined
            let state:
              | {
                  envelope: A2A.TaskEnvelope
                  childRunID: AgentRuntime.RunID
                  statuses: A2A.StatusEvent[]
                  controls: ControlRecord[]
                  receipt?: A2A.ResultReceipt
                }
              | undefined

            for (const event of aggregateEvents) {
              if (event.type === A2A.Event.TaskAccepted.type) {
                const data = asAcceptedData(event.data)
                if (state)
                  throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A task aggregate has two accepted events")
                if (
                  data.taskID !== taskID ||
                  data.envelope.taskID !== taskID ||
                  data.requestID !== data.envelope.requestID ||
                  data.status.taskID !== taskID ||
                  data.status.sequence !== 1 ||
                  data.status.status !== "accepted"
                )
                  throw new A2ATransportError(
                    "TRANSPORT_CONFLICT",
                    "A2A acceptance identity does not match its aggregate",
                  )
                state = {
                  envelope: data.envelope,
                  childRunID: data.childRunID,
                  statuses: [data.status],
                  controls: [],
                }
                continue
              }
              if (!state) throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A task event precedes task acceptance")
              if (event.type === A2A.Event.TaskStatusRecorded.type) {
                const data = asStatusData(event.data)
                if (data.taskID !== taskID || data.status.taskID !== taskID)
                  throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A status identity does not match its aggregate")
                appendStoredStatus(state.statuses, data.status)
              } else if (event.type === A2A.Event.TaskResultRecorded.type) {
                const data = asResultData(event.data)
                if (
                  state.receipt !== undefined ||
                  data.taskID !== taskID ||
                  data.requestID !== state.envelope.requestID ||
                  data.receipt.taskID !== taskID ||
                  data.receipt.requestID !== state.envelope.requestID ||
                  data.status.taskID !== taskID ||
                  data.status.status !== data.receipt.status ||
                  data.status.resultDigest !== data.receipt.resultDigest ||
                  JSON.stringify(data.status.artifactRefs) !== JSON.stringify(data.receipt.artifactRefs) ||
                  JSON.stringify(data.status.evidenceRefs) !== JSON.stringify(data.receipt.evidenceRefs)
                )
                  throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A result identity does not match its aggregate")
                state.receipt = data.receipt
                appendStoredStatus(state.statuses, data.status)
              } else if (event.type === A2A.Event.TaskControlApplied.type) {
                const data = asControlData(event.data)
                const expectedStatus = data.kind === "cancel" ? "cancelled" : "revoked"
                if (
                  data.taskID !== taskID ||
                  data.requestID !== state.envelope.requestID ||
                  data.status.taskID !== taskID ||
                  data.status.status !== expectedStatus
                )
                  throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A control identity does not match its aggregate")
                state.controls.push({
                  kind: data.kind,
                  requestID: data.requestID,
                  nonce: data.nonce,
                  requestDigest: data.requestDigest,
                  status: data.status,
                })
                appendStoredStatus(state.statuses, data.status)
              } else
                throw new A2ATransportError(
                  "TRANSPORT_CONFLICT",
                  "A2A task aggregate contains an event from another aggregate family",
                )
            }
            if (!state) return undefined
            return {
              ...state,
              eventCount: aggregateEvents.length,
            }
          }),
          Effect.flatMap((state) =>
            state
              ? protocolGuard("stored A2A aggregate verification", () => {
                  verifyStoredState(state)
                  return state
                })
              : Effect.succeed(undefined),
          ),
        )

      type NonceIdentity = {
        readonly channelID: string
        readonly senderAgentID: string
        readonly recipientAgentID: string
        readonly nonce: string
      }

      const nonceAggregateID = (input: NonceIdentity) =>
        hashRequired(
          {
            protocol: "a2a-private-v1",
            channelID: input.channelID,
            sender: input.senderAgentID,
            recipient: input.recipientAgentID,
            nonce: input.nonce,
          },
          "A2A nonce aggregate",
        )

      const taskNonceIdentity = (envelope: A2A.TaskEnvelope): NonceIdentity => ({
        channelID: envelope.channel.channelID,
        senderAgentID: envelope.sender.agentID,
        recipientAgentID: envelope.recipient.agentID,
        nonce: envelope.nonce,
      })

      const readNonce = (identity: NonceIdentity): Effect.Effect<NonceClaimData | undefined, unknown> =>
        EventV2.readAggregate<A2A.DurableEvent>(db, {
          aggregateID: nonceAggregateID(identity),
          limit: 8,
          strict: true,
          manifest: {
            definitions: DurableEventManifest.Durable,
            schema: A2A.DurableEvent,
          },
        }).pipe(
          Effect.map(({ events: aggregateEvents }) => {
            if (aggregateEvents.length === 0) return undefined
            if (aggregateEvents.length !== 1 || aggregateEvents[0]?.type !== A2A.Event.NonceClaimed.type)
              throw new A2ATransportError(
                "TRANSPORT_CONFLICT",
                "A2A nonce aggregate must contain exactly one nonce claim",
              )
            const claimed = asNonceData(aggregateEvents[0].data)
            const expectedDigest = nonceAggregateID({
              channelID: claimed.sender.channelID,
              senderAgentID: claimed.sender.agentID,
              recipientAgentID: claimed.recipient.agentID,
              nonce: claimed.nonce,
            })
            if (
              claimed.nonceDigest !== nonceAggregateID(identity) ||
              claimed.nonceDigest !== expectedDigest ||
              claimed.sender.channelID !== claimed.recipient.channelID
            )
              throw new A2ATransportError("TRANSPORT_CONFLICT", "A2A nonce claim identity is inconsistent")
            return claimed
          }),
        )

      const claimNonce = (envelope: A2A.TaskEnvelope) =>
        Effect.gen(function* () {
          const nonceDigest = nonceAggregateID(taskNonceIdentity(envelope))
          const envelopeDigest = taskEnvelopeDigest(envelope)
          const existing = yield* readNonce(taskNonceIdentity(envelope))
          if (existing) {
            if (existing.envelopeDigest !== envelopeDigest || existing.taskID !== envelope.taskID)
              return yield* fail("IDEMPOTENCY_CONFLICT", "the A2A wire nonce was already claimed by another task")
            return
          }
          const exit = yield* Effect.exit(
            events.publish(
              A2A.Event.NonceClaimed,
              {
                nonceDigest,
                nonce: envelope.nonce,
                taskID: envelope.taskID,
                requestID: envelope.requestID,
                envelopeDigest,
                sender: envelope.sender,
                recipient: envelope.recipient,
              },
              { expectedSequence: -1 },
            ),
          )
          if (exit._tag === "Success") return
          const raced = yield* readNonce(taskNonceIdentity(envelope))
          if (raced && raced.envelopeDigest === envelopeDigest && raced.taskID === envelope.taskID) return
          return yield* fail("TRANSPORT_CONFLICT", "A2A nonce claim conflicted repeatedly")
        })

      const claimControlNonce = (input: {
        readonly channelID: string
        readonly senderAgentID: string
        readonly recipientAgentID: string
        readonly nonce: A2A.Nonce
        readonly taskID: A2A.TaskID
        readonly requestID: A2A.RequestID
        readonly requestDigest: string
        readonly sender: A2A.PeerIdentity
        readonly recipient: A2A.PeerIdentity
      }) =>
        Effect.gen(function* () {
          const identity = {
            channelID: input.channelID,
            senderAgentID: input.senderAgentID,
            recipientAgentID: input.recipientAgentID,
            nonce: input.nonce,
          }
          const nonceDigest = nonceAggregateID(identity)
          const existing = yield* readNonce(identity)
          if (existing) {
            if (existing.envelopeDigest !== input.requestDigest || existing.taskID !== input.taskID)
              return yield* fail("IDEMPOTENCY_CONFLICT", "the A2A control nonce was already claimed by another request")
            return
          }
          const exit = yield* Effect.exit(
            events.publish(
              A2A.Event.NonceClaimed,
              {
                nonceDigest,
                nonce: input.nonce,
                taskID: input.taskID,
                requestID: input.requestID,
                envelopeDigest: input.requestDigest,
                sender: input.sender,
                recipient: input.recipient,
              },
              { expectedSequence: -1 },
            ),
          )
          if (exit._tag === "Success") return
          const raced = yield* readNonce(identity)
          if (raced && raced.envelopeDigest === input.requestDigest && raced.taskID === input.taskID) return
          return yield* fail("TRANSPORT_CONFLICT", "A2A control nonce claim conflicted repeatedly")
        })

      const verifyStoredState = (state: TaskState) => {
        const envelope = decodeTaskEnvelope(state.envelope, { nowMs: 0 })
        assertChannel(envelope.channel)
        if (!sameIdentity(envelope.recipient, config.local.identity))
          throw new A2ATransportError("LOCAL_RECIPIENT_REQUIRED", "stored A2A task is not addressed to the local node")
        const sender = resolvePeer(envelope.sender)
        verifyEd25519(sender, envelope.signature, taskEnvelopeDigest(envelope))
        for (const status of state.statuses) {
          if (!sameIdentity(status.actor, config.local.identity))
            throw new A2ATransportError("TRANSPORT_CONFLICT", "stored A2A status actor is not the local node")
          verifyEd25519(config.local, status.signature, statusEventDigest(status))
        }
        if (state.receipt) {
          decodeResultReceipt(state.receipt, state.envelope)
          verifyEd25519(config.local, state.receipt.signature, resultReceiptDigest(state.receipt))
          if (state.receipt.verification.mode !== "local-verifier")
            throw new A2ATransportError("RESULT_NOT_VERIFIED", "stored A2A receipt is not local-verifier bound")
        }
      }

      const requireTask = (taskID: A2A.TaskID) =>
        Effect.gen(function* () {
          const state = yield* readTask(taskID)
          if (!state) return yield* fail("TASK_NOT_FOUND", "the A2A task does not exist")
          return state
        })

      const ensureReader = (state: TaskState, requester: A2A.PeerIdentity) => {
        resolvePeer(requester)
        if (!sameIdentity(requester, state.envelope.sender) && !sameIdentity(requester, state.envelope.recipient))
          throw new A2ATransportError("PEER_NOT_ALLOWED", "the requester is not a participant in this task")
      }

      const resolveCapabilityReference = (envelope: A2A.TaskEnvelope) =>
        Effect.gen(function* () {
          const resolved = yield* config.capabilityResolver
            .resolve({
              parentRunID: envelope.parentRunID,
              sender: envelope.sender,
              recipient: envelope.recipient,
              reference: envelope.capability,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new A2ATransportError(
                    "CAPABILITY_REFERENCE_INVALID",
                    "the local capability registry could not resolve this reference",
                  ),
              ),
            )
          if (!resolved)
            return yield* fail(
              "CAPABILITY_REFERENCE_INVALID",
              "the delegated capability reference is not present in the local registry",
            )
          const expected = yield* protocolGuard("local capability reference", () =>
            Schema.decodeUnknownSync(A2A.CapabilityReference, { onExcessProperty: "error" })(resolved),
          )
          if (capabilityReferenceDigest(expected) !== capabilityReferenceDigest(envelope.capability))
            return yield* fail(
              "CAPABILITY_REFERENCE_INVALID",
              "the delegated capability reference does not match the locally authorized grant",
            )
        })

      const ensureQueued = (runID: AgentRuntime.RunID) =>
        Effect.gen(function* () {
          let snapshot = yield* durableRun.load(runID)
          if (snapshot.run.status === "draft") {
            snapshot = yield* durableRun.transition({ runID, to: "preflight", reason: "private A2A task accepted" })
          }
          if (snapshot.run.status === "preflight") {
            yield* durableRun.transition({ runID, to: "queued", reason: "private A2A task queued" })
          }
        })

      const childFor = (envelope: A2A.TaskEnvelope) =>
        Effect.gen(function* () {
          const parent = yield* durableRun.load(envelope.parentRunID)
          if (!("sessionID" in parent.run) || parent.run.project === undefined || parent.run.location === undefined)
            return yield* fail(
              "PARENT_RUN_REQUIRED",
              "parentRunID must resolve to a local SessionRun with project and location",
            )
          const child = yield* durableRun.createChild({
            parentRunID: envelope.parentRunID,
            sessionID: parent.run.sessionID,
            idempotencyKey: `a2a:${envelope.taskID}:${envelope.idempotencyKey}`,
            delegatedObjective: envelope.objective,
            allowedCapabilities: [
              {
                action: envelope.capability.action,
                resources: [...envelope.capability.resources],
                access: envelope.capability.access,
              },
            ],
            project: parent.run.project,
            location: parent.run.location,
            expectedDeliverable: {
              summaryRequired: true,
              artifactKinds: [],
              evidenceKinds: [],
              verifier: "local:a2a",
            },
            deadlineAt: DateTime.makeUnsafe(envelope.deadlineAt),
            initiator: "agent",
            authority: "scoped_grant",
            riskTier: envelope.capability.access === "write" ? "L2" : "L0",
            reasonSummary: "private A2A delegated task",
            budget: AgentRuntime.Budget.make({
              maxAttempts: envelope.budget.maxAttempts,
              maxDurationMs: envelope.budget.maxDurationMs,
              maxCostMicros: envelope.budget.maxCostMicros,
              maxTokens: envelope.budget.maxTokens ?? AgentRuntime.DEFAULT_MAX_TOKENS,
              attemptsUsed: 0,
              durationMsUsed: 0,
              costMicrosUsed: 0,
              tokensUsed: 0,
            }),
            traceID: `a2a:${envelope.taskID}`,
            parentTraceID: parent.run.traceID,
            visibility: "audit",
          })
          yield* ensureQueued(child.run.id)
          return child
        })

      const childUsage = (snapshot: DurableRun.Snapshot) => ({
        attempts: snapshot.run.budget.attemptsUsed,
        durationMs: snapshot.run.budget.durationMsUsed,
        costMicros: snapshot.run.budget.costMicrosUsed,
        tokens: snapshot.run.budget.tokensUsed,
      })

      const sameUsage = (left: A2A.Usage, right: A2A.Usage) =>
        left.attempts === right.attempts &&
        left.durationMs === right.durationMs &&
        left.costMicros === right.costMicros &&
        left.tokens === right.tokens

      const recordCancelledChild = (runID: AgentRuntime.RunID, summary: string) =>
        Effect.gen(function* () {
          const child = yield* durableRun.load(runID)
          if (child.run.status !== "cancelled") return
          yield* durableRun.recordChildResult({
            runID,
            result: {
              status: "cancelled",
              summary,
              artifactRefs: [],
              evidenceRefs: [],
              usage: childUsage(child),
            },
          })
        })

      const finalizeChildResult = (state: TaskState, receipt: A2A.ResultReceipt) =>
        Effect.gen(function* () {
          let child = yield* durableRun.load(state.childRunID)
          if (!childTerminalStatuses.has(child.run.status)) {
            if (child.run.status === "draft" || child.run.status === "preflight") {
              yield* ensureQueued(state.childRunID)
              child = yield* durableRun.load(state.childRunID)
            }
            if (child.run.status === "paused") {
              child = yield* durableRun.transition({
                runID: state.childRunID,
                to: "running",
                reason: "resume verified private A2A result reconciliation",
              })
            }
            if (receipt.status === "cancelled" && receipt.usage.attempts === 0) {
              child = yield* durableRun.cancel({
                runID: state.childRunID,
                reason: "verified private A2A task was cancelled remotely",
                recursive: true,
              })
            } else {
              if (child.run.status === "queued") {
                child = yield* durableRun.transition({
                  runID: state.childRunID,
                  to: "running",
                  reason: "materialize verified private A2A execution usage",
                })
              }
              while (child.run.status === "running") {
                const used = childUsage(child)
                if (
                  used.attempts > receipt.usage.attempts ||
                  used.durationMs > receipt.usage.durationMs ||
                  used.costMicros > receipt.usage.costMicros ||
                  used.tokens > receipt.usage.tokens
                )
                  return yield* fail(
                    "RESULT_NOT_VERIFIED",
                    "the local child already consumed more than the verified remote usage",
                  )
                if (child.activeAttempt) {
                  const finalAttempt = used.attempts === receipt.usage.attempts
                  child = yield* durableRun.finishAttempt({
                    runID: state.childRunID,
                    attempt: child.activeAttempt.attempt,
                    outcome:
                      finalAttempt && receipt.status === "completed"
                        ? "completed"
                        : finalAttempt && receipt.status === "cancelled"
                          ? "interrupted"
                          : "failed",
                    durationMs: finalAttempt ? receipt.usage.durationMs - used.durationMs : 0,
                    costMicros: finalAttempt ? receipt.usage.costMicros - used.costMicros : 0,
                    tokens: finalAttempt ? receipt.usage.tokens - used.tokens : 0,
                  })
                  continue
                }
                if (used.attempts >= receipt.usage.attempts) break
                child = yield* durableRun.beginAttempt({ runID: state.childRunID })
              }
              if (!sameUsage(childUsage(child), receipt.usage))
                return yield* fail(
                  "RESULT_NOT_VERIFIED",
                  "the materialized child usage does not match the verified result receipt",
                )
              if (receipt.status === "cancelled") {
                child = yield* durableRun.cancel({
                  runID: state.childRunID,
                  reason: "verified private A2A task was cancelled remotely",
                  recursive: true,
                })
              } else {
                if (child.run.status === "running")
                  child = yield* durableRun.transition({
                    runID: state.childRunID,
                    to: "verifying",
                    reason: "verify private A2A result receipt",
                  })
                if (child.run.status === "verifying")
                  child = yield* durableRun.transition({
                    runID: state.childRunID,
                    to: receipt.status,
                    reason: `private A2A result verified as ${receipt.status}`,
                  })
              }
            }
          }
          child = yield* durableRun.load(state.childRunID)
          if (child.run.status !== receipt.status || !sameUsage(childUsage(child), receipt.usage))
            return yield* fail(
              "RESULT_NOT_VERIFIED",
              "the terminal local child does not match the verified A2A result",
            )
          yield* durableRun.recordChildResult({
            runID: state.childRunID,
            result: {
              status: receipt.status,
              summary: receipt.summary,
              artifactRefs: receipt.artifactRefs,
              evidenceRefs: receipt.evidenceRefs,
              usage: receipt.usage,
            },
          })
        })

      const publishRecoveryStatus = (state: TaskState, status: "failed" | "cancelled", summary: string) =>
        Effect.gen(function* () {
          const event = makeStatus(config.local, {
            taskID: state.envelope.taskID,
            sequence: (state.statuses.at(-1)?.sequence ?? 0) + 1,
            status,
            summary,
            createdAt: now(),
          })
          const exit = yield* events
            .publish(A2A.Event.TaskStatusRecorded, { taskID: state.envelope.taskID, status: event }, {
              expectedSequence: state.eventCount - 1,
            })
            .pipe(Effect.exit)
          return exit._tag === "Success"
        })

      const publishAccepted = (envelope: A2A.TaskEnvelope, childRunID: AgentRuntime.RunID) =>
        Effect.gen(function* () {
          const status = makeStatus(config.local, {
            taskID: envelope.taskID,
            sequence: 1,
            status: "accepted",
            summary: "A2A task accepted and queued locally",
            createdAt: now(),
          })
          const exit = yield* Effect.exit(
            events.publish(
              A2A.Event.TaskAccepted,
              {
                taskID: envelope.taskID,
                requestID: envelope.requestID,
                envelope,
                childRunID,
                status,
              },
              { expectedSequence: -1 },
            ),
          )
          if (exit._tag === "Success") return yield* requireTask(envelope.taskID)
          const existing = yield* readTask(envelope.taskID)
          if (existing) {
            yield* protocolGuard("idempotent A2A replay", () => assertExactReplay(existing.envelope, envelope))
            return existing
          }
          return yield* fail("TRANSPORT_CONFLICT", "A2A task acceptance lost its durable append race")
        })

      const submit = (input: unknown) =>
        Effect.gen(function* () {
          const { envelope } = yield* authenticateEnvelope(input)
          const existing = yield* readTask(envelope.taskID)
          if (existing) {
            yield* protocolGuard("idempotent A2A replay", () => assertExactReplay(existing.envelope, envelope))
            return acceptedFor(existing, true)
          }
          yield* resolveCapabilityReference(envelope)
          // Claim before child admission. A same-envelope retry reuses this
          // claim, while a cross-task nonce replay cannot leave an orphan Run.
          yield* claimNonce(envelope)
          const child = yield* childFor(envelope)
          const accepted = yield* publishAccepted(envelope, child.run.id)
          return acceptedFor(accepted, false)
        })

      const statusStream = (input: {
        readonly taskID: A2A.TaskID
        readonly requester: A2A.PeerIdentity
        readonly afterSequence?: number
        readonly limit?: number
      }) =>
        Effect.gen(function* () {
          const state = yield* requireTask(input.taskID)
          yield* protocolGuard("A2A status reader authentication", () => ensureReader(state, input.requester))
          const afterSequence = yield* protocolGuard("A2A status cursor", () =>
            normalizeStatusCursor(input.afterSequence),
          )
          const limit = yield* protocolGuard("A2A status page size", () => normalizeStatusLimit(input.limit))
          const eventsPage = state.statuses.filter((event) => event.sequence > afterSequence).slice(0, limit)
          const nextSequence = eventsPage.at(-1)?.sequence ?? afterSequence
          const latestSequence = state.statuses.at(-1)?.sequence ?? 0
          const complete = nextSequence >= latestSequence
          const digestInput = { taskID: input.taskID, afterSequence, nextSequence, complete, events: eventsPage }
          return {
            version: 1 as const,
            taskID: input.taskID,
            afterSequence,
            nextSequence,
            complete,
            events: eventsPage,
            streamDigest: statusStreamDigest(digestInput),
          }
        })

      const result = (input: unknown) =>
        Effect.gen(function* () {
          const decoded = yield* protocolGuard("result receipt", () => input)
          const taskID = inputField(decoded, "taskID")
          if (typeof taskID !== "string") return yield* fail("INVALID_RESULT", "result receipt task ID is missing")
          const state = yield* requireTask(taskID)
          const receipt = yield* protocolGuard("result receipt", () => decodeResultReceipt(input, state.envelope))
          if (receipt.createdAt > state.envelope.deadlineAt || now() > state.envelope.deadlineAt)
            return yield* fail("EXPIRED_DELEGATION", "the A2A result arrived after the task deadline")
          yield* protocolGuard("A2A result authentication", () =>
            verifyEd25519(localPeer(), receipt.signature, resultReceiptDigest(receipt)),
          )
          if (receipt.verification.mode !== "local-verifier")
            return yield* fail("RESULT_NOT_VERIFIED", "the first local transport accepts local-verifier receipts only")
          if (config.verifier.verifierIDs && !config.verifier.verifierIDs.includes(receipt.verification.verifierID))
            return yield* fail("RESULT_NOT_VERIFIED", "the result verifier is not allowlisted locally")
          const verified = yield* config.verifier.verify({ envelope: state.envelope, receipt })
          if (!verified) return yield* fail("RESULT_NOT_VERIFIED", "the local verifier rejected the result evidence")

          for (let attempt = 0; attempt < 3; attempt += 1) {
            const latest = yield* requireTask(state.envelope.taskID)
            if (latest.receipt) {
              if (resultReceiptDigest(latest.receipt) === resultReceiptDigest(receipt)) {
                yield* finalizeChildResult(latest, latest.receipt)
                return latest.receipt
              }
              return yield* fail("IDEMPOTENCY_CONFLICT", "a different result receipt already exists for this task")
            }
            if (latest.statuses.at(-1) && terminalStatuses.has(latest.statuses.at(-1)!.status))
              return yield* fail("TASK_TERMINAL", "a terminal A2A task cannot accept a new result")
            const status = makeStatus(config.local, {
              taskID: latest.envelope.taskID,
              sequence: (latest.statuses.at(-1)?.sequence ?? 0) + 1,
              status: receipt.status,
              summary: receipt.summary,
              resultDigest: receipt.resultDigest,
              artifactRefs: receipt.artifactRefs,
              evidenceRefs: receipt.evidenceRefs,
              createdAt: receipt.createdAt,
            })
            const exit = yield* Effect.exit(
              events.publish(
                A2A.Event.TaskResultRecorded,
                {
                  taskID: latest.envelope.taskID,
                  requestID: latest.envelope.requestID,
                  receipt,
                  status,
                },
                { expectedSequence: latest.eventCount - 1 },
              ),
            )
            if (exit._tag === "Success") {
              const committed = yield* requireTask(latest.envelope.taskID)
              yield* finalizeChildResult(committed, receipt)
              return receipt
            }
          }
          return yield* fail("TRANSPORT_CONFLICT", "result receipt append conflicted repeatedly")
        })

      const control = (input: unknown, kind: "cancel" | "revoke") =>
        Effect.gen(function* () {
          const rawTaskID = inputField(input, "taskID")
          if (typeof rawTaskID !== "string") return yield* fail("INVALID_CONTROL_REQUEST", `${kind} task ID is missing`)
          const initial = yield* requireTask(rawTaskID)
          const request = yield* authenticateControl(input, initial.envelope, kind)
          const requestDigest =
            kind === "cancel"
              ? cancelRequestDigest(request as A2A.CancelRequest)
              : revokeRequestDigest(request as A2A.RevokeRequest)

          for (let attempt = 0; attempt < 3; attempt += 1) {
            const state = yield* requireTask(initial.envelope.taskID)
            const existingRequest = state.controls.find(
              (record) => record.kind === kind && record.requestID === request.requestID,
            )
            if (existingRequest) {
              if (existingRequest.requestDigest !== requestDigest)
                return yield* fail(
                  "IDEMPOTENCY_CONFLICT",
                  `${kind} request identity was replayed with a different payload`,
                )
              return acceptedFor(state, true)
            }
            if (state.controls.some((record) => record.nonce === request.nonce))
              return yield* fail("IDEMPOTENCY_CONFLICT", "A2A control nonce has already been consumed")
            if (state.statuses.at(-1) && terminalStatuses.has(state.statuses.at(-1)!.status))
              return acceptedFor(state, true)

            yield* claimControlNonce({
              channelID: request.channel.channelID,
              senderAgentID: request.actor.agentID,
              recipientAgentID: state.envelope.recipient.agentID,
              nonce: request.nonce,
              taskID: state.envelope.taskID,
              requestID: request.requestID,
              requestDigest,
              sender: request.actor,
              recipient: state.envelope.recipient,
            })
            const child = yield* durableRun.load(state.childRunID)
            const status = makeStatus(config.local, {
              taskID: state.envelope.taskID,
              sequence: (state.statuses.at(-1)?.sequence ?? 0) + 1,
              status: kind === "cancel" ? "cancelled" : "revoked",
              summary: request.reason,
              createdAt: now(),
            })
            const exit = yield* Effect.exit(
              events.publish(
                A2A.Event.TaskControlApplied,
                {
                  taskID: state.envelope.taskID,
                  requestID: request.requestID,
                  kind,
                  nonce: request.nonce,
                  requestDigest,
                  status,
                },
                { expectedSequence: state.eventCount - 1 },
              ),
            )
            if (exit._tag === "Success") {
              if (!childTerminalStatuses.has(child.run.status)) {
                yield* durableRun.cancel({
                  runID: state.childRunID,
                  reason: `${kind}: ${request.reason}`,
                  recursive: true,
                })
                yield* recordCancelledChild(state.childRunID, `${kind}: ${request.reason}`)
              }
              return acceptedFor(yield* requireTask(state.envelope.taskID), false)
            }
          }
          return yield* fail("TRANSPORT_CONFLICT", `${kind} request conflicted repeatedly`)
        })

      const recover = () =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({ aggregateID: EventSequenceTable.aggregate_id })
            .from(EventSequenceTable)
            .where(like(EventSequenceTable.aggregate_id, "a2a_task_%"))
            .all()
            .pipe(Effect.orDie)
          let repaired = 0
          for (const row of rows) {
            const state = yield* readTask(row.aggregateID)
            if (!state) continue
            const child = yield* durableRun.load(state.childRunID)
            const latestStatus = state.statuses.at(-1)?.status
            if (state.receipt) {
              const missingResult = !("childResult" in child.run) || child.run.childResult === undefined
              yield* finalizeChildResult(state, state.receipt)
              if (missingResult) repaired += 1
            } else if (terminalStatuses.has(latestStatus ?? "failed") && !childTerminalStatuses.has(child.run.status)) {
              const latestControl = state.controls.at(-1)
              yield* durableRun.cancel({
                runID: state.childRunID,
                reason: `${latestControl?.kind ?? latestStatus ?? "terminal"}: A2A recovery reconciliation`,
                recursive: true,
              })
              yield* recordCancelledChild(state.childRunID, "A2A terminal task recovery reconciliation")
              repaired += 1
            } else if (!terminalStatuses.has(latestStatus ?? "failed") && now() >= state.envelope.deadlineAt) {
              const published = yield* publishRecoveryStatus(
                state,
                "failed",
                "A2A task deadline expired before a verified result was recorded",
              )
              if (published && !childTerminalStatuses.has(child.run.status)) {
                yield* durableRun.cancel({
                  runID: state.childRunID,
                  reason: "private A2A task deadline expired",
                  recursive: true,
                })
                yield* recordCancelledChild(state.childRunID, "private A2A task deadline expired")
                repaired += 1
              }
            } else if (!terminalStatuses.has(latestStatus ?? "failed") && childTerminalStatuses.has(child.run.status)) {
              if (
                yield* publishRecoveryStatus(
                  state,
                  child.run.status === "cancelled" ? "cancelled" : "failed",
                  "local child became terminal without a verified A2A result receipt",
                )
              )
                repaired += 1
            } else if (
              !terminalStatuses.has(latestStatus ?? "failed") &&
              (child.run.status === "draft" || child.run.status === "preflight")
            ) {
              yield* ensureQueued(state.childRunID)
              repaired += 1
            }
          }
          return repaired
        })

      return {
        submit,
        lookup: statusStream,
        result,
        cancel: (input: unknown) => control(input, "cancel"),
        revoke: (input: unknown) => control(input, "revoke"),
        recover,
      } satisfies Interface
    }),
  )

export const layer = (config: Config) => makeLayer(config)

export const node = (config: Config) =>
  makeGlobalNode({
    service: Service,
    layer: makeLayer(config),
    deps: [Database.node, EventV2.node, DurableRun.globalNode],
  })
