import { describe, expect, test } from "bun:test"
import {
  isDefinition,
  PluginToolContractError,
  validateDefinition,
} from "@/tool/plugin-source-adapter"

describe("PluginToolSource typed handler boundary", () => {
  test("keeps the legacy undefined-args shorthand while requiring a bounded description and callable handler", () => {
    const definition = {
      description: "legacy no-args tool",
      args: undefined,
      execute: async () => "ok",
    }
    expect(isDefinition(definition)).toBe(true)
    expect(validateDefinition(definition)).toBe(definition as never)
    expect(isDefinition({ ...definition, execute: "not callable" })).toBe(false)
    expect(isDefinition({ ...definition, description: 42 })).toBe(false)
  })

  test("bounds discovered argument maps without changing the canonical Core adapter", () => {
    const args = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`arg_${index}`, {}]))
    expect(() => validateDefinition({ description: "too many args", args, execute: async () => "ok" })).toThrow(
      PluginToolContractError,
    )
    expect(() => validateDefinition({ description: "x", args: [], execute: async () => "ok" })).toThrow(
      PluginToolContractError,
    )
  })
})
