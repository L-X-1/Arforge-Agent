import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { canonicalJson, sha256Text, type GovernanceFinding } from "./arforge-governance"

/**
 * Deterministic migration-window audit for Python leaves which used to own
 * workspace trust/root policy.
 *
 * The audit intentionally does not import Python or execute the old runtime.
 * It records the remaining Python consumers, proves that they are confined to
 * the declared compatibility lanes, and proves that TypeScript/Core owns the
 * replacement surface.  A valid report is not a retirement claim: a leaf may
 * only be deleted after its consumer list becomes empty and the compatibility
 * gates have been refreshed.
 */

export const PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION = "1.0" as const

const REPORT_PATH = "docs/evidence/implementation/python-leaf-consumers.v1.json"
const ATTESTATION_PATH = "docs/evidence/implementation/attestations/python-leaf-consumers.v1.sha256"
const PYTHON_LEDGER_ATTESTATION_PATH = "docs/evidence/implementation/attestations/python-ledger.v1.sha256"
const OWNER_REGISTRY_PATH = "docs/evidence/implementation/owner-registry.v1.json"

const TARGETS = [
  {
    module: "arforge.trust_screen",
    file_path: "arforge/trust_screen.py",
    disposition: "MERGE",
    owner: {
      path: "packages/core/src/workspace-roots.ts",
      symbols: ["isPersistedWorkspaceTrusted", "isWorkspaceTrusted"],
    },
    cli_owner: {
      path: "packages/arforge/src/cli/cmd/workspace.ts",
      symbols: ["WorkspaceCommand"],
    },
    replacement_contract: "read-only Core workspace trust projection; persistent writes remain ActionGateway/CAS gated",
  },
  {
    module: "arforge.workspace_roots",
    file_path: "arforge/workspace_roots.py",
    disposition: "MERGE",
    owner: {
      path: "packages/core/src/workspace-roots.ts",
      symbols: ["configuredWorkspaceRoots", "authorizedWorkspaceRoots", "workspaceRootsReport"],
    },
    cli_owner: {
      path: "packages/arforge/src/cli/cmd/workspace.ts",
      symbols: ["WorkspaceCommand"],
    },
    replacement_contract:
      "metadata-only workspace root report; trust/add/remove stay fail-closed until the durable writer gate",
  },
] as const

const PYTHON_EXTENSIONS = new Set([".py"])
const EXCLUDED_SEGMENTS = [
  ".git",
  ".arforge",
  ".codex-tmp",
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
const PYTHON_ROOTS = ["arforge", "scripts", "tests"] as const
const ROOT_PYTHON_FILES = ["main.py"] as const
const TS_RUNTIME_ROOTS = [
  "packages/core/src",
  "packages/arforge/src",
  "packages/server/src",
  "packages/app/src",
  "packages/desktop/src",
] as const

type ConsumerLane =
  | "frozen-legacy-cli"
  | "legacy-python-runtime"
  | "legacy-python-internal"
  | "compatibility-test"
  | "fixture"
  | "governance-script"

type ReferenceKind = "from-import" | "import" | "dynamic-module-string"

type ConsumerReference = Readonly<{
  path: string
  line: number
  reference_kind: ReferenceKind
  lane: ConsumerLane
}>

type TargetAudit = Readonly<{
  module: string
  file_path: string
  source_digest: string
  disposition: "MERGE"
  owner: Readonly<{ path: string; symbols: readonly string[] }>
  cli_owner: Readonly<{ path: string; symbols: readonly string[] }>
  replacement_contract: string
  consumers: readonly ConsumerReference[]
  consumer_count: number
  retirement_ready: false
  retirement_blockers: readonly string[]
}>

type RetirementReview = Readonly<{
  kind: "python-leaf-retirement-review"
  status: "blocked"
  consumer_free: boolean
  deletion_authorized: false
  target_count: number
  blockers: readonly string[]
  review_digest: string
}>

type AuditArtifact = Readonly<{
  schema_version: typeof PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION
  artifact_kind: "python_leaf_consumer_audit"
  status: "migration-window"
  canonical_runtime: "typescript"
  canonical_cli_entry: "packages/arforge/src/index.ts"
  python_cli_entry: "arforge.cli_bridge"
  python_ledger_attestation: string
  ts_runtime_python_imports: readonly string[]
  targets: readonly TargetAudit[]
  remaining_consumer_count: number
  retirement_review: RetirementReview
  retirement_policy: Readonly<{
    direct_python_owner: "forbidden"
    deletion_gate: readonly string[]
    current_decision: "retain-compatibility-boundary"
  }>
}>

type AuditReport = Readonly<{
  schema_version: typeof PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION
  valid: boolean
  findings: readonly GovernanceFinding[]
  remaining_consumer_count?: number
  target_count?: number
}>

const sourceDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const retirementReview = (
  targets: readonly TargetAudit[],
  tsRuntimePythonImports: readonly string[],
): RetirementReview => {
  const remainingConsumerCount = targets.reduce((sum, target) => sum + target.consumer_count, 0)
  const blockers = [
    ...(remainingConsumerCount > 0 ? ["legacy-consumers-remain"] : []),
    ...(tsRuntimePythonImports.length > 0 ? ["ts-runtime-python-imports"] : []),
    "compatibility-boundary-retained",
    "workspace-writer-gate-disabled",
  ]
  const projection = {
    kind: "python-leaf-retirement-review" as const,
    status: "blocked" as const,
    consumer_free: remainingConsumerCount === 0 && tsRuntimePythonImports.length === 0,
    deletion_authorized: false as const,
    target_count: targets.length,
    blockers,
  }
  return { ...projection, review_digest: sha256Text(canonicalJson(projection)) }
}

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const isExcluded = (relative: string) => EXCLUDED_SEGMENTS.some((segment) => relative.toLowerCase().includes(segment))

const lineNumberAt = (text: string, index: number) => text.slice(0, index).split(/\r?\n/).length

const unique = (values: readonly string[]) => [...new Set(values)].toSorted()

const listPythonFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
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
      if (isExcluded(relative)) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && PYTHON_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  for (const relative of PYTHON_ROOTS) await visit(resolveSafe(root, relative))
  for (const relative of ROOT_PYTHON_FILES) {
    try {
      const info = await stat(resolveSafe(root, relative))
      if (info.isFile()) files.push(resolveSafe(root, relative))
    } catch {
      // Optional root entrypoints are omitted in minimal fixtures.
    }
  }
  return unique(files)
}

