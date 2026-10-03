/**
 * Deterministic settlement recovery coordinator.
 *
 * This is deliberately a very small orchestration seam.  DurableRun and
 * ExperienceStore remain the owners of their aggregates; this module only
 * consumes the read-only audit report and invokes their existing idempotent
 * writes in the declared order.  It never executes a provider, creates a
 * second result state machine, or treats a failed write as permission to
 * retry external work.
 */

import { Context, Effect, Exit, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { makeLocationNode } from "../effect/app-node"
import { ExperienceStoreV1, type TrustedExperienceIdentity } from "../experience-store"
import * as AdmissionEvidence from "./admission-evidence"
import * as ChildSettlement from "./child-settlement"
import * as ChildSettlementAudit from "./child-settlement-audit"
import { DurableRun } from "./durable-run"
import { assertSettlementRecoveryInvariant } from "./invariants"
import { canonicalHash } from "../util/canonical-hash"
import * as SettlementOutbox from "./settlement-outbox"

export const RECOVERY_OUTBOX_SCHEMA_VERSION = 1 as const

type RecoveryOwnerState = "not-required" | "missing" | "present" | "conflict"

export interface RecoveryOutboxReceipt {
  readonly schemaVersion: typeof RECOVERY_OUTBOX_SCHEMA_VERSION
  readonly intentID: string
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly ownerStates: Readonly<{
    readonly evidence: RecoveryOwnerState
    readonly childResult: RecoveryOwnerState
    readonly parentBudget: RecoveryOwnerState
  }>
  /** Digests only; no Evidence/child-result payload is retained. */
  readonly ownerDigests: Readonly<{
    readonly evidence?: string
    readonly childResult?: string
    readonly parentBudget?: string
  }>
  readonly next: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly missing: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly conflicts: ReadonlyArray<string>
  readonly complete: boolean
  readonly decisionDigest: string
  readonly observedAtMs: number
}

const outboxDigest = (
  receipt: Pick<
    RecoveryOutboxReceipt,
    | "schemaVersion"
    | "intentID"
    | "parentRunID"
    | "childRunID"
    | "ownerStates"
    | "ownerDigests"
    | "next"
    | "missing"
    | "conflicts"
    | "complete"
  >,
) =>
  canonicalHash({
    domain: "arforge/child-settlement-recovery-outbox/v1",
    schemaVersion: receipt.schemaVersion,
    intentID: receipt.intentID,
    parentRunID: receipt.parentRunID,
    childRunID: receipt.childRunID,
    ownerStates: receipt.ownerStates,
    ownerDigests: receipt.ownerDigests,
    next: [...receipt.next],
    missing: [...receipt.missing],
    conflicts: [...receipt.conflicts],
    complete: receipt.complete,
  })

/**
 * Materialize a payload-free outbox receipt from one audit report.  The
 * semantic digest excludes observation time so two workers produce the same
 * identity for the same durable facts and decision.
 */
export const recoveryOutboxReceipt = (
  report: ChildSettlementAudit.SettlementAuditReport,
  observedAtMs: number,
): RecoveryOutboxReceipt | undefined => {
  if (report.intentID === undefined || report.facts === undefined || report.decision === undefined) return undefined
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new SettlementRecoveryError("Outbox observation time is invalid.")
  assertSettlementRecoveryInvariant(report.decision)
  const ownerStates = Object.freeze({
    evidence: report.facts.evidence.state,
    childResult: report.facts.childResult.state,
    parentBudget: report.facts.parentBudget.state,
  })
  const ownerDigests = Object.freeze({
    ...(report.facts.evidence.state === "present" ? { evidence: report.facts.evidence.digest } : {}),
    ...(report.facts.childResult.state === "present" ? { childResult: report.facts.childResult.digest } : {}),
    ...(report.facts.parentBudget.state === "present" ? { parentBudget: report.facts.parentBudget.digest } : {}),
  })
  const semantic = {
    schemaVersion: RECOVERY_OUTBOX_SCHEMA_VERSION,
    intentID: report.intentID,
    parentRunID: report.parentRunID,
    childRunID: report.childRunID,
    ownerStates,
    ownerDigests,
    next: report.decision.next,
    missing: report.decision.missing,
    conflicts: report.decision.conflicts,
    complete: report.decision.complete,
  } as const
  const decisionDigest = outboxDigest(semantic)
  if (decisionDigest === undefined) throw new SettlementRecoveryError("Outbox facts are not canonically hashable.")
  return Object.freeze({ ...semantic, decisionDigest, observedAtMs })
}

/** Validate a recovered receipt before it can drive owner writes. */
export const assertRecoveryOutboxReceipt = (value: RecoveryOutboxReceipt): void => {
  if (value === null || typeof value !== "object" || value.schemaVersion !== RECOVERY_OUTBOX_SCHEMA_VERSION)
    throw new SettlementRecoveryError("Recovery outbox receipt schema is invalid.")
  if (!/^stl_[a-f0-9]{64}$/i.test(value.intentID))
    throw new SettlementRecoveryError("Recovery outbox intent identity is invalid.")
  if (
    !/^run_[A-Za-z0-9._:-]{1,255}$/.test(String(value.parentRunID)) ||
    !/^run_[A-Za-z0-9._:-]{1,255}$/.test(String(value.childRunID))
  )
    throw new SettlementRecoveryError("Recovery outbox run identity is invalid.")
  if (!Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0)
    throw new SettlementRecoveryError("Recovery outbox observation time is invalid.")
  if (
    value.ownerStates === null ||
    typeof value.ownerStates !== "object" ||
    value.ownerDigests === null ||
    typeof value.ownerDigests !== "object"
  )
    throw new SettlementRecoveryError("Recovery outbox owner projection is invalid.")
  const ownerNames = ["evidence", "childResult", "parentBudget"] as const
  for (const owner of ownerNames) {
    const state = value.ownerStates[owner]
    if (!(state === "not-required" || state === "missing" || state === "present" || state === "conflict"))
      throw new SettlementRecoveryError(`Recovery outbox ${owner} state is invalid.`)
    const digest = value.ownerDigests[owner]
    if (state === "present") {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest))
        throw new SettlementRecoveryError(`Recovery outbox ${owner} digest is missing.`)
    } else if (digest !== undefined) {
      throw new SettlementRecoveryError(`Recovery outbox ${owner} carries a digest without a present owner.`)
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(value.decisionDigest))
    throw new SettlementRecoveryError("Recovery outbox decision digest is invalid.")
  assertSettlementRecoveryInvariant({
    deterministic: true,
    providerExecutionAllowed: false,
    next: value.next,
    missing: value.missing,
    conflicts: value.conflicts,
    complete: value.complete,
  })
  const expected = outboxDigest(value)
  if (expected === undefined || expected !== value.decisionDigest)
    throw new SettlementRecoveryError("Recovery outbox decision digest drifted.")
}

