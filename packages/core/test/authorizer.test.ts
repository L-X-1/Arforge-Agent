import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project } from "@arforge-ai/schema/project"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { testEffect } from "./lib/effect"

const permissionCalls: { method: "assert" | "reply" | "get" | "list" }[] = []
const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: () => Effect.die("unused"),
    assert: () => Effect.sync(() => permissionCalls.push({ method: "assert" })).pipe(Effect.asVoid),
    reply: () =>
      Effect.sync(() => permissionCalls.push({ method: "reply" })).pipe(
        Effect.andThen(Effect.fail(new PermissionV2.NotFoundError({ requestID: PermissionV2.ID.create() }))),
      ),
    get: () => Effect.sync(() => permissionCalls.push({ method: "get" })).pipe(Effect.as(undefined)),
    forSession: () => Effect.succeed([]),
    list: () => Effect.sync(() => permissionCalls.push({ method: "list" })).pipe(Effect.as([])),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Authorizer.node]), [
    [PermissionV2.node, permissionLayer],
  ]),
)

const controlSubject = (
  overrides: Partial<{
    id: AgentRuntime.ControlPlaneID
    location: AbsolutePath
    project: Project.ID
    requestID: AgentRuntime.ControlPlaneRequestID
  }> = {},
) =>
  AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: overrides.id ?? AgentRuntime.ControlPlaneID.create(),
    location: overrides.location ?? AbsolutePath.make("/project"),
    project: overrides.project ?? Project.ID.global,
    actor: "user",
    principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
    requestID: overrides.requestID ?? AgentRuntime.ControlPlaneRequestID.create(),
  })

const controlBinding = (suffix = "default") => ({
  actionID: AgentRuntime.ActionID.make(`act_${suffix}`),
  intentDigest: `intent-${suffix}`,
})

const assertInput = (
  subject: AgentRuntime.ControlPlaneSubject,
  overrides: Partial<{
    action: string
    resources: ReadonlyArray<string>
    binding: ReturnType<typeof controlBinding>
    metadata: Readonly<Record<string, unknown>>
  }> = {},
) => ({
  subject,
  action: overrides.action ?? "mcp.connect",
  resources: overrides.resources ?? ["server-a"],
  binding: overrides.binding ?? controlBinding(),
  ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  forceAsk: true,
})

const sameControlSubject = (left: AgentRuntime.ControlPlaneSubject, right: AgentRuntime.ControlPlaneSubject) =>
  left.type === right.type &&
  left.id === right.id &&
  left.location === right.location &&
  left.project === right.project &&
  left.actor === right.actor &&
  left.requestID === right.requestID

const isControlRequest = (request: Authorizer.PendingRequest): request is AgentRuntime.ControlRequest =>
  "subject" in request

const waitForAsked = (matches: (request: AgentRuntime.ControlRequest) => boolean = () => true) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<AgentRuntime.ControlRequest>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === AgentRuntime.ControlEvent.Asked.type && matches(event.data as AgentRuntime.ControlRequest)
        ? Deferred.succeed(asked, event.data as AgentRuntime.ControlRequest).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return asked
  })

