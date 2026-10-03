import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { canonicalJson, sha256Text, type GovernanceFinding, type JsonRecord } from "./arforge-governance"

const CAPABILITIES_PATH = "docs/evidence/implementation/legacy-python-capabilities.json"
const FILES_PATH = "docs/evidence/implementation/legacy-python-files.json"
const ATTESTATION_PATH = "docs/evidence/implementation/attestations/python-ledger.v1.sha256"
const OWNER_REGISTRY_PATH = "docs/evidence/implementation/owner-registry.v1.json"
const MANIFEST_PATH = "docs/evidence/implementation/protocol-bootstrap.v1.json"
const PYTHON_ROOT = "arforge"
const PYTHON_ROOTS = ["arforge"] as const
const ROOT_PYTHON_ENTRYPOINTS = ["config.py", "dogfood.py", "main.py", "run_desktop.py", "verify_modules.py"] as const
const CONSUMER_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".ps1",
  ".sh",
])
const CONSUMER_EXCLUDED_SEGMENTS = [
  ".git",
  ".arforge",
  ".codex-tmp",
  ".pytest-tmp",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  "out",
  "tmp/",
  "docs/evidence/implementation",
]
const REQUIRED_DISPOSITIONS = ["MERGE", "PORT", "REPLACE", "FIXTURE", "RETIRE"] as const
const DOMAIN_RULES: ReadonlyArray<readonly [string, string[]]> = [
  ["mcp", ["mcp", "oauth"]],
  ["workflow", ["workflow", "orchestrat", "scheduler", "graph"]],
  ["session", ["session", "prompt", "conversation", "message", "checkpoint", "compaction"]],
  ["action", ["action", "permission", "approval", "mutation", "command"]],
  ["tool", ["tool", "browser", "computer", "notebook", "office"]],
  ["memory", ["memory", "knowledge", "learning", "recall", "embedding"]],
  ["subagent", ["subagent", "agent", "team", "child_run", "multi_agent"]],
  ["cli", ["cli", "tui", "print", "input"]],
  ["context", ["context", "token", "prompt_compiler", "instruction"]],
  ["sandbox", ["sandbox", "egress", "network", "process", "shell"]],
  ["invariant", ["test", "eval", "acceptance", "quality", "verify"]],
]
const MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["process", /\bsubprocess\b|create_subprocess|os\.system|os\.popen/gi],
  ["network", /\brequests\b|\bhttpx\b|urllib|socket\.|aiohttp|websocket/gi],
  ["database", /sqlite|postgres|psycopg|sqlalchemy|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/gi],
  ["filesystem_read", /\bopen\s*\(|Path\([^)]*\)\.read|read_text|read_bytes/gi],
  ["filesystem_write", /\bopen\s*\([^)]*['\"]w|write_text|write_bytes|shutil\.(copy|move|rmtree)|\.save\s*\(/gi],
  ["credential", /API_KEY|SECRET|TOKEN|PASSWORD|credential|keyring/gi],
]
const IMPORT_PATTERN = /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm
const DEFINITION_PATTERN = /^\s*(?:(async)\s+)?(def|class)\s+([A-Za-z_][\w]*)/gm

type OwnerTarget = {
  readonly domain: string
  readonly service_path?: string
  readonly service_symbols?: readonly string[]
}

type CapabilityLeaf = {
  readonly leaf_id: string
  readonly file_path: string
  readonly source_digest: string
  readonly line: number
  readonly name: string
  readonly leaf_kind: "class" | "callable" | "module"
  readonly domain: string
  readonly disposition: (typeof REQUIRED_DISPOSITIONS)[number]
  readonly status: "OPEN"
  readonly target_owner: OwnerTarget | null
  readonly import_hints: readonly string[]
  readonly consumer_hints: readonly string[]
  readonly read_effects: readonly string[]
  readonly write_effects: readonly string[]
  readonly side_effects: readonly string[]
  readonly evidence_refs: readonly string[]
  readonly work_package: "PY-002"
}

type PythonFileRecord = {
  readonly file_path: string
  readonly source_digest: string
  readonly byte_length: number
  readonly line_count: number
  readonly domain: string
  readonly status: "OPEN"
  readonly leaf_ids: readonly string[]
  readonly leaf_count: number
  readonly leaf_disposition_counts: Readonly<Record<string, number>>
  readonly imports: readonly string[]
  readonly consumer_refs: readonly string[]
  readonly read_effects: readonly string[]
  readonly write_effects: readonly string[]
  readonly side_effects: readonly string[]
  readonly evidence_refs: readonly string[]
  readonly work_package: "PY-002"
}

type OwnerRegistry = {
  readonly registry_id: string
  readonly manifest_digest: string
  readonly entries: readonly JsonRecord[]
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const sourceDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const lineNumberAt = (text: string, index: number) => text.slice(0, index).split(/\r?\n/).length

const unique = (items: readonly string[]) => [...new Set(items)].toSorted()

const inferDomain = (relativePath: string): string => {
  const lower = relativePath.toLowerCase()
  for (const [domain, tokens] of DOMAIN_RULES) {
    if (tokens.some((token) => lower.includes(token))) return domain
  }
  return "invariant"
}

const dispositionFor = (relativePath: string, domain: string): (typeof REQUIRED_DISPOSITIONS)[number] => {
  const lower = relativePath.toLowerCase()
  if (lower.includes("test") || lower.includes("fixture") || lower.includes("acceptance")) return "FIXTURE"
  if (["release", "installer", "signing", "staging", "ship", "upgrade"].some((token) => lower.includes(token)))
    return "RETIRE"
  if (
    ["session", "action", "tool", "memory", "workflow", "mcp", "subagent", "cli", "context", "sandbox"].includes(domain)
  )
    return "MERGE"
  return "PORT"
}

const ownerTargetFor = (domain: string, ownerRegistry: OwnerRegistry): OwnerTarget | null => {
  const entry = ownerRegistry.entries.find((candidate) => candidate.domain === domain)
  if (!entry) return null
  const service = isRecord(entry.service_owner) ? entry.service_owner : undefined
  return {
    domain,
    service_path: typeof service?.path === "string" ? service.path : undefined,
    service_symbols: Array.isArray(service?.symbols)
      ? service.symbols.filter((symbol): symbol is string => typeof symbol === "string")
      : undefined,
  }
}

const scanEffects = (text: string) => {
  const readEffects: string[] = []
  const writeEffects: string[] = []
  const sideEffects: string[] = []
  for (const [name, pattern] of MARKERS) {
    pattern.lastIndex = 0
    if (!pattern.test(text)) continue
    sideEffects.push(name)
    if (name === "filesystem_write" || name === "database" || name === "process" || name === "network")
      writeEffects.push(name)
    if (name === "filesystem_read" || name === "database" || name === "credential") readEffects.push(name)
  }
  return { readEffects: unique(readEffects), writeEffects: unique(writeEffects), sideEffects: unique(sideEffects) }
}

const listPythonFiles = async (root: string): Promise<string[]> => {
  const result: string[] = []
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && entry.name.endsWith(".py")) result.push(full)
    }
  }
  for (const pythonRoot of PYTHON_ROOTS) await visit(resolveSafe(root, pythonRoot))
  for (const entrypoint of ROOT_PYTHON_ENTRYPOINTS) {
    try {
      const info = await stat(resolveSafe(root, entrypoint))
      if (info.isFile()) result.push(resolveSafe(root, entrypoint))
    } catch {
      // Root entrypoints are explicit and optional for fixture repositories.
    }
  }
  return result.toSorted((left, right) => left.localeCompare(right))
}