const laneFor = (relative: string, target: string): ConsumerLane => {
  const normalized = relative.replaceAll("\\", "/")
  if (normalized === "arforge/cli.py") return "frozen-legacy-cli"
  if (normalized === target) return "legacy-python-internal"
  if (normalized.startsWith("tests/") || normalized.includes("/tests/") || /(^|\/)test_[^/]+\.py$/i.test(normalized))
    return "compatibility-test"
  if (normalized.includes("/acceptance/") || normalized.includes("/fixture") || normalized.endsWith("_fixture.py"))
    return "fixture"
  if (normalized.startsWith("scripts/") || normalized.startsWith("script/")) return "governance-script"
  return "legacy-python-runtime"
}

const referenceKindFor = (line: string, module: string): ReferenceKind => {
  if (new RegExp(`\\bfrom\\s+${module.replaceAll(".", "\\.")}\\b`).test(line)) return "from-import"
  if (new RegExp(`\\bimport\\s+${module.replaceAll(".", "\\.")}\\b`).test(line)) return "import"
  return "dynamic-module-string"
}

const scanConsumers = async (root: string, target: (typeof TARGETS)[number], pythonFiles: readonly string[]) => {
  const consumers: ConsumerReference[] = []
  const importPattern = new RegExp(
    `(?:\\bfrom\\s+${target.module.replaceAll(".", "\\.")}\\b|\\bimport\\s+${target.module.replaceAll(".", "\\.")}\\b|["']${target.module.replaceAll(".", "\\.")}["'])`,
  )
  for (const fullPath of pythonFiles) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      // Governance helpers sometimes assemble a module name from adjacent
      // string literals (for example `"arforge." + "trust_screen"`). Remove
      // only quoting/concatenation whitespace for a second conservative
      // check; this catches dynamic references without executing Python.
      const compact = line.replaceAll(/["'`\s+]/g, "")
      if (!importPattern.test(line) && !compact.includes(target.module)) continue
      consumers.push({
        path: relative,
        line: index + 1,
        reference_kind: referenceKindFor(line, target.module),
        lane: laneFor(relative, target.file_path),
      })
    }
  }
  return consumers.toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
}

const listTypeScriptFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
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
      if (isExcluded(relative)) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(full)
    }
  }
  for (const relative of TS_RUNTIME_ROOTS) await visit(resolveSafe(root, relative))
  return unique(files)
}

