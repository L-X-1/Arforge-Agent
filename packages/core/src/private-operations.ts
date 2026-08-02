import fs from "node:fs/promises"
import path from "node:path"

const binaryExtensions = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".br",
  ".class",
  ".dll",
  ".dmg",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
])

const secretPatterns = {
  private_key: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  provider_key: /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g,
  github_token: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  slack_token: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  aws_access_key: /\bAKIA[0-9A-Z]{16}\b/g,
  database_url: /\b(?:postgresql|postgres|mysql):\/\/[^\s:/]+:[^@\s]+@/gi,
  bearer_token: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  credential_assignment:
    /\b(?:api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*(?!["']?(?:example|sample|placeholder|changeme|redacted)\b)[^\s,;#]+/gi,
} as const

export interface SecretFinding {
  readonly path: string
  readonly categories: Readonly<Record<string, number>>
}

export interface SecretScanResult {
  readonly root: string
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly truncated: boolean
  readonly findings: ReadonlyArray<SecretFinding>
}

export async function scanSensitiveFiles(
  inputRoot: string,
  options: {
    readonly maxFiles?: number
    readonly maxBytes?: number
    readonly excludeDirectories?: ReadonlyArray<string>
  } = {},
): Promise<SecretScanResult> {
  const root = path.resolve(inputRoot)
  const maxFiles = Math.max(1, Math.min(200_000, Math.trunc(options.maxFiles ?? 50_000)))
  const maxBytes = Math.max(1_024, Math.min(20_000_000, Math.trunc(options.maxBytes ?? 2_000_000)))
  const rootStat = await fs.stat(root)
  if (!rootStat.isDirectory()) throw new Error(`扫描目标不是目录：${root}`)
  const directories = [root]
  const excluded = new Set((options.excludeDirectories ?? []).map((value) => value.toLocaleLowerCase()))
  const findings: SecretFinding[] = []
  let filesScanned = 0
  let filesSkipped = 0
  let truncated = false
  while (directories.length > 0 && !truncated) {
    const directory = directories.pop()!
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        filesSkipped += 1
        continue
      }
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLocaleLowerCase())) {
          filesSkipped += 1
          continue
        }
        directories.push(file)
        continue
      }
      if (!entry.isFile()) continue
      if (filesScanned >= maxFiles) {
        truncated = true
        break
      }
      if (binaryExtensions.has(path.extname(entry.name).toLocaleLowerCase())) {
        filesSkipped += 1
        continue
      }
      const stat = await fs.stat(file)
      if (stat.size > maxBytes) {
        filesSkipped += 1
        continue
      }
      const bytes = new Uint8Array(await fs.readFile(file))
      if (bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) {
        filesSkipped += 1
        continue
      }
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
      filesScanned += 1
      const categories: Record<string, number> = {}
      for (const [category, pattern] of Object.entries(secretPatterns)) {
        const count = Array.from(content.matchAll(new RegExp(pattern.source, pattern.flags))).length
        if (count > 0) categories[category] = count
      }
      if (Object.keys(categories).length > 0) {
        findings.push({ path: path.relative(root, file).replaceAll("\\", "/") || path.basename(file), categories })
      }
    }
  }
  return { root, filesScanned, filesSkipped, truncated, findings }
}

export interface LogPruneResult {
  readonly root: string
  readonly retentionDays: number
  readonly cutoff: string
  readonly apply: boolean
  readonly files: number
  readonly bytes: number
  readonly paths: ReadonlyArray<string>
}

export async function pruneLogs(
  inputRoot: string,
  retentionDays: number,
  options: { readonly apply?: boolean; readonly now?: number } = {},
): Promise<LogPruneResult> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error("日志保留天数必须是 1 到 3650 之间的整数")
  }
  const root = path.resolve(inputRoot)
  const cutoffMs = (options.now ?? Date.now()) - retentionDays * 86_400_000
  const directories = [root]
  const selected: Array<{ readonly file: string; readonly size: number }> = []
  const exists = await fs
    .stat(root)
    .then((item) => item.isDirectory())
    .catch(() => false)
  if (exists) {
    while (directories.length > 0) {
      const directory = directories.pop()!
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          directories.push(file)
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.stat(file)
        if (stat.mtimeMs < cutoffMs) selected.push({ file, size: stat.size })
      }
    }
  }
  if (options.apply) for (const item of selected) await fs.rm(item.file, { force: true })
  return {
    root,
    retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    apply: options.apply === true,
    files: selected.length,
    bytes: selected.reduce((sum, item) => sum + item.size, 0),
    paths: selected.map((item) => path.relative(root, item.file).replaceAll("\\", "/")),
  }
}
