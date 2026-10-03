/**
 * Runtime Insight — process-scoped, best-effort observability for the running
 * runtime: context compilation layers, routing decisions, verifier reports,
 * an append-only hash-chained audit log, and durable run status.
 *
 * This is intentionally a plain singleton (not an Effect service): callers in
 * the runner, tool registry, and verifier can record facts without layer
 * wiring. `attachPersistence` bridges the in-memory log to the database.
 */

import { createHash } from "node:crypto"
import { Billing } from "@arforge-ai/schema/billing"
import { redact } from "../redact"
import { sanitizeForStorage } from "../analysis/runs"
import type { ContextContract } from "../context-contract"

export interface ContextLayerReport {
  readonly layer: string
  readonly name: string
  readonly source: string
  readonly unitID: string
  readonly origin: ContextContract.Origin
  readonly contextLayer: ContextContract.ContextLayer
  readonly authority: ContextContract.Authority
  readonly trust: ContextContract.Trust
  readonly mandatory: boolean
  readonly priority: number
  readonly sourceDigest?: string
  readonly instructionAllowed?: boolean
  readonly tokens: number
  readonly chars: number
  readonly kept: boolean
}

export interface ContextLayersReport {
  readonly sessionID: string
  readonly timestamp: number
  readonly model: string
  readonly totalTokens: number
  readonly layers: ReadonlyArray<ContextLayerReport>
}

export interface RoutingCandidate {
  readonly providerID: string
  readonly modelID: string
  readonly inputCost: number
  readonly outputCost: number
}

export interface RoutingDecision {
  readonly timestamp: number
  readonly sessionID: string
  readonly task: string
  readonly providerID: string
  readonly modelID: string
  readonly inputCost: number
  readonly outputCost: number
  readonly reason: string
  readonly candidates: ReadonlyArray<RoutingCandidate>
}

export interface VerificationCheckResult {
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly outputTail: string
}

export interface VerificationRecord {
  readonly timestamp: number
  readonly runID?: string
  readonly traceID?: string
  readonly actionID?: string
  readonly sessionID: string
  readonly toolCallID: string
  readonly claim: string
  readonly commands: ReadonlyArray<string>
  readonly results: ReadonlyArray<VerificationCheckResult>
  readonly passed: boolean
  readonly durationMs: number
}

export interface AuditEntry {
  readonly seq: number
  readonly recordedAt: number
  readonly actor: string
  readonly action: string
  readonly resource: string
  readonly reason: string | undefined
  readonly metadata: Readonly<Record<string, unknown>>
  /** Optional tenant ownership used when a request-scoped audit is persisted. */
  readonly tenantID?: string
  /** Optional owner identity used when a request-scoped audit is persisted. */
  readonly ownerUserID?: string
  readonly previousHash: string
  readonly recordHash: string
}

export interface RunRecord {
  readonly runID: string
  readonly sessionID: string
  readonly traceID: string
  readonly status: "running" | "idle" | "interrupted" | "failed" | "completed"
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly lastSeq: number | null
  readonly error: string | null
}

/** Shared projection for the existing usage table; persistence policy belongs to the caller. */
export const billingStorageValues = (record: BillingRecord) => ({
  id: record.billingID,
  run_id: record.runID,
  session_id: record.sessionID,
  provider_id: record.providerID,
  model_id: record.modelID,
  usage_source: record.usage.source,
  estimator_id: record.usage.estimatorID ?? null,
  unknown_input: record.usage.tokens.unknownInput,
  image_input: record.usage.tokens.imageInput,
  audio_input: record.usage.tokens.audioInput,
  cache_read_input: record.usage.tokens.cacheReadInput,
  cache_write_input: record.usage.tokens.cacheWriteInput,
  text_output: record.usage.tokens.textOutput,
  reasoning_output: record.usage.tokens.reasoningOutput,
  audio_output: record.usage.tokens.audioOutput,
  price_catalog_revision: record.charge?.priceCatalogRevision ?? null,
  currency: record.charge?.currency ?? record.settlement?.state.currency ?? null,
  amount_minor: record.charge?.amountMinor ?? record.settlement?.actualMinor ?? null,
  unpriced_categories: record.charge?.unpricedCategories ?? [],
  settlement_reservation_id: record.settlement?.reservationID ?? null,
  over_budget: record.settlement?.overBudget ?? false,
  recorded_at: record.recordedAt,
})

export interface BillingRecord {
  readonly billingID: string
  readonly runID: string
  readonly sessionID: string
  readonly providerID: string
  readonly modelID: string
  readonly recordedAt: number
  readonly usage: Billing.TokenUsage
  readonly charge?: Billing.Charge
  readonly settlement?: Billing.Settlement
}

