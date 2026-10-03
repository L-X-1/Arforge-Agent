/** Bounded, ephemeral log suppression only; never decides whether recovery runs. */
export function makeRecoveryDiagnostics() {
  const entries = new Map<string, { fingerprint: string; loggedAt: number }>()
  return {
    shouldLog(key: string, fingerprint: string, now: number) {
      const previous = entries.get(key)
      if (previous?.fingerprint === fingerprint && now >= previous.loggedAt && now - previous.loggedAt < 60_000)
        return false
      entries.delete(key)
      entries.set(key, { fingerprint, loggedAt: now })
      if (entries.size > 1_024) entries.delete(entries.keys().next().value!)
      return true
    },
    clear(key: string) {
      entries.delete(key)
    },
  }
}
