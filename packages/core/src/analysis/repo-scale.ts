export * as RepoScale from "./repo-scale"

/**
 * Large repository scaling — native TS port of ``arforge/core/large_repo.py``
 * report surface. Functionally equivalent: full scans only (the Python
 * incremental state machine is not ported), same .gitignore/binary/size
 * filtering and bounded search behavior.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
const DEFAULT_CODE_SUFFIXES = [".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".md"] as const
const MAX_DETECT_BYTES = 8192
const TEXT_CHARS = new Set([...Array.from({ length: 0x7f - 0x20 }, (_, index) => index + 0x20), 0x09, 0x0a, 0x0d])

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".lib", ".a",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pyc", ".pyo", ".pyd", ".class", ".o", ".obj",
  ".db", ".sqlite", ".sqlite3", ".mdb",
  ".bin", ".dat", ".pak", ".asset",
  ".wasm", ".node",
])

const ALWAYS_SKIP = new Set([
  ".git", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".ruff_cache", "node_modules", ".next", ".nuxt", "dist",
  "build", "target", ".tox", ".mypy_cache",
  ".idea", ".vscode", ".vs",
])

export interface ScannedFile {
  readonly path: string
  readonly suffix: string
  readonly bytes: number
}

export interface RepoScaleReport {
  readonly schema_version: number
  readonly root: string
  readonly budget: { max_files: number; suffixes: string[] }
  readonly scan: {
    total: number
    added: number
    changed: number
    unchanged: number
    removed: number
    incremental: boolean
    scan_time_ms: number
    truncated: boolean
    total_files_estimate: number
    code_files_estimate: number
  }
  readonly suffix_counts: Record<string, number>
  readonly largest_files: ScannedFile[]
  readonly search: {
    query: string
    total: number
    items: Array<{ path: string; line: number; score: number; matched_terms: string[]; preview: string }>
    searched_files: number
    truncated: boolean
  }
  readonly recommendations: string[]
}

type GitignorePattern = readonly [negated: boolean, pattern: string]

function parseGitignore(patterns: string[]): GitignorePattern[] {
  const result: GitignorePattern[] = []
  for (const raw of patterns) {
    let line = raw.trim()
    if (!line || line.startsWith("#")) continue
    let negated = false
    if (line.startsWith("!")) {
      negated = true
      line = line.slice(1)
    }
    line = line.replace(/\/+$/, "")
    result.push([negated, line])
  }
  return result
}

function loadGitignorePatterns(root: string): GitignorePattern[] {
  const gitignorePath = join(root, ".gitignore")
  if (!existsSync(gitignorePath)) return []
  try {
    return parseGitignore(readFileSync(gitignorePath, "utf8").split(/\r?\n/))
  } catch {
    return []
  }
}

/** fnmatch-compatible glob matching (``*`` matches any characters, including "/"). */
function fnmatch(clean: string, pattern: string): boolean {
  let regex = ""
  for (const char of pattern) {
    if (char === "*") regex += ".*"
    else if (char === "?") regex += "."
    else if (char === "[") {
      const end = pattern.indexOf("]", pattern.indexOf(char) + 1)
      if (end > 0) {
        regex += pattern.slice(pattern.indexOf(char), end + 1)
      } else {
        regex += "\\["
      }
    } else regex += char.replace(/[.+^${}()|\\]/g, "\\$&")
  }
  return new RegExp(`^${regex}$`).test(clean)
}

function isIgnored(path: string, gitignorePatterns: GitignorePattern[]): boolean {
  const clean = path.replace(/[\\/]+$/, "")
  let ignored = false
  for (const [negated, pattern] of gitignorePatterns) {
    if (fnmatch(clean, pattern)) ignored = !negated
  }
  return ignored
}

function isBinaryFile(path: string): boolean {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf(".")
  const suffix = dot < 0 ? "" : lower.slice(dot)
  if (BINARY_EXTENSIONS.has(suffix)) return true
  let chunk: Buffer
  try {
    chunk = readFileSync(path)
    if (chunk.length > MAX_DETECT_BYTES) chunk = chunk.subarray(0, MAX_DETECT_BYTES)
  } catch {
    return true
  }
  if (chunk.length === 0) return false
  if (chunk.includes(0x00)) return true
  let nonText = 0
  for (const byte of chunk) {
    if (!TEXT_CHARS.has(byte)) nonText += 1
  }
  return nonText / chunk.length > 0.3
}

function isTooLarge(path: string, maxBytes: number = MAX_FILE_SIZE_BYTES): boolean {
  try {
    return statSync(path).size > maxBytes
  } catch {
    return true
  }
}

function smartScan(
  root: string,
  options: {
    suffixes: readonly string[]
    respectGitignore: boolean
    skipBinary: boolean
    maxFiles: number
  },
): ScannedFile[] {
  const results: ScannedFile[] = []
  const gitignore = options.respectGitignore ? loadGitignorePatterns(root) : []
  const walk = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !ALWAYS_SKIP.has(name) && !name.startsWith("."))
      .sort()
    for (const name of dirs) {
      if (options.respectGitignore && gitignore.length > 0) {
        const rel = relative(root, join(dir, name)).replaceAll("\\", "/")
        if (isIgnored(`${rel}/`, gitignore)) continue
      }
      walk(join(dir, name))
      if (results.length >= options.maxFiles) return
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
    for (const filename of files) {
      if (results.length >= options.maxFiles) break
      const rel = relative(root, join(dir, filename)).replaceAll("\\", "/")
      const suffix = filename.slice(filename.lastIndexOf(".")).toLowerCase()
      if (options.suffixes.length > 0 && !options.suffixes.includes(suffix)) continue
      if (options.respectGitignore && gitignore.length > 0 && isIgnored(rel, gitignore)) continue
      const fullPath = join(dir, filename)
      if (options.skipBinary) {
        if (BINARY_EXTENSIONS.has(suffix)) continue
        if (isTooLarge(fullPath)) continue
      }
      let size: number
      try {
        size = statSync(fullPath).size
      } catch {
        continue
      }
      results.push({ path: rel, suffix, bytes: size })
    }
  }
  walk(root)
  return results
}

