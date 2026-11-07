import {
  STORE_CHUNK_LENGTH,
  STORE_INLINE_LENGTH,
  STORE_MAX_VALUE_LENGTH,
  type StoreWriteBridge,
} from "../shared/store-transfer"

export function createDesktopStoreWriter(bridge: StoreWriteBridge) {
  let pending = Promise.resolve()
  return async (name: string, key: string, value: string): Promise<void> => {
    // Every write shares the queue: an inline value must not overtake a staged
    // commit (or vice versa), including callers outside the renderer adapter.
    const current = pending.then(async () => {
      // Keep the existing main validation for invalid runtime values.
      if (typeof value !== "string" || value.length <= STORE_INLINE_LENGTH) return bridge.set(name, key, value)
      if (value.length > STORE_MAX_VALUE_LENGTH) throw new TypeError("Desktop store value exceeds staging quota")
      const id = await bridge.begin(name, key, value.length)
      try {
        for (let offset = 0, index = 0; offset < value.length; offset += STORE_CHUNK_LENGTH, index++) {
          await bridge.chunk(id, index, value.slice(offset, offset + STORE_CHUNK_LENGTH))
        }
        await bridge.commit(id)
      } catch (error) {
        await bridge.abort(id).catch(() => undefined)
        throw error
      }
    })
    pending = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }
}
