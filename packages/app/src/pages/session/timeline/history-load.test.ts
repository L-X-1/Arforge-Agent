import { expect, test } from "bun:test"
import { createHistoryLoadGuard } from "./history-load"

test("automatic failure is owned once, blocks repeated fills and permits an explicit retry", async () => {
  const guard = createHistoryLoadGuard()
  const failure = new Error("Transport")
  let reads = 0,
    notices = 0,
    fail = true
  const input = {
    key: "1:owned",
    current: () => true,
    automatic: true,
    load: async () => {
      reads++
      if (fail) throw failure
    },
    onError: (error: unknown) => {
      expect(error).toBe(failure)
      notices++
    },
  }
  expect(await guard.run(input)).toBe(false)
  expect(guard.has(input.key)).toBe(false)
  expect(await guard.run(input)).toBe(false)
  expect(reads).toBe(1)
  expect(notices).toBe(1)
  fail = false
  expect(await guard.run({ ...input, automatic: false })).toBe(true)
  expect(await guard.run(input)).toBe(true)
  expect(reads).toBe(3)
})

test("concurrent scroll and fill callbacks share one in-flight request", async () => {
  const guard = createHistoryLoadGuard()
  const pending = Promise.withResolvers<void>()
  let reads = 0
  const input = {
    key: "1:owned",
    current: () => true,
    automatic: true,
    load: () => {
      reads++
      return pending.promise
    },
    onError: () => {
      throw new Error("unexpected")
    },
  }
  const first = guard.run(input)
  expect(guard.has(input.key)).toBe(true)
  expect(await guard.run(input)).toBe(false)
  pending.resolve()
  expect(await first).toBe(true)
  expect(reads).toBe(1)
  expect(guard.has(input.key)).toBe(false)
})

test("a late failure cannot toast or block the replacement source", async () => {
  const guard = createHistoryLoadGuard()
  const pending = Promise.withResolvers<void>()
  let live = true,
    notices = 0
  const first = guard.run({
    key: "1:A",
    current: () => live,
    automatic: true,
    load: () => pending.promise,
    onError: () => notices++,
  })
  live = false
  pending.reject(new Error("Transport"))
  expect(await first).toBe(false)
  expect(notices).toBe(0)
  expect(
    await guard.run({
      key: "2:A",
      current: () => true,
      automatic: true,
      load: async () => {},
      onError: () => notices++,
    }),
  ).toBe(true)
  expect(notices).toBe(0)
})

test("a source retired before dispatch cannot read history", async () => {
  const guard = createHistoryLoadGuard()
  let reads = 0
  expect(
    await guard.run({
      key: "1:A",
      current: () => false,
      automatic: false,
      load: async () => {
        reads++
      },
      onError: () => {},
    }),
  ).toBe(false)
  expect(reads).toBe(0)
})
