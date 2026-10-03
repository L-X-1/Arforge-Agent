import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildSourceSnapshot,
  parseGitStatus,
  SOURCE_SNAPSHOT_PATH,
  validateSourceSnapshot,
  writeSourceSnapshot,
} from "./arforge-source-snapshot"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-source-snapshot-"))
  execFileSync("git", ["init", "--quiet"], { cwd: root })
  await mkdir(path.join(root, "src"))
  await writeFile(path.join(root, "src/中文 with spaces.ts"), "export const value = 1\n")
  await writeFile(path.join(root, ".gitignore"), ".env\n")
  await writeFile(path.join(root, ".env"), "do-not-copy-this-secret")
  return root
}

test("snapshots exact Git-visible paths without copying content or requiring protocol cards", async () => {
  const root = await fixture()
  const first = await buildSourceSnapshot(root)
  const second = await buildSourceSnapshot(root)
  expect(first.digest).toBe(second.digest)
  expect(first.entries.map((entry) => entry.path)).toEqual([".gitignore", "src/中文 with spaces.ts"])
  expect(first.entries[1]).toMatchObject({ git_status: "??", kind: "file" })
  expect(JSON.stringify(first)).not.toContain("do-not-copy-this-secret")
  expect(JSON.stringify(first)).not.toContain("export const")
  expect(first.scope).toBe("git-visible-working-tree")
})

test("published snapshot excludes only itself and survives repeat capture", async () => {
  const root = await fixture()
  await writeSourceSnapshot(root)
  expect((await validateSourceSnapshot(root)).valid).toBe(true)
  const before = await readFile(path.join(root, SOURCE_SNAPSHOT_PATH), "utf8")
  await writeSourceSnapshot(root)
  const after = await readFile(path.join(root, SOURCE_SNAPSHOT_PATH), "utf8")
  expect(JSON.parse(before).digest).toBe(JSON.parse(after).digest)
  expect((await validateSourceSnapshot(root)).valid).toBe(true)
})

test("same-sized source changes invalidate evidence without regenerating acceptance", async () => {
  const root = await fixture()
  await writeSourceSnapshot(root)
  await writeFile(path.join(root, "src/中文 with spaces.ts"), "export const value = 2\n")
  const report = await validateSourceSnapshot(root)
  expect(report.valid).toBe(false)
  expect(report.changed_paths).toContain("src/中文 with spaces.ts")
  expect(report.findings.some((finding) => finding.code === "SNAPSHOT-STALE")).toBe(true)
})

test("added and removed inputs are not hidden by a directory-level digest", async () => {
  const root = await fixture()
  await writeSourceSnapshot(root)
  await writeFile(path.join(root, "new.ts"), "new input")
  await rm(path.join(root, "src/中文 with spaces.ts"))
  const report = await validateSourceSnapshot(root)
  expect(report.valid).toBe(false)
  expect(report.changed_paths).toEqual(["new.ts", "src/中文 with spaces.ts"])
})

test("records deleted tracked files with paths containing spaces", async () => {
  const root = await fixture()
  execFileSync("git", ["add", "--", "."], { cwd: root })
  await rm(path.join(root, "src/中文 with spaces.ts"))
  const snapshot = await buildSourceSnapshot(root)
  expect(snapshot.entries.find((entry) => entry.path === "src/中文 with spaces.ts")).toMatchObject({
    kind: "deleted",
    git_status: "AD",
    digest: null,
  })
})

test("NUL status parsing consumes the old rename path without splitting whitespace", () => {
  const result = parseGitStatus("R  src/新 name.ts\0src/old name.ts\0?? next file.ts\0")
  expect([...result]).toEqual([
    ["src/新 name.ts", "R "],
    ["next file.ts", "??"],
  ])
  expect(() => parseGitStatus("R  new.ts\0")).toThrow("rename")
  expect(() => parseGitStatus("?? ../outside.ts\0")).toThrow("invalid path")
})

test("malformed or tampered snapshots fail closed", async () => {
  const root = await fixture()
  expect((await validateSourceSnapshot(root)).valid).toBe(false)
  await writeSourceSnapshot(root)
  const snapshotPath = path.join(root, SOURCE_SNAPSHOT_PATH)
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  snapshot.entries[0].digest = "0".repeat(64)
  await writeFile(snapshotPath, JSON.stringify(snapshot))
  const report = await validateSourceSnapshot(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "SNAPSHOT-INTEGRITY")).toBe(true)
})

test("refuses linked parent directories rather than reading or writing outside the root", async () => {
  const root = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), "arforge-snapshot-outside-"))
  await writeFile(path.join(outside, "secret.ts"), "outside-secret")
  await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
  await rejects(buildSourceSnapshot(root), /link/)
  const writeRoot = await fixture()
  await symlink(outside, path.join(writeRoot, "docs"), process.platform === "win32" ? "junction" : "dir")
  await rejects(writeSourceSnapshot(writeRoot), /link/)
  expect(await readFile(path.join(outside, "secret.ts"), "utf8")).toBe("outside-secret")
})

test(
  "CLI generation is opt-in and validation never repairs a stale input",
  async () => {
    const root = await fixture()
    const command = path.join(import.meta.dir, "arforge-migration-freshness.ts")
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [command, ...args, "--root", root], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      })
    expect(run("generate-source-snapshot").status).toBe(2)
    expect((await validateSourceSnapshot(root)).valid).toBe(false)
    expect(run("generate-source-snapshot", "--write").status).toBe(0)
    expect(run("validate-source-snapshot").status).toBe(0)
    const original = await readFile(path.join(root, SOURCE_SNAPSHOT_PATH), "utf8")
    await writeFile(path.join(root, "new.ts"), "new input")
    expect(run("validate-source-snapshot").status).toBe(1)
    expect(await readFile(path.join(root, SOURCE_SNAPSHOT_PATH), "utf8")).toBe(original)
  },
  { timeout: 30_000 },
)
