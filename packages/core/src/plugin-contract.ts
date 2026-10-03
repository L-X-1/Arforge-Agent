import { createHash, createPublicKey, verify } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { extname, join, resolve } from "node:path"

/** Version of the declarative Plugin/Skill Center manifest contract. */
export const PLUGIN_CONTRACT_VERSION = 1 as const
export const MAX_PLUGIN_ENTRIES = 2_000
export const MAX_PLUGIN_EXPANDED_BYTES = 100 * 1024 * 1024
const MAX_SCAN_FILE_BYTES = 512 * 1024
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const EXECUTABLE_TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ps1",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
])

export type PluginPermissionDeclaration = {
  readonly action: string
  readonly resources: ReadonlyArray<string>
}

export type PluginCompatibility = {
  readonly api_version: number
  readonly runtime?: string
  readonly platforms: ReadonlyArray<string>
}

export type PluginSignature = {
  readonly algorithm: "ed25519"
  readonly key_id: string
  readonly value: string
}

export type PluginManifestMetadata = {
  readonly permissions: ReadonlyArray<PluginPermissionDeclaration>
  readonly egress: ReadonlyArray<string>
  readonly secrets: ReadonlyArray<string>
  readonly compatibility: PluginCompatibility
  readonly signature?: PluginSignature
}

export type PluginSignatureInfo = {
  readonly status: "unsigned" | "untrusted" | "verified" | "invalid"
  readonly algorithm?: "ed25519"
  readonly key_id?: string
  readonly signed_digest: string
  readonly reason?: string
}

export type PluginSecurityFinding = {
  readonly rule:
    | "forbidden-runtime-boundary"
    | "undeclared-egress"
    | "undeclared-secret"
    | "signature"
    | "scan-limit"
    | "unsafe-path"
  readonly severity: "info" | "warning" | "blocking"
  readonly path: string
  readonly message: string
}

export type PluginSecurityReport = {
  readonly status: "passed" | "warning" | "blocked"
  readonly findings: ReadonlyArray<PluginSecurityFinding>
  readonly scanned_files: number
  readonly scanned_bytes: number
}

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)

const stringList = (value: unknown, label: string, problems: string[], maxItems: number, maxLength: number) => {
  if (value === undefined) return [] as string[]
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => boundedString(item, maxLength))) {
    problems.push(`${label} must be an array of at most ${maxItems} bounded strings`)
    return [] as string[]
  }
  return [...new Set(value.map((item) => String(item).trim()))]
}

export function parsePluginManifestMetadata(
  payload: Record<string, unknown>,
  problems: string[],
): PluginManifestMetadata {
  const permissions: PluginPermissionDeclaration[] = []
  const rawPermissions = payload.permissions
  if (rawPermissions !== undefined) {
    if (!Array.isArray(rawPermissions) || rawPermissions.length > 64) {
      problems.push("permissions must be an array with at most 64 entries")
    } else {
      for (const [index, raw] of rawPermissions.entries()) {
        if (typeof raw !== "object" || raw === null) {
          problems.push(`permissions[${index}] must be an object`)
          continue
        }
        const item = raw as Record<string, unknown>
        const resources = stringList(item.resources, `permissions[${index}].resources`, problems, 64, 512)
        if (!boundedString(item.action, 128) || resources.length === 0) {
          problems.push(`permissions[${index}] requires a bounded action and at least one resource`)
          continue
        }
        permissions.push({ action: String(item.action).trim(), resources })
      }
    }
  }

  const egress = stringList(payload.egress, "egress", problems, 64, 512)
  const secrets = stringList(payload.secrets, "secrets", problems, 64, 256)

  let compatibility: PluginCompatibility = { api_version: PLUGIN_CONTRACT_VERSION, platforms: [] }
  if (payload.compatibility !== undefined) {
    if (typeof payload.compatibility !== "object" || payload.compatibility === null) {
      problems.push("compatibility must be an object")
    } else {
      const raw = payload.compatibility as Record<string, unknown>
      const platforms = stringList(raw.platforms, "compatibility.platforms", problems, 16, 64)
      const apiVersion = raw.api_version
      if (!Number.isSafeInteger(apiVersion) || apiVersion !== PLUGIN_CONTRACT_VERSION) {
        problems.push(`compatibility.api_version must equal ${PLUGIN_CONTRACT_VERSION}`)
      }
      if (raw.runtime !== undefined && !boundedString(raw.runtime, 128)) {
        problems.push("compatibility.runtime must be a bounded string")
      }
      compatibility = {
        api_version: typeof apiVersion === "number" ? apiVersion : -1,
        ...(typeof raw.runtime === "string" ? { runtime: raw.runtime.trim() } : {}),
        platforms,
      }
    }
  }

  let signature: PluginSignature | undefined
  if (payload.signature !== undefined) {
    if (typeof payload.signature !== "object" || payload.signature === null) {
      problems.push("signature must be an object")
    } else {
      const raw = payload.signature as Record<string, unknown>
      if (raw.algorithm !== "ed25519" || !boundedString(raw.key_id, 128) || !boundedString(raw.value, 512)) {
        problems.push("signature must declare ed25519, a bounded key_id, and a bounded base64 value")
      } else if (!/^[A-Za-z0-9+/_=-]+$/.test(raw.value)) {
        problems.push("signature.value must be base64 or base64url")
      } else {
        signature = { algorithm: "ed25519", key_id: raw.key_id.trim(), value: raw.value }
      }
    }
  }

  return { permissions, egress, secrets, compatibility, ...(signature ? { signature } : {}) }
}

