import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { ManagedSkillRegistry } from "@arforge-ai/core/skill/managed"

function tempHome(): string {
  const home = join(tmpdir(), `arforge-managed-skills-${randomUUID().replace(/-/g, "")}`)
  mkdirSync(join(home, "skills"), { recursive: true })
  return home
}

function writeSkill(root: string, id: string, extra = ""): string {
  const dir = join(root, "skills", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\n" +
      `id: ${id}\n` +
      `name: ${id}\n` +
      "description: Integration test skill.\n" +
      "version: 1.0.0\n" +
      "license: LicenseRef-Proprietary\n" +
      `tags: [development, ${id}]\n` +
      "---\n" +
      `# ${id}\nUse ${id} faithfully.\n` +
      extra,
    "utf8",
  )
  return dir
}

describe("ManagedSkillRegistry", () => {
  test("discovers profile skills and reports enabled counts", () => {
    const home = tempHome()
    writeSkill(home, "grill-me")
    writeSkill(home, "openspec")
    const registry = new ManagedSkillRegistry({ home })
    const listed = registry.list()
    expect(listed.items.length).toBeGreaterThanOrEqual(2)
    expect(listed.enabled_count).toBe(listed.items.length)
    const openspec = listed.items.find((item) => item.id === "openspec")
    expect(openspec).toMatchObject({ enabled: true, version: "1.0.0", license: "LicenseRef-Proprietary" })
    expect(openspec?.tags).toContain("development")
  })

  test("persists enable/disable state in the Python-compatible skills_state.json", () => {
    const home = tempHome()
    writeSkill(home, "openspec")
    const registry = new ManagedSkillRegistry({ home })
    const mutation = registry.setEnabled("openspec", false)
    expect(mutation).toMatchObject({ skill_id: "openspec", enabled: false, changed: true })
    expect(mutation.skills.items.find((item) => item.id === "openspec")?.enabled).toBe(false)

    const stateFile = join(home, "skills_state.json")
    const persisted = JSON.parse(require("node:fs").readFileSync(stateFile, "utf8"))
    expect(persisted).toEqual({ disabled: ["openspec"] })

    const reopened = new ManagedSkillRegistry({ home })
    expect(reopened.list().items.find((item) => item.id === "openspec")?.enabled).toBe(false)
    const reenable = reopened.setEnabled("openspec", true)
    expect(reenable.changed).toBe(true)
    expect(reenable.skills.items.find((item) => item.id === "openspec")?.enabled).toBe(true)
  })

  test("reads a skill body with truncation and resource listing", () => {
    const home = tempHome()
    const dir = writeSkill(home, "pdf", "\n# appendix\n")
    const registry = new ManagedSkillRegistry({ home })
    const result = registry.read("pdf")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain("Use pdf faithfully")
      expect(result.truncated).toBe(false)
    }
    const truncated = registry.read("pdf", 100)
    expect(truncated.ok).toBe(true)
    if (truncated.ok) expect(truncated.truncated).toBe(true)

    const missing = registry.read("does-not-exist")
    expect(missing).toEqual({ ok: false, error: "skill not found, disabled, or invalid: does-not-exist" })
    void dir
  })

  test("routes development requests with phases and relationship natively", () => {
    const home = tempHome()
    const registry = new ManagedSkillRegistry({ home })
    const route = registry.route("I am not sure, help me design and implement a new database feature")
    expect(route.mode).toBe("clarify")
    expect(route.selected).toEqual(["grill-me", "openspec", "superpowers"])
    expect(route.phases).toEqual(["clarify", "specify", "deliver"])
    expect(route.relationship).toBe("grill-me → OpenSpec → Trellis → Superpowers")
    expect(route.missing).toEqual([])

    const imageRoute = registry.route("这张截图里有什么？请识别报错信息。")
    expect(imageRoute.capabilities).toContain("vision-tools")
  })

  test("flags invalid manifests as problems", () => {
    const home = tempHome()
    const dir = join(home, "skills", "broken")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "---\nid: bad id!\n---\n# broken\n", "utf8")
    const registry = new ManagedSkillRegistry({ home })
    const broken = registry.list().items.find((item) => item.id === "bad id!")
    expect(broken?.problems.length).toBeGreaterThan(0)
    expect(() => registry.read("bad id!")).toThrow()
  })
})
