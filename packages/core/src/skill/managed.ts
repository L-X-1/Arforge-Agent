export * as ManagedSkills from "./managed"

/**
 * Managed skill registry — native port of ``arforge/skills.py`` and the
 * ``skills.*`` bridge surface. Reads the same skill roots, manifest format
 * and ``skills_state.json`` disable state as the retired Python registry, so
 * existing profiles keep working. Routing reuses the native SkillRouting.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { findDevelopmentRuntimeRoot } from "./runtime-root"
import { SkillRouting } from "./routing"

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/

const BUNDLED_MANIFEST_OVERRIDES: Record<string, { id: string; name: string; description: string }> = {
  "model-api": {
    id: "model-api",
    name: "model-api",
    description:
      "Reference for model API / SDK work: model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, and model migration.",
  },
}

export interface ManagedSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly source: string
  readonly path: string
  readonly entrypoint: string
  readonly license: string
  readonly tags: string[]
  readonly enabled: boolean
  readonly problems: string[]
}

export interface ManagedSkillList {
  readonly count: number
  readonly enabled_count: number
  readonly items: ManagedSkill[]
  readonly roots: string[]
}

export interface ManagedSkillMutation {
  readonly skill_id: string
  readonly enabled: boolean
  readonly changed: boolean
  readonly skills: ManagedSkillList
}

export interface SkillReadSuccess {
  readonly ok: true
  readonly manifest: ManagedSkill
  readonly content: string
  readonly truncated: boolean
  readonly resources: string[]
}

export interface SkillReadFailure {
  readonly ok: false
  readonly error: string
}

export type SkillReadResult = SkillReadSuccess | SkillReadFailure

export interface SkillRouteResult {
  readonly mode: string
  readonly selected: string[]
  readonly phases: string[]
  readonly reasons: Record<string, string>
  readonly missing: string[]
  readonly relationship: string
  readonly capabilities?: string[]
}

export interface ManagedSkillOptions {
  readonly roots?: string[]
  readonly statePath?: string
  readonly home?: string
}

interface RawManifest {
  readonly id?: string
  readonly name?: string
  readonly description?: string
  readonly version?: string
  readonly license?: string
  readonly tags?: string[]
  readonly _error?: string
}

const DEVELOPMENT_SKILL_ORDER = ["grill-me", "openspec", "trellis", "superpowers"] as const
const ALL_ROUTABLE_SKILLS = new Set<string>([...DEVELOPMENT_SKILL_ORDER, "vision-tools", "design-taste-frontend"])
const PHASES = {
  "grill-me": "clarify",
  openspec: "specify",
  trellis: "organize",
  superpowers: "deliver",
} as const
const RELATIONSHIP = "grill-me → OpenSpec → Trellis → Superpowers"

export function defaultSkillRoots(options: { home?: string; cwd?: string } = {}): string[] {
  const roots: string[] = []
  const envRoots = process.env.ARFORGE_SKILL_PATHS?.trim() ?? ""
  if (envRoots) {
    for (const part of envRoots.split(/\s*[;:]\s*/)) {
      if (part.trim()) roots.push(resolve(part.replace(/^~(?=[\\/])/, homedir())))
    }
  }
  roots.push(resolve(defaultHome(options.home), "skills"))
  roots.push(resolve(options.cwd ?? process.cwd(), ".arforge", "skills"))
  const bundled = bundledAgentSkillsRoot()
  if (bundled) roots.push(bundled)
  return dedupe(roots)
}

export function defaultHome(home?: string): string {
  const configured = (home ?? process.env.ARFORGE_HOME)?.trim()
  return configured ? resolve(configured) : resolve(homedir(), ".arforge")
}

export function bundledAgentSkillsRoot(): string | undefined {
  const runtimeRoot = process.env.ARFORGE_AGENT_RUNTIME_ROOT || findDevelopmentRuntimeRoot(process.cwd())
  if (!runtimeRoot) return
  for (const candidate of [
    join(runtimeRoot, "arforge", "bundled_skills", "agent_skills", "skills"),
    join(runtimeRoot, "_internal", "arforge", "bundled_skills", "agent_skills", "skills"),
  ]) {
    if (existsSync(candidate)) return candidate
  }
}

export class ManagedSkillRegistry {
  private readonly roots: string[]
  private readonly statePath: string
  private readonly home: string
  private disabled = new Set<string>()
  private stateLoaded = false

  constructor(options: ManagedSkillOptions = {}) {
    this.home = defaultHome(options.home)
    this.roots = options.roots ?? defaultSkillRoots({ home: this.home })
    this.statePath = options.statePath ?? join(this.home, "skills_state.json")
  }

