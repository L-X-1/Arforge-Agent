export * as FrontendDiagnosis from "./frontend-diagnosis"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "./schema"

/** The two legacy frontend validators are one deterministic Core operation. */
export const Mode = Schema.Literals(["frontend", "javascript"]).annotate({
  identifier: "FrontendDiagnosis.Mode",
})
export type Mode = typeof Mode.Type

export const Severity = Schema.Literals(["error", "warning", "info"]).annotate({
  identifier: "FrontendDiagnosis.Severity",
})
export type Severity = typeof Severity.Type

export const IssueCode = Schema.Literals([
  "empty_source",
  "missing_body",
  "missing_html",
  "unclosed_script",
  "blocking_script",
  "external_asset_not_checked",
  "unbalanced_braces",
  "unbalanced_parentheses",
  "unbalanced_brackets",
  "stray_closing_delimiter",
  "unterminated_string",
  "unterminated_comment",
  "missing_mount_target",
  "prefix_icon_literal",
  "undeclared_app",
  "router_history_unclear",
  "vue_detected",
]).annotate({ identifier: "FrontendDiagnosis.IssueCode" })
export type IssueCode = typeof IssueCode.Type

export const Issue = Schema.Struct({
  code: IssueCode,
  severity: Severity,
  message: Schema.String,
  line: PositiveInt.pipe(optional),
  detail: Schema.String.pipe(optional),
}).annotate({ identifier: "FrontendDiagnosis.Issue" })
export interface Issue extends Schema.Schema.Type<typeof Issue> {}

export const ScriptSummary = Schema.Struct({
  tags: NonNegativeInt,
  inline: NonNegativeInt,
  external: NonNegativeInt,
  blocking: NonNegativeInt,
}).annotate({ identifier: "FrontendDiagnosis.ScriptSummary" })
export interface ScriptSummary extends Schema.Schema.Type<typeof ScriptSummary> {}

export const ExternalAsset = Schema.Struct({
  kind: Schema.Literals(["script", "stylesheet"]),
  url: Schema.String,
  local: Schema.Boolean,
}).annotate({ identifier: "FrontendDiagnosis.ExternalAsset" })
export interface ExternalAsset extends Schema.Schema.Type<typeof ExternalAsset> {}

/**
 * Read-only discovery metadata for the future external-asset localization
 * action.  This is deliberately a preview contract: it never contains
 * fetched bytes, write targets, credentials, or an approval capability.
 */
export const AssetLocalizationPreview = Schema.Struct({
  status: Schema.Literals(["ready", "none", "blocked"]),
  execution: Schema.Literal("preview_only"),
  htmlResource: Schema.String,
  assetRoot: Schema.String,
  discoveryDigest: Schema.String.pipe(optional),
  references: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["script", "stylesheet"]),
      /** Query values are redacted before this metadata crosses the API. */
      url: Schema.String,
    }),
  ),
  networkScopeCount: NonNegativeInt,
  reason: Schema.String.pipe(optional),
}).annotate({ identifier: "FrontendDiagnosis.AssetLocalizationPreview" })
export interface AssetLocalizationPreview extends Schema.Schema.Type<typeof AssetLocalizationPreview> {}

export const Framework = Schema.Literals(["none", "vue3"]).annotate({
  identifier: "FrontendDiagnosis.Framework",
})
export type Framework = typeof Framework.Type

export const Report = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  localOnly: Schema.Literal(true),
  mode: Mode,
  path: Schema.String,
  success: Schema.Boolean,
  textChars: NonNegativeInt,
  lineCount: NonNegativeInt,
  truncated: Schema.Boolean,
  script: ScriptSummary.pipe(optional),
  framework: Framework,
  externalAssets: Schema.Array(ExternalAsset),
  assetLocalizationPreview: AssetLocalizationPreview.pipe(optional),
  issues: Schema.Array(Issue),
}).annotate({ identifier: "FrontendDiagnosis.Report" })
export interface Report extends Schema.Schema.Type<typeof Report> {}