export interface SettlementRecoveryInput {
  readonly identity: TrustedExperienceIdentity
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
}

/**
 * Bounded owner-scoped recovery discovery. The sweep reads only metadata from
 * SettlementOutbox and delegates every item to this same recovery owner; it
 * never accepts provider payloads or creates a second settlement state
 * machine. Committed receipts are intentionally excluded because they are
 * already acknowledged and require no automatic replay.
 */
export interface SettlementRecoverySweepInput {
  readonly identity: TrustedExperienceIdentity
  readonly status?: Extract<SettlementOutbox.SettlementOutboxStatus, "prepared" | "recovery-required">
  readonly limit?: number
}

export type SettlementRecoverySweepOutcome = "committed" | "pending" | "recovery-required" | "failed"

export interface SettlementRecoverySweepItem {
  readonly intentID: string
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sourceStatus: Extract<SettlementOutbox.SettlementOutboxStatus, "prepared" | "recovery-required">
  readonly afterStatus?: SettlementOutbox.SettlementOutboxStatus
  readonly outcome: SettlementRecoverySweepOutcome
  readonly attempted: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly repaired: ReadonlyArray<ChildSettlement.SettlementWrite>
  /** Bounded, metadata-only operator-facing reason. */
  readonly reason: string
}

export interface SettlementRecoverySweepReport {
  readonly schemaVersion: 1
  readonly identity: SettlementOutbox.SettlementOutboxIdentity
  readonly status?: Extract<SettlementOutbox.SettlementOutboxStatus, "prepared" | "recovery-required">
  readonly limit: number
  readonly scanned: number
  readonly committed: number
  readonly pending: number
  readonly recoveryRequired: number
  readonly failed: number
  /** True when the bounded page may have left more pending receipts. */
  readonly hasMore: boolean
  readonly items: ReadonlyArray<SettlementRecoverySweepItem>
  readonly deterministic: true
  readonly providerExecutionAllowed: false
}

