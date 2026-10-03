import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { canonicalJson, sha256Text, type GovernanceFinding, type JsonRecord } from "./arforge-governance"

const TEST_LEDGER_PATH = "docs/evidence/implementation/legacy-python-tests.json"
const ATTESTATION_PATH = "docs/evidence/implementation/attestations/python-tests.v1.sha256"
const OWNER_REGISTRY_PATH = "docs/evidence/implementation/owner-registry.v1.json"
const SOURCE_REVISION = "92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8"
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
  "tmp/",
]
const AUTHORIZED_ROOTS = ["tests/", "arforge/", "legacy_script/", "acceptance/"] as const
const TEST_TYPES = [
  "unit",
  "property",
  "crash",
  "race",
  "golden",
  "fixture",
  "negative",
  "integration",
  "acceptance",
] as const
const DISPOSITIONS = ["PORT", "FIXTURE", "RETIRE"] as const
const DEFINITION_PATTERN = /^\s*(?:(async)\s+)?(def|class)\s+([A-Za-z_][\w]*)/gm
const IMPORT_PATTERN = /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm

type TestType = (typeof TEST_TYPES)[number]
type TestDisposition = (typeof DISPOSITIONS)[number]

type OwnerTarget = {
  readonly domain: string
  readonly service_path: string
  readonly service_symbols: readonly string[]
}

type TestLeaf = {
  readonly leaf_id: string
  readonly file_path: string
  readonly source_digest: string
  readonly line: number
  readonly name: string
  readonly leaf_kind: "test" | "class" | "module"
  readonly test_type: TestType
  readonly disposition: TestDisposition
  readonly status: "OPEN"
  readonly ts_strategy: string
  readonly target_owner: OwnerTarget
  readonly imports: readonly string[]
  readonly python_runtime_dependencies: readonly string[]
  readonly python_oracle_calls: readonly string[]
  readonly fixture_inputs: readonly string[]
  readonly evidence_refs: readonly string[]
  readonly work_package: "PY-005"
}

type TestFile = {
  readonly file_path: string
  readonly source_digest: string
  readonly byte_length: number
  readonly line_count: number
  readonly test_type: TestType | "mixed"
  readonly status: "OPEN"
  readonly leaf_ids: readonly string[]
  readonly leaf_count: number
  readonly disposition_counts: Readonly<Record<string, number>>
  readonly target_owner: OwnerTarget
  readonly imports: readonly string[]
  readonly python_runtime_dependencies: readonly string[]
  readonly python_oracle_calls: readonly string[]
  readonly fixture_inputs: readonly string[]
  readonly evidence_refs: readonly string[]
  readonly work_package: "PY-005"
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const sourceDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const lineNumberAt = (text: string, index: number) => text.slice(0, index).split(/\r?\n/).length
const unique = (items: readonly string[]) => [...new Set(items)].toSorted()

const importsFor = (text: string) => {
  const imports: string[] = []
  IMPORT_PATTERN.lastIndex = 0
  for (const match of text.matchAll(IMPORT_PATTERN)) imports.push(match[1])
  return unique(imports)
}

const definitionWindow = (text: string, definitions: readonly { readonly line: number }[], index: number): string => {
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, definitions[index].line - 1)
  const nextLine = definitions[index + 1]?.line
  // A leaf owns the source interval up to the next definition.  This keeps
  // dependency/effect evidence local to a definition instead of copying a
  // whole file's markers into every test leaf.
  const end = nextLine === undefined ? lines.length : Math.max(start + 1, nextLine - 1)
  return lines.slice(start, end).join("\n")
}

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const isInScope = (relative: string) => {
  const normalized = relative.replaceAll("\\", "/")
  const lower = normalized.toLowerCase()
  if (EXCLUDED_SEGMENTS.some((segment) => lower.includes(segment))) return false
  if (!lower.endsWith(".py")) return false
  if (!AUTHORIZED_ROOTS.some((root) => lower.startsWith(root))) return false
  const name = path.posix.basename(lower)
  const isNamedTest = name.startsWith("test") || name.endsWith("_test.py")
  const isExplicitAsset =
    lower.startsWith("legacy_script/") ||
    lower.startsWith("acceptance/") ||
    lower.includes("/legacy_script/") ||
    lower.includes("/acceptance/")
  if (lower.startsWith("tests/") || lower.startsWith("arforge/")) return isNamedTest || isExplicitAsset
  return isExplicitAsset
}

