import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { once } from "node:events"
import { observeLocalStartupError } from "../../src/mcp/transport-error"

test("classifies split startup errors without returning child output or credentials", () => {
  const stream = new PassThrough()
  const diagnostic = observeLocalStartupError(stream)
  stream.write("secret-value /private/path error: CouldntReadCurrent")
  expect(diagnostic.error()).toBeUndefined()
  stream.write("Directory\nsecret-after")
  const error = diagnostic.error()
  expect(error?.reason).toBe("current_directory")
  expect(error?.message).toContain("已授权")
  expect(JSON.stringify(error)).not.toContain("secret")
  expect(JSON.stringify(error)).not.toContain("/private/path")
  diagnostic.stop()
})

test("drains noisy stderr and finds a bounded diagnostic after a large chunk", () => {
  const stream = new PassThrough()
  const diagnostic = observeLocalStartupError(stream)
  stream.write(Buffer.alloc(512 * 1024, 120))
  stream.write("\nerror: Cannot find module '/private/token=secret'\n")
  expect(stream.readableLength).toBe(0)
  expect(diagnostic.error()?.reason).toBe("module_unavailable")
  expect(diagnostic.error()?.message).not.toContain("secret")
  diagnostic.stop()
})

test("preserves the first classified failure and discards arbitrary startup output", () => {
  const stream = new PassThrough()
  const diagnostic = observeLocalStartupError(stream)
  stream.write("arbitrary secret text\n")
  expect(diagnostic.error()).toBeUndefined()
  stream.write("error: CouldntReadCurrentDirectory\n")
  stream.write("Windows sandbox DeleteAppContainerProfile failed (HRESULT 0x80070005)\n")
  expect(diagnostic.error()?.reason).toBe("current_directory")
  diagnostic.stop()
})

test("releases startup classification but keeps stderr draining after connection", async () => {
  const stream = new PassThrough()
  const diagnostic = observeLocalStartupError(stream)
  expect(stream.listenerCount("data")).toBe(1)
  diagnostic.stop()
  diagnostic.stop()
  expect(stream.listenerCount("data")).toBe(0)
  const ended = once(stream, "end")
  stream.end("CouldntReadCurrentDirectory" + "x".repeat(512 * 1024))
  await ended
  expect(stream.readableLength).toBe(0)
  expect(diagnostic.error()).toBeUndefined()
})

test("native failures expose a fixed message rather than the child's error details", () => {
  const stream = new PassThrough()
  const diagnostic = observeLocalStartupError(stream)
  stream.write("Windows sandbox Experimental_CreateProcessInSandbox failed (Win32 error 50) secret")
  expect(diagnostic.error()?.reason).toBe("native_launch")
  expect(diagnostic.error()?.message).toContain("系统沙箱")
  expect(JSON.stringify(diagnostic.error())).not.toContain("secret")
  diagnostic.stop()
})

test("recognizes the Bun module-loading error without disclosing its path", () => {
  const stream = new PassThrough()
  const diagnostic = observeLocalStartupError(stream)
  stream.write("error: Module not found '/private/fixture-secret/server.mjs'\n")
  expect(diagnostic.error()?.reason).toBe("module_unavailable")
  expect(JSON.stringify(diagnostic.error())).not.toContain("fixture-secret")
  diagnostic.stop()
})

test("handles an absent stderr stream without inventing a diagnostic", () => {
  const diagnostic = observeLocalStartupError(null)
  expect(diagnostic.error()).toBeUndefined()
  expect(() => diagnostic.stop()).not.toThrow()
})
