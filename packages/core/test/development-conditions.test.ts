import { describe, expect, test } from "bun:test"
import { parseDevelopmentConditions } from "@arforge-ai/schema/development-conditions"

describe("development conditions", () => {
  test("extracts explicit delivery conditions from the workflow benchmark", () => {
    expect(parseDevelopmentConditions("Fix the function. Change only merge.mjs, run node visible-test.mjs, then report the change.")).toEqual({
      files: ["merge.mjs"],
      commands: ["node visible-test.mjs"],
    })
  })

  test("supports explicit localized lists without treating pasted code as requirements", () => {
    const prompt = [
      "改动范围：src\\merge.ts、`test/merge test.ts`",
      "验证命令：`bun test test/merge.test.ts`",
      "```text",
      "Allowed files: unrelated.ts",
      "run npm test",
      "```",
    ].join("\n")
    expect(parseDevelopmentConditions(prompt)).toEqual({
      files: ["src/merge.ts", "test/merge test.ts"],
      commands: ["bun test test/merge.test.ts"],
    })
  })

  test("does not narrow the review using ambiguous or conflicting file scopes", () => {
    expect(parseDevelopmentConditions("Change only the broken test.").files).toEqual([])
    expect(parseDevelopmentConditions("Allowed files: ../escape.ts").files).toEqual([])
    expect(parseDevelopmentConditions("Allowed files: first.ts\nAllowed files: second.ts").files).toEqual([])
  })

  test("honors both requested files and does not turn a prohibition into a check", () => {
    expect(parseDevelopmentConditions("Change only a.ts and b.ts. Do not run npm test.")).toEqual({
      files: ["a.ts", "b.ts"],
      commands: [],
    })
    expect(parseDevelopmentConditions("只修改 a.ts，不要运行 npm test。")).toEqual({
      files: ["a.ts"],
      commands: [],
    })
    expect(parseDevelopmentConditions("只修改 a.ts 和 b.ts，然后运行 bun test。")).toEqual({
      files: ["a.ts", "b.ts"],
      commands: ["bun test"],
    })
    expect(parseDevelopmentConditions("改动范围：合同.ts").files).toEqual(["合同.ts"])
  })
})
