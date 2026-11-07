export type ClosePreparationAcknowledgement = {
  requestID: string
  ok: boolean
  error?: string | Error
}

export type ClosePreparationOptions = {
  request: (requestID: string) => void
  blockInput: () => () => void
  /** Return a fresh token for every preparation generation. */
  createID: () => string
  timeoutMs?: number
}

type Preparation = {
  requestID?: string
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  restoreInput?: () => void
  timer?: ReturnType<typeof setTimeout>
  sending: boolean
  acknowledged: boolean
  ready: boolean
}

const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** One window's barrier only; the caller owns sender authorization and native close. */
export function createClosePreparation(options: ClosePreparationOptions) {
  let current: Preparation | undefined

  const clearTimer = (preparation: Preparation) => {
    if (preparation.timer === undefined) return
    clearTimeout(preparation.timer)
    preparation.timer = undefined
  }

  const cancelPreparation = (preparation: Preparation, error: Error) => {
    if (current !== preparation) return
    current = undefined
    clearTimer(preparation)
    const restoreInput = preparation.restoreInput
    preparation.restoreInput = undefined
    try {
      restoreInput?.()
    } catch (restoreError) {
      error = new AggregateError([error, restoreError], "Close preparation could not restore input")
      if (preparation.ready) throw error
    }
    preparation.reject(error)
  }

  const succeed = (preparation: Preparation) => {
    if (current !== preparation) return
    clearTimer(preparation)
    preparation.ready = true
    preparation.resolve()
    // Retain the original input restorer until native close is cancelled.
  }

  const send = (preparation: Preparation) => {
    if (preparation.requestID === undefined || preparation.sending || preparation.acknowledged) return
    preparation.sending = true
    try {
      options.request(preparation.requestID)
    } catch (error) {
      cancelPreparation(preparation, asError(error))
    } finally {
      preparation.sending = false
    }
    // A synchronous acknowledgement cannot hide a subsequent request throw.
    if (preparation.acknowledged && current === preparation) succeed(preparation)
  }

  return {
    prepare(): Promise<void> {
      if (current) return current.promise
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
      })
      const preparation: Preparation = { promise, resolve, reject, sending: false, acknowledged: false, ready: false }
      // Install the promise before invoking any supplied callback.
      current = preparation
      try {
        const requestID = options.createID()
        const restoreInput = options.blockInput()
        if (current !== preparation) {
          restoreInput()
          return promise
        }
        preparation.restoreInput = restoreInput
        preparation.timer = setTimeout(
          () => cancelPreparation(preparation, new Error("Close preparation timed out")),
          options.timeoutMs ?? 10_000,
        )
        preparation.requestID = requestID
        send(preparation)
      } catch (error) {
        cancelPreparation(preparation, asError(error))
      }
      return promise
    },
    acknowledge(acknowledgement: ClosePreparationAcknowledgement): boolean {
      const preparation = current
      if (
        !preparation || preparation.ready || preparation.acknowledged ||
        preparation.requestID !== acknowledgement.requestID
      ) return false
      preparation.acknowledged = true
      if (!acknowledgement.ok) {
        cancelPreparation(preparation, asError(acknowledgement.error ?? "Close preparation failed"))
      } else if (!preparation.sending) {
        succeed(preparation)
      }
      return true
    },
    get ready(): boolean {
      return current?.ready === true
    },
    cancel(error = new Error("Close preparation cancelled")): void {
      if (current) cancelPreparation(current, error)
    },
    /** Retry delivery after preload readiness without extending the pending deadline. */
    resend(): void {
      if (current && !current.ready) send(current)
    },
  }
}
