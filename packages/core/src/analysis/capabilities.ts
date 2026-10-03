/**
 * Deterministic capability routing for the TypeScript/Core CLI.
 *
 * The historical Python capability engine executed arbitrary handlers while
 * testing a route.  That made a command named `capabilities test` capable of
 * invoking a model, writing files, or running a command merely because a
 * keyword matched.  The TypeScript owner intentionally makes this surface a
 * side-effect-free route preview until every capability has a typed Core
 * execution contract and the corresponding permission/evidence boundary.
 */

import {
  CAPABILITY_CATALOG,
  type CapabilityExecutionContract,
  type CatalogEntry,
  type CapabilityExecutionVerification,
} from "../capability-catalog"

export type CapabilityRouteReason = "keyword" | "none"

export interface CapabilityRouteMatch {
  readonly name: string
  readonly description: string
  readonly kind: string
  readonly priority: number
  readonly enabled: boolean
  readonly score: number
  readonly matched_keywords: ReadonlyArray<string>
  /** A route match is available to a future typed handler, not executed here. */
  readonly status: "matched-not-executed"
}

export interface CapabilityTestReport {
  readonly schema_version: 1
  readonly input: string
  readonly route_reason: CapabilityRouteReason
  readonly execution_mode: "route-preview"
  readonly side_effects: "none"
  readonly total: number
  readonly matched: number
  readonly executed: 0
  readonly succeeded: 0
  readonly failed: 0
  readonly not_executed: number
  readonly capabilities_used: ReadonlyArray<string>
  readonly items: ReadonlyArray<CapabilityRouteMatch>
}

export interface CapabilityTestOptions {
  /** Maximum number of ranked matches. The default mirrors Python routing. */
  readonly limit?: number
}

export type CapabilityExecutionReadiness = "ready" | "not_ready" | "disabled"

export interface CapabilityExecutionAuditItem {
  readonly name: string
  readonly description: string
  readonly kind: string
  readonly priority: number
  readonly enabled: boolean
  readonly status: CapabilityExecutionReadiness
  readonly missing_requirements: ReadonlyArray<string>
  readonly declared_owner: string | null
  readonly declared_side_effects: CapabilityExecutionContract["side_effects"] | "unknown"
  readonly declared_verification: CapabilityExecutionVerification | null
}

export interface CapabilityExecutionAuditReport {
  readonly schema_version: 1
  /** A declaration audit never invokes a capability handler. */
  readonly execution_mode: "read-only-capability-contract-audit"
  readonly side_effects: "none"
  readonly catalog_count: number
  readonly enabled_count: number
  readonly ready_count: number
  readonly not_ready_count: number
  readonly disabled_count: number
  readonly model_invoked: false
  readonly handlers_executed: 0
  readonly decision: "ready" | "fail-closed"
  readonly items: ReadonlyArray<CapabilityExecutionAuditItem>
  readonly caveat: string
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const REQUIRED_EXECUTION_REQUIREMENTS = [
  "typed_input_schema",
  "typed_output_schema",
  "action_gateway_authorization",
  "cancellation",
  "evidence",
  "settlement",
  "owner",
  "side_effects",
  "verification_evidence",
] as const

function normalizeInput(value: string): string {
  return value.trim()
}

function matchEntry(
  entry: CatalogEntry,
  input: string,
  index: number,
): (CapabilityRouteMatch & { readonly index: number }) | undefined {
  if (!entry.enabled) return undefined
  const lowered = input.toLowerCase()
  const matchedKeywords = entry.keywords.filter((keyword) => {
    const normalized = keyword.trim().toLowerCase()
    return normalized.length > 0 && lowered.includes(normalized)
  })
  if (matchedKeywords.length === 0) return undefined
  return {
    name: entry.name,
    description: entry.description,
    kind: entry.kind,
    priority: entry.priority,
    enabled: entry.enabled,
    score: matchedKeywords.length,
    matched_keywords: matchedKeywords,
    status: "matched-not-executed",
    index,
  }
}

/**
 * Rank the same keyword routes exposed by the legacy registry without
 * executing a handler.  Sorting uses score, priority, and catalog order so a
 * report is stable across processes and runtimes.
 */
export function testCapabilities(input: string, options: CapabilityTestOptions = {}): CapabilityTestReport {
  const normalized = normalizeInput(input)
  const requestedLimit = options.limit ?? DEFAULT_LIMIT
  const safeLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, safeLimit))
  const matches = CAPABILITY_CATALOG.map((entry, index) => matchEntry(entry, normalized, index))
    .filter((entry): entry is CapabilityRouteMatch & { readonly index: number } => entry !== undefined)
    .sort((left, right) => right.score - left.score || left.priority - right.priority || left.index - right.index)
    .slice(0, limit)
    .map(({ index: _index, ...entry }) => entry)

  const names = matches.map((entry) => entry.name)
  return {
    schema_version: 1,
    input: normalized,
    route_reason: matches.length > 0 ? "keyword" : "none",
    execution_mode: "route-preview",
    side_effects: "none",
    total: matches.length,
    matched: matches.length,
    executed: 0,
    succeeded: 0,
    failed: 0,
    not_executed: matches.length,
    capabilities_used: names,
    items: matches,
  }
}

