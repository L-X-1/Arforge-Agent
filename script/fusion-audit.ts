import path from "node:path"
import { lstat, readdir, realpath } from "node:fs/promises"

export interface FusionPolicy {
  readonly canonicalRootName: string
  readonly canonicalVersion: string
  readonly canonicalPackageScope: string
  readonly externalReferenceRoots: readonly string[]
  readonly excludeDirectories: readonly string[]
  readonly externalReferenceDocumentation: readonly string[]
  readonly compatibleVendoredPackages: readonly string[]
  readonly versionedManifests: readonly string[]
  readonly defaultScripts: Readonly<Record<string, string>>
  readonly requiredEntrypoints: readonly string[]
}

export interface FusionFinding {
  readonly rule:
    | "root-name"
    | "external-reference"
    | "external-link"
    | "license-file"
    | "manifest"
    | "package-name"
    | "package-version"
    | "default-script"
    | "entrypoint"
  readonly file: string
  readonly detail: string
}

export interface FusionReport {
  readonly version: 1
  readonly generatedAt: string
  readonly root: string
  readonly manifests: number
  readonly visitedFiles: number
  readonly scannedTextFiles: number
  readonly reparsePoints: number
  readonly findings: readonly FusionFinding[]
}

type PackageManifest = {
  name?: string
  version?: string
  private?: boolean
  license?: string
  workspaces?: { packages?: string[] } | string[]
  scripts?: Record<string, string>
  repository?: unknown
  homepage?: unknown
  bugs?: unknown
  author?: unknown
  contributors?: unknown
  funding?: unknown
  publishConfig?: unknown
}

const slash = (value: string) => value.replaceAll("\\", "/")
const lowerPath = (value: string) => slash(path.resolve(value)).toLocaleLowerCase()
const isInside = (root: string, candidate: string) => {
  const base = lowerPath(root).replace(/\/+$/, "")
  const target = lowerPath(candidate)
  return target === base || target.startsWith(`${base}/`)
}
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const containsExternalRoot = (text: string, externalRoot: string) => {
  const normalized = slash(text)
  const root = slash(externalRoot).replace(/\/+$/, "")
  const expression = new RegExp(
    `(?:^|[^A-Za-z0-9._-])${escapeRegex(root)}(?=$|[\\\\/\"'\\x60\\s])`,
    "i",
  )
  return expression.test(normalized)
}

