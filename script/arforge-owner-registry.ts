import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import { canonicalJson, sha256Text, type GovernanceFinding, type JsonRecord } from "./arforge-governance"

const REGISTRY_PATH = "docs/evidence/implementation/owner-registry.v1.json"
const MANIFEST_PATH = "docs/evidence/implementation/protocol-bootstrap.v1.json"
const ATTESTATION_PATH = "docs/evidence/implementation/attestations/owner-registry.v1.sha256"
const REQUIRED_DOMAINS = [
  "session",
  "action",
  "tool",
  "memory",
  "workflow",
  "mcp",
  "subagent",
  "cli",
  "context",
  "sandbox",
  "invariant",
] as const
const REQUIRED_ROLES = ["schema_owner", "service_owner", "store_owner", "writer_owner", "executor_owner"] as const
const PYTHON_MARKERS = [".py", "packages/agent-python", ".venv", "sidecar", "fallback"]
const GOVERNED_SOURCE_ROOTS = [
  "packages/core/src",
  "packages/arforge/src",
  "packages/schema/src",
  "packages/protocol/src",
  "packages/cli/src",
  "packages/server/src",
  "src",
  "script",
] as const
const GOVERNANCE_TOOL_PATHS = new Set([
  "script/arforge-governance.ts",
  "script/arforge-owner-registry.ts",
  "script/arforge-python-ledger.ts",
  "script/arforge-python-tests-ledger.ts",
  "script/arforge-python-dependencies-ledger.ts",
  "script/arforge-python-consumer-audit.ts",
  "script/arforge-ts-boot-gate.ts",
])

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value)

const isSafeRelativePath = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return false
  const normalized = value.replaceAll("\\", "/")
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../")
}

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const finding = (code: string, file: string, detail: string): GovernanceFinding => ({ code, path: file, detail })

const GOVERNED_FORBIDDEN_EXPORTS = /^(?:DeepSeek|PythonCompat|PythonBridge|Second(?:Loop|Registry|Writer|Provider)|LegacyPython)/
const GOVERNANCE_SENSITIVE_EXPORTS = /^(?:DeepSeekLoop|DeepSeekToolPipeline|DeepSeekCheckpoint|PythonCompatRuntime|PythonBridge|Second(?:Loop|Registry|Writer|Provider)|Loop|ToolPipeline|Checkpoint|Registry)$/

const symbolPrograms = new Map<string, ts.Program>()

const resolveQualifiedExport = (root: string, relative: string, qualified: string): boolean => {
  const filePath = resolveSafe(root, relative)
  const cacheKey = filePath
  let program = symbolPrograms.get(cacheKey)
  if (!program) {
    program = ts.createProgram([filePath], {
      allowJs: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    })
    symbolPrograms.set(cacheKey, program)
  }
  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) return false
  const checker = program.getTypeChecker()
  let current = checker.getSymbolAtLocation(sourceFile)
  if (!current) return false
  for (const [index, part] of qualified.split(".").entries()) {
    let exports: readonly ts.Symbol[] = []
    try {
      exports = checker.getExportsOfModule(current)
    } catch {
      exports = []
    }
    let next = exports.find((candidate) => candidate.name === part)
    if (!next && index === 0) next = checker.getSymbolsInScope(sourceFile, ts.SymbolFlags.All).find((candidate) => candidate.name === part)
    if (!next) return false
    if ((next.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        next = checker.getAliasedSymbol(next)
      } catch {
        return false
      }
    }
    current = next
  }
  return true
}

const readJson = async (root: string, relative: string, findings: GovernanceFinding[]): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(resolveSafe(root, relative), "utf8")) as unknown
  } catch (error) {
    findings.push(finding("PY001-001", relative, "cannot read valid JSON: " + String(error)))
    return undefined
  }
}

const validatePath = async (
  root: string,
  relative: unknown,
  file: string,
  role: string,
  findings: GovernanceFinding[],
  requireFile = true,
) => {
  if (!isSafeRelativePath(relative)) {
    findings.push(finding("PY001-002", file, role + " path is not a safe repository-relative path"))
    return
  }
  const normalized = relative.replaceAll("\\", "/").toLowerCase()
  if (PYTHON_MARKERS.some((marker) => normalized.includes(marker)) || normalized === "arforge" || normalized.startsWith("arforge/")) {
    findings.push(finding("PY001-009", file, role + " path points at a Python runtime, sidecar or fallback"))
  }
  try {
    const info = await stat(resolveSafe(root, relative))
    if (requireFile && !info.isFile()) findings.push(finding("PY001-002", file, role + " path must resolve to a file"))
  } catch (error) {
    findings.push(finding("PY001-002", file, role + " path does not exist: " + String(error)))
  }
}

