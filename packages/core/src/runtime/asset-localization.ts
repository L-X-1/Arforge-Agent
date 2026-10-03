import { createHash } from "node:crypto"
import posix from "node:path/posix"

/**
 * Pure planning seam for the future CDN asset-localization action.
 *
 * This module deliberately does not import HttpClient, FileMutation, or an
 * ActionGateway. It validates and plans a complete change set first; a later
 * adapter may execute that plan only after it has bound the same plan digest,
 * egress grant, fresh HTML fingerprint, and durable mutation intent to one
 * ActionGateway operation. Keeping the planner pure prevents a half-localized
 * page when a download, redirect, or CAS check fails.
 */

export const MAX_HTML_BYTES = 250_000
export const MAX_REFERENCES = 32
export const MAX_ASSET_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_ASSET_BYTES = 20 * 1024 * 1024

const mimePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/
const externalUrlPattern = /^https?:\/\/[^\s"'<>]+$/i

export type AssetKind = "script" | "stylesheet"

export type AssetReference = Readonly<{
  readonly kind: AssetKind
  /** URL exactly as it appeared in the HTML attribute, after trimming. */
  readonly url: string
  /** URL normalized for egress/fetch-result matching. */
  readonly normalizedURL: string
  readonly attribute: "src" | "href"
  /** Zero-based occurrence in source order. */
  readonly occurrence: number
}>

/**
 * The immutable request snapshot created before any asset is fetched.
 *
 * A future ActionGateway adapter should authorize this snapshot first, fetch
 * only the URLs in `networkScope`, and pass it back to `plan`. The planner
 * then recomputes the snapshot from the fresh HTML and fails closed if the
 * document, references, or target root changed while the requests were out.
 */
export type AssetDiscovery = Readonly<{
  readonly schemaVersion: 1
  readonly htmlResource: string
  readonly htmlDigest: string
  readonly assetRoot: string
  readonly references: ReadonlyArray<AssetReference>
  /** Unique normalized URLs that may be requested during discovery. */
  readonly networkScope: ReadonlyArray<string>
  /** Before staging, only the source HTML is allowed to be observed. */
  readonly filesystemScope: ReadonlyArray<string>
  /** Stable digest used to bind authorization to this exact request. */
  readonly requestDigest: string
}>

export type FetchedAsset = Readonly<{
  /** The URL passed to the egress-authorized fetcher. */
  readonly url: string
  /** Every redirect hop observed by the egress-authorized fetcher, in order. */
  readonly redirects?: ReadonlyArray<string>
  /** Final URL after redirects, if the fetcher followed a redirect. */
  readonly finalURL?: string
  readonly contentType: string
  readonly bytes: Uint8Array
}>

export type StagedAsset = Readonly<{
  readonly kind: AssetKind
  readonly digest: string
  readonly byteLength: number
  readonly contentType: string
  /** Workspace-relative target; never an absolute path or URL. */
  readonly target: string
  readonly content: Uint8Array
  readonly sourceURLs: ReadonlyArray<string>
  /** Redirect destinations returned by the egress-authorized fetcher. */
  readonly resolvedURLs: ReadonlyArray<string>
}>

export type LocalizationWrite = Readonly<{
  /** Workspace-relative target. */
  readonly target: string
  readonly content: string | Uint8Array
  readonly digest: string
  /** Existing files must be observed by the eventual ActionGateway adapter. */
  readonly requiresFreshObservation: true
}>

export type LocalizationPlan = Readonly<{
  readonly schemaVersion: 1
  readonly changed: boolean
  readonly htmlResource: string
  readonly htmlDigest: string
  readonly rewrittenHtmlDigest: string
  readonly assetRoot: string
  readonly references: ReadonlyArray<AssetReference>
  /** Digest of the pre-fetch HTML/reference request snapshot. */
  readonly discoveryDigest: string
  readonly stagedAssets: ReadonlyArray<StagedAsset>
  readonly writes: ReadonlyArray<LocalizationWrite>
  readonly networkScope: ReadonlyArray<string>
  readonly filesystemScope: ReadonlyArray<string>
  /** Exact request identity to bind into ActionGateway inputDigest/idempotency. */
  readonly inputDigest: string
  readonly idempotencyKey: string
}>

export type LocalizationActionDescriptor = Readonly<{
  readonly actionKind: "asset-localization"
  readonly actionVersion: "1"
  readonly inputDigest: string
  readonly discoveryDigest: string
  readonly idempotencyKey: string
  readonly networkScope: ReadonlyArray<string>
  readonly filesystemScope: ReadonlyArray<string>
  readonly expectedArtifacts: ReadonlyArray<string>
}>

export type AssetLocalizationErrorCode =
  | "invalid_html"
  | "unsafe_resource"
  | "too_many_references"
  | "invalid_url"
  | "missing_fetch"
  | "conflicting_fetch"
  | "invalid_redirect"
  | "discovery_mismatch"
  | "unsupported_content_type"
  | "asset_too_large"
  | "total_assets_too_large"
  | "nested_external_reference"

export class AssetLocalizationError extends Error {
  readonly code: AssetLocalizationErrorCode
  readonly value?: string

  constructor(code: AssetLocalizationErrorCode, message: string, value?: string) {
    super(message)
    this.name = "AssetLocalizationError"
    this.code = code
    this.value = value
  }
}

type SourceMatch = AssetReference & Readonly<{ start: number; end: number }>

const bytesOf = (value: string | Uint8Array): Uint8Array => {
  if (typeof value === "string") return new TextEncoder().encode(value)
  return new Uint8Array(value)
}

const textOf = (value: string | Uint8Array, label: string): string => {
  if (typeof value === "string") return value
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    throw new AssetLocalizationError("invalid_html", `${label} must be valid UTF-8 text.`)
  }
}

