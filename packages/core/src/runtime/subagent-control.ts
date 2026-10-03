/**
 * Parent-scoped control for delegated child sessions.
 *
 * This is the durable bridge between the provider control seam and the
 * SessionInput inbox.  DurableRun remains the authority for parent/child
 * identity, execution leases and terminal state; SessionInput remains the
 * single prompt admission pipeline.  Provider state is only an optional
 * process-local accelerator used for waiting/interruption and can never turn
 * an unknown provider outcome into a successful durable cancellation.
 */

export * as SubagentControl from "./subagent-control"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { SubagentControl as SubagentControlContract } from "@arforge-ai/schema/subagent-control"
import { PromptInput } from "@arforge-ai/schema/prompt-input"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { SessionExecution } from "../session/execution"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { RuntimeInsight } from "./insight"
import { DurableRun } from "./durable-run"
import { SubagentProvider } from "./subagent-provider"
import * as ControlClaimIndex from "./control-claim-index"
import * as SubagentControlClaim from "./subagent-control-claim"
import { canonicalHash } from "../util/canonical-hash"
import { KeyedMutex } from "../effect/keyed-mutex"
import { AccessDeniedError, CurrentCheck, TreeScopeError } from "./subagent-control-access"

export const Operation = Schema.Literals(["steer", "followup", "wait", "cancel"] as const)
export type Operation = typeof Operation.Type

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "SubagentControl.InvalidRequestError",
  {
    operation: Operation,
    parentRunID: AgentRuntime.RunID,
    childRunID: AgentRuntime.RunID,
    reason: Schema.String,
  },
) {}

export class RequestConflictError extends Schema.TaggedErrorClass<RequestConflictError>()(
  "SubagentControl.RequestConflictError",
  {
    operation: Schema.Literals(["steer", "followup"]),
    parentRunID: AgentRuntime.RunID,
    childRunID: AgentRuntime.RunID,
    requestID: Schema.String,
    messageID: SessionMessage.ID,
    reason: Schema.String,
  },
) {}

export class ControlClosedError extends Schema.TaggedErrorClass<ControlClosedError>()(
  "SubagentControl.ControlClosedError",
  {
    operation: Operation,
    runID: AgentRuntime.RunID,
    status: AgentRuntime.RunStatus,
  },
) {}

type ParentLeaseInput = {
  readonly callerRunID: AgentRuntime.RunID
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly leaseID: AgentRuntime.LeaseID
  readonly ownerID: string
}

export type SteerInput = ParentLeaseInput & {
  readonly operation: "steer"
  /** Client/request identity. Replays with the same identity are idempotent. */
  readonly requestID: string
  readonly prompt: PromptInput.Prompt
}

export type FollowupInput = ParentLeaseInput & {
  readonly operation: "followup"
  /** Client/request identity. Replays with the same identity are idempotent. */
  readonly requestID: string
  readonly prompt: PromptInput.Prompt
}

export type WaitInput = ParentLeaseInput & {
  readonly operation: "wait"
  /** 0 is a non-blocking snapshot; omitted is a bounded five-second wait. */
  readonly timeoutMs?: number
}

export type CancelInput = ParentLeaseInput & {
  readonly operation: "cancel"
  readonly reason: string
  readonly recursive?: boolean
  /** 0 asks the provider for an immediate outcome and never waits. */
  readonly timeoutMs?: number
}

export type Input = SteerInput | FollowupInput | WaitInput | CancelInput

/**
 * A metadata-only, authenticated control intent.  `claim` seals this intent
 * through the existing ControlClaimIndex/ActionGateway path after a
 * steer/followup has already been admitted to SessionInput.  It never accepts
 * a raw prompt or cancellation reason and it never mutates the child run.
 */
export type ClaimInput = SubagentControlClaim.Input & {
  /** Internal two-phase adapter marker; it is not persisted in the claim. */
  readonly admission?: "pending" | "required"
}

