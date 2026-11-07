import { Deferred, Effect } from "effect"

export async function readyLocalServer<A>(
  server: {
    listener: { stop: () => Promise<void> }
    health: { wait: Promise<void> }
  },
  data: A,
): Promise<A> {
  try {
    await server.health.wait
    return data
  } catch (error) {
    await server.listener.stop()
    throw error
  }
}

export function forwardInitializationFailure<A>(initialization: Deferred.Deferred<A, unknown>) {
  return <B, E, R>(effect: Effect.Effect<B, E, R>) =>
    effect.pipe(Effect.tapCause((cause) => Deferred.failCause(initialization, cause)))
}
