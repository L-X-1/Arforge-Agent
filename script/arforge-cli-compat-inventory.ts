import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

/**
 * TypeScript owner for the frozen legacy Python CLI inventory.
 *
 * The inventory is a source/digest review, not a Python parser or product
 * runtime.  It intentionally does not import or execute `arforge.cli`; the
 * compatibility wrapper delegates here so there is one governance algorithm
 * and one canonical migration decision.
 */

const SCHEMA_VERSION = 1 as const
const EXPECTED_CLI_SHA256 = "b7d4e3dce4d598d706ce8b367aa5fabbbfe872b19ff897fb63af35edbca1a881"
const EXPECTED_FACADE_EXPORTS = [
  "CliInvocationResult",
  "UnifiedCliUnavailable",
  "build_command",
  "invoke",
  "main",
  "resolve_unified_cli",
  "run",
] as const
const TRUST_SCREEN_MODULE = "arforge." + "trust_screen"
const WORKSPACE_ROOTS_MODULE = "arforge." + "workspace_roots"
const FROZEN_COMPAT_MODULES = new Set([TRUST_SCREEN_MODULE, WORKSPACE_ROOTS_MODULE])

type LegacyDefinition = Readonly<{
  name: string
  line: number
  kind: "class" | "async_function" | "function" | "constant"
  visibility: "private" | "public"
  status: "frozen-legacy"
}>

type FrozenCompatImport = Readonly<{
  module: string
  names: ReadonlyArray<string>
  line: number
}>

const sourceDigest = (source: string) => createHash("sha256").update(source, "utf8").digest("hex")

const rootFromArgument = (raw: string | undefined): string => path.resolve(raw ?? path.join(import.meta.dir, ".."))

const topLevel = (line: string): boolean => line.length === 0 || !/^[ \t]/.test(line)

const assignedNames = (line: string): string[] => {
  const assignment = line.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=\r\n]+)?=/)
  if (!assignment) return []
  return assignment[1]!
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

const legacyDefinitions = (source: string): LegacyDefinition[] => {
  const definitions: LegacyDefinition[] = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!topLevel(line)) continue
    const lineNumber = index + 1
    const functionMatch = line.match(/^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
    const classMatch = line.match(/^class\s+([A-Za-z_]\w*)\b/)
    const names = functionMatch ? [functionMatch[2]!] : classMatch ? [classMatch[1]!] : assignedNames(line)
    const kind = functionMatch
      ? functionMatch[1]
        ? ("async_function" as const)
        : ("function" as const)
      : classMatch
        ? ("class" as const)
        : ("constant" as const)
    for (const name of names)
      definitions.push({
        name,
        line: lineNumber,
        kind,
        visibility: name.startsWith("_") ? "private" : "public",
        status: "frozen-legacy",
      })
  }
  return definitions
}

const frozenCompatImports = (source: string): FrozenCompatImport[] => {
  const lines = source.split(/\r?\n/)
  const imports: FrozenCompatImport[] = []
  let inFunction = false
  let functionIndent = 0
  for (const [index, line] of lines.entries()) {
    const functionMatch = line.match(/^(async\s+)?def\s+/)
    if (functionMatch) {
      inFunction = true
      functionIndent = line.length - line.trimStart().length
      continue
    }
    if (!inFunction) continue
    const indent = line.length - line.trimStart().length
    if (line.trim() !== "" && indent <= functionIndent) {
      inFunction = false
      continue
    }
    const match = line.match(/^\s*from\s+(arforge\.[A-Za-z_]\w*)\s+import\s+(.+)$/)
    if (!match || !FROZEN_COMPAT_MODULES.has(match[1]!)) continue
    const names = match[2]!
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/i)[0]!)
      .filter((name) => name !== "*")
      .toSorted()
    imports.push({ module: match[1]!, names, line: index + 1 })
  }
  return imports
}

const facadeExports = (source: string): string[] => {
  const match = source.match(/from\s+arforge\.cli_bridge\s+import\s+\(([^)]*)\)/s)
  if (!match) return []
  return [...match[1]!.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((item) => item[1]!).filter((name) => name !== "as")
}