const listConsumerFiles = async (root: string): Promise<string[]> => {
  const result: string[] = []
  const visit = async (directory: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = (await readdir(directory, { withFileTypes: true })) as import("node:fs").Dirent[]
    } catch {
      return
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).replaceAll("\\", "/")
      const lower = relative.toLowerCase()
      if (CONSUMER_EXCLUDED_SEGMENTS.some((segment) => lower.includes(segment))) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && CONSUMER_EXTENSIONS.has(path.extname(lower))) result.push(full)
    }
  }
  await visit(root)
  return result.toSorted((left, right) => left.localeCompare(right))
}

const moduleAliasesFor = (relative: string) => {
  const normalized = relative.replaceAll("\\", "/")
  const withoutExtension = normalized.replace(/\.py$/, "")
  const module = withoutExtension.replaceAll("/", ".").replace(/(?:^|\.)__init__$/, "")
  return unique([normalized, withoutExtension, module, "arforge." + module.replace(/^arforge\./, "")])
}

const IMPORT_NAME_PATTERN = /^[A-Za-z_][\w.]*$/

const addImportedMembers = (tokens: Set<string>, module: string, imported: string) => {
  for (const rawItem of imported.split(",")) {
    const item = rawItem.replace(/#.*/, "").trim()
    if (!item || item === "*") continue
    const name = item.split(/\s+as\s+/i, 1)[0]?.trim() ?? ""
    if (IMPORT_NAME_PATTERN.test(name)) tokens.add(module + "." + name)
  }
}

/**
 * Collect import references with package-member precision.
 *
 * A plain `from arforge.tools import lsp_tools` statement first names the
 * package, while the actual legacy module is the imported member. The old
 * scanner only retained the former and therefore incorrectly classified
 * optional Python wrappers as consumer-free. Keep the broad fallback for
 * compatibility, then add exact member tokens for one-line and parenthesized
 * imports. This remains lexical/deterministic by design; it is evidence for
 * migration triage, not a Python execution or import resolver.
 */
const importTokensFor = (text: string) => {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/\bfrom[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]*\(([\s\S]*?)\)/g)) {
    tokens.add(match[1])
    addImportedMembers(tokens, match[1], match[2])
  }
  for (const match of text.matchAll(/\bfrom[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]+([^\r\n]+)/g)) {
    tokens.add(match[1])
    addImportedMembers(tokens, match[1], match[2])
  }
  for (const match of text.matchAll(
    /\bimport[ \t]+([A-Za-z_][\w.]*(?:[ \t]+as[ \t]+[A-Za-z_]\w*)?(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*(?:[ \t]+as[ \t]+[A-Za-z_]\w*)?)*)/g,
  )) {
    for (const rawItem of match[1].split(",")) {
      const name = rawItem.split(/[ \t]+as[ \t]+/i, 1)[0]?.trim() ?? ""
      if (IMPORT_NAME_PATTERN.test(name)) tokens.add(name)
    }
  }
  // Preserve the historical broad match for unusual/dynamic syntax and for
  // non-Python evidence files that contain a simple import marker.
  for (const match of text.matchAll(/\b(?:from|import)\s+([A-Za-z_][\w.]*)/g)) tokens.add(match[1])
  // Built-in registration and deferred loading intentionally keep module
  // names in string literals (for example `importlib.import_module(name)`).
  // Treat an exact quoted dotted module as a consumer reference as well; this
  // prevents a dynamic registry edge from being mistaken for an orphaned
  // Python wrapper during retirement triage.
  for (const match of text.matchAll(/["'`](arforge\.[A-Za-z_][\w.]*)["'`]/g)) tokens.add(match[1])
  return tokens
}

const buildReverseConsumers = async (root: string, pythonFiles: readonly string[]) => {
  const aliases = new Map<string, string[]>()
  for (const fullPath of pythonFiles) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    for (const alias of moduleAliasesFor(relative)) aliases.set(alias, [...(aliases.get(alias) ?? []), relative])
  }
  const consumers = new Map<string, Set<string>>()
  for (const fullPath of await listConsumerFiles(root)) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    const tokens = importTokensFor(text)
    for (const match of text.matchAll(/\barforge[\\/][A-Za-z0-9_./-]+/g)) tokens.add(match[0])
    for (const token of tokens) {
      const targets = aliases.get(token) ?? aliases.get(token.replaceAll("\\", "/").replace(/\.py$/, "")) ?? []
      for (const target of targets) {
        const set = consumers.get(target) ?? new Set<string>()
        if (target !== relative) set.add(relative)
        consumers.set(target, set)
      }
    }
  }
  return new Map([...consumers.entries()].map(([file, paths]) => [file, [...paths].toSorted()] as const))
}