/**
 * The exact request envelope stored in an audit record and returned to the
 * caller. It contains identity and digests only; prompt bytes stay in the
 * existing SessionInput durable inbox and are never copied into provider
 * metadata or RuntimeInsight.
 */
export interface RequestEnvelope {
  readonly schemaVersion: 1
  readonly operation: "steer" | "followup"
  readonly requestID: string
  readonly messageID: SessionMessage.ID
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: SessionSchema.ID
  readonly delivery: SessionInput.Delivery
  readonly promptDigest: string
  readonly envelopeDigest: string
}

export interface Result {
  readonly operation: Operation
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly durable: DurableRun.ChildSnapshot
  readonly timedOut: boolean
  readonly provider?: SubagentProvider.Snapshot
  readonly request?: RequestEnvelope
  readonly admitted?: SessionInput.Admitted
}

type Authorized = {
  readonly parent: DurableRun.SessionSnapshot
  readonly child: DurableRun.ChildSnapshot
}

export type Error =
  | AccessDeniedError
  | TreeScopeError
  | InvalidRequestError
  | RequestConflictError
  | ControlClosedError
  | DurableRun.NotFoundError
  | DurableRun.CorruptHistoryError
  | DurableRun.LeaseMismatchError
  | DurableRun.InvalidRunLeaseCapabilityError
  | DurableRun.ChildParentMismatchError
  | DurableRun.ChildAdmissionError
  | DurableRun.InvalidTransitionError
  | DurableRun.AttemptMismatchError
  | DurableRun.InvalidAttemptStateError
  | SubagentProvider.Error
  | SubagentControlClaim.InvalidClaimRequestError
  | ControlClaimIndex.MissingPrincipalError
  | ControlClaimIndex.InvalidClaimMaterialError
  | ControlClaimIndex.ClaimConflictError

const terminal = (status: AgentRuntime.RunStatus) => ["completed", "failed", "cancelled"].includes(status)

/** Read-only projection of durable facts, not a second settlement state machine. */
export function resultReceiptStatus(
  run: Pick<AgentRuntime.SessionRun, "status" | "childResult">,
): SubagentControlContract.ResultReceiptStatus {
  if (run.status === "cancelled") return "not-required"
  if (run.status !== "completed" && run.status !== "failed") return "pending"
  return run.childResult ? "present" : "missing"
}

const validBoundedString = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || value.trim().length === 0) return `${label} must be a non-empty string`
  if (value.length > max) return `${label} exceeds the ${max}-character bound`
  return undefined
}

const timeoutOrDefault = (value: number | undefined) => value ?? 5_000

const validTimeout = (value: number | undefined) => {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000)
    return "timeoutMs must be an integer between 0 and 60000"
  return undefined
}

const operationOf = (input: { readonly operation?: unknown }): Operation => {
  if (
    input.operation === "steer" ||
    input.operation === "followup" ||
    input.operation === "wait" ||
    input.operation === "cancel"
  )
    return input.operation
  return "wait"
}

const safeRunID = (value: unknown, fallback: string) =>
  typeof value === "string" && value.startsWith("run_")
    ? AgentRuntime.RunID.make(value)
    : AgentRuntime.RunID.make(fallback)

const invalid = (input: ParentLeaseInput & { readonly operation?: unknown }, reason: string) =>
  new InvalidRequestError({
    operation: operationOf(input),
    parentRunID: safeRunID(input.parentRunID, "run_invalid-parent"),
    childRunID: safeRunID(input.childRunID, "run_invalid-child"),
    reason,
  })

const validateParentLeaseInput = (input: Input): string | undefined => {
  const identifiers = [
    validBoundedString(input.callerRunID, "callerRunID", 512),
    validBoundedString(input.parentRunID, "parentRunID", 512),
    validBoundedString(input.childRunID, "childRunID", 512),
    validBoundedString(input.leaseID, "leaseID", 512),
    validBoundedString(input.ownerID, "ownerID", 512),
  ].filter((value): value is string => value !== undefined)
  if (identifiers.length > 0) return identifiers.join("; ")
  if (input.callerRunID !== input.parentRunID) return "only the direct parent run may control a delegated child"
  if (input.parentRunID === input.childRunID) return "a child cannot control itself"
  if (input.operation === "wait" || input.operation === "cancel") {
    const timeoutError = validTimeout(input.timeoutMs)
    if (timeoutError) return timeoutError
  }
  if (input.operation === "cancel") {
    const reasonError = validBoundedString(input.reason, "reason", 2_000)
    if (reasonError) return reasonError
  }
  return undefined
}

