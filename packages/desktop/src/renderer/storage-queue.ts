import type { AsyncStorage } from "@solid-primitives/storage"
import { createPersistenceDrain } from "../shared/persistence-drain"

export function createStorageMutationQueue() {
  let tail = Promise.resolve()
  const drain = createPersistenceDrain()

  const enqueue = <T>(operation: () => Promise<T>, key = "mutation", options?: { clearsPrefix?: string }) => {
    const current = tail.catch(() => undefined).then(operation)
    tail = current.then(
      () => undefined,
      () => undefined,
    )
    return drain.track(key, current, options)
  }
  return Object.assign(enqueue, { flush: drain.flush })
}

type DesktopStorageBridge = {
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
}

export function createDesktopStorage(
  name: string,
  bridge: DesktopStorageBridge,
): AsyncStorage & { flush: () => Promise<void> } {
  const mutate = createStorageMutationQueue()
  const api: AsyncStorage & { flush: () => Promise<void> } = {
    flush: mutate.flush,
    getItem: (key: string) => bridge.storeGet(name, key),
    setItem: (key: string, value: string) =>
      mutate(
        () => {
          // @solid-primitives/storage removes nullish persisted signals, but its
          // store branch can pass JSON.stringify(undefined) through setItem.
          // Keep the desktop adapter consistent with the signal branch instead
          // of forwarding an invalid IPC value and leaving the caller rejected.
          if (value === undefined || value === null) return bridge.storeDelete(name, key)
          if (typeof value !== "string") return Promise.reject(new TypeError("Invalid desktop store value"))
          return bridge.storeSet(name, key, value)
        },
        JSON.stringify(["key", key]),
      ),
    removeItem: (key: string) => mutate(() => bridge.storeDelete(name, key), JSON.stringify(["key", key])),
    clear: () => mutate(() => bridge.storeClear(name), JSON.stringify(["clear"]), { clearsPrefix: "" }),
    key: async (index: number) => (await bridge.storeKeys(name))[index],
    getLength: () => bridge.storeLength(name),
    get length() {
      return api.getLength()
    },
  }
  return api
}
