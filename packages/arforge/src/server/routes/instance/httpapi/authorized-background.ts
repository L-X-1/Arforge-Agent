import { Database } from "@arforge-ai/core/database/database"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { Effect, FiberSet } from "effect"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"

export interface AuthorizedBackground {
  /**
   * Launch work from the server-owned runtime instead of the request fiber.
   *
   * PostgreSQL authorization wraps a request in a transaction so RLS settings
   * are transaction-local. A child fork must not inherit that transaction's
   * connection: the HTTP response can commit it while the child is still
   * running, leaving the child with invalid savepoints. The detached runtime
   * starts with clean fiber refs and establishes a fresh principal transaction.
   */
  readonly launch: (principal: IdentityContext.Principal, effect: Effect.Effect<void>) => Effect.Effect<void>
}

export const makeAuthorizedBackground = Effect.gen(function* () {
  const database = yield* Database.Service
  const fork = yield* FiberSet.makeRuntime<never, void, never>()

  return {
    launch: (principal: IdentityContext.Principal, effect: Effect.Effect<void>) =>
      Effect.gen(function* () {
        // These two request-scoped references are legitimate execution
        // context. Capture and re-provide them explicitly while leaving every
        // other request FiberRef (especially the SQL transaction) behind.
        const instance = yield* InstanceRef
        const workspaceID = yield* WorkspaceRef
        yield* Effect.sync(() => {
          fork(
            database
              .runAsPrincipal(
                principal,
                effect.pipe(
                  // The detached FiberSet runtime deliberately drops the
                  // request transaction context. Re-provide the durable
                  // database handle explicitly so prompt/session effects do
                  // not depend on whichever pruned route context happened to
                  // construct this helper.
                  Effect.provideService(Database.Service, database),
                  Effect.provideService(IdentityContext.Current, principal),
                  Effect.provideService(InstanceRef, instance),
                  Effect.provideService(WorkspaceRef, workspaceID),
                ),
              )
              .pipe(Effect.orDie, Effect.asVoid),
          )
        })
      }),
  } satisfies AuthorizedBackground
})
