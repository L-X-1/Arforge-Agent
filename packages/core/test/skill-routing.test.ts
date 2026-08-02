import { describe, expect, test } from "bun:test"
import { SkillRouting } from "@arforge-ai/core/skill/routing"

describe("SkillRouting", () => {
  test("keeps simple non-development requests direct", () => {
    expect(SkillRouting.route("What is the capital of France?")).toEqual({
      mode: "direct",
      selected: [],
      reasons: {},
    })
  })

  test("routes a focused bug to Superpowers only", () => {
    expect(SkillRouting.route("Fix the crash in the parser").selected).toEqual(["superpowers"])
  })

  test("orders ambiguous material work from clarification through delivery", () => {
    const result = SkillRouting.route("I am not sure, help me design and implement a new database feature")
    expect(result.mode).toBe("clarify")
    expect(result.selected).toEqual(["grill-me", "openspec", "superpowers"])
  })

  test("adds durable organization only for long delivery", () => {
    const result = SkillRouting.route("Implement this complete project end-to-end across multiple packages")
    expect(result.mode).toBe("long_delivery")
    expect(result.selected).toEqual(["openspec", "trellis", "superpowers"])
  })

  test("honors availability and explicit skill requests", () => {
    const result = SkillRouting.route("Use Trellis to organize this", new Set(["trellis"]))
    expect(result.selected).toEqual(["trellis"])
  })
})
