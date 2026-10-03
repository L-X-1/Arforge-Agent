#!/usr/bin/env bun

/**
 * Controlled PostgreSQL settlement evidence probe.
 *
 * This is deliberately a fixture-only script. It creates random identities,
 * runs the real SettlementOwnerAdapters through Database.transactionAsPrincipal
 * and the durable SettlementOutbox service, then removes every row it owns.
 * It never enables the production settlement gate and never prints secrets or
 * provider payloads.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PgClient } from "@effect/sql-pg"
import { and, eq, inArray, sql } from "drizzle-orm"
import { DateTime, Effect, Redacted } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { loadProductEnv } from "../src/config/product-env"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { ExperienceAuditTable, ExperienceEvidenceTable } from "../src/experience-store/sql"
import * as AdmissionEvidence from "../src/runtime/admission-evidence"
import * as ChildSettlement from "../src/runtime/child-settlement"
import * as RuntimeInvariants from "../src/runtime/invariants"
import * as SettlementCoordinator from "../src/runtime/settlement-coordinator"
import * as SettlementCoordinatorInvariant from "../src/runtime/settlement-coordinator-invariant"
import * as SettlementOutbox from "../src/runtime/settlement-outbox"
import * as SettlementObservation from "../src/runtime/settlement-observation"
import * as SettlementObservationJournal from "../src/runtime/settlement-observation-journal"
import * as SettlementOwnerAdapters from "../src/runtime/settlement-owner-adapters"
import { childRunIDFor } from "../src/runtime/durable-run"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
const adminUrl = process.env.ARFORGE_DB_ADMIN_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")
if (!adminUrl) throw new Error("ARFORGE_DB_ADMIN_URL is required for fixture setup and cleanup")

const suffix = `${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
const now = Date.now()
const parseSoakIterations = (): number => {
  const raw = process.env.ARFORGE_SETTLEMENT_SOAK_ITERATIONS?.trim()
  if (raw === undefined || raw === "") return 8
  if (!/^\d+$/.test(raw)) throw new Error("ARFORGE_SETTLEMENT_SOAK_ITERATIONS must be an integer from 1 to 1024")
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024)
    throw new Error("ARFORGE_SETTLEMENT_SOAK_ITERATIONS must be an integer from 1 to 1024")
  return value
}
const soakIterations = parseSoakIterations()
const fixturePasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$DslOhTbBqO3nFXkCIMCK7puUBUgiJZRsFoiJ+L+96LM$j2MMLIvQlEimqSHb4PyWD03mD1lQh+pr2lFyBR3cv84"

const identity = {
  tenantID: `ten_settlement_pg_${suffix}`,
  userID: `usr_settlement_pg_${suffix}`,
  actor: `user:settlement-pg-${suffix}`,
} as const
const otherIdentity = {
  tenantID: `ten_settlement_pg_other_${suffix}`,
  userID: `usr_settlement_pg_other_${suffix}`,
} as const

type Check = { readonly name: string; readonly passed: true; readonly evidence: unknown }
const checks: Check[] = []
const record = (name: string, condition: boolean, evidence: unknown) => {
  if (!condition) throw new Error(`${name} failed: ${JSON.stringify(evidence)}`)
  checks.push({ name, passed: true, evidence })
}

const adminLayer = PgClient.layer({
  url: Redacted.make(adminUrl),
  applicationName: "Arforge settlement evidence fixture administrator",
  maxConnections: 1,
})

const userRows = [
  [identity.userID, `settlement-pg-${suffix}@example.invalid`, "Settlement PG owner"],
  [otherIdentity.userID, `settlement-pg-other-${suffix}@example.invalid`, "Settlement PG other owner"],
] as const
const tenantRows = [
  [identity.tenantID, `settlement-pg-${suffix}`, identity.userID, "Settlement PG tenant"],
  [otherIdentity.tenantID, `settlement-pg-other-${suffix}`, otherIdentity.userID, "Settlement PG other tenant"],
] as const

const setup = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  yield* client.withTransaction(
    Effect.gen(function* () {
      for (const [userID, email, displayName] of userRows) {
        yield* client.unsafe(
          `INSERT INTO identity_user
             (id, email, normalized_email, display_name, password_hash, status, email_verified_at,
              session_epoch, time_created, time_updated)
           VALUES ($1, $2, $2, $3, $4, 'active', $5, 0, $5, $5)`,
          [userID, email, displayName, fixturePasswordHash, now],
        )
      }
      for (const [tenantID, slug, ownerID, name] of tenantRows) {
        yield* client.unsafe(
          `INSERT INTO identity_tenant (id, name, slug, created_by_user_id, time_created, time_updated)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [tenantID, name, slug, ownerID, now],
        )
      }
      for (const [tenantID, userID] of [
        [identity.tenantID, identity.userID],
        [otherIdentity.tenantID, otherIdentity.userID],
      ] as const) {
        yield* client.unsafe(
          `INSERT INTO identity_tenant_member
             (tenant_id, user_id, role, status, time_created, time_updated)
           VALUES ($1, $2, 'owner', 'active', $3, $3)`,
          [tenantID, userID, now],
        )
      }
    }),
  )
}).pipe(Effect.provide(adminLayer))

const cleanup = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const tenantIDs = [identity.tenantID, otherIdentity.tenantID]
  const userIDs = [identity.userID, otherIdentity.userID]
  const aggregateIDs = allContracts.flatMap(({ parentRunID, childRunID }) => [parentRunID, childRunID])
  const intentIDs = allContracts.map(({ outboxPlan }) => outboxPlan.intentID)
  yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(`DELETE FROM event WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])`, [
        tenantIDs,
        userIDs,
      ])
      yield* client.unsafe(
        `DELETE FROM event_sequence WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])`,
        [tenantIDs, userIDs],
      )
      yield* client.unsafe(
        `DELETE FROM experience_audit WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])`,
        [tenantIDs, userIDs],
      )
      yield* client.unsafe(
        `DELETE FROM experience_evidence WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])`,
        [tenantIDs, userIDs],
      )
      yield* client.unsafe(
        `DELETE FROM child_settlement_recovery_outbox
         WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[]) AND intent_id = ANY($3::text[])`,
        [tenantIDs, userIDs, intentIDs],
      )
      yield* client.unsafe(`DELETE FROM identity_tenant_member WHERE user_id = ANY($1::text[])`, [userIDs])
      yield* client.unsafe(`DELETE FROM identity_tenant WHERE id = ANY($1::text[])`, [tenantIDs])
      yield* client.unsafe(`DELETE FROM identity_user WHERE id = ANY($1::text[])`, [userIDs])
    }),
  )
  const residue = yield* client.unsafe<{
    events: number
    sequences: number
    evidence: number
    audit: number
    outbox: number
    users: number
    tenants: number
  }>(
    `SELECT
       (SELECT count(*)::int FROM event WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])) AS events,
       (SELECT count(*)::int FROM event_sequence WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])) AS sequences,
       (SELECT count(*)::int FROM experience_evidence WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])) AS evidence,
       (SELECT count(*)::int FROM experience_audit WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])) AS audit,
       (SELECT count(*)::int FROM child_settlement_recovery_outbox WHERE tenant_id = ANY($1::text[]) AND owner_user_id = ANY($2::text[])) AS outbox,
       (SELECT count(*)::int FROM identity_user WHERE id = ANY($2::text[])) AS users,
       (SELECT count(*)::int FROM identity_tenant WHERE id = ANY($1::text[])) AS tenants`,
    [tenantIDs, userIDs],
  )
  return residue[0]
}).pipe(Effect.provide(adminLayer))

const admission = (): AgentRuntime.CustomAgentAdmissionEvidence => ({
  schema_version: 1,
  kind: "custom-agent-admission",
  role: "CustomAgent.PostgresSettlementProbe",
  profile_path: "profiles/postgres-settlement-probe.json",
  status: "admitted",
  decision: "admitted",
  reason: "controlled production PostgreSQL settlement evidence fixture",
  ready: true,
  descriptor_digest: "a".repeat(64),
  checks: {
    status_consistent: true,
    descriptor_digest_consistent: true,
    tool_projection_consistent: true,
    payload_free: true,
  },
  declared_tool_count: 1,
  canonical_tool_count: 1,
  unsupported_tool_count: 0,
  valid: true,
  violations: [],
})

type Contract = Readonly<{
  parentRunID: AgentRuntime.RunID
  childRunID: AgentRuntime.RunID
  plan: ChildSettlement.SettlementCommitPlan
  shared: ChildSettlement.SettlementSharedTransactionEvidence
  adapterInput: SettlementOwnerAdapters.SettlementOwnerAdapterInput
  outboxPlan: ChildSettlement.SettlementCommitPlan
}>

const makeContract = (label: string): Contract => {
  const parentRunID = AgentRuntime.RunID.make(`run_settlement_pg_${label}_${suffix}_parent`)
  const idempotencyKey = `settlement-pg-${label}-${suffix}`
  const childRunID = childRunIDFor(parentRunID, idempotencyKey)
  if (!childRunID) throw new Error("fixture child run ID could not be derived")
  const actionID = AgentRuntime.ActionID.make(`act_settlement_pg_${label}_${suffix}`)
  const observation = AgentRuntime.Observation.make({
    id: AgentRuntime.ObservationID.make(`obs_settlement_pg_${label}_${suffix}`),
    actionID,
    status: "succeeded",
    summary: `controlled PostgreSQL ${label} observation`,
    artifactIDs: [],
    observedAt: DateTime.makeUnsafe("2026-09-04T00:00:00.000Z"),
  })
  const admissionPlan = AdmissionEvidence.plan({
    identity,
    parentRunID,
    childRunID,
    idempotencyKey,
    admission: admission(),
    evidenceRefs: [],
  })
  const materialized = AdmissionEvidence.materialize({ plan: admissionPlan, actionID, observation })
  const usage = { attempts: 1, durationMs: 12, costMicros: 4, tokens: 20 }
  const resultInput = {
    status: "completed" as const,
    summary: `controlled PostgreSQL ${label} child result`,
    artifactRefs: [] as ReadonlyArray<AgentRuntime.ArtifactID>,
    evidenceRefs: [admissionPlan.evidenceID],
    usage,
  }
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result: resultInput,
    admissionEvidence: {
      evidenceID: admissionPlan.evidenceID,
      recordDigest: materialized.recordDigest,
      actionID,
      observationID: observation.id,
    },
    createdAtMs: now,
  })
  const result = AgentRuntime.ChildRunResult.make({
    ...resultInput,
    resultDigest: intent.resultDigest,
    recordedAt: DateTime.makeUnsafe("2026-09-04T00:00:00.000Z"),
  })
  const transactionID = `tx_settlement_pg_${label}_${suffix}`
  const shared = ChildSettlement.makeSettlementSharedTransactionEvidence({
    transactionKey: `settlement:${intent.intentID}`,
    transactionID,
    ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
  })
  const plan = ChildSettlement.planSettlementCommit(intent, {
    mode: "same-transaction",
    atomicDatabaseTransaction: true,
    durableRecoveryOutbox: false,
    sharedTransactionEvidence: shared,
  })
  const outboxPlan = ChildSettlement.planSettlementCommit(intent, {
    mode: "recovery-outbox",
    atomicDatabaseTransaction: false,
    durableRecoveryOutbox: true,
  })
  return {
    parentRunID,
    childRunID,
    plan,
    shared,
    outboxPlan,
    adapterInput: {
      plan,
      admission: { identity, plan: admissionPlan, actionID, observation },
      childResult: {
        eventID: EventV2.ID.create(),
        sessionID: `ses_settlement_pg_${label}_child` as AgentRuntime.SessionRun["sessionID"],
        result,
        expectedSequence: 0,
      },
      parentBudget: {
        eventID: EventV2.ID.create(),
        sessionID: `ses_settlement_pg_${label}_parent` as AgentRuntime.SessionRun["sessionID"],
        reserved: usage,
        actual: usage,
        reservedTotal: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        settledAt: result.recordedAt,
        expectedSequence: 0,
      },
    },
  }
}

const contracts = [
  makeContract("commit"),
  makeContract("rollback"),
  makeContract("outbox"),
  makeContract("coordinator-crash"),
] as const
const soakContracts = Array.from({ length: soakIterations }, (_, index) => makeContract(`coordinator-soak-${index}`))
const recoveryPromotionContract = makeContract("outbox-recovery-promotion")
const observationCrashContract = makeContract("observation-crash")
const allContracts = [...contracts, ...soakContracts, recoveryPromotionContract, observationCrashContract]

const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, SettlementOutbox.node]), [
  [Database.node, Database.layerFromPostgresUrl(appUrl)],
])

type OutboxCrashProbeResult = Readonly<{
  readonly exitCode: number
  readonly marker: Readonly<{
    readonly schemaVersion: 1
    readonly prepared: "prepared"
    readonly ownerProgress: ReadonlyArray<ChildSettlement.SettlementWrite>
    readonly intentID: string
  }>
}>

type CoordinatorCrashProbeResult = Readonly<{
  readonly exitCode: number
  readonly marker: Readonly<{
    readonly schemaVersion: 1
    readonly ownersWritten: ReadonlyArray<ChildSettlement.SettlementWrite>
    readonly transactionKey: string
    readonly transactionID: string
  }>
}>

type ObservationCrashProbeResult = Readonly<{
  readonly exitCode: number
  readonly marker: Readonly<{
    readonly schemaVersion: 1
    readonly mode: "crash"
    readonly parentRunID: string
    readonly childRunID: string
    readonly observerID: string
    readonly journalEventType: string
    readonly journalPresentOnOpenTransaction: true
  }>
}>

type ObservationCommitProbeResult = Readonly<{
  readonly exitCode: number
  readonly marker: Readonly<{
    readonly schemaVersion: 1
    readonly mode: "commit"
    readonly parentRunID: string
    readonly childRunID: string
    readonly observerID: string
    readonly journalEventType: string
    readonly journalPresentOnOpenTransaction: true
    readonly committed: true
    readonly executionDigest: string
  }>
}>

const runOutboxCrashProbe = async (contract: Contract, observedAtMs: number): Promise<OutboxCrashProbeResult> => {
  const directory = mkdtempSync(join(tmpdir(), "arforge-pg-settlement-"))
  const descriptorPath = join(directory, "descriptor.json")
  const readyMarker = join(directory, "ready.json")
  const workerPath = join(process.cwd(), "script", "postgres-settlement-outbox-crash-worker.ts")
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      identity: { tenantID: identity.tenantID, userID: identity.userID },
      plan: contract.outboxPlan,
      observedAtMs,
    }),
    "utf8",
  )
  const worker = Bun.spawn([process.execPath, workerPath, descriptorPath, readyMarker], {
    cwd: process.cwd(),
    env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let killed = false
  try {
    for (let attempt = 0; attempt < 400 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
    if (!existsSync(readyMarker)) {
      worker.kill("SIGKILL")
      killed = true
      const exitCode = await worker.exited
      const stderr = worker.stderr ? await new Response(worker.stderr).text() : ""
      throw new Error(`PostgreSQL outbox crash worker did not reach its marker (exit=${exitCode}): ${stderr}`)
    }
    const marker = JSON.parse(readFileSync(readyMarker, "utf8")) as OutboxCrashProbeResult["marker"]
    worker.kill("SIGKILL")
    killed = true
    const exitCode = await worker.exited
    return { exitCode, marker }
  } finally {
    if (!killed) worker.kill("SIGKILL")
    await worker.exited
    rmSync(directory, { recursive: true, force: true })
  }
}

type OutboxOwnerCrashProbeResult = Readonly<{
  readonly exitCode: number
  readonly marker: Readonly<{
    readonly schemaVersion: 1
    readonly ownerWritten: "admission-evidence"
    readonly auditDurable: true
    readonly intentID: string
    readonly transactionKey: string
    readonly transactionID: string
  }>
}>

/**
 * Commit one concrete owner in a child process, then kill it before the
 * metadata-only outbox promotion. The restart path must recognize the
 * durable owner/audit and advance only the missing promotion proof.
 */
