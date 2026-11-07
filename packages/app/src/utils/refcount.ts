import { createRoot, getOwner, onCleanup } from "solid-js"

export function createRefCountMap<T>(
  create: (key: string) => T,
  remove?: (key: string) => void,
  identity: (key: string) => string = (key) => key,
) {
  const items = new Map<string, T>()
  const refCounts = new Map<string, number>()
  const disposers = new Map<string, () => void>()
  const owner = getOwner()
  let disposed = false

  const release = (id: string) => {
    const dispose = disposers.get(id)
    disposers.delete(id)
    items.delete(id)
    refCounts.delete(id)
    try {
      dispose?.()
    } finally {
      remove?.(id)
    }
  }
  if (owner)
    onCleanup(() => {
      disposed = true
      for (const id of [...items.keys()]) release(id)
    })

  return (key: string) => {
    if (disposed) throw new Error("Shared resource owner is disposed")
    const id = identity(key)
    if (!items.has(id)) {
      // The resource outlives its first consumer. Inherit the map owner's
      // context, and dispose this root only after its last reference retires.
      const item = createRoot((dispose) => {
        try {
          return { value: create(key), dispose }
        } catch (error) {
          dispose()
          throw error
        }
      }, owner)
      items.set(id, item.value)
      disposers.set(id, item.dispose)
      refCounts.set(id, 0)
    }
    refCounts.set(id, (refCounts.get(id) ?? 0) + 1)
    onCleanup(() => {
      const count = refCounts.get(id)
      if (count === undefined) return
      if (count === 1) release(id)
      else refCounts.set(id, count - 1)
    })
    return items.get(id)!
  }
}