export const buildCliCompatibilityInventory = async (rootInput: string) => {
  const root = path.resolve(rootInput)
  const legacyRelative = "arforge/cli.py"
  const facadeRelative = "arforge/cli_compat.py"
  const legacyPath = path.join(root, legacyRelative)
  const facadePath = path.join(root, facadeRelative)
  const source = await readFile(legacyPath, "utf8")
  const facade = await readFile(facadePath, "utf8")
  const definitions = legacyDefinitions(source)
  const compatImports = frozenCompatImports(source)
  return {
    schema_version: SCHEMA_VERSION,
    status: "migration-window",
    legacy_module: "arforge.cli",
    canonical_runtime: "typescript",
    canonical_entry: "packages/arforge/src/index.ts",
    embedding_facade: "arforge.cli_compat",
    legacy_source: legacyRelative,
    legacy_source_sha256: sourceDigest(source),
    legacy_definition_count: definitions.length,
    legacy_definitions: definitions,
    frozen_compat_import_count: compatImports.length,
    frozen_compat_imports: compatImports,
    embedding_facade_exports: facadeExports(facade),
    retirement_policy: {
      new_product_commands: "forbidden",
      new_python_state_writers: "forbidden",
      executable_entry: "cli_bridge-only",
      direct_import: "explicit-migration-only",
      removal_prerequisites: [
        "all external imports migrated to arforge.cli_compat",
        "Python fixtures converted or frozen as language-neutral evidence",
        "TS command/protocol parity evidence is fresh",
        "no product runtime references arforge.cli",
      ],
    },
  }
}

export const checkCliCompatibilityInventory = async (
  root: string,
  inventory: Awaited<ReturnType<typeof buildCliCompatibilityInventory>>,
) => {
  const errors: string[] = []
  if (inventory.legacy_source_sha256 !== EXPECTED_CLI_SHA256)
    errors.push("arforge/cli.py changed; refresh the frozen digest only after reviewing every legacy definition")
  if (JSON.stringify(inventory.embedding_facade_exports) !== JSON.stringify(EXPECTED_FACADE_EXPORTS))
    errors.push("arforge/cli_compat.py exports drifted from cli_bridge's explicit adapter surface")
  const names = inventory.legacy_definitions.map((item) => item.name)
  if (new Set(names).size !== names.length) errors.push("legacy definition inventory contains duplicate names")
  if (inventory.legacy_definitions.some((item) => item.status !== "frozen-legacy"))
    errors.push("every legacy definition must remain explicitly frozen during the migration window")
  const actualImports = inventory.frozen_compat_imports.map(({ module, names }) => ({ module, names }))
  if (actualImports.length !== 0)
    errors.push("frozen legacy trust/workspace imports drifted; review before changing the compatibility boundary")
  const source = await readFile(path.join(root, "arforge/cli.py"), "utf8")
  if (!source.includes("from arforge.cli_bridge import main as unified_main"))
    errors.push("legacy module executable guard no longer points at cli_bridge")
  return errors
}

const parseArgs = (args: readonly string[]) => {
  const rootIndex = args.indexOf("--root")
  const root = rootFromArgument(rootIndex >= 0 ? args[rootIndex + 1] : undefined)
  return { root, json: args.includes("--json"), check: args.includes("--check") }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  try {
    const inventory = await buildCliCompatibilityInventory(options.root)
    const errors = options.check ? await checkCliCompatibilityInventory(options.root, inventory) : []
    if (options.json) console.log(JSON.stringify(inventory, null, 2))
    else {
      console.log(
        `CLI compatibility inventory: ${inventory.legacy_definition_count} frozen definitions; source sha256=${inventory.legacy_source_sha256}`,
      )
      console.log(`canonical=${inventory.canonical_entry} facade=${inventory.embedding_facade}`)
    }
    for (const error of errors) console.error(`ERROR: ${error}`)
    process.exit(errors.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(`cli compatibility inventory failed: ${String(error)}`)
    process.exit(2)
  }
}
