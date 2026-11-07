import { Database } from "@arforge-ai/core/database/database"
import * as TransactionEffects from "@arforge-ai/core/database/transaction-effects"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { Context, Effect, FiberSet } from "effect"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"

export interface AuthorizedBackground {
  /**
   * Launch work from the server-owned runtime instead of the request fiber.
   *
   * Admission must commit before work starts. A child must not inherit an
   * admission transaction's connection or commit queue. Bind identity for the
   * execution lifetime; each SQL operation establishes its own short RLS scope.
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
        yield* Database.afterCommit(
          database,
          Effect.sync(() => {
            fork(
              Database.principalContext(
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
              ).pipe(
                // The helper's runtime may itself have been constructed in an
                // admission transaction; providing services only merges context.
                Effect.updateContext((context: Context.Context<never>) =>
                  TransactionEffects.detachedContext(database.db.$client, context),
                ),
                Effect.orDie,
                Effect.asVoid,
              ),
            )
          }),
        )
      }),
  } satisfies AuthorizedBackground
})
