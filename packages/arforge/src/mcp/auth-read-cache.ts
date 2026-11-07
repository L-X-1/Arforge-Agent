import { Effect } from "effect"
import { SecretProvider } from "@arforge-ai/core/secret-provider"

/** One layer's decrypt result, never an auth record or a substitute for reading disk. */
export const make = (secrets: SecretProvider.Interface, maxAgeMs = 30_000) => Effect.gen(function* () {
  let entry: { ciphertext: string; bytes: Uint8Array; expires: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let closed = false
  const clear = () => {
    generation++
    if (timer) clearTimeout(timer)
    timer = undefined
    entry?.bytes.fill(0)
    entry = undefined
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    closed = true
    clear()
  }))
  const unprotect = Effect.fn("McpAuthReadCache.unprotect")(function* (ciphertext: string) {
    if (entry?.ciphertext === ciphertext && performance.now() < entry.expires)
      return new Uint8Array(entry.bytes)
    clear()
    const started = generation
    const bytes = yield* secrets.unprotect(ciphertext).pipe(Effect.onError(() => Effect.sync(() => {
      if (generation === started) clear()
    })))
    // This continuation does not run after interruption. A closed/cleared owner
    // cannot republish a late native Promise result into its private cache.
    if (!closed && generation === started) {
      entry = { ciphertext, bytes: new Uint8Array(bytes), expires: performance.now() + maxAgeMs }
      timer = setTimeout(clear, maxAgeMs)
      timer.unref()
    }
    return new Uint8Array(bytes)
  })
  return { provider: SecretProvider.Service.of({ ...secrets, unprotect }), clear }
})

export * as McpAuthReadCache from "./auth-read-cache"
