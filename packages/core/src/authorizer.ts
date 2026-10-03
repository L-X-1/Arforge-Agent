export * as Authorizer from "./authorizer"

import { Cause, Context, Deferred, Effect, Layer, Schema } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionV2 } from "./session"
import { PermissionV2 } from "./permission"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { EventTable } from "./event/sql"
import { AgentV2 } from "./agent"
import { makeLocationNode } from "./effect/app-node"
import { DurableAction } from "./runtime/durable-action"
import { DurableRun } from "./runtime/durable-run"
import { and, eq, inArray } from "drizzle-orm"

export type AssertInput = {
  readonly subject: AgentRuntime.Subject
  readonly action: string
  readonly resources: ReadonlyArray<string>
  /**
   * Trusted durable identity injected by the ActionGateway for control-plane
   * requests. It is deliberately separate from caller metadata: metadata is
   * presentation context and can never select or merge an approval.
   *
   * Session assertions retain their legacy contract and ignore this value.
   */
  readonly binding?: {
    readonly actionID: AgentRuntime.ActionID
    readonly intentDigest: string
    /** Current policy revision supplied by the ActionGateway. */
    readonly policyVersion?: string
  }
  readonly save?: ReadonlyArray<string>
  /**
   * Untrusted presentation data for legacy session permissions. Control-plane
   * approvals deliberately never publish caller metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly source?: PermissionV2.Source
  readonly forceAsk?: boolean
}

export type ReplyInput = {
  readonly requestID: PermissionV2.ID
  readonly reply: PermissionV2.Reply
  readonly message?: string
}

/** A pending approval request as seen through the Authorizer: either the legacy session request or a control-plane request. */
export type PendingRequest = PermissionV2.Request | AgentRuntime.ControlRequest

/**
 * Trusted authorization boundary behind the ActionGateway. The gateway never
 * talks to PermissionV2 directly; it evaluates every L2/L3 preflight through
 * this service.
 *
 * - Session subjects delegate to PermissionV2 unchanged: the session adapter
 *   preserves the exact legacy rule evaluation, pending request, reply, and
 *   saved-allow semantics. PermissionV2 remains the pure session subject
 *   implementation with its original contract.
 * - Control-plane subjects run the A1 control adapter on the dedicated
 *   ControlRequest contract: no session or agent rules are read, no saved
 *   allow rules are consulted, and every request is a fresh human ask
 *   resolved only by an explicit reply by requestID. No caller-supplied
 *   boolean or Effect can ever represent authorization — only the Authorizer
 *   sealed grant/capability advances an action.
 *
 * Authorization is never an event: published events are audit/UI input only.
 */
export interface Interface {
  readonly assert: (input: AssertInput) => Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, PermissionV2.NotFoundError>
  readonly get: (requestID: PermissionV2.ID) => Effect.Effect<PendingRequest | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<PendingRequest>>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Authorizer") {}

interface Pending {
  readonly request: AgentRuntime.ControlRequest
  /** The non-presentation identity that owns this pending approval. */
  readonly key: string
  readonly binding: NonNullable<AssertInput["binding"]>
  /** Durable asks can be rebuilt without the original in-memory waiter. */
  readonly durable: boolean
  readonly deferred: Deferred.Deferred<void, PermissionV2.DeclinedError | PermissionV2.CorrectedError>
}

type DurableControlReply = EventV2.Data<typeof AgentRuntime.ControlEvent.Replied>

type DurableControlSnapshot = {
  readonly requests: ReadonlyArray<AgentRuntime.ControlRequest>
  readonly replies: ReadonlyMap<PermissionV2.ID, DurableControlReply>
}

const canonicalResources = (resources: ReadonlyArray<string>) => [...new Set(resources)].sort()

/**
 * A pending approval is shared only by the exact durable action it represents.
 * The complete control subject is intentionally included even though the
 * current A1 actor set has one member: widening that schema in a later phase
 * must not silently weaken approval isolation.
 */
const controlPendingKey = (
  subject: AgentRuntime.ControlPlaneSubject,
  action: string,
  resources: ReadonlyArray<string>,
  binding: NonNullable<AssertInput["binding"]>,
) =>
  JSON.stringify({
    subject: {
      type: subject.type,
      location: subject.location,
      project: subject.project,
      actor: subject.actor,
      principalRef: subject.principalRef,
      id: subject.id,
      requestID: subject.requestID,
    },
    action,
    resources: canonicalResources(resources),
    actionID: binding.actionID,
    intentDigest: binding.intentDigest,
    policyVersion: binding.policyVersion,
  })

/**
 * Control requests are published to the audit and approval surfaces. Their
 * metadata must therefore be a small, trusted display contract, never caller
 * presentation data that might contain credentials or unrelated payloads.
 */
const controlMetadata = (binding: NonNullable<AssertInput["binding"]>) => ({
  actionID: binding.actionID,
  intentDigest: binding.intentDigest,
})

const sameControlSubject = (left: AgentRuntime.ControlPlaneSubject, right: AgentRuntime.ControlPlaneSubject) =>
  left.id === right.id &&
  left.location === right.location &&
  left.project === right.project &&
  left.actor === right.actor &&
  left.principalRef === right.principalRef &&
  left.requestID === right.requestID

const sameResources = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  JSON.stringify(canonicalResources(left)) === JSON.stringify(canonicalResources(right))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const permissions = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const durableActions = yield* DurableAction.Service
    const durableRuns = yield* DurableRun.Service
    const controlPending = new Map<PermissionV2.ID, Pending>()
    const retiredControlRequests = new Set<PermissionV2.ID>()
    const askedType = EventV2.versionedType(AgentRuntime.ControlEvent.Asked.type, 1)
    const repliedType = EventV2.versionedType(AgentRuntime.ControlEvent.Replied.type, 1)

    /**
     * Control approval events are durable projections, not credentials. The
     * ActionGateway still validates the loaded Action/Run and is the only
     * component that can mint a grant. This reader lets a fresh HTTP/location
     * service instance discover the same open request and append a reply to
     * the request aggregate.
     */
    const readDurableControlSnapshot = Effect.fnUntraced(function* () {
      const rows = yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(inArray(EventTable.type, [askedType, repliedType]))
        .all()
        .pipe(Effect.orDie)
      const requests = new Map<PermissionV2.ID, AgentRuntime.ControlRequest>()
      const replies = new Map<PermissionV2.ID, DurableControlReply>()
      for (const row of rows) {
        try {
          if (row.type === askedType) {
            const request = Schema.decodeUnknownSync(AgentRuntime.ControlEvent.Asked.data)(row.data)
            requests.set(request.id, request)
          } else if (row.type === repliedType) {
            const reply = Schema.decodeUnknownSync(AgentRuntime.ControlEvent.Replied.data)(row.data)
            replies.set(reply.requestID, reply)
          }
        } catch {
          // A malformed event is never promoted into a pending approval. The
          // durable event audit/replay path remains responsible for surfacing
          // the corruption; this projection fails closed.
        }
      }
      return { requests: Array.from(requests.values()), replies } satisfies DurableControlSnapshot
    })

    const bindingFromDurableRequest = (request: AgentRuntime.ControlRequest) => {
      const metadata = request.metadata
      if (!metadata) return undefined
      const actionID = metadata.actionID
      const intentDigest = metadata.intentDigest
      if (
        typeof actionID !== "string" ||
        !actionID.startsWith("act_") ||
        typeof intentDigest !== "string" ||
        intentDigest.length === 0
      )
        return undefined
      return {
        actionID: AgentRuntime.ActionID.make(actionID),
        intentDigest,
      } satisfies NonNullable<AssertInput["binding"]>
    }

    const durablePending = Effect.fnUntraced(function* (request: AgentRuntime.ControlRequest) {
      const parsedBinding = bindingFromDurableRequest(request)
      if (!parsedBinding) return undefined
      const action = yield* durableActions.load(parsedBinding.actionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const policyVersion = action?.policyDecision?.policyVersion
      const binding =
        typeof policyVersion === "string" && policyVersion.length > 0
          ? { ...parsedBinding, policyVersion }
          : parsedBinding
      const deferred = yield* Deferred.make<void, PermissionV2.DeclinedError | PermissionV2.CorrectedError>()
      return {
        request,
        key: controlPendingKey(request.subject, request.action, request.resources, binding),
        binding,
        durable: true as boolean,
        deferred,
      } satisfies Pending
    })

    const readDurablePending = Effect.fnUntraced(function* () {
      const snapshot = yield* readDurableControlSnapshot()
      const pending = yield* Effect.forEach(
        snapshot.requests.filter((request) => !snapshot.replies.has(request.id)),
        durablePending,
      ).pipe(Effect.map((items) => items.filter((item): item is Pending => item !== undefined)))
      // An interrupted/rebuilt waiter may have left an older Asked event in
      // the append-only projection. Only the newest unresolved ask for an
      // exact durable action/binding is actionable; otherwise a UI or HTTP
      // caller could reply to a stale request while the gateway waits on the
      // re-presented request.
      const latest = new Map<string, Pending>()
      for (const item of pending) latest.set(item.key, item)
      return [...latest.values()]
    })

    const readDurablePendingByID = Effect.fnUntraced(function* (requestID: PermissionV2.ID) {
      const pending = (yield* readDurablePending()).find((item) => item.request.id === requestID)
      return pending
    })

    const readDurableControlReply = Effect.fnUntraced(function* (requestID: PermissionV2.ID) {
      const row = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, requestID), eq(EventTable.type, repliedType)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      try {
        return Schema.decodeUnknownSync(AgentRuntime.ControlEvent.Replied.data)(row.data)
      } catch {
        return undefined
      }
    })

    /**
     * An in-memory ask is only a live waiter. Before it can be displayed or
     * replied to, the production gateway binding must still point at the
     * exact durable Action and ControlRun that created it. The later
     * ActionGateway CAS remains the final grant boundary for races.
     */
    const isDurableControlApproval = Effect.fnUntraced(function* (pending: Pending) {
      const binding = pending.binding
      // Direct Authorizer tests and legacy callers may omit the gateway
      // policy revision. Real control requests always receive it from the
      // ActionGateway and therefore take the strict durable path below.
      if (!pending.durable && !binding.policyVersion) return true
      const action = yield* durableActions.load(binding.actionID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!action || action.action.status !== "awaiting_approval") {
        return false
      }
      const actionSubject = action.action.subject
      if (
        action.action.authority !== "human" ||
        action.action.intentDigest !== binding.intentDigest ||
        action.action.name !== pending.request.action ||
        !sameResources(action.action.resources, pending.request.resources) ||
        actionSubject?.type !== "control-plane" ||
        !actionSubject ||
        !sameControlSubject(actionSubject, pending.request.subject)
      )
      if (
        action.action.authority !== "human" ||
        action.action.intentDigest !== binding.intentDigest ||
        action.action.name !== pending.request.action ||
        !sameResources(action.action.resources, pending.request.resources) ||
        actionSubject?.type !== "control-plane" ||
        !actionSubject ||
        !sameControlSubject(actionSubject, pending.request.subject)
      )
        return false
      const decision = action.policyDecision
      if (
        !decision ||
        decision.actionID !== action.action.id ||
        decision.subject?.type !== "control-plane" ||
        !sameControlSubject(decision.subject, pending.request.subject) ||
        decision.authority !== action.action.authority ||
        decision.riskTier !== action.action.riskTier ||
        decision.decision !== "ask"
      )
      if (
        !decision ||
        decision.actionID !== action.action.id ||
        decision.subject?.type !== "control-plane" ||
        !sameControlSubject(decision.subject, pending.request.subject) ||
        decision.authority !== action.action.authority ||
        decision.riskTier !== action.action.riskTier ||
        decision.decision !== "ask"
      )
        return false
      const policyVersion = binding.policyVersion ?? decision.policyVersion
      if (!policyVersion || decision.policyVersion !== policyVersion) return false
      // Standalone control actions (for example an MCP connect outside a
      // ControlRun) still receive the durable Action/policy checks above, but
      // have no Run aggregate to cross-check.
      if (!action.action.runID) return true
      const run = yield* durableRuns.load(action.action.runID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!run || !("subject" in run.run) || run.run.status !== "awaiting_authorization") return false
      return (
        sameControlSubject(run.run.subject, pending.request.subject) &&
        run.run.operation.actionID === action.action.id &&
        run.run.operation.policyVersion === policyVersion
      )
    })

    const waitForDurableControlReply = Effect.fnUntraced(function* (requestID: PermissionV2.ID) {
      while (true) {
        const reply = yield* readDurableControlReply(requestID)
        if (reply) {
          if (reply.reply === "reject") {
            return yield* reply.message
              ? new PermissionV2.CorrectedError({ feedback: reply.message })
              : new PermissionV2.DeclinedError()
          }
          return
        }
        yield* Effect.sleep("50 millis")
      }
    })

    const isAggregateSequenceConflict = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) => Cause.isDieReason(reason) && reason.defect instanceof EventV2.AggregateSequenceConflictError,
      )

    const publishControlReply = (pending: Pending, input: ReplyInput): Effect.Effect<void, PermissionV2.NotFoundError> => {
      const data = {
        subject: pending.request.subject,
        requestID: input.requestID,
        reply: input.reply,
        ...(input.message ? { message: input.message } : {}),
      }
      return Effect.gen(function* () {
        const published = events
          .publish(AgentRuntime.ControlEvent.Replied, data, { expectedSequence: 0 })
          .pipe(
            Effect.catchCauseIf(isAggregateSequenceConflict, (): Effect.Effect<void, PermissionV2.NotFoundError> =>
              Effect.gen(function* () {
                const existing = (yield* readDurableControlSnapshot()).replies.get(input.requestID)
                if (
                  existing &&
                  existing.reply === input.reply &&
                  sameControlSubject(existing.subject, pending.request.subject)
                )
                  return
                return yield* new PermissionV2.NotFoundError({ requestID: input.requestID })
              }),
            ),
          ) as Effect.Effect<unknown, PermissionV2.NotFoundError>
        yield* published
      })
    }

    /**
     * A cancellation/supersession can win after the ask was published. Retire
     * that stale waiter as part of the projection read so it cannot keep a
     * worker alive until the next periodic recovery pass.
     */
    const activeControlApproval = Effect.fnUntraced(function* (pending: Pending) {
      const active = yield* isDurableControlApproval(pending)
      if (active) return true
      controlPending.delete(pending.request.id)
      retiredControlRequests.add(pending.request.id)
      yield* Deferred.fail(pending.deferred, new PermissionV2.DeclinedError())
      return false
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        controlPending.values(),
        (item) => Deferred.fail(item.deferred, new PermissionV2.DeclinedError()),
        {
          discard: true,
        },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            controlPending.clear()
            retiredControlRequests.clear()
          }),
        ),
      ),
    )

    const sessionAssert = Effect.fn("Authorizer.sessionAssert")(function* (input: AssertInput) {
      if (input.subject.type !== "session") return yield* Effect.die(new Error("Expected a session subject"))
      return yield* permissions.assert({
        sessionID: input.subject.sessionID,
        ...(input.subject.agent ? { agent: AgentV2.ID.make(input.subject.agent) } : {}),
        action: input.action,
        resources: [...input.resources],
        ...(input.save ? { save: [...input.save] } : {}),
        ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.forceAsk ? { forceAsk: true } : {}),
      })
    })

    const controlAssert = Effect.fn("Authorizer.controlAssert")(function* (input: AssertInput) {
      if (input.subject.type !== "control-plane")
        return yield* Effect.die(new Error("Expected a control-plane subject"))
      const controlSubject = input.subject
      const binding = input.binding
      if (
        !binding ||
        typeof binding.actionID !== "string" ||
        !binding.actionID.startsWith("act_") ||
        typeof binding.intentDigest !== "string" ||
        binding.intentDigest.length === 0
      )
        return yield* Effect.die(new Error("A control-plane authorization requires a gateway action binding."))
      // The control-plane subject has no session or agent rule sources and
      // never consults saved allow rules: every request is a fresh human ask.
      // A1 opens L3 human only; the gateway rejects other tiers before this.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Re-presenting the same durable control-plane action reuses the
          // same pending request identity: an awaiting-approval action that
          // survives a runtime rebuild binds its fresh attempt to the ask it
          // already owns, so no duplicate pending request is ever stacked.
          // Every action, scope, subject, and durable intent dimension must
          // match exactly; otherwise it is a distinct human decision.
          const key = controlPendingKey(controlSubject, input.action, input.resources, binding)
          const existing = Array.from(controlPending.values()).find((item) => item.key === key)
          if (existing) {
            yield* restore(Deferred.await(existing.deferred)).pipe(
              Effect.catchTag("PermissionV2.DeclinedError", (error) => Effect.die(error)),
            )
            return
          }
          const recovered = (yield* readDurablePending()).find((item) => item.key === key)
          if (recovered && (yield* isDurableControlApproval(recovered))) {
            // A durable Asked event is evidence that an approval existed, not
            // a live waiter. Re-present it with a fresh request ID while
            // preserving the exact control subject/action/binding. This makes
            // an interrupted worker's approval recoverable without allowing a
            // stale UI reply to resolve the new waiter.
            const request = AgentRuntime.ControlRequest.make({
              id: PermissionV2.ID.create(),
              subject: recovered.request.subject,
              action: recovered.request.action,
              resources: canonicalResources(recovered.request.resources),
              metadata: controlMetadata(recovered.binding),
            })
            const deferred = yield* Deferred.make<void, PermissionV2.DeclinedError | PermissionV2.CorrectedError>()
            const rePresented: Pending = {
              request,
              key: recovered.key,
              binding: recovered.binding,
              durable: true,
              deferred,
            }
            controlPending.set(request.id, rePresented)
            yield* events.publish(AgentRuntime.ControlEvent.Asked, request).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  controlPending.delete(request.id)
                }),
              ),
            )
            yield* restore(Effect.raceFirst(Deferred.await(deferred), waitForDurableControlReply(request.id))).pipe(
              Effect.catchTag("PermissionV2.DeclinedError", (error) => Effect.die(error)),
              Effect.ensuring(
                Effect.sync(() => {
                  controlPending.delete(request.id)
                }),
              ),
            )
            return
          }
          const request = AgentRuntime.ControlRequest.make({
            id: PermissionV2.ID.create(),
            subject: controlSubject,
            action: input.action,
            resources: canonicalResources(input.resources),
            metadata: controlMetadata(binding),
          })
          const deferred = yield* Deferred.make<void, PermissionV2.DeclinedError | PermissionV2.CorrectedError>()
          controlPending.set(request.id, {
            request,
            key,
            binding,
            durable: Boolean(binding.policyVersion),
            deferred,
          })
          yield* events.publish(AgentRuntime.ControlEvent.Asked, request).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                controlPending.delete(request.id)
              }),
            ),
          )
          yield* restore(Effect.raceFirst(Deferred.await(deferred), waitForDurableControlReply(request.id))).pipe(
            Effect.catchTag("PermissionV2.DeclinedError", (error) => Effect.die(error)),
            Effect.ensuring(
              Effect.sync(() => {
                controlPending.delete(request.id)
              }),
            ),
          )
        }),
      )
    })

    const assert = Effect.fn("Authorizer.assert")(function* (input: AssertInput) {
      return yield* input.subject.type === "session" ? sessionAssert(input) : controlAssert(input)
    })

    const controlReply = (input: ReplyInput, recovered?: Pending): Effect.Effect<void, PermissionV2.NotFoundError> =>
      Effect.gen(function* () {
        const existing = controlPending.get(input.requestID) ?? recovered
        if (!existing) {
          retiredControlRequests.delete(input.requestID)
          return yield* new PermissionV2.NotFoundError({ requestID: input.requestID })
        }
        if (!(yield* activeControlApproval(existing)))
          return yield* new PermissionV2.NotFoundError({ requestID: input.requestID })
        yield* publishControlReply(existing, input)
        if (input.reply === "reject") {
          yield* Deferred.fail(
            existing.deferred,
            input.message
              ? new PermissionV2.CorrectedError({ feedback: input.message })
              : new PermissionV2.DeclinedError(),
          )
          controlPending.delete(input.requestID)
          return
        }
        // "once" and "always" both resolve this request. Control-plane replies
        // never write PermissionSaved rules, so a saved allow can never skip a
        // future confirmation.
        yield* Deferred.succeed(existing.deferred, undefined)
        controlPending.delete(input.requestID)
      })

    const reply = Effect.fn("Authorizer.reply")(function* (input: ReplyInput) {
      const pending = controlPending.get(input.requestID)
      if (pending || retiredControlRequests.has(input.requestID)) return yield* controlReply(input)
      const recovered = yield* readDurablePendingByID(input.requestID)
      if (recovered) return yield* controlReply(input, recovered)
      return yield* permissions.reply({
        requestID: input.requestID,
        reply: input.reply,
        ...(input.message ? { message: input.message } : {}),
      })
    })

    const get = Effect.fn("Authorizer.get")(function* (requestID: PermissionV2.ID) {
      const control = controlPending.get(requestID)
      if (control) return (yield* activeControlApproval(control)) ? control.request : undefined
      const recovered = yield* readDurablePendingByID(requestID)
      if (recovered) return (yield* activeControlApproval(recovered)) ? recovered.request : undefined
      return yield* permissions.get(requestID)
    })

    const list = Effect.fn("Authorizer.list")(function* () {
      const recovered = yield* readDurablePending()
      const inMemoryIDs = new Set(controlPending.keys())
      const controls = yield* Effect.forEach(controlPending.values(), (item) =>
        activeControlApproval(item).pipe(Effect.map((valid) => (valid ? item.request : undefined))),
      )
      const durableControls = yield* Effect.forEach(
        recovered.filter((item) => !inMemoryIDs.has(item.request.id)),
        (item) => activeControlApproval(item).pipe(Effect.map((valid) => (valid ? item.request : undefined))),
      )
      return [
        ...(yield* permissions.list()),
        ...controls.filter((item): item is AgentRuntime.ControlRequest => item !== undefined),
        ...durableControls.filter((item): item is AgentRuntime.ControlRequest => item !== undefined),
      ]
    })

    return Service.of({ assert, reply, get, list })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PermissionV2.node, EventV2.node, Database.node, DurableAction.node, DurableRun.node],
})