const inferTestType = (relative: string, text = "", definitionName = ""): TestType => {
  const lower = (relative + " " + definitionName + " " + text).toLowerCase()
  if (lower.includes("fixture")) return "fixture"
  if (lower.includes("negative")) return "negative"
  if (lower.includes("crash")) return "crash"
  if (lower.includes("race") || lower.includes("concurr")) return "race"
  if (lower.includes("property") || lower.includes("hypothesis")) return "property"
  if (lower.includes("golden") || lower.includes("snapshot")) return "golden"
  if (lower.includes("integration")) return "integration"
  if (lower.includes("acceptance") || lower.includes("e2e")) return "acceptance"
  return "unit"
}

const strategyFor = (testType: TestType) => {
  if (testType === "fixture" || testType === "golden") return "neutral-fixture-or-ts-golden"
  return "ts-" + testType
}

const dispositionFor = (relative: string, testType: TestType): TestDisposition => {
  const lower = relative.toLowerCase()
  if (["release", "installer", "signing", "staging", "ship"].some((token) => lower.includes(token))) return "RETIRE"
  if (testType === "fixture" || testType === "golden") return "FIXTURE"
  return "PORT"
}

const ownerDomainFor = (relative: string): string => {
  const lower = relative.toLowerCase()
  if (lower.includes("desktop")) return "action"
  if (lower.includes("app") || lower.includes("browser")) return "tool"
  if (lower.includes("server") || lower.includes("http")) return "session"
  if (lower.includes("cli") || lower.includes("tui")) return "cli"
  return "invariant"
}

type OwnerRegistry = { readonly entries: readonly JsonRecord[] }

const ownerFor = (relative: string, ownerRegistry: OwnerRegistry): OwnerTarget => {
  const domain = ownerDomainFor(relative)
  const entry = ownerRegistry.entries.find((candidate) => candidate.domain === domain)
  const service = entry && isRecord(entry.service_owner) ? entry.service_owner : undefined
  const servicePath = typeof service?.path === "string" ? service.path : undefined
  const serviceSymbols = Array.isArray(service?.symbols)
    ? service.symbols.filter((symbol): symbol is string => typeof symbol === "string")
    : []
  if (!servicePath || serviceSymbols.length === 0)
    throw new Error("owner registry has no concrete service owner for domain: " + domain)
  return { domain, service_path: servicePath, service_symbols: serviceSymbols }
}

const dependencyMarkers = (text: string) => {
  const deps: string[] = []
  const calls: string[] = []
  const markerMap: ReadonlyArray<readonly [string, RegExp, boolean]> = [
    ["pytest", /\bpytest\b|pytest\./gi, false],
    ["unittest", /\bunittest\b/gi, false],
    ["arforge-python", /\barforge\b/gi, false],
    ["subprocess", /\bsubprocess\b|create_subprocess|os\.system/gi, true],
    ["provider", /Provider|LLM|openai|anthropic|deepseek/gi, true],
    ["database", /sqlite|postgres|psycopg|sqlalchemy|CREATE\s+TABLE|INSERT\s+INTO/gi, true],
    ["network", /requests|httpx|urllib|socket\.|aiohttp|websocket/gi, true],
  ]
  for (const [name, pattern, oracle] of markerMap) {
    pattern.lastIndex = 0
    if (!pattern.test(text)) continue
    if (oracle) calls.push(name)
    else deps.push(name)
  }
  return { dependencies: unique(deps), oracleCalls: unique(calls) }
}

const fixtureInputs = (text: string) => {
  const result: string[] = []
  const patterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["golden", /golden|snapshot/gi],
    ["fixture", /fixture|sample|fixture_data/gi],
    ["project", /acceptance\/projects|test_project/gi],
  ]
  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(text)) result.push(name)
  }
  return unique(result)
}

const listFiles = async (root: string): Promise<string[]> => {
  const result: string[] = []
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).replaceAll("\\", "/")
      if (entry.isDirectory() && !EXCLUDED_SEGMENTS.some((segment) => relative.toLowerCase().includes(segment)))
        await visit(full)
      else if (entry.isFile()) {
        if (isInScope(relative)) result.push(full)
      }
    }
  }
  await visit(root)
  return result.toSorted((left, right) => left.localeCompare(right))
}

