import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * The dynamic provider hook is intentionally a narrow compatibility seam:
 * it may load an already-resolved local module or an npm package, but it must
 * never treat an arbitrary URL, module export, or return value as executable
 * provider state.  Keep these checks here so AISDK and the provider plugin do
 * not grow parallel validation rules.
 */

export const DynamicProviderLimits = Object.freeze({
  packageSpec: 256,
  entrypoint: 4096,
  optionKeys: 256,
  optionKey: 128,
})

export type DynamicProviderContractCode =
  | "invalid-package-spec"
  | "unsupported-package-protocol"
  | "invalid-entrypoint"
  | "unsupported-entrypoint-protocol"
  | "invalid-options"
  | "invalid-factory-export"
  | "ambiguous-factory-export"
  | "missing-factory-export"
  | "factory-threw"
  | "invalid-sdk"

export class DynamicProviderContractError extends Error {
  readonly _tag = "DynamicProviderContractError"

  constructor(readonly code: DynamicProviderContractCode) {
    super(`Dynamic provider contract rejected (${code})`)
    this.name = "DynamicProviderContractError"
  }
}

const reject = (code: DynamicProviderContractCode): never => {
  throw new DynamicProviderContractError(code)
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const hasControl = (value: string) => /[\u0000-\u001f\u007f]/u.test(value)
const hasControlOrWhitespace = (value: string) => /[\u0000-\u0020\u007f]/u.test(value)

/** Validate the package coordinate before Npm.add or a dynamic import runs. */
export function validateDynamicProviderPackage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > DynamicProviderLimits.packageSpec)
    return reject("invalid-package-spec")
  if (hasControlOrWhitespace(value)) return reject("invalid-package-spec")

  if (value.startsWith("file://")) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return reject("invalid-package-spec")
    }
    if (url.protocol !== "file:" || url.hostname.length > 0 || url.pathname.length === 0 || url.search || url.hash)
      return reject("invalid-package-spec")
    return value
  }

  const protocol = /^[a-z][a-z\d+.-]*:/iu.exec(value)?.[0]?.toLowerCase()
  if (protocol) {
    // npm: aliases still resolve through the existing Npm owner.  All other
    // URI schemes (including http(s), git and data) are outside this local
    // typed seam and remain explicitly deferred.
    if (protocol !== "npm:") return reject("unsupported-package-protocol")
    const target = value.slice("npm:".length)
    if (!target || /^(?:https?|git|file):/iu.test(target)) return reject("invalid-package-spec")
    return value
  }

  // Dynamic providers are addressed by registry package specs.  A local path
  // must be represented as file:// so the import root cannot silently depend
  // on process.cwd().
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("\\") || value.includes("\\"))
    return reject("invalid-package-spec")
  return value
}

/**
 * Convert an Npm owner result into an import URL.  Npm is expected to return a
 * local absolute path; accepting only file:// or absolute paths prevents a
 * mocked/misconfigured resolver from turning this seam into remote code load.
 */
export function dynamicProviderEntrypoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > DynamicProviderLimits.entrypoint)
    return reject("invalid-entrypoint")
  // Spaces are valid in a local filesystem path; control characters are not.
  if (hasControl(value)) return reject("invalid-entrypoint")

  if (value.startsWith("file://")) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return reject("invalid-entrypoint")
    }
    if (url.protocol !== "file:" || url.hostname.length > 0 || url.pathname.length === 0 || url.search || url.hash)
      return reject("invalid-entrypoint")
    return value
  }

  if (!path.isAbsolute(value)) {
    if (/^[a-z][a-z\d+.-]*:/iu.test(value)) return reject("unsupported-entrypoint-protocol")
    return reject("invalid-entrypoint")
  }
  return pathToFileURL(value).href
}

/**
 * Freeze a shallow, metadata-preserving copy of provider options.  Functions
 * such as the AISDK custom fetch remain valid values; we only reject arrays,
 * class instances and unbounded/control-bearing option maps.
 */
export function dynamicProviderOptions(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return reject("invalid-options")
  const entries = Object.entries(value)
  if (entries.length > DynamicProviderLimits.optionKeys) return reject("invalid-options")
  for (const [key] of entries) {
    if (key.length === 0 || key.length > DynamicProviderLimits.optionKey || hasControlOrWhitespace(key))
      return reject("invalid-options")
  }
  return Object.freeze({ ...value })
}

export type DynamicProviderFactory = (options: Readonly<Record<string, unknown>>) => unknown

export type DynamicProviderSDK = {
  readonly languageModel: (modelID: string) => unknown
}

const isFactoryName = (name: string) => /^create(?:[A-Za-z0-9_]+)?$/u.test(name)

/**
 * Select one deterministic factory export.  `createProvider` is the explicit
 * convention; otherwise exactly one create* function is accepted.  Picking
 * the first object key made provider selection depend on bundler ordering and
 * could accidentally execute a helper export, so ambiguity is fail-closed.
 */
export function selectDynamicProviderFactory(module: unknown): {
  readonly name: string
  readonly factory: DynamicProviderFactory
} {
  // ESM module namespace objects have an exotic prototype, so this boundary
  // intentionally checks only the immutable object shape, not Object.prototype.
  if (!isObjectRecord(module)) return reject("missing-factory-export")

  const explicit = module.createProvider
  if (explicit !== undefined) {
    if (typeof explicit !== "function") return reject("invalid-factory-export")
    return { name: "createProvider", factory: explicit as DynamicProviderFactory }
  }

  const candidates = Object.keys(module).filter(isFactoryName)
  if (candidates.length === 0) return reject("missing-factory-export")
  if (candidates.length !== 1) return reject("ambiguous-factory-export")
  const name = candidates[0]
  const factory = module[name]
  if (typeof factory !== "function") return reject("invalid-factory-export")
  return { name, factory: factory as DynamicProviderFactory }
}

export function dynamicProviderSDK(value: unknown): DynamicProviderSDK {
  const candidate =
    (typeof value === "object" && value !== null) || typeof value === "function"
      ? (value as { languageModel?: unknown })
      : undefined
  if (!candidate || typeof candidate.languageModel !== "function") return reject("invalid-sdk")
  return value as DynamicProviderSDK
}

/** Invoke a factory without allowing its exception to escape as an untyped contract. */
export function createDynamicProviderSDK(
  factory: DynamicProviderFactory,
  options: Readonly<Record<string, unknown>>,
): DynamicProviderSDK {
  let value: unknown
  try {
    value = factory(options)
  } catch {
    return reject("factory-threw")
  }
  return dynamicProviderSDK(value)
}