const runOutboxOwnerCrashProbe = async (
  contract: Contract,
  observedAtMs: number,
): Promise<OutboxOwnerCrashProbeResult> => {
  const directory = mkdtempSync(join(tmpdir(), "arforge-pg-settlement-recovery-"))
  const descriptorPath = join(directory, "descriptor.json")
  const readyMarker = join(directory, "ready.json")
  const workerPath = join(process.cwd(), "script", "postgres-settlement-recovery-crash-worker.ts")
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      identity,
      outboxPlan: contract.outboxPlan,
      adapterInput: contract.adapterInput,
      observedAtMs,
    }),
    "utf8",
  )
  const worker = Bun.spawn([process.execPath, workerPath, descriptorPath, readyMarker], {
    cwd: process.cwd(),
    env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let killed = false
  try {
    for (let attempt = 0; attempt < 400 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
    if (!existsSync(readyMarker)) {
      worker.kill("SIGKILL")
      killed = true
      const exitCode = await worker.exited
      const stderr = worker.stderr ? await new Response(worker.stderr).text() : ""
      throw new Error(`PostgreSQL recovery owner worker did not reach its marker (exit=${exitCode}): ${stderr}`)
    }
    const marker = JSON.parse(readFileSync(readyMarker, "utf8")) as OutboxOwnerCrashProbeResult["marker"]
    worker.kill("SIGKILL")
    killed = true
    const exitCode = await worker.exited
    return { exitCode, marker }
  } finally {
    if (!killed) worker.kill("SIGKILL")
    await worker.exited
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * Kill a real coordinator while its second concrete owner is still inside the
 * same PostgreSQL transaction.  The worker receives only the immutable plan
 * and adapter binding needed by the fixture; it never receives credentials or
 * a Provider capability.
 */
const runCoordinatorCrashProbe = async (
  contract: Contract,
  observedAtMs: number,
): Promise<CoordinatorCrashProbeResult> => {
  const directory = mkdtempSync(join(tmpdir(), "arforge-pg-coordinator-"))
  const descriptorPath = join(directory, "descriptor.json")
  const readyMarker = join(directory, "ready.json")
  const workerPath = join(process.cwd(), "script", "postgres-settlement-coordinator-crash-worker.ts")
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      identity,
      plan: contract.plan,
      shared: contract.shared,
      adapterInput: contract.adapterInput,
      observedAtMs,
    }),
    "utf8",
  )
  const worker = Bun.spawn([process.execPath, workerPath, descriptorPath, readyMarker], {
    cwd: process.cwd(),
    env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let killed = false
  try {
    for (let attempt = 0; attempt < 400 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
    if (!existsSync(readyMarker)) {
      worker.kill("SIGKILL")
      killed = true
      const exitCode = await worker.exited
      const stderr = worker.stderr ? await new Response(worker.stderr).text() : ""
      throw new Error(`PostgreSQL coordinator crash worker did not reach its marker (exit=${exitCode}): ${stderr}`)
    }
    const marker = JSON.parse(readFileSync(readyMarker, "utf8")) as CoordinatorCrashProbeResult["marker"]
    worker.kill("SIGKILL")
    killed = true
    const exitCode = await worker.exited
    return { exitCode, marker }
  } finally {
    if (!killed) worker.kill("SIGKILL")
    await worker.exited
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * Exercise the observation journal itself across a PostgreSQL process
 * boundary. Crash mode kills the worker after the journal row is visible on
 * the open coordinator transaction; commit mode exits normally so a fresh
 * application layer can rebuild the row and checkpoint.
 */
const runObservationProbe = async (
  contract: Contract,
  observedAtMs: number,
  mode: "crash" | "commit",
): Promise<ObservationCrashProbeResult | ObservationCommitProbeResult> => {
  const directory = mkdtempSync(join(tmpdir(), "arforge-pg-observation-"))
  const descriptorPath = join(directory, "descriptor.json")
  const readyMarker = join(directory, "ready.json")
  const workerPath = join(process.cwd(), "script", "postgres-settlement-observation-crash-worker.ts")
  const observerID = `postgres-settlement-observation:${identity.tenantID}`
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      identity,
      plan: contract.plan,
      shared: contract.shared,
      adapterInput: contract.adapterInput,
      observedAtMs,
      parentRunID: contract.parentRunID,
      childRunID: contract.childRunID,
      sessionID: contract.adapterInput.parentBudget.sessionID,
      observerID,
      minimumSamples: 1,
    }),
    "utf8",
  )
  const worker = Bun.spawn([process.execPath, workerPath, descriptorPath, mode, readyMarker], {
    cwd: process.cwd(),
    env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let terminated = false
  try {
    for (let attempt = 0; attempt < 400 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
    if (!existsSync(readyMarker)) {
      worker.kill("SIGKILL")
      terminated = true
      const exitCode = await worker.exited
      const stderr = worker.stderr ? await new Response(worker.stderr).text() : ""
      throw new Error(`PostgreSQL observation ${mode} worker did not reach its marker (exit=${exitCode}): ${stderr}`)
    }
    const marker = JSON.parse(readFileSync(readyMarker, "utf8")) as
      | ObservationCrashProbeResult["marker"]
      | ObservationCommitProbeResult["marker"]
    if (mode === "crash") {
      worker.kill("SIGKILL")
      terminated = true
      const exitCode = await worker.exited
      return { exitCode, marker: marker as ObservationCrashProbeResult["marker"] }
    }
    const exitCode = await worker.exited
    terminated = true
    return { exitCode, marker: marker as ObservationCommitProbeResult["marker"] }
  } finally {
    if (!terminated) worker.kill("SIGKILL")
    await worker.exited
    rmSync(directory, { recursive: true, force: true })
  }
}

type ProbeRow = Readonly<{
  backendPID: number
  transactionID: string
  tenantID: string
  userID: string
}>
type TransactionWithExecute = {
  execute: (query: unknown) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
}

const readProbe = (transaction: Database.Transaction): Effect.Effect<ProbeRow, Error> =>
  (transaction as unknown as TransactionWithExecute)
    .execute(
      sql`SELECT pg_backend_pid()::int AS backend_pid,
               txid_current()::text AS transaction_id,
               current_setting('arforge.tenant_id', true) AS tenant_id,
               current_setting('arforge.user_id', true) AS user_id`,
    )
    .pipe(
      Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      Effect.flatMap((rows) => {
        const row = rows[0]
        const backendPID = Number(row?.backend_pid)
        const transactionID = String(row?.transaction_id ?? "")
        const tenantID = String(row?.tenant_id ?? "")
        const userID = String(row?.user_id ?? "")
        if (!Number.isSafeInteger(backendPID) || backendPID < 1 || transactionID.length === 0)
          return Effect.fail(new Error("PostgreSQL transaction probe returned an invalid backend/transaction identity"))
        return Effect.succeed({ backendPID, transactionID, tenantID, userID })
      }),
    )

const instrument =
  (
    owner: ChildSettlement.SettlementWrite,
    writer: SettlementCoordinator.SettlementOwnerWriter,
    probes: Array<ProbeRow & { readonly owner: ChildSettlement.SettlementWrite }>,
  ): SettlementCoordinator.SettlementOwnerWriter =>
  (transaction, scope) =>
    Effect.gen(function* () {
      const before = yield* readProbe(transaction)
      if (before.tenantID !== identity.tenantID || before.userID !== identity.userID)
        return yield* Effect.fail(new Error(`PostgreSQL principal drifted before ${owner}`))
      const receipt = yield* writer(transaction, scope)
      const after = yield* readProbe(transaction)
      if (
        before.backendPID !== after.backendPID ||
        before.transactionID !== after.transactionID ||
        after.tenantID !== identity.tenantID ||
        after.userID !== identity.userID
      )
        return yield* Effect.fail(new Error(`PostgreSQL physical transaction/principal drifted during ${owner}`))
      probes.push({ owner, ...after })
      return receipt
    })

const seedAggregates = (database: Database.Interface, contract: Contract) =>
  database.transactionAsPrincipal(identity, (transaction) =>
    Effect.gen(function* () {
      yield* transaction
        .insert(EventSequenceTable)
        .values([
          {
            tenant_id: identity.tenantID,
            owner_user_id: identity.userID,
            aggregate_id: contract.childRunID,
            seq: 0,
            owner_id: identity.userID,
          },
          {
            tenant_id: identity.tenantID,
            owner_user_id: identity.userID,
            aggregate_id: contract.parentRunID,
            seq: 0,
            owner_id: identity.userID,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* transaction
        .insert(EventTable)
        .values([
          {
            tenant_id: identity.tenantID,
            owner_user_id: identity.userID,
            id: EventV2.ID.create(),
            aggregate_id: contract.childRunID,
            seq: 0,
            type: "fixture.seed.1",
            data: { fixture: true },
          },
          {
            tenant_id: identity.tenantID,
            owner_user_id: identity.userID,
            id: EventV2.ID.create(),
            aggregate_id: contract.parentRunID,
            seq: 0,
            type: "fixture.seed.1",
            data: { fixture: true },
          },
        ])
        .run()
        .pipe(Effect.orDie)
    }),
  )

const settlementRows = (
  database: Database.Interface,
  contract: Contract,
): Effect.Effect<Readonly<{ evidence: number; audit: number; events: number }>, never> =>
  Effect.gen(function* () {
    const evidence = yield* database
      .runAsPrincipal(
        identity,
        database.db
          .select({ id: ExperienceEvidenceTable.id })
          .from(ExperienceEvidenceTable)
          .where(
            and(
              eq(ExperienceEvidenceTable.tenant_id, identity.tenantID),
              eq(ExperienceEvidenceTable.owner_user_id, identity.userID),
              eq(ExperienceEvidenceTable.run_id, contract.childRunID),
            ),
          )
          .all(),
      )
      .pipe(Effect.orDie)
    const audit = yield* database
      .runAsPrincipal(
        identity,
        database.db
          .select({ aggregateID: ExperienceAuditTable.aggregate_id })
          .from(ExperienceAuditTable)
          .where(
            and(
              eq(ExperienceAuditTable.tenant_id, identity.tenantID),
              eq(ExperienceAuditTable.owner_user_id, identity.userID),
              eq(ExperienceAuditTable.aggregate_id, String(contract.adapterInput.admission.plan.evidenceID)),
            ),
          )
          .all(),
      )
      .pipe(Effect.orDie)
    const events = yield* database
      .runAsPrincipal(
        identity,
        database.db
          .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.tenant_id, identity.tenantID),
              eq(EventTable.owner_user_id, identity.userID),
              inArray(EventTable.aggregate_id, [contract.childRunID, contract.parentRunID]),
              eq(EventTable.seq, 1),
            ),
          )
          .all(),
      )
      .pipe(Effect.orDie)
    return { evidence: evidence.length, audit: audit.length, events: events.length }
  })

const observationRows = (database: Database.Interface, contract: Contract): Effect.Effect<number, never> =>
  database
    .runAsPrincipal(
      identity,
      database.db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.tenant_id, identity.tenantID),
            eq(EventTable.owner_user_id, identity.userID),
            eq(EventTable.aggregate_id, contract.parentRunID),
            eq(EventTable.type, SettlementObservationJournal.type),
          ),
        )
        .all(),
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

const commitRecoveryOwner = (
  database: Database.Interface,
  contract: Contract,
  owner: "child-result" | "parent-budget",
  observedAtMs: number,
) => {
  const writers = SettlementOwnerAdapters.createSettlementOwnerWriters(contract.adapterInput)
  const scope: SettlementCoordinator.SettlementOwnerTransactionScope = Object.freeze({
    owner,
    transactionKey: contract.outboxPlan.transactionKey,
    transactionID: `tx_recovery_owner_${owner}_${observedAtMs}_${contract.outboxPlan.intentID.slice(-24)}`,
    providerExecutionAllowed: false,
  })
  return database.transactionAsPrincipal(identity, (transaction) =>
    writers[owner](transaction, scope).pipe(Effect.asVoid),
  )
}

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const probes: Array<ProbeRow & { readonly owner: ChildSettlement.SettlementWrite }> = []
  const contract = contracts[0]
  yield* seedAggregates(database, contract)
  const baseWriters = SettlementOwnerAdapters.createSettlementOwnerWriters(contract.adapterInput)
  const writers: SettlementCoordinator.SettlementOwnerWriters = {
    "admission-evidence": instrument("admission-evidence", baseWriters["admission-evidence"], probes),
    "child-result": instrument("child-result", baseWriters["child-result"], probes),
    "parent-budget": instrument("parent-budget", baseWriters["parent-budget"], probes),
  }
  const execution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
    database,
    plan: contract.plan,
    sharedTransactionEvidence: contract.shared,
    writers,
    principal: identity,
    observedAtMs: now,
  })
  SettlementCoordinator.assertSettlementTransactionExecution(execution, {
    plan: contract.plan,
    sharedTransactionEvidence: contract.shared,
  })
  const invariantRegistry = RuntimeInvariants.createRuntimeInvariantRegistry()
  const invariant = yield* SettlementCoordinatorInvariant.inspect(invariantRegistry, {
    kind: "execution",
    execution,
    plan: contract.plan,
    sharedTransactionEvidence: contract.shared,
  })
  record("real PostgreSQL coordinator execution receipt passes runtime invariant", invariant.passedAll, {
    resultCount: invariant.results.length,
  })
  const physicalIDs = new Set(probes.map((probe) => `${probe.backendPID}:${probe.transactionID}`))
  record("all three concrete owners used one PostgreSQL backend transaction", physicalIDs.size === 1, {
    ownerCount: probes.length,
    physicalIDs: [...physicalIDs],
    ownerOrder: probes.map((probe) => probe.owner),
  })
  record(
    "PostgreSQL transaction principal remained tenant/user bound",
    probes.length === 3 &&
      probes.every((probe) => probe.tenantID === identity.tenantID && probe.userID === identity.userID),
    { owners: probes.map(({ owner, tenantID, userID }) => ({ owner, tenantID, userID })) },
  )

  const evidenceRows = yield* database.runAsPrincipal(
    identity,
    database.db
      .select({ id: ExperienceEvidenceTable.id })
      .from(ExperienceEvidenceTable)
      .where(
        and(
          eq(ExperienceEvidenceTable.tenant_id, identity.tenantID),
          eq(ExperienceEvidenceTable.owner_user_id, identity.userID),
          eq(ExperienceEvidenceTable.run_id, contract.childRunID),
        ),
      )
      .all(),
  )
  const auditRows = yield* database.runAsPrincipal(
    identity,
    database.db
      .select({ aggregateID: ExperienceAuditTable.aggregate_id })
      .from(ExperienceAuditTable)
      .where(
        and(
          eq(ExperienceAuditTable.tenant_id, identity.tenantID),
          eq(ExperienceAuditTable.owner_user_id, identity.userID),
          eq(ExperienceAuditTable.aggregate_id, String(contract.adapterInput.admission.plan.evidenceID)),
        ),
      )
      .all(),
  )
  const eventRows = yield* database.runAsPrincipal(
    identity,
    database.db
      .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.tenant_id, identity.tenantID),
          eq(EventTable.owner_user_id, identity.userID),
          inArray(EventTable.aggregate_id, [contract.childRunID, contract.parentRunID]),
          eq(EventTable.seq, 1),
        ),
      )
      .all(),
  )
  record(
    "real PostgreSQL coordinator committed concrete owner rows",
    evidenceRows.length === 1 && auditRows.length === 1 && eventRows.length === 2,
    {
      evidence: evidenceRows.length,
      audit: auditRows.length,
      events: eventRows.length,
    },
  )

  const rollbackContract = contracts[1]
  yield* seedAggregates(database, rollbackContract)
  const rollbackWriters = SettlementOwnerAdapters.createSettlementOwnerWriters({
    ...rollbackContract.adapterInput,
    parentBudget: { ...rollbackContract.adapterInput.parentBudget, expectedSequence: 9 },
  })
  const failed = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
    database,
    plan: rollbackContract.plan,
    sharedTransactionEvidence: rollbackContract.shared,
    writers: rollbackWriters,
    principal: identity,
    observedAtMs: now + 1,
  }).pipe(Effect.exit)
  record("later concrete owner failure rolls back the full PostgreSQL transaction", failed._tag === "Failure", {
    failure: failed._tag,
  })
  const rollbackEvidence = yield* database.runAsPrincipal(
    identity,
    database.db
      .select({ id: ExperienceEvidenceTable.id })
      .from(ExperienceEvidenceTable)
      .where(
        and(
          eq(ExperienceEvidenceTable.tenant_id, identity.tenantID),
          eq(ExperienceEvidenceTable.owner_user_id, identity.userID),
          eq(ExperienceEvidenceTable.run_id, rollbackContract.childRunID),
        ),
      )
      .all(),
  )
  const rollbackEvents = yield* database.runAsPrincipal(
    identity,
    database.db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.tenant_id, identity.tenantID),
          eq(EventTable.owner_user_id, identity.userID),
          inArray(EventTable.aggregate_id, [rollbackContract.childRunID, rollbackContract.parentRunID]),
          eq(EventTable.seq, 1),
        ),
      )
      .all(),
  )
  record(
    "PostgreSQL rollback leaves no partial Evidence or events",
    rollbackEvidence.length === 0 && rollbackEvents.length === 0,
    {
      evidence: rollbackEvidence.length,
      events: rollbackEvents.length,
    },
  )

  const crashContract = contracts[3]
  yield* seedAggregates(database, crashContract)
  const crashProbe = yield* Effect.promise(() => runCoordinatorCrashProbe(crashContract, now + 5))
  // PostgreSQL releases the killed worker's connection before Bun reports the
  // child exit, but a short bounded retry keeps this fixture deterministic on
  // a busy local server without masking a real residual row.
  let afterCrash = yield* settlementRows(database, crashContract)
  for (
    let attempt = 0;
    attempt < 20 && (afterCrash.evidence > 0 || afterCrash.audit > 0 || afterCrash.events > 0);
    attempt += 1
  ) {
    yield* Effect.promise(() => Bun.sleep(25))
    afterCrash = yield* settlementRows(database, crashContract)
  }
  record(
    "coordinator SIGKILL rolls back in-flight concrete owner writes and audit",
    crashProbe.exitCode !== 0 &&
      JSON.stringify(crashProbe.marker.ownersWritten) === JSON.stringify(["admission-evidence", "child-result"]) &&
      afterCrash.evidence === 0 &&
      afterCrash.audit === 0 &&
      afterCrash.events === 0,
    {
      workerExitCode: crashProbe.exitCode,
      ownersWritten: crashProbe.marker.ownersWritten,
      afterCrash,
    },
  )
  const recoveredWriters = SettlementOwnerAdapters.createSettlementOwnerWriters(crashContract.adapterInput)
  const recoveredExecution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
    database,
    plan: crashContract.plan,
    sharedTransactionEvidence: crashContract.shared,
    writers: recoveredWriters,
    principal: identity,
    observedAtMs: now + 6,
  })
  SettlementCoordinator.assertSettlementTransactionExecution(recoveredExecution, {
    plan: crashContract.plan,
    sharedTransactionEvidence: crashContract.shared,
  })
  const recoveredRows = yield* settlementRows(database, crashContract)
  record(
    "fresh coordinator restart commits the exact owner set and audit after SIGKILL",
    recoveredExecution.providerExecutionAllowed === false &&
      recoveredRows.evidence === 1 &&
      recoveredRows.audit === 1 &&
      recoveredRows.events === 2,
    {
      transactionID: recoveredExecution.transactionID,
      providerExecutionAllowed: recoveredExecution.providerExecutionAllowed,
      recoveredRows,
    },
  )

  const observationCrash = observationCrashContract
  const observationCrashID = `postgres-settlement-observation:${identity.tenantID}`
  yield* seedAggregates(database, observationCrash)
  const observationCrashProbe = yield* Effect.promise(() => runObservationProbe(observationCrash, now + 20, "crash"))
  let observationAfterCrash = yield* observationRows(database, observationCrash)
  let settlementAfterObservationCrash = yield* settlementRows(database, observationCrash)
  for (
    let attempt = 0;
    attempt < 20 &&
    (observationAfterCrash > 0 ||
      settlementAfterObservationCrash.evidence > 0 ||
      settlementAfterObservationCrash.audit > 0 ||
      settlementAfterObservationCrash.events > 0);
    attempt += 1
  ) {
    yield* Effect.promise(() => Bun.sleep(25))
    observationAfterCrash = yield* observationRows(database, observationCrash)
    settlementAfterObservationCrash = yield* settlementRows(database, observationCrash)
  }
  record(
    "observation journal SIGKILL rolls back PostgreSQL owners and the parent event",
    observationCrashProbe.exitCode !== 0 &&
      observationCrashProbe.marker.journalPresentOnOpenTransaction === true &&
      observationAfterCrash === 0 &&
      settlementAfterObservationCrash.evidence === 0 &&
      settlementAfterObservationCrash.audit === 0 &&
      settlementAfterObservationCrash.events === 0,
    {
      workerExitCode: observationCrashProbe.exitCode,
      journalPresentOnOpenTransaction: observationCrashProbe.marker.journalPresentOnOpenTransaction,
      observationEventsAfterCrash: observationAfterCrash,
      settlementAfterCrash: settlementAfterObservationCrash,
    },
  )

  const observationCommitProbe = yield* Effect.promise(() => runObservationProbe(observationCrash, now + 21, "commit"))
  const observationCommitMarker = observationCommitProbe.marker as ObservationCommitProbeResult["marker"]
  const observationAfterCommit = yield* observationRows(database, observationCrash)
  const settlementAfterObservationCommit = yield* settlementRows(database, observationCrash)
  const restoredObservation = yield* database.runAsPrincipal(
    identity,
    SettlementObservationJournal.load(database.db, {
      parentRunID: observationCrash.parentRunID,
      observerID: observationCrashID,
      minimumSamples: 1,
    }),
  )
  record(
    "fresh PostgreSQL process commits and rebuilds the observation checkpoint",
    observationCommitProbe.exitCode === 0 &&
      observationCommitMarker.committed === true &&
      observationAfterCommit === 1 &&
      settlementAfterObservationCommit.evidence === 1 &&
      settlementAfterObservationCommit.audit === 1 &&
      settlementAfterObservationCommit.events === 2 &&
      restoredObservation?.window.sampleCount === 1 &&
      restoredObservation.window.promotionAuthorized === false,
    {
      workerExitCode: observationCommitProbe.exitCode,
      observationEventsAfterCommit: observationAfterCommit,
      settlementAfterCommit: settlementAfterObservationCommit,
      sampleCount: restoredObservation?.window.sampleCount,
      checkpointDigest: restoredObservation?.checkpointDigest,
      promotionAuthorized: restoredObservation?.window.promotionAuthorized,
      providerExecutionAllowed: false,
    },
  )

  const soakResults: Array<
    Readonly<{
      readonly transactionID: string
      readonly rows: Readonly<{ evidence: number; audit: number; events: number }>
      readonly observationEvents: number
      readonly ownerOrder: ReadonlyArray<ChildSettlement.SettlementWrite>
      readonly executionDigest: string
    }>
  > = []
  let observationCheckpoint: SettlementObservation.SettlementObservationCheckpoint | undefined
  const observationID = `postgres-settlement-soak:${identity.tenantID}`
  for (const [index, soakContract] of soakContracts.entries()) {
    yield* seedAggregates(database, soakContract)
    const soakExecution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
      database,
      plan: soakContract.plan,
      sharedTransactionEvidence: soakContract.shared,
      writers: SettlementOwnerAdapters.createSettlementOwnerWriters(soakContract.adapterInput),
      principal: identity,
      beforeCommit: ({ transaction, execution }) =>
        SettlementObservationJournal.appendInTransaction({
          transaction,
          parentRunID: soakContract.parentRunID,
          sessionID: soakContract.adapterInput.parentBudget.sessionID,
          childRunID: soakContract.childRunID,
          observerID: observationID,
          execution,
          plan: soakContract.plan,
          sharedTransactionEvidence: soakContract.shared,
          minimumSamples: soakIterations,
        }).pipe(Effect.asVoid),
      observedAtMs: now + 100 + index,
    })
    SettlementCoordinator.assertSettlementTransactionExecution(soakExecution, {
      plan: soakContract.plan,
      sharedTransactionEvidence: soakContract.shared,
    })
    const observationSample = SettlementObservation.observationFromExecution({
      execution: soakExecution,
      plan: soakContract.plan,
      sharedTransactionEvidence: soakContract.shared,
    })
    const checkpointInput =
      observationCheckpoint === undefined
        ? { observerID: observationID, sample: observationSample, minimumSamples: soakIterations }
        : {
            observerID: observationID,
            checkpoint: observationCheckpoint,
            sample: observationSample,
            minimumSamples: soakIterations,
          }
    observationCheckpoint = SettlementObservation.appendSettlementObservationCheckpoint(checkpointInput)
    // Exercise the restart-safe, payload-free checkpoint boundary at bounded points.
    if (index === 0 || index % 8 === 0 || index === soakContracts.length - 1) {
      observationCheckpoint = JSON.parse(
        JSON.stringify(observationCheckpoint),
      ) as SettlementObservation.SettlementObservationCheckpoint
      SettlementObservation.assertSettlementObservationCheckpoint(observationCheckpoint)
    }
    const observationEvents = yield* database
      .runAsPrincipal(
        identity,
        database.db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.tenant_id, identity.tenantID),
              eq(EventTable.owner_user_id, identity.userID),
              eq(EventTable.aggregate_id, soakContract.parentRunID),
              eq(EventTable.type, SettlementObservationJournal.type),
            ),
          )
          .all(),
      )
      .pipe(Effect.orDie)
    soakResults.push({
      transactionID: soakExecution.transactionID,
      rows: yield* settlementRows(database, soakContract),
      observationEvents: observationEvents.length,
      ownerOrder: soakExecution.ownerOrder,
      executionDigest: soakExecution.executionDigest,
    })
  }
  if (observationCheckpoint === undefined) throw new Error("settlement observation checkpoint was not created")
  SettlementObservation.assertSettlementObservationCheckpoint(observationCheckpoint)
  const observationWindow = SettlementObservation.resumeSettlementObservationCheckpoint(observationCheckpoint)
  SettlementObservation.assertSettlementObservationWindow(observationWindow)
  record(
    "bounded PostgreSQL coordinator soak produces a review-only observation window",
    soakResults.length === soakContracts.length &&
      observationWindow.status === "ready-for-review" &&
      observationWindow.reviewOnly === true &&
      observationWindow.promotionAuthorized === false &&
      observationWindow.allOwnerOrderStable === true &&
      observationWindow.allProviderFenced === true &&
      soakResults.every(
        (result) =>
          result.rows.evidence === 1 &&
          result.rows.audit === 1 &&
          result.rows.events === 2 &&
          result.observationEvents === 1 &&
          JSON.stringify(result.ownerOrder) === JSON.stringify(observationWindow.ownerOrder),
      ),
    {
      iterations: soakResults.length,
      successful: soakResults.filter(
        (result) =>
          result.rows.evidence === 1 &&
          result.rows.audit === 1 &&
          result.rows.events === 2 &&
          result.observationEvents === 1,
      ).length,
      observationEvents: soakResults.reduce((count, result) => count + result.observationEvents, 0),
      observationStatus: observationWindow.status,
      observationWindowDigest: observationWindow.windowDigest,
      observationCheckpointDigest: observationCheckpoint.checkpointDigest,
      observationID: observationCheckpoint.observerID,
      ownerOrder: observationWindow.ownerOrder,
      providerExecutionAllowed: false,
    },
  )

  const outbox = yield* SettlementOutbox.Service
  const outboxContract = contracts[2]
  const outboxInput = { identity, plan: outboxContract.outboxPlan, observedAtMs: now + 10 } as const
  const outboxCrashProbe = yield* Effect.promise(() => runOutboxCrashProbe(outboxContract, now + 10))
  const crashPrepared = yield* outbox.read({ identity, intentID: outboxContract.outboxPlan.intentID })
  const recovery = yield* outbox.markRecoveryRequired({
    ...outboxInput,
    reason: "controlled PostgreSQL owner interruption",
    observedAtMs: now + 12,
  })
  const reopened = yield* outbox.prepare({ ...outboxInput, observedAtMs: now + 13 })
  yield* outbox.promoteOwner({
    ...outboxInput,
    owner: "child-result",
    ownerDigest: outboxContract.outboxPlan.expectedDigests.childResult,
    observedAtMs: now + 14,
  })
  yield* outbox.promoteOwner({
    ...outboxInput,
    owner: "parent-budget",
    ownerDigest: outboxContract.outboxPlan.expectedDigests.parentBudget,
    observedAtMs: now + 15,
  })
  const outboxCommitted = yield* outbox.commitPromoted({ ...outboxInput, observedAtMs: now + 16 })
  const otherPrepared = yield* outbox.prepare({
    identity: otherIdentity,
    plan: outboxContract.outboxPlan,
    observedAtMs: now + 20,
  })
  const ownRead = yield* outbox.read({ identity, intentID: outboxContract.outboxPlan.intentID })
  const otherRead = yield* outbox.read({ identity: otherIdentity, intentID: outboxContract.outboxPlan.intentID })
  record(
    "cross-process SIGKILL preserves PostgreSQL outbox prefix and recovery reaches commit",
    outboxCrashProbe.exitCode !== 0 &&
      outboxCrashProbe.marker.prepared === "prepared" &&
      JSON.stringify(outboxCrashProbe.marker.ownerProgress) === JSON.stringify(["admission-evidence"]) &&
      crashPrepared?.status === "prepared" &&
      crashPrepared.ownerProgress?.completed.length === 1 &&
      recovery.record.status === "recovery-required" &&
      reopened.record.status === "prepared" &&
      outboxCommitted.record.status === "committed" &&
      outboxCommitted.record.ownerProgress?.completed.length === 3,
    {
      workerExitCode: outboxCrashProbe.exitCode,
      workerPrefix: outboxCrashProbe.marker.ownerProgress,
      prefixAfterCrash: crashPrepared?.ownerProgress?.completed,
      recovery: recovery.record.status,
      reopened: reopened.record.status,
      committed: outboxCommitted.record.status,
    },
  )
  record(
    "PostgreSQL outbox rows remain isolated by tenant and owner",
    otherPrepared.record.status === "prepared" && ownRead?.status === "committed" && otherRead?.status === "prepared",
    {
      ownStatus: ownRead?.status,
      otherStatus: otherRead?.status,
    },
  )

  const recoveryContract = recoveryPromotionContract
  yield* seedAggregates(database, recoveryContract)
  const recoveryCrashProbe = yield* Effect.promise(() => runOutboxOwnerCrashProbe(recoveryContract, now + 30))
  const recoveryPrepared = yield* outbox.read({
    identity,
    intentID: recoveryContract.outboxPlan.intentID,
  })
  const rowsAfterOwnerCrash = yield* settlementRows(database, recoveryContract)
  record(
    "cross-process recovery crash preserves concrete Evidence/audit before outbox promotion",
    recoveryCrashProbe.exitCode !== 0 &&
      recoveryCrashProbe.marker.ownerWritten === "admission-evidence" &&
      recoveryCrashProbe.marker.auditDurable === true &&
      recoveryPrepared?.status === "prepared" &&
      (recoveryPrepared.ownerProgress?.completed.length ?? 0) === 0 &&
      rowsAfterOwnerCrash.evidence === 1 &&
      rowsAfterOwnerCrash.audit === 1 &&
      rowsAfterOwnerCrash.events === 0,
    {
      workerExitCode: recoveryCrashProbe.exitCode,
      ownerWritten: recoveryCrashProbe.marker.ownerWritten,
      auditDurable: recoveryCrashProbe.marker.auditDurable,
      outboxStatus: recoveryPrepared?.status,
      promotedBeforeCrash: recoveryPrepared?.ownerProgress?.completed ?? [],
      rowsAfterOwnerCrash,
    },
  )

  const recoveryInput = {
    identity,
    plan: recoveryContract.outboxPlan,
    observedAtMs: now + 31,
  } as const
  const evidencePromoted = yield* outbox.promoteOwner({
    ...recoveryInput,
    owner: "admission-evidence",
    ownerDigest: recoveryContract.outboxPlan.expectedDigests.evidence!,
    observedAtMs: now + 32,
  })
  yield* commitRecoveryOwner(database, recoveryContract, "child-result", now + 33)
  const childPromoted = yield* outbox.promoteOwner({
    ...recoveryInput,
    owner: "child-result",
    ownerDigest: recoveryContract.outboxPlan.expectedDigests.childResult,
    observedAtMs: now + 34,
  })
  yield* commitRecoveryOwner(database, recoveryContract, "parent-budget", now + 35)
  const budgetPromoted = yield* outbox.promoteOwner({
    ...recoveryInput,
    owner: "parent-budget",
    ownerDigest: recoveryContract.outboxPlan.expectedDigests.parentBudget,
    observedAtMs: now + 36,
  })
  const recoveryCommitted = yield* outbox.commitPromoted({ ...recoveryInput, observedAtMs: now + 37 })
  const recoveryPromotionRows = yield* settlementRows(database, recoveryContract)
  record(
    "restart promotes only missing concrete owners and commits the recovery receipt",
    evidencePromoted.record.ownerProgress?.completed.join(",") === "admission-evidence" &&
      childPromoted.record.ownerProgress?.completed.join(",") === "admission-evidence,child-result" &&
      budgetPromoted.record.ownerProgress?.completed.join(",") === "admission-evidence,child-result,parent-budget" &&
      recoveryCommitted.record.status === "committed" &&
      recoveryPromotionRows.evidence === 1 &&
      recoveryPromotionRows.audit === 1 &&
      recoveryPromotionRows.events === 2,
    {
      ownerProgress: recoveryCommitted.record.ownerProgress?.completed ?? [],
      status: recoveryCommitted.record.status,
      recoveredRows: recoveryPromotionRows,
      providerExecutionAllowed: false,
    },
  )

  return {
    schemaVersion: 1,
    database: new URL(appUrl).pathname.replace(/^\//, ""),
    applicationRole: "arforge_app",
    passed: true,
    checkCount: checks.length,
    checks,
    fixturePrefix: `settlement_pg_*_${suffix}`,
    secretsPrinted: false,
    execution: {
      transactionID: execution.transactionID,
      ownerCount: execution.ownerReceipts.length,
      providerExecutionAllowed: execution.providerExecutionAllowed,
    },
    settlementObservation: {
      schemaVersion: observationWindow.schemaVersion,
      sampleCount: observationWindow.sampleCount,
      minimumSamples: observationWindow.minimumSamples,
      status: observationWindow.status,
      reviewOnly: observationWindow.reviewOnly,
      promotionAuthorized: observationWindow.promotionAuthorized,
      allOwnerOrderStable: observationWindow.allOwnerOrderStable,
      allProviderFenced: observationWindow.allProviderFenced,
      windowDigest: observationWindow.windowDigest,
      observerID: observationCheckpoint.observerID,
      checkpointDigest: observationCheckpoint.checkpointDigest,
    },
    recoveryPromotion: {
      intentID: recoveryCommitted.record.intentID,
      ownerCount: recoveryCommitted.record.ownerProgress?.completed.length ?? 0,
      providerExecutionAllowed: false,
    },
    cleanupVerified: true,
  }
}).pipe(Effect.provide(runtimeLayer))

