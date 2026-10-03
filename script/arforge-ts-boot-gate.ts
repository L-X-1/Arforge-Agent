import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const CLI_ENTRYPOINT = "packages/arforge/src/index.ts"
const ARFORGE_PACKAGE_ENTRYPOINT = "./src/index.ts"
const CANONICAL_BIN_PACKAGE = "packages/arforge/package.json"

export type TsBootFinding = {
  readonly code: string
  readonly path: string
  readonly detail: string
}

export type TsBootCheck = {
  readonly id: string
  readonly status: "pass" | "warn" | "fail"
  readonly detail: string
}

export type TsBootReport = {
  readonly schema_version: "1.0"
  readonly valid: boolean
  readonly canonical_entrypoint: string
  readonly checks: readonly TsBootCheck[]
  readonly findings: readonly TsBootFinding[]
  readonly legacy_utility_scripts: readonly string[]
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalized = (value: string) => value.replaceAll("\\", "/")

const hasPythonRuntimeMarker = (source: string) =>
  /\b(?:PythonCompatRuntime|PythonBridge|LegacyPythonRuntime|fallbackRuntime|fallbackProvider|fallbackLoop)\b|packages[\\/]agent-python(?:[\\/"']|$)/i.test(
    source,
  )

const hasPythonCommand = (source: string) =>
  /(?:^|[\s"'`])(?:python(?:\.exe|3)?\s+(?:-[mc]\s+)?(?:[^\s"'`]+\.py|arforge\b|pytest\b|ruff\b|pip\b)|\.venv(?:[\\/]|$)|agent-python(?:[\\/]|$)|[^\s"'`]+\.py)(?:$|[\s"'`])/i.test(
    source,
  )

const hasPythonProcessInvocation = (source: string) =>
  /\b(?:spawn|spawnSync|exec|execFile|fork|utilityProcess\.fork)\s*\([\s\S]{0,240}?(?:python(?:\.exe|3)?|agent-python|\.venv)/i.test(
    source,
  )

const PRODUCT_PROCESS_BOUNDARIES = [
  "packages/arforge/src/index.ts",
  "packages/arforge/src/cli-main.ts",
  "packages/cli/src/index.ts",
  "packages/cli/src/tui.ts",
  "packages/desktop/src/main/index.ts",
  "packages/desktop/src/main/sidecar.ts",
] as const

const readText = async (root: string, relative: string, findings: TsBootFinding[]) => {
  const fullPath = path.resolve(root, relative)
  try {
    return await readFile(fullPath, "utf8")
  } catch {
    findings.push({
      code: "TSBOOT-001",
      path: relative,
      detail: "required TypeScript boot file is missing or unreadable",
    })
    return undefined
  }
}

const readOptionalText = async (root: string, relative: string) => {
  try {
    return await readFile(path.resolve(root, relative), "utf8")
  } catch {
    return undefined
  }
}

/**
 * Find workspace package manifests without descending into dependencies.
 * Workspace packages can be nested (for example `packages/sdk/js`), while
 * `node_modules` may contain thousands of unrelated manifests and must never
 * participate in the product CLI ownership decision.
 */
const workspacePackageManifests = async (root: string): Promise<string[]> => {
  const result = ["package.json"]
  const packagesRoot = path.resolve(root, "packages")
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const child = path.join(directory, entry.name)
      const manifest = path.join(child, "package.json")
      try {
        await readFile(manifest, "utf8")
        result.push(path.relative(root, manifest).replaceAll(path.sep, "/"))
      } catch {
        // A source directory without package metadata is not a workspace
        // package; continue searching for nested workspace packages.
      }
      await walk(child, depth + 1)
    }
  }
  await walk(packagesRoot, 0)
  return [...new Set(result)].sort()
}

const packageBinNames = (value: JsonRecord): string[] => {
  const bin = value.bin
  if (typeof bin === "string") {
    const name = typeof value.name === "string" ? value.name.split("/").pop() : undefined
    return name ? [name] : []
  }
  if (!isRecord(bin)) return []
  return Object.keys(bin)
}

const readJson = async (root: string, relative: string, findings: TsBootFinding[]) => {
  const source = await readText(root, relative, findings)
  if (source === undefined) return undefined
  try {
    const value: unknown = JSON.parse(source)
    if (!isRecord(value)) throw new Error("not an object")
    return value
  } catch {
    findings.push({ code: "TSBOOT-002", path: relative, detail: "package metadata is not valid JSON object" })
    return undefined
  }
}

const packageScripts = (value: JsonRecord | undefined) => {
  const scripts = value?.scripts
  if (!isRecord(scripts)) return {}
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

/**
 * Verify that user-facing CLI and Desktop launch paths resolve to the current
 * TypeScript runtime. This is intentionally a read-only topology check: it
 * does not remove the legacy Python assets, but it prevents them from becoming
 * a second session boot owner.
 */
export async function validateTsBoot(rootInput: string): Promise<TsBootReport> {
  const root = path.resolve(rootInput)
  const findings: TsBootFinding[] = []
  const checks: TsBootCheck[] = []
  const check = (id: string, ok: boolean, detail: string, pathName?: string) => {
    const code = `TSBOOT-${id}`
    checks.push({ id: code, status: ok ? "pass" : "fail", detail })
    if (!ok) findings.push({ code, path: pathName ?? id, detail })
  }

  const rootPackage = await readJson(root, "package.json", findings)
  const arforgePackage = await readJson(root, "packages/arforge/package.json", findings)
  const desktopPackage = await readJson(root, "packages/desktop/package.json", findings)
  const rootScripts = packageScripts(rootPackage)
  const arforgeScripts = packageScripts(arforgePackage)

  const arforgeBinOwners: string[] = []
  for (const manifest of await workspacePackageManifests(root)) {
    const metadata = manifest === "package.json" ? rootPackage : await readJson(root, manifest, findings)
    if (metadata !== undefined && packageBinNames(metadata).includes("arforge")) arforgeBinOwners.push(manifest)
  }
  const expectedBinOwners = [CANONICAL_BIN_PACKAGE]
  check(
    "011-arforge-bin-owner",
    JSON.stringify(arforgeBinOwners) === JSON.stringify(expectedBinOwners),
    arforgeBinOwners.length === 0
      ? `only ${CANONICAL_BIN_PACKAGE} may declare the arforge bin; no owner was found`
      : `only ${CANONICAL_BIN_PACKAGE} may declare the arforge bin; found: ${arforgeBinOwners.join(", ")}`,
    arforgeBinOwners.find((manifest) => manifest !== CANONICAL_BIN_PACKAGE) ?? CANONICAL_BIN_PACKAGE,
  )

  for (const [name, command] of Object.entries({ dev: rootScripts.dev, cli: rootScripts.cli })) {
    check(
      `003-${name}`,
      typeof command === "string" && normalized(command).includes(CLI_ENTRYPOINT) && !hasPythonCommand(command),
      `root ${name} script must execute ${CLI_ENTRYPOINT} without a Python command`,
      "package.json",
    )
  }

  check(
    "004-arforge-package",
    arforgeScripts.dev === `bun run --conditions=browser ${ARFORGE_PACKAGE_ENTRYPOINT}`,
    `packages/arforge dev script must execute ${ARFORGE_PACKAGE_ENTRYPOINT}`,
    "packages/arforge/package.json",
  )

  const cliSource = await readText(root, CLI_ENTRYPOINT, findings)
  if (cliSource !== undefined) {
    check(
      "005-cli-source",
      !hasPythonRuntimeMarker(cliSource) && !hasPythonCommand(cliSource),
      "canonical CLI source must not launch a Python runtime or fallback loop",
      CLI_ENTRYPOINT,
    )
  }

  const compatibilityLauncherPath = "bin/arforge.js"
  const compatibilityLauncher = await readText(root, compatibilityLauncherPath, findings)
  if (compatibilityLauncher !== undefined) {
    const normalizedLauncher = normalized(compatibilityLauncher)
    check(
      "006-node-compatibility-launcher",
      normalizedLauncher.includes('path.join(PACKAGE_ROOT, "packages", "arforge", "src", "index.ts")') &&
        normalizedLauncher.includes('spawn(bun, ["--conditions=browser", CLI_ENTRY') &&
        !hasPythonRuntimeMarker(normalizedLauncher) &&
        !hasPythonCommand(normalizedLauncher),
      "Node compatibility launcher must delegate to the canonical Bun/TypeScript entrypoint",
      compatibilityLauncherPath,
    )
  }

  const desktopMainPath = "packages/desktop/src/main/index.ts"
  const desktopMain = await readText(root, desktopMainPath, findings)
  const desktopMainConfigured = isRecord(desktopPackage) && desktopPackage.main === "./out/main/index.js"
  check(
    "007-desktop-main",
    desktopMainConfigured && desktopMain !== undefined && !hasPythonRuntimeMarker(desktopMain),
    "Desktop must compile and launch its TypeScript main entrypoint",
    "packages/desktop/package.json",
  )

  const desktopBuilderPath = "packages/desktop/electron-builder.config.ts"
  const desktopBuilder = await readText(root, desktopBuilderPath, findings)
  if (desktopBuilder !== undefined) {
    const extraResources = desktopBuilder.match(/extraResources\s*:\s*\[[\s\S]*?\n\s*\],/)?.[0] ?? ""
    check(
      "008-desktop-resources",
      !/agent-python|\.venv|python(?:\.exe|3)?/i.test(extraResources),
      "Desktop extraResources must not reintroduce the retired Python sidecar",
      desktopBuilderPath,
    )
  }

  const processBoundarySources = await Promise.all(
    PRODUCT_PROCESS_BOUNDARIES.map(async (relative) => ({ relative, source: await readOptionalText(root, relative) })),
  )
  const pythonProcessBoundaries = processBoundarySources
    .filter(({ source }) => source !== undefined && hasPythonProcessInvocation(source))
    .map(({ relative }) => relative)
  check(
    "010-product-runtime-no-python-process",
    pythonProcessBoundaries.length === 0,
    pythonProcessBoundaries.length === 0
      ? "product CLI/Desktop process boundaries contain no Python spawn/exec/fork"
      : `product process boundaries must not launch Python: ${pythonProcessBoundaries.join(", ")}`,
    pythonProcessBoundaries[0] ?? "packages",
  )

  const legacyUtilityScripts = Object.entries(rootScripts)
    .filter(([, command]) => hasPythonCommand(command) || /python|\.venv|agent-python/i.test(command))
    .map(([name]) => name)
    .sort()
  checks.push({
    id: "TSBOOT-009-legacy-utility-scripts",
    status: "warn",
    detail:
      legacyUtilityScripts.length === 0
        ? "no Python compatibility utility scripts remain"
        : `Python compatibility utilities remain outside the boot path: ${legacyUtilityScripts.join(", ")}`,
  })

  return {
    schema_version: "1.0",
    valid: findings.length === 0,
    canonical_entrypoint: CLI_ENTRYPOINT,
    checks,
    findings,
    legacy_utility_scripts: legacyUtilityScripts,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] !== "--root" && !args.includes("--root")) {
    console.error("usage: bun run script/arforge-ts-boot-gate.ts --root <repo>")
    process.exit(2)
  }
  const report = await validateTsBoot(parseRoot(args))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.valid ? 0 : 1)
}
