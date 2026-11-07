import { expect, test } from "bun:test"
import { createLogExportAction } from "./log-export-action"

test("registered export failure becomes visible feedback with a retry through the same owner", async () => {
  const failure = Object.assign(new Error("owned Downloads path unavailable"), { code: "ENOENT" })
  let calls = 0,
    retry: (() => void) | undefined
  const notifications: string[] = []
  const run = createLogExportAction({
    exportLogs: async () => {
      if (++calls === 1) throw failure
      return "owned.zip"
    },
    active: () => true,
    notify: (result) => {
      notifications.push(result.type)
      if (result.type === "error") {
        expect(result.error).toBe(failure)
        retry = result.retry
      }
    },
  })
  await run()
  expect(notifications).toEqual(["error"])
  expect(retry).toBeFunction()
  retry!()
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(2)
  expect(notifications).toEqual(["error", "success"])
})

test("closing the owner suppresses late error feedback and cannot retry a disposed export", async () => {
  let reject!: (error: Error) => void,
    active = true,
    notifications = 0,
    calls = 0
  const run = createLogExportAction({
    exportLogs: () => {
      calls++
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    },
    active: () => active,
    notify: () => {
      notifications++
    },
  })
  const pending = run()
  active = false
  reject(new Error("owned failure"))
  await pending
  await run()
  expect(notifications).toBe(0)
  expect(calls).toBe(1)
})