export const relativeArforgeReferences = (text: string) =>
  Array.from(
    text.matchAll(/(?:^|[\s"'`(=])((?:\.\.[\\/])+arforge(?:[\\/][A-Za-z0-9._/@-]+)?)/gim),
    (match) => match[1],
  )

export const manifestFailures = (
  file: string,
  manifest: PackageManifest,
  policy: FusionPolicy,
): FusionFinding[] => {
  const findings: FusionFinding[] = []
  const finding = (rule: FusionFinding["rule"], detail: string) => findings.push({ rule, file, detail })
  if (!manifest.name) finding("manifest", "package name is missing")
  if (manifest.private !== true) finding("manifest", "private must be true")
  if (manifest.license !== "UNLICENSED") finding("manifest", "license must be UNLICENSED")
  for (const field of ["repository", "homepage", "bugs", "author", "contributors", "funding", "publishConfig"] as const) {
    if (manifest[field] !== undefined) finding("manifest", `external or publishing metadata is present: ${field}`)
  }
  if (
    manifest.name &&
    manifest.name !== "arforge-agent" &&
    manifest.name !== "arforge" &&
    !manifest.name.startsWith(policy.canonicalPackageScope) &&
    !policy.compatibleVendoredPackages.includes(manifest.name)
  ) {
    finding("package-name", `package name is outside the private namespace: ${manifest.name}`)
  }
  if (policy.versionedManifests.includes(file) && manifest.version !== policy.canonicalVersion) {
    finding(
      "package-version",
      `expected ${policy.canonicalVersion}, received ${manifest.version ?? "<missing>"}`,
    )
  }
  return findings
}

async function workspaceManifests(root: string, manifest: PackageManifest) {
  const configured = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? [])
  const files = new Set<string>(["package.json"])
  for (const configuredPath of configured) {
    const normalized = slash(configuredPath).replace(/\/+$/, "")
    if (normalized.endsWith("/*")) {
      const parent = normalized.slice(0, -2)
      const entries = await readdir(path.join(root, parent), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const relative = `${parent}/${entry.name}/package.json`
        if (await Bun.file(path.join(root, relative)).exists()) files.add(relative)
      }
      continue
    }
    const relative = `${normalized}/package.json`
    if (await Bun.file(path.join(root, relative)).exists()) files.add(relative)
  }
  return [...files].toSorted()
}

const binaryExtensions = new Set([
  ".7z",
  ".a",
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
  ".o",
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

export async function auditFusion(root: string, policy: FusionPolicy): Promise<FusionReport> {
  const findings: FusionFinding[] = []
  const excluded = new Set(policy.excludeDirectories.map((item) => item.toLocaleLowerCase()))
  const documentation = new Set(policy.externalReferenceDocumentation.map(slash))
  let visitedFiles = 0
  let scannedTextFiles = 0
  let reparsePoints = 0

  const add = (rule: FusionFinding["rule"], file: string, detail: string) =>
    findings.push({ rule, file: slash(file), detail })

  if (path.basename(root).toLocaleLowerCase() !== policy.canonicalRootName.toLocaleLowerCase()) {
    add("root-name", ".", `expected repository root ${policy.canonicalRootName}, received ${path.basename(root)}`)
  }

  async function walk(directory: string, relative = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name.toLocaleLowerCase())) continue
      const raw = relative ? path.join(relative, entry.name) : entry.name
      const absolute = path.join(directory, entry.name)
      const stats = await lstat(absolute)
      if (stats.isSymbolicLink()) {
        reparsePoints += 1
        let target: string
        try {
          target = await realpath(absolute)
        } catch (error) {
          add("external-link", raw, `unresolvable reparse point: ${String(error)}`)
          continue
        }
        if (!isInside(root, target)) add("external-link", raw, `target escapes repository: ${target}`)
        continue
      }
      if (stats.isDirectory()) {
        await walk(absolute, raw)
        continue
      }
      if (!stats.isFile()) continue
      visitedFiles += 1
      const file = slash(raw)
      if (/^(?:license|licence|copying|notice)(?:[._-].*)?$/i.test(entry.name)) {
        add("license-file", file, "first-party license-like file is not allowed")
      }
      if (binaryExtensions.has(path.extname(entry.name).toLocaleLowerCase()) || stats.size > 5_000_000) continue
      const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer())
      if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) continue
      scannedTextFiles += 1
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
      if (!documentation.has(file)) {
        for (const externalRoot of policy.externalReferenceRoots) {
          if (containsExternalRoot(text, externalRoot)) {
            add("external-reference", file, `contains external source root ${externalRoot}`)
          }
        }
      }
      for (const reference of relativeArforgeReferences(text)) {
        const resolved = path.resolve(path.dirname(absolute), reference)
        if (!isInside(root, resolved)) add("external-reference", file, `relative path escapes repository: ${reference}`)
      }
    }
  }

  await walk(root)

  const rootManifest = (await Bun.file(path.join(root, "package.json")).json()) as PackageManifest
  const manifests = await workspaceManifests(root, rootManifest)
  const packageOwners = new Map<string, string>()
  for (const file of manifests) {
    const manifest = (await Bun.file(path.join(root, file)).json()) as PackageManifest
    findings.push(...manifestFailures(file, manifest, policy))
    if (manifest.name) {
      const owner = packageOwners.get(manifest.name)
      if (owner) add("package-name", file, `duplicate package name ${manifest.name}; first declared by ${owner}`)
      else packageOwners.set(manifest.name, file)
    }
  }

  for (const [name, expected] of Object.entries(policy.defaultScripts)) {
    const actual = rootManifest.scripts?.[name]
    if (actual !== expected) add("default-script", "package.json", `${name}: expected "${expected}", received "${actual}"`)
    if (actual && /(?:legacy|tauri|run_cli\.py|E:[\\/]Arforge(?:[\\/]|$))/i.test(actual)) {
      add("default-script", "package.json", `${name} points to a legacy or external entrypoint`)
    }
  }
  for (const file of policy.requiredEntrypoints) {
    if (!(await Bun.file(path.join(root, file)).exists())) add("entrypoint", file, "required current entrypoint is missing")
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    manifests: manifests.length,
    visitedFiles,
    scannedTextFiles,
    reparsePoints,
    findings: findings.toSorted((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule)),
  }
}

function print(report: FusionReport) {
  console.log(
    `Fusion audit: ${report.findings.length} findings; ${report.manifests} manifests; ` +
      `${report.visitedFiles} files visited; ${report.scannedTextFiles} text files scanned; ` +
      `${report.reparsePoints} first-party reparse points`,
  )
  for (const finding of report.findings) {
    console.log(`  [${finding.rule}] ${finding.file}: ${finding.detail}`)
  }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..")
  const policy = (await Bun.file(path.join(root, "specs", "fusion-policy.json")).json()) as FusionPolicy
  const report = await auditFusion(root, policy)
  print(report)
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2))
  if (report.findings.length > 0) process.exitCode = 1
}
