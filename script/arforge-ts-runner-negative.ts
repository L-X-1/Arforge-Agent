import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import { canonicalJson, sha256Text, type GovernanceFinding } from "./arforge-governance"
import { buildTsCompositionArtifact, TOPOLOGY_PATH, type TopologyArtifact } from "./arforge-ts-composition-ledger"

export const NEGATIVE_PATH = "docs/evidence/implementation/ts-runner-negative.v1.json"
export const ATTESTATION_PATH = "docs/evidence/implementation/attestations/ts-runner-negative.v1.sha256"
export const SOURCE_REVISION = "92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8"

const SELECTOR_MARKERS = [
  "executionMode",
  "runnerMode",
  "useRunner",
  "selectRunner",
  "chooseRunner",
  "runnerProvider",
  "executionProvider",
] as const
const TRANSITIONAL_MARKER = "drainScoped"

type SelectorMarker = (typeof SELECTOR_MARKERS)[number]

export type SelectorSignal = {
  readonly source_path: string
  readonly line: number
  readonly column: number
  readonly marker: SelectorMarker
  readonly classification: "forbidden_option_selector"
}

export type TransitionalSignal = {
  readonly source_path: string
  readonly line: number
  readonly column: number
  readonly marker: typeof TRANSITIONAL_MARKER
  readonly classification: "transitional_adapter"
}

export type DuplicateProviderBinding = {
  readonly source_path: string
  readonly line: number
  readonly column: number
  readonly builder: "AppNodeBuilder.build" | "AppNodeBuilderV1.build"
  readonly service_binding_count: number
  readonly provider_binding_count: number
}

export type RunnerNegativeArtifact = {
  readonly schema_version: "1.0"
  readonly ledger_id: "ts-runner-negative"
  readonly plan_revision: "v1.3"
  readonly source_revision: string
  readonly work_package: "PY-105"
  readonly status: "OPEN"
  readonly disposition: "CONVERGE"
  readonly topology_artifact_path: typeof TOPOLOGY_PATH
  readonly topology_artifact_digest: string
  readonly selector_signals: readonly SelectorSignal[]
  readonly transitional_signals: readonly TransitionalSignal[]
  readonly duplicate_provider_bindings: readonly DuplicateProviderBinding[]
  readonly external_runner_service_uses: TopologyArtifact["runner_service_uses"]
  readonly public_runner_entry_uses: TopologyArtifact["runner_service_uses"]
  readonly invariants: {
    readonly no_forbidden_option_selector: boolean
    readonly no_duplicate_session_execution_provider: boolean
    readonly no_external_runner_service_bypass: boolean
    readonly no_second_public_runner_entry: boolean
  }
}

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

const digestArtifact = (artifact: unknown) => sha256Text(canonicalJson(artifact))

const lineAndColumn = (sourceFile: ts.SourceFile, position: number) => {
  const location = sourceFile.getLineAndCharacterOfPosition(position)
  return { line: location.line + 1, column: location.character + 1 }
}

type BuilderAliases = Map<string, "AppNodeBuilder.build" | "AppNodeBuilderV1.build">
type BuilderKind = "AppNodeBuilder.build" | "AppNodeBuilderV1.build"

const aliasesForSource = (sourceFile: ts.SourceFile) => {
  const sessionAliases = new Set(["SessionExecution"])
  const providerAliases = new Set(["SessionExecutionMature", "SessionExecutionFormal", "SessionExecutionLocal"])
  const builderAliases: BuilderAliases = new Map([
    ["AppNodeBuilder", "AppNodeBuilder.build"],
    ["AppNodeBuilderV1", "AppNodeBuilderV1.build"],
  ])
  const visitImports = (node: ts.Node) => {
    if (!ts.isImportDeclaration(node)) return
    const moduleName = node.moduleSpecifier.getText(sourceFile).replaceAll('"', "").replaceAll("'", "")
    const bindings = node.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const local = element.name.text
        const imported = element.propertyName?.text ?? local
        if (imported === "SessionExecution") sessionAliases.add(local)
        if (
          imported === "SessionExecutionMature" ||
          imported === "SessionExecutionFormal" ||
          imported === "SessionExecutionLocal"
        )
          providerAliases.add(local)
        if (imported === "AppNodeBuilder") builderAliases.set(local, "AppNodeBuilder.build")
        if (imported === "AppNodeBuilderV1") builderAliases.set(local, "AppNodeBuilderV1.build")
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      const local = bindings.name.text
      if (moduleName.includes("session/execution-formal")) providerAliases.add(local)
      else if (moduleName.includes("session/execution/local")) providerAliases.add(local)
      else if (moduleName.includes("session/execution")) sessionAliases.add(local)
      if (moduleName.includes("app-node-builder")) {
        builderAliases.set(local, moduleName.includes("-v1") ? "AppNodeBuilderV1.build" : "AppNodeBuilder.build")
      }
    }
  }
  ts.forEachChild(sourceFile, visitImports)
  return { sessionAliases, providerAliases, builderAliases }
}

const propertyAccessOwner = (node: ts.PropertyAccessExpression) => node.expression.getText(node.getSourceFile())

