/**
 * Detached recovery for parent-scoped delegated-child control.
 *
 * This module owns scheduling only. DurableRun remains authoritative for the
 * ControlRun lease/attempt/state, ActionGateway remains authoritative for the
 * durable action and settlement, and SubagentControl remains the only service
 * allowed to mutate SessionInput or a child run. Recovery rebuilds an exact
 * request from the immutable ControlRun envelope plus the existing inbox row;
 * it never persists an HTTP closure, raw prompt, cancellation reason, or
 * provider payload.
 */

export * as SubagentControlRecovery from "./subagent-control-recovery"

import * as ActionGateway from "../action-gateway"
import { Database } from "../database/database"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import type { LocationError, LocationServices } from "../location-services"
import { SessionInput } from "../session/input"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { makeGlobalNode } from "../effect/app-node"
import * as SubagentControl from "./subagent-control"
import * as SubagentControlClaim from "./subagent-control-claim"
import * as RuntimeInvariants from "./invariants"
import { DurableRun } from "./durable-run"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SubagentControl as ProtocolSubagentControl } from "@arforge-ai/schema/subagent-control"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { AbsolutePath } from "../schema"
import { Cause, Context, DateTime, Effect, Layer, LayerMap, Schedule, Scope } from "effect"
import { canonicalHash } from "../util/canonical-hash"
import { randomUUID } from "node:crypto"
import {
  AccessDeniedError,
  CurrentCheck,
  PendingSession,
  assertDescendantsReadable,
  assertSessionReadable,
  principalForClaim,
} from "./subagent-control-access"

export const CONTROL_LEASE_TTL_MS = 120_000

const RECOVERABLE_STATUS = new Set<AgentRuntime.RunStatus>([
  "draft",
  "preflight",
  "awaiting_authorization",
  "queued",
  "running",
  "recovering",
  "verifying",
])

const OPERATION_PREFIX = "subagent.control."
const digestPattern = /^[a-f0-9]{64}$/i

export type ControlGatewayReceipt = {
  readonly version: 1
  readonly operation: SubagentControl.Operation
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly timedOut: boolean
  readonly admission?: ProtocolSubagentControl.Admission
}

const ownKeys = (value: object) => Object.keys(value).sort()
const hasExactKeys = (value: object, required: ReadonlyArray<string>, optional: ReadonlyArray<string> = []) => {
  const allowed = new Set([...required, ...optional])
  const keys = ownKeys(value)
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => allowed.has(key))
  )
}

const boundedID = (value: unknown, prefix?: string): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  (prefix === undefined || value.startsWith(prefix))

const operationOf = (value: unknown): value is SubagentControl.Operation =>
  value === "steer" || value === "followup" || value === "wait" || value === "cancel"

/** Strict decoder for the metadata-only ActionGateway result. */
export const decodeControlGatewayReceipt = (value: unknown): ControlGatewayReceipt => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("The control gateway receipt is not an object.")
  const receipt = value as Record<string, unknown>
  if (
    !hasExactKeys(
      receipt,
      ["version", "operation", "parentRunID", "childRunID", "requestID", "timedOut"],
      ["admission"],
    )
  )
    throw new Error("The control gateway receipt contains unexpected or missing fields.")
  if (receipt.version !== 1 || !operationOf(receipt.operation))
    throw new Error("The control gateway receipt version or operation is invalid.")
  if (!boundedID(receipt.parentRunID, "run_") || !boundedID(receipt.childRunID, "run_"))
    throw new Error("The control gateway receipt run identity is invalid.")
  if (!boundedID(receipt.requestID) || typeof receipt.timedOut !== "boolean")
    throw new Error("The control gateway receipt request identity is invalid.")

  let admission: ProtocolSubagentControl.Admission | undefined
  if (receipt.admission !== undefined) {
    if (receipt.admission === null || typeof receipt.admission !== "object" || Array.isArray(receipt.admission))
      throw new Error("The control gateway receipt admission is invalid.")
    const candidate = receipt.admission as Record<string, unknown>
    if (!hasExactKeys(candidate, ["messageID", "sessionID", "delivery", "promptDigest", "envelopeDigest"]))
      throw new Error("The control gateway receipt admission contains unexpected or missing fields.")
    if (
      !boundedID(candidate.messageID, "msg_") ||
      !boundedID(candidate.sessionID, "ses_") ||
      (candidate.delivery !== "steer" && candidate.delivery !== "queue") ||
      typeof candidate.promptDigest !== "string" ||
      !digestPattern.test(candidate.promptDigest) ||
      typeof candidate.envelopeDigest !== "string" ||
      !digestPattern.test(candidate.envelopeDigest)
    )
      throw new Error("The control gateway receipt admission metadata is invalid.")
    if (receipt.operation === "steer" && candidate.delivery !== "steer")
      throw new Error("A steer receipt admission must use steer delivery.")
    if (receipt.operation === "followup" && candidate.delivery !== "queue")
      throw new Error("A followup receipt admission must use queue delivery.")
    admission = candidate as ProtocolSubagentControl.Admission
  }
  if ((receipt.operation === "steer" || receipt.operation === "followup") && admission === undefined)
    throw new Error("A message-control receipt must include its admitted envelope.")
  if ((receipt.operation === "wait" || receipt.operation === "cancel") && admission !== undefined)
    throw new Error("An observation-control receipt cannot include a message admission.")
  return {
    version: 1,
    operation: receipt.operation,
    parentRunID: AgentRuntime.RunID.make(receipt.parentRunID),
    childRunID: AgentRuntime.RunID.make(receipt.childRunID),
    requestID: AgentRuntime.ControlPlaneRequestID.make(receipt.requestID),
    timedOut: receipt.timedOut,
    ...(admission ? { admission } : {}),
  }
}

