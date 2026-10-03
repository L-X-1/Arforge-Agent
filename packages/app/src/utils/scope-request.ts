export type ScopeRequestToken = Readonly<{
  key: string
  generation: number
}>

/**
 * Tracks the scope a UI request belongs to and rejects late responses from an
 * older scope. Calling `current`/`capture` also observes scope changes, so a
 * response cannot win merely because a reactive effect has not run yet.
 */
export function createScopeRequestGuard(readScope: () => string) {
  let key = readScope()
  let generation = 0

  const snapshot = (): ScopeRequestToken => ({ key, generation })
  const sync = () => {
    const next = readScope()
    if (next !== key) {
      key = next
      generation += 1
    }
    return snapshot()
  }

  return {
    current: sync,
    capture: sync,
    isCurrent(token: ScopeRequestToken) {
      const active = sync()
      return active.key === token.key && active.generation === token.generation
    },
    invalidate() {
      key = readScope()
      generation += 1
      return snapshot()
    },
  }
}
