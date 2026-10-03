import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { canonicalJson, sha256Text, type GovernanceFinding, type JsonRecord } from "./arforge-governance"

const LEDGER_PATH = "docs/evidence/implementation/legacy-python-dependencies.json"
const ATTESTATION_PATH = "docs/evidence/implementation/attestations/python-dependencies.v1.sha256"
const OWNER_REGISTRY_PATH = "docs/evidence/implementation/owner-registry.v1.json"
const SOURCE_REVISION = "92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8"
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const EXCLUDED_SEGMENTS = [
  ".codex-tmp",
  ".pytest-tmp",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".git",
  "node_modules",
  "dist",
  "out",
  ".venv",
  "__pycache__",
  ".arforge",
  "test-results",
  "playwright-report",
  "docs/evidence/implementation",
  "tmp/",
]
const SCAN_ROOTS = ["arforge", "packages", "scripts", "script", "tests", ".github", "docs"] as const
const ROOT_CONFIG_FILES = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "tox.ini",
  "pytest.ini",
  "Makefile",
  "package.json",
  "bunfig.toml",
] as const
const TEXT_EXTENSIONS = new Set([
  ".cmd",
  ".bat",
  ".cfg",
  ".ini",
  ".json",
  ".js",
  ".jsx",
  ".lock",
  ".md",
  ".ps1",
  ".py",
  ".pyi",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
])
const MARKER_PATTERN =
  /python|pyproject|agent-python|python3|pythonpath|\.py\b|\.venv|pip\b|pytest|uv\b|conda|sys\.executable|subprocess|spawn\s*\(|launch\s*\(|arforge\.cmd|packages\/agent-python/gi
const ASSET_PATHS = [
  ".venv",
  "packages/agent-python",
  "packages/desktop/resources/agent-python-dist",
  "packages/desktop/dist-acceptance/win-unpacked/resources/agent-python",
  "packages/desktop/out",
  "packages/desktop/dist",
] as const

type ReferenceKind = "dependency" | "import" | "spawn" | "launch" | "script" | "artifact"
type Disposition = "REPLACE" | "RETIRE" | "FIXTURE"

type DependencyLeaf = {
  readonly leaf_id: string
  readonly file_path: string
  readonly source_digest: string
  readonly line: number
  readonly line_digest: string
  readonly reference_kind: ReferenceKind
  readonly marker: string
  readonly owner: OwnerTarget
  readonly disposition: Disposition
  readonly status: "OPEN"
  readonly target_owner: OwnerTarget
  readonly source_byte_length: number
  readonly evidence_refs: readonly string[]
  readonly work_package: "PY-007"
}

type OwnerTarget = {
  readonly domain: string
  readonly service_path: string
  readonly service_symbols: readonly string[]
}

type ScannedFile = {
  readonly path: string
  readonly source_digest: string
  readonly byte_length: number
}

type AssetFootprint = {
  readonly path: string
  readonly present: boolean
  readonly kind: "directory" | "file" | "missing"
  readonly file_count: number
  readonly byte_count: number
  readonly source_digest: string | null
  readonly tree_digest: string | null
  readonly digest_algorithm: "sha256-file-bytes" | "sha256-canonical-tree" | null
  readonly status: "OPEN"
  readonly disposition: Disposition
  readonly evidence_refs: readonly string[]
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const sourceDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const lineDigest = (line: string) => sourceDigest(line)
const unique = (items: readonly string[]) => [...new Set(items)].toSorted()

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const isExcluded = (relative: string) => EXCLUDED_SEGMENTS.some((segment) => relative.toLowerCase().includes(segment))

const isTextCandidate = (relative: string) => TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())

const classifyReference = (marker: string, relative: string): ReferenceKind => {
  const lower = marker.toLowerCase()
  if (lower.includes("spawn") || lower.includes("subprocess") || lower.includes("sys.executable")) return "spawn"
  if (lower.includes("launch") || lower.includes("arforge.cmd") || lower.includes("python3")) return "launch"
  if (
    lower.includes("artifact") ||
    relative.toLowerCase().includes("resources/") ||
    relative.toLowerCase().includes("dist")
  )
    return "artifact"
  if (lower.includes("import") || lower.includes("pythonpath") || lower.includes(".py")) return "import"
  if (
    lower.includes("pyproject") ||
    lower.includes("pip") ||
    lower.includes("pytest") ||
    lower.includes("conda") ||
    lower.includes("uv")
  )
    return "dependency"
  return "script"
}

const dispositionFor = (relative: string, marker: string): Disposition => {
  const lower = (relative + " " + marker).toLowerCase()
  if (lower.includes("test") || lower.includes("fixture") || lower.includes("acceptance")) return "FIXTURE"
  if (lower.includes("dist") || lower.includes("out") || lower.includes(".venv") || lower.includes("agent-python"))
    return "RETIRE"
  return "REPLACE"
}

const ownerDomainFor = (relative: string, marker = "") => {
  const lower = relative.toLowerCase()
  const combined = lower + " " + marker.toLowerCase()
  if (combined.includes("mcp")) return "mcp"
  if (combined.includes("subagent") || combined.includes("team")) return "subagent"
  if (combined.includes("workflow") || combined.includes("scheduler")) return "workflow"
  if (combined.includes("memory")) return "memory"
  if (combined.includes("context") || combined.includes("prompt") || combined.includes("compaction")) return "context"
  if (
    combined.includes("sandbox") ||
    combined.includes("permission") ||
    combined.includes("process") ||
    combined.includes("subprocess")
  )
    return "sandbox"
  if (combined.includes("tool") || combined.includes("browser")) return "tool"
  if (combined.includes("action") || combined.includes("mutation") || combined.includes("desktop")) return "action"
  if (combined.includes("session") || combined.includes("server") || combined.includes("http")) return "session"
  if (
    combined.includes("cli") ||
    combined.includes("tui") ||
    combined.includes("script") ||
    combined.includes(".github") ||
    lower.endsWith("package.json")
  )
    return "cli"
  return "invariant"
}

const targetOwnerFor = (relative: string, marker: string, entries: readonly JsonRecord[]): OwnerTarget => {
  const domain = ownerDomainFor(relative, marker)
  const entry = entries.find((candidate) => candidate.domain === domain)
  const service = entry && isRecord(entry.service_owner) ? entry.service_owner : undefined
  const servicePath = typeof service?.path === "string" ? service.path : undefined
  const serviceSymbols = Array.isArray(service?.symbols)
    ? service.symbols.filter((symbol): symbol is string => typeof symbol === "string")
    : []
  if (!servicePath || serviceSymbols.length === 0)
    throw new Error("owner registry has no concrete service owner for dependency domain: " + domain)
  return { domain, service_path: servicePath, service_symbols: serviceSymbols }
}

const redactedLine = (line: string) =>
  line
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
    .trim()
    .slice(0, 240)

const listTextFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const visit = async (directory: string) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).replaceAll("\\", "/")
      if (isExcluded(relative)) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && isTextCandidate(relative)) {
        try {
          const info = await stat(full)
          if (info.size <= MAX_TEXT_BYTES) files.push(full)
        } catch {
          // A transient or inaccessible file is represented by the surrounding scan count, not executed.
        }
      }
    }
  }
  for (const scanRoot of SCAN_ROOTS) {
    try {
      await visit(resolveSafe(root, scanRoot))
    } catch {
      // Explicit roots may be absent in a minimal fixture repository.
    }
  }
  for (const configFile of ROOT_CONFIG_FILES) {
    try {
      const full = resolveSafe(root, configFile)
      const info = await stat(full)
      if (info.isFile() && info.size <= MAX_TEXT_BYTES && isTextCandidate(configFile)) files.push(full)
    } catch {
      // Optional root configuration.
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right))
}