type Residue = Readonly<{
  events: number
  sequences: number
  evidence: number
  audit: number
  outbox: number
  users: number
  tenants: number
}>

let failure: unknown
let fixturesMayExist = false
let residue: Residue | undefined
try {
  fixturesMayExist = true
  await Effect.runPromise(setup)
  const result = await Effect.runPromise(program.pipe(Effect.scoped))
  try {
    residue = await Effect.runPromise(cleanup)
  } catch (error) {
    throw new Error("PostgreSQL settlement fixture cleanup failed", { cause: error })
  }
  if (!residue || Object.values(residue).some((value) => value !== 0))
    throw new Error(`PostgreSQL settlement fixture cleanup left residue: ${JSON.stringify(residue)}`)
  console.log(JSON.stringify({ ...result, residue }, null, 2))
} catch (error) {
  failure = error
  try {
    if (fixturesMayExist) {
      residue = await Effect.runPromise(cleanup)
      if (!residue || Object.values(residue).some((value) => value !== 0))
        throw new Error(`PostgreSQL settlement fixture cleanup left residue: ${JSON.stringify(residue)}`)
    }
  } catch (cleanupError) {
    throw new Error("PostgreSQL settlement fixture cleanup failed", { cause: cleanupError })
  }
}
if (failure) throw failure
