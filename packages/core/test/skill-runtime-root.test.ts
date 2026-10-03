import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { findDevelopmentRuntimeRoot } from "@arforge-ai/core/skill/runtime-root"

const bundlePath = (root: string) => join(root, "arforge", "bundled_skills", "agent_skills", "skills")

describe("findDevelopmentRuntimeRoot", () => {
  test("finds a TypeScript skill bundle without requiring a Python virtualenv", () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-skill-root-"))
    try {
      mkdirSync(bundlePath(root), { recursive: true })
      const nested = join(root, "packages", "core")
      mkdirSync(nested, { recursive: true })
      expect(findDevelopmentRuntimeRoot(nested)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed to the caller when no bundled skill root exists", () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-skill-root-missing-"))
    try {
      const nested = join(root, "packages", "core")
      mkdirSync(nested, { recursive: true })
      expect(findDevelopmentRuntimeRoot(nested)).toBe(nested)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