const scanReferences = async (root: string, ownerEntries: readonly JsonRecord[]) => {
  const leaves: DependencyLeaf[] = []
  const scannedFiles: ScannedFile[] = []
  const fullPaths = await listTextFiles(root)
  for (const fullPath of fullPaths) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    const bytes = Buffer.byteLength(text, "utf8")
    const digest = sourceDigest(text)
    scannedFiles.push({ path: relative, source_digest: digest, byte_length: bytes })
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      MARKER_PATTERN.lastIndex = 0
      const markers = unique([...line.matchAll(MARKER_PATTERN)].map((match) => match[0].toLowerCase()))
      for (const marker of markers) {
        const normalized = redactedLine(line)
        const kind = classifyReference(marker, relative)
        const id = `PY007:${relative}:${index + 1}:${kind}:${marker}:${lineDigest(normalized)}`
        leaves.push({
          leaf_id: id,
          file_path: relative,
          source_digest: digest,
          line: index + 1,
          line_digest: lineDigest(normalized),
          reference_kind: kind,
          marker,
          owner: targetOwnerFor(relative, marker, ownerEntries),
          disposition: dispositionFor(relative, marker),
          status: "OPEN",
          target_owner: targetOwnerFor(relative, marker, ownerEntries),
          source_byte_length: bytes,
          evidence_refs: [relative, OWNER_REGISTRY_PATH],
          work_package: "PY-007",
        })
      }
    })
  }
  leaves.sort((left, right) => left.leaf_id.localeCompare(right.leaf_id))
  return { leaves, scannedFiles: scannedFiles.toSorted((left, right) => left.path.localeCompare(right.path)) }
}

