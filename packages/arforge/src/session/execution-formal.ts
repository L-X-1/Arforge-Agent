import { Database } from "@arforge-ai/core/database/database"
import { makeGlobalNode } from "@arforge-ai/core/effect/app-node"
import { EventV2 } from "@arforge-ai/core/event"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { SessionRunner } from "@arforge-ai/core/session/runner"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionStore } from "@arforge-ai/core/session/store"
import { SessionInput } from "@arforge-ai/core/session/input"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Cause, Clock, DateTime, Effect, Layer, Scope, Schema } from "effect"
import { SystemContext } from "@arforge-ai/core/system-context"
import { SystemPrompt } from "./system"
import { Agent } from "@/agent/agent"
import { Session } from "./session"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { makeRecoveryDiagnostics } from "./recovery-diagnostics"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt, type ChildRunExecutor } from "./prompt"
import { SessionStatus } from "./status"
import { ToolCoreBridge } from "@/tool/core-bridge"
import { SessionID } from "./schema"
import { hasPendingTaskNotification, taskNotificationParentToWake } from "@/tool/task"

/**
 * Product execution adapter for the Formal Core runner.
 *
 * SessionInput and Core SessionMessage remain the only execution facts. The
 * prompt service supplies child-prompt operations to one canonical Core task
 * tool; no Mature parent assistant/tool shadow or opaque scheduled carrier is
 * created, and the Mature agent loop is never started here.
 */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const durableRuns = yield* DurableRun.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const status = yield* SessionStatus.Service
    const toolBridge = yield* ToolCoreBridge.Service
    const systemPrompt = yield* SystemPrompt.Service
    const agents = yield* Agent.Service
    const legacySessions = yield* Session.Service
    const externalContext = Effect.fn("SessionExecutionFormal.externalContext")(function* (
      sessionID: SessionSchema.ID,
      agentName: string,
    ) {
      const session = yield* legacySessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
      const agent = yield* agents.get(agentName)
      if (!agent) return yield* Effect.die(new Error(`Unknown context agent: ${agentName}`))
      const text = yield* systemPrompt.mcp(agent, session.permission)
      if (!text) return SystemContext.empty
      return SystemContext.make({
        key: SystemContext.Key.make("mcp/server-instructions"),
        codec: Schema.String,
        load: Effect.succeed(text),
        baseline: (value) => value,
        update: (_previous, value) => value,
        removed: () =>
          "Previously supplied MCP server instructions are no longer available or permitted; disregard them.",
      })
    })
    const runChild: ChildRunExecutor = (input) =>
      Effect.gen(function* () {
        const child = yield* sessions.get(input.sessionID)
        if (!child) return yield* Effect.die(new Error(`Child session not found: ${input.sessionID}`))
        yield* instances.provide(
          { directory: child.location.directory },
          Effect.scoped(SessionRunner.Service.use((runner) => runner.run({ ...input, force: false }))).pipe(
            Effect.provideService(SessionRunner.ExternalTools, toolBridge.snapshot),
            Effect.provideService(SessionRunner.ExternalContext, externalContext),
            Effect.provide(locations.get(child.location)),
          ),
        )
      }).pipe(Effect.orDie)

    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      options: SessionExecution.RunOptions | undefined,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      return yield* instances.provide(
        { directory: session.location.directory },
        Effect.scoped(
          Effect.gen(function* () {
            // The formal Core runner is the execution owner, but the mature
            // HTTP/CLI transports still consume the legacy session.status
            // stream. Project its lifecycle at this single adapter boundary
            // so callers get one busy→idle transition without introducing a
            // second runner or a second status authority.
            yield* status.set(sessionID, { type: "busy" })
            const taskRoutes = new Map<
              string,
              { readonly modelID: string; readonly providerID: string; readonly variant?: string }
            >()
            const context = yield* sessions.context(sessionID)
            const admitted = [
              ...(yield* SessionInput.listPending(database.db, sessionID, "steer")),
              ...(yield* SessionInput.listPending(database.db, sessionID, "queue")),
            ]
            const taskInputs = [
              ...context.flatMap((message) => (message.type === "user" ? (message.scheduledTasks ?? []) : [])),
              ...admitted.flatMap((input) => input.prompt.scheduledTasks ?? []),
            ]
            for (const task of taskInputs) {
              const route = task.model ?? session.model
              if (!route) continue
              taskRoutes.set(task.id, {
                modelID: String(route.id),
                providerID: String(route.providerID),
                ...(session.model?.variant ? { variant: String(session.model.variant) } : {}),
              })
            }
            const scheduledTaskTool = yield* prompt.scheduledTaskTool({
              sessionID: SessionID.make(sessionID),
              routes: Object.fromEntries(taskRoutes),
              wakeSession: (id): Effect.Effect<void> => withDatabase(coordinator.wake(SessionSchema.ID.make(id))),
              runChild,
              metadata: ({ assistantMessageID, callID, value }) =>
                events.publish(SessionEvent.Tool.Progress, {
                  sessionID,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                  assistantMessageID,
                  callID,
                  structured: {
                    ...(value.metadata ?? {}),
                    ...(value.title ? { title: value.title } : {}),
                  },
                  content: value.title ? [{ type: "text", text: value.title }] : [],
                }),
            })
            return yield* SessionRunner.Service.use((runner) =>
              runner
                .run({
                  sessionID,
                  force,
                  billing: options?.billing,
                  personalJob: options?.personalJob,
                  onSettled: options?.onSettled,
                  settlementCollector: options?.settlementCollector,
                  ...(scheduledTaskTool ? { scheduledTaskTool } : {}),
                  modelTaskCalls: true,
                })
                .pipe(
                  Effect.provideService(SessionRunner.ExternalContext, externalContext),
                  // Always close the compatibility projection, including
                  // model/transport failures and interrupts. The runner's
                  // durable terminal status remains authoritative for V2;
                  // this event is only the legacy transport wake-up.
                  Effect.onExit(() => status.set(sessionID, { type: "idle" }).pipe(Effect.ignore)),
                  Effect.provideService(SessionRunner.ExternalTools, toolBridge.snapshot),
                ),
            )
          }),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.provideService(
            SessionRunnerModel.CredentialScope,
            options?.credentialIDs && options.credentialIDs.length > 0 ? options.credentialIDs : undefined,
          ),
        ),
      )
    })

    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError,
      SessionExecution.RunOptions
    >({
      drain: (sessionID, force, options) =>
        drain(sessionID, force, options).pipe(
          Effect.tapCause((cause) =>
            Effect.logError("Failed to drain Formal Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        ),
    })

    // Reclaim expired workers and never-started child handoffs without a lease.
    // Paused heads fence later child work until an explicit resume. Keep the
    // scanner on this Formal owner so the replacement layer has the same durable
    // recovery guarantee as the mature adapter without introducing a second
    // execution loop.
    const scope = yield* Scope.Scope
    const recoveryDiagnostics = makeRecoveryDiagnostics()
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.gen(function* () {
          const orphaned = yield* durableRuns.orphaned(undefined, { includePendingChildren: true })
          const notifications = (yield* durableRuns.list({ limit: Number.MAX_SAFE_INTEGER })).filter(
            (item): item is DurableRun.ChildSnapshot =>
              "sessionID" in item.run &&
              !!item.run.child &&
              ["completed", "failed", "cancelled"].includes(item.run.status),
          )
          yield* Effect.forEach(
            [...orphaned, ...notifications],
            (item) =>
              (item.run.child
                ? Effect.gen(function* () {
                    // Decode recovery metadata within the per-item failure
                    // boundary: one corrupt notification must not starve all
                    // orphaned workers or healthy terminal deliveries.
                    if (
                      ["completed", "failed", "cancelled"].includes(item.run.status) &&
                      (item.run.status === "cancelled" || !!item.run.childResult) &&
                      !hasPendingTaskNotification(item as DurableRun.ChildSnapshot)
                    ) {
                      const parentID = yield* taskNotificationParentToWake(item as DurableRun.ChildSnapshot)
                      if (parentID) yield* coordinator.wake(SessionSchema.ID.make(parentID))
                      return
                    }
                    const session = yield* sessions.get(item.run.sessionID)
                    if (!session) return yield* Effect.die(new Error("Orphaned child session is missing"))
                    yield* instances.provide(
                      { directory: session.location.directory },
                      prompt.recoverTask({
                        child: item as DurableRun.ChildSnapshot,
                        runChild,
                        wakeSession: (id) => coordinator.wake(SessionSchema.ID.make(id)),
                      }),
                    )
                  }).pipe(Effect.asVoid)
                : coordinator.wake(item.run.sessionID)
              ).pipe(
                Effect.tap(() => Effect.sync(() => recoveryDiagnostics.clear(item.run.id))),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const now = yield* Clock.currentTimeMillis
                    const fingerprint = `${item.lastSequence}:${canonicalHash(Cause.pretty(cause))}`
                    if (!recoveryDiagnostics.shouldLog(item.run.id, fingerprint, now)) return
                    yield* Effect.logWarning("Formal recovery item rejected; continuing scan", {
                      runID: item.run.id,
                      cause,
                    })
                  }),
                ),
              ),
            {
              discard: true,
            },
          )
        }).pipe(
          Effect.tap(() => Effect.sync(() => recoveryDiagnostics.clear("scan"))),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              if (!recoveryDiagnostics.shouldLog("scan", canonicalHash(Cause.pretty(cause))!, now)) return
              yield* Effect.logWarning("Formal Session execution recovery scan failed; retrying", { cause })
            }),
          ),
        )
        yield* Effect.sleep("2 seconds")
      }
    }).pipe(Effect.provideService(Database.Service, database), Effect.forkIn(scope, { startImmediately: true }))

    const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(Database.Service, database))

    const cancelPendingActions = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(sessionID)
        if (!session) return
        // The ActionGateway is location-scoped. Resolve the same instance that
        // owns the running Formal session before interrupting its coordinator;
        // this lets the gateway win the awaiting-approval CAS with the exact
        // action input/plan captured at execution start.
        yield* instances.provide(
          { directory: session.location.directory },
          Effect.scoped(
            Effect.gen(function* () {
              const gateway = yield* ActionGateway.Service
              if (!gateway.cancelPendingSessionActions) return
              yield* gateway.cancelPendingSessionActions(sessionID)
            }),
          ).pipe(Effect.provide(locations.get(session.location))),
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Formal Session pending-action cancellation failed; interrupting runner anyway", {
            cause,
          }),
        ),
      )

    return SessionExecution.Service.of({
      active: coordinator.active,
      exclusive: (sessionID, work, beforeInterrupt) =>
        withDatabase(coordinator.exclusive(sessionID, work, beforeInterrupt)),
      resume: (sessionID) => withDatabase(coordinator.run(sessionID)),
      resumeWith: ({ sessionID, options }) => withDatabase(coordinator.runWith(sessionID, options)),
      wake: (sessionID) => withDatabase(coordinator.wake(sessionID)),
      wakeAndWait: (sessionID) => withDatabase(coordinator.wakeAndWait(sessionID)),
      interrupt: (sessionID) =>
        withDatabase(
          Effect.gen(function* () {
            // Cancel the durable pre-execution approval before stopping the
            // runner. Once the execution handoff has committed, the gateway
            // records an honest handoff/review state and the live worker owns
            // observation; no adapter can claim a safe cancellation then.
            yield* coordinator.interrupt(sessionID, cancelPendingActions(sessionID))
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    DurableRun.globalNode,
    LocationServiceMap.node,
    SessionStore.node,
    InstanceStore.node,
    SessionPrompt.node,
    SessionStatus.node,
    ToolCoreBridge.node,
    SystemPrompt.node,
    Agent.node,
    Session.node,
  ],
})

export * as SessionExecutionFormal from "./execution-formal"
