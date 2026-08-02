import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export type ProductEnvSource = "explicit" | "user" | "workspace"

export type ProductEnvResult = {
  path?: string
  source?: ProductEnvSource
  loaded: string[]
  skipped: string[]
}

export type ProductEnvOptions = {
  workspaceRoot?: string
  env?: NodeJS.ProcessEnv
  home?: string
  /**
   * Make the selected product env file authoritative over inherited values.
   * This is intended for interactive product launchers whose parent shell can
   * contain stale credentials. Service processes should keep the default so
   * explicitly injected environment variables remain authoritative.
   */
  override?: boolean
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if (first === "'" && last === "'") return value.slice(1, -1)
  if (first !== '"' || last !== '"') return value
  return value
    .slice(1, -1)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
}

export function parseProductEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line
    const separator = normalized.indexOf("=")
    if (separator <= 0) continue
    const key = normalized.slice(0, separator).trim()
    if (!ENV_KEY.test(key)) continue
    result[key] = unquote(normalized.slice(separator + 1).trim())
  }
  return result
}

function explicitPath(value: string | undefined, cwd: string): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
}

export function resolveProductEnvFile(options: ProductEnvOptions = {}): {
  path?: string
  source?: ProductEnvSource
} {
  const env = options.env ?? process.env
  const explicit = explicitPath(env.ARFORGE_ENV_FILE, process.cwd())
  if (explicit) return { path: explicit, source: "explicit" }

  const user = join(options.home ?? homedir(), ".arforge", ".env")
  if (existsSync(user)) return { path: user, source: "user" }

  if (options.workspaceRoot) {
    const workspace = join(options.workspaceRoot, ".env")
    if (existsSync(workspace)) return { path: workspace, source: "workspace" }
  }
  return {}
}

/**
 * Load the private product environment before database/provider modules import.
 * Existing process variables win by default, so service managers and explicit
 * command-line environments remain authoritative. Interactive launchers may
 * opt into file authority with `override: true`.
 */
export function loadProductEnv(options: ProductEnvOptions = {}): ProductEnvResult {
  const env = options.env ?? process.env
  const selected = resolveProductEnvFile({ ...options, env })
  if (!selected.path || !selected.source) return { loaded: [], skipped: [] }
  if (!existsSync(selected.path)) {
    if (selected.source === "explicit") {
      throw new Error(`ARFORGE_ENV_FILE does not exist: ${selected.path}`)
    }
    return { loaded: [], skipped: [] }
  }

  const parsed = parseProductEnv(readFileSync(selected.path, "utf8"))
  const loaded: string[] = []
  const skipped: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (!options.override && env[key] !== undefined) {
      skipped.push(key)
      continue
    }
    env[key] = value
    loaded.push(key)
  }
  return {
    path: selected.path,
    source: selected.source,
    loaded: loaded.sort(),
    skipped: skipped.sort(),
  }
}