const footprintFor = async (root: string, relative: string): Promise<AssetFootprint> => {
  try {
    const info = await stat(resolveSafe(root, relative))
    if (info.isFile()) {
      const bytes = await readFile(resolveSafe(root, relative))
      const digest = createHash("sha256").update(bytes).digest("hex")
      return {
        path: relative,
        present: true,
        kind: "file",
        file_count: 1,
        byte_count: bytes.byteLength,
        source_digest: digest,
        tree_digest: digest,
        digest_algorithm: "sha256-file-bytes",
        status: "OPEN",
        disposition: dispositionFor(relative, "artifact"),
        evidence_refs: [relative],
      }
    }
    let fileCount = 0
    let byteCount = 0
    const treeEntries: Array<{ readonly path: string; readonly source_digest: string; readonly byte_length: number }> =
      []
    const assetRoot = resolveSafe(root, relative)
    const visit = async (directory: string) => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) await visit(full)
        else if (entry.isFile()) {
          fileCount += 1
          try {
            const bytes = await readFile(full)
            const digest = createHash("sha256").update(bytes).digest("hex")
            byteCount += bytes.byteLength
            treeEntries.push({
              path: path.relative(assetRoot, full).replaceAll("\\", "/"),
              source_digest: digest,
              byte_length: bytes.byteLength,
            })
          } catch {
            // Leave byte count conservative if a generated file disappears during observation.
          }
        }
      }
    }
    await visit(assetRoot)
    treeEntries.sort((left, right) => left.path.localeCompare(right.path))
    const treeDigest = sha256Text(canonicalJson(treeEntries))
    return {
      path: relative,
      present: true,
      kind: "directory",
      file_count: fileCount,
      byte_count: byteCount,
      source_digest: null,
      tree_digest: treeDigest,
      digest_algorithm: "sha256-canonical-tree",
      status: "OPEN",
      disposition: dispositionFor(relative, "artifact"),
      evidence_refs: [relative],
    }
  } catch {
    return {
      path: relative,
      present: false,
      kind: "missing",
      file_count: 0,
      byte_count: 0,
      source_digest: null,
      tree_digest: null,
      digest_algorithm: null,
      status: "OPEN",
      disposition: dispositionFor(relative, "artifact"),
      evidence_refs: [relative],
    }
  }
}

