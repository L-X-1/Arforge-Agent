export * as AnalysisQuality from "./quality"

/**
 * G12 quality standards for changed files — native TS port of
 * ``arforge/core/quality_gate.py``.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface QualityIssue {
  readonly level: "error" | "warning"
  readonly code: string
  readonly message: string
  readonly file: string
}

export interface DiffStats {
  readonly files: string[]
  readonly files_changed: number
  readonly additions: number
  readonly deletions: number
  readonly changed_lines: number
  readonly hunks: number
  readonly new_files: number
  readonly deleted_files: number
}

export interface QualityReport {
  readonly passed: boolean
  readonly score: number
  readonly files_checked: number
  readonly diff_stats: DiffStats
  readonly issues: QualityIssue[]
  readonly summary: string
}

const DOC_EXTENSIONS = new Set([".md", ".rst", ".txt"])
const CODE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".toml", ".json", ".yaml", ".yml"])
const GENERATED_PARTS = new Set(["dist", "build", "target", "__pycache__", ".pytest_cache", "node_modules"])
const PUBLIC_SURFACE_PREFIXES = [
  "arforge/cli.py",
  "arforge/bridge.py",
  "arforge/product/",
  "desktop/src/types/",
  "docs/",
]

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot).toLowerCase()
}

function isDoc(path: string): boolean {
  return DOC_EXTENSIONS.has(extensionOf(path)) || normalize(path).startsWith("docs/")
}

function isCode(path: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(path))
}

function touchesPublicSurface(path: string): boolean {
  const normalized = normalize(path)
  return PUBLIC_SURFACE_PREFIXES.some(
    (prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix),
  )
}

function looksGenerated(path: string): boolean {
  const parts = new Set(normalize(path).split("/"))
  return [...parts].some((part) => GENERATED_PARTS.has(part))
}

function patchPath(value: string): string {
  const cleaned = value.trim().replace(/^"|"$/g, "")
  if (cleaned === "/dev/null" || cleaned === "") return ""
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) return cleaned.slice(2)
  return cleaned
}

export function parseUnifiedDiffStats(patchText: string): DiffStats {
  const files: string[] = []
  const seen = new Set<string>()
  let additions = 0
  let deletions = 0
  let hunks = 0
  let newFiles = 0
  let deletedFiles = 0

  const remember = (path: string) => {
    const normalized = normalize(patchPath(path))
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      files.push(normalized)
    }
  }

  for (const rawLine of patchText.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      const parts = rawLine.split(/\s+/)
      const currentOld = parts.length > 2 ? patchPath(parts[2]) : ""
      const currentNew = parts.length > 3 ? patchPath(parts[3]) : ""
      remember(currentNew || currentOld)
      continue
    }
    if (rawLine.startsWith("new file mode")) {
      newFiles += 1
      continue
    }
    if (rawLine.startsWith("deleted file mode")) {
      deletedFiles += 1
      continue
    }
    if (rawLine.startsWith("--- ")) {
      remember(patchPath(rawLine.slice(4)))
      continue
    }
    if (rawLine.startsWith("+++ ")) {
      remember(patchPath(rawLine.slice(4)))
      continue
    }
    if (rawLine.startsWith("@@")) {
      hunks += 1
      continue
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      additions += 1
      continue
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      deletions += 1
    }
  }
  return {
    files,
    files_changed: files.length,
    additions,
    deletions,
    changed_lines: additions + deletions,
    hunks,
    new_files: newFiles,
    deleted_files: deletedFiles,
  }
}

function appendDiffQualityIssues(issues: QualityIssue[], diffStats: DiffStats | null): void {
  if (!diffStats) return
  const { changed_lines: changedLines, additions, hunks, files_changed: filesChanged, new_files: newFiles } = diffStats
  if (changedLines > 500) {
    issues.push({
      level: "warning",
      code: "large-diff",
      message: `Diff changes ${changedLines} lines; split or justify the scope before handoff.`,
      file: "",
    })
  }
  if (hunks > 30) {
    issues.push({
      level: "warning",
      code: "high-hunk-count",
      message: `Diff spans ${hunks} hunks; review for avoidable churn and focused edits.`,
      file: "",
    })
  }
  if (newFiles > 8) {
    issues.push({
      level: "warning",
      code: "new-file-surge",
      message: `Diff adds ${newFiles} files; confirm the new surface is necessary.`,
      file: "",
    })
  }
  if (filesChanged > 0 && additions / Math.max(filesChanged, 1) > 180) {
    issues.push({
      level: "warning",
      code: "over-engineering-risk",
      message: "Average added lines per changed file is high; confirm this is the smallest useful design.",
      file: "",
    })
  }
}

export function assessQualityChange(
  files: string[],
  options: { patchText?: string; root?: string; resolver?: (filename: string) => string } = {},
): QualityReport {
  const diffStats = options.patchText ? parseUnifiedDiffStats(options.patchText) : null
  const changed = [...new Set([...(files ?? []).filter(Boolean), ...(diffStats?.files ?? [])])]
  const resolve =
    options.resolver ??
    (options.root ? (filename: string) => join(options.root!, filename) : (filename: string) => filename)

  if (changed.length === 0) {
    return {
      passed: true,
      score: 100,
      files_checked: 0,
      diff_stats: diffStats ?? emptyDiffStats(changed),
      issues: [],
      summary: "no changed files",
    }
  }

  const issues: QualityIssue[] = []
  if (changed.length > 20) {
    issues.push({
      level: "warning",
      code: "broad-change",
      message: `${changed.length} files changed; split or justify broad changes before handoff.`,
      file: "",
    })
  }
  const docsTouched = changed.some((path) => isDoc(path))
  const publicSurfaceChanged = changed.some((path) => touchesPublicSurface(path) && isCode(path))
  if (publicSurfaceChanged && !docsTouched) {
    issues.push({
      level: "warning",
      code: "docs-sync",
      message: "Public CLI/Bridge/product surface changed without README/docs updates.",
      file: "",
    })
  }
  appendDiffQualityIssues(issues, diffStats)

  let checked = 0
  for (const filename of changed) {
    const normalized = normalize(filename)
    if (looksGenerated(normalized)) {
      issues.push({
        level: "warning",
        code: "generated-file",
        message: "Generated/cache/build output changed.",
        file: filename,
      })
      continue
    }
    let target: string
    try {
      target = resolve(filename)
    } catch (error) {
      issues.push({
        level: "warning",
        code: "unresolved-path",
        message: `Could not resolve changed path: ${error instanceof Error ? error.message : String(error)}`,
        file: filename,
      })
      continue
    }
    if (!existsSync(target)) {
      issues.push({ level: "warning", code: "missing-file", message: "Changed file no longer exists.", file: filename })
      continue
    }
    if (!isCode(filename) && !isDoc(filename)) continue
    let text: string | null = null
    try {
      text = readFileSync(target, "utf8")
    } catch {
      text = null
    }
    if (text === null) {
      issues.push({ level: "warning", code: "binary-skip", message: "Binary or non-UTF-8 file skipped.", file: filename })
      continue
    }
    checked += 1
    const lines = text.split(/\r?\n/)
    if (lines.length > 800) {
      issues.push({
        level: "warning",
        code: "large-file",
        message: `Changed file has ${lines.length} lines; consider narrower edits.`,
        file: filename,
      })
    }
    for (let index = 0; index < lines.length; index++) {
      if (lines[index] !== lines[index].trimEnd()) {
        issues.push({
          level: "error",
          code: "trailing-whitespace",
          message: `Trailing whitespace at line ${index + 1}.`,
          file: filename,
        })
        break
      }
    }
    if (extensionOf(target) === ".py") {
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].startsWith("\t")) {
          issues.push({
            level: "error",
            code: "tab-indent",
            message: `Tab indentation at line ${index + 1}.`,
            file: filename,
          })
          break
        }
      }
    }
  }

  let score = 100
  for (const issue of issues) {
    score -= issue.level === "error" ? 25 : 10
  }
  score = Math.max(score, 0)
  const passed = issues.every((issue) => issue.level !== "error") && score >= 70
  return {
    passed,
    score,
    files_checked: checked,
    diff_stats: diffStats ?? emptyDiffStats(changed),
    issues,
    summary: `${checked} files checked, ${issues.length} quality issues`,
  }
}

export function formatQualityReport(report: QualityReport): string {
  const status = report.passed ? "PASS" : "REVIEW"
  const lines = [`G12 quality gate: ${status} (score ${report.score}/100)`, `  ${report.summary}`]
  const diff = report.diff_stats
  if (diff) {
    lines.push(
      `  Diff: ${diff.files_changed} files, +${diff.additions}/-${diff.deletions}, ${diff.hunks} hunks`,
    )
  }
  for (const issue of report.issues.slice(0, 12)) {
    const target = issue.file ? ` ${issue.file}` : ""
    lines.push(`  - [${issue.level}] ${issue.code}:${target} ${issue.message}`)
  }
  if (report.issues.length > 12) {
    lines.push(`  ... ${report.issues.length - 12} more`)
  }
  return lines.join("\n")
}

function emptyDiffStats(files: string[]): DiffStats {
  return {
    files,
    files_changed: files.length,
    additions: 0,
    deletions: 0,
    changed_lines: 0,
    hunks: 0,
    new_files: 0,
    deleted_files: 0,
  }
}