export interface MetricRecord {
  readonly name: string
  readonly value: number
  readonly unit: "count" | "milliseconds" | "tokens" | "minor-units"
  readonly recordedAt: number
  readonly attributes: Readonly<Record<string, unknown>>
}

export interface ModelCallRecord {
  readonly runID: string
  readonly sessionID: string
  readonly traceID: string
  readonly actionID?: string
  readonly providerID: string
  readonly modelID: string
  readonly requestDigest: string
  readonly mode: "primary" | "retry" | "fallback"
  readonly attempt: number
  readonly status: "succeeded" | "failed" | "interrupted"
  readonly category: string
  readonly outputStarted: boolean
  readonly toolCallStarted: boolean
  readonly startedAt: number
  readonly finishedAt: number
  readonly durationMs: number
}

export interface MemoryRecallHit {
  readonly memoryID: string
  readonly score: number
  readonly source: string
}

export interface MemoryRecallRecord {
  readonly timestamp: number
  readonly sessionID: string
  readonly scopeHash: string
  readonly queryFingerprint: string
  readonly algorithm: string
  readonly algorithmRevision: string
  readonly latencyMs: number
  readonly hits: ReadonlyArray<MemoryRecallHit>
}

export interface PersistenceAdapter {
  readonly insertAudit?: (entries: ReadonlyArray<AuditEntry>) => Promise<void> | void
  readonly upsertRun?: (run: RunRecord) => Promise<void> | void
  readonly insertBilling?: (record: BillingRecord) => Promise<void> | void
}

const MAX_CONTEXT_LAYERS = 120
const MAX_ROUTING = 200
const MAX_VERIFICATIONS = 100
const MAX_AUDIT_MEMORY = 1000
const MAX_RUNS = 100
const MAX_MEMORY_RECALLS = 100
const MAX_BILLING = 500
const MAX_METRICS = 1000
const MAX_MODEL_CALLS = 500

class InsightStore {
  contextLayers: ContextLayersReport[] = []
  routing: RoutingDecision[] = []
  verifications: VerificationRecord[] = []
  audit: AuditEntry[] = []
  runs = new Map<string, RunRecord>()
  recalls: MemoryRecallRecord[] = []
  billing: BillingRecord[] = []
  metrics: MetricRecord[] = []
  modelCalls: ModelCallRecord[] = []
  adapter: PersistenceAdapter | undefined
  nextAuditSeq = 1
  headHash = "genesis"
  /** Hash of the newest entry that was pruned from the in-memory chain. */
  chainAnchor = "genesis"
  auditDropped = 0
}

const store = new InsightStore()

const recordMetric = (input: Omit<MetricRecord, "recordedAt"> & { readonly recordedAt?: number }): MetricRecord => {
  const record: MetricRecord = {
    ...input,
    recordedAt: input.recordedAt ?? Date.now(),
    attributes: sanitizeForStorage(input.attributes) as Readonly<Record<string, unknown>>,
  }
  store.metrics.push(record)
  if (store.metrics.length > MAX_METRICS) store.metrics.shift()
  return record
}

