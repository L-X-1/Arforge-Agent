import { Cause } from "effect"
import { STATUS_CODES } from "node:http"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"
import { types } from "node:util"

const stackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get
const names = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "McpError",
  "SseError",
  "AbortError",
  "TimeoutError",
  "UnauthorizedError",
])
const prototypes = new Map<object, string>([
  [Error.prototype, "Error"],
  [TypeError.prototype, "TypeError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [SyntaxError.prototype, "SyntaxError"],
  [URIError.prototype, "URIError"],
  [EvalError.prototype, "EvalError"],
  [AggregateError.prototype, "AggregateError"],
])
const rpcCodes = new Set([-32700, -32600, -32601, -32602, -32603, -32000, -32001, -32042])
const data = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value
const knownCode = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  (rpcCodes.has(value) || (value >= 400 && value <= 599 && STATUS_CODES[value] !== undefined))
    ? value
    : undefined

function stack(value: object): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, "stack")
  if (typeof descriptor?.value === "string") return descriptor.value
  if (!stackGetter || descriptor?.get !== stackGetter) return
  // Native formatting reads name/message. Never enter a supplied accessor or Proxy.
  let current: object | null = value
  for (let depth = 0; current && depth < 8; depth++) {
    if (types.isProxy(current)) return
    for (const key of ["name", "message"]) {
      const item = Object.getOwnPropertyDescriptor(current, key)
      if (item && (!("value" in item) || (item.value !== undefined && typeof item.value !== "string"))) return
    }
    current = Object.getPrototypeOf(current)
  }
  if (current) return
  const result: unknown = Reflect.apply(stackGetter, value, [])
  return typeof result === "string" ? result : undefined
}

function frames(value: string | undefined, bundle: string) {
  if (!value) return []
  const url = new URL(bundle)
  if (url.protocol !== "file:" || url.search || url.hash || basename(fileURLToPath(url)) !== "node.js") return []
  const allowed = new Set([url.href, fileURLToPath(url)])
  const result: string[] = []
  for (const line of value.split("\n").slice(1, 33)) {
    const match = /(?:\(|\s)(file:\/\/\/[^()]+|[A-Za-z]:[\\/][^()]+|\/[^()]+):(\d{1,9}):(\d{1,9})\)?$/.exec(line)
    if (match && allowed.has(match[1])) {
      result.push(`node.js:${Number(match[2])}:${Number(match[3])}`)
      if (result.length === 4) break
    }
  }
  return result
}

export function fromCause(cause: Cause.Cause<unknown>, bundle = import.meta.url) {
  try {
    let failed = false,
      died = false,
      interrupted = false,
      error: unknown
    for (const reason of cause.reasons.slice(0, 16)) {
      if (Cause.isFailReason(reason)) {
        failed = true
        error ??= reason.error
      }
      if (Cause.isDieReason(reason)) {
        died = true
        error ??= reason.defect
      }
      if (Cause.isInterruptReason(reason)) interrupted = true
    }
    const causeKind =
      Number(failed) + Number(died) + Number(interrupted) > 1
        ? "mixed"
        : interrupted
          ? "interrupt"
          : died
            ? "defect"
            : failed
              ? "failure"
              : "empty"
    let errorName = "UnknownError",
      code: number | undefined,
      ownedFrames: string[] = []
    if (typeof error === "object" && error !== null && !types.isProxy(error) && types.isNativeError(error)) {
      const ownName = data(error, "name")
      errorName =
        typeof ownName === "string" && names.has(ownName)
          ? ownName
          : (prototypes.get(Object.getPrototypeOf(error)) ?? "UnknownError")
      code = knownCode(data(error, "code")) ?? knownCode(data(error, "status"))
      ownedFrames = frames(stack(error), bundle)
    }
    return {
      causeKind,
      interrupted,
      errorName,
      category: interrupted
        ? "interruption"
        : code !== undefined
          ? code < 0
            ? "json-rpc"
            : "http"
          : errorName === "AbortError"
            ? "abort"
            : errorName === "TimeoutError"
              ? "timeout"
              : "unknown",
      code,
      ownedFrames,
    }
  } catch {
    return {
      causeKind: "unavailable",
      interrupted: false,
      errorName: "UnknownError",
      category: "unknown",
      code: undefined,
      ownedFrames: [],
    }
  }
}

export * as McpFailureDiagnostic from "./failure-diagnostic"
