const DEFAULT_RETRY_DELAYS_MS = [15, 30, 60, 120, 240, 480] as const
const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"])

type FileSystemError = Error & { code?: string }

export class StoreMutationCoordinator {
  private readonly pending = new Map<string, Promise<void>>()

  run(name: string, operation: () => void | Promise<void>) {
    const previous = this.pending.get(name) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => retryStoreMutation(operation))
    let tracked: Promise<void>
    tracked = current.finally(() => {
      if (this.pending.get(name) === tracked) this.pending.delete(name)
    })
    this.pending.set(name, tracked)
    return tracked
  }
}

export async function retryStoreMutation(
  operation: () => void | Promise<void>,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await operation()
      return
    } catch (error) {
      if (!isRetryableStoreError(error) || attempt >= retryDelaysMs.length) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
    }
  }
}

export function isRetryableStoreError(error: unknown) {
  if (!(error instanceof Error)) return false
  return RETRYABLE_CODES.has((error as FileSystemError).code ?? "")
}
