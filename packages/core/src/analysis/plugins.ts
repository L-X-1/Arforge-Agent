export * as Plugins from "./plugins"

/**
 * MCP plugin management — native TS port of the declarative surface of
 * ``arforge/mcp_http.py`` + ``arforge/plugin_install.py`` + ``plugin_state.py``.
 *
 * Scope (per product decision): manifest discovery/validation, enablement
 * state, and the inspect/apply/remove/restore install transaction. Python
 * entrypoint plugins remain discoverable/installable but are not loaded
 * (loading Python factories requires the retired runtime). Git-clone plugin
 * sources are rejected with PLUGIN_SOURCE_UNSUPPORTED.
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"

const INSPECTION_TTL_SECONDS = 3600
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const SAFE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/
const SAFE_TOKEN = /^[0-9a-f]{32}$/
const SAFE_PLUGIN_NAME = /^[a-z][a-z0-9_.-]{0,63}$/
const SAFE_PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_-]{1,64}$/
const ENTRYPOINT_PATTERN = /^[A-Za-z0-9_.-]+\.py:[A-Za-z_][A-Za-z0-9_]*$/
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9_.+-]{1,128}$/
const RECOVERY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}-\d{8}T\d{6}-[a-f0-9]{8}$/

export class PluginInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PluginInstallError"
  }
}

export interface PluginToolSpec {
  readonly name: string
  readonly description: string
  readonly command: string[]
  readonly parameters: Record<string, unknown>
}

export interface DiscoveredPlugin {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly hooks: string[]
  readonly tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  readonly manifest_path: string
  readonly entrypoint: string
  readonly enabled: boolean
  readonly problems: string[]
  readonly managed: boolean
}

export interface PluginList {
  readonly count: number
  readonly items: DiscoveredPlugin[]
  readonly roots: string[]
}

export interface PluginInspection {
  readonly token: string
  readonly source: string
  readonly expires_in_seconds: number
  readonly selection_required: boolean
  readonly candidates: Array<Record<string, unknown>>
}

export interface PluginTransaction {
  readonly name: string
  readonly version: string
  readonly path: string
  readonly source: string
  readonly sha256: string
  readonly enabled: boolean
  readonly updated: boolean
  readonly recovery: Record<string, unknown> | null
}

export interface PluginRemoval {
  readonly name: string
  readonly removed: boolean
  readonly recoverable: boolean
  readonly recovery: Record<string, unknown>
}

export interface PluginRestore {
  readonly name: string
  readonly restored: boolean
  readonly path: string
  readonly enabled: boolean
}

export function defaultPluginRoots(home?: string): string[] {
  const roots = [join(defaultHome(home), "plugins"), join(process.cwd(), ".arforge", "plugins")]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const root of roots) {
    const resolved = resolve(root)
    const key = resolved.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(resolved)
  }
  return unique
}

export function defaultHome(home?: string): string {
  const configured = (home ?? process.env.ARFORGE_HOME)?.trim()
  return configured ? resolve(configured) : resolve(homedir(), ".arforge")
}

// ---------------------------------------------------------------------------
// Manifest validation (native port of PluginRegistry._read_manifest)
// ---------------------------------------------------------------------------

function validateManifest(manifestPath: string, root: string): { name: string; version: string; description: string; hooks: string[]; tools: PluginToolSpec[]; entrypoint: string; enabled: boolean; problems: string[] } {
  const fallbackName = dirname(manifestPath).split(/[\\/]/).pop()?.toLowerCase() ?? ""
  const problems: string[] = []
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  } catch (error) {
    return { name: fallbackName, version: "", description: "", hooks: [], tools: [], entrypoint: "", enabled: false, problems: [`invalid manifest: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (typeof payload !== "object" || payload === null) {
    return { name: fallbackName, version: "", description: "", hooks: [], tools: [], entrypoint: "", enabled: false, problems: ["manifest must be a JSON object"] }
  }
  let name = typeof payload.name === "string" ? payload.name : ""
  let version = typeof payload.version === "string" ? payload.version : ""
  let description = typeof payload.description === "string" ? payload.description : ""
  const entrypoint = typeof payload.entrypoint === "string" ? payload.entrypoint : ""
  const hooks = payload.hooks === undefined ? [] : payload.hooks
  const tools = payload.tools
  let enabled = typeof payload.enabled === "boolean" ? payload.enabled : true

  if (typeof name !== "string" || !SAFE_PLUGIN_NAME.test(name)) {
    problems.push("name must be lowercase and URL-safe")
    name = fallbackName
  }
  if (typeof version !== "string" || !version.trim() || version.length > 64) {
    problems.push("version must be a non-empty string up to 64 characters")
    version = ""
  }
  if (typeof description !== "string" || description.length > 2000) {
    problems.push("description must be a string up to 2000 characters")
    description = ""
  }
  if (!Array.isArray(hooks) || !hooks.every((item) => typeof item === "string" && item.length <= 128)) {
    problems.push("hooks must be an array of short strings")
  }
  if (typeof enabled !== "boolean") {
    problems.push("enabled must be a boolean")
    enabled = false
  }
  if (typeof entrypoint !== "string") {
    problems.push("entrypoint must be a string")
  } else if (entrypoint && !ENTRYPOINT_PATTERN.test(entrypoint)) {
    problems.push("entrypoint must use relative_file.py:factory format")
  }
  if (!entrypoint && !Array.isArray(tools)) {
    problems.push("manifest must declare an entrypoint or at least one command tool")
  }
  if (entrypoint && ENTRYPOINT_PATTERN.test(entrypoint)) {
    const sourceName = entrypoint.split(":", 1)[0]
    const source = resolve(dirname(manifestPath), sourceName)
    if (!isWithin(dirname(manifestPath), source)) {
      problems.push("entrypoint must stay inside its plugin directory")
    } else if (!isWithin(root, source)) {
      problems.push("entrypoint must stay inside its discovery root")
    } else if (!existsSync(source)) {
      problems.push("entrypoint file does not exist")
    }
  }
  const toolSpecs = validateTools(tools, manifestPath, problems)
  const cleanHooks = Array.isArray(hooks) ? hooks.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 128)) : []
  return { name, version, description, hooks: cleanHooks, tools: toolSpecs, entrypoint, enabled, problems }
}

function validateTools(raw: unknown, manifestPath: string, problems: string[]): PluginToolSpec[] {
  const tools: PluginToolSpec[] = []
  if (raw === null || raw === undefined) return tools
  if (!Array.isArray(raw) || raw.length > 64) {
    problems.push("tools must be an array with at most 64 entries")
    return tools
  }
  const seen = new Set<string>()
  for (let index = 0; index < raw.length; index++) {
    const prefix = `tools[${index}]`
    const item = raw[index]
    if (typeof item !== "object" || item === null) {
      problems.push(`${prefix} must be an object`)
      continue
    }
    const record = item as Record<string, unknown>
    const unexpected = Object.keys(record).filter((key) => !["name", "description", "command", "parameters"].includes(key))
    if (unexpected.length > 0) {
      problems.push(`${prefix} contains unsupported fields`)
      continue
    }
    const name = record.name
    const description = record.description
    const command = record.command
    const parameters = (record.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>
    if (typeof name !== "string" || !SAFE_PLUGIN_TOOL_NAME.test(name)) {
      problems.push(`${prefix}.name must be short and URL-safe`)
      continue
    }
    if (name.toLowerCase() === "plugin" || seen.has(name.toLowerCase())) {
      problems.push(`duplicate plugin tool name: ${name}`)
      continue
    }
    seen.add(name.toLowerCase())
    if (typeof description !== "string" || !description.trim() || description.length > 2000) {
      problems.push(`${prefix}.description must be a non-empty string up to 2000 characters`)
      continue
    }
    if (
      !Array.isArray(command) ||
      command.length < 1 ||
      command.length > 32 ||
      !command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 1024 && !part.includes("\0"))
    ) {
      problems.push(`${prefix}.command must contain 1 to 32 bounded argument strings`)
      continue
    }
    if (typeof parameters !== "object" || parameters === null || (parameters.type ?? "object") !== "object") {
      problems.push(`${prefix}.parameters must be an object JSON Schema`)
      continue
    }
    const properties = parameters.properties ?? {}
    const required = parameters.required ?? []
    if (
      typeof properties !== "object" ||
      properties === null ||
      Object.keys(properties).length > 64 ||
      !Object.entries(properties as Record<string, unknown>).every(
        ([key, schema]) =>
          TOOL_NAME_PATTERN.test(key) &&
          typeof schema === "object" &&
          schema !== null &&
          ["string", "integer", "number", "boolean", "array", "object"].includes(String((schema as Record<string, unknown>).type ?? "string")),
      ) ||
      !Array.isArray(required) ||
      !required.every((item) => typeof item === "string" && item in (properties as Record<string, unknown>))
    ) {
      problems.push(`${prefix}.parameters contains an unsupported property schema`)
      continue
    }
    const normalized = {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    }
    try {
      validatePluginCommand(dirname(manifestPath), command as string[])
    } catch (error) {
      problems.push(`tool ${name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    tools.push({ name: name as string, description: (description as string).trim(), command: command as string[], parameters: normalized })
  }
  return tools
}

function validatePluginCommand(pluginDirectory: string, command: string[]): string[] {
  let executable = command[0]
  if (executable.includes("/") || executable.includes("\\")) {
    const resolved = resolve(pluginDirectory, executable)
    if (!isWithin(pluginDirectory, resolved)) {
      throw new Error("plugin command executable escaped its plugin directory")
    }
    if (!existsSync(resolved)) {
      throw new Error("plugin command executable does not exist")
    }
    executable = resolved
  } else if (!EXECUTABLE_NAME_PATTERN.test(executable)) {
    throw new Error("plugin command executable name is invalid")
  }
  return [executable, ...command.slice(1)]
}

// ---------------------------------------------------------------------------
// Plugin state (native port of plugin_state.py)
// ---------------------------------------------------------------------------

function pluginStatePath(home?: string): string {
  return join(defaultHome(home), "config", "plugin_state.json")
}

export function loadPluginOverrides(home?: string): Record<string, boolean> {
  try {
    const payload = JSON.parse(readFileSync(pluginStatePath(home), "utf8")) as { enabled_overrides?: unknown }
    const overrides = payload.enabled_overrides
    if (typeof overrides !== "object" || overrides === null) return {}
    const result: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof value === "boolean") result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

function persistPluginOverrides(overrides: Record<string, boolean>, home?: string): void {
  const path = pluginStatePath(home)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, enabled_overrides: overrides }, null, 2)}\n`, "utf8")
    renameSync(temporary, path)
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // best effort
    }
  }
}

export function setPluginEnabled(manifestPath: string, enabled: boolean, home?: string): Record<string, boolean> {
  const overrides = loadPluginOverrides(home)
  overrides[resolve(manifestPath)] = enabled
  persistPluginOverrides(overrides, home)
  return overrides
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function listPlugins(options: { home?: string; roots?: string[] } = {}): PluginList {
  const roots = options.roots ?? defaultPluginRoots(options.home)
  const overrides = loadPluginOverrides(options.home)
  const managedRoot = resolve(join(defaultHome(options.home), "plugins"))
  const items: DiscoveredPlugin[] = []
  const seen = new Map<string, DiscoveredPlugin>()
  for (const rawRoot of roots) {
    const root = resolve(rawRoot)
    if (!existsSync(root)) continue
    const manifests: string[] = []
    for (const child of readdirSync(root, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      const candidate = join(root, child.name, "plugin.json")
      if (existsSync(candidate)) manifests.push(candidate)
    }
    for (const manifestPath of manifests.sort()) {
      const parsed = validateManifest(manifestPath, root)
      const override = overrides[resolve(manifestPath)]
      let enabled = parsed.enabled
      if (override !== undefined) enabled = override
      const resolvedManifest = resolve(manifestPath)
      const parts = relative(managedRoot, resolvedManifest).split(sep).filter(Boolean)
      const managed = parts.length === 2 && parts[1] === "plugin.json" && !parts[0].startsWith(".") && !relative(managedRoot, resolvedManifest).startsWith(`..${sep}`)
      const item: DiscoveredPlugin = {
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        hooks: parsed.hooks,
        tools: parsed.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        manifest_path: resolve(manifestPath),
        entrypoint: parsed.entrypoint,
        enabled,
        problems: parsed.problems,
        managed,
      }
      const existing = seen.get(item.name)
      if (!existing) seen.set(item.name, item)
    }
  }
  for (const item of seen.values()) items.push(item)
  return {
    count: items.length,
    items,
    roots: roots.map((root) => resolve(root)),
  }
}

// ---------------------------------------------------------------------------
// Install transaction (declarative port of PluginInstallRuntime)
// ---------------------------------------------------------------------------

export interface PluginInstallRuntimeOptions {
  readonly home?: string
  readonly cacheRoot?: string
  readonly pluginsRoot?: string
  readonly trashRoot?: string
}

export class PluginInstallRuntime {
  readonly profileRoot: string
  readonly cacheRoot: string
  readonly pluginsRoot: string
  readonly trashRoot: string

  constructor(options: PluginInstallRuntimeOptions = {}) {
    this.profileRoot = defaultHome(options.home)
    this.cacheRoot = options.cacheRoot ?? join(this.profileRoot, "cache", "plugins")
    this.pluginsRoot = options.pluginsRoot ?? join(this.profileRoot, "plugins")
    this.trashRoot = options.trashRoot ?? join(this.profileRoot, "trash", "plugins")
  }

  inspect(source: string): PluginInspection {
    const normalized = String(source ?? "").trim()
    if (!normalized || normalized.length > 4096) {
      throw new PluginInstallError("INVALID_PLUGIN_SOURCE", "plugin source must be a non-empty path or HTTPS URL")
    }
    this.pruneExpired()
    const token = randomBytes(16).toString("hex")
    const inspection = join(this.cacheRoot, token)
    const payloadRoot = join(inspection, "payload")
    mkdirSync(inspection, { recursive: true })
    try {
      this.materialize(normalized, payloadRoot, inspection)
      const candidates = this.candidates(payloadRoot)
      const metadata = {
        token,
        created_epoch: Date.now() / 1000,
        source: safeSourceLabel(normalized),
        candidates,
      }
      writeFileSync(join(inspection, "inspection.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
      return {
        token,
        source: metadata.source,
        expires_in_seconds: INSPECTION_TTL_SECONDS,
        selection_required: candidates.length > 1,
        candidates: candidates.map((item) => {
          const { relative_path: _relativePath, ...rest } = item
          return rest
        }),
      }
    } catch (error) {
      rmSync(inspection, { recursive: true, force: true })
      throw error
    }
  }

  apply(token: string, pluginName = "", replace = false): PluginTransaction {
    const inspection = this.loadInspection(token)
    const metadata = JSON.parse(readFileSync(join(inspection, "inspection.json"), "utf8")) as { candidates: Array<Record<string, unknown>>; source?: unknown }
    const candidates = metadata.candidates
    const selectedName = String(pluginName ?? "").trim().toLowerCase()
    let matches: Array<Record<string, unknown>>
    if (selectedName) {
      matches = candidates.filter((item) => String(item.name ?? "").toLowerCase() === selectedName)
    } else if (candidates.length === 1) {
      matches = [candidates[0]]
    } else {
      throw new PluginInstallError("PLUGIN_SELECTION_REQUIRED", "select one plugin from the inspected package")
    }
    if (matches.length !== 1) {
      throw new PluginInstallError("PLUGIN_NOT_FOUND", `inspected package does not contain plugin: ${pluginName}`)
    }
    const selected = matches[0]
    const name = String(selected.name ?? "")
    if (!SAFE_NAME.test(name)) throw new PluginInstallError("INVALID_PLUGIN_NAME", "plugin name must be lowercase and URL-safe")
    const sourceDir = resolve(join(inspection, "payload", String(selected.relative_path ?? "")))
    if (!isWithin(join(inspection, "payload"), sourceDir)) {
      throw new PluginInstallError("INVALID_INSPECTION", "inspection candidate escaped its staging directory")
    }
    if (treeDigest(sourceDir) !== String(selected.sha256 ?? "")) {
      throw new PluginInstallError("INSPECTION_CHANGED", "inspected plugin files changed before installation; inspect the package again")
    }
    mkdirSync(this.pluginsRoot, { recursive: true })
    const target = join(this.pluginsRoot, name)
    const stage = join(this.pluginsRoot, `.install-${token}-${name}`)
    const backup = join(this.pluginsRoot, `.backup-${token}-${name}`)
    if (existsSync(target) && !replace) {
      throw new PluginInstallError("PLUGIN_ALREADY_INSTALLED", `plugin is already installed: ${name}`)
    }
    if (replace && !existsSync(target)) {
      throw new PluginInstallError("PLUGIN_NOT_INSTALLED", `plugin is not installed and cannot be updated: ${name}`)
    }
    if (existsSync(target) && !existsSync(join(target, "plugin.json"))) {
      throw new PluginInstallError("PLUGIN_TARGET_CONFLICT", `profile plugin target exists without a valid manifest: ${name}`)
    }
    if (existsSync(stage) || existsSync(backup)) {
      throw new PluginInstallError("PLUGIN_INSTALL_BUSY", "a plugin transaction with this token already exists")
    }
    copyTree(sourceDir, stage)
    try {
      if (treeDigest(stage) !== String(selected.sha256 ?? "")) {
        throw new PluginInstallError("INSPECTION_CHANGED", "plugin files changed while staging; inspect the package again")
      }
      const staged = listPlugins({ roots: [this.pluginsRoot] }).items.find((item) => dirname(item.manifest_path) === stage)
      if (!staged || staged.problems.length > 0) {
        const detail = staged ? staged.problems.join(", ") : "staged manifest was not discoverable"
        throw new PluginInstallError("INVALID_PLUGIN_MANIFEST", detail)
      }
      if (existsSync(target)) {
        renameSync(target, backup)
      }
      let recovery: Record<string, unknown> | null = null
      try {
        renameSync(stage, target)
      } catch (error) {
        if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
        throw error
      }
      if (existsSync(backup)) {
        recovery = this.moveToTrash(backup, name, "update")
      }
      setPluginEnabled(join(target, "plugin.json"), false, this.profileRoot)
      rmSync(inspection, { recursive: true, force: true })
      return {
        name,
        version: String(selected.version ?? ""),
        path: target,
        source: String(metadata.source ?? ""),
        sha256: treeDigest(target),
        enabled: false,
        updated: Boolean(replace),
        recovery,
      }
    } catch (error) {
      rmSync(stage, { recursive: true, force: true })
      throw error
    }
  }

  remove(name: string): PluginRemoval {
    const normalized = String(name ?? "").trim().toLowerCase()
    if (!SAFE_NAME.test(normalized)) {
      throw new PluginInstallError("INVALID_PLUGIN_NAME", "plugin name must be lowercase and URL-safe")
    }
    const target = resolve(join(this.pluginsRoot, normalized))
    if (!isWithin(this.pluginsRoot, target)) {
      throw new PluginInstallError("INVALID_PLUGIN_NAME", "plugin path escaped the profile plugin root")
    }
    if (!existsSync(join(target, "plugin.json"))) {
      throw new PluginInstallError("PLUGIN_NOT_FOUND", `managed plugin was not found: ${normalized}`)
    }
    setPluginEnabled(join(target, "plugin.json"), false, this.profileRoot)
    const recovery = this.moveToTrash(target, normalized, "remove")
    return { name: normalized, removed: true, recoverable: true, recovery }
  }

  restore(recoveryId: string): PluginRestore {
    const recovery = String(recoveryId ?? "").trim()
    if (!RECOVERY_PATTERN.test(recovery)) {
      throw new PluginInstallError("INVALID_RECOVERY_ID", "invalid plugin recovery identifier")
    }
    const source = resolve(join(this.trashRoot, recovery))
    if (!isWithin(this.trashRoot, source)) {
      throw new PluginInstallError("INVALID_RECOVERY_ID", "recovery path escaped the plugin trash root")
    }
    let recoveryMetadata: Record<string, unknown>
    try {
      recoveryMetadata = JSON.parse(readFileSync(join(source, ".recovery.json"), "utf8")) as Record<string, unknown>
    } catch {
      throw new PluginInstallError("RECOVERY_NOT_FOUND", "plugin recovery entry was not found")
    }
    const name = recoveryMetadata.name
    if (typeof name !== "string" || !SAFE_NAME.test(name)) {
      throw new PluginInstallError("INVALID_RECOVERY", "plugin recovery metadata is invalid")
    }
    const target = join(this.pluginsRoot, name)
    if (existsSync(target)) {
      throw new PluginInstallError("PLUGIN_ALREADY_INSTALLED", `plugin is already installed: ${name}`)
    }
    rmSync(join(source, ".recovery.json"), { force: true })
    try {
      renameSync(source, target)
    } catch (error) {
      writeFileSync(join(source, ".recovery.json"), `${JSON.stringify(recoveryMetadata, null, 2)}\n`, "utf8")
      throw new PluginInstallError("PLUGIN_RESTORE_FAILED", `plugin restore failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    setPluginEnabled(join(target, "plugin.json"), false, this.profileRoot)
    return { name, restored: true, path: target, enabled: false }
  }

  private materialize(source: string, payloadRoot: string, inspection: string): void {
    if (/^https?:\/\//i.test(source)) {
      const parsed = new URL(source)
      if (!/^https:$/.test(parsed.protocol)) {
        throw new PluginInstallError("UNSAFE_PLUGIN_SOURCE", "plugin source must use HTTPS")
      }
      if (parsed.pathname.toLowerCase().endsWith(".zip")) {
        const archive = join(inspection, "package.zip")
        downloadZip(source, archive)
        mkdirSync(payloadRoot)
        extractZip(archive, payloadRoot)
        rmSync(archive, { force: true })
        return
      }
      throw new PluginInstallError("PLUGIN_SOURCE_UNSUPPORTED", "remote plugin sources must be an HTTPS .zip archive; git clones are not supported by the native runtime")
    }
    const local = resolve(source.replace(/^~(?=[\\/])/, homedir()))
    if (existsSync(local) && statSync(local).isDirectory()) {
      copyTree(local, payloadRoot)
    } else if (existsSync(local) && local.toLowerCase().endsWith(".zip")) {
      if (statSync(local).size > MAX_ARCHIVE_BYTES) {
        throw new PluginInstallError("PLUGIN_PACKAGE_TOO_LARGE", `plugin archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
      }
      mkdirSync(payloadRoot)
      extractZip(local, payloadRoot)
    } else {
      throw new PluginInstallError("PLUGIN_SOURCE_NOT_FOUND", "local plugin source must be an existing directory or ZIP archive")
    }
  }

  private candidates(payloadRoot: string): Array<Record<string, unknown>> {
    const manifestPaths: string[] = []
    const rootManifest = join(payloadRoot, "plugin.json")
    if (existsSync(rootManifest)) manifestPaths.push(rootManifest)
    for (const child of readdirSync(payloadRoot, { withFileTypes: true })) {
      if (child.isDirectory() && existsSync(join(payloadRoot, child.name, "plugin.json"))) {
        manifestPaths.push(join(payloadRoot, child.name, "plugin.json"))
      }
    }
    const candidates: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const manifestPath of manifestPaths.sort()) {
      const parsed = validateManifest(manifestPath, payloadRoot)
      if (parsed.problems.length > 0) {
        throw new PluginInstallError("INVALID_PLUGIN_MANIFEST", `${manifestPath}: ${parsed.problems.join(", ")}`)
      }
      if (seen.has(parsed.name)) {
        throw new PluginInstallError("INVALID_PLUGIN_PACKAGE", `duplicate plugin name: ${parsed.name}`)
      }
      seen.add(parsed.name)
      candidates.push({
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        hooks: parsed.hooks,
        tools: parsed.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        manifest_path: resolve(manifestPath),
        entrypoint: parsed.entrypoint,
        enabled: parsed.enabled,
        problems: parsed.problems,
        relative_path: dirname(manifestPath).replace(payloadRoot, "").replace(/^[\\/]/, ""),
        sha256: treeDigest(dirname(manifestPath)),
      })
    }
    if (candidates.length === 0) {
      throw new PluginInstallError("PLUGIN_MANIFEST_NOT_FOUND", "plugin package must contain plugin.json at its root or in an immediate subdirectory")
    }
    return candidates
  }

  private loadInspection(token: string): string {
    const normalized = String(token ?? "").trim().toLowerCase()
    if (!SAFE_TOKEN.test(normalized)) {
      throw new PluginInstallError("INVALID_INSPECTION", "invalid plugin inspection token")
    }
    const inspection = resolve(join(this.cacheRoot, normalized))
    if (!isWithin(this.cacheRoot, inspection)) {
      throw new PluginInstallError("INVALID_INSPECTION", "inspection path escaped the cache root")
    }
    if (!existsSync(join(inspection, "inspection.json"))) {
      throw new PluginInstallError("INSPECTION_NOT_FOUND", "plugin inspection expired or was not found")
    }
    let metadata: { created_epoch?: unknown }
    try {
      metadata = JSON.parse(readFileSync(join(inspection, "inspection.json"), "utf8")) as { created_epoch?: unknown }
    } catch {
      throw new PluginInstallError("INSPECTION_NOT_FOUND", "plugin inspection expired or was not found")
    }
    const created = metadata.created_epoch
    if (typeof created !== "number" || Date.now() / 1000 - created > INSPECTION_TTL_SECONDS) {
      rmSync(inspection, { recursive: true, force: true })
      throw new PluginInstallError("INSPECTION_EXPIRED", "plugin inspection has expired")
    }
    return inspection
  }

  private moveToTrash(source: string, name: string, reason: string): Record<string, unknown> {
    mkdirSync(this.trashRoot, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "T")
    const recoveryId = `${name}-${stamp}-${randomBytes(4).toString("hex")}`
    const destination = join(this.trashRoot, recoveryId)
    const recovery = {
      recovery_id: recoveryId,
      name,
      reason,
      removed_at: new Date().toISOString(),
      path: destination,
    }
    const metadataPath = join(source, ".recovery.json")
    writeFileSync(metadataPath, `${JSON.stringify(recovery, null, 2)}\n`, "utf8")
    try {
      renameSync(source, destination)
    } catch (error) {
      rmSync(metadataPath, { force: true })
      throw error
    }
    return recovery
  }

  private pruneExpired(): void {
    if (!existsSync(this.cacheRoot)) return
    const cutoff = Date.now() / 1000 - INSPECTION_TTL_SECONDS
    for (const child of readdirSync(this.cacheRoot, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      try {
        if (statSync(join(this.cacheRoot, child.name)).mtimeMs / 1000 < cutoff) {
          rmSync(join(this.cacheRoot, child.name), { recursive: true, force: true })
        }
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeSourceLabel(source: string): string {
  try {
    const parsed = new URL(source)
    if (/^https?:$/.test(parsed.protocol)) return `${parsed.protocol}//${parsed.host}${parsed.pathname.slice(0, 120)}`
  } catch {
    // local path
  }
  return source.slice(0, 120)
}

function isWithin(parent: string, child: string): boolean {
  const base = resolve(parent).toLowerCase()
  const target = resolve(child).toLowerCase()
  return target === base || target.startsWith(`${base}${sep}`)
}

function treeDigest(root: string): string {
  const hash = createHash("sha256")
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      hash.update(entry.name)
      if (entry.isDirectory()) {
        hash.update("/")
        walk(full)
      } else if (entry.isFile()) {
        hash.update(readFileSync(full))
      }
    }
  }
  walk(root)
  return hash.digest("hex")
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name)
    const dst = join(destination, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else if (entry.isFile()) {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, readFileSync(src))
    }
  }
}

function extractZip(archive: string, destination: string): void {
  // Minimal ZIP extraction for local .zip archives (no external dependency):
  // implemented with the end-of-central-directory scan + local file headers.
  const data = readFileSync(archive)
  const eocd = findEocd(data)
  if (eocd < 0) throw new PluginInstallError("INVALID_PLUGIN_ARCHIVE", "plugin archive is not a valid ZIP file")
  let offset = data.readUInt32LE(eocd + 16)
  while (offset < eocd) {
    if (data.readUInt32LE(offset) !== 0x04034b50) throw new PluginInstallError("INVALID_PLUGIN_ARCHIVE", "plugin archive has an invalid local header")
    const method = data.readUInt16LE(offset + 8)
    const compressedSize = data.readUInt32LE(offset + 18)
    const uncompressedSize = data.readUInt32LE(offset + 22)
    const nameLength = data.readUInt16LE(offset + 26)
    const extraLength = data.readUInt16LE(offset + 28)
    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
    const payload = data.subarray(offset + 30 + nameLength + extraLength, offset + 30 + nameLength + extraLength + compressedSize)
    const target = resolve(destination, name)
    if (!isWithin(destination, target)) {
      throw new PluginInstallError("UNSAFE_PLUGIN_ARCHIVE", "plugin archive contains paths escaping the payload root")
    }
    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true })
    } else {
      mkdirSync(dirname(target), { recursive: true })
      const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib")
      if (method === 0) {
        writeFileSync(target, payload)
      } else if (method === 8) {
        writeFileSync(target, inflateRawSync(payload))
      } else {
        throw new PluginInstallError("INVALID_PLUGIN_ARCHIVE", `plugin archive uses unsupported compression method: ${method}`)
      }
    }
    offset += 30 + nameLength + extraLength + compressedSize
  }
}

function findEocd(data: Buffer): number {
  for (let index = data.length - 22; index >= 0; index--) {
    if (data.readUInt32LE(index) === 0x06054b50) return index
    if (data.length - index > 65_536) break
  }
  return -1
}

function downloadZip(source: string, destination: string): void {
  const output = join(tmpdir(), `arforge-plugin-${randomBytes(8).toString("hex")}.zip`)
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const result = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", "--output", output, source], {
    timeout: 30_000,
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0 || !existsSync(output)) {
    const detail = String(result.stderr ?? result.error?.message ?? "download failed").trim().slice(0, 500)
    rmSync(output, { force: true })
    throw new PluginInstallError("PLUGIN_DOWNLOAD_FAILED", `plugin download failed: ${detail}`)
  }
  renameSync(output, destination)
}
