import { expect, test } from "bun:test"
import { configureConsoleTransport, type ConsoleTransport } from "./logging-console"

type TestTransport = ConsoleTransport<Record<string, never>>

test("disables the console transport for packaged GUI processes", () => {
  let writes = 0
  const transport: TestTransport = {
    level: "info",
    writeFn: () => {
      writes += 1
    },
  }

  configureConsoleTransport(transport, true)

  expect(transport.level).toBe(false)
  transport.writeFn({})
  expect(writes).toBe(1)
})

test("keeps development console output enabled", () => {
  let writes = 0
  const transport: TestTransport = {
    level: "info",
    writeFn: () => {
      writes += 1
    },
  }

  configureConsoleTransport(transport, false)
  transport.writeFn({})

  expect(transport.level).toBe("info")
  expect(writes).toBe(1)
})