const inspectSource = (relative: string, source: string) => {
  const scriptKind = relative.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind)
  const { sessionAliases, providerAliases, builderAliases } = aliasesForSource(sourceFile)
  const selectorSignals: SelectorSignal[] = []
  const transitionalSignals: TransitionalSignal[] = []
  const duplicateProviderBindings: DuplicateProviderBinding[] = []

  const countBindings = (call: ts.CallExpression, builder: BuilderKind) => {
    let serviceBindingCount = 0
    let providerBindingCount = 0
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "node") {
        const owner = propertyAccessOwner(node)
        if (sessionAliases.has(owner)) serviceBindingCount += 1
        if (providerAliases.has(owner)) providerBindingCount += 1
      }
      ts.forEachChild(node, visit)
    }
    for (const argument of call.arguments) visit(argument)
    // A canonical builder normally mentions SessionExecution.node twice: once
    // in the root service group and once on the left side of its replacement.
    // Competing ownership exists only when more than one provider node is
    // bound inside that same builder call; unresolved service-only bindings
    // are rejected by the composition ledger.
    if (providerBindingCount > 1) {
      duplicateProviderBindings.push({
        source_path: relative,
        ...lineAndColumn(sourceFile, call.getStart(sourceFile)),
        builder,
        service_binding_count: serviceBindingCount,
        provider_binding_count: providerBindingCount,
      })
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const marker = node.text as SelectorMarker | typeof TRANSITIONAL_MARKER
      const location = lineAndColumn(sourceFile, node.getStart(sourceFile))
      if ((SELECTOR_MARKERS as readonly string[]).includes(marker)) {
        selectorSignals.push({
          source_path: relative,
          ...location,
          marker: marker as SelectorMarker,
          classification: "forbidden_option_selector",
        })
      } else if (marker === TRANSITIONAL_MARKER) {
        transitionalSignals.push({
          source_path: relative,
          ...location,
          marker: TRANSITIONAL_MARKER,
          classification: "transitional_adapter",
        })
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "build"
    ) {
      const builder = builderAliases.get(node.expression.expression.getText(sourceFile))
      if (builder) countBindings(node, builder)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { selectorSignals, transitionalSignals, duplicateProviderBindings }
}

const sortSignals = <T extends { readonly source_path: string; readonly line: number; readonly column: number }>(
  values: readonly T[],
) =>
  [...values].toSorted(
    (left, right) =>
      left.source_path.localeCompare(right.source_path) || left.line - right.line || left.column - right.column,
  )

export async function buildTsRunnerNegativeArtifact(root: string): Promise<RunnerNegativeArtifact> {
  const topology = await buildTsCompositionArtifact(root)
  const selectorSignals: SelectorSignal[] = []
  const transitionalSignals: TransitionalSignal[] = []
  const duplicateProviderBindings: DuplicateProviderBinding[] = []
  for (const sourceFile of topology.source_files) {
    const source = await readFile(resolveSafe(root, sourceFile.path), "utf8")
    const inspected = inspectSource(sourceFile.path, source)
    selectorSignals.push(...inspected.selectorSignals)
    transitionalSignals.push(...inspected.transitionalSignals)
  }
  for (const rootEntry of topology.composition_roots) {
    const source = await readFile(resolveSafe(root, rootEntry.source_path), "utf8")
    const inspected = inspectSource(rootEntry.source_path, source)
    // The source-wide scan above records markers; this pass only contributes
    // duplicate bindings discovered in individual builder call expressions.
    // It is intentionally restricted to canonical topology roots.
    if (inspected.duplicateProviderBindings.length > 0) {
      // Keep one deterministic record for each call even if a root is listed once.
      // (The topology scanner de-duplicates composition roots by source path.)
      duplicateProviderBindings.push(...inspected.duplicateProviderBindings)
    }
  }
  const externalRunnerServiceUses = topology.contract.external_runner_service_uses.toSorted(
    (left, right) =>
      left.source_path.localeCompare(right.source_path) || left.line - right.line || left.column - right.column,
  )
  const publicEntrypoints = new Set(
    topology.entrypoint_references.filter((entry) => entry.public_entrypoint).map((entry) => entry.source_path),
  )
  const publicRunnerEntryUses = topology.runner_service_uses
    .filter((use) => publicEntrypoints.has(use.source_path) && use.kind === "external_bypass")
    .toSorted(
      (left, right) =>
        left.source_path.localeCompare(right.source_path) || left.line - right.line || left.column - right.column,
    )
  return {
    schema_version: "1.0",
    ledger_id: "ts-runner-negative",
    plan_revision: "v1.3",
    source_revision: SOURCE_REVISION,
    work_package: "PY-105",
    status: "OPEN",
    disposition: "CONVERGE",
    topology_artifact_path: TOPOLOGY_PATH,
    topology_artifact_digest: digestArtifact(topology),
    selector_signals: sortSignals(selectorSignals),
    transitional_signals: sortSignals(transitionalSignals),
    duplicate_provider_bindings: sortSignals(duplicateProviderBindings),
    external_runner_service_uses: externalRunnerServiceUses,
    public_runner_entry_uses: publicRunnerEntryUses,
    invariants: {
      no_forbidden_option_selector: selectorSignals.length === 0,
      no_duplicate_session_execution_provider: duplicateProviderBindings.length === 0,
      no_external_runner_service_bypass: externalRunnerServiceUses.length === 0,
      no_second_public_runner_entry: publicRunnerEntryUses.length === 0,
    },
  }
}

export async function writeTsRunnerNegativeArtifact(root: string) {
  const artifact = await buildTsRunnerNegativeArtifact(root)
  await mkdir(resolveSafe(root, path.dirname(NEGATIVE_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, NEGATIVE_PATH), JSON.stringify(artifact, null, 2) + "\n")
  const digest = digestArtifact(artifact)
  await writeFile(resolveSafe(root, ATTESTATION_PATH), "sha256:" + digest + "\n")
  return {
    selector_signal_count: artifact.selector_signals.length,
    transitional_signal_count: artifact.transitional_signals.length,
    duplicate_provider_binding_count: artifact.duplicate_provider_bindings.length,
    external_runner_service_use_count: artifact.external_runner_service_uses.length,
    artifact_digest: digest,
  }
}

export async function validateTsRunnerNegativeArtifact(root: string) {
  const findings: GovernanceFinding[] = []
  let artifact: RunnerNegativeArtifact
  try {
    artifact = JSON.parse(await readFile(resolveSafe(root, NEGATIVE_PATH), "utf8")) as RunnerNegativeArtifact
  } catch (error) {
    return {
      schema_version: "1.0" as const,
      valid: false,
      findings: [{ code: "PY105-001", path: NEGATIVE_PATH, detail: "cannot read negative artifact: " + String(error) }],
    }
  }
  if (
    artifact.schema_version !== "1.0" ||
    artifact.ledger_id !== "ts-runner-negative" ||
    artifact.work_package !== "PY-105"
  ) {
    findings.push({ code: "PY105-001", path: NEGATIVE_PATH, detail: "negative artifact identity is not canonical" })
  }
  let expected: RunnerNegativeArtifact
  try {
    expected = await buildTsRunnerNegativeArtifact(root)
  } catch (error) {
    findings.push({
      code: "PY105-003",
      path: TOPOLOGY_PATH,
      detail: "cannot regenerate canonical topology input: " + String(error),
    })
    return { schema_version: "1.0" as const, valid: false, findings }
  }
  if (canonicalJson(artifact) !== canonicalJson(expected)) {
    findings.push({
      code: "PY105-002",
      path: NEGATIVE_PATH,
      detail: "negative artifact is stale or does not equal deterministic source scan",
    })
  }
  if (artifact.selector_signals.length > 0 || !artifact.invariants.no_forbidden_option_selector) {
    findings.push({ code: "PY105-004", path: NEGATIVE_PATH, detail: "forbidden option/selector marker was discovered" })
  }
  if (artifact.duplicate_provider_bindings.length > 0 || !artifact.invariants.no_duplicate_session_execution_provider) {
    findings.push({
      code: "PY105-005",
      path: NEGATIVE_PATH,
      detail: "one composition builder binds multiple SessionExecution providers",
    })
  }
  if (artifact.external_runner_service_uses.length > 0 || !artifact.invariants.no_external_runner_service_bypass) {
    findings.push({
      code: "PY105-006",
      path: NEGATIVE_PATH,
      detail: "external SessionRunner.Service bypass was discovered",
    })
  }
  if (artifact.public_runner_entry_uses.length > 0 || !artifact.invariants.no_second_public_runner_entry) {
    findings.push({ code: "PY105-008", path: NEGATIVE_PATH, detail: "a second public runner entry was discovered" })
  }
  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    if (attestation !== "sha256:" + digestArtifact(artifact))
      findings.push({
        code: "PY105-007",
        path: ATTESTATION_PATH,
        detail: "negative artifact attestation does not match",
      })
  } catch (error) {
    findings.push({
      code: "PY105-007",
      path: ATTESTATION_PATH,
      detail: "cannot read negative artifact attestation: " + String(error),
    })
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    findings,
    topology_artifact_digest: artifact.topology_artifact_digest,
    selector_signal_count: artifact.selector_signals.length,
    transitional_signal_count: artifact.transitional_signals.length,
    duplicate_provider_binding_count: artifact.duplicate_provider_bindings.length,
    external_runner_service_use_count: artifact.external_runner_service_uses.length,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = parseRoot(args)
  if (args[0] === "generate-ts-runner-negative") {
    if (!args.includes("--write")) {
      console.error("generation is read-only unless --write is explicit")
      process.exit(2)
    }
    console.log(JSON.stringify(await writeTsRunnerNegativeArtifact(root), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-ts-runner-negative") {
    const report = await validateTsRunnerNegativeArtifact(root)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  console.error(
    "usage: bun run script/arforge-ts-runner-negative.ts generate-ts-runner-negative|validate-ts-runner-negative --root <repo>",
  )
  process.exit(2)
}
