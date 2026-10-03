import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import { canonicalJson, sha256Text, type GovernanceFinding, type JsonRecord } from "./arforge-governance"

export const TOPOLOGY_PATH = "docs/evidence/implementation/ts-session-composition.v1.json"
export const ATTESTATION_PATH = "docs/evidence/implementation/attestations/ts-session-composition.v1.sha256"
export const OWNER_REGISTRY_PATH = "docs/evidence/implementation/owner-registry.v1.json"
export const SOURCE_REVISION = "92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8"

const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/arforge/src",
  "packages/server/src",
  "packages/cli/src",
  "packages/desktop/src",
  "packages/app/src",
  "packages/sdk-next/src",
  "src",
] as const

const CORE_EXECUTION_PATH = "packages/core/src/session/execution.ts"
const CORE_LOCAL_EXECUTION_PATH = "packages/core/src/session/execution/local.ts"
const FORMAL_EXECUTION_PATH = "packages/arforge/src/session/execution-formal.ts"
const EXCLUDED_SEGMENTS = ["node_modules", ".git", ".arforge", ".turbo", "dist", "out"]

type RunnerUseKind = "core_executor" | "core_local_executor" | "mature_adapter" | "formal_adapter" | "external_bypass"

export type SourceRecord = {
  readonly path: string
  readonly source_digest: string
  readonly byte_length: number
}

export type RunnerServiceUse = {
  readonly source_path: string
  readonly line: number
  readonly column: number
  readonly kind: RunnerUseKind
  readonly symbol: "SessionRunner.Service"
}

export type CompositionBinding = {
  readonly source_path: string
  readonly line: number
  readonly column: number
  readonly builder: "AppNodeBuilder.build" | "AppNodeBuilderV1.build" | null
  readonly service_symbol: "SessionExecution.node"
  readonly provider_symbol:
    | "SessionExecutionMature.node"
    | "SessionExecutionFormal.node"
    | "SessionExecutionLocal.node"
    | null
  readonly provider_path: string | null
  readonly provider_line: number | null
}

export type CompositionRoot = {
  readonly source_path: string
  readonly builders: readonly ("AppNodeBuilder.build" | "AppNodeBuilderV1.build")[]
  readonly bindings: readonly CompositionBinding[]
}

export type EntrypointReference = {
  readonly source_path: string
  readonly source_digest: string
  readonly public_entrypoint: boolean
}

export type TopologyArtifact = {
  readonly schema_version: "1.0"
  readonly ledger_id: "ts-session-composition"
  readonly plan_revision: "v1.3"
  readonly source_revision: string
  readonly owner_registry_path: string
  readonly owner_registry_digest: string
  readonly work_package: "PY-101"
  readonly status: "OPEN"
  readonly disposition: "CONVERGE"
  readonly contract: {
    readonly service_owner: "packages/core/src/session/execution.ts#SessionExecution.Service"
    readonly composition_token: "SessionExecution.node"
    readonly runner_service: "SessionRunner.Service"
    readonly allowed_runner_paths: readonly string[]
    readonly transitional_runner_paths: readonly string[]
    readonly external_runner_service_uses: readonly RunnerServiceUse[]
  }
  readonly source_file_count: number
  readonly composition_root_count: number
  readonly composition_binding_count: number
  readonly runner_service_use_count: number
  readonly entrypoint_reference_count: number
  readonly source_files: readonly SourceRecord[]
  readonly composition_roots: readonly CompositionRoot[]
  readonly runner_service_uses: readonly RunnerServiceUse[]
  readonly entrypoint_references: readonly EntrypointReference[]
  readonly invariants: {
    readonly composition_bindings_use_service_token: boolean
    readonly composition_bindings_have_one_provider: boolean
    readonly no_external_runner_service_use: boolean
    readonly no_runner_selected_by_composition_root: boolean
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const sourceDigest = (bytes: Uint8Array) => sha256Text(Buffer.from(bytes).toString("utf8"))

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const lineAndColumn = (sourceFile: ts.SourceFile, position: number) => {
  const location = sourceFile.getLineAndCharacterOfPosition(position)
  return { line: location.line + 1, column: location.character + 1 }
}

const listSourceFiles = async (root: string): Promise<string[]> => {
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
      if (
        EXCLUDED_SEGMENTS.some(
          (segment) => lower.includes("/" + segment.toLowerCase() + "/") || lower.endsWith("/" + segment.toLowerCase()),
        )
      )
        continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && (lower.endsWith(".ts") || lower.endsWith(".tsx")) && !lower.endsWith(".d.ts"))
        result.push(full)
    }
  }
  for (const sourceRoot of SOURCE_ROOTS) await visit(resolveSafe(root, sourceRoot))
  return [...new Set(result)].toSorted((left, right) => left.localeCompare(right))
}