function scanStats(root: string): { total_files_estimate: number; code_files_estimate: number } {
  const codeSuffixes = new Set([".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".h"])
  let totalFiles = 0
  let codeFiles = 0
  const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"])
  const walk = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || skip.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        totalFiles += 1
        const suffix = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()
        if (codeSuffixes.has(suffix)) codeFiles += 1
      }
      if (totalFiles > 200_000) return
    }
  }
  walk(root)
  return { total_files_estimate: totalFiles, code_files_estimate: codeFiles }
}

function searchLargeRepo(
  root: string,
  options: { query: string; files: ScannedFile[]; limit: number },
): {
  query: string
  total: number
  items: Array<{ path: string; line: number; score: number; matched_terms: string[]; preview: string }>
  searched_files: number
} {
  const terms = options.query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 1)
  if (terms.length === 0) {
    return { query: options.query, total: 0, items: [], searched_files: 0 }
  }
  const matches: Array<{ path: string; line: number; score: number; matched_terms: string[]; preview: string }> = []
  let searched = 0
  for (const item of options.files) {
    const fullPath = join(root, item.path)
    let text: string
    try {
      text = readFileSync(fullPath, "utf8")
    } catch {
      continue
    }
    searched += 1
    const lines = text.split(/\r?\n/)
    const lowerLines = lines.map((line) => line.toLowerCase())
    let score = 0
    let firstLine = 0
    let preview = ""
    const matchedTerms = new Set<string>()
    for (let index = 0; index < lowerLines.length; index++) {
      const lineHits = terms.filter((term) => lowerLines[index].includes(term))
      if (lineHits.length === 0) continue
      score += lineHits.length
      for (const hit of lineHits) matchedTerms.add(hit)
      if (!firstLine) {
        firstLine = index + 1
        preview = lines[index].trim().slice(0, 160)
      }
    }
    if (score > 0) {
      matches.push({
        path: item.path,
        line: firstLine,
        score,
        matched_terms: [...matchedTerms].sort(),
        preview,
      })
    }
  }
  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const byPath = left.path.localeCompare(right.path)
    return byPath !== 0 ? byPath : left.line - right.line
  })
  return {
    query: options.query,
    total: matches.length,
    items: matches.slice(0, options.limit),
    searched_files: searched,
  }
}

export function buildRepoScaleReport(
  root: string,
  options: { query?: string; maxFiles?: number; limit?: number; suffixes?: readonly string[] } = {},
): RepoScaleReport {
  const base = resolve(root)
  const suffixes = [...(options.suffixes ?? DEFAULT_CODE_SUFFIXES)]
  const maxFiles = options.maxFiles ?? 5000
  const limit = options.limit ?? 20
  const started = Date.now()
  const files = smartScan(base, {
    suffixes,
    respectGitignore: true,
    skipBinary: true,
    maxFiles,
  })
  const scanTimeMs = Date.now() - started
  const suffixCounts: Record<string, number> = {}
  for (const item of files) {
    suffixCounts[item.suffix] = (suffixCounts[item.suffix] ?? 0) + 1
  }
  const largest = [...files].sort((left, right) => right.bytes - left.bytes).slice(0, Math.min(limit, 20))
  const totalEstimate = scanStats(base)
  const truncated = files.length >= maxFiles && totalEstimate.code_files_estimate > files.length

  let search: RepoScaleReport["search"] = {
    query: options.query ?? "",
    total: 0,
    items: [],
    searched_files: 0,
    truncated,
  }
  if ((options.query ?? "").trim()) {
    search = {
      ...searchLargeRepo(base, { query: options.query ?? "", files, limit }),
      truncated,
    }
  }

  const recommendations: string[] = []
  if (truncated) {
    recommendations.push("Increase max_files or narrow suffixes when working in repositories larger than the scan budget.")
  }
  if (search.query && search.total === 0) {
    recommendations.push("No match found inside the current scan budget; try a narrower symbol or raise max_files.")
  }
  if (recommendations.length === 0) {
    recommendations.push("Repository scan is within budget and ready for bounded local search.")
  }

  return {
    schema_version: 1,
    root: base,
    budget: { max_files: maxFiles, suffixes },
    scan: {
      total: files.length,
      added: 0,
      changed: 0,
      unchanged: 0,
      removed: 0,
      incremental: false,
      scan_time_ms: scanTimeMs,
      truncated,
      total_files_estimate: totalEstimate.total_files_estimate,
      code_files_estimate: totalEstimate.code_files_estimate,
    },
    suffix_counts: Object.fromEntries(Object.entries(suffixCounts).sort(([a], [b]) => a.localeCompare(b))),
    largest_files: largest,
    search,
    recommendations,
  }
}

export function normalizeScanPath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\.\//, "")
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const base = resolve(root).toLowerCase()
  const target = resolve(candidate).toLowerCase()
  return target === base || target.startsWith(`${base}${sep}`)
}

