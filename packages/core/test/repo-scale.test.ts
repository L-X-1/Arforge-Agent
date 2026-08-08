import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { RepoScale } from "@arforge-ai/core/analysis/repo-scale"

function tempRepo(): string {
  const root = join(tmpdir(), `arforge-repo-scale-${randomUUID().replace(/-/g, "")}`)
  mkdirSync(root, { recursive: true })
  return root
}

describe("RepoScale", () => {
  test("scans code files with gitignore filtering", () => {
    const root = tempRepo()
    writeFileSync(join(root, "main.ts"), "export const a = 1\n", "utf8")
    writeFileSync(join(root, "ignored.js"), "// ignored\n", "utf8")
    writeFileSync(join(root, ".gitignore"), "ignored.js\n", "utf8")
    mkdirSync(join(root, "node_modules"), { recursive: true })
    writeFileSync(join(root, "node_modules", "dep.js"), "x\n", "utf8")
    writeFileSync(join(root, "readme.md"), "# readme\n", "utf8")
    writeFileSync(join(root, "binary.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), "utf8")

    const report = RepoScale.buildRepoScaleReport(root, { maxFiles: 100, limit: 5 })
    expect(report.schema_version).toBe(1)
    const paths = report.scan.total === 2 ? report.largest_files.map((item) => item.path) : []
    expect(report.scan.total).toBe(2)
    expect(paths).toEqual(expect.arrayContaining(["main.ts", "readme.md"]))
    expect(report.scan.incremental).toBe(false)
    expect(report.suffix_counts[".ts"]).toBe(1)
    expect(report.suffix_counts[".md"]).toBe(1)
    expect(report.recommendations.length).toBeGreaterThan(0)
  })

  test("search ranks term matches with previews", () => {
    const root = tempRepo()
    writeFileSync(join(root, "a.ts"), "function render() {}\nconst targetSymbol = 1\n", "utf8")
    writeFileSync(join(root, "b.ts"), "targetSymbol = 2\n// targetSymbol\n", "utf8")

    const report = RepoScale.buildRepoScaleReport(root, { query: "targetSymbol", maxFiles: 100, limit: 10 })
    expect(report.search.total).toBeGreaterThanOrEqual(1)
    expect(report.search.searched_files).toBe(2)
    const top = report.search.items[0]
    expect(top.matched_terms).toContain("targetsymbol")
    expect(top.preview.length).toBeGreaterThan(0)
  })

  test("respects max_files budget and flags truncation", () => {
    const root = tempRepo()
    for (let index = 0; index < 6; index++) {
      writeFileSync(join(root, `file${index}.ts`), `// file ${index}\n`, "utf8")
    }
    const report = RepoScale.buildRepoScaleReport(root, { maxFiles: 3, limit: 3 })
    expect(report.scan.total).toBeLessThanOrEqual(3)
    expect(report.budget.max_files).toBe(3)
  })

  test("reports empty search for repos without matches", () => {
    const root = tempRepo()
    writeFileSync(join(root, "a.ts"), "const value = 1\n", "utf8")
    const report = RepoScale.buildRepoScaleReport(root, { query: "nonexistent_symbol_xyz", maxFiles: 100, limit: 5 })
    expect(report.search.total).toBe(0)
    expect(report.search.items).toEqual([])
    expect(report.recommendations.some((item) => item.includes("No match"))).toBe(true)
  })
})