const runnerKind = (relative: string): RunnerUseKind => {
  if (relative === CORE_EXECUTION_PATH) return "core_executor"
  if (relative === CORE_LOCAL_EXECUTION_PATH) return "core_local_executor"
  if (relative === FORMAL_EXECUTION_PATH) return "formal_adapter"
  return "external_bypass"
}

const providerPath = (symbol: CompositionBinding["provider_symbol"]) => {
  // Keep recognizing the retired symbol so a restored binding fails closed.
  if (symbol === "SessionExecutionMature.node") return null
  if (symbol === "SessionExecutionFormal.node") return FORMAL_EXECUTION_PATH
  if (symbol === "SessionExecutionLocal.node") return CORE_LOCAL_EXECUTION_PATH
  return null
}

type PropertyRecord = { readonly node: ts.PropertyAccessExpression; readonly line: number; readonly column: number }

const inspectSource = (root: string, fullPath: string, source: string) => {
  const relative = path.relative(root, fullPath).replaceAll("\\", "/")
  const scriptKind = fullPath.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind)
  const sessionNodes: PropertyRecord[] = []
  const providers: Array<PropertyRecord & { readonly symbol: NonNullable<CompositionBinding["provider_symbol"]> }> = []
  const runnerUses: RunnerServiceUse[] = []
  const builders: Array<{
    readonly node: ts.CallExpression
    readonly builder: NonNullable<CompositionBinding["builder"]>
  }> = []
  const sessionAliases = new Set(["SessionExecution"])
  const matureAliases = new Set(["SessionExecutionMature"])
  const formalAliases = new Set(["SessionExecutionFormal"])
  const localAliases = new Set(["SessionExecutionLocal"])
  const runnerAliases = new Set(["SessionRunner"])
  const builderAliases = new Map<string, "AppNodeBuilder.build" | "AppNodeBuilderV1.build">([
    ["AppNodeBuilder", "AppNodeBuilder.build"],
    ["AppNodeBuilderV1", "AppNodeBuilderV1.build"],
  ])
  let importsSessionExecution = false

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = node.moduleSpecifier.getText(sourceFile)
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = element.name.text
          const imported = element.propertyName?.text ?? name
          if (
            ["SessionExecution", "SessionExecutionMature", "SessionExecutionFormal", "SessionExecutionLocal"].includes(
              name,
            ) ||
            ["SessionExecution", "SessionExecutionMature", "SessionExecutionFormal", "SessionExecutionLocal"].includes(
              imported,
            )
          )
            importsSessionExecution = true
          if (imported === "SessionExecution") sessionAliases.add(name)
          if (imported === "SessionExecutionMature") matureAliases.add(name)
          if (imported === "SessionExecutionFormal") formalAliases.add(name)
          if (imported === "SessionExecutionLocal") localAliases.add(name)
          if (imported === "SessionRunner" && moduleName.includes("session/runner")) runnerAliases.add(name)
          if (imported === "AppNodeBuilder") builderAliases.set(name, "AppNodeBuilder.build")
          if (imported === "AppNodeBuilderV1") builderAliases.set(name, "AppNodeBuilderV1.build")
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        const name = bindings.name.text
        if (moduleName.includes("session/runner")) runnerAliases.add(name)
        if (moduleName.includes("session/execution-formal")) formalAliases.add(name)
        else if (moduleName.includes("session/execution/local")) localAliases.add(name)
        else if (moduleName.includes("session/execution")) sessionAliases.add(name)
        if (moduleName.includes("app-node-builder"))
          builderAliases.set(name, moduleName.includes("-v1") ? "AppNodeBuilderV1.build" : "AppNodeBuilder.build")
      }
      if (moduleName.includes("session/execution")) importsSessionExecution = true
    }
    if (ts.isPropertyAccessExpression(node)) {
      const left = node.expression.getText(sourceFile)
      const name = node.name.text
      const location = lineAndColumn(sourceFile, node.getStart(sourceFile))
      if (runnerAliases.has(left) && name === "Service") {
        runnerUses.push({
          source_path: relative,
          ...location,
          kind: runnerKind(relative),
          symbol: "SessionRunner.Service",
        })
      }
      if (sessionAliases.has(left) && name === "node") sessionNodes.push({ node, ...location })
      if (name === "node" && (matureAliases.has(left) || formalAliases.has(left) || localAliases.has(left))) {
        const symbol = matureAliases.has(left)
          ? "SessionExecutionMature.node"
          : formalAliases.has(left)
            ? "SessionExecutionFormal.node"
            : "SessionExecutionLocal.node"
        providers.push({ node, ...location, symbol })
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "build"
    ) {
      const builderName = node.expression.expression.getText(sourceFile)
      const builder = builderAliases.get(builderName)
      if (builder) {
        builders.push({ node, builder })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const bindings: CompositionBinding[] = sessionNodes.flatMap(({ node, line, column }) => {
    const containingBuilder = builders.find(
      ({ node: builder }) =>
        node.getStart(sourceFile) >= builder.getStart(sourceFile) && node.getEnd() <= builder.getEnd(),
    )
    if (!containingBuilder) return []
    const candidates = providers
      .filter(
        (candidate) =>
          candidate.node.getStart(sourceFile) >= containingBuilder.node.getStart(sourceFile) &&
          candidate.node.getEnd() <= containingBuilder.node.getEnd(),
      )
      .toSorted((left, right) => left.line - right.line || left.column - right.column)
    const providerSymbols = [...new Set(candidates.map((candidate) => candidate.symbol))]
    const provider = providerSymbols.length === 1 ? candidates[0] : undefined
    return [
      {
        source_path: relative,
        line,
        column,
        builder: containingBuilder?.builder ?? null,
        service_symbol: "SessionExecution.node",
        provider_symbol: provider?.symbol ?? null,
        provider_path: providerPath(provider?.symbol ?? null),
        provider_line: provider?.line ?? null,
      },
    ]
  })

  return {
    relative,
    sourceFile,
    sourceRecord: {
      path: relative,
      source_digest: sourceDigest(Buffer.from(source, "utf8")),
      byte_length: Buffer.byteLength(source, "utf8"),
    } satisfies SourceRecord,
    bindings,
    runnerUses,
    builders: builders.map(({ builder }) => builder),
    importsSessionExecution,
  }
}

const publicSessionEntrypoints = async (root: string, sourceRecords: readonly SourceRecord[]) => {
  try {
    const registry = JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8")) as JsonRecord
    const entries = Array.isArray(registry.entries) ? registry.entries.filter(isRecord) : []
    const session = entries.find((entry) => entry.domain === "session")
    const paths = Array.isArray(session?.public_entrypoints)
      ? session.public_entrypoints.filter((value): value is string => typeof value === "string")
      : []
    return paths
      .map((publicEntrypoint) => {
        const source = sourceRecords.find((candidate) => candidate.path === publicEntrypoint)
        return source
          ? { source_path: publicEntrypoint, source_digest: source.source_digest, public_entrypoint: true }
          : undefined
      })
      .filter((value): value is EntrypointReference => value !== undefined)
  } catch {
    return []
  }
}

export async function buildTsCompositionArtifact(root: string): Promise<TopologyArtifact> {
  const fullPaths = await listSourceFiles(root)
  const inspected = []
  for (const fullPath of fullPaths) {
    const source = await readFile(fullPath, "utf8")
    inspected.push(inspectSource(root, fullPath, source))
  }
  const sourceFiles = inspected
    .map((item) => item.sourceRecord)
    .toSorted((left, right) => left.path.localeCompare(right.path))
  const compositionRoots = inspected
    .filter((item) => item.bindings.length > 0)
    .map((item) => ({
      source_path: item.relative,
      builders: [...new Set(item.builders)].toSorted() as Array<"AppNodeBuilder.build" | "AppNodeBuilderV1.build">,
      bindings: item.bindings.toSorted((left, right) => left.line - right.line || left.column - right.column),
    }))
  const runnerUses = inspected
    .flatMap((item) => item.runnerUses)
    .toSorted(
      (left, right) =>
        left.source_path.localeCompare(right.source_path) || left.line - right.line || left.column - right.column,
    )
  const registry = JSON.parse(await readFile(resolveSafe(root, OWNER_REGISTRY_PATH), "utf8")) as JsonRecord
  const registryDigest = sha256Text(canonicalJson(registry))
  const entrypointReferences = await publicSessionEntrypoints(root, sourceFiles)
  const externalRunnerUses = runnerUses.filter((use) => use.kind === "external_bypass")
  const transitional = runnerUses
    .filter((use) => use.kind === "mature_adapter")
    .map((use) => use.source_path)
    .filter((value, index, values) => values.indexOf(value) === index)
    .toSorted()
  const bindingsUseToken = compositionRoots.every((rootEntry) =>
    rootEntry.bindings.every((binding) => binding.service_symbol === "SessionExecution.node"),
  )
  const bindingsHaveOneProvider = compositionRoots.every((rootEntry) =>
    rootEntry.bindings.every(
      (binding) => binding.provider_symbol !== null && binding.provider_path !== null && binding.builder !== null,
    ),
  )
  return {
    schema_version: "1.0",
    ledger_id: "ts-session-composition",
    plan_revision: "v1.3",
    source_revision: SOURCE_REVISION,
    owner_registry_path: OWNER_REGISTRY_PATH,
    owner_registry_digest: registryDigest,
    work_package: "PY-101",
    status: "OPEN",
    disposition: "CONVERGE",
    contract: {
      service_owner: "packages/core/src/session/execution.ts#SessionExecution.Service",
      composition_token: "SessionExecution.node",
      runner_service: "SessionRunner.Service",
      allowed_runner_paths: [CORE_EXECUTION_PATH, CORE_LOCAL_EXECUTION_PATH, FORMAL_EXECUTION_PATH],
      transitional_runner_paths: transitional,
      external_runner_service_uses: externalRunnerUses,
    },
    source_file_count: sourceFiles.length,
    composition_root_count: compositionRoots.length,
    composition_binding_count: compositionRoots.reduce((total, entry) => total + entry.bindings.length, 0),
    runner_service_use_count: runnerUses.length,
    entrypoint_reference_count: entrypointReferences.length,
    source_files: sourceFiles,
    composition_roots: compositionRoots,
    runner_service_uses: runnerUses,
    entrypoint_references: entrypointReferences,
    invariants: {
      composition_bindings_use_service_token: bindingsUseToken,
      composition_bindings_have_one_provider: bindingsHaveOneProvider,
      no_external_runner_service_use: externalRunnerUses.length === 0,
      no_runner_selected_by_composition_root: externalRunnerUses.length === 0,
    },
  }
}

const digestArtifact = (artifact: unknown) => sha256Text(canonicalJson(artifact))

export async function writeTsCompositionArtifact(root: string) {
  const artifact = await buildTsCompositionArtifact(root)
  await mkdir(resolveSafe(root, path.dirname(TOPOLOGY_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, TOPOLOGY_PATH), JSON.stringify(artifact, null, 2) + "\n")
  const digest = digestArtifact(artifact)
  await writeFile(resolveSafe(root, ATTESTATION_PATH), "sha256:" + digest + "\n")
  return {
    source_file_count: artifact.source_file_count,
    composition_root_count: artifact.composition_root_count,
    composition_binding_count: artifact.composition_binding_count,
    runner_service_use_count: artifact.runner_service_use_count,
    artifact_digest: digest,
  }
}

export async function validateTsCompositionArtifact(root: string) {
  const findings: GovernanceFinding[] = []
  let artifact: TopologyArtifact
  try {
    artifact = JSON.parse(await readFile(resolveSafe(root, TOPOLOGY_PATH), "utf8")) as TopologyArtifact
  } catch (error) {
    return {
      schema_version: "1.0" as const,
      valid: false,
      findings: [
        { code: "PY101-001", path: TOPOLOGY_PATH, detail: "cannot read valid topology artifact: " + String(error) },
      ],
    }
  }
  if (
    artifact.schema_version !== "1.0" ||
    artifact.ledger_id !== "ts-session-composition" ||
    artifact.work_package !== "PY-101"
  )
    findings.push({ code: "PY101-001", path: TOPOLOGY_PATH, detail: "topology artifact identity is not canonical" })
  const expected = await buildTsCompositionArtifact(root)
  if (canonicalJson(artifact) !== canonicalJson(expected))
    findings.push({
      code: "PY101-002",
      path: TOPOLOGY_PATH,
      detail: "topology artifact is stale or does not equal deterministic source scan",
    })
  if (artifact.composition_root_count < 1)
    findings.push({
      code: "PY101-003",
      path: TOPOLOGY_PATH,
      detail: "no SessionExecution composition root was discovered",
    })
  if (!artifact.invariants?.composition_bindings_use_service_token)
    findings.push({
      code: "PY101-004",
      path: TOPOLOGY_PATH,
      detail: "composition binding does not use SessionExecution.node",
    })
  if (!artifact.invariants?.composition_bindings_have_one_provider)
    findings.push({
      code: "PY101-005",
      path: TOPOLOGY_PATH,
      detail: "composition binding is outside AppNodeBuilder or has no unique provider",
    })
  if (
    !artifact.invariants?.no_external_runner_service_use ||
    !artifact.invariants?.no_runner_selected_by_composition_root ||
    artifact.contract.external_runner_service_uses.length > 0
  )
    findings.push({
      code: "PY101-006",
      path: TOPOLOGY_PATH,
      detail: "non-canonical source calls SessionRunner.Service",
    })
  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    if (attestation !== "sha256:" + digestArtifact(artifact))
      findings.push({
        code: "PY101-007",
        path: ATTESTATION_PATH,
        detail: "topology artifact attestation does not match",
      })
  } catch (error) {
    findings.push({
      code: "PY101-007",
      path: ATTESTATION_PATH,
      detail: "cannot read topology artifact attestation: " + String(error),
    })
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    findings,
    source_file_count: artifact.source_file_count,
    composition_root_count: artifact.composition_root_count,
    composition_binding_count: artifact.composition_binding_count,
    runner_service_use_count: artifact.runner_service_use_count,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = parseRoot(args)
  if (args[0] === "generate-ts-composition-ledger") {
    if (!args.includes("--write")) {
      console.error("generation is read-only unless --write is explicit")
      process.exit(2)
    }
    console.log(JSON.stringify(await writeTsCompositionArtifact(root), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-ts-composition-ledger") {
    const report = await validateTsCompositionArtifact(root)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  console.error(
    "usage: bun run script/arforge-ts-composition-ledger.ts generate-ts-composition-ledger --root <repo> --write | validate-ts-composition-ledger --root <repo>",
  )
  process.exit(2)
}
