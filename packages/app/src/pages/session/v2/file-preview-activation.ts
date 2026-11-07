export const COMPACT_FILE_PREVIEW_DELAY = 500

type ActivationInput = {
  compact: () => boolean
  source: () => unknown
  identity: () => string
  preview: (path: string) => void
  pin: (path: string) => void
}

type Schedule = (callback: () => void, delay: number) => () => void

/** Keep the directory row available for a human double click before compact navigation unmounts it. */
export function createFilePreviewActivation(
  input: ActivationInput,
  schedule: Schedule = (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
) {
  let generation = 0
  let pending: (() => void) | undefined
  const cancel = () => {
    generation++
    pending?.()
    pending = undefined
  }
  return {
    cancel,
    select(path: string, options: { permanent?: boolean; pointer?: boolean } = {}) {
      cancel()
      if (options.permanent) {
        input.pin(path)
        return
      }
      if (!input.compact() || !options.pointer) {
        input.preview(path)
        return
      }
      const source = input.source()
      const identity = input.identity()
      const request = generation
      pending = schedule(() => {
        if (request !== generation) return
        pending = undefined
        try {
          if (input.source() !== source || input.identity() !== identity) return
        } catch {
          return
        }
        input.preview(path)
      }, COMPACT_FILE_PREVIEW_DELAY)
    },
  }
}