function executionMissing(contract: CapabilityExecutionContract | undefined): string[] {
  if (!contract) return [...REQUIRED_EXECUTION_REQUIREMENTS]
  const missing: string[] = []
  if (!contract.owner.trim()) missing.push("owner")
  if (!contract.typed_input_schema.trim()) missing.push("typed_input_schema")
  if (!contract.typed_output_schema.trim()) missing.push("typed_output_schema")
  if (contract.authorization !== "action-gateway") missing.push("action_gateway_authorization")
  if (contract.cancellation !== "required") missing.push("cancellation")
  if (contract.evidence !== "required") missing.push("evidence")
  if (contract.settlement !== "required") missing.push("settlement")
  if (contract.side_effects !== "read-only" && contract.side_effects !== "write") missing.push("side_effects")
  if (!contract.verification?.test_id.trim() || !contract.verification?.evidence_digest.trim())
    missing.push("verification_evidence")
  return missing
}

/**
 * Audit whether catalog entries are ready for a typed execution adapter.
 *
 * This deliberately checks declarations only.  It does not load a handler,
 * call a model, access a workspace, or exercise a side-effecting tool.  The
 * report gives future migration slices a stable, machine-readable checklist
 * and keeps an incomplete capability surface fail-closed.
 */
export function evaluateCapabilityExecution(
  catalog: ReadonlyArray<CatalogEntry> = CAPABILITY_CATALOG,
): CapabilityExecutionAuditReport {
  const items = catalog.map<CapabilityExecutionAuditItem>((entry) => {
    const missing = executionMissing(entry.execution)
    const status: CapabilityExecutionReadiness = !entry.enabled
      ? "disabled"
      : missing.length === 0
        ? "ready"
        : "not_ready"
    return {
      name: entry.name,
      description: entry.description,
      kind: entry.kind,
      priority: entry.priority,
      enabled: entry.enabled,
      status,
      missing_requirements: missing,
      declared_owner: entry.execution?.owner?.trim() || null,
      declared_side_effects: entry.execution?.side_effects ?? "unknown",
      declared_verification: entry.execution?.verification ?? null,
    }
  })
  const enabledCount = items.filter((item) => item.enabled).length
  const readyCount = items.filter((item) => item.status === "ready").length
  const notReadyCount = items.filter((item) => item.status === "not_ready").length
  const disabledCount = items.filter((item) => item.status === "disabled").length
  return {
    schema_version: 1,
    execution_mode: "read-only-capability-contract-audit",
    side_effects: "none",
    catalog_count: items.length,
    enabled_count: enabledCount,
    ready_count: readyCount,
    not_ready_count: notReadyCount,
    disabled_count: disabledCount,
    model_invoked: false,
    handlers_executed: 0,
    decision: enabledCount > 0 && readyCount === enabledCount ? "ready" : "fail-closed",
    items,
    caveat:
      "此报告只检查能力目录中声明的 typed execution contract；不会调用 handler、模型、shell、文件或数据库。缺少输入/输出、ActionGateway 授权、取消、evidence、settlement 或 owner 的能力继续 fail-closed。",
  }
}

export const CapabilityAnalysis = {
  test: testCapabilities,
  evaluate: evaluateCapabilityExecution,
}
