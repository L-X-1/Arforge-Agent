import { describe, expect, test } from "bun:test"
import { StoreMutationCoordinator, isRetryableStoreError, retryStoreMutation } from "./store-mutation"

describe("retryStoreMutation", () => {
  test("retries transient Windows rename failures", async () => {
    let attempts = 0
    await retryStoreMutation(
      () => {
        attempts++
        if (attempts < 3) throw Object.assign(new Error("rename blocked"), { code: "EPERM" })
      },
      [0, 0],
    )
    expect(attempts).toBe(3)
  })

  test("does not mask permanent errors", async () => {
    const error = Object.assign(new Error("invalid path"), { code: "EINVAL" })
    expect(isRetryableStoreError(error)).toBe(false)
    expect(retryStoreMutation(() => Promise.reject(error), [0])).rejects.toBe(error)
  })
})

describe("StoreMutationCoordinator", () => {
  test("serializes writes to one store while allowing later writes after a failure", async () => {
    const coordinator = new StoreMutationCoordinator()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = coordinator.run("draft", async () => {
      order.push("first:start")
      await gate
      order.push("first:end")
    })
    const second = coordinator.run("draft", () => {
      order.push("second")
    })
    await Bun.sleep(0)
    expect(order).toEqual(["first:start"])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["first:start", "first:end", "second"])

    await expect(
      coordinator.run("draft", () => {
        throw new Error("failed write")
      }),
    ).rejects.toThrow("failed write")
    await coordinator.run("draft", () => {
      order.push("after-failure")
    })
    expect(order.at(-1)).toBe("after-failure")
  })
})
