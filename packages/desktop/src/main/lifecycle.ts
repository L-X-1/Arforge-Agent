type QuitEvent = { preventDefault(): void }

/** Showing a window and admitting a child share the same shutdown fence. */
export function createStartupGate() {
  let closed = false
  return {
    close() {
      closed = true
    },
    start<A>(showFeedback: () => void, factory: () => Promise<A>): Promise<A> {
      if (closed) return Promise.reject(new Error("Application is shutting down"))
      showFeedback()
      if (closed) return Promise.reject(new Error("Application is shutting down"))
      // No await between the fence and the factory. spawnLocalServer registers
      // its captured listener synchronously, before waiting for readiness.
      return factory()
    },
  }
}

/** Keep Electron alive until the captured owners have finished shutting down. */
export function createQuitCoordinator(input: {
  stop: () => Promise<void>
  quit: () => void
  onError: (error: unknown) => void
}) {
  let requested = false
  let ready = false
  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= Promise.resolve()
      .then(input.stop)
      .catch((error) => {
        stopping = undefined
        throw error
      }))
  return {
    get requested() {
      return requested
    },
    stop,
    beforeQuit(event: QuitEvent) {
      if (ready) return
      event.preventDefault()
      if (requested) return
      requested = true
      void stop().then(
        () => {
          ready = true
          input.quit()
        },
        (error) => {
          requested = false
          input.onError(error)
        },
      )
    },
  }
}

/** Only the captured child is signalled, and kill is followed by an exit receipt. */
export function createOwnedProcessStop(input: {
  exited: () => boolean
  exit: Promise<unknown>
  requestStop: () => void
  kill: () => void
  graceMs?: number
  killWaitMs?: number
}) {
  let stopping: Promise<void> | undefined
  return () =>
    (stopping ??= (async () => {
      if (input.exited()) return
      try {
        input.requestStop()
      } catch {
        input.kill()
      }
      if (await exitedWithin(input.exit, input.graceMs ?? 6000)) return
      if (!input.exited()) input.kill()
      if (await exitedWithin(input.exit, input.killWaitMs ?? 3000)) return
      throw new Error("Owned backend did not exit after stop and kill; application exit was withheld")
    })().catch((error) => {
      stopping = undefined
      throw error
    }))
}

export function createSidecarOwner<L extends { stop: (close?: boolean) => void | Promise<void> }>() {
  let starting: Promise<L> | undefined
  let stopping: Promise<void> | undefined
  return {
    get stopping() {
      return stopping !== undefined
    },
    start(factory: () => Promise<L>) {
      if (stopping) return Promise.reject(new Error("Owned backend is already stopping"))
      return (starting ??= factory())
    },
    stop() {
      return (stopping ??= (async () => {
        const listener = await starting?.catch(() => undefined)
        await listener?.stop(true)
      })())
    },
  }
}

async function exitedWithin(exit: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