export interface SettlementRecoveryReport {
  readonly before: ChildSettlementAudit.SettlementAuditReport
  readonly after: ChildSettlementAudit.SettlementAuditReport
  readonly attempted: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly repaired: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly deterministic: true
  readonly providerExecutionAllowed: false
  readonly reason: string
}

export class SettlementRecoveryError extends Error {
  readonly _tag = "Runtime.ChildSettlementRecoveryError"

  constructor(readonly reason: string) {
    super(reason)
    this.name = this._tag
  }
}

export interface Interface {
  readonly recover: (input: SettlementRecoveryInput) => Effect.Effect<SettlementRecoveryReport, Error>
  /** Discover and recover a bounded owner-scoped page of pending receipts. */
  readonly recoverPending: (input: SettlementRecoverySweepInput) => Effect.Effect<SettlementRecoverySweepReport, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ChildSettlementRecovery") {}

const ready = (report: ChildSettlementAudit.SettlementAuditReport, write: ChildSettlement.SettlementWrite) => {
  const component =
    write === "admission-evidence"
      ? report.facts?.evidence
      : write === "child-result"
        ? report.facts?.childResult
        : report.facts?.parentBudget
  return component?.state === "present" || component?.state === "not-required"
}

const MAX_SWEEP_LIMIT = 1_000

const normalizeSweepLimit = (limit: number | undefined): number => {
  const value = limit ?? 100
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SWEEP_LIMIT)
    throw new SettlementRecoveryError("Settlement recovery sweep limit must be an integer between 1 and 1000.")
  return value
}

const normalizeSweepStatus = (
  status: SettlementRecoverySweepInput["status"],
): SettlementRecoverySweepInput["status"] => {
  if (status === undefined || status === "prepared" || status === "recovery-required") return status
  throw new SettlementRecoveryError("Settlement recovery sweep status is invalid.")
}