const digestOf = (value: string | Uint8Array): string => createHash("sha256").update(bytesOf(value)).digest("hex")

const cleanResource = (value: string, field: "htmlResource" | "assetRoot"): string => {
  const normalized = value.trim().replaceAll("\\", "/")
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000") ||
    normalized.split("/").some((part) => part === "..") ||
    /^[A-Za-z]:\//.test(normalized)
  )
    throw new AssetLocalizationError("unsafe_resource", `${field} must be a workspace-relative resource.`, value)
  return normalized
}

const normalizeURL = (value: string, code: "invalid_url" | "invalid_redirect" = "invalid_url"): string => {
  if (!externalUrlPattern.test(value) || /[\u0000-\u001f\u007f]/.test(value))
    throw new AssetLocalizationError(code, "Asset URL must use http:// or https:// without control characters.", value)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AssetLocalizationError(code, "Asset URL is not valid.", value)
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password)
    throw new AssetLocalizationError(code, "Asset URL must not contain credentials or an unsupported scheme.", value)
  if (parsed.hash)
    throw new AssetLocalizationError(code, "Asset URL fragments are not fetchable asset identities.", value)
  parsed.hash = ""
  return parsed.toString()
}

const mimeOf = (value: string): string => value.split(";", 1)[0]!.trim().toLowerCase()

const expectedMimes: Readonly<Record<AssetKind, ReadonlySet<string>>> = {
  script: new Set(["application/javascript", "application/x-javascript", "text/javascript", "text/ecmascript"]),
  stylesheet: new Set(["text/css"]),
}

const extensionOf = (kind: AssetKind) => (kind === "script" ? "js" : "css")
const directoryOf = (kind: AssetKind) => (kind === "script" ? "js" : "css")

const isStylesheetTag = (tag: string): boolean => {
  const rel = /\brel\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2] ?? ""
  return rel.split(/\s+/).some((part) => part.toLowerCase() === "stylesheet")
}