export const receiptFromResult = (
  result: SubagentControl.Result,
  material: SubagentControlClaim.Material,
): ControlGatewayReceipt => ({
  version: 1,
  operation: result.operation,
  parentRunID: result.parentRunID,
  childRunID: result.childRunID,
  requestID: AgentRuntime.ControlPlaneRequestID.make(material.envelope.requestID),
  timedOut: result.timedOut,
  ...(result.request
    ? {
        admission: {
          messageID: result.request.messageID,
          sessionID: result.request.sessionID,
          delivery: result.request.delivery,
          promptDigest: result.request.promptDigest,
          envelopeDigest: result.request.envelopeDigest,
        },
      }
    : {}),
})

const actionName = (operation: SubagentControl.Operation) => `${OPERATION_PREFIX}${operation}`
const leaseActive = (snapshot: DurableRun.ControlSnapshot, nowMs: number) =>
  snapshot.lease !== undefined && DateTime.toEpochMillis(snapshot.lease.expiresAt) > nowMs
const sorted = (values: ReadonlyArray<string>) => [...values].sort()
const sameArray = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index])

export class RecoveryEnvelopeError extends Error {
  readonly _tag = "SubagentControlRecovery.RecoveryEnvelopeError"

  constructor(
    readonly runID: AgentRuntime.RunID,
    message: string,
  ) {
    super(message)
  }
}

/** Rebuild a typed claim input from a JSON-only ControlRun payload. */
const envelopeInput = (run: AgentRuntime.ControlRun): SubagentControlClaim.Input | undefined => {
  const payload = run.operation.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const value = payload as Record<string, unknown>
  if (!run.operation.kind.startsWith(OPERATION_PREFIX)) return undefined
  if (!operationOf(value.operation) || value.operation !== run.operation.kind.slice(OPERATION_PREFIX.length))
    return undefined
  if (
    !boundedID(value.requestID) ||
    !boundedID(value.parentRunID, "run_") ||
    !boundedID(value.childRunID, "run_") ||
    !boundedID(value.sessionID, "ses_") ||
    typeof value.envelopeDigest !== "string"
  )
    return undefined
  const operation = value.operation
  return {
    operation,
    subject: run.subject,
    parentRunID: AgentRuntime.RunID.make(value.parentRunID),
    childRunID: AgentRuntime.RunID.make(value.childRunID),
    sessionID: SessionSchema.ID.make(value.sessionID),
    requestID: AgentRuntime.ControlPlaneRequestID.make(value.requestID),
    ...(value.messageID === undefined ? {} : { messageID: SessionMessage.ID.make(String(value.messageID)) }),
    ...(value.promptDigest === undefined ? {} : { promptDigest: String(value.promptDigest) }),
    ...(value.delivery === undefined ? {} : { delivery: value.delivery as "steer" | "queue" }),
    ...(value.reasonDigest === undefined ? {} : { reasonDigest: String(value.reasonDigest) }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: Number(value.timeoutMs) }),
    ...(value.recursive === undefined ? {} : { recursive: value.recursive as boolean }),
  }
}