const scanTypeScriptPythonImports = async (root: string) => {
  const findings: string[] = []
  const importPattern =
    /(?:\bfrom\s*["'](?:arforge(?:\.|["']))|\bimport\s*["'](?:arforge(?:\.|["']))|require\(\s*["'](?:arforge(?:\.|["'])))/
  for (const fullPath of await listTypeScriptFiles(root)) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (importPattern.test(line)) findings.push(`${relative}:${index + 1}`)
    }
  }
  return findings.toSorted()
}

const readRequired = async (root: string, relative: string) => readFile(resolveSafe(root, relative), "utf8")

const hasExportedSymbol = (source: string, symbol: string) =>
  new RegExp(
    `(?:export\\s+(?:const|function|class|type|interface|namespace)\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b)`,
  ).test(source)

const readPythonLedgerAttestation = async (root: string) => {
  try {
    const value = (await readRequired(root, PYTHON_LEDGER_ATTESTATION_PATH)).trim()
    return /^sha256:[0-9a-f]{64}$/i.test(value) ? value : "invalid"
  } catch {
    return "missing"
  }
}

export async function buildPythonConsumerAudit(root: string): Promise<AuditArtifact> {
  const pythonFiles = await listPythonFiles(root)
  const tsRuntimePythonImports = await scanTypeScriptPythonImports(root)
  const pythonLedgerAttestation = await readPythonLedgerAttestation(root)
  const targets: TargetAudit[] = []
  for (const target of TARGETS) {
    const source = await readRequired(root, target.file_path)
    const consumers = await scanConsumers(root, target, pythonFiles)
    const retirementBlockers = [
      ...(consumers.length > 0 ? ["legacy Python consumers remain in the migration window"] : []),
      "retain the importable compatibility leaf until an explicit migration-window retirement decision",
      "workspace trust/add/remove durable writer remains fail-closed by policy",
    ]
    targets.push({
      module: target.module,
      file_path: target.file_path,
      source_digest: sourceDigest(source),
      disposition: target.disposition,
      owner: target.owner,
      cli_owner: target.cli_owner,
      replacement_contract: target.replacement_contract,
      consumers,
      consumer_count: consumers.length,
      retirement_ready: false,
      retirement_blockers: retirementBlockers,
    })
  }
  return {
    schema_version: PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION,
    artifact_kind: "python_leaf_consumer_audit",
    status: "migration-window",
    canonical_runtime: "typescript",
    canonical_cli_entry: "packages/arforge/src/index.ts",
    python_cli_entry: "arforge.cli_bridge",
    python_ledger_attestation: pythonLedgerAttestation,
    ts_runtime_python_imports: tsRuntimePythonImports,
    targets,
    remaining_consumer_count: targets.reduce((sum, target) => sum + target.consumer_count, 0),
    retirement_review: retirementReview(targets, tsRuntimePythonImports),
    retirement_policy: {
      direct_python_owner: "forbidden",
      deletion_gate: [
        "consumer_count=0 for the target leaf",
        "TypeScript/Core owner symbols remain present and typechecked",
        "Python CLI/bridge compatibility tests remain green",
        "legacy Python ledgers are regenerated and attested",
        "no TS runtime import or executable fallback points back to Python",
      ],
      current_decision: "retain-compatibility-boundary",
    },
  }
}

const artifactDigest = (artifact: AuditArtifact) => sha256Text(canonicalJson(artifact))

