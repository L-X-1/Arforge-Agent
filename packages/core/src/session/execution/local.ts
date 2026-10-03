import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionRunnerModel } from "../runner/model"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { ActionGateway } from "../../action-gateway"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError,
      SessionExecution.RunOptions
    >({
      drain: Effect.fnUntraced(function* (
        sessionID: SessionSchema.ID,
        force,
        options: SessionExecution.RunOptions | undefined,
      ) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) =>
          runner.run({
            sessionID,
            force,
            billing: options?.billing,
            onSettled: options?.onSettled,
            settlementCollector: options?.settlementCollector,
          }),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.provideService(
            SessionRunnerModel.CredentialScope,
            options?.credentialIDs && options.credentialIDs.length > 0 ? options.credentialIDs : undefined,
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    const cancelPendingActions = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const session = yield* store.get(sessionID)
        if (!session) return
        // Resolve the same location-scoped ActionGateway that owns the local
        // runner, then win any pre-execution approval CAS before interrupting
        // the coordinator. The gateway remains the sole durable authority.
        yield* Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          if (!gateway.cancelPendingSessionActions) return
          yield* gateway.cancelPendingSessionActions(sessionID)
        }).pipe(Effect.provide(locations.get(session.location)))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Session pending-action cancellation failed; interrupting runner anyway", { cause }),
        ),
      )

    return SessionExecution.Service.of({
      active: coordinator.active,
      exclusive: coordinator.exclusive,
      interrupt: (sessionID) =>
        Effect.gen(function* () {
          yield* coordinator.interrupt(sessionID, cancelPendingActions(sessionID))
        }),
      resume: coordinator.run,
      resumeWith: (input) => coordinator.runWith(input.sessionID, input.options),
      wake: coordinator.wake,
      wakeAndWait: coordinator.wakeAndWait,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