/**
 * Extract only external script/link stylesheet attributes. Inline JavaScript,
 * local paths, data URLs, and unrelated link types stay untouched. Attribute
 * ranges are retained internally so rewriting cannot replace a URL appearing
 * in a comment or script body by accident.
 */
const sourceMatches = (html: string): ReadonlyArray<SourceMatch> => {
  const matches: SourceMatch[] = []
  const tagPattern = /<script\b[^>]*>|<link\b[^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = tagPattern.exec(html)) !== null) {
    const source = tag[0]
    const isScript = /^<script\b/i.test(source)
    if (!isScript && !isStylesheetTag(source)) continue
    const attribute = isScript ? "src" : "href"
    const attributePattern = new RegExp(`\\b${attribute}\\s*=\\s*([\\\"'])(https?:\\/\\/[^\\\"'\\s>]+)\\1`, "i")
    const found = attributePattern.exec(source)
    if (!found || found.index === undefined) continue
    const url = found[2]!.trim()
    const normalizedURL = normalizeURL(url)
    const valueStart = tag.index + found.index + found[0].lastIndexOf(url)
    matches.push({
      kind: isScript ? "script" : "stylesheet",
      url,
      normalizedURL,
      attribute,
      occurrence: matches.length,
      start: valueStart,
      end: valueStart + url.length,
    })
    if (matches.length > MAX_REFERENCES)
      throw new AssetLocalizationError(
        "too_many_references",
        `Asset localization supports at most ${MAX_REFERENCES} external references.`,
      )
  }
  return matches
}

const discoveryDigest = (input: {
  readonly htmlResource: string
  readonly htmlDigest: string
  readonly assetRoot: string
  readonly references: ReadonlyArray<AssetReference>
}): string =>
  digestOf(
    JSON.stringify({
      domain: "arforge.asset-discovery/v1",
      schemaVersion: 1,
      htmlResource: input.htmlResource,
      htmlDigest: input.htmlDigest,
      assetRoot: input.assetRoot,
      references: input.references.map(({ kind, url, normalizedURL, attribute, occurrence }) => ({
        kind,
        url,
        normalizedURL,
        attribute,
        occurrence,
      })),
    }),
  )

/**
 * Parse and validate the source document before any network request. This is
 * deliberately side-effect-free so an ActionGateway can authorize the exact
 * URL set and HTML fingerprint before it gives a fetcher an egress grant.
 */
export const discover = (input: {
  readonly htmlResource: string
  readonly html: string | Uint8Array
  readonly assetRoot?: string
}): AssetDiscovery => {
  const htmlResource = cleanResource(input.htmlResource, "htmlResource")
  const assetRoot = cleanResource(input.assetRoot ?? "vendor", "assetRoot")
  const htmlBytes = bytesOf(input.html)
  if (htmlBytes.length > MAX_HTML_BYTES)
    throw new AssetLocalizationError("invalid_html", `HTML exceeds the ${MAX_HTML_BYTES}-byte limit.`)
  const html = textOf(input.html, "HTML")
  if (html.includes("\u0000")) throw new AssetLocalizationError("invalid_html", "HTML contains a NUL byte.")
  const matches = sourceMatches(html)
  const references = matches.map(({ start: _start, end: _end, ...reference }) => reference)
  const htmlDigest = digestOf(htmlBytes)
  const requestDigest = discoveryDigest({ htmlResource, htmlDigest, assetRoot, references })
  return {
    schemaVersion: 1,
    htmlResource,
    htmlDigest,
    assetRoot,
    references,
    networkScope: [...new Set(references.map((reference) => reference.normalizedURL))].sort(),
    filesystemScope: [htmlResource],
    requestDigest,
  }
}

