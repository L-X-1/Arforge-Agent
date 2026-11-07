import { createEffect, onCleanup } from "solid-js"

/** Captures a confirmation's owner and source without changing its business state. */
export function createManagementConfirmationGuard<Source>(input: {
  source: () => Source
  key: () => string
  blocked: () => boolean
  invalidate?: () => unknown
}) {
  let live = true
  let generation = 0
  let source = input.source()
  let key = input.key()
  const observe = () => {
    const nextSource = input.source()
    const nextKey = input.key()
    if (nextSource !== source || nextKey !== key) {
      source = nextSource
      key = nextKey
      generation += 1
      input.invalidate?.()
    }
  }
  createEffect(observe)
  onCleanup(() => {
    live = false
    generation += 1
    input.invalidate?.()
  })
  return () => {
    observe()
    const capturedSource = source
    const capturedGeneration = generation
    const isCurrent = () => {
      if (!live) return false
      observe()
      return generation === capturedGeneration && source === capturedSource
    }
    return {
      source: capturedSource,
      isCurrent,
      canWrite: () => isCurrent() && !input.blocked(),
    }
  }
}
