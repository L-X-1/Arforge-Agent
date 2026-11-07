import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import {
  createMemoryNativeActionJournal,
  createNativeActionRequest,
  createNativeActionRuntime,
  NativeActionKind,
} from "@arforge-ai/core/runtime/native-action"
import { executeNative } from "./native-action-bridge"
import { requireNativeStorePart, requireNativeStoreValue } from "./native-input"
import { StoreTransfers } from "./store-transfer"
import { registerStoreTransferIpc } from "./store-transfer-ipc"
import { StoreMutationCoordinator } from "./store-mutation"
import { createDesktopStoreWriter } from "../preload/store-write"
import { createDesktopStorage } from "../renderer/storage-queue"
import { STORE_CHUNK_LENGTH, STORE_INLINE_LENGTH, STORE_MAX_VALUE_LENGTH } from "../shared/store-transfer"
import {
  normalizePromptHistoryEntry,
  prependHistoryEntry,
  type PromptHistoryStoredEntry,
} from "../../../app/src/components/prompt-input/history"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const storeName = "arforge.global.dat"
const storeKey = "prompt-history"

function fixture(transfers = new StoreTransfers()) {
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const journal = createMemoryNativeActionJournal()
  const nativeActions = createNativeActionRuntime({ journal })
  const values = new Map<string, string>()
  const coordinator = new StoreMutationCoordinator()
  const frames: { channel: string; bytes: number }[] = []
  let writes = 0
  let failure: Error | undefined
  const write = (name: string, key: string, value: string) =>
    coordinator.run(name, () => {
      if (failure) {
        const error = failure
        failure = undefined
        throw error
      }
      values.set(name + ":" + key, value)
      writes++
    })
  const ipc: Pick<IpcMain, "handle"> = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
  }
  registerStoreTransferIpc(ipc, { nativeActions, write, transfers })
  ipc.handle("store-set", (event, name, key, value) => {
    const checkedName = requireNativeStorePart("store name", name)
    const checkedKey = requireNativeStorePart("store key", key)
    const checked = requireNativeStoreValue(value)
    return executeNative(
      nativeActions,
      event,
      NativeActionKind.filesystem,
      "store-set",
      { name: checkedName, key: checkedKey, value: checked },
      () => write(checkedName, checkedKey, checked),
    )
  })
  class Sender extends EventEmitter {
    destroyed = false
    constructor(readonly id: number) {
      super()
    }
    isDestroyed() {
      return this.destroyed
    }
    send() {}
    destroy() {
      this.destroyed = true
      this.emit("destroyed")
    }
  }
  function client(id: number) {
    const sender = new Sender(id)
    const invoke = async (channel: string, ...args: unknown[]) => {
      frames.push({ channel, bytes: Buffer.byteLength(JSON.stringify(args)) })
      const handler = handlers.get(channel)
      if (!handler) throw new Error("Unknown fixture channel")
      return handler({ sender } as unknown as IpcMainInvokeEvent, ...args)
    }
    const writer = createDesktopStoreWriter({
      set: (name, key, value) => invoke("store-set", name, key, value),
      begin: (name, key, length) => invoke("store-write-begin", name, key, length),
      chunk: (id, index, value) => invoke("store-write-chunk", id, index, value),
      commit: (id) => invoke("store-write-commit", id),
      abort: (id) => invoke("store-write-abort", id),
    })
    const storage = createDesktopStorage(storeName, {
      storeSet: writer,
      storeGet: async (name, key) => values.get(name + ":" + key) ?? null,
      storeDelete: async (name, key) => {
        values.delete(name + ":" + key)
      },
      storeClear: async (name) => {
        for (const key of values.keys()) if (key.startsWith(name + ":")) values.delete(key)
      },
      storeKeys: async (name) =>
        [...values.keys()].filter((key) => key.startsWith(name + ":")).map((key) => key.slice(name.length + 1)),
      storeLength: async (name) => [...values.keys()].filter((key) => key.startsWith(name + ":")).length,
    })
    return { sender, invoke, writer, storage }
  }
  return {
    client,
    values,
    frames,
    journal,
    transfers,
    writes: () => writes,
    failNext: (error: Error) => {
      failure = error
    },
    read: () => values.get(storeName + ":" + storeKey),
  }
}