const validateSymbols = async (root: string, owner: JsonRecord, file: string, role: string, findings: GovernanceFinding[]) => {
  if (!isSafeRelativePath(owner.path)) return
  if (!Array.isArray(owner.symbols)) return
  try {
    for (const symbol of owner.symbols) {
      if (typeof symbol !== "string" || symbol.length === 0) continue
      if (!resolveQualifiedExport(root, owner.path, symbol)) {
        findings.push(finding("PY001-010", file, role + " symbol is not present in its owner file: " + symbol))
      }
    }
  } catch {
    // validatePath reports missing/unreadable owner files; avoid duplicating that finding here.
  }
}

const listGovernedSourceFiles = async (root: string): Promise<string[]> => {
  const result: string[] = []
  const visit = async (directory: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true }) as import("node:fs").Dirent[]
    } catch {
      return
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).replaceAll("\\", "/")
      const lower = relative.toLowerCase()
      if (lower.includes("/node_modules/") || lower.includes("/.git/") || lower.includes("/.arforge/") || lower.includes("/.turbo/") || lower.includes("/dist/") || lower.includes("/out/")) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && (lower.endsWith(".ts") || lower.endsWith(".tsx"))) result.push(full)
    }
  }
  for (const sourceRoot of GOVERNED_SOURCE_ROOTS) {
    try {
      await visit(resolveSafe(root, sourceRoot))
    } catch {
      // Explicit governed roots may be absent in a minimal fixture.
    }
  }
  return [...new Set(result)].toSorted((left, right) => left.localeCompare(right))
}

const sourceTokensWithoutLiterals = (source: string): string => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
  const ignored = new Set([
    ts.SyntaxKind.SingleLineCommentTrivia,
    ts.SyntaxKind.MultiLineCommentTrivia,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
  ])
  const tokens: string[] = []
  while (true) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken) break
    if (!ignored.has(kind)) tokens.push(scanner.getTokenText())
  }
  return tokens.join(" ")
}

