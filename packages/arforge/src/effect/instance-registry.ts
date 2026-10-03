import { Context, Effect, Exit } from "effect"

type Disposer = (
  directory: string,
  runtimeContext: Context.Context<never>,
) => Effect.Effect<void, unknown, never> | Promise<void>

type DisposerRecord = {
  readonly run: Disposer
  /** The durable runtime that owns the cached resource, when available. */
  readonly owner?: object
}

const disposers = new Set<DisposerRecord>()

export function registerDisposer(disposer: Disposer, owner?: object) {
  const record: DisposerRecord = { run: disposer, ...(owner === undefined ? {} : { owner }) }
  disposers.add(record)
  return () => {
    disposers.delete(record)
  }
}

/**
 * Run all instance disposers inside the caller's Effect runtime.
 *
 * InstanceStore used to cross into a naked Promise here. That made scoped
 * finalizers lose the services that were available when an instance was
 * created (most visibly Database and LocationServiceMap), and concurrent
 * test/request cleanup could surface an unhandled missing-service defect.
 * Capturing an Effect instead keeps cleanup in the same deterministic
 * context while `Exit` preserves the old all-settled behavior.
 */
export function disposeInstanceEffect(directory: string, owner?: object) {
  return Effect.gen(function* () {
    // A disposer may have captured a narrower construction context, while the
    // caller (for example the HTTP authorization boundary) has a newer
    // Database/Location context. Pass both so cleanup never drops services at
    // a lifecycle boundary; captured values win when the same service key is
    // intentionally pinned to the resource that owns it.
    const runtimeContext = yield* Effect.context()
    const selected = [...disposers].filter((record) => owner === undefined || record.owner === undefined || record.owner === owner)
    // A process may host more than one managed runtime (the desktop server,
    // an isolated test instance, or a temporary CLI bridge). Never invalidate
    // a cache owned by another durable Database runtime. Legacy callers that
    // do not pass an owner retain the old all-runtime behavior, and unowned
    // test/compatibility disposers remain visible to an owned store.
    yield* Effect.forEach(
      selected,
      (record) =>
        Effect.exit(
          Effect.suspend(() => {
            const result = record.run(directory, runtimeContext)
            return Effect.isEffect(result) ? result : Effect.promise(() => result)
          }),
        ).pipe(
          Effect.tap((exit) =>
            Exit.isFailure(exit)
              ? Effect.logWarning("Instance disposer failed", { directory, cause: exit.cause })
              : Effect.void,
          ),
        ),
      { discard: true },
    )
  })
}

/** Promise bridge for legacy callers outside an Effect boundary. */
export async function disposeInstance(directory: string) {
  await Effect.runPromise(disposeInstanceEffect(directory))
}