const relativeTarget = (htmlResource: string, assetRoot: string, kind: AssetKind, digest: string): string => {
  const htmlDirectory = posix.dirname(htmlResource)
  const target = posix.join(htmlDirectory, assetRoot, directoryOf(kind), `${digest}.${extensionOf(kind)}`)
  const relative = posix.relative(htmlDirectory, target)
  if (!relative || relative.startsWith("../") || relative === ".." || relative.startsWith("/"))
    throw new AssetLocalizationError("unsafe_resource", "Staged asset target escapes the HTML directory.", target)
  return target
}

const rewrite = (
  html: string,
  matches: ReadonlyArray<SourceMatch>,
  replacements: ReadonlyMap<string, string>,
): string => {
  let result = ""
  let cursor = 0
  for (const match of matches) {
    const replacement = replacements.get(`${match.kind}\0${match.normalizedURL}`)
    if (!replacement)
      throw new AssetLocalizationError("missing_fetch", "An asset replacement was not planned.", match.url)
    result += html.slice(cursor, match.start) + replacement
    cursor = match.end
  }
  return result + html.slice(cursor)
}

const descriptorDigest = (input: {
  readonly htmlResource: string
  readonly htmlDigest: string
  readonly assetRoot: string
  readonly discoveryDigest: string
  readonly references: ReadonlyArray<AssetReference>
  readonly stagedAssets: ReadonlyArray<Pick<StagedAsset, "kind" | "digest" | "target" | "byteLength" | "resolvedURLs">>
}) =>
  digestOf(
    JSON.stringify({
      domain: "arforge.asset-localization/v1",
      htmlResource: input.htmlResource,
      htmlDigest: input.htmlDigest,
      assetRoot: input.assetRoot,
      discoveryDigest: input.discoveryDigest,
      references: input.references.map(({ kind, normalizedURL, attribute, occurrence }) => ({
        kind,
        normalizedURL,
        attribute,
        occurrence,
      })),
      stagedAssets: [...input.stagedAssets].sort((left, right) => left.target.localeCompare(right.target)),
    }),
  )