describe("bounded desktop store transfer", () => {
  test("reproduces both existing size boundaries without printing stored content", () => {
    expect(() => requireNativeStoreValue("x".repeat(2_231_990))).toThrow("Invalid store value")
    expect(() =>
      createNativeActionRequest({
        senderID: 1,
        kind: NativeActionKind.filesystem,
        name: "store-set",
        payload: { name: storeName, key: storeKey, value: requireNativeStoreValue("x".repeat(70_000)) },
      }),
    ).toThrow("native action input is too large")
  })

  test("round-trips oversized legacy image history after a safe new prompt, preserving Up recall", async () => {
    const ctx = fixture()
    const client = ctx.client(1)
    const image = "data:image/png;base64," + "A".repeat(2_231_990)
    const legacy: PromptHistoryStoredEntry[] = [
      [{ type: "image", id: "fixture-image", filename: "fixture.png", mime: "image/png", dataUrl: image }],
    ]
    const old = JSON.stringify({ entries: legacy })
    ctx.values.set(storeName + ":" + storeKey, old)
    expect((await client.storage.getItem(storeKey)) === old).toBe(true)
    const entries = prependHistoryEntry(legacy, [{ type: "text", content: "safe no-tool fixture", start: 0, end: 20 }])
    const next = JSON.stringify({ entries })
    await client.storage.setItem(storeKey, next)
    const restored = JSON.parse((await client.storage.getItem(storeKey))!) as { entries: PromptHistoryStoredEntry[] }
    expect(hash(ctx.read()!)).toBe(hash(next))
    expect(restored.entries).toHaveLength(2)
    const recalled = normalizePromptHistoryEntry(restored.entries[1]).prompt[0]
    expect(recalled.type).toBe("image")
    expect(recalled.type === "image" && hash(recalled.dataUrl) === hash(image)).toBe(true)
    expect(ctx.writes()).toBe(1)
    expect(await client.storage.getLength()).toBe(1)
    expect(await client.storage.key(0)).toBe(storeKey)
    expect(Math.max(...ctx.frames.map((frame) => frame.bytes))).toBeLessThan(512 * 1024)
    const receipts = await ctx.journal.load()
    expect(receipts.some((item) => item.name === "store-write-commit" && item.state === "settled")).toBe(true)
    expect(JSON.stringify(receipts).includes("data:image")).toBe(false)
  })

  test("keeps worst-case escaped inline frames within the Core bound and larger frames on the bounded path", async () => {
    const ctx = fixture()
    const client = ctx.client(1)
    for (const length of [0, STORE_INLINE_LENGTH, STORE_INLINE_LENGTH + 1, STORE_CHUNK_LENGTH + 1]) {
      const value = "\u0000".repeat(length)
      await client.writer(storeName, storeKey, value)
      expect(hash(ctx.read()!)).toBe(hash(value))
    }
    expect(Math.max(...ctx.frames.map((frame) => frame.bytes))).toBeLessThan(512 * 1024)
  })

  test("preserves Unicode and surrogate pairs across frame boundaries exactly", async () => {
    const ctx = fixture()
    const value = "a".repeat(STORE_CHUNK_LENGTH - 1) + "😀中文\ud800\u0000"
    await ctx.client(1).writer(storeName, storeKey, value)
    expect(ctx.read() === value).toBe(true)
  })

  test("does not publish incomplete chunks and rejects duplicate, reordered and oversized frames", async () => {
    const ctx = fixture()
    const client = ctx.client(1)
    await client.writer(storeName, storeKey, "prior")
    const id = await client.invoke("store-write-begin", storeName, storeKey, STORE_CHUNK_LENGTH + 1)
    await expect(client.invoke("store-write-chunk", id, 1, "a".repeat(STORE_CHUNK_LENGTH))).rejects.toThrow()
    await expect(client.invoke("store-write-chunk", id, 0, "a".repeat(STORE_CHUNK_LENGTH + 1))).rejects.toThrow()
    await client.invoke("store-write-chunk", id, 0, "a".repeat(STORE_CHUNK_LENGTH))
    await expect(client.invoke("store-write-chunk", id, 0, "a".repeat(STORE_CHUNK_LENGTH))).rejects.toThrow()
    await expect(client.invoke("store-write-commit", id)).rejects.toThrow("Incomplete")
    expect(ctx.read()).toBe("prior")
    expect(ctx.writes()).toBe(1)
    await client.invoke("store-write-abort", id)
  })

  test("binds transfers to the sender and isolates concurrent window commits", async () => {
    const ctx = fixture()
    const a = ctx.client(1),
      b = ctx.client(2)
    const id = await a.invoke("store-write-begin", storeName, storeKey, 3)
    await expect(b.invoke("store-write-chunk", id, 0, "bad")).rejects.toThrow()
    await expect(b.invoke("store-write-commit", id)).rejects.toThrow()
    await expect(b.invoke("store-write-abort", id)).rejects.toThrow()
    await a.invoke("store-write-chunk", id, 0, "one")
    await b.writer(storeName, storeKey, "two".repeat(30_000))
    const previous = ctx.read()
    expect((await b.storage.getItem(storeKey)) === previous).toBe(true)
    await a.invoke("store-write-commit", id)
    expect(await b.storage.getItem(storeKey)).toBe("one")
    await expect(a.invoke("store-write-commit", id)).rejects.toThrow()
  })

  test("recovers from a failed commit without deleting the old value or blocking the next queued mutation", async () => {
    const ctx = fixture()
    const client = ctx.client(1)
    await client.storage.setItem(storeKey, "prior")
    ctx.failNext(new Error("fixture permanent write failure"))
    await expect(client.storage.setItem(storeKey, "a".repeat(70_000))).rejects.toThrow(
      "fixture permanent write failure",
    )
    expect(ctx.read()).toBe("prior")
    await client.storage.setItem(storeKey, "b".repeat(70_000))
    expect(ctx.read()?.length).toBe(70_000)
    await client.storage.removeItem(storeKey)
    expect(ctx.read()).toBeUndefined()
    await client.storage.setItem(storeKey, "c".repeat(70_000))
    await client.storage.clear()
    expect(await client.storage.getLength()).toBe(0)
  })

  test("preserves the adapter queue across upload, delete and later writes", async () => {
    const ctx = fixture(),
      client = ctx.client(1)
    const first = client.storage.setItem(storeKey, "a".repeat(70_000))
    const remove = client.storage.removeItem(storeKey)
    const next = client.storage.setItem(storeKey, "last")
    await Promise.all([first, remove, next])
    expect(ctx.read()).toBe("last")
    expect(ctx.writes()).toBe(2)
  })

  test("serializes concurrent large stores from one preload without exceeding the owner quota", async () => {
    const ctx = fixture(),
      client = ctx.client(1)
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => client.writer(storeName, `fixture-${index}`, "a".repeat(70_000))),
    )
    expect(ctx.writes()).toBe(8)
    expect(ctx.values.size).toBe(8)
    expect(client.sender.listenerCount("destroyed")).toBe(1)
  })

  test("releases owner staging after destruction and rejects old handles", async () => {
    const transfers = new StoreTransfers({ maxPendingLength: 20 })
    const ctx = fixture(transfers),
      a = ctx.client(1),
      b = ctx.client(2)
    const id = await a.invoke("store-write-begin", storeName, storeKey, 20)
    a.sender.destroy()
    await expect(a.invoke("store-write-commit", id)).rejects.toThrow("destroyed")
    const other = await b.invoke("store-write-begin", storeName, storeKey, 20)
    await b.invoke("store-write-abort", other)
    expect(ctx.writes()).toBe(0)
  })

  test("bounds staging, expiry, transfer counts, types, paths and namespaced keys", () => {
    let now = 0
    const transfers = new StoreTransfers({ now: () => now, ttlMs: 100, maxLength: 8, maxPendingLength: 8 })
    for (const name of ["../outside", "/absolute", "C:drive", "..", "."]) {
      expect(() => transfers.begin(1, name, storeKey, 1)).toThrow()
    }
    for (const length of [undefined, "1", -1, 0, 1.5, Number.NaN, 9]) {
      expect(() => transfers.begin(1, storeName, storeKey, length)).toThrow()
    }
    const id = transfers.begin(1, storeName, "session:fixture:prompt", 8)
    expect(() => transfers.begin(2, storeName, storeKey, 1)).toThrow("quota")
    now = 100
    expect(() => transfers.prepare(1, id)).toThrow("expired")
    const next = transfers.begin(2, storeName, storeKey, 8)
    transfers.abort(2, next)
    const counts = new StoreTransfers()
    const ids = Array.from({ length: 4 }, () => counts.begin(1, storeName, storeKey, 1))
    expect(() => counts.begin(1, storeName, storeKey, 1)).toThrow("quota")
    ids.forEach((id) => counts.abort(1, id))
  })

  test("rejects values beyond the explicit staging quota before any bridge operation", async () => {
    const ctx = fixture()
    await expect(ctx.client(1).writer(storeName, storeKey, "x".repeat(STORE_MAX_VALUE_LENGTH + 1))).rejects.toThrow(
      "staging quota",
    )
    expect(ctx.frames).toHaveLength(0)
    expect(ctx.writes()).toBe(0)
  })
})