const ownerRegistryDigest = async (root: string) =>
  sha256Text(canonicalJson(JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8"))))

const readOwnerRegistry = async (root: string): Promise<OwnerRegistry> => {
  const value = JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8")) as JsonRecord
  const entries = Array.isArray(value.entries) ? value.entries.filter(isRecord) : []
  return { entries }
}

export async function buildPythonTestsLedger(root: string) {
  const registryDigest = await ownerRegistryDigest(root)
  const ownerRegistry = await readOwnerRegistry(root)
  const fullPaths = await listFiles(root)
  const leaves: TestLeaf[] = []
  const files: TestFile[] = []
  for (const fullPath of fullPaths) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    const digest = sourceDigest(text)
    const targetOwner = ownerFor(relative, ownerRegistry)
    const definitions: Array<{ readonly kind: "test" | "class"; readonly name: string; readonly line: number }> = []
    DEFINITION_PATTERN.lastIndex = 0
    for (const match of text.matchAll(DEFINITION_PATTERN)) {
      const name = match[3]
      if (
        name.startsWith("test") ||
        name.startsWith("Test") ||
        relative.toLowerCase().includes("acceptance") ||
        relative.toLowerCase().includes("legacy_script")
      ) {
        definitions.push({
          kind: match[2] === "class" ? "class" : "test",
          name,
          line: lineNumberAt(text, match.index ?? 0),
        })
      }
    }
    const leafDefinitions =
      definitions.length > 0
        ? definitions
        : [{ kind: "module" as const, name: path.basename(relative, ".py"), line: 1 }]
    const leafIds: string[] = []
    const leafTypes: TestType[] = []
    const leafAnalyses: Array<{
      readonly testType: TestType
      readonly disposition: TestDisposition
      readonly imports: readonly string[]
      readonly dependencies: readonly string[]
      readonly oracleCalls: readonly string[]
      readonly fixtureInputs: readonly string[]
    }> = []
    for (const [definitionIndex, definition] of leafDefinitions.entries()) {
      const definitionText = definitionWindow(text, leafDefinitions, definitionIndex)
      const testType = inferTestType(relative, definitionText, definition.name)
      leafTypes.push(testType)
      const disposition = dispositionFor(relative, testType)
      const definitionImports = importsFor(definitionText)
      const markers = dependencyMarkers(definitionText)
      const fixture = fixtureInputs(definitionText)
      leafAnalyses.push({
        testType,
        disposition,
        imports: definitionImports,
        dependencies: markers.dependencies,
        oracleCalls: markers.oracleCalls,
        fixtureInputs: fixture,
      })
      const leafId = `PY005:${relative}:${definition.kind}:${definition.line}:${definition.name}`
      leafIds.push(leafId)
      leaves.push({
        leaf_id: leafId,
        file_path: relative,
        source_digest: digest,
        line: definition.line,
        name: definition.name,
        leaf_kind: definition.kind,
        test_type: testType,
        disposition,
        status: "OPEN",
        ts_strategy: strategyFor(testType),
        target_owner: targetOwner,
        imports: definitionImports,
        python_runtime_dependencies: markers.dependencies,
        python_oracle_calls: markers.oracleCalls,
        fixture_inputs: fixture,
        evidence_refs: [relative, OWNER_REGISTRY_PATH],
        work_package: "PY-005",
      })
    }
    const dispositionCounts: Record<string, number> = {}
    for (const analysis of leafAnalyses) {
      const disposition = analysis.disposition
      dispositionCounts[disposition] = (dispositionCounts[disposition] ?? 0) + 1
    }
    const distinctTypes = [...new Set(leafTypes)]
    const fileType: TestType | "mixed" = distinctTypes.length === 1 ? distinctTypes[0] : "mixed"
    const aggregateImports = unique(leafAnalyses.flatMap((analysis) => analysis.imports))
    const aggregateDependencies = unique(leafAnalyses.flatMap((analysis) => analysis.dependencies))
    const aggregateOracleCalls = unique(leafAnalyses.flatMap((analysis) => analysis.oracleCalls))
    const aggregateFixtureInputs = unique(leafAnalyses.flatMap((analysis) => analysis.fixtureInputs))
    files.push({
      file_path: relative,
      source_digest: digest,
      byte_length: Buffer.byteLength(text, "utf8"),
      line_count: text.split(/\r?\n/).length,
      test_type: fileType,
      status: "OPEN",
      leaf_ids: leafIds,
      leaf_count: leafIds.length,
      disposition_counts: Object.fromEntries(
        Object.entries(dispositionCounts).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
      target_owner: targetOwner,
      imports: aggregateImports,
      python_runtime_dependencies: aggregateDependencies,
      python_oracle_calls: aggregateOracleCalls,
      fixture_inputs: aggregateFixtureInputs,
      evidence_refs: [relative, OWNER_REGISTRY_PATH],
      work_package: "PY-005",
    })
  }
  leaves.sort((left, right) => left.leaf_id.localeCompare(right.leaf_id))
  files.sort((left, right) => left.file_path.localeCompare(right.file_path))
  const common = {
    schema_version: "1.0",
    ledger_id: "legacy-python-tests",
    plan_revision: "v1.3",
    source_revision: SOURCE_REVISION,
    owner_registry_path: OWNER_REGISTRY_PATH,
    owner_registry_digest: registryDigest,
    scope_policy:
      "test*.py, *_test.py, legacy_script and acceptance Python assets; generated snapshots and .codex-tmp excluded",
    python_file_count: files.length,
    test_leaf_count: leaves.length,
    status_policy: "all generated leaves and file projections start OPEN; no Python oracle is executed",
  }
  return {
    artifact: { ...common, test_leaves: leaves, files },
    python_file_count: files.length,
    test_leaf_count: leaves.length,
  }
}

const digestArtifact = (artifact: unknown) => sha256Text(canonicalJson(artifact))

export async function writePythonTestsLedger(root: string) {
  const { artifact, python_file_count, test_leaf_count } = await buildPythonTestsLedger(root)
  await mkdir(resolveSafe(root, path.dirname(TEST_LEDGER_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, TEST_LEDGER_PATH), JSON.stringify(artifact, null, 2) + "\n")
  const digest = digestArtifact(artifact)
  await writeFile(resolveSafe(root, ATTESTATION_PATH), "sha256:" + digest + "\n")
  return { python_file_count, test_leaf_count, artifact_digest: digest }
}

export async function validatePythonTestsLedger(root: string) {
  const findings: GovernanceFinding[] = []
  let artifact: JsonRecord
  try {
    artifact = JSON.parse(await readFile(resolveSafe(root, TEST_LEDGER_PATH), "utf8")) as JsonRecord
  } catch (error) {
    findings.push({
      code: "PY005-001",
      path: TEST_LEDGER_PATH,
      detail: "cannot read valid test ledger: " + String(error),
    })
    return { schema_version: "1.0" as const, valid: false, findings }
  }
  if (artifact.schema_version !== "1.0" || artifact.ledger_id !== "legacy-python-tests")
    findings.push({ code: "PY005-001", path: TEST_LEDGER_PATH, detail: "test ledger schema or id is not canonical" })
  if (!Array.isArray(artifact.test_leaves) || !Array.isArray(artifact.files))
    findings.push({ code: "PY005-001", path: TEST_LEDGER_PATH, detail: "test_leaves and files must be arrays" })
  const leaves = Array.isArray(artifact.test_leaves) ? artifact.test_leaves : []
  const files = Array.isArray(artifact.files) ? artifact.files : []
  const ids = leaves.map((leaf) => (isRecord(leaf) ? leaf.leaf_id : undefined))
  if (new Set(ids).size !== ids.length)
    findings.push({ code: "PY005-003", path: TEST_LEDGER_PATH, detail: "test leaf IDs are not unique" })
  const paths = files.map((file) => (isRecord(file) ? file.file_path : undefined))
  if (new Set(paths).size !== paths.length)
    findings.push({ code: "PY005-003", path: TEST_LEDGER_PATH, detail: "test file paths are not unique" })
  if (artifact.python_file_count !== files.length || artifact.test_leaf_count !== leaves.length)
    findings.push({ code: "PY005-004", path: TEST_LEDGER_PATH, detail: "artifact counts do not match projections" })
  if (
    artifact.owner_registry_path !== OWNER_REGISTRY_PATH ||
    artifact.owner_registry_digest !== (await ownerRegistryDigest(root))
  )
    findings.push({ code: "PY005-005", path: TEST_LEDGER_PATH, detail: "owner registry binding is stale" })
  const ownerRegistry = await readOwnerRegistry(root).catch(() => ({ entries: [] as JsonRecord[] }))
  const ownerTargetMatches = (value: unknown, relative: string) => {
    if (
      !isRecord(value) ||
      typeof value.domain !== "string" ||
      typeof value.service_path !== "string" ||
      !Array.isArray(value.service_symbols)
    )
      return false
    const expectedDomain = ownerDomainFor(relative)
    const entry = ownerRegistry.entries.find((candidate) => candidate.domain === expectedDomain)
    const service = entry && isRecord(entry.service_owner) ? entry.service_owner : undefined
    const expectedPath = typeof service?.path === "string" ? service.path : undefined
    const expectedSymbols = Array.isArray(service?.symbols)
      ? service.symbols.filter((symbol): symbol is string => typeof symbol === "string")
      : []
    return (
      value.domain === expectedDomain &&
      value.service_path === expectedPath &&
      canonicalJson(value.service_symbols) === canonicalJson(expectedSymbols)
    )
  }

  const currentFullPaths = await listFiles(root)
  const current = new Map<string, { digest: string; bytes: number }>()
  for (const fullPath of currentFullPaths) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    const text = await readFile(fullPath, "utf8")
    current.set(relative, { digest: sourceDigest(text), bytes: Buffer.byteLength(text, "utf8") })
  }
  for (const file of files) {
    if (!isRecord(file) || typeof file.file_path !== "string") continue
    const entry = current.get(file.file_path)
    if (!entry) findings.push({ code: "PY005-006", path: file.file_path, detail: "source test file is missing" })
    else if (entry.digest !== file.source_digest || entry.bytes !== file.byte_length)
      findings.push({ code: "PY005-006", path: file.file_path, detail: "source test digest/size drifted" })
    if (file.status !== "OPEN")
      findings.push({
        code: "PY005-007",
        path: file.file_path,
        detail: "file projection must remain OPEN before conversion evidence",
      })
    if (!isInScope(file.file_path))
      findings.push({
        code: "PY005-002",
        path: file.file_path,
        detail: "file projection is outside the authorized test/fixture roots",
      })
    if (!ownerTargetMatches(file.target_owner, file.file_path))
      findings.push({
        code: "PY005-005",
        path: file.file_path,
        detail: "file target_owner is not bound to the Owner Registry service owner",
      })
  }
  if (current.size !== files.length)
    findings.push({
      code: "PY005-006",
      path: TEST_LEDGER_PATH,
      detail: "current scoped test file count differs from artifact",
    })
  const fileLeafIds = new Set(
    files.flatMap((file) => (isRecord(file) && Array.isArray(file.leaf_ids) ? file.leaf_ids : [])),
  )
  for (const leaf of leaves) {
    if (!isRecord(leaf)) continue
    if (!fileLeafIds.has(leaf.leaf_id))
      findings.push({
        code: "PY005-008",
        path: TEST_LEDGER_PATH,
        detail: "leaf is not referenced by its file projection",
      })
    if (leaf.status !== "OPEN")
      findings.push({ code: "PY005-007", path: TEST_LEDGER_PATH, detail: "test leaf must remain OPEN" })
    if (!TEST_TYPES.includes(leaf.test_type as TestType) || !DISPOSITIONS.includes(leaf.disposition as TestDisposition))
      findings.push({ code: "PY005-009", path: TEST_LEDGER_PATH, detail: "unknown test type or disposition" })
    if (typeof leaf.file_path !== "string" || !isInScope(leaf.file_path))
      findings.push({ code: "PY005-002", path: TEST_LEDGER_PATH, detail: "test leaf is outside the authorized roots" })
    if (!ownerTargetMatches(leaf.target_owner, String(leaf.file_path ?? "")))
      findings.push({
        code: "PY005-005",
        path: TEST_LEDGER_PATH,
        detail: "leaf target_owner is not bound to the Owner Registry service owner",
      })
  }
  try {
    const regenerated = await buildPythonTestsLedger(root)
    if (canonicalJson(artifact) !== canonicalJson(regenerated.artifact)) {
      findings.push({
        code: "PY005-011",
        path: TEST_LEDGER_PATH,
        detail: "checked-in test leaf/file projections do not exactly match deterministic per-definition regeneration",
      })
    }
  } catch (error) {
    findings.push({
      code: "PY005-011",
      path: TEST_LEDGER_PATH,
      detail: "deterministic per-definition test regeneration failed: " + String(error),
    })
  }
  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    if (attestation !== "sha256:" + digestArtifact(artifact))
      findings.push({
        code: "PY005-010",
        path: ATTESTATION_PATH,
        detail: "test ledger attestation does not match artifact",
      })
  } catch (error) {
    findings.push({
      code: "PY005-010",
      path: ATTESTATION_PATH,
      detail: "cannot read test ledger attestation: " + String(error),
    })
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    findings,
    python_file_count: files.length,
    test_leaf_count: leaves.length,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = parseRoot(args)
  if (args[0] === "generate-python-tests-ledger") {
    if (!args.includes("--write")) {
      console.error("generation is read-only unless --write is explicit")
      process.exit(2)
    }
    console.log(JSON.stringify(await writePythonTestsLedger(root), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-python-tests-ledger") {
    const report = await validatePythonTestsLedger(root)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  console.error(
    "usage: bun run script/arforge-python-tests-ledger.ts generate-python-tests-ledger --root <repo> --write | validate-python-tests-ledger --root <repo>",
  )
  process.exit(2)
}