export async function writePythonConsumerAudit(root: string) {
  const artifact = await buildPythonConsumerAudit(root)
  await mkdir(resolveSafe(root, path.dirname(REPORT_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, REPORT_PATH), JSON.stringify(artifact, null, 2) + "\n")
  await writeFile(resolveSafe(root, ATTESTATION_PATH), "sha256:" + artifactDigest(artifact) + "\n")
  return {
    target_count: artifact.targets.length,
    remaining_consumer_count: artifact.remaining_consumer_count,
    artifact_digest: artifactDigest(artifact),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const loadJson = async (root: string, relative: string, findings: GovernanceFinding[]) => {
  try {
    return JSON.parse(await readRequired(root, relative)) as unknown
  } catch (error) {
    findings.push({ code: "PY016-001", path: relative, detail: "cannot read valid JSON: " + String(error) })
    return undefined
  }
}

export async function validatePythonConsumerAudit(root: string): Promise<AuditReport> {
  const findings: GovernanceFinding[] = []
  const raw = await loadJson(root, REPORT_PATH, findings)
  if (!isRecord(raw)) return { schema_version: PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION, valid: false, findings }
  if (raw.schema_version !== PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION || raw.artifact_kind !== "python_leaf_consumer_audit")
    findings.push({ code: "PY016-002", path: REPORT_PATH, detail: "audit artifact schema or kind is not canonical" })
  if (raw.status !== "migration-window" || raw.canonical_runtime !== "typescript")
    findings.push({
      code: "PY016-003",
      path: REPORT_PATH,
      detail: "audit must remain a TypeScript migration-window report",
    })
  if (raw.canonical_cli_entry !== "packages/arforge/src/index.ts" || raw.python_cli_entry !== "arforge.cli_bridge")
    findings.push({
      code: "PY016-004",
      path: REPORT_PATH,
      detail: "CLI ownership binding drifted from the unified bridge",
    })
  const review = isRecord(raw.retirement_review) ? raw.retirement_review : undefined
  if (
    !review ||
    review.kind !== "python-leaf-retirement-review" ||
    review.status !== "blocked" ||
    review.deletion_authorized !== false ||
    typeof review.consumer_free !== "boolean" ||
    typeof review.target_count !== "number" ||
    !Array.isArray(review.blockers) ||
    review.blockers.some((blocker) => typeof blocker !== "string") ||
    typeof review.review_digest !== "string"
  )
    findings.push({
      code: "PY016-019",
      path: REPORT_PATH,
      detail: "retirement review card is missing, malformed, or authorizes deletion",
    })
  else {
    const reviewProjection = {
      kind: review.kind,
      status: review.status,
      consumer_free: review.consumer_free,
      deletion_authorized: review.deletion_authorized,
      target_count: review.target_count,
      blockers: review.blockers,
    }
    if (review.review_digest !== sha256Text(canonicalJson(reviewProjection)))
      findings.push({ code: "PY016-019", path: REPORT_PATH, detail: "retirement review digest is invalid" })
  }
  if (
    typeof raw.python_ledger_attestation !== "string" ||
    !/^sha256:[0-9a-f]{64}$/i.test(raw.python_ledger_attestation)
  )
    findings.push({
      code: "PY016-018",
      path: REPORT_PATH,
      detail: "Python capability/file ledger attestation is missing or malformed",
    })
  const targets = Array.isArray(raw.targets) ? raw.targets.filter(isRecord) : []
  if (targets.length !== TARGETS.length)
    findings.push({
      code: "PY016-005",
      path: REPORT_PATH,
      detail: "target leaf set is incomplete or contains unexpected entries",
    })

  for (const expected of TARGETS) {
    const target = targets.find((candidate) => candidate.module === expected.module)
    if (!target) {
      findings.push({ code: "PY016-005", path: REPORT_PATH, detail: "missing target leaf: " + expected.module })
      continue
    }
    if (target.file_path !== expected.file_path || target.disposition !== expected.disposition)
      findings.push({
        code: "PY016-006",
        path: REPORT_PATH,
        detail: "target identity/disposition drifted: " + expected.module,
      })
    if (!isRecord(target.owner) || target.owner.path !== expected.owner.path)
      findings.push({
        code: "PY016-007",
        path: REPORT_PATH,
        detail: "TypeScript Core owner binding drifted: " + expected.module,
      })
    if (!isRecord(target.cli_owner) || target.cli_owner.path !== expected.cli_owner.path)
      findings.push({
        code: "PY016-007",
        path: REPORT_PATH,
        detail: "TS CLI owner binding drifted: " + expected.module,
      })
    if (target.retirement_ready !== false)
      findings.push({
        code: "PY016-008",
        path: REPORT_PATH,
        detail: "legacy leaf cannot be marked retirement_ready during migration window",
      })
    const consumers = Array.isArray(target.consumers) ? target.consumers.filter(isRecord) : []
    if (target.consumer_count !== consumers.length)
      findings.push({
        code: "PY016-009",
        path: REPORT_PATH,
        detail: "consumer_count does not match consumer projection: " + expected.module,
      })
    for (const consumer of consumers) {
      if (
        typeof consumer.path !== "string" ||
        typeof consumer.line !== "number" ||
        typeof consumer.reference_kind !== "string"
      )
        findings.push({
          code: "PY016-010",
          path: REPORT_PATH,
          detail: "consumer reference is malformed: " + expected.module,
        })
      if (
        ![
          "frozen-legacy-cli",
          "legacy-python-runtime",
          "legacy-python-internal",
          "compatibility-test",
          "fixture",
          "governance-script",
        ].includes(String(consumer.lane))
      )
        findings.push({
          code: "PY016-010",
          path: REPORT_PATH,
          detail: "consumer lane is not governed: " + String(consumer.path),
        })
    }
    try {
      const source = await readRequired(root, expected.file_path)
      if (sourceDigest(source) !== target.source_digest)
        findings.push({
          code: "PY016-011",
          path: expected.file_path,
          detail: "Python leaf source digest drifted; regenerate audit",
        })
      const ownerSource = await readRequired(root, expected.owner.path)
      for (const symbol of expected.owner.symbols) {
        if (!hasExportedSymbol(ownerSource, symbol))
          findings.push({
            code: "PY016-012",
            path: expected.owner.path,
            detail: "Core owner symbol missing: " + symbol,
          })
      }
      const cliSource = await readRequired(root, expected.cli_owner.path)
      for (const symbol of expected.cli_owner.symbols) {
        if (!hasExportedSymbol(cliSource, symbol))
          findings.push({
            code: "PY016-012",
            path: expected.cli_owner.path,
            detail: "CLI owner symbol missing: " + symbol,
          })
      }
    } catch (error) {
      findings.push({
        code: "PY016-013",
        path: expected.file_path,
        detail: "owner/source cannot be read: " + String(error),
      })
    }
  }

  const current = await buildPythonConsumerAudit(root).catch((error) => {
    findings.push({
      code: "PY016-014",
      path: REPORT_PATH,
      detail: "deterministic audit regeneration failed: " + String(error),
    })
    return undefined
  })
  if (current && canonicalJson(current) !== canonicalJson(raw))
    findings.push({
      code: "PY016-014",
      path: REPORT_PATH,
      detail: "checked-in audit artifact does not match deterministic regeneration",
    })
  if (
    current &&
    typeof raw.remaining_consumer_count === "number" &&
    raw.remaining_consumer_count !== current.remaining_consumer_count
  )
    findings.push({ code: "PY016-009", path: REPORT_PATH, detail: "remaining_consumer_count drifted" })

  const tsRuntimePythonImports = await scanTypeScriptPythonImports(root)
  if (tsRuntimePythonImports.length > 0)
    findings.push({
      code: "PY016-015",
      path: REPORT_PATH,
      detail: "TS runtime imports a Python package/module: " + tsRuntimePythonImports.join(", "),
    })

  try {
    const attestation = (await readRequired(root, ATTESTATION_PATH)).trim()
    if (!current || attestation !== "sha256:" + artifactDigest(current))
      findings.push({
        code: "PY016-016",
        path: ATTESTATION_PATH,
        detail: "audit attestation does not match deterministic artifact",
      })
  } catch (error) {
    findings.push({
      code: "PY016-016",
      path: ATTESTATION_PATH,
      detail: "cannot read audit attestation: " + String(error),
    })
  }

  const entryChecks: ReadonlyArray<readonly [string, string]> = [
    ["arforge/__main__.py", "from arforge.cli_bridge import main"],
    ["main.py", "from arforge.cli_bridge import main"],
    ["arforge/cli.py", "from arforge.cli_bridge import main as unified_main"],
  ]
  for (const [relative, marker] of entryChecks) {
    try {
      const source = await readRequired(root, relative)
      if (!source.includes(marker))
        findings.push({
          code: "PY016-017",
          path: relative,
          detail: "Python executable entry no longer points at cli_bridge",
        })
    } catch (error) {
      findings.push({ code: "PY016-017", path: relative, detail: "cannot inspect Python CLI entry: " + String(error) })
    }
  }

  return {
    schema_version: PYTHON_CONSUMER_AUDIT_SCHEMA_VERSION,
    valid: findings.length === 0,
    findings,
    remaining_consumer_count:
      typeof raw.remaining_consumer_count === "number" ? raw.remaining_consumer_count : undefined,
    target_count: targets.length,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = parseRoot(args)
  if (args[0] === "generate-python-consumer-audit") {
    if (!args.includes("--write")) {
      console.error("generation is read-only unless --write is explicit")
      process.exit(2)
    }
    console.log(JSON.stringify(await writePythonConsumerAudit(root), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-python-consumer-audit") {
    const report = await validatePythonConsumerAudit(root)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  console.error(
    "usage: bun run script/arforge-python-consumer-audit.ts generate-python-consumer-audit --root <repo> --write | validate-python-consumer-audit --root <repo>",
  )
  process.exit(2)
}