  list(cached = false): ManagedSkillList {
    void cached
    this.loadState()
    const manifests: ManagedSkill[] = []
    const scannedRoots: string[] = []
    for (const rawRoot of this.roots) {
      const root = resolve(rawRoot)
      scannedRoots.push(root)
      if (!existsSync(root)) continue
      for (const candidate of iterSkillDirs(root)) {
        const manifest = loadSkillManifest(candidate, root)
        if (manifest !== null) manifests.push(manifest)
      }
    }
    const deduped = dedupeSkills(manifests, this.disabled)
    const enabled = deduped.filter((item) => item.enabled && item.problems.length === 0)
    return { count: deduped.length, enabled_count: enabled.length, items: deduped, roots: scannedRoots }
  }

  refresh(): ManagedSkillList {
    return this.list(false)
  }

  read(skillId: string, maxChars = 60_000): SkillReadResult {
    const cleanId = validateSkillId(skillId)
    const list = this.list(false)
    const manifest = list.items.find((item) => item.id.toLowerCase() === cleanId)
    if (!manifest || !manifest.enabled || manifest.problems.length > 0) {
      return { ok: false, error: `skill not found, disabled, or invalid: ${skillId}` }
    }
    const skillDir = resolve(manifest.path)
    const entrypoint = resolve(skillDir, manifest.entrypoint)
    if (!isWithin(skillDir, entrypoint) || !existsSync(entrypoint)) {
      return { ok: false, error: "skill entrypoint is missing or outside the skill directory" }
    }
    let content: string
    try {
      content = readFileSync(entrypoint, "utf8").replace(/^\uFEFF/, "")
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const truncated = content.length > maxChars
    if (truncated) content = `${content.slice(0, maxChars)}\n...[truncated]`
    return {
      ok: true,
      manifest,
      content,
      truncated,
      resources: listSkillResources(skillDir),
    }
  }

  setEnabled(skillId: string, enabled: boolean): ManagedSkillMutation {
    const cleanId = validateSkillId(skillId)
    this.loadState()
    const before = this.disabled.has(cleanId)
    const nowDisabled = !enabled
    if (nowDisabled) this.disabled.add(cleanId)
    else this.disabled.delete(cleanId)
    const changed = before !== nowDisabled
    if (changed) this.saveState()
    return {
      skill_id: cleanId,
      enabled,
      changed,
      skills: this.list(false),
    }
  }

  route(request: string): SkillRouteResult {
    const route = SkillRouting.route(request, ALL_ROUTABLE_SKILLS)
    const phases = DEVELOPMENT_SKILL_ORDER.filter((skill) => route.selected.includes(skill)).map(
      (skill) => PHASES[skill],
    )
    return {
      mode: route.mode,
      selected: [...route.selected],
      phases,
      reasons: { ...route.reasons },
      missing: [],
      relationship: RELATIONSHIP,
      capabilities: [...route.capabilities],
    }
  }

  private loadState(): void {
    if (this.stateLoaded) return
    this.stateLoaded = true
    if (!existsSync(this.statePath)) return
    try {
      const data = JSON.parse(readFileSync(this.statePath, "utf8")) as { disabled?: unknown }
      if (Array.isArray(data.disabled)) {
        for (const value of data.disabled) {
          if (typeof value === "string" && SAFE_ID.test(value)) this.disabled.add(value)
        }
      }
    } catch {
      // unreadable state is treated as empty; enable/disable rewrites it
    }
  }

  private saveState(): void {
    mkdirSync(dirname(this.statePath), { recursive: true })
    const encoded = Buffer.from(`${JSON.stringify({ disabled: [...this.disabled].sort() }, null, 2)}\n`, "utf8")
    const temporary = join(dirname(this.statePath), `.skills_state.${randomUUID().replace(/-/g, "")}.tmp`)
    try {
      writeFileSync(temporary, encoded, { flag: "wx" })
      renameSync(temporary, this.statePath)
    } finally {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest parsing (compatible with the Python front-matter reader)
// ---------------------------------------------------------------------------

function loadSkillManifest(skillDir: string, root: string): ManagedSkill | null {
  const resolvedDir = resolve(skillDir)
  const manifestPath = join(resolvedDir, "skill.json")
  const markdownPath = join(resolvedDir, "SKILL.md")
  let data: RawManifest
  let entrypoint: string
  if (existsSync(manifestPath)) {
    entrypoint = "skill.json"
    try {
      data = JSON.parse(readFileSync(manifestPath, "utf8")) as RawManifest
    } catch (error) {
      data = { name: basenameOf(resolvedDir), description: "", _error: String(error) }
    }
  } else if (existsSync(markdownPath)) {
    entrypoint = "SKILL.md"
    data = loadMarkdownFrontMatter(markdownPath)
  } else {
    return null
  }

  const problems: string[] = []
  if (data === null || typeof data !== "object") {
    data = {}
    problems.push("manifest is not an object")
  }
  if (data._error) problems.push(data._error)
  const rawSkillId = String(data.id ?? data.name ?? basenameOf(resolvedDir)).trim()
  const override = BUNDLED_MANIFEST_OVERRIDES[basenameOf(resolvedDir).toLowerCase()]
  const skillId = String(override?.id ?? rawSkillId).trim()
  const name = String(override?.name ?? data.name ?? skillId).trim()
  const description = String(override?.description ?? data.description ?? "").trim()
  const version = String(data.version ?? "0.0.0").trim()
  const licenseText = String(data.license ?? "").trim()
  const tags = cleanTags(data.tags)
  if (!skillId || !SAFE_ID.test(skillId)) problems.push("id must match ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
  if (!name) problems.push("name is required")
  if (!description) problems.push("description is required")

  return {
    id: skillId,
    name,
    description,
    version,
    source: sourceFor(resolvedDir, root),
    path: resolvedDir,
    entrypoint,
    license: licenseText,
    tags,
    enabled: true,
    problems,
  }
}

function loadMarkdownFrontMatter(path: string): RawManifest {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    return { name: basenameOf(dirname(path)), description: "", _error: String(error) }
  }
  if (!text.startsWith("---\n")) return { name: basenameOf(dirname(path)), description: firstHeading(text) }
  const end = text.indexOf("\n---", 4)
  if (end < 0) return { name: basenameOf(dirname(path)), description: firstHeading(text) }
  const data: RawManifest = {}
  const lines = text.slice(4, end).split("\n")
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const colon = line.indexOf(":")
    if (colon < 0) {
      index += 1
      continue
    }
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value === "|" || value === "|-" || value === "|+" || value === ">" || value === ">-" || value === ">+") {
      const block: string[] = []
      index += 1
      while (index < lines.length) {
        const next = lines[index]
        if (!next.startsWith(" ") && !next.startsWith("\t") && next.trim()) break
        block.push(next.trim())
        index += 1
      }
      const joined = block.join("\n")
      if (value.startsWith(">")) {
        value = joined
          .split("\n")
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" ")
      } else {
        value = joined
      }
    }
    if (key) (data as Record<string, unknown>)[key] = parseScalar(value)
    index += 1
  }
  return data
}

function parseScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
  }
  return value.replace(/^['"]|['"]$/g, "")
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const tags = raw.map((item) => String(item).trim()).filter(Boolean)
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b))
}