const validatePrompt = (prompt: PromptInput.Prompt): string | undefined => {
  if (prompt === null || typeof prompt !== "object") return "prompt must be an object"
  if (typeof prompt.text !== "string") return "prompt.text must be a string"
  if (prompt.text.length > 64_000) return "prompt.text exceeds the 64000-character bound"
  if (prompt.files !== undefined && !Array.isArray(prompt.files)) return "prompt.files must be an array"
  if (prompt.files && prompt.files.length > 64) return "prompt.files exceeds the 64-item bound"
  for (const file of prompt.files ?? []) {
    if (typeof file.uri !== "string") return "prompt file URI must be a string"
    if (file.uri.length > 4_096) return "prompt file URI exceeds the 4096-character bound"
    if (file.name && file.name.length > 512) return "prompt file name exceeds the 512-character bound"
    if (file.description && file.description.length > 2_000)
      return "prompt file description exceeds the 2000-character bound"
  }
  if (prompt.agents !== undefined && !Array.isArray(prompt.agents)) return "prompt.agents must be an array"
  if (prompt.agents && prompt.agents.length > 64) return "prompt.agents exceeds the 64-item bound"
  return undefined
}

const normalizePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    ...(input.files === undefined
      ? {}
      : {
          files: input.files.map((file) => {
            const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
            let target = file.name ?? file.uri
            try {
              target = URL.canParse(file.uri) ? new URL(file.uri).pathname : target
            } catch {
              // Keep the user-provided name/URI for MIME fallback.
            }
            return {
              ...file,
              mime:
                file.mime ?? dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
            }
          }),
        }),
    ...(input.agents === undefined ? {} : { agents: input.agents }),
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.command === undefined ? {} : { command: input.command }),
  })

export interface PreparedInput {
  readonly operation: "steer" | "followup"
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly messageID: SessionMessage.ID
  readonly prompt: typeof Prompt.Type
  readonly promptDigest: string
  readonly delivery: SessionInput.Delivery
}

/**
 * Compute the exact message identity used by the durable admission path
 * without writing anything. A trusted HTTP/CLI adapter can seal a
 * metadata-only control claim first, then call steer/followup; a crash between
 * those two steps leaves no prompt admission and a retry recomputes the same
 * message identity.
 */
export const prepare = (input: {
  readonly operation: "steer" | "followup"
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly prompt: PromptInput.Prompt
}): PreparedInput => {
  const requestError = validBoundedString(input.requestID, "requestID", 256)
  if (requestError)
    throw new InvalidRequestError({
      operation: input.operation,
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      reason: requestError,
    })
  const promptError = validatePrompt(input.prompt)
  if (promptError)
    throw new InvalidRequestError({
      operation: input.operation,
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      reason: promptError,
    })
  let prompt: typeof Prompt.Type
  try {
    prompt = normalizePrompt(input.prompt)
  } catch {
    throw new InvalidRequestError({
      operation: input.operation,
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      reason: "The prompt failed strict schema normalization.",
    })
  }
  const promptDigest = canonicalHash(prompt)
  if (!promptDigest)
    throw new InvalidRequestError({
      operation: input.operation,
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      reason: "The prompt is not canonically hashable.",
    })
  const messageIdentity = canonicalHash({
    schemaVersion: 1,
    operation: input.operation,
    requestID: input.requestID,
    parentRunID: input.parentRunID,
    childRunID: input.childRunID,
  })
  if (!messageIdentity)
    throw new InvalidRequestError({
      operation: input.operation,
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      reason: "The request identity is not canonically hashable.",
    })
  return {
    operation: input.operation,
    parentRunID: input.parentRunID,
    childRunID: input.childRunID,
    sessionID: input.sessionID,
    requestID: input.requestID,
    messageID: SessionMessage.ID.make(`msg_parent_control_${messageIdentity}`),
    prompt,
    promptDigest,
    delivery: input.operation === "steer" ? "steer" : "queue",
  }
}