const validateFetchedAsset = (
  reference: AssetReference,
  fetched: FetchedAsset,
): Readonly<{
  readonly finalURL: string
  readonly redirectURLs: ReadonlyArray<string>
  readonly contentType: string
  readonly bytes: Uint8Array
  readonly digest: string
}> => {
  const requestedURL = normalizeURL(fetched.url)
  if (requestedURL !== reference.normalizedURL)
    throw new AssetLocalizationError(
      "conflicting_fetch",
      "Fetched asset URL does not match the requested reference.",
      fetched.url,
    )
  const redirectURLs = (fetched.redirects ?? []).map((value) => normalizeURL(value, "invalid_redirect"))
  const finalURL =
    fetched.finalURL === undefined
      ? (redirectURLs.at(-1) ?? requestedURL)
      : normalizeURL(fetched.finalURL, "invalid_redirect")
  if (redirectURLs.length > 0 && redirectURLs.at(-1) !== finalURL)
    throw new AssetLocalizationError(
      "invalid_redirect",
      "Redirect chain does not end at the final asset URL.",
      fetched.url,
    )
  const contentType = mimeOf(fetched.contentType)
  if (!mimePattern.test(contentType) || !expectedMimes[reference.kind].has(contentType))
    throw new AssetLocalizationError(
      "unsupported_content_type",
      `Fetched ${reference.kind} must have a JavaScript/CSS content type.`,
      fetched.contentType,
    )
  const bytes = bytesOf(fetched.bytes)
  if (bytes.length > MAX_ASSET_BYTES)
    throw new AssetLocalizationError(
      "asset_too_large",
      `Fetched asset exceeds the ${MAX_ASSET_BYTES}-byte limit.`,
      reference.url,
    )
  if (reference.kind === "stylesheet") {
    const css = textOf(bytes, "Fetched stylesheet")
    if (/(?:@import\s+(?:url\s*\(\s*)?|url\s*\(\s*)["']?https?:\/\//i.test(css))
      throw new AssetLocalizationError(
        "nested_external_reference",
        "Stylesheets with nested external references cannot be localized atomically yet.",
        reference.url,
      )
  }
  return { finalURL, redirectURLs, contentType, bytes, digest: digestOf(bytes) }
}

/**
 * Build a complete, side-effect-free localization plan. Every referenced
 * external URL must have one egress-validated fetch result; otherwise the
 * function fails before returning any write. Duplicate URLs are fetched once,
 * and equal content is staged once per asset kind by SHA-256.
 */
export const plan = (input: {
  readonly htmlResource: string
  readonly html: string | Uint8Array
  readonly fetchedAssets: ReadonlyArray<FetchedAsset>
  readonly assetRoot?: string
  /** Optional pre-fetch snapshot; a changed document fails closed. */
  readonly discovery?: AssetDiscovery
}): LocalizationPlan => {
  const discovered = discover(input)
  if (input.discovery && input.discovery.requestDigest !== discovered.requestDigest)
    throw new AssetLocalizationError(
      "discovery_mismatch",
      "The HTML or asset references changed after discovery; restart asset localization.",
    )
  const { htmlResource, assetRoot, htmlDigest } = discovered
  const requestDigest = discovered.requestDigest
  const html = textOf(input.html, "HTML")
  const matches = sourceMatches(html)
  const references = discovered.references
  if (matches.length === 0) {
    const inputDigest = descriptorDigest({
      htmlResource,
      htmlDigest,
      assetRoot,
      discoveryDigest: requestDigest,
      references,
      stagedAssets: [],
    })
    return {
      schemaVersion: 1,
      changed: false,
      htmlResource,
      htmlDigest,
      rewrittenHtmlDigest: htmlDigest,
      assetRoot,
      references,
      discoveryDigest: requestDigest,
      stagedAssets: [],
      writes: [],
      networkScope: [],
      filesystemScope: [htmlResource],
      inputDigest,
      idempotencyKey: `asset-localization:${inputDigest.slice(0, 32)}`,
    }
  }

  const fetchedByURL = new Map<string, FetchedAsset>()
  for (const fetched of input.fetchedAssets) {
    const normalized = normalizeURL(fetched.url)
    const previous = fetchedByURL.get(normalized)
    if (previous) {
      const previousBytes = bytesOf(previous.bytes)
      const nextBytes = bytesOf(fetched.bytes)
      const previousFinal =
        previous.finalURL === undefined ? normalized : normalizeURL(previous.finalURL, "invalid_redirect")
      const nextFinal = fetched.finalURL === undefined ? normalized : normalizeURL(fetched.finalURL, "invalid_redirect")
      const previousRedirects = (previous.redirects ?? []).map((value) => normalizeURL(value, "invalid_redirect"))
      const nextRedirects = (fetched.redirects ?? []).map((value) => normalizeURL(value, "invalid_redirect"))
      if (
        digestOf(previousBytes) !== digestOf(nextBytes) ||
        mimeOf(previous.contentType) !== mimeOf(fetched.contentType) ||
        previousFinal !== nextFinal ||
        JSON.stringify(previousRedirects) !== JSON.stringify(nextRedirects)
      )
        throw new AssetLocalizationError(
          "conflicting_fetch",
          "Multiple fetch results disagree for one URL.",
          fetched.url,
        )
      continue
    }
    fetchedByURL.set(normalized, fetched)
  }

  const validated = new Map<string, ReturnType<typeof validateFetchedAsset>>()
  const stagedByKey = new Map<string, StagedAsset>()
  const replacements = new Map<string, string>()
  let totalBytes = 0
  for (const reference of references) {
    const fetched = fetchedByURL.get(reference.normalizedURL)
    if (!fetched)
      throw new AssetLocalizationError(
        "missing_fetch",
        "Every external reference must be fetched before staging.",
        reference.url,
      )
    const key = `${reference.kind}\0${reference.normalizedURL}`
    let checked = validated.get(key)
    if (!checked) {
      checked = validateFetchedAsset(reference, fetched)
      validated.set(key, checked)
    }
    const stageKey = `${reference.kind}\0${checked.digest}`
    let staged = stagedByKey.get(stageKey)
    if (!staged) {
      totalBytes += checked.bytes.length
      if (totalBytes > MAX_TOTAL_ASSET_BYTES)
        throw new AssetLocalizationError(
          "total_assets_too_large",
          `Staged assets exceed the ${MAX_TOTAL_ASSET_BYTES}-byte total limit.`,
        )
      const target = relativeTarget(htmlResource, assetRoot, reference.kind, checked.digest)
      staged = {
        kind: reference.kind,
        digest: checked.digest,
        byteLength: checked.bytes.length,
        contentType: checked.contentType,
        target,
        content: new Uint8Array(checked.bytes),
        sourceURLs: [reference.url],
        resolvedURLs: [...new Set([...checked.redirectURLs, checked.finalURL])],
      }
      stagedByKey.set(stageKey, staged)
    } else if (
      !staged!.sourceURLs.includes(reference.url) ||
      checked.redirectURLs.some((url) => !staged!.resolvedURLs.includes(url)) ||
      !staged!.resolvedURLs.includes(checked.finalURL)
    ) {
      staged = {
        ...staged,
        ...(staged!.sourceURLs.includes(reference.url) ? {} : { sourceURLs: [...staged!.sourceURLs, reference.url] }),
        resolvedURLs: [...new Set([...staged!.resolvedURLs, ...checked.redirectURLs, checked.finalURL])],
      }
      stagedByKey.set(stageKey, staged)
    }
    if (!staged)
      throw new AssetLocalizationError("missing_fetch", "An asset staging target was not created.", reference.url)
    replacements.set(key, posix.relative(posix.dirname(htmlResource), staged.target))
  }

  const stagedAssets = [...stagedByKey.values()].sort((left, right) => left.target.localeCompare(right.target))
  const rewrittenHtml = rewrite(html, matches, replacements)
  const rewrittenHtmlDigest = digestOf(rewrittenHtml)
  const inputDigest = descriptorDigest({
    htmlResource,
    htmlDigest,
    assetRoot,
    discoveryDigest: requestDigest,
    references,
    stagedAssets,
  })
  const writes: LocalizationWrite[] = [
    ...stagedAssets.map((asset) => ({
      target: asset.target,
      content: new Uint8Array(asset.content),
      digest: asset.digest,
      requiresFreshObservation: true as const,
    })),
    {
      target: htmlResource,
      content: rewrittenHtml,
      digest: rewrittenHtmlDigest,
      requiresFreshObservation: true,
    },
  ]
  return {
    schemaVersion: 1,
    changed: true,
    htmlResource,
    htmlDigest,
    rewrittenHtmlDigest,
    assetRoot,
    references,
    discoveryDigest: requestDigest,
    stagedAssets,
    writes,
    networkScope: [
      ...new Set([
        ...references.map((reference) => reference.normalizedURL),
        ...stagedAssets.flatMap((asset) => asset.resolvedURLs),
      ]),
    ].sort(),
    filesystemScope: [htmlResource, ...stagedAssets.map((asset) => asset.target)].sort(),
    inputDigest,
    idempotencyKey: `asset-localization:${inputDigest.slice(0, 32)}`,
  }
}

/** Convert a pure plan into the exact scope metadata an ActionGateway adapter must bind. */
export const actionDescriptor = (value: LocalizationPlan): LocalizationActionDescriptor => ({
  actionKind: "asset-localization",
  actionVersion: "1",
  inputDigest: value.inputDigest,
  discoveryDigest: value.discoveryDigest,
  idempotencyKey: value.idempotencyKey,
  networkScope: value.networkScope,
  filesystemScope: value.filesystemScope,
  expectedArtifacts: value.filesystemScope,
})
