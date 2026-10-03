export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@arforge-ai/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { PermissionSaved } from "./permission/saved"
import { PermissionV1 } from "./v1/permission"

export { Effect, Rule, Ruleset } from "@arforge-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

// Fields a caller may present to PermissionV2. The human-confirmation bit is
// intentionally absent: it is a trusted presentation fact derived only by
// this service from `forceAsk`, never caller metadata or input JSON.
const AssertRequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...AssertRequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
  /** Ignore configured/saved allow rules while preserving deny rules. Used for L3 actions that require confirmation now. */
  forceAsk: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

/**
 * Raised by the gateway-backed leaf gate when a tool requests an action or
 * resource scope outside its verified durable authorization grant. The
 * request never reaches the interactive permission service.
 */
export class ScopeEscalationError extends Error {
  override readonly name = "PermissionV2.ScopeEscalationError"

  constructor(
    readonly granted: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>,
    readonly requested: { readonly action: string; readonly resources: ReadonlyArray<string> },
  ) {
    super(
      `Tool execution requested a broader ${requested.action} scope than its durable authorization grant. ` +
        "The action was stopped before the expanded effect could run.",
    )
  }
}

export type Error = BlockedError | CorrectedError | ScopeEscalationError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

/** Maps persisted V1 session rules into the V2 evaluator without changing their order. */
export function fromV1Rules(rules: PermissionV1.Ruleset): Permission.Ruleset {
  return rules.map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

/**
 * Location services are intentionally scoped per request, but a pending
 * human approval must be visible to both the worker waiting in Authorizer and
 * the HTTP request that lists/replies to it. Share only the in-process waiter
 * registry for the exact location; durable Action state remains the source of
 * truth across a process restart.
 */
interface PendingRegistry {
  readonly pending: Map<ID, Pending>
  refs: number
}

const pendingRegistries = new Map<string, PendingRegistry>()

const pendingRegistryKey = (location: Location.Interface) =>
  JSON.stringify({
    directory: location.directory,
    workspaceID: location.workspaceID ?? null,
    projectID: location.project.id,
  })

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const registryKey = pendingRegistryKey(location)
    const registry = pendingRegistries.get(registryKey) ?? { pending: new Map<ID, Pending>(), refs: 0 }
    registry.refs += 1
    pendingRegistries.set(registryKey, registry)
    const pending = registry.pending

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.gen(function* () {
        registry.refs -= 1
        if (registry.refs > 0) return
        // Detach before yielding so a concurrently-created service cannot
        // attach to a registry whose finalizer is already closing it.
        pendingRegistries.delete(registryKey)
        yield* EffectRuntime.forEach(
          pending.values(),
          (item) => Deferred.fail(item.deferred, new DeclinedError()),
          { discard: true },
        )
        pending.clear()
      }),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      const agentRules = agent?.permissions ?? missingAgentPermissions
      const sessionRules = fromV1Rules((yield* sessions.permissions(sessionID)) ?? [])
      return { agentRules, sessionRules, all: [...agentRules, ...sessionRules] }
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      // Session rules intentionally come after agent rules for allow/ask overrides.
      // A deny effective within either source remains a hard boundary.
      if (denied(input, rules.agentRules) || denied(input, rules.sessionRules))
        return { effect: "deny" as const, rules: rules.all }
      const all = [...rules.all, ...(yield* savedRules())]
      if (input.forceAsk) return { effect: "ask" as const, rules: all }
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
        // This is deliberately derived inside the trusted permission service,
        // rather than inferred by a desktop client from tool name, metadata,
        // or a user-entered command. L3 gateway requests use forceAsk and
        // must remain visible even when a session is in full-access mode.
        ...(input.forceAsk ? { requiresHumanConfirmation: true } : {}),
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
           pending.set(request.id, item)
           yield* events
             .publish(Event.Asked, request, { location })
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") {
            return
          }
          const item = yield* create(request(input), input.agent)
          yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          // A forceAsk/L3 request is a one-time human decision. Normalize an
          // API client's forged `always` reply before publishing it, saving a
          // rule, or resolving other pending requests. The trusted bit only
          // originates from assert(forceAsk), never request metadata.
          const reply: Reply =
            existing.request.requiresHumanConfirmation && input.reply === "always" ? "once" : input.reply
           yield* events.publish(
             Event.Replied,
             {
               sessionID: existing.request.sessionID,
               requestID: existing.request.id,
               reply,
             },
             { location },
           )

          if (reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            // A reply decides one exact permission request. Rejecting a
            // direct-shell confirmation must not silently cancel unrelated
            // work in the same session; explicit session cancellation owns
            // that broader business operation.
            return
          }

          if (reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            // A remembered L2 allow never unlocks an L3 `forceAsk` request.
            // The trusted bit is held on the pending request, not inferred
            // from presentation metadata, so a concurrent direct shell stays
            // visible until its own explicit human decision.
            if (item.request.requiresHumanConfirmation) continue
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules.agentRules) || denied(input, rules.sessionRules)) continue
            const effective = [...rules.all, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
             yield* events.publish(
               Event.Replied,
               {
                 sessionID: item.request.sessionID,
                 requestID: item.request.id,
                 reply: "always",
               },
               { location },
             )
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
