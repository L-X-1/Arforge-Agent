import { describe, expect, test } from "bun:test"
import { canonicalHash, canonicalJson } from "@arforge-ai/core/util/canonical-hash"

describe("canonical input hashing", () => {
  test("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }))
    expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]))
  })

  test("undefined object fields do not collide with omitted fields", () => {
    expect(canonicalJson({ x: undefined })).not.toBe(canonicalJson({}))
    expect(canonicalJson({ x: undefined })).not.toBe(canonicalJson({ x: null }))
  })

  test("Dates do not collide with equal ISO strings", () => {
    const iso = "2026-08-09T00:00:00.000Z"
    expect(canonicalJson(new Date(iso))).not.toBe(canonicalJson(iso))
  })

  test("binary does not collide with an equal base64 string", () => {
    const base64 = Buffer.from("hello").toString("base64")
    expect(canonicalJson(Buffer.from("hello"))).not.toBe(canonicalJson(base64))
  })

  test("negative zero does not collide with positive zero", () => {
    expect(canonicalJson(-0)).not.toBe(canonicalJson(0))
  })

  test("preserves value types across distinct representations", () => {
    expect(canonicalJson("1")).not.toBe(canonicalJson(1))
    expect(canonicalJson(true)).not.toBe(canonicalJson(1))
    expect(canonicalJson(null)).not.toBe(canonicalJson(0))
  })

  test("fails closed on non-canonicalizable values", () => {
    expect(canonicalJson(1n)).toBeUndefined()
    expect(canonicalJson(() => {})).toBeUndefined()
    expect(canonicalJson(Symbol("x"))).toBeUndefined()
    expect(canonicalJson(NaN)).toBeUndefined()
    expect(canonicalJson(Infinity)).toBeUndefined()
    expect(canonicalJson(new (class {})())).toBeUndefined()
    expect(canonicalHash({ nested: { fn: () => {} } })).toBeUndefined()
  })

  test("digest is deterministic for identical inputs", () => {
    const input = { path: "src/a.ts", oldString: "x", newString: "y", replaceAll: false }
    expect(canonicalHash(input)).toBe(canonicalHash({ ...input }))
    expect(canonicalHash(input)).toMatch(/^[0-9a-f]{64}$/)
  })
})