function firstHeading(text: string): string {
  for (const line of text.split("\n")) {
    const stripped = line.trim()
    if (stripped.startsWith("#")) return stripped.replace(/^#+\s*/, "")
  }
  return ""
}

// ---------------------------------------------------------------------------
// Discovery helpers (compatible with the Python iterators)
// ---------------------------------------------------------------------------

function iterSkillDirs(root: string): string[] {
  const candidates = new Map<string, string>()
  const add = (path: string) => {
    if (existsSync(join(path, "SKILL.md")) || existsSync(join(path, "skill.json"))) {
      candidates.set(resolve(path).toLowerCase(), resolve(path))
    }
  }
  add(root)
  if (existsSync(root)) {
    for (const child of readdirSync(root, { withFileTypes: true })) {
      if (child.isDirectory()) add(join(root, child.name))
    }
  }
  const nested = join(root, "skills")
  if (existsSync(nested)) {
    for (const child of readdirSync(nested, { withFileTypes: true })) {
      if (child.isDirectory()) add(join(nested, child.name))
    }
  }
  return [...candidates.values()].sort((a, b) => basenameOf(a).localeCompare(basenameOf(b)))
}

function listSkillResources(skillDir: string, limit = 80): string[] {
  const resources: string[] = []
  const walk = (current: string) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name !== "SKILL.md" && entry.name !== "skill.json") {
        const relative = full.slice(skillDir.length + 1).replaceAll("\\", "/")
        resources.push(relative)
        if (resources.length >= limit) return
      }
    }
  }
  walk(skillDir)
  return resources
}

function sourceFor(skillDir: string, root: string): string {
  const bundled = bundledAgentSkillsRoot()
  if (bundled && isWithin(bundled, skillDir)) return "builtin:agent-skills"
  const cwd = process.cwd()
  if (isWithin(cwd, skillDir)) return "workspace"
  void root
  return "profile"
}

function validateSkillId(skillId: string): string {
  const cleaned = String(skillId ?? "").trim()
  if (!SAFE_ID.test(cleaned)) throw new Error("skill_id must match ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
  return cleaned
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const key = resolve(path).toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(path)
    }
  }
  return result
}

function dedupeSkills(items: ManagedSkill[], disabled: Set<string>): ManagedSkill[] {
  const seen = new Set<string>()
  const result: ManagedSkill[] = []
  for (const item of items) {
    const key = item.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...item, enabled: !disabled.has(item.id) })
  }
  return result
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ""
}

function isWithin(parent: string, child: string): boolean {
  const relative = resolve(child).toLowerCase()
  const root = resolve(parent).toLowerCase()
  return relative === root || relative.startsWith(`${root}\\`) || relative.startsWith(`${root}/`)
}
