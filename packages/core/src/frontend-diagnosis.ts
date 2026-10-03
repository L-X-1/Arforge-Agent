import { FrontendDiagnosis } from "@arforge-ai/schema/frontend-diagnosis"
import * as AssetLocalization from "./runtime/asset-localization"

export const MAX_SOURCE_CHARS = 250_000
const MAX_EXTERNAL_ASSETS = 32

export type AnalyzeInput = {
  readonly source: string
  readonly path: string
  readonly mode: FrontendDiagnosis.Mode
}

type MutableIssue = FrontendDiagnosis.Issue

type Delimiter = "{" | "(" | "["

const closing: Record<Delimiter, string> = {
  "{": "}",
  "(": ")",
  "[": "]",
}

const issueForDelimiter = (delimiter: Delimiter): FrontendDiagnosis.IssueCode => {
  switch (delimiter) {
    case "{":
      return "unbalanced_braces"
    case "(":
      return "unbalanced_parentheses"
    case "[":
      return "unbalanced_brackets"
  }
}

const lineAt = (source: string, offset: number) => source.slice(0, Math.max(0, offset)).split(/\r?\n/).length

const issue = (
  code: FrontendDiagnosis.IssueCode,
  severity: FrontendDiagnosis.Severity,
  message: string,
  line?: number,
  detail?: string,
): MutableIssue => ({
  code,
  severity,
  message,
  ...(line === undefined ? {} : { line }),
  ...(detail === undefined ? {} : { detail }),
})

const attribute = (attributes: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const isExternalUrl = (value: string) => /^https?:\/\//i.test(value) || value.startsWith("//")

/** Keep external asset URLs useful without allowing query values into metadata. */
const redactAssetURL = (value: string) => {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value)
    for (const key of url.searchParams.keys()) url.searchParams.set(key, "[REDACTED]")
    return url.toString()
  } catch {
    return "[REDACTED_URL]"
  }
}

const safeAssetURL = (value: string) => (isExternalUrl(value) ? redactAssetURL(value) : value)

const scanJavascript = (source: string): ReadonlyArray<MutableIssue> => {
  const issues: MutableIssue[] = []
  const stack: Array<{ readonly delimiter: Delimiter; readonly line: number }> = []
  let state: "code" | "single" | "double" | "template" | "line_comment" | "block_comment" = "code"
  let stateLine = 1

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    const line = lineAt(source, index)

    if (state === "line_comment") {
      if (current === "\n" || current === "\r") state = "code"
      continue
    }
    if (state === "block_comment") {
      if (current === "*" && next === "/") {
        state = "code"
        index += 1
      }
      continue
    }
    if (state === "single" || state === "double" || state === "template") {
      if (current === "\\") {
        index += 1
        continue
      }
      const terminator = state === "single" ? "'" : state === "double" ? '"' : "`"
      if (current === terminator) state = "code"
      continue
    }

    if (current === "/" && next === "/") {
      state = "line_comment"
      index += 1
      continue
    }
    if (current === "/" && next === "*") {
      state = "block_comment"
      stateLine = line
      index += 1
      continue
    }
    if (current === "'" || current === '"' || current === "`") {
      state = current === "'" ? "single" : current === '"' ? "double" : "template"
      stateLine = line
      continue
    }
    if (current === "{" || current === "(" || current === "[") {
      stack.push({ delimiter: current, line })
      continue
    }
    if (current === "}" || current === ")" || current === "]") {
      const top = stack.at(-1)
      if (top && closing[top.delimiter] === current) stack.pop()
      else
        issues.push(
          issue(
            "stray_closing_delimiter",
            "error",
            `Stray closing delimiter ${current} does not match the active JavaScript scope`,
            line,
          ),
        )
    }
  }

  if (state === "single" || state === "double" || state === "template")
    issues.push(issue("unterminated_string", "error", "JavaScript string or template literal is not closed", stateLine))
  if (state === "block_comment")
    issues.push(issue("unterminated_comment", "error", "JavaScript block comment is not closed", stateLine))

  for (const unmatched of stack)
    issues.push(
      issue(
        issueForDelimiter(unmatched.delimiter),
        "error",
        `Unbalanced JavaScript delimiter ${unmatched.delimiter}; expected ${closing[unmatched.delimiter]}`,
        unmatched.line,
      ),
    )
  return issues
}

