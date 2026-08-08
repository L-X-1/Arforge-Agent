import { describe, expect, test } from "bun:test"
import path from "path"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SkillV2 } from "@arforge-ai/core/skill"
import { SkillRouting } from "@arforge-ai/core/skill/routing"

describe("SkillRouting", () => {
  test("keeps simple non-development requests direct", () => {
    expect(SkillRouting.route("What is the capital of France?")).toEqual({
      mode: "direct",
      selected: [],
      capabilities: [],
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

  test("routes frontend visual work to the design-taste capability", () => {
    const result = SkillRouting.route(
      "请为设计工作室创建一个高端作品集网站并完成前端设计。",
      new Set([...SkillRouting.developmentSkillOrder, "design-taste-frontend"]),
    )
    expect(result.capabilities).toEqual(["design-taste-frontend"])
  })

  test("routes image tasks to vision-tools regardless of coding terms", () => {
    const result = SkillRouting.route(
      "这张截图里有什么？请识别并描述里面的报错信息。",
      new Set([...SkillRouting.developmentSkillOrder, "vision-tools"]),
    )
    expect(result.selected).toEqual([])
    expect(result.capabilities).toEqual(["vision-tools"])
  })

  test("does not select capability skills that are unavailable", () => {
    const result = SkillRouting.route("请重新设计这个页面。", new Set(["openspec"]))
    expect(result.capabilities).toEqual([])
  })

  test("render injects capability skills after the development route", () => {
    const skills = [
      SkillV2Info("openspec", "Executable specifications"),
      SkillV2Info("superpowers", "Disciplined delivery"),
      SkillV2Info("design-taste-frontend", "Anti-slop frontend"),
      SkillV2Info("vision-tools", "Local vision CLIs"),
    ]
    const rendered = SkillRouting.render(
      "请做一个落地页并重新设计这个网站，同时看看这张设计稿截图。",
      skills,
    ) ?? ""
    expect(rendered).toContain("## Automatic Development Skill Route")
    expect(rendered).toContain("Activated skills: openspec, superpowers")
    expect(rendered).toContain("Activated capability skills: design-taste-frontend, vision-tools")
    expect(rendered).toContain('<skill id="design-taste-frontend">')
    expect(rendered).toContain('<skill id="vision-tools">')
    expect(rendered.indexOf('<skill id="superpowers">')).toBeLessThan(
      rendered.indexOf('<skill id="design-taste-frontend">'),
    )
  })

  test("render stays direct when neither development nor capability skills match", () => {
    expect(SkillRouting.render("What is the capital of France?", [])).toBeUndefined()
  })
})

function SkillV2Info(name: string, description: string) {
  return SkillV2.Info.make({
    name,
    description,
    location: AbsolutePath.make(path.resolve(`/skills/${name}/SKILL.md`)),
    content: `# ${name}\nUse ${name} faithfully.`,
  })
}
