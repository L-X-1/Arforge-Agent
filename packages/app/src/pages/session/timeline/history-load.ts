/** Own failures of automatic pagination without converting failure into success. */
export function createHistoryLoadGuard() {
  const pending = new Set<string>()
  let failed: string | undefined

  return {
    has: (key: string) => pending.has(key),
    async run(input: {
      key: string
      current: () => boolean
      automatic: boolean
      load: () => Promise<void>
      onError: (error: unknown) => void
    }) {
      if (!input.current() || pending.has(input.key) || (input.automatic && failed === input.key)) return false
      pending.add(input.key)
      try {
        await input.load()
        if (!input.current()) return false
        if (failed === input.key) failed = undefined
        return true
      } catch (error) {
        if (input.current()) {
          failed = input.key
          input.onError(error)
        }
        return false
      } finally {
        pending.delete(input.key)
      }
    },
  }
}