/** Validate that recovery is rebuilding exactly the originally sealed intent. */
/** Reconstruct and revalidate the exact claim material from a persisted run. */
export const rebuildMaterial = (run: AgentRuntime.ControlRun): SubagentControlClaim.Material => {
  const input = envelopeInput(run)
  if (!input) throw new RecoveryEnvelopeError(run.id, "The persisted subagent control envelope is malformed.")
  if (input.requestID !== run.subject.requestID || input.parentRunID === run.id || input.childRunID === run.id)
    throw new RecoveryEnvelopeError(run.id, "The persisted control envelope has an invalid identity binding.")
  let material: SubagentControlClaim.Material
  try {
    material = SubagentControlClaim.make(input)
  } catch (cause) {
    throw new RecoveryEnvelopeError(run.id, cause instanceof Error ? cause.message : String(cause))
  }
  const payloadDigest = canonicalHash(run.operation.payload)
  const gateway = { ...material.gateway, runID: run.id } satisfies Extract<
    ActionGateway.Input,
    { readonly kind: "control-plane" }
  >
  const authorizationDigest = ActionGateway.intentDigestOf(gateway, material.authorization)
  const envelopeDigest =
    run.operation.payload && typeof run.operation.payload === "object" && !Array.isArray(run.operation.payload)
      ? (run.operation.payload as { readonly envelopeDigest?: unknown }).envelopeDigest
      : undefined
  if (
    material.envelope.envelopeDigest !== envelopeDigest ||
    material.inputDigest !== run.operation.inputDigest ||
    payloadDigest !== run.operation.payloadDigest ||
    material.actionID !== run.operation.actionID ||
    authorizationDigest !== run.operation.authorizationDigest ||
    actionName(input.operation) !== run.operation.kind ||
    run.operation.policyVersion !== ActionGateway.POLICY_VERSION ||
    !sameArray(sorted(material.resources), sorted(run.operation.resources))
  )
    throw new RecoveryEnvelopeError(
      run.id,
      "The persisted subagent control envelope no longer matches its immutable operation binding.",
    )
  return material
}

const stableCancelReason = (reasonDigest: string) => {
  if (!digestPattern.test(reasonDigest)) throw new Error("The persisted cancellation reason digest is invalid.")
  return `Parent requested delegated-child cancellation (reason digest ${reasonDigest})`
}

/** Rebuild the direct SubagentControl call without copying prompt bytes into the claim. */
const directFromMaterial = (input: {
  readonly material: SubagentControlClaim.Material
  readonly control: SubagentControl.Interface
  readonly database: Database.Interface
  readonly parentLease: AgentRuntime.RunLease
}) =>
  Effect.gen(function* () {
    const { material, control, database, parentLease } = input
    const envelope = material.envelope
    if (envelope.operation === "steer" || envelope.operation === "followup") {
      if (!envelope.messageID || !envelope.promptDigest || !envelope.delivery)
        return yield* Effect.fail(new Error("The persisted message-control envelope is incomplete."))
      const admitted = yield* SessionInput.find(database.db, envelope.messageID)
      if (
        !admitted ||
        admitted.sessionID !== envelope.sessionID ||
        admitted.delivery !== envelope.delivery ||
        canonicalHash(admitted.prompt) !== envelope.promptDigest
      )
        return yield* Effect.fail(
          new Error("The persisted SessionInput admission does not match the control envelope."),
        )
      const base = {
        callerRunID: envelope.parentRunID,
        parentRunID: envelope.parentRunID,
        childRunID: envelope.childRunID,
        leaseID: parentLease.id,
        ownerID: parentLease.ownerID,
        operation: envelope.operation,
        requestID: envelope.requestID,
        prompt: admitted.prompt,
      }
      return envelope.operation === "steer"
        ? yield* control.steer(base as SubagentControl.SteerInput)
        : yield* control.followup(base as SubagentControl.FollowupInput)
    }
    if (envelope.operation === "wait")
      return yield* control.wait({
        callerRunID: envelope.parentRunID,
        parentRunID: envelope.parentRunID,
        childRunID: envelope.childRunID,
        leaseID: parentLease.id,
        ownerID: parentLease.ownerID,
        operation: "wait",
        ...(envelope.timeoutMs === undefined ? {} : { timeoutMs: envelope.timeoutMs }),
      })
    return yield* control.cancel({
      callerRunID: envelope.parentRunID,
      parentRunID: envelope.parentRunID,
      childRunID: envelope.childRunID,
      leaseID: parentLease.id,
      ownerID: parentLease.ownerID,
      operation: "cancel",
      reason: stableCancelReason(envelope.reasonDigest ?? ""),
      ...(envelope.recursive === undefined ? {} : { recursive: envelope.recursive }),
      ...(envelope.timeoutMs === undefined ? {} : { timeoutMs: envelope.timeoutMs }),
    })
  })

