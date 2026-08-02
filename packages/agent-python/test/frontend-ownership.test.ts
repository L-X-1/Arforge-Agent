import { describe, expect, test } from "bun:test"
import { BRIDGE_FRONTEND_OWNERSHIP, mappedBridgeMethods } from "../src/frontend-ownership"
import { MANAGEMENT_METHODS, READ_ONLY_METHODS } from "../src/protocol"

describe("Python Bridge frontend ownership", () => {
  test("classifies every callable method exactly once", () => {
    const callable = [...READ_ONLY_METHODS, ...MANAGEMENT_METHODS].sort()
    const mapped = mappedBridgeMethods()
    expect([...mapped].sort()).toEqual(callable)
    expect(new Set(mapped).size).toBe(mapped.length)
  })

  test("requires a typed replacement for every user-semantic Bridge capability", () => {
    for (const entry of BRIDGE_FRONTEND_OWNERSHIP) {
      if (entry.kind === "transport-internal") {
        expect(entry.surface).toBe("transport")
        expect(entry.replacement).toEqual([])
        continue
      }
      expect(entry.replacement.length).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })

  test("keeps transport exemptions narrow and explicit", () => {
    const internal = BRIDGE_FRONTEND_OWNERSHIP.filter((entry) => entry.kind === "transport-internal")
    expect(internal).toHaveLength(1)
    expect(internal[0]?.methods).toEqual(["protocol.describe"])
  })
})