export function pluginHome(home?: string): string {
  const configured = (home ?? process.env.ARFORGE_HOME)?.trim()
  return configured ? resolve(configured) : resolve(homedir(), ".arforge")
}

export function pluginTreeDigest(root: string, options: { readonly excludeSignature?: boolean } = {}): string {
  const hash = createHash("sha256")
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      hash.update(entry.name)
      if (entry.isDirectory()) {
        hash.update("/")
        walk(full)
      } else if (entry.isFile()) {
        if (options.excludeSignature && entry.name === "plugin.json") {
          try {
            const payload = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>
            delete payload.signature
            hash.update(stableJson(payload))
          } catch {
            hash.update(readFileSync(full))
          }
        } else {
          hash.update(readFileSync(full))
        }
      }
    }
  }
  walk(resolve(root))
  return hash.digest("hex")
}

export function verifyPluginSignature(
  root: string,
  metadata: PluginManifestMetadata,
  identity: { readonly name: string; readonly version: string },
  home?: string,
): PluginSignatureInfo {
  const signedDigest = pluginTreeDigest(root, { excludeSignature: true })
  const signature = metadata.signature
  if (!signature) return { status: "unsigned", signed_digest: signedDigest, reason: "manifest has no signature" }

  const trustPath = join(pluginHome(home), "config", "plugin_trust.json")
  let trustedKey: unknown
  try {
    const payload = JSON.parse(readFileSync(trustPath, "utf8")) as { keys?: unknown }
    trustedKey = payload.keys && typeof payload.keys === "object" ? (payload.keys as Record<string, unknown>)[signature.key_id] : undefined
  } catch {
    trustedKey = undefined
  }
  if (!boundedString(trustedKey, 16_384)) {
    return {
      status: "untrusted",
      algorithm: signature.algorithm,
      key_id: signature.key_id,
      signed_digest: signedDigest,
      reason: "signature key is not present in the local trust store",
    }
  }

  const message = Buffer.from(
    `arforge-plugin-signature/v1\0${identity.name}\0${identity.version}\0${signedDigest}\0${stableJson(metadata.compatibility)}`,
    "utf8",
  )
  try {
    const key = trustedKey.includes("BEGIN")
      ? createPublicKey(trustedKey)
      : createPublicKey({ key: Buffer.from(trustedKey, "base64"), format: "der", type: "spki" })
    const value = Buffer.from(signature.value.replaceAll("-", "+").replaceAll("_", "/"), "base64")
    const valid = verify(null, message, key, value)
    return {
      status: valid ? "verified" : "invalid",
      algorithm: signature.algorithm,
      key_id: signature.key_id,
      signed_digest: signedDigest,
      ...(valid ? {} : { reason: "signature verification failed" }),
    }
  } catch {
    return {
      status: "invalid",
      algorithm: signature.algorithm,
      key_id: signature.key_id,
      signed_digest: signedDigest,
      reason: "signature key or value is malformed",
    }
  }
}