/**
 * Shared ActionGateway handoff used by the HTTP path and detached recovery.
 * `direct` is supplied by HTTP for its already-decoded prompt; recovery leaves
 * it omitted and rebuilds the exact call from the durable envelope/inbox row.
 */
export const executeControlGateway = Effect.fn("SubagentControlRecovery.executeControlGateway")(function* (input: {
  readonly runID: AgentRuntime.RunID
  readonly material: SubagentControlClaim.Material
  readonly sealedKind: "claimed" | "existing"
  readonly parentLease: AgentRuntime.RunLease
  readonly durable: DurableRun.Interface
  readonly gateway: ActionGateway.Interface
  readonly control: SubagentControl.Interface
  readonly database: Database.Interface
  readonly direct?: () => Effect.Effect<SubagentControl.Result, SubagentControl.Error | Error>
}) {
  const { runID, material, parentLease, durable, gateway, control, database } = input
  const initial = yield* durable.load(runID)
  if (!("subject" in initial.run))
    return yield* Effect.fail(new Error("The subagent control operation is not a ControlRun."))
  const controlRun = initial.run
  const assertAccess = Effect.fnUntraced(function* () {
    const principal = yield* principalForClaim(database, controlRun)
    const parent = yield* durable.load(material.envelope.parentRunID)
    if (!("sessionID" in parent.run)) return yield* Effect.fail(new AccessDeniedError())
    yield* assertSessionReadable(database, parent.run.sessionID, principal)
    yield* assertSessionReadable(database, material.envelope.sessionID, principal)
    const pendingSession = yield* PendingSession
    if (pendingSession !== undefined) yield* assertSessionReadable(database, pendingSession, principal)
    if (material.envelope.operation === "cancel" && material.envelope.recursive !== false)
      yield* assertDescendantsReadable(database, durable, material.envelope.childRunID, principal, {
        project: controlRun.subject.project,
        location: String(controlRun.subject.location),
      })
  })
  yield* assertAccess()
  const replay = input.sealedKind === "existing" && initial.run.status === "completed"
  yield* durable.validateLease({ runID: parentLease.runID, leaseID: parentLease.id, ownerID: parentLease.ownerID })
  const acquired = yield* durable.acquireControlLease({
    runID,
    ownerID: `subagent-control-worker:${randomUUID()}`,
    ttlMs: CONTROL_LEASE_TTL_MS,
  })
  const capability = acquired.capability
  let directInvoked = false
  const release = durable
    .releaseControlLease(capability, { runID, reason: "Subagent control worker stopped" })
    .pipe(Effect.catchCause(() => Effect.void))

  return yield* Effect.ensuring(
    Effect.gen(function* () {
      let current = acquired.snapshot
      const recovering = !replay && ["running", "verifying", "recovering"].includes(current.run.status)
      // A worker lease is not a logical attempt. Keep an unfinished attempt
      // under the new exclusive lease instead of charging a second attempt.
      const resumedAttempt = !replay && current.run.status === "running" ? current.activeAttempt : undefined
      if (!replay) {
        if (current.run.status === "running" && resumedAttempt === undefined)
          current = yield* durable.transitionControl(capability, {
            runID,
            to: "recovering",
            reason: "A previous subagent control worker stopped before durable settlement",
          })
        if (current.run.status === "verifying")
          current = yield* durable.transitionControl(capability, {
            runID,
            to: "recovering",
            reason: "Subagent control settlement was observed before the final run transition",
          })
        if (current.run.status === "recovering")
          current = yield* durable.transitionControl(capability, {
            runID,
            to: "running",
            reason: "A new subagent control worker took over the recoverable request",
          })
        if (current.run.status === "draft")
          current = yield* durable.transitionControl(capability, {
            runID,
            to: "preflight",
            reason: "Recovered subagent control claim passed metadata preflight",
          })
        if (current.run.status === "preflight")
          current = yield* durable.transitionControl(capability, {
            runID,
            to: "queued",
            reason: "Recovered subagent control claim queued for ActionGateway execution",
          })
        if (current.run.status === "awaiting_authorization")
          current = yield* durable.transitionControl(capability, {
            runID,
            to: "queued",
            reason: "Recovered subagent control claim uses the bound parent lease as automatic authority",
          })
      }

      const direct = input.direct ?? (() => directFromMaterial({ material, control, database, parentLease }))
      const gatewayInput = {
        ...material.gateway,
        runID,
        runLease: capability,
        ...(replay ? { allowSettledReplay: true } : {}),
        ...(recovering ? { allowControlRecovery: true } : {}),
      } satisfies Extract<ActionGateway.Input, { readonly kind: "control-plane" }>
      const receipt = yield* gateway.execute(gatewayInput, {
        authorization: material.authorization,
        durableResult: { encode: (value: ControlGatewayReceipt) => value, decode: decodeControlGatewayReceipt },
        successSummary: (value: ControlGatewayReceipt) =>
          `${value.operation} control request completed for delegated child`,
        execute: () =>
          Effect.gen(function* () {
            yield* assertAccess()
            let handoff = yield* durable.validateControlLease(capability)
            if (handoff.run.status === "awaiting_authorization")
              handoff = yield* durable.transitionControl(capability, {
                runID,
                to: "queued",
                reason: "ActionGateway handed off the bound subagent control request",
              })
            if (handoff.run.status === "recovering")
              handoff = yield* durable.transitionControl(capability, {
                runID,
                to: "running",
                reason: "ActionGateway resumed the recoverable subagent control request",
              })
            if (handoff.run.status === "queued")
              handoff = yield* durable.transitionControl(capability, {
                runID,
                to: "running",
                reason: "ActionGateway started the direct parent subagent control operation",
              })
            const resuming =
              resumedAttempt !== undefined &&
              handoff.activeAttempt?.attempt === resumedAttempt.attempt &&
              DateTime.toEpochMillis(handoff.activeAttempt.startedAt) ===
                DateTime.toEpochMillis(resumedAttempt.startedAt)
            if (handoff.run.status !== "running" || (handoff.activeAttempt !== undefined && !resuming))
              return yield* new ActionGateway.BlockedError({
                actionID: material.actionID,
                reason: `The control handoff expected an idle running state, found ${handoff.run.status}.`,
              })
            if (
              resuming &&
              handoff.run.budget.durationMsUsed +
                Math.max(
                  0,
                  DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(resumedAttempt.startedAt),
                ) >=
                handoff.run.budget.maxDurationMs
            )
              return yield* new ActionGateway.BlockedError({
                actionID: material.actionID,
                reason: "The resumed control attempt has exhausted its duration budget.",
              })
            const started = resuming ? handoff : yield* durable.beginControlAttempt(capability, { runID })
            const attempt = started.activeAttempt?.attempt
            if (attempt === undefined)
              return yield* new ActionGateway.RecoveryRequiredError({
                actionID: material.actionID,
                reason: "The control attempt did not persist an active attempt before execution.",
              })
            const startedAt = DateTime.toEpochMillis(started.activeAttempt!.startedAt)
            directInvoked = true
            const outcome = yield* Effect.exit(direct().pipe(Effect.provideService(CurrentCheck, assertAccess())))
            const finishedAt = DateTime.toEpochMillis(yield* DateTime.now)
            const interrupted = outcome._tag === "Failure" && Cause.hasInterruptsOnly(outcome.cause)
            yield* Effect.uninterruptible(
              durable.finishControlAttempt(capability, {
                runID,
                attempt,
                outcome: outcome._tag === "Success" ? "completed" : interrupted ? "interrupted" : "failed",
                durationMs: Math.max(0, finishedAt - startedAt),
                costMicros: 0,
                tokens: 0,
              }),
            )
            if (outcome._tag === "Failure") {
              yield* Effect.uninterruptible(
                durable.transitionControl(capability, {
                  runID,
                  to: interrupted ? "paused" : "failed",
                  reason: interrupted
                    ? "The direct parent subagent control operation was interrupted before settlement"
                    : "The direct parent subagent control operation failed",
                }),
              )
              return yield* Effect.failCause(outcome.cause)
            }
            yield* durable.transitionControl(capability, {
              runID,
              to: "verifying",
              reason: "The direct parent subagent control operation produced a durable result",
            })
            return receiptFromResult(outcome.value, material)
          }),
      })

      // Settled-result recovery bypasses the execute callback and its live check.
      // Revalidate before closing an abandoned attempt or disclosing its receipt.
      yield* assertAccess()
      if (!replay) {
        let settled = yield* durable.load(runID)
        if (!directInvoked && resumedAttempt && settled.activeAttempt?.attempt === resumedAttempt.attempt) {
          // Gateway recovered an already settled result without re-execution.
          settled = yield* durable.finishControlAttempt(capability, {
            runID,
            attempt: resumedAttempt.attempt,
            outcome: "completed",
            durationMs: Math.max(
              0,
              DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(resumedAttempt.startedAt),
            ),
            costMicros: 0,
            tokens: 0,
          })
        }
        if ((settled.run.status === "queued" || settled.run.status === "running") && !directInvoked)
          settled = yield* durable.transitionControl(capability, {
            runID,
            to: "verifying",
            reason: "Recovered a settled Action before the subagent control handoff began",
          })
        if (settled.run.status === "recovering")
          settled = yield* durable.transitionControl(capability, {
            runID,
            to: "verifying",
            reason: "Recovered the subagent control lifecycle from its settled Action",
          })
        if (settled.run.status === "verifying")
          settled = yield* durable.transitionControl(capability, {
            runID,
            to: "completed",
            reason: "ActionGateway settled the direct parent subagent control operation",
          })
        if (settled.run.status !== "completed")
          return yield* new ActionGateway.RecoveryRequiredError({
            actionID: material.actionID,
            reason: `The ActionGateway result did not leave the control run completed (${settled.run.status}).`,
          })
      }
      return receipt
    }),
    release,
  )
})