const childSnapshot = (snapshot: DurableRun.Snapshot): DurableRun.ChildSnapshot | undefined => {
  if (!("sessionID" in snapshot.run) || snapshot.run.child === undefined) return undefined
  return snapshot as DurableRun.ChildSnapshot
}

const childMismatch = (input: ParentLeaseInput, reason: string) =>
  new DurableRun.ChildParentMismatchError({
    parentRunID: input.parentRunID,
    childRunID: input.childRunID,
    reason,
  })

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SubagentControl") {}

export interface Interface {
  /**
   * Seal an already-authorized, metadata-only control intent in the existing
   * ControlRun claim index.  Execution still requires the direct-parent lease
   * through steer/followup/wait/cancel; this method is not a second executor.
   */
  readonly claim: (input: ClaimInput) => Effect.Effect<ControlClaimIndex.ClaimResult, Error>
  readonly steer: (input: SteerInput) => Effect.Effect<Result, Error>
  readonly followup: (input: FollowupInput) => Effect.Effect<Result, Error>
  readonly wait: (input: WaitInput) => Effect.Effect<Result, Error>
  readonly cancel: (input: CancelInput) => Effect.Effect<Result, Error>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const durable = yield* DurableRun.Service
    const claims = yield* ControlClaimIndex.Service
    const { db } = database
    const controls = KeyedMutex.makeUnsafe<AgentRuntime.RunID>()

    const authorize = Effect.fnUntraced(function* (input: Input) {
      yield* yield* CurrentCheck
      const invalidInput = validateParentLeaseInput(input)
      if (invalidInput) return yield* Effect.fail(invalid(input, invalidInput))

      const parent = yield* durable.validateLease({
        runID: input.parentRunID,
        leaseID: input.leaseID,
        ownerID: input.ownerID,
      })
      if (!("sessionID" in parent.run))
        return yield* Effect.fail(invalid(input, "parent-scoped control requires a SessionRun parent"))
      if (terminal(parent.run.status))
        return yield* Effect.fail(
          new ControlClosedError({ operation: input.operation, runID: parent.run.id, status: parent.run.status }),
        )

      const child = childSnapshot(yield* durable.load(input.childRunID))
      if (!child)
        return yield* Effect.fail(childMismatch(input, "Parent-scoped control requires a SessionRun child binding."))
      if (child.run.child.parentRunID !== input.parentRunID)
        return yield* Effect.fail(
          childMismatch(input, "The supplied parent does not match the child's immutable parent binding."),
        )
      return { parent: parent as DurableRun.SessionSnapshot, child }
    })