const ownerRegistryDigest = async (root: string) =>
  sha256Text(canonicalJson(JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8"))))

export async function buildPythonDependenciesLedger(root: string) {
  const registryDigest = await ownerRegistryDigest(root)
  const ownerRegistry = JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8")) as JsonRecord
  const ownerEntries = Array.isArray(ownerRegistry.entries) ? ownerRegistry.entries.filter(isRecord) : []
  const scan = await scanReferences(root, ownerEntries)
  const assets = []
  for (const asset of ASSET_PATHS) assets.push(await footprintFor(root, asset))
  const artifact = {
    schema_version: "1.0",
    ledger_id: "legacy-python-dependencies",
    plan_revision: "v1.3",
    source_revision: SOURCE_REVISION,
    owner_registry_path: OWNER_REGISTRY_PATH,
    owner_registry_digest: registryDigest,
    scope_policy:
      "explicit roots arforge, packages, scripts, script, tests, .github and docs plus named root config files; .arforge and generated snapshots are never traversed; no process is started; directory assets use sha256 over canonical sorted relative path/digest/byte_length entries",
    scanned_file_count: scan.scannedFiles.length,
    dependency_leaf_count: scan.leaves.length,
    asset_count: assets.length,
    status_policy: "all dependency, launch and artifact leaves start OPEN; no deletion or cutover is inferred",
    scanned_files: scan.scannedFiles,
    dependency_leaves: scan.leaves,
    asset_footprints: assets,
  }
  return {
    artifact,
    scanned_file_count: scan.scannedFiles.length,
    dependency_leaf_count: scan.leaves.length,
    asset_count: assets.length,
  }
}

const digestArtifact = (artifact: unknown) => sha256Text(canonicalJson(artifact))

export async function writePythonDependenciesLedger(root: string) {
  const { artifact, scanned_file_count, dependency_leaf_count, asset_count } = await buildPythonDependenciesLedger(root)
  await mkdir(resolveSafe(root, path.dirname(LEDGER_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, LEDGER_PATH), JSON.stringify(artifact, null, 2) + "\n")
  const digest = digestArtifact(artifact)
  await writeFile(resolveSafe(root, ATTESTATION_PATH), "sha256:" + digest + "\n")
  return { scanned_file_count, dependency_leaf_count, asset_count, artifact_digest: digest }
}

export async function validatePythonDependenciesLedger(root: string) {
  const findings: GovernanceFinding[] = []
  let artifact: JsonRecord
  try {
    artifact = JSON.parse(await readFile(resolveSafe(root, LEDGER_PATH), "utf8")) as JsonRecord
  } catch (error) {
    findings.push({
      code: "PY007-001",
      path: LEDGER_PATH,
      detail: "cannot read valid dependency ledger: " + String(error),
    })
    return { schema_version: "1.0" as const, valid: false, findings }
  }
  if (artifact.schema_version !== "1.0" || artifact.ledger_id !== "legacy-python-dependencies")
    findings.push({ code: "PY007-001", path: LEDGER_PATH, detail: "dependency ledger schema or id is not canonical" })
  if (
    artifact.owner_registry_path !== OWNER_REGISTRY_PATH ||
    artifact.owner_registry_digest !== (await ownerRegistryDigest(root))
  )
    findings.push({ code: "PY007-005", path: LEDGER_PATH, detail: "owner registry binding is stale" })
  const leaves = Array.isArray(artifact.dependency_leaves) ? artifact.dependency_leaves : []
  const scannedFiles = Array.isArray(artifact.scanned_files) ? artifact.scanned_files : []
  const assets = Array.isArray(artifact.asset_footprints) ? artifact.asset_footprints : []
  const ids = leaves.map((leaf) => (isRecord(leaf) ? leaf.leaf_id : undefined))
  if (new Set(ids).size !== ids.length)
    findings.push({ code: "PY007-003", path: LEDGER_PATH, detail: "dependency leaf IDs are not unique" })
  if (
    artifact.scanned_file_count !== scannedFiles.length ||
    artifact.dependency_leaf_count !== leaves.length ||
    artifact.asset_count !== assets.length
  )
    findings.push({ code: "PY007-004", path: LEDGER_PATH, detail: "dependency ledger counts do not match arrays" })
  const ownerRegistry = JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8")) as JsonRecord
  const ownerEntries = Array.isArray(ownerRegistry.entries) ? ownerRegistry.entries.filter(isRecord) : []
  const ownerTargetMatches = (value: unknown, relative: string, marker: string) => {
    if (
      !isRecord(value) ||
      typeof value.domain !== "string" ||
      typeof value.service_path !== "string" ||
      !Array.isArray(value.service_symbols)
    )
      return false
    try {
      const expected = targetOwnerFor(relative, marker, ownerEntries)
      return canonicalJson(value) === canonicalJson(expected)
    } catch {
      return false
    }
  }
  const currentCache = new Map<string, { digest: string; bytes: number }>()
  for (const fullPath of await listTextFiles(root)) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const bytes = await readFile(fullPath)
    currentCache.set(relative, { digest: sourceDigest(bytes.toString("utf8")), bytes: bytes.byteLength })
  }
  const scannedByPath = new Map<string, { digest: string; bytes: number }>()
  for (const scanned of scannedFiles) {
    if (
      !isRecord(scanned) ||
      typeof scanned.path !== "string" ||
      typeof scanned.source_digest !== "string" ||
      typeof scanned.byte_length !== "number"
    ) {
      findings.push({
        code: "PY007-004",
        path: LEDGER_PATH,
        detail: "scanned_files must contain path, source_digest and byte_length records",
      })
      continue
    }
    if (scannedByPath.has(scanned.path))
      findings.push({ code: "PY007-003", path: LEDGER_PATH, detail: "scanned file paths are not unique" })
    scannedByPath.set(scanned.path, { digest: scanned.source_digest, bytes: scanned.byte_length })
    const current = currentCache.get(scanned.path)
    if (!current)
      findings.push({ code: "PY007-006", path: scanned.path, detail: "scanned dependency source file is missing" })
    else if (current.digest !== scanned.source_digest || current.bytes !== scanned.byte_length)
      findings.push({ code: "PY007-006", path: scanned.path, detail: "scanned file digest/size drifted" })
  }
  if (scannedByPath.size !== currentCache.size || [...scannedByPath.keys()].some((file) => !currentCache.has(file)))
    findings.push({
      code: "PY007-006",
      path: LEDGER_PATH,
      detail: "current explicit scan roots differ from the recorded scanned_files list",
    })
  for (const leaf of leaves) {
    if (!isRecord(leaf) || typeof leaf.file_path !== "string") continue
    if (isExcluded(leaf.file_path))
      findings.push({
        code: "PY007-002",
        path: LEDGER_PATH,
        detail: "excluded snapshot path appears in dependency ledger: " + leaf.file_path,
      })
    const current = currentCache.get(leaf.file_path)
    if (!current)
      findings.push({ code: "PY007-006", path: leaf.file_path, detail: "dependency source file is missing" })
    else if (current.digest !== leaf.source_digest || current.bytes !== leaf.source_byte_length)
      findings.push({ code: "PY007-006", path: leaf.file_path, detail: "dependency source digest/size drifted" })
    if (leaf.status !== "OPEN")
      findings.push({ code: "PY007-007", path: LEDGER_PATH, detail: "dependency leaf must remain OPEN" })
    if (
      !ownerTargetMatches(leaf.target_owner, leaf.file_path, String(leaf.marker ?? "")) ||
      !ownerTargetMatches(leaf.owner, leaf.file_path, String(leaf.marker ?? ""))
    )
      findings.push({
        code: "PY007-011",
        path: LEDGER_PATH,
        detail: "dependency leaf owner is not a concrete Owner Registry binding",
      })
  }
  for (const expectedAsset of ASSET_PATHS) {
    const actual = assets.find((asset) => isRecord(asset) && asset.path === expectedAsset)
    if (!actual)
      findings.push({ code: "PY007-008", path: LEDGER_PATH, detail: "asset footprint is missing: " + expectedAsset })
    else {
      const expected = await footprintFor(root, expectedAsset)
      if (canonicalJson(actual) !== canonicalJson(expected))
        findings.push({ code: "PY007-008", path: LEDGER_PATH, detail: "asset footprint is stale: " + expectedAsset })
    }
  }
  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    if (attestation !== "sha256:" + digestArtifact(artifact))
      findings.push({
        code: "PY007-010",
        path: ATTESTATION_PATH,
        detail: "dependency ledger attestation does not match artifact",
      })
  } catch (error) {
    findings.push({
      code: "PY007-010",
      path: ATTESTATION_PATH,
      detail: "cannot read dependency ledger attestation: " + String(error),
    })
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    findings,
    scanned_file_count: scannedFiles.length,
    dependency_leaf_count: leaves.length,
    asset_count: assets.length,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = parseRoot(args)
  if (args[0] === "generate-python-dependencies-ledger") {
    if (!args.includes("--write")) {
      console.error("generation is read-only unless --write is explicit")
      process.exit(2)
    }
    console.log(JSON.stringify(await writePythonDependenciesLedger(root), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-python-dependencies-ledger") {
    const report = await validatePythonDependenciesLedger(root)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  console.error(
    "usage: bun run script/arforge-python-dependencies-ledger.ts generate-python-dependencies-ledger --root <repo> --write | validate-python-dependencies-ledger --root <repo>",
  )
  process.exit(2)
}