const recordModelCall = (input: Omit<ModelCallRecord, "durationMs"> & { readonly durationMs?: number }) => {
  const record: ModelCallRecord = {
    ...input,
    durationMs: Math.max(0, Math.trunc(input.durationMs ?? input.finishedAt - input.startedAt)),
  }
  store.modelCalls.push(record)
  if (store.modelCalls.length > MAX_MODEL_CALLS) store.modelCalls.shift()
  return record
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

export const RuntimeInsight = {
  reset(): void {
    store.contextLayers = []
    store.routing = []
    store.verifications = []
    store.audit = []
    store.runs.clear()
    store.recalls = []
    store.billing = []
    store.metrics = []
    store.modelCalls = []
    store.nextAuditSeq = 1
    store.headHash = "genesis"
    store.chainAnchor = "genesis"
    store.auditDropped = 0
  },

  attachPersistence(adapter: PersistenceAdapter): void {
    store.adapter = adapter
  },

  recordContextLayers(report: ContextLayersReport): void {
    store.contextLayers.push(report)
    if (store.contextLayers.length > MAX_CONTEXT_LAYERS) store.contextLayers.shift()
  },

  contextLayers(limit = 20): ReadonlyArray<ContextLayersReport> {
    return store.contextLayers.slice(-limit).reverse()
  },

  recordRoutingDecision(decision: RoutingDecision): void {
    store.routing.push(decision)
    if (store.routing.length > MAX_ROUTING) store.routing.shift()
  },

  routingDecisions(limit = 50): ReadonlyArray<RoutingDecision> {
    return store.routing.slice(-limit).reverse()
  },

  recordVerification(record: VerificationRecord): void {
    store.verifications.push(record)
    if (store.verifications.length > MAX_VERIFICATIONS) store.verifications.shift()
    recordMetric({
      name: "verification.result",
      value: record.passed ? 1 : 0,
      unit: "count",
      attributes: {
        ...(record.runID ? { runID: record.runID } : {}),
        ...(record.traceID ? { traceID: record.traceID } : {}),
        ...(record.actionID ? { actionID: record.actionID } : {}),
        sessionID: record.sessionID,
        toolCallID: record.toolCallID,
        passed: record.passed,
      },
    })
  },

  verifications(limit = 50): ReadonlyArray<VerificationRecord> {
    return store.verifications.slice(-limit).reverse()
  },

  auditRecord(input: {
    readonly actor: string
    readonly action: string
    readonly resource: string
    readonly reason?: string
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly tenantID?: string
    readonly ownerUserID?: string
  }): AuditEntry {
    const event = {
      seq: store.nextAuditSeq,
      recordedAt: Date.now(),
      actor: input.actor,
      action: input.action,
      resource: redact(input.resource),
      reason: input.reason === undefined ? undefined : redact(input.reason),
      metadata: sanitizeForStorage(input.metadata ?? {}) as Readonly<Record<string, unknown>>,
      ...(input.tenantID === undefined ? {} : { tenantID: input.tenantID }),
      ...(input.ownerUserID === undefined ? {} : { ownerUserID: input.ownerUserID }),
      previousHash: store.headHash,
    }
    const record: AuditEntry = { ...event, recordHash: digest(event) }
    store.nextAuditSeq += 1
    store.headHash = record.recordHash
    store.audit.push(record)
    if (store.audit.length > MAX_AUDIT_MEMORY) {
      const pruned = store.audit.shift()
      if (pruned) store.chainAnchor = pruned.recordHash
      store.auditDropped += 1
    }
    if (store.adapter?.insertAudit) {
      void Promise.resolve(store.adapter.insertAudit([record])).catch(() => {
        // best-effort persistence; the in-memory chain remains authoritative
      })
    }
    const metricName = input.action.startsWith("action.authorization.")
      ? "approval.event"
      : input.action.includes("recovery") || input.action.includes("resumed")
        ? "runtime.recovery"
        : undefined
    if (metricName) {
      recordMetric({
        name: metricName,
        value: 1,
        unit: "count",
        attributes: { action: input.action, actor: input.actor, resource: event.resource },
      })
    }
    return record
  },

  auditList(limit = 100, beforeSequence?: number): { entries: ReadonlyArray<AuditEntry>; dropped: number } {
    const entries =
      beforeSequence === undefined ? store.audit : store.audit.filter((entry) => entry.seq < beforeSequence)
    return { entries: entries.slice(-limit).reverse(), dropped: store.auditDropped }
  },

  auditVerify(): { valid: boolean; count: number; headHash: string; issue: string | null } {
    let previous = store.chainAnchor
    let index = 0
    for (const entry of store.audit) {
      if (entry.previousHash !== previous)
        return {
          valid: false,
          count: store.audit.length,
          headHash: store.headHash,
          issue: `chain break at seq ${entry.seq}`,
        }
      const expected = digest({
        seq: entry.seq,
        recordedAt: entry.recordedAt,
        actor: entry.actor,
        action: entry.action,
        resource: entry.resource,
        reason: entry.reason,
        metadata: entry.metadata,
        ...(entry.tenantID === undefined ? {} : { tenantID: entry.tenantID }),
        ...(entry.ownerUserID === undefined ? {} : { ownerUserID: entry.ownerUserID }),
        previousHash: entry.previousHash,
      })
      if (expected !== entry.recordHash)
        return {
          valid: false,
          count: store.audit.length,
          headHash: store.headHash,
          issue: `hash mismatch at seq ${entry.seq}`,
        }
      previous = entry.recordHash
      index += 1
    }
    return { valid: true, count: index, headHash: store.headHash, issue: null }
  },

  runBegin(sessionID: string, runID: string, options?: { readonly traceID?: string }): RunRecord {
    const run: RunRecord = {
      runID,
      sessionID,
      traceID: options?.traceID ?? runID,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      lastSeq: null,
      error: null,
    }
    store.runs.set(runID, run)
    if (store.runs.size > MAX_RUNS) {
      const oldest = [...store.runs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0]
      if (oldest) store.runs.delete(oldest[0])
    }
    return run
  },

  runFinish(runID: string, status: RunRecord["status"], options?: { error?: string; lastSeq?: number }): void {
    const current = store.runs.get(runID)
    if (!current) return
    const updated: RunRecord = {
      ...current,
      status,
      finishedAt: Date.now(),
      lastSeq: options?.lastSeq ?? current.lastSeq,
      error: options?.error ?? current.error,
    }
    store.runs.set(runID, updated)
    if (store.adapter?.upsertRun) {
      void Promise.resolve(store.adapter.upsertRun(updated)).catch(() => {
        // best-effort persistence
      })
    }
  },

  runTouch(runID: string, lastSeq: number): void {
    const current = store.runs.get(runID)
    if (!current || current.status !== "running") return
    store.runs.set(runID, { ...current, lastSeq })
  },

  recordBilling(
    input: Omit<BillingRecord, "recordedAt"> & { readonly recordedAt?: number },
    options?: { readonly persist?: boolean },
  ): BillingRecord {
    const record: BillingRecord = {
      ...input,
      recordedAt: input.recordedAt ?? Date.now(),
      usage: Billing.TokenUsage.make({
        source: input.usage.source,
        estimatorID: input.usage.estimatorID,
        tokens: { ...input.usage.tokens },
      }),
      ...(input.charge === undefined
        ? {}
        : {
            charge: Billing.Charge.make({
              ...input.charge,
              tokens: { ...input.charge.tokens },
              unpricedCategories: [...input.charge.unpricedCategories],
            }),
          }),
      ...(input.settlement === undefined
        ? {}
        : {
            settlement: Billing.Settlement.make({
              ...input.settlement,
              state: Billing.BudgetState.make({
                ...input.settlement.state,
                activeReservationIDs: [...input.settlement.state.activeReservationIDs],
              }),
            }),
          }),
    }
    store.billing.push(record)
    if (store.billing.length > MAX_BILLING) store.billing.shift()
    if (options?.persist !== false && store.adapter?.insertBilling) {
      void Promise.resolve(store.adapter.insertBilling(record)).catch(() => {
        // best-effort persistence; the in-memory usage record remains authoritative
      })
    }
    const tokens = Object.values(record.usage.tokens).reduce((total, value) => total + value, 0)
    recordMetric({
      name: "llm.tokens",
      value: tokens,
      unit: "tokens",
      attributes: {
        runID: record.runID,
        sessionID: record.sessionID,
        providerID: record.providerID,
        modelID: record.modelID,
        source: record.usage.source,
      },
    })
    if (record.charge) {
      recordMetric({
        name: "llm.cost",
        value: record.charge.amountMinor,
        unit: "minor-units",
        attributes: {
          runID: record.runID,
          sessionID: record.sessionID,
          providerID: record.providerID,
          modelID: record.modelID,
          currency: record.charge.currency,
          priceCatalogRevision: record.charge.priceCatalogRevision,
        },
      })
    }
    return record
  },

  billing(limit = 100): ReadonlyArray<BillingRecord> {
    return store.billing.slice(-limit).reverse()
  },

  recordMetric,

  metrics(limit = 200): ReadonlyArray<MetricRecord> {
    return store.metrics.slice(-limit).reverse()
  },

  recordModelCall,

  modelCalls(limit = 100): ReadonlyArray<ModelCallRecord> {
    return store.modelCalls.slice(-limit).reverse()
  },

  runs(limit = 50): ReadonlyArray<RunRecord> {
    return [...store.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  },

  recordMemoryRecall(record: MemoryRecallRecord): void {
    store.recalls.push({
      ...record,
      hits: record.hits.map((hit) => ({ ...hit })),
    })
    if (store.recalls.length > MAX_MEMORY_RECALLS) store.recalls.shift()
  },

  memoryRecalls(limit = 20): ReadonlyArray<MemoryRecallRecord> {
    return store.recalls.slice(-limit).reverse()
  },

  snapshot(): Record<string, unknown> {
    return {
      contextLayers: store.contextLayers.length,
      routing: store.routing.length,
      verifications: store.verifications.length,
      audit: store.audit.length,
      auditDropped: store.auditDropped,
      runs: store.runs.size,
      recalls: store.recalls.length,
      billing: store.billing.length,
      metrics: store.metrics.length,
      modelCalls: store.modelCalls.length,
      headHash: store.headHash,
    }
  },

  /** Test-only hook: direct access to the in-memory store. */
  __storeForTesting(): InsightStore {
    return store
  },
}