const dedupeIssues = (issues: ReadonlyArray<MutableIssue>) => {
  const seen = new Set<string>()
  return issues.filter((item) => {
    const key = `${item.code}\u0000${item.line ?? 0}\u0000${item.detail ?? item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const mapScriptIssues = (source: string, offset: number, script: string) =>
  scanJavascript(script).map((item) => ({
    ...item,
    ...(item.line === undefined ? {} : { line: lineAt(source, offset) + item.line - 1 }),
  }))

const addFrontendChecks = (source: string, issues: MutableIssue[]) => {
  if (!/<\/body\s*>/i.test(source)) issues.push(issue("missing_body", "error", "HTML is missing a closing </body> tag"))
  if (!/<\/html\s*>/i.test(source)) issues.push(issue("missing_html", "error", "HTML is missing a closing </html> tag"))

  const scriptTagPattern = /<script\b([^>]*)>/gi
  const scriptContentPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  const scriptClosingPattern = /<\/script\s*>/gi
  const scriptTags = [...source.matchAll(scriptTagPattern)]
  const scriptContents = [...source.matchAll(scriptContentPattern)]
  const scriptClosings = [...source.matchAll(scriptClosingPattern)]
  let inline = 0
  let external = 0
  let blocking = 0
  const externalAssets: FrontendDiagnosis.ExternalAsset[] = []

  for (const match of scriptTags) {
    const attributes = match[1] ?? ""
    const url = attribute(attributes, "src")
    if (!url) {
      inline += 1
      continue
    }
    external += 1
    const nonBlocking = /\b(?:async|defer)\b/i.test(attributes) || /\btype\s*=\s*["']module["']/i.test(attributes)
    const displayURL = safeAssetURL(url)
    if (!nonBlocking) {
      blocking += 1
      issues.push(
        issue(
          "blocking_script",
          "warning",
          `External script is blocking page parsing: ${displayURL}`,
          lineAt(source, match.index ?? 0),
        ),
      )
    }
    if (externalAssets.length < MAX_EXTERNAL_ASSETS)
      externalAssets.push({ kind: "script", url: displayURL, local: !isExternalUrl(url) })
  }

  if (scriptTags.length > scriptClosings.length)
    issues.push(issue("unclosed_script", "error", "One or more <script> tags are missing a closing </script> tag"))

  for (const match of scriptContents) {
    const body = match[2] ?? ""
    if (!body.trim()) continue
    const offset = (match.index ?? 0) + (match[0]?.indexOf(">") ?? 0) + 1
    issues.push(...mapScriptIssues(source, offset, body))
  }

  const linkPattern = /<link\b([^>]*)>/gi
  for (const match of source.matchAll(linkPattern)) {
    const attributes = match[1] ?? ""
    const url = attribute(attributes, "href")
    const rel = attribute(attributes, "rel") ?? ""
    if (!url || !/\bstylesheet\b/i.test(rel)) continue
    const displayURL = safeAssetURL(url)
    if (externalAssets.length < MAX_EXTERNAL_ASSETS)
      externalAssets.push({ kind: "stylesheet", url: displayURL, local: !isExternalUrl(url) })
  }

  for (const asset of externalAssets.filter((item) => !item.local))
    issues.push(
      issue(
        "external_asset_not_checked",
        "info",
        `External ${asset.kind} reachability was not checked in local-only diagnosis`,
        undefined,
        asset.url,
      ),
    )

  const hasVue = source.includes("createApp") || (source.includes(".mount") && source.includes("createRouter"))
  if (hasVue) issues.push(issue("vue_detected", "info", "Vue 3 application patterns detected"))

  for (const match of source.matchAll(/\.mount\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = match[1] ?? ""
    const id = target.startsWith("#") ? target.slice(1) : undefined
    if (id && !new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`, "i").test(source))
      issues.push(
        issue(
          "missing_mount_target",
          "error",
          `Vue mount target ${target} was not found in HTML`,
          lineAt(source, match.index ?? 0),
        ),
      )
  }

  const icons = [...source.matchAll(/prefix-icon\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]).filter(Boolean)
  if (icons.length > 0)
    issues.push(
      issue(
        "prefix_icon_literal",
        "warning",
        `Found ${icons.length} prefix-icon string value(s); verify registered Vue icon components`,
        undefined,
        [...new Set(icons)].join(", "),
      ),
    )

  if (/createRouter\s*\(/.test(source) && !/createWeb(?:Hash)?History\s*\(/.test(source))
    issues.push(issue("router_history_unclear", "warning", "Vue Router history mode could not be determined"))

  if (/\bapp\s*=\s*createApp\s*\(/.test(source) && !/\b(?:var|let|const)\s+app\s*=\s*createApp\s*\(/.test(source))
    issues.push(issue("undeclared_app", "warning", "app = createApp(...) is assigned without var, let, or const"))

  return {
    script: { tags: scriptTags.length, inline, external, blocking },
    framework: hasVue ? ("vue3" as const) : ("none" as const),
    externalAssets,
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Derive the exact pre-fetch asset request fingerprint without contacting the
 * network.  This is intentionally a preview-only projection: a later
 * executor must rediscover the source, ask the ActionGateway for the exact
 * scope, and only then fetch/write.  Invalid input becomes a bounded reason,
 * never a thrown UI-breaking error or a leaked URL.
 */
export const assetLocalizationPreview = (
  htmlResource: string,
  source: string,
): FrontendDiagnosis.AssetLocalizationPreview => {
  const base = {
    execution: "preview_only" as const,
    htmlResource,
    assetRoot: "vendor",
    references: [] as Array<{ readonly kind: "script" | "stylesheet"; readonly url: string }>,
    networkScopeCount: 0,
  }
  if (!/\.html?$/i.test(htmlResource))
    return {
      ...base,
      status: "none",
      reason: "Asset localization preview is available for HTML files only.",
    }
  if (!source.trim())
    return {
      ...base,
      status: "blocked",
      reason: "No HTML source is available for an asset localization preview.",
    }
  try {
    const discovery = AssetLocalization.discover({ htmlResource, html: source })
    return {
      ...base,
      status: discovery.references.length > 0 ? "ready" : "none",
      assetRoot: discovery.assetRoot,
      discoveryDigest: discovery.requestDigest,
      references: discovery.references.map((reference) => ({
        kind: reference.kind,
        url: redactAssetURL(reference.url),
      })),
      networkScopeCount: discovery.networkScope.length,
      ...(discovery.references.length === 0
        ? { reason: "No external script or stylesheet references need localization." }
        : {}),
    }
  } catch (error) {
    const code = error instanceof AssetLocalization.AssetLocalizationError ? error.code : "invalid_html"
    return {
      ...base,
      status: "blocked",
      reason: `Asset localization preview is unavailable (${code}).`,
    }
  }
}

/**
 * Deterministic local-only replacement for the legacy Python frontend and JS
 * validators. It never fetches URLs, executes JavaScript, or writes assets;
 * callers that need network access must use the canonical webfetch/egress
 * pipeline and callers that need a mutation must use the canonical write
 * pipeline.
 */
export const analyze = (input: AnalyzeInput): FrontendDiagnosis.Report => {
  const normalized = input.source.replaceAll("\u0000", "")
  const truncated = normalized.length > MAX_SOURCE_CHARS
  const source = normalized.slice(0, MAX_SOURCE_CHARS)
  const issues: MutableIssue[] = []
  const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length
  if (!source.trim()) issues.push(issue("empty_source", "error", "The source is empty"))

  let script: FrontendDiagnosis.ScriptSummary | undefined
  let framework: FrontendDiagnosis.Framework = "none"
  let externalAssets: FrontendDiagnosis.ExternalAsset[] = []
  let localizationPreview: FrontendDiagnosis.AssetLocalizationPreview | undefined
  if (input.mode === "frontend") {
    const checks = addFrontendChecks(source, issues)
    script = checks.script
    framework = checks.framework
    externalAssets = checks.externalAssets
    localizationPreview = assetLocalizationPreview(input.path, source)
  } else {
    issues.push(...scanJavascript(source))
  }

  const stableIssues = dedupeIssues(issues)
  return {
    schemaVersion: 1,
    localOnly: true,
    mode: input.mode,
    path: input.path,
    success: source.trim().length > 0 && !stableIssues.some((item) => item.severity === "error"),
    textChars: source.length,
    lineCount,
    truncated,
    ...(script ? { script } : {}),
    framework,
    externalAssets,
    ...(localizationPreview ? { assetLocalizationPreview: localizationPreview } : {}),
    issues: stableIssues,
  }
}

export const suggestions = (report: FrontendDiagnosis.Report): ReadonlyArray<string> => {
  const suggestions: string[] = []
  const errors = report.issues.filter((item) => item.severity === "error")
  const warnings = report.issues.filter((item) => item.severity === "warning")
  for (const item of errors.slice(0, 4)) suggestions.push(`${item.message}${item.line ? ` (line ${item.line})` : ""}.`)
  if (report.issues.some((item) => item.code === "external_asset_not_checked"))
    suggestions.push(
      "Use the approved webfetch path to verify external assets; this local diagnostic never disables TLS verification.",
    )
  if (warnings.length > 0 && suggestions.length < 4)
    suggestions.push(
      "Review the warnings before editing, then rerun multimodal_diagnose with the same mode to verify the fix.",
    )
  if (suggestions.length === 0)
    suggestions.push(
      "No deterministic frontend or JavaScript defects were found; check the browser console for runtime-only failures.",
    )
  return suggestions
}

export const format = (report: FrontendDiagnosis.Report) => {
  const lines = [
    `Frontend diagnosis (${report.mode})`,
    `- local_only: ${report.localOnly}`,
    `- success: ${report.success}`,
    `- path: ${report.path}`,
    `- text_chars: ${report.textChars}`,
    `- lines: ${report.lineCount}`,
    `- truncated: ${report.truncated}`,
    `- framework: ${report.framework}`,
  ]
  if (report.script)
    lines.push(
      `- scripts: tags=${report.script.tags}, inline=${report.script.inline}, external=${report.script.external}, blocking=${report.script.blocking}`,
    )
  if (report.externalAssets.length > 0) {
    lines.push("", "External assets (reachability intentionally not probed):")
    for (const asset of report.externalAssets.slice(0, 12))
      lines.push(`- ${asset.kind}: ${asset.url} [local=${asset.local}]`)
  }
  if (report.assetLocalizationPreview) {
    const preview = report.assetLocalizationPreview
    lines.push("", "Asset localization preview (read-only; no fetch or write):")
    lines.push(
      `- status: ${preview.status}`,
      `- html_resource: ${preview.htmlResource}`,
      `- asset_root: ${preview.assetRoot}`,
    )
    if (preview.discoveryDigest) lines.push(`- discovery_digest: ${preview.discoveryDigest}`)
    lines.push(`- network_scope_count: ${preview.networkScopeCount}`)
    for (const reference of preview.references.slice(0, 12)) lines.push(`- ${reference.kind}: ${reference.url}`)
    if (preview.reason) lines.push(`- reason: ${preview.reason}`)
  }
  if (report.issues.length > 0) {
    lines.push("", "Issues:")
    for (const item of report.issues.slice(0, 24))
      lines.push(`- [${item.severity}] ${item.code}${item.line ? ` line ${item.line}` : ""}: ${item.message}`)
  }
  lines.push("", "Next steps:", ...suggestions(report).map((item) => `- ${item}`))
  return lines.join("\n")
}
