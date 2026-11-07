import { describe, expect, test } from "bun:test"
import { createDesktopStorage } from "./storage-queue"
import { createDesktopStoreWriter } from "../preload/store-write"
import { createPersistenceDrain } from "../shared/persistence-drain"
import { STORE_INLINE_LENGTH } from "../shared/store-transfer"
import { createClosePreparation } from "../main/close-preparation"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe("immediate close preserves the actual asynchronous storage path", () => {
  for (const phase of ["before-bridge", "staged-chunk", "native-settlement"] as const) {
    test(phase, async () => {
      const gate = deferred()
      const preload = createPersistenceDrain()
      const value = "最新草稿 🧪".repeat(STORE_INLINE_LENGTH)
      let staged = "",
        saved = "old draft",
        enabled = true,
        closed = false
      const writer = createDesktopStoreWriter({
        set: async () => {
          throw new Error("The large value must use staging")
        },
        begin: async () => "owned-transfer",
        chunk: async (_id, _index, text) => {
          if (phase === "staged-chunk") await gate.promise
          staged += text
        },
        commit: async () => {
          saved = staged
          if (phase === "native-settlement") await gate.promise
        },
        abort: async () => undefined,
      })
      const storage = createDesktopStorage("owned.dat", {
        storeSet: async (name, key, text) => {
          if (phase === "before-bridge") await gate.promise
          await preload.track(key, writer(name, key, text))
        },
        storeGet: async () => saved,
        storeDelete: async () => undefined,
        storeClear: async () => undefined,
        storeKeys: async () => [],
        storeLength: async () => 0,
      })
      const preparation = createClosePreparation({
        createID: () => "owned-close-generation",
        blockInput: () => {
          enabled = false
          return () => {
            enabled = true
          }
        },
        request: (requestID) => {
          void storage
            .flush()
            .then(() => preload.flush())
            .then(
              () => preparation.acknowledge({ requestID, ok: true }),
              () => preparation.acknowledge({ requestID, ok: false }),
            )
        },
      })
      // The initiating UI neither awaits the write nor probes saved state before Close.
      const write = storage.setItem("prompt", value)
      const close = preparation.prepare().then(() => {
        closed = true
      })
      await Bun.sleep(0)
      expect(closed).toBe(false)
      expect(enabled).toBe(false)
      gate.resolve()
      await Promise.all([write, close])
      expect(closed).toBe(true)
      expect(saved).toBe(value)
      expect(preparation.ready).toBe(true)
      preparation.cancel()
      expect(enabled).toBe(true)
    })
  }

  test("failure keeps the owner open and does not replay; a new explicit save permits retry", async () => {
    let writes = 0,
      saved = "old",
      enabled = true
    const storage = createDesktopStorage("owned.dat", {
      storeSet: async (_name, _key, value) => {
        if (++writes === 1) throw new Error("file locked")
        saved = value
      },
      storeGet: async () => saved,
      storeDelete: async () => undefined,
      storeClear: async () => undefined,
      storeKeys: async () => [],
      storeLength: async () => 0,
    })
    let generation = 0
    const preparation = createClosePreparation({
      createID: () => String(++generation),
      blockInput: () => {
        enabled = false
        return () => {
          enabled = true
        }
      },
      request: (requestID) => {
        void storage.flush().then(
          () => preparation.acknowledge({ requestID, ok: true }),
          () => preparation.acknowledge({ requestID, ok: false }),
        )
      },
    })
    await storage.setItem("prompt", "latest draft").catch(() => undefined)
    await expect(preparation.prepare()).rejects.toThrow()
    expect(enabled).toBe(true)
    expect(preparation.ready).toBe(false)
    expect(writes).toBe(1)
    expect(saved).toBe("old")
    await storage.setItem("prompt", "latest draft")
    await preparation.prepare()
    expect(saved).toBe("latest draft")
    expect(writes).toBe(2)
    expect(generation).toBe(2)
    preparation.cancel()
  })
})