export interface Interface {
  readonly start: (
    runID: AgentRuntime.RunID,
    location?: AgentRuntime.ControlPlaneSubject["location"],
  ) => Effect.Effect<void>
  readonly recover: () => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<AgentRuntime.RunID>>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SubagentControlRecovery") {}

/** Register the recovery owner's cheap, exact-envelope invariant once. */
export const registerInvariants = (registry: RuntimeInvariants.RuntimeInvariantRegistry): void => {
  if (registry.get("subagent-control-recovery", "control-envelope", "1")) return
  registry.register({
    owner: "subagent-control-recovery",
    key: "control-envelope",
    version: "1",
    cost: "cheap",
    check: (context) =>
      Effect.sync(() => {
        if (context === null || typeof context !== "object" || Array.isArray(context))
          throw new Error("control envelope is not an object")
        const envelope = context as SubagentControlClaim.Envelope
        const { envelopeDigest, ...unsigned } = envelope
        const rebuiltDigest = canonicalHash(unsigned)
        RuntimeInvariants.assertExactRequestDigest(envelopeDigest, rebuiltDigest ?? "")
      }),
  })
}

const recoverableOperation = (run: AgentRuntime.Run): run is AgentRuntime.ControlRun =>
  "subject" in run &&
  "operation" in run &&
  run.operation.kind.startsWith(OPERATION_PREFIX) &&
  operationOf(run.operation.kind.slice(OPERATION_PREFIX.length)) &&
  RECOVERABLE_STATUS.has(run.status)

const recoverOne = Effect.fn("SubagentControlRecovery.recoverOne")(function* (input: {
  readonly snapshot: DurableRun.ControlSnapshot
  readonly location: AgentRuntime.ControlPlaneSubject["location"]
  readonly database: Database.Interface
  readonly durable: DurableRun.Interface
  readonly control: SubagentControl.Interface
  readonly gateway: ActionGateway.Interface
  readonly invariants?: RuntimeInvariants.RuntimeInvariantRegistry
}) {
  const { snapshot, location, database, durable, control, gateway, invariants } = input
  const material = rebuildMaterial(snapshot.run)
  const envelope = material.envelope
  if (invariants) {
    const report = yield* invariants.assert(envelope, {
      owner: "subagent-control-recovery",
      key: "control-envelope",
      mode: process.env.NODE_ENV === "production" ? "production" : "development",
    })
    if (!report.passedAll)
      return yield* Effect.fail(
        new RecoveryEnvelopeError(snapshot.run.id, "The sealed control envelope failed its runtime invariant."),
      )
  }
  if (snapshot.run.subject.location !== location)
    throw new RecoveryEnvelopeError(snapshot.run.id, "The recovery location does not match the sealed subject.")
  const parent = yield* durable.load(envelope.parentRunID)
  if (
    !("sessionID" in parent.run && parent.run.project === snapshot.run.subject.project) ||
    String(parent.run.location ?? "") !== String(snapshot.run.subject.location)
  )
    throw new RecoveryEnvelopeError(snapshot.run.id, "The sealed parent run does not match the control scope.")
  if (!parent.lease) {
    yield* Effect.logDebug("Subagent control recovery is waiting for an active parent lease", {
      runID: snapshot.run.id,
      parentRunID: envelope.parentRunID,
    })
    return undefined
  }
  return yield* executeControlGateway({
    runID: snapshot.run.id,
    material,
    sealedKind: "existing",
    parentLease: parent.lease,
    durable,
    gateway,
    control,
    database,
  })
})

const makeScheduler = (input: {
  readonly database: Database.Interface
  readonly durable: DurableRun.Interface
  readonly locations: LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
  readonly invariants?: RuntimeInvariants.RuntimeInvariantRegistry
}): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scheduledLocations = new Map<AgentRuntime.RunID, AgentRuntime.ControlPlaneSubject["location"]>()
    const coordinator = yield* SessionRunCoordinator.make<AgentRuntime.RunID, never>({
      drain: (runID): Effect.Effect<void, never> => {
        const location = scheduledLocations.get(runID)
        if (!location) return Effect.logWarning("Subagent control recovery has no persisted location", { runID })
        const locationLayer = input.locations.get(Location.Ref.make({ directory: AbsolutePath.make(location) }))
        const effect = Effect.gen(function* () {
          const durable = yield* DurableRun.Service
          const control = yield* SubagentControl.Service
          const gateway = yield* ActionGateway.Service
          const snapshot = yield* durable.load(runID)
          if (!recoverableOperation(snapshot.run)) return
          yield* recoverOne({
            snapshot: snapshot as DurableRun.ControlSnapshot,
            location,
            database: input.database,
            durable,
            control,
            gateway,
            invariants: input.invariants,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Subagent control recovery attempt did not settle", { runID, cause }),
            ),
          )
        }).pipe(Effect.provide(locationLayer), Effect.provideService(Database.Service, input.database))
        return effect as Effect.Effect<void, never>
      },
    })