export function scanPluginDirectory(
  root: string,
  metadata: PluginManifestMetadata,
  signature: PluginSignatureInfo,
): PluginSecurityReport {
  const findings: PluginSecurityFinding[] = []
  let scannedFiles = 0
  let scannedBytes = 0
  let scanStopped = false
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (scanStopped) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (entry.isSymbolicLink()) {
        findings.push({
          rule: "unsafe-path",
          severity: "blocking",
          path: full.slice(resolve(root).length + 1).replaceAll("\\", "/"),
          message: "plugin package contains a symbolic link or reparse point",
        })
        continue
      }
      if (!entry.isFile() || entry.name === "plugin.json") continue
      scannedFiles += 1
      if (scannedFiles > MAX_PLUGIN_ENTRIES) {
        findings.push({
          rule: "scan-limit",
          severity: "blocking",
          path: entry.name,
          message: "security scan limits were exceeded",
        })
        scanStopped = true
        return
      }
      const size = statSync(full).size
      const relativePath = full.slice(resolve(root).length + 1).replaceAll("\\", "/")
      if (size > MAX_SCAN_FILE_BYTES) {
        if (EXECUTABLE_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
          findings.push({
            rule: "scan-limit",
            severity: "blocking",
            path: relativePath,
            message: "executable source exceeds the per-file security scan limit",
          })
        continue
      }
      if (scannedBytes + size > MAX_SCAN_BYTES) {
        findings.push({
          rule: "scan-limit",
          severity: "blocking",
          path: relativePath,
          message: "security scan byte limit was exceeded",
        })
        scanStopped = true
        return
      }
      const content = readFileSync(full).toString("utf8")
      scannedBytes += size
      if (/(?:EventV2|event[-_ ]publisher|Database\.(?:Admin|Service)|db[-_ ]admin|opaque[^\n]{0,80}capability[^\n]{0,40}registry)/i.test(content)) {
        findings.push({
          rule: "forbidden-runtime-boundary",
          severity: "blocking",
          path: relativePath,
          message: "plugin code references a forbidden EventV2, database-admin, or opaque capability boundary",
        })
      }
      if (hasUndeclaredSecretAccess(content, metadata.secrets)) {
        findings.push({
          rule: "undeclared-secret",
          severity: "blocking",
          path: relativePath,
          message: "plugin code accesses a secret name that is not declared in the manifest",
        })
      }
      if (hasUndeclaredEgress(content, metadata.egress)) {
        findings.push({
          rule: "undeclared-egress",
          severity: "blocking",
          path: relativePath,
          message: "plugin code uses a network target that is not declared in the manifest",
        })
      }
    }
  }
  try {
    visit(resolve(root))
  } catch (error) {
    findings.push({
      rule: "scan-limit",
      severity: "blocking",
      path: ".",
      message: `security scan could not read the package: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  if (signature.status === "unsigned") {
    findings.push({ rule: "signature", severity: "warning", path: "plugin.json", message: "plugin is unsigned" })
  } else if (signature.status === "untrusted") {
    findings.push({ rule: "signature", severity: "warning", path: "plugin.json", message: signature.reason ?? "signature is untrusted" })
  } else if (signature.status === "invalid") {
    findings.push({ rule: "signature", severity: "blocking", path: "plugin.json", message: signature.reason ?? "signature is invalid" })
  }
  const status = findings.some((item) => item.severity === "blocking")
    ? "blocked"
    : findings.some((item) => item.severity === "warning")
      ? "warning"
      : "passed"
  return { status, findings, scanned_files: scannedFiles, scanned_bytes: scannedBytes }
}

const SECRET_ACCESS_PATTERN =
  /(?:process|Bun)\.env(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*|\s*\[)|Deno\.env\.get\s*\(|os\.(?:environ\s*\[|getenv\s*\()|System\.getenv\s*\(|\$env:/i

function accessedSecretNames(content: string): ReadonlySet<string> {
  const names = new Set<string>()
  const patterns = [
    /(?:process|Bun)\.env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:process|Bun)\.env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /(?:Deno\.env\.get|os\.getenv|System\.getenv)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /os\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /\$env:([A-Za-z_][A-Za-z0-9_]*)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) names.add(match[1].toUpperCase())
    }
  }
  return names
}

function hasUndeclaredSecretAccess(content: string, declarations: ReadonlyArray<string>): boolean {
  if (!SECRET_ACCESS_PATTERN.test(content)) return false
  const declared = new Set(declarations.map((value) => value.trim().toUpperCase()))
  const accessed = accessedSecretNames(content)
  if (accessed.size === 0) return true
  return [...accessed].some((name) => !declared.has(name))
}

const EGRESS_ACCESS_PATTERN =
  /(?:\bcurl\b|\bwget\b|Invoke-WebRequest|fetch\s*\(|https?:\/\/|requests\.(?:get|post)|urllib|socket|http\.request)/i

function declaredEgressAllows(declaration: string, target: URL): boolean {
  const normalized = declaration.trim()
  try {
    const allowed = new URL(normalized)
    if (allowed.protocol !== target.protocol || allowed.hostname.toLowerCase() !== target.hostname.toLowerCase()) return false
    if (allowed.port !== target.port) return false
    const path = allowed.pathname.replace(/\/+$/, "")
    return path === "" || path === "/" || target.pathname === path || target.pathname.startsWith(`${path}/`)
  } catch {
    return normalized.toLowerCase() === target.hostname.toLowerCase()
  }
}

function hasUndeclaredEgress(content: string, declarations: ReadonlyArray<string>): boolean {
  if (!EGRESS_ACCESS_PATTERN.test(content)) return false
  const targets: URL[] = []
  for (const match of content.matchAll(/https?:\/\/[^\s'"`)<>{}\]]+/gi)) {
    try {
      targets.push(new URL(match[0]))
    } catch {
      return true
    }
  }
  if (targets.length === 0) return true
  return targets.some((target) => !declarations.some((declaration) => declaredEgressAllows(declaration, target)))
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
