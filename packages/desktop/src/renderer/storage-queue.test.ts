import { describe, expect, test } from "bun:test"
import { createStorageMutationQueue } from "./storage-queue"

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
