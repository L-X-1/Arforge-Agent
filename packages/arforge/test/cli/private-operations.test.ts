import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pruneLogs, scanSensitiveFiles } from "../../src/cli/cmd/private-operations"

const roots: string[] = []

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arforge-private-operations-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe("private maintenance operations", () => {
  test("reports secret categories and paths without returning credential values", async () => {
    const root = await temporaryRoot()
    const secret = "sk-" + "A".repeat(30)
    await fs.writeFile(path.join(root, "private.env"), `API_KEY=${secret}\n`)
    await fs.writeFile(path.join(root, "example.env"), "PASSWORD=example\n")

    const result = await scanSensitiveFiles(root)
    const serialized = JSON.stringify(result)

    expect(result.filesScanned).toBe(2)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.path).toBe("private.env")
    expect(result.findings[0]?.categories.provider_key).toBe(1)
    expect(result.findings[0]?.categories.credential_assignment).toBe(1)
    expect(serialized).not.toContain(secret)
  })

  test("bounds a scan instead of silently claiming complete coverage", async () => {
    const root = await temporaryRoot()
    await fs.writeFile(path.join(root, "one.txt"), "safe")
    await fs.writeFile(path.join(root, "two.txt"), "safe")

    const result = await scanSensitiveFiles(root, { maxFiles: 1 })

    expect(result.filesScanned).toBe(1)
    expect(result.truncated).toBe(true)
  })

  test("excludes expensive subtrees from the read-only overview scan", async () => {
    const root = await temporaryRoot()
    await fs.mkdir(path.join(root, "repos"), { recursive: true })
    await fs.writeFile(path.join(root, "auth.json"), "token=placeholder\n")
    await fs.writeFile(path.join(root, "repos", "project.env"), "token=definitely-sensitive-value-1234567890\n")

    const result = await scanSensitiveFiles(root, { excludeDirectories: ["repos"] })

    expect(result.filesScanned).toBe(1)
    expect(result.filesSkipped).toBe(1)
    expect(result.findings).toHaveLength(0)
  })

  test("previews old logs and only removes them when apply is explicit", async () => {
    const root = await temporaryRoot()
    const old = path.join(root, "old.log")
    const recent = path.join(root, "recent.log")
    await fs.writeFile(old, "old")
    await fs.writeFile(recent, "recent")
    const now = Date.UTC(2026, 6, 27)
    const oldTime = new Date(now - 40 * 86_400_000)
    const recentTime = new Date(now - 2 * 86_400_000)
    await fs.utimes(old, oldTime, oldTime)
    await fs.utimes(recent, recentTime, recentTime)

    const preview = await pruneLogs(root, 30, { now })
    expect(preview).toMatchObject({ apply: false, files: 1, paths: ["old.log"] })
    expect(await fs.stat(old).then(() => true)).toBe(true)

    const applied = await pruneLogs(root, 30, { now, apply: true })
    expect(applied).toMatchObject({ apply: true, files: 1, paths: ["old.log"] })
    expect(await fs.stat(old).then(() => true).catch(() => false)).toBe(false)
    expect(await fs.stat(recent).then(() => true)).toBe(true)
  })

  test("rejects unsafe retention bounds", async () => {
    const root = await temporaryRoot()
    for (const days of [0, 3_651]) {
      let failure: unknown
      try {
        await pruneLogs(root, days)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      if (failure instanceof Error) expect(failure.message).toContain("1 到 3650")
    }
  })
})
