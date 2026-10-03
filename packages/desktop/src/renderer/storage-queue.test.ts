import { describe, expect, test } from "bun:test"
import { createDesktopStorage, createStorageMutationQueue } from "./storage-queue"

describe("createStorageMutationQueue", () => {
  test("keeps desktop store mutations ordered and recovers after rejection", async () => {
    const enqueue = createStorageMutationQueue()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = enqueue(async () => {
      order.push("first:start")
      await gate
      order.push("first:end")
    })
    const second = enqueue(async () => {
      order.push("second")
      return 2
    })
    await Bun.sleep(0)
    expect(order).toEqual(["first:start"])
    release()
    expect(await second).toBe(2)
    await first
    expect(order).toEqual(["first:start", "first:end", "second"])

    await expect(enqueue(() => Promise.reject(new Error("failed")))).rejects.toThrow("failed")
    await enqueue(async () => {
      order.push("after-failure")
    })
    expect(order.at(-1)).toBe("after-failure")
  })
})

describe("createDesktopStorage", () => {
  test("treats nullish serialized values as removal", async () => {
    const calls: string[] = []
    const storage = createDesktopStorage("state.dat", {
      storeGet: async () => null,
      storeSet: async (name, key, value) => {
        calls.push(`set:${name}:${key}:${value}`)
      },
      storeDelete: async (name, key) => {
        calls.push(`delete:${name}:${key}`)
      },
      storeClear: async () => {},
      storeKeys: async () => [],
      storeLength: async () => 0,
    })

    await storage.setItem("prompt", undefined as unknown as string)
    await storage.setItem("model", null as unknown as string)

    expect(calls).toEqual(["delete:state.dat:prompt", "delete:state.dat:model"])
  })

  test("persists strings and rejects other runtime values", async () => {
    const calls: string[] = []
    const storage = createDesktopStorage("state.dat", {
      storeGet: async () => null,
      storeSet: async (name, key, value) => {
        calls.push(`set:${name}:${key}:${value}`)
      },
      storeDelete: async () => {},
      storeClear: async () => {},
      storeKeys: async () => [],
      storeLength: async () => 0,
    })

    await storage.setItem("prompt", '{"text":"hello"}')
    await storage.setItem("empty", "")
    await expect(storage.setItem("prompt", {} as unknown as string)).rejects.toThrow("Invalid desktop store value")

    expect(calls).toEqual(['set:state.dat:prompt:{"text":"hello"}', "set:state.dat:empty:"])
  })
})
