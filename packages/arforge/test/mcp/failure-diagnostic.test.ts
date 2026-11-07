import { expect, test } from "bun:test"
import { Cause } from "effect"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { McpFailureDiagnostic } from "../../src/mcp/failure-diagnostic"

const bundle = pathToFileURL(resolve("owned-fixture/server/node.js")).href
const secret = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG"

test("keeps only known name/code and exact own-bundle frame positions", () => {
  const error = Object.assign(new Error(secret), { name: "McpError", code: -32601 })
  error.stack = `${secret}\n    at ${secret} (${bundle}:123:45)\n    at x (https://example.invalid/server/node.js:8:9?token=${secret})\n    at x (/private/${secret}/other.js:4:5)`
  expect(McpFailureDiagnostic.fromCause(Cause.fail(error), bundle)).toEqual({
    causeKind: "failure",
    interrupted: false,
    errorName: "McpError",
    category: "json-rpc",
    code: -32601,
    ownedFrames: ["node.js:123:45"],
  })
})

test("drops arbitrary name/code, paths, queries, response bodies and first stack line", () => {
  const error = Object.assign(new Error(JSON.stringify({ access_token: secret })), { name: secret, code: secret })
  error.stack = `Error ${secret}\n    at x (https://example.invalid/?token=${secret}:1:2)\n    at x (/private/${secret}/node.js:3:4)`
  const result = McpFailureDiagnostic.fromCause(Cause.die(error), bundle)
  expect(result.errorName).toBe("Error")
  expect(result.ownedFrames).toEqual([])
  expect(JSON.stringify(result)).not.toContain(secret)
})

test("does not invoke supplied getters or inspect a Proxy", () => {
  let reads = 0
  const error = new Error(secret)
  for (const key of ["name", "code", "status", "stack", "message"])
    Object.defineProperty(error, key, {
      configurable: true,
      get() {
        reads++
        throw new Error(secret)
      },
    })
  const result = McpFailureDiagnostic.fromCause(Cause.fail(error), bundle)
  const proxy = new Proxy(error, {
    getOwnPropertyDescriptor() {
      reads++
      throw new Error(secret)
    },
  })
  expect(McpFailureDiagnostic.fromCause(Cause.fail(proxy), bundle).errorName).toBe("UnknownError")
  expect(reads).toBe(0)
  expect(JSON.stringify(result)).not.toContain(secret)
})

test("preserves interruption classification without fiber IDs or arbitrary data", () => {
  expect(McpFailureDiagnostic.fromCause(Cause.interrupt(7351), bundle)).toMatchObject({
    causeKind: "interrupt",
    interrupted: true,
    category: "interruption",
    ownedFrames: [],
  })
  expect(
    McpFailureDiagnostic.fromCause(Cause.combine(Cause.interrupt(7351), Cause.fail(new TypeError(secret))), bundle),
  ).toMatchObject({ causeKind: "mixed", interrupted: true, errorName: "TypeError" })
})

test("accepts only registered HTTP and JSON-RPC numeric codes", () => {
  expect(McpFailureDiagnostic.fromCause(Cause.fail(Object.assign(new Error(), { status: 503 })), bundle)).toMatchObject(
    { code: 503, category: "http" },
  )
  expect(
    McpFailureDiagnostic.fromCause(Cause.fail(Object.assign(new Error(), { code: -99999 })), bundle).code,
  ).toBeUndefined()
})

test("does not read prototype accessors while formatting native stacks", () => {
  let reads = 0
  const error = new Error(secret)
  Object.setPrototypeOf(
    error,
    Object.create(Error.prototype, {
      name: {
        get() {
          reads++
          return secret
        },
      },
    }),
  )
  const result = McpFailureDiagnostic.fromCause(Cause.fail(error), bundle)
  expect(result.ownedFrames).toEqual([])
  expect(reads).toBe(0)
})

test("does not coerce object, function or nested Proxy name/message values", () => {
  for (const key of ["name", "message"]) {
    for (const kind of ["object", "function", "proxy"]) {
      let calls = 0
      const coerce = () => {
        calls++
        return secret
      }
      const value =
        kind === "proxy"
          ? new Proxy({}, { get: coerce })
          : Object.defineProperty(kind === "function" ? () => secret : {}, Symbol.toPrimitive, { value: coerce })
      const error = new Error(secret)
      Object.defineProperty(error, key, { value, configurable: true })
      const result = McpFailureDiagnostic.fromCause(Cause.fail(error), bundle)
      expect(calls).toBe(0)
      expect(result.ownedFrames).toEqual([])
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  }
})
