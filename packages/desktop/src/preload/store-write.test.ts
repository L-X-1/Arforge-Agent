import { describe, expect, test } from "bun:test"
import { createDesktopStoreWriter } from "./store-write"
import { STORE_INLINE_LENGTH, STORE_MAX_VALUE_LENGTH, type StoreWriteBridge } from "../shared/store-transfer"

function fixture(
  options: {
    commit?: () => Promise<void>
    set?: () => Promise<void>
  } = {},
) {
  const events: string[] = []
  const staged = new Map<string, string>()
  let current = "prior"
  let sequence = 0
  const bridge: StoreWriteBridge = {
    set: async (_name, _key, value) => {
      events.push("inline:start")
      await options.set?.()
      current = value
      events.push("inline:end")
    },
    begin: async () => {
      const id = String(++sequence)
      staged.set(id, "")
      events.push("large:begin")
      return id
    },
    chunk: async (id, _index, value) => {
      staged.set(id, staged.get(id)! + value)
    },
    commit: async (id) => {
      events.push("large:commit-start")
      await options.commit?.()
      current = staged.get(id)!
      staged.delete(id)
      events.push("large:commit-end")
    },
    abort: async (id) => {
      staged.delete(id)
      events.push("large:abort")
    },
  }
  return { write: createDesktopStoreWriter(bridge), events, value: () => current }
}

describe("preload store writer sequencing", () => {
  test("a newer inline write waits for an older delayed large commit on the same key", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const ctx = fixture({
      commit: async () => {
        started.resolve()
        await release.promise
      },
    })
    const first = ctx.write("fixture.dat", "history", "a".repeat(STORE_INLINE_LENGTH + 1))
    await started.promise
    const next = ctx.write("fixture.dat", "history", "newer small value")
    await Promise.resolve()
    release.resolve()
    await Promise.all([first, next])
    expect(ctx.value() === "newer small value").toBe(true)
    expect(ctx.events).toEqual(["large:begin", "large:commit-start", "large:commit-end", "inline:start", "inline:end"])
  })

  test("a newer large write waits for an older delayed inline write on the same key", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const ctx = fixture({
      set: async () => {
        started.resolve()
        await release.promise
      },
    })
    const first = ctx.write("fixture.dat", "history", "older small value")
    await started.promise
    const newer = "b".repeat(STORE_INLINE_LENGTH + 1)
    const next = ctx.write("fixture.dat", "history", newer)
    // Wait long enough for an incorrectly independent large transfer to reach
    // its commit, without timers or real storage.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    release.resolve()
    await Promise.all([first, next])
    expect(ctx.value() === newer).toBe(true)
    expect(ctx.events).toEqual(["inline:start", "inline:end", "large:begin", "large:commit-start", "large:commit-end"])
  })

  test("an inline rejection retains its error and does not poison a queued large write", async () => {
    const failure = new Error("fixture inline write failed")
    const ctx = fixture({
      set: async () => {
        throw failure
      },
    })
    const failed = ctx.write("fixture.dat", "history", "small")
    const next = ctx.write("fixture.dat", "history", "c".repeat(STORE_INLINE_LENGTH + 1))
    await expect(failed).rejects.toBe(failure)
    await next
    expect(ctx.value().length).toBe(STORE_INLINE_LENGTH + 1)
    expect(ctx.events).toEqual(["inline:start", "large:begin", "large:commit-start", "large:commit-end"])
  })

  test("a staging quota rejection leaves the value intact and permits the next inline write", async () => {
    const ctx = fixture()
    const failed = ctx.write("fixture.dat", "history", "x".repeat(STORE_MAX_VALUE_LENGTH + 1))
    const next = ctx.write("fixture.dat", "history", "latest")
    await expect(failed).rejects.toThrow("staging quota")
    await next
    expect(ctx.value()).toBe("latest")
    expect(ctx.events).toEqual(["inline:start", "inline:end"])
  })
})