const boundedSweepReason = (reason: string): string => reason.replace(/\u0000/g, " ").slice(0, 512)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const audit = yield* ChildSettlementAudit.Service
    const runs = yield* DurableRun.Service
    const experience = yield* ExperienceStoreV1.Service
    const outbox = yield* SettlementOutbox.Service

    const recover: Interface["recover"] = Effect.fn("ChildSettlementRecovery.recover")(function* (input) {
      const before = yield* audit.inspect(input)
      const attempted: ChildSettlement.SettlementWrite[] = []
      const repaired: ChildSettlement.SettlementWrite[] = []

      const report = (after: ChildSettlementAudit.SettlementAuditReport, reason: string): SettlementRecoveryReport =>
        Object.freeze({
          before,
          after,
          attempted: Object.freeze([...attempted]),
          repaired: Object.freeze([...repaired]),
          deterministic: true as const,
          providerExecutionAllowed: false as const,
          reason,
        })

      // A complete audit does not imply that the recovery receipt was
      // acknowledged.  A process can die after DurableRun/ExperienceStore
      // committed every owner and before SettlementOutbox.commitPromoted()
      // returned.  In that window the next process must still finalize the
      // exact metadata-only receipt; returning early would strand a prepared
      // row forever.  Manual-review and missing-intent reports remain
      // fail-closed and never create an intent or outbox row.
      if ((before.status !== "repairable" && before.status !== "complete") || before.decision === undefined)
        return report(before, before.reason)
      assertSettlementRecoveryInvariant(before.decision)

      const intent = yield* runs.readChildSettlementIntent({
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
      })
      if (intent === undefined) return report(before, "Settlement intent disappeared; manual review is required.")

      let commitPlan: ChildSettlement.SettlementCommitPlan
      try {
        // Recovery must reuse the same owner-bound contract as the future
        // writer. The current cross-owner path is explicitly outbox based;
        // this does not claim that ExperienceStore and DurableRun share one
        // SQL transaction yet.
        commitPlan = ChildSettlement.planSettlementCommit(intent, {
          mode: "recovery-outbox",
          atomicDatabaseTransaction: false,
          durableRecoveryOutbox: true,
        })
      } catch {
        return report(before, "Settlement commit plan cannot be reproduced; manual review is required.")
      }
      const expectedMissing = commitPlan.ownerOrder.filter((write) => before.decision!.next.includes(write))
      if (JSON.stringify(expectedMissing) !== JSON.stringify(before.decision.next))
        return report(
          before,
          "Settlement owner order drifted from the immutable commit plan; manual review is required.",
        )

      const outboxInput = {
        identity: input.identity,
        plan: commitPlan,
        observedAtMs: Date.now(),
      } as const
      const ownerDigest = (owner: ChildSettlement.SettlementWrite): string | undefined =>
        owner === "admission-evidence"
          ? commitPlan.expectedDigests.evidence
          : owner === "child-result"
            ? commitPlan.expectedDigests.childResult
            : commitPlan.expectedDigests.parentBudget
      const prepared = yield* outbox.prepare(outboxInput).pipe(Effect.exit)
      if (prepared._tag === "Failure")
        return report(before, "Settlement recovery receipt could not be prepared; manual review is required.")
      if (prepared.value.record.status === "committed") {
        if (
          before.status === "complete" &&
          prepared.value.record.ownerProgress?.completed.length === commitPlan.ownerOrder.length
        )
          return report(before, "Settlement recovery receipt was already acknowledged; no provider execution occurred.")
        return report(
          before,
          "Settlement recovery receipt is committed but durable owner promotion proof is incomplete; manual review is required.",
        )
      }
      if (prepared.value.record.status !== "prepared")
        return report(before, "Settlement recovery receipt is not prepared; manual review is required.")
      const promotedOwners = new Set<ChildSettlement.SettlementWrite>(
        prepared.value.record.ownerProgress?.completed ?? [],
      )

      /**
       * Persist a bounded failure marker without masking the audit result.
       * This is best-effort because the database may be the failing
       * dependency, but a failed promotion/ack must remain discoverable when
       * it is available.
       */
      const failClosed = (reason: string, after: ChildSettlementAudit.SettlementAuditReport = before) =>
        outbox.markRecoveryRequired({ ...outboxInput, reason }).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
          Effect.as(report(after, reason)),
        )

      // Finalize an already-complete audit before entering the owner-repair
      // path below.  No owner payload is replayed here: all facts are already
      // durable, so this branch only records the ordered promotion proof and
      // acknowledges the recovery outbox.  An old committed row without a
      // promotion prefix is deliberately rejected instead of inventing proof.
      if (before.status === "complete") {
        for (const owner of commitPlan.ownerOrder) {
          if (!ready(before, owner))
            return yield* failClosed(
              `Settlement recovery reports complete but ${owner} is not ready; manual review is required.`,
            )
          if (promotedOwners.has(owner)) continue
          const digest = ownerDigest(owner)
          if (digest === undefined) return yield* failClosed(`Settlement owner digest is unavailable for ${owner}.`)
          const promoted = yield* outbox
            .promoteOwner({
              ...outboxInput,
              owner,
              ownerDigest: digest,
              observedAtMs: Date.now(),
            })
            .pipe(Effect.exit)
          if (promoted._tag === "Failure")
            return yield* failClosed("Settlement owners are complete but promotion proof could not be persisted.")
          promotedOwners.add(owner)
        }
        const committed = yield* outbox.commitPromoted({ ...outboxInput, observedAtMs: Date.now() }).pipe(Effect.exit)
        if (committed._tag === "Failure")
          return yield* failClosed("Settlement owners are complete but recovery receipt commit failed.")
        if (committed.value.record.status !== "committed")
          return yield* failClosed("Settlement recovery receipt did not reach committed state.")
        return report(before, "Settlement recovery receipt finalized after owner commit without provider execution.")
      }

      // Promote only the contiguous prefix already proven by the audit. This
      // makes a restart between owner writes observable and resumable without
      // replaying any provider or storing an owner payload in the outbox.
      for (const owner of commitPlan.ownerOrder) {
        if (!ready(before, owner)) break
        const digest = ownerDigest(owner)
        if (digest === undefined) return yield* failClosed(`Settlement owner digest is unavailable for ${owner}.`)
        const promoted = yield* outbox
          .promoteOwner({
            ...outboxInput,
            owner,
            ownerDigest: digest,
            observedAtMs: Date.now(),
          })
          .pipe(Effect.exit)
        if (promoted._tag === "Failure")
          return yield* failClosed(
            `Settlement ${owner} promotion proof could not be persisted; manual review is required.`,
          )
        promotedOwners.add(owner)
      }

      // The audit decision is already ordered by the pure settlement contract.
      // Evidence is therefore repaired before asking DurableRun to replay the
      // child-result and parent-budget owners.
      if (commitPlan.ownerOrder.includes("admission-evidence") && before.decision.next.includes("admission-evidence")) {
        attempted.push("admission-evidence")
        const receipt = intent.admissionEvidence
        const child = yield* runs.load(input.childRunID)
        const binding = "child" in child.run ? child.run.child : undefined
        if (receipt === undefined || receipt.actionID === undefined || binding?.runtimeAdmission === undefined) {
          return yield* failClosed(
            "Admission Evidence lacks a replayable action or immutable runtime receipt; manual review is required.",
          )
        }

        let plan: AdmissionEvidence.Plan
        try {
          plan = AdmissionEvidence.plan({
            identity: input.identity,
            parentRunID: input.parentRunID,
            childRunID: input.childRunID,
            idempotencyKey: intent.idempotencyKey,
            admission: binding.runtimeAdmission.evidence,
            evidenceRefs: binding.runtimeAdmission.evidenceRefs,
          })
        } catch (cause) {
          return yield* failClosed(`Admission Evidence plan is not reproducible: ${String(cause)}`)
        }
        if (String(plan.evidenceID) !== String(receipt.evidenceID))
          return yield* failClosed(
            "Admission Evidence ID diverges from the immutable settlement intent; manual review is required.",
          )

        const written = yield* experience
          .recordAdmissionEvidence({
            identity: input.identity,
            parentRunID: input.parentRunID,
            childRunID: input.childRunID,
            idempotencyKey: intent.idempotencyKey,
            admission: binding.runtimeAdmission.evidence,
            evidenceRefs: binding.runtimeAdmission.evidenceRefs,
            actionID: receipt.actionID,
          })
          .pipe(Effect.exit)
        if (written._tag === "Failure") {
          const after = yield* audit.inspect(input).pipe(Effect.orElseSucceed(() => before))
          return yield* failClosed("Admission Evidence owner rejected recovery; manual review is required.", after)
        }
        if (
          String(written.value.evidenceID) !== String(receipt.evidenceID) ||
          written.value.recordDigest.toLowerCase() !== receipt.recordDigest.toLowerCase() ||
          (receipt.observationID !== undefined && String(written.value.observationID) !== String(receipt.observationID))
        ) {
          const after = yield* audit.inspect(input).pipe(Effect.orElseSucceed(() => before))
          return yield* failClosed(
            "Admission Evidence owner returned a divergent immutable receipt; manual review is required.",
            after,
          )
        }
        repaired.push("admission-evidence")
        const promoted = yield* outbox
          .promoteOwner({
            ...outboxInput,
            owner: "admission-evidence",
            ownerDigest: commitPlan.expectedDigests.evidence!,
            observedAtMs: Date.now(),
          })
          .pipe(Effect.exit)
        if (promoted._tag === "Failure")
          return yield* failClosed("Admission Evidence converged but its promotion proof could not be persisted.")
        promotedOwners.add("admission-evidence")
      }

      const durableWrites = commitPlan.ownerOrder
        .filter(
          (write): write is "child-result" | "parent-budget" => write === "child-result" || write === "parent-budget",
        )
        .filter((write) => before.decision!.next.includes(write))
      if (durableWrites.length > 0) {
        attempted.push(...durableWrites)
        const recovered = yield* runs.recoverChildren({ parentRunID: input.parentRunID }).pipe(Effect.exit)
        if (recovered._tag === "Failure") {
          const after = yield* audit.inspect(input).pipe(Effect.orElseSucceed(() => before))
          return yield* failClosed("DurableRun rejected owner recovery; manual review is required.", after)
        }
      }

      const after = yield* audit.inspect(input)
      if (after.decision !== undefined) assertSettlementRecoveryInvariant(after.decision)
      for (const write of before.decision.next) {
        if (ready(after, write) && !repaired.includes(write)) repaired.push(write)
      }
      if (after.status !== "complete") return yield* failClosed(after.reason, after)
      for (const owner of commitPlan.ownerOrder) {
        if (promotedOwners.has(owner)) continue
        const digest = ownerDigest(owner)
        if (digest === undefined)
          return yield* failClosed(`Settlement owner digest is unavailable for ${owner}.`, after)
        const promoted = yield* outbox
          .promoteOwner({
            ...outboxInput,
            owner,
            ownerDigest: digest,
            observedAtMs: Date.now(),
          })
          .pipe(Effect.exit)
        if (promoted._tag === "Failure")
          return yield* failClosed(`Settlement ${owner} converged but promotion proof could not be persisted.`, after)
        promotedOwners.add(owner)
      }
      const committed = yield* outbox.commitPromoted({ ...outboxInput, observedAtMs: Date.now() }).pipe(Effect.exit)
      if (committed._tag === "Failure")
        return yield* failClosed(
          "Settlement recovery owners converged but receipt commit failed; manual review is required.",
          after,
        )
      if (committed.value.record.status !== "committed")
        return yield* failClosed(
          "Settlement recovery receipt did not reach committed state; manual review is required.",
          after,
        )
      return report(after, "Settlement recovery converged without provider execution.")
    })

    const recoverPending: Interface["recoverPending"] = Effect.fn("ChildSettlementRecovery.recoverPending")(
      function* (input) {
        let limit: number
        let status: SettlementRecoverySweepInput["status"]
        try {
          limit = normalizeSweepLimit(input.limit)
          status = normalizeSweepStatus(input.status)
        } catch (cause) {
          return yield* Effect.fail(cause instanceof Error ? cause : new SettlementRecoveryError(String(cause)))
        }

        // Read one bounded page per status, then merge by the outbox's stable
        // updatedAt/intent ordering. Fetching limit + 1 lets callers know a
        // page was truncated without making an unbounded query; the 1000 item
        // API ceiling remains explicit when the caller requests the maximum.
        const statuses: ReadonlyArray<"prepared" | "recovery-required"> = status
          ? [status]
          : ["prepared", "recovery-required"]
        const pageLimit = Math.min(MAX_SWEEP_LIMIT, limit + 1)
        const pages = yield* Effect.forEach(
          statuses,
          (pageStatus) => outbox.list({ identity: input.identity, status: pageStatus, limit: pageLimit }),
          { concurrency: 1 },
        )
        const listed = pages.flat()
        const hasMore =
          listed.length > limit || (limit === MAX_SWEEP_LIMIT && pages.some((page) => page.length === MAX_SWEEP_LIMIT))
        const records = [...listed]
          .filter(
            (
              record,
            ): record is SettlementOutbox.SettlementOutboxRecord & {
              readonly status: "prepared" | "recovery-required"
            } => record.status === "prepared" || record.status === "recovery-required",
          )
          .sort((left, right) => left.updatedAtMs - right.updatedAtMs || left.intentID.localeCompare(right.intentID))
          .slice(0, limit)

        const items = yield* Effect.forEach(
          records,
          (record) =>
            Effect.gen(function* () {
              const recovered = yield* recover({
                identity: input.identity,
                parentRunID: record.parentRunID,
                childRunID: record.childRunID,
              }).pipe(Effect.exit)
              const afterReceipt = yield* outbox
                .read({ identity: input.identity, intentID: record.intentID })
                .pipe(Effect.exit)
              const afterStatus = Exit.isSuccess(afterReceipt) ? afterReceipt.value?.status : undefined

              if (Exit.isSuccess(recovered)) {
                const outcome: SettlementRecoverySweepOutcome =
                  afterStatus === "committed"
                    ? "committed"
                    : afterStatus === "recovery-required"
                      ? "recovery-required"
                      : afterStatus === "prepared"
                        ? "pending"
                        : "failed"
                const reason =
                  afterStatus === undefined
                    ? "Settlement recovery completed but its receipt could not be read; manual review is required."
                    : recovered.value.reason
                return Object.freeze({
                  intentID: record.intentID,
                  parentRunID: record.parentRunID,
                  childRunID: record.childRunID,
                  sourceStatus: record.status,
                  ...(afterStatus === undefined ? {} : { afterStatus }),
                  outcome,
                  attempted: Object.freeze([...recovered.value.attempted]),
                  repaired: Object.freeze([...recovered.value.repaired]),
                  reason: boundedSweepReason(reason),
                }) satisfies SettlementRecoverySweepItem
              }

              return Object.freeze({
                intentID: record.intentID,
                parentRunID: record.parentRunID,
                childRunID: record.childRunID,
                sourceStatus: record.status,
                ...(afterStatus === undefined ? {} : { afterStatus }),
                outcome: "failed" as const,
                attempted: Object.freeze([]) as ReadonlyArray<ChildSettlement.SettlementWrite>,
                repaired: Object.freeze([]) as ReadonlyArray<ChildSettlement.SettlementWrite>,
                reason: boundedSweepReason(
                  afterStatus === "recovery-required"
                    ? "Settlement recovery failed and the receipt requires manual review."
                    : "Settlement recovery invocation failed; manual review is required.",
                ),
              }) satisfies SettlementRecoverySweepItem
            }),
          { concurrency: 1 },
        )
        const committed = items.filter((item) => item.outcome === "committed").length
        const pending = items.filter((item) => item.outcome === "pending").length
        const recoveryRequired = items.filter((item) => item.outcome === "recovery-required").length
        const failed = items.filter((item) => item.outcome === "failed").length
        return Object.freeze({
          schemaVersion: 1 as const,
          identity: { tenantID: input.identity.tenantID, userID: input.identity.userID },
          ...(status === undefined ? {} : { status }),
          limit,
          scanned: items.length,
          committed,
          pending,
          recoveryRequired,
          failed,
          hasMore,
          items: Object.freeze([...items]),
          deterministic: true as const,
          providerExecutionAllowed: false as const,
        })
      },
    )

    return { recover, recoverPending }
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ChildSettlementAudit.node, DurableRun.globalNode, ExperienceStoreV1.node, SettlementOutbox.globalNode],
})