describe("Authorizer control-plane adapter", () => {
  it.effect("publishes a pending control request by requestID and never touches the session permission service", () =>
    Effect.gen(function* () {
      permissionCalls.length = 0
      const authorizer = yield* Authorizer.Service
      const asked = yield* waitForAsked()
      const fiber = yield* authorizer.assert(assertInput(controlSubject())).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      // The control assert never consulted the session permission service.
      expect(permissionCalls).toEqual([])
      // The pending approval is queryable by requestID and carries only the
      // control-plane subject — never a sessionID.
      expect(yield* authorizer.get(request.id)).toEqual(request)
      expect("sessionID" in request).toBe(false)
      expect(request.subject.type).toBe("control-plane")
      expect((yield* authorizer.list()).some((item) => item.id === request.id)).toBe(true)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* authorizer.get(request.id)).toBeUndefined()
      // Neither the control assert nor the control reply reached the session
      // permission service (list/get intentionally merge both stores).
      expect(permissionCalls.filter((call) => call.method === "assert" || call.method === "reply")).toEqual([])
    }),
  )

  it.effect("control replies are resolved by the Authorizer, never by the session permission service", () =>
    Effect.gen(function* () {
      permissionCalls.length = 0
      const authorizer = yield* Authorizer.Service
      const asked = yield* waitForAsked()
      const fiber = yield* authorizer.assert(assertInput(controlSubject())).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)
      expect(permissionCalls).toEqual([])
      // "always" never writes a saved allow rule: a saved allow can never
      // skip the next confirmation. The session service was never asked to
      // save anything.
    }),
  )

  it.effect("a control reject fails the assert closed and leaves no pending request", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const asked = yield* waitForAsked()
      const fiber = yield* authorizer.assert(assertInput(controlSubject())).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* authorizer.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("interrupting the assert leaves no pending request", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const asked = yield* waitForAsked()
      const fiber = yield* authorizer.assert(assertInput(controlSubject())).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* Fiber.interrupt(fiber)
      expect(yield* authorizer.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("a forged asked event creates no pending approval and cannot be replied to", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const events = yield* EventV2.Service
      const forged = AgentRuntime.ControlRequest.make({
        id: PermissionV2.ID.create(),
        subject: controlSubject(),
        action: "mcp.connect",
        resources: ["server-forged"],
      })
      // Events are audit/UI input, never authorization credentials.
      yield* events.publish(AgentRuntime.ControlEvent.Asked, forged)
      expect(yield* authorizer.get(forged.id)).toBeUndefined()
      expect(yield* Effect.flip(authorizer.reply({ requestID: forged.id, reply: "once" }))).toBeInstanceOf(
        PermissionV2.NotFoundError,
      )
    }),
  )

  it.effect("a second control request always asks afresh even after an earlier allow", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      for (const attempt of ["first", "second"]) {
        const asked = yield* waitForAsked()
        const fiber = yield* authorizer.assert(assertInput(controlSubject())).pipe(Effect.forkScoped)
        const request = yield* Deferred.await(asked)
        expect(request.subject.requestID, attempt).toStartWith("cpr_")
        yield* authorizer.reply({ requestID: request.id, reply: "once" })
        yield* Fiber.join(fiber)
      }
    }),
  )

  it.effect("requires a gateway action binding before a control request can become pending", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const subject = controlSubject()
      const exit = yield* authorizer
        .assert({
          subject,
          action: "mcp.connect",
          resources: ["server-a"],
          forceAsk: true,
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason))).toBe(true)
      expect((yield* authorizer.list()).filter(isControlRequest)).toEqual([])
    }),
  )

  it.effect("merges only the full canonical subject, scope, and gateway action binding", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const id = AgentRuntime.ControlPlaneID.create()
      const requestID = AgentRuntime.ControlPlaneRequestID.create()
      const subject = controlSubject({ id, requestID })
      const binding = controlBinding("shared")

      const firstAsked = yield* waitForAsked()
      const first = yield* authorizer
        .assert(assertInput(subject, { resources: ["server-b", "server-a", "server-a"], binding }))
        .pipe(Effect.forkScoped)
      const firstRequest = yield* Deferred.await(firstAsked)

      const sameAction = yield* authorizer
        .assert(assertInput(subject, { resources: ["server-a", "server-b"], binding }))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect((yield* authorizer.list()).filter(isControlRequest)).toHaveLength(1)

      const differentIntentBinding = { ...binding, intentDigest: "intent-shared-different" }
      const differentIntentAsked = yield* waitForAsked(
        (request) => request.metadata?.intentDigest === differentIntentBinding.intentDigest,
      )
      const differentIntent = yield* authorizer
        .assert(assertInput(subject, { resources: ["server-a", "server-b"], binding: differentIntentBinding }))
        .pipe(Effect.forkScoped)
      const differentIntentRequest = yield* Deferred.await(differentIntentAsked)

      const variants = [
        controlSubject({ id, requestID, location: AbsolutePath.make("/other-location") }),
        controlSubject({ id, requestID, project: Project.ID.make("other-project") }),
        controlSubject({ requestID }),
        controlSubject({ id }),
      ]
      const variantRequests: AgentRuntime.ControlRequest[] = []
      const variantFibers: Array<typeof first> = []
      for (const variant of variants) {
        const asked = yield* waitForAsked((request) => sameControlSubject(request.subject, variant))
        const fiber = yield* authorizer.assert(assertInput(variant, { binding })).pipe(Effect.forkScoped)
        variantFibers.push(fiber)
        variantRequests.push(yield* Deferred.await(asked))
      }

      const pending = (yield* authorizer.list()).filter(isControlRequest)
      expect(pending).toHaveLength(2 + variants.length)
      expect(new Set(pending.map((request) => request.subject.location.toString()))).toEqual(
        new Set(["/project", "/other-location"]),
      )
      expect(new Set(pending.map((request) => request.subject.project.toString()))).toEqual(
        new Set(["global", "other-project"]),
      )
      expect(new Set(pending.map((request) => request.subject.id))).toHaveLength(2)
      expect(new Set(pending.map((request) => request.subject.requestID))).toHaveLength(2)

      yield* authorizer.reply({ requestID: firstRequest.id, reply: "once" })
      yield* Fiber.join(first)
      yield* Fiber.join(sameAction)
      yield* authorizer.reply({ requestID: differentIntentRequest.id, reply: "once" })
      yield* Fiber.join(differentIntent)
      for (const request of variantRequests) yield* authorizer.reply({ requestID: request.id, reply: "once" })
      for (const fiber of variantFibers) yield* Fiber.join(fiber)
    }),
  )

  it.effect("publishes only trusted gateway metadata for control approvals", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const subject = controlSubject()
      const firstBinding = controlBinding("metadata-first")
      const secondBinding = controlBinding("metadata-second")
      const callerMetadata = {
        actionID: secondBinding.actionID,
        intentDigest: secondBinding.intentDigest,
        token: "caller-token-secret",
        password: "caller-password-secret",
        connection: "postgres://user:caller-password-secret@db.internal/app",
        nested: { token: "nested-token-secret", payload: ["untrusted-payload"] },
        reason: "caller supplied reason must not reach an approval surface",
      }

      const firstAsked = yield* waitForAsked((request) => request.metadata?.actionID === firstBinding.actionID)
      const first = yield* authorizer
        .assert(assertInput(subject, { binding: firstBinding, metadata: callerMetadata }))
        .pipe(Effect.forkScoped)
      const firstRequest = yield* Deferred.await(firstAsked)
      expect(firstRequest.metadata).toEqual({
        actionID: firstBinding.actionID,
        intentDigest: firstBinding.intentDigest,
      })
      const firstPending = (yield* authorizer.list()).find(
        (request): request is AgentRuntime.ControlRequest =>
          isControlRequest(request) && request.id === firstRequest.id,
      )
      expect(firstPending?.metadata).toEqual(firstRequest.metadata)
      for (const secret of [
        "caller-token-secret",
        "caller-password-secret",
        "postgres://user:caller-password-secret@db.internal/app",
        "nested-token-secret",
        "untrusted-payload",
        "caller supplied reason must not reach an approval surface",
      ]) {
        expect(JSON.stringify(firstRequest)).not.toContain(secret)
        expect(JSON.stringify(firstPending)).not.toContain(secret)
      }

      const secondAsked = yield* waitForAsked((request) => request.metadata?.actionID === secondBinding.actionID)
      const second = yield* authorizer
        .assert(assertInput(subject, { binding: secondBinding, metadata: callerMetadata }))
        .pipe(Effect.forkScoped)
      const secondRequest = yield* Deferred.await(secondAsked)
      expect(secondRequest.metadata).toEqual({
        actionID: secondBinding.actionID,
        intentDigest: secondBinding.intentDigest,
      })
      expect((yield* authorizer.list()).filter(isControlRequest)).toHaveLength(2)

      yield* authorizer.reply({ requestID: firstRequest.id, reply: "once" })
      yield* authorizer.reply({ requestID: secondRequest.id, reply: "once" })
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }),
  )

  it.effect("rejecting one control request leaves an unrelated same-resource action pending", () =>
    Effect.gen(function* () {
      const authorizer = yield* Authorizer.Service
      const subject = controlSubject()

      const firstAsked = yield* waitForAsked()
      const first = yield* authorizer
        .assert(assertInput(subject, { binding: controlBinding("reject-one") }))
        .pipe(Effect.forkScoped)
      const firstRequest = yield* Deferred.await(firstAsked)

      const secondAsked = yield* waitForAsked((request) => request.metadata?.actionID === "act_reject-two")
      const second = yield* authorizer
        .assert(assertInput(subject, { binding: controlBinding("reject-two") }))
        .pipe(Effect.forkScoped)
      const secondRequest = yield* Deferred.await(secondAsked)

      yield* authorizer.reply({ requestID: firstRequest.id, reply: "reject" })
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isFailure(firstExit)).toBe(true)
      expect(yield* authorizer.get(secondRequest.id)).toEqual(secondRequest)
      expect((yield* authorizer.list()).filter(isControlRequest)).toEqual([secondRequest])

      yield* authorizer.reply({ requestID: secondRequest.id, reply: "once" })
      yield* Fiber.join(second)
    }),
  )

  it.effect("admits no alternate A1 actor value", () =>
    Effect.gen(function* () {
      const subject = controlSubject()
      const decoded = yield* Schema.decodeUnknownEffect(AgentRuntime.ControlPlaneSubject)({
        ...subject,
        actor: "agent",
      }).pipe(Effect.exit)
      expect(Exit.isFailure(decoded)).toBe(true)
    }),
  )
})