const readOwnerRegistry = async (root: string): Promise<OwnerRegistry> => {
  const registry = JSON.parse(
    await readFile(resolveSafe(root, "docs/evidence/implementation/owner-registry.v1.json"), "utf8"),
  ) as JsonRecord
  if (
    registry.registry_id !== "ts-owner-registry" ||
    !Array.isArray(registry.entries) ||
    typeof registry.manifest_digest !== "string"
  ) {
    throw new Error("owner registry is not structurally valid")
  }
  return {
    registry_id: registry.registry_id,
    manifest_digest: registry.manifest_digest,
    entries: registry.entries.filter(isRecord),
  }
}

export async function buildLedgers(root: string) {
  const ownerRegistry = await readOwnerRegistry(root)
  const pythonFiles = await listPythonFiles(root)
  const reverseConsumers = await buildReverseConsumers(root, pythonFiles)
  const capabilities: CapabilityLeaf[] = []
  const files: PythonFileRecord[] = []
  for (const fullPath of pythonFiles) {
    const relativePath = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    const digest = sourceDigest(text)
    const domain = inferDomain(relativePath)
    const disposition = dispositionFor(relativePath, domain)
    const imports: string[] = []
    IMPORT_PATTERN.lastIndex = 0
    for (const match of text.matchAll(IMPORT_PATTERN)) imports.push(match[1])
    const effects = scanEffects(text)
    const definitions: Array<{ readonly kind: "class" | "callable"; readonly name: string; readonly line: number }> = []
    DEFINITION_PATTERN.lastIndex = 0
    for (const match of text.matchAll(DEFINITION_PATTERN)) {
      definitions.push({
        kind: match[2] === "class" ? "class" : "callable",
        name: match[3],
        line: lineNumberAt(text, match.index ?? 0),
      })
    }
    const leafDefinitions =
      definitions.length > 0
        ? definitions
        : [{ kind: "module" as const, name: path.basename(relativePath, ".py"), line: 1 }]
    const ownerTarget = ownerTargetFor(domain, ownerRegistry)
    const leafIds: string[] = []
    for (const definition of leafDefinitions) {
      const leafId = `PY002:${relativePath}:${definition.kind}:${definition.line}:${definition.name}`
      leafIds.push(leafId)
      capabilities.push({
        leaf_id: leafId,
        file_path: relativePath,
        source_digest: digest,
        line: definition.line,
        name: definition.name,
        leaf_kind: definition.kind,
        domain,
        disposition,
        status: "OPEN",
        target_owner: disposition === "RETIRE" ? null : ownerTarget,
        import_hints: unique(imports),
        consumer_hints: reverseConsumers.get(relativePath) ?? [],
        read_effects: effects.readEffects,
        write_effects: effects.writeEffects,
        side_effects: effects.sideEffects,
        evidence_refs: [relativePath, "docs/evidence/implementation/owner-registry.v1.json"],
        work_package: "PY-002",
      })
    }
    const dispositionCounts: Record<string, number> = {}
    for (const leaf of leafDefinitions) dispositionCounts[disposition] = (dispositionCounts[disposition] ?? 0) + 1
    files.push({
      file_path: relativePath,
      source_digest: digest,
      byte_length: Buffer.byteLength(text, "utf8"),
      line_count: text.split(/\r?\n/).length,
      domain,
      status: "OPEN",
      leaf_ids: leafIds,
      leaf_count: leafIds.length,
      leaf_disposition_counts: Object.fromEntries(
        Object.entries(dispositionCounts).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
      imports: unique(imports),
      consumer_refs: reverseConsumers.get(relativePath) ?? [],
      read_effects: effects.readEffects,
      write_effects: effects.writeEffects,
      side_effects: effects.sideEffects,
      evidence_refs: [relativePath, "docs/evidence/implementation/owner-registry.v1.json"],
      work_package: "PY-002",
    })
  }
  capabilities.sort((left, right) => left.leaf_id.localeCompare(right.leaf_id))
  files.sort((left, right) => left.file_path.localeCompare(right.file_path))
  const common = {
    schema_version: "1.0",
    ledger_id: "legacy-python",
    plan_revision: "v1.3",
    source_revision: "92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8",
    python_root: PYTHON_ROOT,
    owner_registry_path: OWNER_REGISTRY_PATH,
    owner_registry_digest: sha256Text(
      canonicalJson(JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8"))),
    ),
    python_file_count: files.length,
    capability_leaf_count: capabilities.length,
    status_policy: "all generated leaves and file projections start OPEN; status is not inferred as CLOSED",
  }
  return {
    capabilitiesArtifact: { ...common, artifact_kind: "capability_leaves", capabilities },
    filesArtifact: { ...common, artifact_kind: "file_projection", files },
  }
}

const artifactDigest = (capabilitiesArtifact: unknown, filesArtifact: unknown) =>
  sha256Text(canonicalJson({ capabilities: capabilitiesArtifact, files: filesArtifact }))

export async function writeLedgers(root: string) {
  const { capabilitiesArtifact, filesArtifact } = await buildLedgers(root)
  await mkdir(resolveSafe(root, path.dirname(CAPABILITIES_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, CAPABILITIES_PATH), JSON.stringify(capabilitiesArtifact, null, 2) + "\n")
  await writeFile(resolveSafe(root, FILES_PATH), JSON.stringify(filesArtifact, null, 2) + "\n")
  await writeFile(
    resolveSafe(root, ATTESTATION_PATH),
    "sha256:" + artifactDigest(capabilitiesArtifact, filesArtifact) + "\n",
  )
  return {
    python_file_count: capabilitiesArtifact.python_file_count,
    capability_leaf_count: capabilitiesArtifact.capability_leaf_count,
    artifact_digest: artifactDigest(capabilitiesArtifact, filesArtifact),
  }
}

const loadArtifact = async (root: string, relative: string, findings: GovernanceFinding[]) => {
  try {
    return JSON.parse(await readFile(resolveSafe(root, relative), "utf8")) as JsonRecord
  } catch (error) {
    findings.push({ code: "PY002-001", path: relative, detail: "cannot read valid ledger artifact: " + String(error) })
    return undefined
  }
}

export async function validatePythonLedgers(root: string) {
  const findings: GovernanceFinding[] = []
  const capabilities = await loadArtifact(root, CAPABILITIES_PATH, findings)
  const files = await loadArtifact(root, FILES_PATH, findings)
  if (!capabilities || !files) return { schema_version: "1.0" as const, valid: false, findings }
  if (capabilities.schema_version !== "1.0" || files.schema_version !== "1.0")
    findings.push({ code: "PY002-001", path: CAPABILITIES_PATH, detail: "ledger schema_version must be 1.0" })
  if (capabilities.ledger_id !== "legacy-python" || files.ledger_id !== "legacy-python")
    findings.push({ code: "PY002-001", path: CAPABILITIES_PATH, detail: "ledger_id is not canonical" })
  if (capabilities.python_root !== PYTHON_ROOT || files.python_root !== PYTHON_ROOT)
    findings.push({ code: "PY002-002", path: CAPABILITIES_PATH, detail: "python_root is not canonical" })
  const capabilityLeaves = Array.isArray(capabilities.capabilities) ? capabilities.capabilities : []
  const fileRecords = Array.isArray(files.files) ? files.files : []
  const leafIds = capabilityLeaves.map((leaf) => (isRecord(leaf) ? leaf.leaf_id : undefined))
  if (new Set(leafIds).size !== leafIds.length)
    findings.push({ code: "PY002-003", path: CAPABILITIES_PATH, detail: "capability leaf IDs are not unique" })
  const filePaths = fileRecords.map((file) => (isRecord(file) ? file.file_path : undefined))
  if (new Set(filePaths).size !== filePaths.length)
    findings.push({ code: "PY002-003", path: FILES_PATH, detail: "Python file paths are not unique" })
  if (capabilities.python_file_count !== fileRecords.length || files.python_file_count !== fileRecords.length)
    findings.push({ code: "PY002-004", path: FILES_PATH, detail: "python_file_count does not match file projection" })
  if (
    capabilities.capability_leaf_count !== capabilityLeaves.length ||
    files.capability_leaf_count !== capabilityLeaves.length
  )
    findings.push({
      code: "PY002-004",
      path: CAPABILITIES_PATH,
      detail: "capability_leaf_count does not match leaf projection",
    })

  const ownerRegistry = await readOwnerRegistry(root).catch((error) => {
    findings.push({ code: "PY002-005", path: OWNER_REGISTRY_PATH, detail: String(error) })
    return undefined
  })
  if (ownerRegistry && capabilities.owner_registry_path === OWNER_REGISTRY_PATH) {
    const ownerDigest = sha256Text(
      canonicalJson(JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8"))),
    )
    if (capabilities.owner_registry_digest !== ownerDigest || files.owner_registry_digest !== ownerDigest)
      findings.push({ code: "PY002-005", path: OWNER_REGISTRY_PATH, detail: "owner registry digest binding is stale" })
  }
  const ownerTargetMatches = (value: unknown, domain: unknown) => {
    if (
      !isRecord(value) ||
      typeof domain !== "string" ||
      value.domain !== domain ||
      typeof value.service_path !== "string" ||
      !Array.isArray(value.service_symbols)
    )
      return false
    const entry = ownerRegistry?.entries.find((candidate) => candidate.domain === domain)
    const service = entry && isRecord(entry.service_owner) ? entry.service_owner : undefined
    const expectedPath = typeof service?.path === "string" ? service.path : undefined
    const expectedSymbols = Array.isArray(service?.symbols)
      ? service.symbols.filter((symbol): symbol is string => typeof symbol === "string")
      : []
    return (
      value.service_path === expectedPath && canonicalJson(value.service_symbols) === canonicalJson(expectedSymbols)
    )
  }

  const currentFiles = await listPythonFiles(root)
  const currentByRelative = new Map<string, { digest: string; bytes: number }>()
  for (const fullPath of currentFiles) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    currentByRelative.set(relative, { digest: sourceDigest(text), bytes: Buffer.byteLength(text, "utf8") })
  }
  for (const file of fileRecords) {
    if (!isRecord(file) || typeof file.file_path !== "string") continue
    const current = currentByRelative.get(file.file_path)
    if (!current)
      findings.push({
        code: "PY002-006",
        path: FILES_PATH,
        detail: "ledger file is missing from arforge scan: " + file.file_path,
      })
    else if (current.digest !== file.source_digest || current.bytes !== file.byte_length)
      findings.push({ code: "PY002-006", path: file.file_path, detail: "source digest/size drifted after generation" })
  }
  if (currentByRelative.size !== fileRecords.length)
    findings.push({ code: "PY002-006", path: FILES_PATH, detail: "current Python file count differs from ledger" })
  const fileLeafIds = new Set(
    fileRecords.flatMap((file) => (isRecord(file) && Array.isArray(file.leaf_ids) ? file.leaf_ids : [])),
  )
  for (const leaf of capabilityLeaves) {
    if (!isRecord(leaf)) continue
    if (!fileLeafIds.has(leaf.leaf_id))
      findings.push({
        code: "PY002-007",
        path: CAPABILITIES_PATH,
        detail: "capability leaf is not referenced by file projection: " + String(leaf.leaf_id),
      })
    if (leaf.status !== "OPEN")
      findings.push({
        code: "PY002-008",
        path: CAPABILITIES_PATH,
        detail: "generated leaf must remain OPEN until parity evidence closes it",
      })
    if (!REQUIRED_DISPOSITIONS.includes(leaf.disposition as (typeof REQUIRED_DISPOSITIONS)[number]))
      findings.push({
        code: "PY002-009",
        path: CAPABILITIES_PATH,
        detail: "leaf disposition is not one of the five plan dispositions",
      })
    if (leaf.disposition !== "RETIRE" && !ownerTargetMatches(leaf.target_owner, leaf.domain))
      findings.push({
        code: "PY002-011",
        path: CAPABILITIES_PATH,
        detail: "non-RETIRE leaf target_owner does not resolve to the Owner Registry service owner",
      })
    if (!Array.isArray(leaf.consumer_hints) || leaf.consumer_hints.some((item) => typeof item !== "string"))
      findings.push({
        code: "PY002-012",
        path: CAPABILITIES_PATH,
        detail: "consumer_hints must be a reverse consumer path list",
      })
  }
  for (const file of fileRecords) {
    if (!isRecord(file)) continue
    if (!Array.isArray(file.consumer_refs) || file.consumer_refs.some((item) => typeof item !== "string"))
      findings.push({
        code: "PY002-012",
        path: FILES_PATH,
        detail: "file consumer_refs must be a reverse consumer path list",
      })
  }
  try {
    const regenerated = await buildLedgers(root)
    const currentProjection = {
      capabilitiesArtifact: capabilities,
      filesArtifact: files,
    }
    const expectedProjection = {
      capabilitiesArtifact: regenerated.capabilitiesArtifact,
      filesArtifact: regenerated.filesArtifact,
    }
    if (canonicalJson(currentProjection) !== canonicalJson(expectedProjection)) {
      findings.push({
        code: "PY002-013",
        path: CAPABILITIES_PATH,
        detail: "checked-in capability/file projections do not exactly match deterministic regeneration",
      })
    }
  } catch (error) {
    findings.push({
      code: "PY002-013",
      path: CAPABILITIES_PATH,
      detail: "deterministic ledger regeneration failed: " + String(error),
    })
  }
  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    const expected = artifactDigest(capabilities, files)
    if (attestation !== "sha256:" + expected)
      findings.push({
        code: "PY002-010",
        path: ATTESTATION_PATH,
        detail: "combined ledger attestation does not match artifacts",
      })
  } catch (error) {
    findings.push({
      code: "PY002-010",
      path: ATTESTATION_PATH,
      detail: "cannot read combined ledger attestation: " + String(error),
    })
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    findings,
    python_file_count: fileRecords.length,
    capability_leaf_count: capabilityLeaves.length,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = parseRoot(args)
  if (args[0] === "generate-python-ledger") {
    if (!args.includes("--write")) {
      console.error("generation is read-only unless --write is explicit")
      process.exit(2)
    }
    console.log(JSON.stringify(await writeLedgers(root), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-python-ledger") {
    const report = await validatePythonLedgers(root)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  console.error(
    "usage: bun run script/arforge-python-ledger.ts generate-python-ledger --root <repo> --write | validate-python-ledger --root <repo>",
  )
  process.exit(2)
}