const validateGovernedSourceSafety = async (root: string, registry: JsonRecord, findings: GovernanceFinding[]) => {
  const paths = new Set<string>()
  const claimedKeys = new Set<string>()
  const entries = Array.isArray(registry.entries) ? registry.entries.filter(isRecord) : []
  for (const entry of entries) {
    for (const role of REQUIRED_ROLES) {
      const owner = entry[role]
      if (isRecord(owner) && isSafeRelativePath(owner.path)) {
        paths.add(owner.path)
        if (Array.isArray(owner.symbols)) for (const symbol of owner.symbols) if (typeof symbol === "string") claimedKeys.add(owner.path + "#" + (symbol.split(".").at(-1) ?? symbol))
      }
    }
    for (const publicEntrypoint of Array.isArray(entry.public_entrypoints) ? entry.public_entrypoints : []) {
      if (isSafeRelativePath(publicEntrypoint)) paths.add(publicEntrypoint)
    }
  }
  const forbiddenParallelNames = new Set(
    (Array.isArray(registry.forbidden_parallel_names) ? registry.forbidden_parallel_names : []).filter((value): value is string => typeof value === "string"),
  )
  const claimedSensitiveNames = new Set<string>(forbiddenParallelNames)
  for (const key of claimedKeys) {
    const terminal = key.split("#").at(-1)
    if (terminal && !new Set(["Service", "Info", "Scope", "Store", "Writer", "Executor", "Request", "Config", "State", "make", "compile", "create", "execute"]).has(terminal)) claimedSensitiveNames.add(terminal)
  }
  const forbiddenExports = new Set<string>()
  const sensitiveExports = new Map<string, string[]>()
  const governedFiles = await listGovernedSourceFiles(root)
  const governedFileSet = new Set(governedFiles.map((file) => path.resolve(file)))
  const program = ts.createProgram(governedFiles, {
    allowJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  })
  const checker = program.getTypeChecker()
  const inspectExport = (relative: string, exportedName: string, targetName?: string) => {
    for (const name of [exportedName, targetName].filter((value): value is string => typeof value === "string")) {
      if (GOVERNED_FORBIDDEN_EXPORTS.test(name)) forbiddenExports.add(relative + "#" + name)
      if (GOVERNANCE_SENSITIVE_EXPORTS.test(name) && claimedSensitiveNames.has(name)) sensitiveExports.set(name, [...(sensitiveExports.get(name) ?? []), relative])
    }
  }
  for (const fullPath of governedFiles) {
    const relative = path.relative(root, fullPath).replaceAll("\\", "/")
    try {
      const source = await readFile(fullPath, "utf8")
      const sourceFile = program.getSourceFile(path.resolve(fullPath))
      if (sourceFile) {
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
        if (moduleSymbol) {
          for (const exported of checker.getExportsOfModule(moduleSymbol)) {
            let targetName: string | undefined
            if ((exported.flags & ts.SymbolFlags.Alias) !== 0) {
              try {
                targetName = checker.getAliasedSymbol(exported).name
              } catch {
                targetName = undefined
              }
            }
            inspectExport(relative, exported.name, targetName)
          }
        }
      }
      const sourceTokens = sourceTokensWithoutLiterals(source)
      const runtimeMarkers = /\b(?:PythonCompatRuntime|PythonBridge|LegacyPythonRuntime|fallbackRuntime|fallbackProvider|fallbackLoop)\b|packages[\\/]agent-python/i
      const launchesPython = /\b(?:spawn|exec|execFile|Command)\s*\([^\n]*(?:python|\.py|agent-python)/i.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, ""))
      if (!GOVERNANCE_TOOL_PATHS.has(relative) && !relative.endsWith(".test.ts") && !relative.endsWith(".spec.ts") && (runtimeMarkers.test(sourceTokens) || launchesPython)) {
        findings.push(finding("PY001-011", relative, "governed TypeScript source contains a Python runtime or fallback marker"))
      }
    } catch {
      // validatePath and validateSymbols report missing/unreadable owner sources.
    }
  }
  // Registry entries/public entrypoints may point outside the explicit roots;
  // inspect those too, but only once, while the program above covers every
  // governed source (including re-export forms) rather than only listed files.
  for (const relative of paths) {
    const fullPath = path.resolve(resolveSafe(root, relative))
    if (governedFileSet.has(fullPath)) continue
    try {
      const source = await readFile(fullPath, "utf8")
      const sourceFile = ts.createSourceFile(fullPath, source, ts.ScriptTarget.Latest, true, relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      for (const statement of sourceFile.statements) {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
        if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
        const name = ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isModuleDeclaration(statement)
          ? statement.name?.text
          : ts.isVariableStatement(statement)
            ? statement.declarationList.declarations.find((declaration) => ts.isIdentifier(declaration.name))?.name.getText(sourceFile)
            : undefined
        if (name) inspectExport(relative, name)
      }
    } catch {
      // validatePath and validateSymbols report missing/unreadable owner sources.
    }
  }
  for (const exported of forbiddenExports) findings.push(finding("PY001-011", exported, "forbidden parallel owner export detected in governed TypeScript source"))
  for (const [name, owners] of sensitiveExports) {
    const uniqueOwners = [...new Set(owners)]
    if (uniqueOwners.length > 1) findings.push(finding("PY001-012", uniqueOwners.join(","), "governance-sensitive owner symbol is exported by multiple governed sources"))
    for (const ownerPath of uniqueOwners) if (!claimedKeys.has(ownerPath + "#" + name)) findings.push(finding("PY001-012", ownerPath + "#" + name, "governance-sensitive owner export is not bound to the Owner Registry"))
  }
}

