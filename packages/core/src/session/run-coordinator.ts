export * as SessionRunCoordinator from "./run-coordinator"

import { Context, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Options = never> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Runs one-off work in the same execution slot; false means busy and work was not started. */
  readonly exclusive: (
    key: Key,
    work: Effect.Effect<void, E>,
    beforeInterrupt?: Effect.Effect<void>,
  ) => Effect.Effect<boolean, E>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Starts a run with an explicit, non-inheritable execution scope. */
  readonly runWith: (key: Key, options: Options) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Registers work and waits for the drain that is guaranteed to observe it. */
  readonly wakeAndWait: (key: Key) => Effect.Effect<void, E>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key, beforeInterrupt?: Effect.Effect<void>) => Effect.Effect<void>
}

type Entry<E, Options> = {
  readonly done: Deferred.Deferred<void, E>
  readonly options?: Options
  /** One-off work is never inherited by a queued drain. */
  work?: Effect.Effect<void, E>
  beforeInterrupt?: Effect.Effect<void>
  /** Context that owns this execution generation. */
  context: Context.Context<never>
  /** Context supplied by wakes that arrived while the generation was active. */
  pendingContext?: Context.Context<never>
  /** Callers whose admitted work is owned by this execution generation. */
  readonly completionWaiters: Array<Deferred.Deferred<void, E>>
  /** Callers admitted while this generation is active; transferred to its successor. */
  readonly pendingWaiters: Array<Deferred.Deferred<void, E>>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E, Options = never>(options: {
  readonly drain: (key: Key, force: boolean, options?: Options) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E, Options>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E, Options>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (
      context: Context.Context<never>,
      options?: Options,
      completionWaiters: Array<Deferred.Deferred<void, E>> = [],
    ): Entry<E, Options> => ({
      done: Deferred.makeUnsafe<void, E>(),
      ...(options === undefined ? {} : { options }),
      context,
      completionWaiters,
      pendingWaiters: [],
      pendingWake: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E, Options>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(
            Effect.suspend(() => entry.work ?? options.drain(key, force, entry.options)).pipe(
              Effect.provide(entry.context),
            ),
          ),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E, Options>, exit: Exit.Exit<void, E>) => {
      // Only ordinary drains may reuse their generation. An explicit runWith
      // scope belongs to that run alone: a queued wake gets the fresh entry
      // below, without its credentials, billing policy or settlement hooks.
      if (
        entry.work === undefined &&
        entry.options === undefined &&
        Exit.isSuccess(exit) &&
        !entry.stopping &&
        entry.pendingWake
      ) {
        entry.pendingWake = false
        if (entry.pendingContext !== undefined) entry.context = entry.pendingContext
        entry.pendingContext = undefined
        entry.completionWaiters.push(...entry.pendingWaiters.splice(0))
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake
        ? makeEntry(entry.pendingContext ?? entry.context, undefined, entry.pendingWaiters.splice(0))
        : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
      // Detach the list before notification: resumed callers may synchronously
      // run their finalizers and remove their own registrations.
      for (const waiter of entry.completionWaiters.splice(0)) Deferred.doneUnsafe(waiter, exit)
    }

    const joinEntry = (entry: Entry<E, Options>) => {
      // Each caller owns its completion latch. In particular an interrupt
      // must not synchronously unsubscribe one shared Deferred observer while
      // that Deferred is still notifying the remaining callers.
      const waiter = Deferred.makeUnsafe<void, E>()
      entry.completionWaiters.push(waiter)
      return Deferred.await(waiter).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const index = entry.completionWaiters.indexOf(waiter)
            if (index >= 0) entry.completionWaiters.splice(index, 1)
          }),
        ),
      )
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.contextWith((context: Context.Context<never>) => {
          const entry = active.get(key)
          if (entry !== undefined) {
            if (entry.stopping) return restore(joinEntry(entry).pipe(Effect.andThen(run(key))))
            // A completed command is not a completed model drain. Resume must
            // observe queued input after the one-off execution releases its slot.
            if (entry.work !== undefined) return restore(wakeAndWait(key))
            return restore(joinEntry(entry))
          }

          const next = makeEntry(context)
          active.set(key, next)
          start(key, next, true)
          return restore(Deferred.await(next.done))
        }),
      )

    const exclusive = (
      key: Key,
      work: Effect.Effect<void, E>,
      beforeInterrupt?: Effect.Effect<void>,
    ): Effect.Effect<boolean, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.contextWith((context: Context.Context<never>) => {
          if (active.has(key)) return Effect.succeed(false)
          const next = makeEntry(context)
          next.work = work
          next.beforeInterrupt = beforeInterrupt
          active.set(key, next)
          start(key, next, false)
          return restore(Deferred.await(next.done)).pipe(Effect.as(true))
        }),
      )

    const runWith = (key: Key, options: Options): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.contextWith((context: Context.Context<never>) => {
          const entry = active.get(key)
          if (entry !== undefined)
            // A scoped run waits for the current run, then starts a fresh entry
            // so credentials/options can never leak into a coalesced successor.
            return restore(joinEntry(entry).pipe(Effect.andThen(runWith(key, options))))

          const next = makeEntry(context, options)
          active.set(key, next)
          start(key, next, true)
          return restore(Deferred.await(next.done))
        }),
      )

    const wake = (key: Key): Effect.Effect<void> =>
      Effect.contextWith((context: Context.Context<never>) =>
        Effect.sync(() => {
          const entry = active.get(key)
          if (entry !== undefined) {
            entry.pendingWake = true
            entry.pendingContext = Context.merge(entry.pendingContext ?? entry.context, context)
            return
          }

          const next = makeEntry(context)
          active.set(key, next)
          start(key, next, false)
        }),
      )

    const wakeAndWait = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.contextWith((context: Context.Context<never>) => {
          const entry = active.get(key)
          if (entry === undefined) {
            const next = makeEntry(context)
            active.set(key, next)
            start(key, next, false)
            return restore(Deferred.await(next.done))
          }

          const waiter = Deferred.makeUnsafe<void, E>()
          entry.pendingWake = true
          entry.pendingContext = Context.merge(entry.pendingContext ?? entry.context, context)
          entry.pendingWaiters.push(waiter)
          return restore(Deferred.await(waiter))
        }),
      )

    const interrupt = (key: Key, beforeInterrupt?: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return beforeInterrupt ?? Effect.void
        entry.stopping = true
        entry.pendingWake = false
        entry.completionWaiters.push(...entry.pendingWaiters.splice(0))
        return (entry.beforeInterrupt ?? Effect.void).pipe(
          Effect.andThen(beforeInterrupt ?? Effect.void),
          Effect.ensuring(Fiber.interrupt(entry.owner)),
        )
      })

    return { active: Effect.sync(() => new Set(active.keys())), exclusive, run, runWith, wake, wakeAndWait, interrupt }
  })
