import { describe, expect, test } from "bun:test"
import { buildWindowsSandboxSpec } from "@/sandbox/windows-sandbox-spec"

const u16 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true)
const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true)
const i32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getInt32(offset, true)
const tableField = (bytes: Uint8Array, table: number, index: number) => {
  const vtable = table - i32(bytes, table)
  const offset = u16(bytes, vtable + 4 + index * 2)
  return offset === 0 ? undefined : table + offset
}
const offsetTarget = (bytes: Uint8Array, field: number) => field + u32(bytes, field)
const readString = (bytes: Uint8Array, position: number) => {
  const length = u32(bytes, position)
  return new TextDecoder().decode(bytes.subarray(position + 4, position + 4 + length))
}

describe("Windows SBOX FlatBuffer", () => {
  test("encodes explicit read-only dependencies in their own field without writable grants", () => {
    const bytes = buildWindowsSandboxSpec({
      roots: ["C:\\workspace"],
      readOnlyRoots: ["C:\\runtime", "C:\\runtime"],
      network: "none",
    })
    const root = u32(bytes, 0)
    const writable = offsetTarget(bytes, tableField(bytes, root, 7)!)
    expect(u32(bytes, writable)).toBe(1)
    expect(readString(bytes, offsetTarget(bytes, writable + 4))).toBe("C:\\workspace")
    const readable = offsetTarget(bytes, tableField(bytes, root, 8)!)
    expect(u32(bytes, readable)).toBe(1)
    expect(readString(bytes, offsetTarget(bytes, readable + 4))).toBe("C:\\runtime")
    expect(() =>
      buildWindowsSandboxSpec({ roots: ["C:\\workspace"], readOnlyRoots: ["bad\0path"], network: "none" }),
    ).toThrow(/NUL/iu)
  })

  test("encodes required identity, roots and deny-by-default network policy", () => {
    const bytes = buildWindowsSandboxSpec({
      roots: ["C:\\workspace", "C:\\workspace\\src", "C:\\workspace"],
      network: "none",
    })
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe("SBOX")

    const root = u32(bytes, 0)
    expect(readString(bytes, offsetTarget(bytes, tableField(bytes, root, 0)!))).toBe("0.1.0")
    expect(bytes[tableField(bytes, root, 1)!]).toBe(1)

    const vector = offsetTarget(bytes, tableField(bytes, root, 7)!)
    expect(u32(bytes, vector)).toBe(2)
    const first = vector + 4
    const second = first + 4
    expect(readString(bytes, offsetTarget(bytes, first))).toBe("C:\\workspace")
    expect(readString(bytes, offsetTarget(bytes, second))).toBe("C:\\workspace\\src")

    const network = offsetTarget(bytes, tableField(bytes, root, 9)!)
    const endpoint = offsetTarget(bytes, tableField(bytes, network, 1)!)
    expect(bytes[tableField(bytes, endpoint, 0)!]).toBe(0)
  })

  test("encodes allow-by-default network policy only when requested", () => {
    const bytes = buildWindowsSandboxSpec({ roots: ["C:\\workspace"], network: "inherit" })
    const root = u32(bytes, 0)
    const network = offsetTarget(bytes, tableField(bytes, root, 9)!)
    const endpoint = offsetTarget(bytes, tableField(bytes, network, 1)!)
    expect(bytes[tableField(bytes, endpoint, 0)!]).toBe(1)
  })

  test("rejects empty or NUL-containing roots before building policy bytes", () => {
    expect(() => buildWindowsSandboxSpec({ roots: ["", "  "], network: "none" })).toThrow(
      /at least one approved root/iu,
    )
    expect(() => buildWindowsSandboxSpec({ roots: ["C:\\ok\0bad"], network: "none" })).toThrow(/NUL/iu)
  })
})
