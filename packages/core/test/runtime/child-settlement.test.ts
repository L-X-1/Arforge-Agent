import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"

const parentRunID = AgentRuntime.RunID.make("run_parent_settlement_contract")
const idempotencyKey = "settlement-contract"
const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
const evidenceID = AgentRuntime.EvidenceID.make("evd_admission_settlement_contract")

const result = {
  status: "completed" as const,
  summary: "child completed through the provider-neutral path",
  artifactRefs: [],
  evidenceRefs: [evidenceID],
  usage: { attempts: 1, durationMs: 42, costMicros: 7, tokens: 11 },
}

const intent = () =>
  ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result,
    admissionEvidence: {
      evidenceID,
      recordDigest: "a".repeat(64),
      actionID: AgentRuntime.ActionID.make("act_settlement_contract"),
      observationID: AgentRuntime.ObservationID.make("obs_settlement_contract"),
    },
    createdAtMs: 1_735_000_000_000,
  })

const absent = (): ChildSettlement.SettlementFacts => ({
  intent: "present",
  evidence: { state: "missing" },
  childResult: { state: "missing" },
  parentBudget: { state: "missing" },
})

describe("ChildSettlement recovery contract", () => {
  it("derives one immutable intent and keeps the receipt payload-free", () => {
    const first = intent()
    const second = intent()
    expect(first).toEqual(second)
    expect(first.intentID).toMatch(/^stl_[a-f0-9]{64}$/)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.usage)).toBe(true)
    expect(first).not.toHaveProperty("prompt")
    expect(first).not.toHaveProperty("credentials")
    expect(first).not.toHaveProperty("providerPayload")
  })

  it("builds one deterministic owner-bound commit plan without enabling provider work", () => {
    const current = intent()
    const capabilities = {
      mode: "recovery-outbox" as const,
      atomicDatabaseTransaction: false,
      durableRecoveryOutbox: true,
    }
    const first = ChildSettlement.planSettlementCommit(current, capabilities)
    const second = ChildSettlement.planSettlementCommit(current, capabilities)
    expect(first).toEqual(second)
    expect(first.ownerOrder).toEqual(["admission-evidence", "child-result", "parent-budget"])
    expect(first.owners).toEqual({
      evidence: "experience-store",
      childResult: "durable-run",
      parentBudget: "durable-run",
    })
    expect(first.expectedDigests).toEqual({
      evidence: current.admissionEvidence!.recordDigest,
      childResult: current.resultDigest,
      parentBudget: canonicalHash(current.usage)!,
    })
    expect(first.outboxRequired).toBe(true)
    expect(first.providerExecutionAllowed).toBe(false)
    expect(first.commitDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(first)).toBe(true)
    expect(JSON.stringify(first)).not.toContain("child completed through the provider-neutral path")
    expect(JSON.stringify(first)).not.toContain("credentials")
    ChildSettlement.assertSettlementCommitPlan(first)
  })

  it("exposes one fail-closed production decision for cross-owner settlement", () => {
    const first = ChildSettlement.settlementCommitEnableGate()
    const second = ChildSettlement.settlementCommitEnableGate()
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: 1,
      mode: "recovery-outbox",
      ready: false,
      decision: "keep-recovery-outbox",
      providerExecutionAllowed: false,
    })
    expect(first.gates.map((gate) => gate.id)).toEqual([
      "event-v2-shared-transaction",
      "durable-recovery-outbox",
      "owner-order-invariant",
      "provider-execution-fence",
    ])
    expect(first.gates[0]).toMatchObject({ status: "blocked", evidenceScope: "production" })
    expect(first.gates.slice(1).every((gate) => gate.status === "satisfied")).toBe(true)
    expect(first.blocking_gate_ids).toEqual(["event-v2-shared-transaction"])
    expect(first.decisionDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(first)).toBe(true)
    expect(JSON.stringify(first)).not.toContain("prompt")
    expect(JSON.stringify(first)).not.toContain("credentials")
    ChildSettlement.assertSettlementCommitEnableGate(first)
    expect(() =>
      ChildSettlement.assertSettlementCommitEnableGate({
        ...first,
        decision: "enable-same-transaction",
      }),
    ).toThrow("cannot enable with blocking gates")
    expect(() =>
      ChildSettlement.assertSettlementCommitEnableGate({
        ...first,
        gates: first.gates.map((gate, index) => (index === 0 ? { ...gate, blocker: "" } : gate)),
        decisionDigest: first.decisionDigest,
      }),
    ).toThrow("entries are invalid")
    expect(() =>
      ChildSettlement.assertSettlementCommitEnableGate({
        ...first,
        decision: "enable-same-transaction",
        decisionDigest: first.decisionDigest,
      }),
    ).toThrow("cannot enable with blocking gates")
    expect(() =>
      ChildSettlement.assertSettlementCommitEnableGate({
        ...first,
        decision: "blocked",
        gates: first.gates.map((gate) => ({ ...gate, status: "satisfied" as const, blocker: "" })),
        blocking_gate_ids: [],
        decisionDigest: first.decisionDigest,
      }),
    ).toThrow("blocked settlement enable gate has no blocking gates")
  })

  it("keeps legacy children on the DurableRun-only order and validates atomic mode explicitly", () => {
    const current = ChildSettlement.createIntent({
      parentRunID,
      childRunID,
      idempotencyKey,
      result: { ...result, evidenceRefs: [] },
      createdAtMs: 1_735_000_000_000,
    })
    const planned = ChildSettlement.planSettlementCommit(current, {
      mode: "same-transaction",
      atomicDatabaseTransaction: true,
      durableRecoveryOutbox: false,
    })
    expect(planned.ownerOrder).toEqual(["child-result", "parent-budget"])
    expect(planned.owners.evidence).toBe("not-required")
    expect(planned.expectedDigests).not.toHaveProperty("evidence")
    expect(planned.outboxRequired).toBe(false)
    expect(planned.mode).toBe("same-transaction")
    ChildSettlement.assertSettlementCommitPlan(planned)
  })

  it("requires a complete shared-transaction evidence card before planning cross-owner atomic mode", () => {
    const current = intent()
    const transactionKey = `settlement:${current.intentID}`
    const evidence = ChildSettlement.makeSettlementSharedTransactionEvidence({
      transactionKey,
      transactionID: "tx_settlement_contract_1",
      ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
    })
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      transactionKey,
      transactionID: "tx_settlement_contract_1",
      atomicCommit: true,
      rollbackOnFailure: true,
      providerExecutionAllowed: false,
    })
    expect(evidence.bindings.map((binding) => binding.owner)).toEqual(["event-v2", "experience-store", "durable-run"])
    expect(evidence.bindings.every((binding) => binding.transactionID === evidence.transactionID)).toBe(true)
    expect(evidence.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    ChildSettlement.assertSettlementSharedTransactionEvidence(evidence, {
      transactionKey,
      ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
    })

    const planned = ChildSettlement.planSettlementCommit(current, {
      mode: "same-transaction",
      atomicDatabaseTransaction: true,
      durableRecoveryOutbox: false,
      sharedTransactionEvidence: evidence,
    })
    expect(planned.mode).toBe("same-transaction")
    expect(planned.sharedTransactionEvidenceDigest).toBe(evidence.evidenceDigest)
    expect(planned.outboxRequired).toBe(false)
    ChildSettlement.assertSettlementCommitPlan(planned)

    expect(() =>
      ChildSettlement.planSettlementCommit(current, {
        mode: "same-transaction",
        atomicDatabaseTransaction: true,
        durableRecoveryOutbox: false,
        sharedTransactionEvidence: {
          ...evidence,
          bindings: evidence.bindings.map((binding, index) =>
            index === 1 ? { ...binding, transactionID: "tx_other" } : binding,
          ),
        },
      }),
    ).toThrow("shared EventV2 transaction evidence is invalid")
  })

  it("rejects an unsafe commit capability or a tampered plan before any owner write", () => {
    const current = intent()
    expect(() =>
      ChildSettlement.planSettlementCommit(current, {
        mode: "same-transaction",
        atomicDatabaseTransaction: false,
        durableRecoveryOutbox: true,
      }),
    ).toThrow("requires one atomic database transaction")
    expect(() =>
      ChildSettlement.planSettlementCommit(current, {
        mode: "same-transaction",
        atomicDatabaseTransaction: true,
        durableRecoveryOutbox: false,
      }),
    ).toThrow("cross-owner settlement requires an explicit shared EventV2 transaction")
    expect(() =>
      ChildSettlement.planSettlementCommit(current, {
        mode: "recovery-outbox",
        atomicDatabaseTransaction: false,
        durableRecoveryOutbox: false,
      }),
    ).toThrow("requires a durable recovery outbox")
    const planned = ChildSettlement.planSettlementCommit(current, {
      mode: "recovery-outbox",
      atomicDatabaseTransaction: false,
      durableRecoveryOutbox: true,
    })
    expect(() =>
      ChildSettlement.assertSettlementCommitPlan({ ...planned, providerExecutionAllowed: true as never }),
    ).toThrow("cannot authorize provider execution")
    expect(() =>
      ChildSettlement.assertSettlementCommitPlan({ ...planned, ownerOrder: ["child-result", "parent-budget"] }),
    ).toThrow("owner order drifted")
  })

  it("reconciles every crash window in fixed Evidence → result → budget order", () => {
    const current = intent()
    const windows: Array<[string, ChildSettlement.SettlementFacts, ReadonlyArray<ChildSettlement.SettlementWrite>]> = [
      ["before any owner write", absent(), ["admission-evidence", "child-result", "parent-budget"]],
      [
        "after Evidence",
        { ...absent(), evidence: { state: "present", digest: "a".repeat(64) } },
        ["child-result", "parent-budget"],
      ],
      [
        "after child result",
        {
          ...absent(),
          evidence: { state: "present", digest: "a".repeat(64) },
          childResult: { state: "present", digest: current.resultDigest },
        },
        ["parent-budget"],
      ],
      [
        "after parent budget",
        {
          ...absent(),
          evidence: { state: "present", digest: "a".repeat(64) },
          childResult: { state: "present", digest: current.resultDigest },
          parentBudget: { state: "present", digest: "b".repeat(64) },
        },
        [],
      ],
    ]
    for (const [name, facts, expected] of windows) {
      const decision = ChildSettlement.reconcile(current, facts)
      if (name === "after parent budget") {
        expect(decision.complete).toBe(false)
        expect(decision.conflicts.length).toBe(1)
      } else {
        expect(decision.next, name).toEqual(expected)
        expect(decision.providerExecutionAllowed).toBe(false)
      }
    }
    const expectedBudgetDigest = canonicalHash(current.usage)!
    const settled = ChildSettlement.reconcile(current, {
      intent: "present",
      evidence: { state: "present", digest: "a".repeat(64), identity: String(evidenceID) },
      childResult: { state: "present", digest: current.resultDigest },
      parentBudget: { state: "present", digest: expectedBudgetDigest },
    })
    expect(settled.complete).toBe(true)
    expect(settled.next).toEqual([])
  })

  it("stops on divergent components and never authorizes a provider retry", () => {
    const current = intent()
    const decision = ChildSettlement.reconcile(current, {
      intent: "present",
      evidence: { state: "present", digest: "b".repeat(64) },
      childResult: { state: "present", digest: current.resultDigest },
      parentBudget: { state: "missing" },
    })
    expect(decision.complete).toBe(false)
    expect(decision.next).toEqual([])
    expect(decision.conflicts.length).toBe(1)
    expect(decision.providerExecutionAllowed).toBe(false)
  })

  it("rejects missing intent, child identity drift, and an admission reference omission", () => {
    expect(() =>
      ChildSettlement.reconcile(intent(), {
        intent: "missing",
        evidence: { state: "missing" },
        childResult: { state: "missing" },
        parentBudget: { state: "missing" },
      }),
    ).toThrow("settlement intent is missing")
    expect(() =>
      ChildSettlement.createIntent({
        parentRunID,
        childRunID: AgentRuntime.RunID.make("run_child_drifted"),
        idempotencyKey,
        result,
        createdAtMs: 1,
      }),
    ).toThrow("childRunID does not match")
    expect(() =>
      ChildSettlement.createIntent({
        parentRunID,
        childRunID,
        idempotencyKey,
        result: { ...result, evidenceRefs: [] },
        admissionEvidence: { evidenceID, recordDigest: "a".repeat(64) },
        createdAtMs: 1,
      }),
    ).toThrow("must be carried")
  })

  it("rejects a forged immutable intent and an Evidence identity drift", () => {
    const current = intent()
    expect(() => ChildSettlement.reconcile({ ...current, resultDigest: "b".repeat(64) }, absent())).toThrow(
      "immutable fields do not match",
    )
    const decision = ChildSettlement.reconcile(current, {
      intent: "present",
      evidence: { state: "present", digest: "a".repeat(64), identity: "evd_other" },
      childResult: { state: "present", digest: current.resultDigest },
      parentBudget: { state: "missing" },
    })
    expect(decision.next).toEqual([])
    expect(decision.conflicts).toContain("admission-evidence identity does not match settlement intent")
  })

  it("merges owner-scoped resolver digests with DurableRun facts without exposing payload", () => {
    const current = intent()
    const merged = ChildSettlement.mergeEvidenceFacts(
      current,
      {
        childResult: { state: "present", digest: current.resultDigest, identity: String(childRunID) },
        parentBudget: { state: "present", digest: canonicalHash(current.usage)!, identity: String(childRunID) },
      },
      {
        resolution: {
          requested: [evidenceID],
          present: [evidenceID],
          missing: [],
          duplicate: [],
          invalid: [],
          valid: true,
        },
        recordDigests: [{ evidenceID, recordDigest: current.admissionEvidence!.recordDigest }],
      },
    )
    expect(merged.evidence).toEqual({
      state: "present",
      digest: current.admissionEvidence!.recordDigest,
      identity: String(evidenceID),
    })
    expect(ChildSettlement.reconcile(current, merged)).toMatchObject({
      complete: true,
      providerExecutionAllowed: false,
    })
    expect(JSON.stringify(merged)).not.toContain("summary")
    expect(JSON.stringify(merged)).not.toContain("credentials")
  })

  it("turns missing, malformed, or digest-drifted resolver facts into a fail-closed decision", () => {
    const current = intent()
    const base = {
      childResult: { state: "present" as const, digest: current.resultDigest },
      parentBudget: { state: "present" as const, digest: canonicalHash(current.usage)! },
    }
    const missing = ChildSettlement.mergeEvidenceFacts(current, base, {
      resolution: {
        requested: [evidenceID],
        present: [],
        missing: [evidenceID],
        duplicate: [],
        invalid: [],
        valid: false,
      },
      recordDigests: [],
    })
    expect(ChildSettlement.reconcile(current, missing)).toMatchObject({
      complete: false,
      missing: ["admission-evidence"],
      providerExecutionAllowed: false,
    })

    const drifted = ChildSettlement.mergeEvidenceFacts(current, base, {
      resolution: {
        requested: [evidenceID],
        present: [evidenceID],
        missing: [],
        duplicate: [],
        invalid: [],
        valid: true,
      },
      recordDigests: [{ evidenceID, recordDigest: "b".repeat(64) }],
    })
    const decision = ChildSettlement.reconcile(current, drifted)
    expect(decision.complete).toBe(false)
    expect(decision.next).toEqual([])
    expect(decision.conflicts).toContain("Evidence record digest does not match settlement intent")
    expect(decision.providerExecutionAllowed).toBe(false)
  })
})