export async function validateOwnerRegistry(root: string): Promise<{ schema_version: "1.0"; valid: boolean; findings: GovernanceFinding[] }> {
  const findings: GovernanceFinding[] = []
  const registry = await readJson(root, REGISTRY_PATH, findings)
  const manifest = await readJson(root, MANIFEST_PATH, findings)
  if (!isRecord(registry)) return { schema_version: "1.0", valid: false, findings }

  if (registry.schema_version !== "1.0") findings.push(finding("PY001-001", REGISTRY_PATH, "schema_version must be 1.0"))
  if (registry.registry_id !== "ts-owner-registry") findings.push(finding("PY001-001", REGISTRY_PATH, "registry_id is not canonical"))
  if (registry.status !== "REGISTERED") findings.push(finding("PY001-006", REGISTRY_PATH, "registry must be REGISTERED"))
  if (registry.protocol_manifest !== MANIFEST_PATH) findings.push(finding("PY001-003", REGISTRY_PATH, "protocol_manifest is not canonical"))

  if (isRecord(manifest)) {
    const expectedManifestDigest = sha256Text(canonicalJson(manifest))
    if (registry.manifest_digest !== expectedManifestDigest) {
      findings.push(finding("PY001-004", REGISTRY_PATH, "manifest_digest does not match normalized bootstrap manifest"))
    }
  }

  const requiredDomains = Array.isArray(registry.required_domains) ? registry.required_domains : []
  for (const domain of REQUIRED_DOMAINS) {
    if (!requiredDomains.includes(domain)) findings.push(finding("PY001-001", REGISTRY_PATH, "required domain missing: " + domain))
  }
  const entries = Array.isArray(registry.entries) ? registry.entries : []
  const seenDomains = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const file = REGISTRY_PATH + "#entries[" + index + "]"
    if (!isRecord(entry)) {
      findings.push(finding("PY001-001", file, "entry must be an object"))
      continue
    }
    const domain = typeof entry.domain === "string" ? entry.domain : ""
    if (!domain || !REQUIRED_DOMAINS.includes(domain as (typeof REQUIRED_DOMAINS)[number])) {
      findings.push(finding("PY001-001", file, "entry domain is not in the required domain set"))
    } else if (seenDomains.has(domain)) {
      findings.push(finding("PY001-003", file, "duplicate authoritative domain"))
    } else {
      seenDomains.add(domain)
    }
    if (entry.status !== "REGISTERED") findings.push(finding("PY001-006", file, "entry status must be REGISTERED"))
    if (entry.disposition !== "MERGE" && entry.disposition !== "PORT" && entry.disposition !== "REPLACE") {
      findings.push(finding("PY001-005", file, "entry disposition must be MERGE, PORT or REPLACE"))
    }
    for (const role of REQUIRED_ROLES) {
      const owner = entry[role]
      if (!isRecord(owner)) {
        findings.push(finding("PY001-003", file, role + " must have exactly one owner object"))
        continue
      }
      const symbols = owner.symbols
      if (!Array.isArray(symbols) || symbols.length === 0 || symbols.some((symbol) => typeof symbol !== "string" || symbol.length === 0)) {
        findings.push(finding("PY001-003", file, role + " must declare at least one symbol"))
      }
      await validatePath(root, owner.path, file, role, findings)
      await validateSymbols(root, owner, file, role, findings)
    }
    const publicEntrypoints = Array.isArray(entry.public_entrypoints) ? entry.public_entrypoints : []
    if (publicEntrypoints.length === 0) findings.push(finding("PY001-003", file, "public_entrypoints must be non-empty"))
    for (const [entryIndex, publicPath] of publicEntrypoints.entries()) {
      await validatePath(root, publicPath, file + ".public_entrypoints[" + entryIndex + "]", "public entrypoint", findings)
    }
    if (!Array.isArray(entry.forbidden_parallel_truths) || entry.forbidden_parallel_truths.length === 0) {
      findings.push(finding("PY001-008", file, "forbidden_parallel_truths must be explicit"))
    }
    const evidenceRefs = Array.isArray(entry.evidence_refs) ? entry.evidence_refs : []
    for (const [evidenceIndex, evidencePath] of evidenceRefs.entries()) {
      await validatePath(root, evidencePath, file + ".evidence_refs[" + evidenceIndex + "]", "evidence reference", findings)
    }
  }
  for (const required of REQUIRED_DOMAINS) {
    if (!seenDomains.has(required)) findings.push(finding("PY001-001", REGISTRY_PATH, "exactly one entry is required for domain: " + required))
  }

  await validateGovernedSourceSafety(root, registry, findings)

  const forbiddenNames = Array.isArray(registry.forbidden_parallel_names) ? registry.forbidden_parallel_names : []
  for (const requiredName of ["DeepSeekLoop", "DeepSeekToolPipeline", "DeepSeekCheckpoint", "PythonCompatRuntime"]) {
    if (!forbiddenNames.includes(requiredName)) findings.push(finding("PY001-008", REGISTRY_PATH, "required forbidden parallel name is missing: " + requiredName))
  }
  const registryText = canonicalJson({ ...registry, forbidden_parallel_names: [] })
  for (const name of forbiddenNames) {
    if (typeof name !== "string" || name.length === 0) findings.push(finding("PY001-008", REGISTRY_PATH, "forbidden name is invalid"))
  }
  if (registryText.includes("DeepSeekLoop") || registryText.includes("DeepSeekToolPipeline") || registryText.includes("PythonCompatRuntime")) {
    findings.push(finding("PY001-008", REGISTRY_PATH, "registry contains a forbidden transitional parallel owner name"))
  }

  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    const registryDigest = sha256Text(canonicalJson(registry))
    if (attestation !== "sha256:" + registryDigest) findings.push(finding("PY001-004", ATTESTATION_PATH, "detached registry attestation does not match normalized registry bytes"))
  } catch (error) {
    findings.push(finding("PY001-004", ATTESTATION_PATH, "cannot read detached registry attestation: " + String(error)))
  }

  return { schema_version: "1.0", valid: findings.length === 0, findings }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] !== "validate-owner-registry") {
    console.error("usage: bun run script/arforge-owner-registry.ts validate-owner-registry --root <repo>")
    process.exit(2)
  }
  const report = await validateOwnerRegistry(parseRoot(args))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.valid ? 0 : 1)
}
