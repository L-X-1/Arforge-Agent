/** Observe admitted mutations without replacing their ordering or failure semantics. */
export function createPersistenceDrain() {
  let sequence = 0
  const pending = new Set<Promise<void>>()
  const latest = new Map<string, number>()
  const failures = new Map<string, { sequence: number; error: unknown }>()
  const cleared = new Map<string, number>()

  const superseded = (key: string, version: number) =>
    [...cleared].some(([prefix, clearVersion]) => version <= clearVersion && key.startsWith(prefix))

  return {
    track<T>(key: string, operation: Promise<T>, options?: { clearsPrefix?: string }): Promise<T> {
      const version = ++sequence
      latest.set(key, version)
      let observed: Promise<void>
      observed = operation.then(
        () => {
          if (latest.get(key) === version) {
            latest.delete(key)
            failures.delete(key)
          }
          if (options?.clearsPrefix !== undefined) {
            const prefix = options.clearsPrefix
            cleared.set(prefix, Math.max(cleared.get(prefix) ?? 0, version))
            for (const [failedKey, failure] of failures) {
              if (failure.sequence <= version && failedKey.startsWith(prefix)) failures.delete(failedKey)
            }
          }
          pending.delete(observed)
        },
        (error) => {
          if (latest.get(key) === version) {
            latest.delete(key)
            if (!superseded(key, version)) failures.set(key, { sequence: version, error })
          }
          pending.delete(observed)
        },
      )
      pending.add(observed)
      return operation
    },
    async flush() {
      // Include mutations admitted while an earlier batch was settling.
      while (pending.size) await Promise.all([...pending])
      const failure = failures.values().next().value
      if (failure) throw failure.error
    },
  }
}