    const start = (runID: AgentRuntime.RunID, location?: AgentRuntime.ControlPlaneSubject["location"]) =>
      Effect.sync(() => {
        if (!location) throw new Error(`Subagent control recovery run ${runID} has no location binding`)
        const previous = scheduledLocations.get(runID)
        if (previous !== undefined && previous !== location)
          throw new Error(`Subagent control recovery run ${runID} was scheduled for two locations`)
        scheduledLocations.set(runID, location)
      }).pipe(Effect.andThen(coordinator.wake(runID)))

    const recover = Effect.fn("SubagentControlRecovery.recover")(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
      const [recoverable, orphaned] = yield* Effect.all([
        input.durable.recoverableControl(),
        input.durable.orphanedControl(),
      ])
      const candidates = new Map<AgentRuntime.RunID, DurableRun.ControlSnapshot>()
      for (const snapshot of [...recoverable, ...orphaned]) {
        if (!recoverableOperation(snapshot.run) || leaseActive(snapshot, nowMs)) continue
        candidates.set(snapshot.run.id, snapshot)
      }
      yield* Effect.forEach(candidates.values(), (snapshot) => start(snapshot.run.id, snapshot.run.subject.location), {
        concurrency: 4,
        discard: true,
      })
    })

    yield* recover().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Initial subagent control recovery scan failed", { cause })),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    )
    return { start, recover, active: coordinator.active } satisfies Interface
  })

export const make: Effect.Effect<
  Interface,
  never,
  Database.Service | DurableRun.Service | LocationServiceMap.Service | RuntimeInvariants.Service | Scope.Scope
> = Effect.gen(function* () {
  const database = yield* Database.Service
  const durable = yield* DurableRun.Service
  const locations = yield* LocationServiceMap.Service
  const invariants = yield* RuntimeInvariants.Service
  registerInvariants(invariants)
  return yield* makeScheduler({ database, durable, locations, invariants })
})

export const layer: Layer.Layer<
  Service,
  never,
  Database.Service | DurableRun.Service | LocationServiceMap.Service | RuntimeInvariants.Service
> = Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, DurableRun.globalNode, LocationServiceMap.node, RuntimeInvariants.node],
})
