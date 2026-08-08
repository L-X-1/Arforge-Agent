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

export interface ContextLayerReport {
  readonly layer: string
  readonly name: string
  readonly source: string
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
  readonly previousHash: string
  readonly recordHash: string
}

export interface RunRecord {
  readonly runID: string
  readonly sessionID: string
  readonly status: "running" | "idle" | "interrupted" | "failed" | "completed"
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly lastSeq: number | null
  readonly error: string | null
}

export interface MemoryRecallHit {
  readonly memoryID: string
  readonly content: string
  readonly score: number
  readonly source: string
}

export interface MemoryRecallRecord {
  readonly timestamp: number
  readonly sessionID: string
  readonly query: string
  readonly algorithm: string
  readonly hits: ReadonlyArray<MemoryRecallHit>
}

export interface PersistenceAdapter {
  readonly insertAudit?: (entries: ReadonlyArray<AuditEntry>) => Promise<void> | void
  readonly upsertRun?: (run: RunRecord) => Promise<void> | void
}

const MAX_CONTEXT_LAYERS = 120
const MAX_ROUTING = 200
const MAX_VERIFICATIONS = 100
const MAX_AUDIT_MEMORY = 1000
const MAX_RUNS = 100
const MAX_MEMORY_RECALLS = 100

class InsightStore {
  contextLayers: ContextLayersReport[] = []
  routing: RoutingDecision[] = []
  verifications: VerificationRecord[] = []
  audit: AuditEntry[] = []
  runs = new Map<string, RunRecord>()
  recalls: MemoryRecallRecord[] = []
  adapter: PersistenceAdapter | undefined
  nextAuditSeq = 1
  headHash = "genesis"
  /** Hash of the newest entry that was pruned from the in-memory chain. */
  chainAnchor = "genesis"
  auditDropped = 0
}

const store = new InsightStore()

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
  }): AuditEntry {
    const event = {
      seq: store.nextAuditSeq,
      recordedAt: Date.now(),
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      reason: input.reason,
      metadata: input.metadata ?? {},
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
    return record
  },

  auditList(limit = 100, beforeSequence?: number): { entries: ReadonlyArray<AuditEntry>; dropped: number } {
    const entries =
      beforeSequence === undefined
        ? store.audit
        : store.audit.filter((entry) => entry.seq < beforeSequence)
    return { entries: entries.slice(-limit).reverse(), dropped: store.auditDropped }
  },

  auditVerify(): { valid: boolean; count: number; headHash: string; issue: string | null } {
    let previous = store.chainAnchor
    let index = 0
    for (const entry of store.audit) {
      if (entry.previousHash !== previous)
        return { valid: false, count: store.audit.length, headHash: store.headHash, issue: `chain break at seq ${entry.seq}` }
      const expected = digest({
        seq: entry.seq,
        recordedAt: entry.recordedAt,
        actor: entry.actor,
        action: entry.action,
        resource: entry.resource,
        reason: entry.reason,
        metadata: entry.metadata,
        previousHash: entry.previousHash,
      })
      if (expected !== entry.recordHash)
        return { valid: false, count: store.audit.length, headHash: store.headHash, issue: `hash mismatch at seq ${entry.seq}` }
      previous = entry.recordHash
      index += 1
    }
    return { valid: true, count: index, headHash: store.headHash, issue: null }
  },

  runBegin(sessionID: string, runID: string): RunRecord {
    const run: RunRecord = {
      runID,
      sessionID,
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

  runs(limit = 50): ReadonlyArray<RunRecord> {
    return [...store.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
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
      headHash: store.headHash,
    }
  },

  /** Test-only hook: direct access to the in-memory store. */
  __storeForTesting(): InsightStore {
    return store
  },
}
