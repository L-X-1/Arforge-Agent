export * as RuntimeCompiler from "./compiler"
export * as RuntimeEmbedding from "./embedding"
export * as RuntimeStrategy from "./strategy"
export * as RuntimeVerifier from "./verifier"
export * as RuntimeInvariants from "./invariants"
export * as RuntimeRouter from "./router"
export * as RuntimeRetry from "./retry"
export * as RuntimeBilling from "./billing"
export * as RuntimeEvaluation from "./evaluation"
export * as RuntimeGolden from "./golden"
export * as RuntimeMultiAgentScheduling from "./multi-agent-scheduling"
export * as RuntimeWriteConflictControl from "./write-conflict-control"
export * as ExecutionBoundary from "./execution-boundary"
export * as RuntimeA2A from "./a2a"
export * as RuntimeA2ATransport from "./a2a-transport"
export * as RuntimeMigration from "./migration"
export * from "./sql"
export * from "./insight"
export * as ControlClaimIndex from "./control-claim-index"
export * as NativeAction from "./native-action"
export * as ExternalApiAction from "./external-api-action"
export * as MutationIntent from "./mutation-intent"
export * as RollbackArtifact from "./rollback-artifact"
export * as OpaqueArtifact from "./artifact-ref"
export * as ArtifactMaintenanceScan from "./artifact-maintenance-scan"
export * as SubagentProvider from "./subagent-provider"
export * as SubagentChildExecutor from "./subagent-child-executor"
export * as SubagentControl from "./subagent-control"
export * as SubagentControlClaim from "./subagent-control-claim"
export * as SubagentControlRecovery from "./subagent-control-recovery"
export * as ProfileMaintenanceLifecycle from "./profile-maintenance-lifecycle"
export * as AssetLocalization from "./asset-localization"
export * as AssetLocalizationAction from "./asset-localization-action"
export * as RuntimeToolExecution from "../tool/execution-state"
export * as CustomAgentAdmissionInvariant from "./custom-agent-admission-invariant"
export * as AdmissionEvidence from "./admission-evidence"
export * as ChildSettlement from "./child-settlement"
export * as ChildContract from "./child-contract"
export * as ChildSettlementAudit from "./child-settlement-audit"
export * as ChildSettlementRecovery from "./child-settlement-recovery"
export * as SettlementOutbox from "./settlement-outbox"
export * as SettlementCoordinator from "./settlement-coordinator"
export * as SettlementOwnerAdapters from "./settlement-owner-adapters"
export * as SettlementCoordinatorInvariant from "./settlement-coordinator-invariant"
export * as SettlementOutboxInvariant from "./settlement-outbox-invariant"
export * as SettlementObservation from "./settlement-observation"
export * as SettlementObservationJournal from "./settlement-observation-journal"
export * as SettlementTransactionWriters from "./settlement-transaction-writers"
export * as WorkspaceRootWriterInvariant from "../workspace-root-writer-invariant"

import { RuntimeInsight, billingStorageValues } from "./insight"
import { AuditEntryTable, SessionRunTable, SessionRunUsageTable } from "./sql"
import { desc } from "drizzle-orm"

// Structural adapter bound: this module only needs insert/select chains, and
// the host database may be Effect Drizzle or a plain SQLite client. The `any`
// parameters are deliberate to keep the boundary compatible with either.
type Db = {
  insert(table: any): {
    values(value: Record<string, unknown>): { run(): unknown }
  }
  select(): {
    from(table: any): {
      orderBy(column: any): { limit(count: number): { all(): Promise<unknown[]> | unknown[] | unknown } }
    }
  }
}

/**
 * Bridge the in-memory runtime insight to the database (best-effort).
 * Call once from a location that owns the Database service (e.g. the server
 * bootstrap). Audit persistence is append-only; run status is upserted.
 */
export function attachRuntimePersistence(db: Db): void {
  RuntimeInsight.attachPersistence({
    insertAudit: (entries) => {
      void Promise.all(
        entries.map((entry) =>
          db
            .insert(AuditEntryTable)
            .values({
              id: `audit_${entry.seq}_${entry.recordHash.slice(0, 8)}`,
              seq: entry.seq,
              recorded_at: entry.recordedAt,
              actor: entry.actor,
              action: entry.action,
              resource: entry.resource,
              reason: entry.reason ?? null,
              metadata: entry.metadata,
              ...(entry.tenantID === undefined ? {} : { tenant_id: entry.tenantID }),
              ...(entry.ownerUserID === undefined ? {} : { owner_user_id: entry.ownerUserID }),
              previous_hash: entry.previousHash,
              record_hash: entry.recordHash,
            })
            .run(),
        ),
      ).catch(() => {
        // best-effort persistence; the in-memory chain remains authoritative
      })
    },
    upsertRun: (run) => {
      void db
        .insert(SessionRunTable)
        .values({
          id: run.runID,
          session_id: run.sessionID,
          status: run.status,
          started_at: run.startedAt,
          finished_at: run.finishedAt ?? 0,
          last_seq: run.lastSeq ?? 0,
          error: run.error,
        })
        .run()
    },
    insertBilling: (record) => {
      void db.insert(SessionRunUsageTable).values(billingStorageValues(record)).run()
    },
  })
}

export async function listPersistedRuns(db: Db, limit = 50): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(SessionRunTable).orderBy(desc(SessionRunTable.started_at)).limit(limit).all()
  return rows as Array<Record<string, unknown>>
}
