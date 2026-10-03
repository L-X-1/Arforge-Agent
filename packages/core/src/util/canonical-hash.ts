import { createHash } from "node:crypto"

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const isBytes = (value: unknown): value is Uint8Array | ArrayBuffer =>
  value instanceof Uint8Array || value instanceof ArrayBuffer

type Node = unknown

/**
 * Deterministic canonical JSON for input hashing using explicit type-tagged
 * nodes, so distinct input values can never collide: `{x: undefined}` differs
 * from `{}`, a Date differs from an equal ISO string, bytes differ from an
 * equal base64 string, and `-0` differs from `0`. Object keys are sorted
 * recursively; array order and item positions are preserved. BigInt,
 * functions, symbols, NaN/Infinity, and non-plain objects are not
 * canonicalizable and yield undefined — callers must fail closed on that
 * signal and never hash a lossy representation of an untrusted input.
 */
export const canonicalJson = (value: unknown): string | undefined => {
  const canonical = (item: unknown): Node => {
    if (item === null) return ["null"]
    if (item === undefined) return ["undefined"]
    if (typeof item === "string") return ["string", item]
    if (typeof item === "boolean") return ["boolean", item]
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return undefined
      return ["number", Object.is(item, -0) ? "-0" : String(item)]
    }
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") return undefined
    if (item instanceof Date) return ["date", item.toISOString()]
    if (isBytes(item)) return ["binary", Buffer.from(item as Uint8Array).toString("base64")]
    if (Array.isArray(item)) {
      const items = item.map(canonical)
      if (items.some((entry) => entry === undefined)) return undefined
      return ["array", items]
    }
    if (isPlainObject(item)) {
      const entries: Array<[string, Node]> = []
      for (const [key, entry] of Object.entries(item)) {
        const canonicalEntry = canonical(entry)
        if (canonicalEntry === undefined) return undefined
        entries.push([key, canonicalEntry])
      }
      return ["object", entries.sort(([a], [b]) => a.localeCompare(b))]
    }
    return undefined
  }
  const result = canonical(value)
  if (result === undefined) return undefined
  return JSON.stringify(result)
}

export const canonicalHash = (value: unknown): string | undefined => {
  const json = canonicalJson(value)
  if (json === undefined) return undefined
  return createHash("sha256").update(json).digest("hex")
}