    const sessionExists = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, input: Input) {
      const row = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row)
        return yield* Effect.fail(invalid(input, "The child session does not exist in the durable Session store."))
    })

    const claim: Interface["claim"] = Effect.fn("SubagentControl.claim")(function* (input) {
      if (input.requestID !== input.subject.requestID)
        return yield* new SubagentControlClaim.InvalidClaimRequestError({
          reason: "The control subject requestID must match the sealed control request.",
        })
      const parentSnapshot = yield* durable.load(input.parentRunID)
      if (!("sessionID" in parentSnapshot.run))
        return yield* new SubagentControlClaim.InvalidClaimRequestError({
          reason: "Parent-scoped control claims require a SessionRun parent.",
        })
      if (terminal(parentSnapshot.run.status))
        return yield* new ControlClosedError({
          operation: input.operation,
          runID: parentSnapshot.run.id,
          status: parentSnapshot.run.status,
        })
      if (
        parentSnapshot.run.project !== input.subject.project ||
        String(parentSnapshot.run.location ?? "") !== String(input.subject.location)
      )
        return yield* new SubagentControlClaim.InvalidClaimRequestError({
          reason: "The control subject does not match the parent run location and project.",
        })
      const child = childSnapshot(yield* durable.load(input.childRunID))
      if (!child)
        return yield* new DurableRun.ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "Parent-scoped control claims require a SessionRun child binding.",
        })
      if (child.run.child.parentRunID !== input.parentRunID)
        return yield* new DurableRun.ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "The supplied parent does not match the child's immutable parent binding.",
        })
      if (child.run.sessionID !== input.sessionID)
        return yield* new SubagentControlClaim.InvalidClaimRequestError({
          reason: "The control request session does not match the immutable child session.",
        })
      // Observation and cancellation are safe to replay against an already
      // terminal child: wait returns the durable terminal snapshot and cancel
      // preserves the existing idempotent terminal result.  New steering or
      // follow-up inputs must still fail closed once the child is closed.
      if (terminal(child.run.status) && input.operation !== "wait" && input.operation !== "cancel")
        return yield* new ControlClosedError({
          operation: input.operation,
          runID: child.run.id,
          status: child.run.status,
        })

      if (input.operation === "steer" || input.operation === "followup") {
        if (!input.messageID || !input.promptDigest || !input.delivery)
          return yield* new SubagentControlClaim.InvalidClaimRequestError({
            reason: `${input.operation} claims require an admitted SessionInput message reference.`,
          })
        if (input.admission !== "pending") {
          const admitted = yield* SessionInput.find(db, input.messageID)
          if (
            !admitted ||
            admitted.sessionID !== input.sessionID ||
            admitted.delivery !== input.delivery ||
            canonicalHash(admitted.prompt) !== input.promptDigest
          )
            return yield* new SubagentControlClaim.InvalidClaimRequestError({
              reason: "The control claim does not match the durable SessionInput admission.",
            })
        }
      }

      let material: SubagentControlClaim.Material
      try {
        material = SubagentControlClaim.make(input)
      } catch (error) {
        if (error instanceof SubagentControlClaim.InvalidClaimRequestError) return yield* error
        return yield* new SubagentControlClaim.InvalidClaimRequestError({
          reason: "The control request could not be canonically sealed.",
        })
      }
      return yield* claims.claim(material.claim)
    })

    const wake = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
      if (execution) yield* execution.wake(sessionID)
    })

    const admit = Effect.fnUntraced(function* (input: SteerInput | FollowupInput, authorized: Authorized) {
      let prepared: PreparedInput
      try {
        prepared = prepare({
          operation: input.operation,
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          sessionID: authorized.child.run.sessionID,
          requestID: input.requestID,
          prompt: input.prompt,
        })
      } catch (error) {
        if (error instanceof InvalidRequestError) return yield* Effect.fail(error)
        return yield* Effect.fail(invalid(input, "The prompt failed strict schema normalization."))
      }
      yield* sessionExists(authorized.child.run.sessionID, input)
      const existing = yield* SessionInput.find(db, prepared.messageID)
      const expected = {
        sessionID: authorized.child.run.sessionID,
        messageID: prepared.messageID,
        prompt: prepared.prompt,
        delivery: prepared.delivery,
      }
      // The lease is checked again immediately before the inbox mutation. A
      // slow attachment normalization or database read must not turn an
      // expired parent lease into a valid steer/followup admission.
      yield* durable.validateLease({
        runID: input.parentRunID,
        leaseID: input.leaseID,
        ownerID: input.ownerID,
      })
      const admitted =
        existing ??
        (yield* SessionInput.admit(db, events, {
          id: prepared.messageID,
          sessionID: authorized.child.run.sessionID,
          prompt: prepared.prompt,
          delivery: prepared.delivery,
        }).pipe(
          Effect.catchDefect((defect) =>
            SessionInput.find(db, prepared.messageID).pipe(
              Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect))),
            ),
          ),
        ))
      if (!SessionInput.equivalent(admitted, expected))
        return yield* Effect.fail(
          new RequestConflictError({
            operation: input.operation,
            parentRunID: input.parentRunID,
            childRunID: input.childRunID,
            requestID: input.requestID,
            messageID: prepared.messageID,
            reason: "The request identity is already bound to a different prompt, session, or delivery mode.",
          }),
        )

      const envelopeWithoutDigest = {
        schemaVersion: 1 as const,
        operation: input.operation,
        requestID: input.requestID,
        messageID: prepared.messageID,
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
        sessionID: authorized.child.run.sessionID,
        delivery: prepared.delivery,
        promptDigest: prepared.promptDigest,
      }
      const envelopeDigest = canonicalHash(envelopeWithoutDigest)
      if (!envelopeDigest)
        return yield* Effect.fail(invalid(input, "The request envelope is not canonically hashable."))
      const request: RequestEnvelope = { ...envelopeWithoutDigest, envelopeDigest }

      // Admission is durable before provider dispatch.  A native provider
      // hook is only an accelerator: it receives the exact envelope identity
      // and digests, never prompt bytes.  Unsupported/unavailable/error paths
      // all fall back to the single durable SessionInput wakeup pipeline.
      let providerControlStatus: "accepted" | "unsupported" | "unavailable" | "error" | "not_requested" =
        "not_requested"
      const provider = Option.getOrUndefined(yield* Effect.serviceOption(SubagentProvider.Service))
      const providerEpoch = authorized.child.activeAttempt?.attempt
      let native: SubagentProvider.ParentMessageControlResult | undefined
      if (provider && providerEpoch !== undefined) {
        const nativeExit = yield* Effect.exit(
          provider.control({
            operation: input.operation,
            callerRunID: input.callerRunID,
            childParentRunID: input.parentRunID,
            childRunID: input.childRunID,
            executionID: input.childRunID,
            epoch: providerEpoch,
            requestID: input.requestID,
            messageID: prepared.messageID,
            promptDigest: prepared.promptDigest,
            envelopeDigest,
            delivery: prepared.delivery,
          }),
        )
        native = Exit.isSuccess(nativeExit) ? nativeExit.value : undefined
      }
      if (native) providerControlStatus = native.status
      else if (provider && providerEpoch !== undefined) providerControlStatus = "error"
      if (providerControlStatus !== "accepted") yield* wake(authorized.child.run.sessionID)
      RuntimeInsight.auditRecord({
        actor: authorized.parent.run.initiator,
        action: `subagent.control.${input.operation}.admitted`,
        resource: input.childRunID,
        reason: "Parent admitted a deterministic child-session input envelope",
        metadata: {
          schemaVersion: 1,
          operation: input.operation,
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          sessionID: authorized.child.run.sessionID,
          requestID: input.requestID,
          messageID: prepared.messageID,
          delivery: prepared.delivery,
          promptDigest: prepared.promptDigest,
          envelopeDigest,
          providerControlStatus,
        },
      })
      const fresh = childSnapshot(yield* durable.load(input.childRunID))
      if (!fresh) return yield* Effect.fail(childMismatch(input, "The child changed while admitting its input."))
      return {
        operation: input.operation,
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
        durable: fresh,
        timedOut: false,
        request,
        admitted,
      } satisfies Result
    })

    const waitDurable = Effect.fnUntraced(function* (input: WaitInput, initial: DurableRun.ChildSnapshot) {
      const timeoutMs = timeoutOrDefault(input.timeoutMs)
      if (terminal(initial.run.status) || timeoutMs === 0)
        return { snapshot: initial, timedOut: !terminal(initial.run.status) }
      const poll = Effect.gen(function* () {
        while (true) {
          const current = childSnapshot(yield* durable.load(input.childRunID))
          if (!current) return yield* Effect.fail(childMismatch(input, "The child binding disappeared during wait."))
          if (terminal(current.run.status)) return current
          yield* Effect.sleep(`${Math.min(250, Math.max(25, Math.floor(timeoutMs / 20)))} millis`)
        }
      })
      const completed = yield* poll.pipe(Effect.timeoutOption(timeoutMs))
      if (Option.isSome(completed)) return { snapshot: completed.value, timedOut: false }
      const current = childSnapshot(yield* durable.load(input.childRunID))
      if (!current) return yield* Effect.fail(childMismatch(input, "The child binding disappeared after wait timeout."))
      return { snapshot: current, timedOut: true }
    })

    const providerControlInput = (
      input: ParentLeaseInput,
      operation: "wait" | "cancel",
      timeoutMs: number,
    ): SubagentProvider.ParentWaitInput | SubagentProvider.ParentCancelInput => ({
      operation,
      callerRunID: input.callerRunID,
      childParentRunID: input.parentRunID,
      childRunID: input.childRunID,
      executionID: input.childRunID,
      timeoutMs,
    })

    const wait: Interface["wait"] = Effect.fn("SubagentControl.wait")(function* (input) {
      const authorized = yield* authorize(input)
      const timeoutMs = timeoutOrDefault(input.timeoutMs)
      const provider = Option.getOrUndefined(yield* Effect.serviceOption(SubagentProvider.Service))
      const providerResult = provider
        ? yield* provider.wait(providerControlInput(input, "wait", timeoutMs) as SubagentProvider.ParentWaitInput)
        : undefined
      const durableResult =
        providerResult?.timedOut === true
          ? { snapshot: authorized.child, timedOut: true }
          : yield* waitDurable(input, authorized.child)
      const timedOut = durableResult.timedOut || providerResult?.timedOut === true
      RuntimeInsight.auditRecord({
        actor: authorized.parent.run.initiator,
        action: "subagent.control.wait",
        resource: input.childRunID,
        reason: timedOut ? "Parent wait reached its bounded deadline" : "Parent observed child completion",
        metadata: {
          schemaVersion: 1,
          operation: "wait",
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          timeoutMs,
          timedOut,
          ...(providerResult?.snapshot
            ? { provider: providerResult.snapshot.provider, providerPhase: providerResult.snapshot.phase }
            : {}),
        },
      })
      return {
        operation: "wait",
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
        durable: durableResult.snapshot,
        timedOut,
        ...(providerResult?.snapshot ? { provider: providerResult.snapshot } : {}),
      } satisfies Result
    })

    const cancel: Interface["cancel"] = Effect.fn("SubagentControl.cancel")(function* (input) {
      return yield* controls.withLock(input.childRunID)(
        Effect.gen(function* () {
          const authorized = yield* authorize(input)
          if (terminal(authorized.child.run.status))
            return {
              operation: "cancel",
              parentRunID: input.parentRunID,
              childRunID: input.childRunID,
              durable: authorized.child,
              timedOut: false,
            } satisfies Result

          const timeoutMs = timeoutOrDefault(input.timeoutMs)
          const provider = Option.getOrUndefined(yield* Effect.serviceOption(SubagentProvider.Service))
          const providerResult = provider
            ? yield* provider.cancel(
                providerControlInput(input, "cancel", timeoutMs) as SubagentProvider.ParentCancelInput,
              )
            : undefined
          const providerUnknown =
            // Current user authority may have changed while Provider.cancel
            // was pending. Do not continue local effects under the old check.
            providerResult?.timedOut === true || providerResult?.snapshot?.phase === "outcome_unknown"
          yield* yield* CurrentCheck
          if (providerUnknown) {
            const current = childSnapshot(yield* durable.load(input.childRunID))
            if (!current)
              return yield* Effect.fail(childMismatch(input, "The child binding disappeared after provider timeout."))
            RuntimeInsight.auditRecord({
              actor: authorized.parent.run.initiator,
              action: "subagent.control.cancel.unknown",
              resource: input.childRunID,
              reason: "Provider cancellation timed out; durable child remains unreconciled",
              metadata: {
                schemaVersion: 1,
                operation: "cancel",
                parentRunID: input.parentRunID,
                childRunID: input.childRunID,
                timeoutMs,
                timedOut: true,
                providerPhase: providerResult?.snapshot?.phase,
              },
            })
            return {
              operation: "cancel",
              parentRunID: input.parentRunID,
              childRunID: input.childRunID,
              durable: current,
              timedOut: true,
              ...(providerResult?.snapshot ? { provider: providerResult.snapshot } : {}),
            } satisfies Result
          }

          // A provider that already completed/failed owns the outcome. Do not
          // overwrite it with a synthetic durable cancellation while its
          // normal result finalizer is racing to settle the child aggregate.
          if (providerResult?.snapshot && ["completed", "failed"].includes(providerResult.snapshot.phase)) {
            const current = childSnapshot(yield* durable.load(input.childRunID))
            if (!current)
              return yield* Effect.fail(
                childMismatch(input, "The child binding disappeared after provider completion."),
              )
            return {
              operation: "cancel",
              parentRunID: input.parentRunID,
              childRunID: input.childRunID,
              durable: current,
              timedOut: false,
              provider: providerResult.snapshot,
            } satisfies Result
          }

          // Re-check the parent's lease after any provider side effect. A
          // lease that expired during cancellation cannot authorize the
          // durable transition, even though the provider signal was sent.
          yield* durable.validateLease({
            runID: input.parentRunID,
            leaseID: input.leaseID,
            ownerID: input.ownerID,
          })
          const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
          // A provider service may be present while this child is running on
          // the legacy/local owner and therefore has no provider entry. In
          // that case the process-local execution owner still needs the
          // interrupt signal; only a provider snapshot proves it already
          // received one.
          if (execution && providerResult?.snapshot === undefined)
            yield* execution.interrupt(authorized.child.run.sessionID)
          yield* yield* CurrentCheck
          const cancelled = yield* durable.cancelChild({
            parentRunID: input.parentRunID,
            childRunID: input.childRunID,
            reason: input.reason,
            recursive: input.recursive,
          })
          RuntimeInsight.auditRecord({
            actor: authorized.parent.run.initiator,
            action: "subagent.control.cancelled",
            resource: input.childRunID,
            reason: "Direct parent durably cancelled child after provider outcome was known",
            metadata: {
              schemaVersion: 1,
              operation: "cancel",
              parentRunID: input.parentRunID,
              childRunID: input.childRunID,
              recursive: input.recursive !== false,
              timeoutMs,
              providerPhase: providerResult?.snapshot?.phase,
            },
          })
          return {
            operation: "cancel",
            parentRunID: input.parentRunID,
            childRunID: input.childRunID,
            durable: cancelled,
            timedOut: false,
            ...(providerResult?.snapshot ? { provider: providerResult.snapshot } : {}),
          } satisfies Result
        }),
      )
    })

    const steer: Interface["steer"] = Effect.fn("SubagentControl.steer")(function* (input) {
      return yield* controls.withLock(input.childRunID)(
        Effect.gen(function* () {
          const authorized = yield* authorize(input)
          if (terminal(authorized.child.run.status))
            return yield* Effect.fail(
              new ControlClosedError({
                operation: "steer",
                runID: authorized.child.run.id,
                status: authorized.child.run.status,
              }),
            )
          const requestError = validBoundedString(input.requestID, "requestID", 256)
          if (requestError) return yield* Effect.fail(invalid(input, requestError))
          return yield* admit(input, authorized)
        }),
      )
    })

    const followup: Interface["followup"] = Effect.fn("SubagentControl.followup")(function* (input) {
      return yield* controls.withLock(input.childRunID)(
        Effect.gen(function* () {
          const authorized = yield* authorize(input)
          if (terminal(authorized.child.run.status))
            return yield* Effect.fail(
              new ControlClosedError({
                operation: "followup",
                runID: authorized.child.run.id,
                status: authorized.child.run.status,
              }),
            )
          const requestError = validBoundedString(input.requestID, "requestID", 256)
          if (requestError) return yield* Effect.fail(invalid(input, requestError))
          return yield* admit(input, authorized)
        }),
      )
    })

    return Service.of({ claim, steer, followup, wait, cancel })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, DurableRun.node, ControlClaimIndex.node],
})
