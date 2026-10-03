type Schedule = (callback: () => void, delay: number) => () => void

const schedule: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}

/** Pointer timing is independent of streaming and never schedules a touch dismissal. */
export function createHistoryPreviewTimers(hide: () => void, later: Schedule = schedule) {
  let cancelOpen: (() => void) | undefined
  let cancelClose: (() => void) | undefined
  let persistent = false
  const cancel = () => {
    cancelOpen?.()
    cancelClose?.()
    cancelOpen = cancelClose = undefined
  }
  return {
    hover(reveal: () => void) {
      cancel()
      persistent = false
      cancelOpen = later(reveal, 150)
    },
    open(reveal: () => void, touch = false) {
      cancel()
      persistent = touch
      reveal()
    },
    keepOpen() {
      cancelClose?.()
      cancelClose = undefined
    },
    leave() {
      cancelOpen?.()
      cancelClose?.()
      cancelOpen = cancelClose = undefined
      if (!persistent) cancelClose = later(hide, 200)
    },
    close() {
      cancel()
      persistent = false
      hide()
    },
    dispose: cancel,
  }
}
