import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as SettlementCoordinator from "@arforge-ai/core/runtime/settlement-coordinator"
import * as SettlementCoordinatorInvariant from "@arforge-ai/core/runtime/settlement-coordinator-invariant"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as Runtime from "@arforge-ai/core/runtime"
import * as SettlementObservation from "@arforge-ai/core/runtime/settlement-observation"
import { Effect } from "effect"

const makeExecution = async (label: string, observedAtMs: number) => {
  const parentRunID = AgentRuntime.RunID.make(`run_observation_${label}_parent`)
  const idempotencyKey = `observation-${label}`
  const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
  const evidenceID = AgentRuntime.EvidenceID.make(`evd_observation_${label}`)
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result: {
      status: "completed",
      summary: "observation fixture",
      artifactRefs: [],
      evidenceRefs: [evidenceID],
      usage: { attempts: 1, durationMs: 2, costMicros: 1, tokens: 3 },
    },
    admissionEvidence: {
      evidenceID,
      recordDigest: "a".repeat(64),
      actionID: AgentRuntime.ActionID.make(`act_observation_${label}`),
      observationID: AgentRuntime.ObservationID.make(`obs_observation_${label}`),
    },
    createdAtMs: observedAtMs,
  })
  const sharedTransactionEvidence = ChildSettlement.makeSettlementSharedTransactionEvidence({
    transactionKey: `settlement:${intent.intentID}`,
    transactionID: `tx_observation_${label}`,
    ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
  })
  const plan = ChildSettlement.planSettlementCommit(intent, {
    mode: "same-transaction",
    atomicDatabaseTransaction: true,
    durableRecoveryOutbox: false,
    sharedTransactionEvidence,
  })
  const owners: ReadonlyArray<ChildSettlement.SettlementWrite> = ["admission-evidence", "child-result", "parent-budget"]
  const writers: SettlementCoordinator.SettlementOwnerWriters = Object.fromEntries(
    owners.map((owner) => [
      owner,
      (
        _transaction: SettlementCoordinator.SettlementTransactionHandle,
        scope: SettlementCoordinator.SettlementOwnerTransactionScope,
      ) =>
        Effect.succeed({
          schemaVersion: 1 as const,
          owner,
          transactionKey: scope.transactionKey,
          transactionID: scope.transactionID,
          ownerDigest:
            owner === "admission-evidence"
              ? plan.expectedDigests.evidence!
              : owner === "child-result"
                ? plan.expectedDigests.childResult
                : plan.expectedDigests.parentBudget,
        }),
    ]),
  ) as unknown as SettlementCoordinator.SettlementOwnerWriters
  const execution = await Effect.runPromise(
    SettlementCoordinator.executeSettlementTransaction({
      database: {} as SettlementCoordinator.SettlementTransactionInput["database"],
      plan,
      sharedTransactionEvidence,
      writers,
      transaction: (callback) => callback({} as SettlementCoordinator.SettlementTransactionHandle),
      observedAtMs,
    }),
  )
  return { execution, plan, sharedTransactionEvidence }
}

describe("Settlement observation windows", () => {
  test("projects a validated coordinator receipt without payloads", async () => {
    expect(Runtime.SettlementObservation.SETTLEMENT_OBSERVATION_SCHEMA_VERSION).toBe(1)
    const input = await makeExecution("single", 10)
    const sample = SettlementObservation.observationFromExecution(input)

    expect(sample).toMatchObject({
      transactionID: "tx_observation_single",
      ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
      ownerCount: 3,
      outcome: "committed",
      providerExecutionAllowed: false,
      observedAtMs: 10,
    })
    expect(JSON.stringify(sample)).not.toContain("observation fixture")
  })

  test("marks a bounded window ready for review only after its minimum sample count", async () => {
    const first = await makeExecution("first", 10)
    const second = await makeExecution("second", 20)
    const window = SettlementObservation.buildSettlementObservationWindow({
      samples: [
        SettlementObservation.observationFromExecution(first),
        SettlementObservation.observationFromExecution(second),
      ],
      minimumSamples: 2,
    })

    expect(window.status).toBe("ready-for-review")
    expect(window.reviewOnly).toBe(true)
    expect(window.promotionAuthorized).toBe(false)
    expect(window.allOwnerOrderStable).toBe(true)
    expect(window.allProviderFenced).toBe(true)
    expect(window.windowDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => SettlementObservation.assertSettlementObservationWindow(window)).not.toThrow()
    const invariant = await Effect.runPromise(
      SettlementCoordinatorInvariant.inspect(RuntimeInvariants.createRuntimeInvariantRegistry(), {
        kind: "observation-window",
        observation: window,
      }),
    )
    expect(invariant.passedAll).toBe(true)
    expect(invariant.results).toMatchObject([
      { owner: "settlement-coordinator", key: "observation-window", status: "passed" },
    ])
  })

  test("keeps an undersampled window explicit instead of treating it as production evidence", async () => {
    const input = await makeExecution("under", 10)
    const window = SettlementObservation.buildSettlementObservationWindow({
      samples: [SettlementObservation.observationFromExecution(input)],
      minimumSamples: 2,
    })

    expect(window.status).toBe("insufficient-observations")
    expect(window.sampleCount).toBe(1)
    expect(window.promotionAuthorized).toBe(false)
  })

  test("rejects duplicate executions and non-monotonic observation time", async () => {
    const first = await makeExecution("duplicate", 20)
    const duplicate = SettlementObservation.observationFromExecution(first)
    expect(() => SettlementObservation.buildSettlementObservationWindow({ samples: [duplicate, duplicate] })).toThrow(
      "execution is duplicated",
    )

    const earlier = await makeExecution("earlier", 10)
    expect(() =>
      SettlementObservation.buildSettlementObservationWindow({
        samples: [duplicate, SettlementObservation.observationFromExecution(earlier)],
      }),
    ).toThrow("timestamps are not monotonic")

    const sameKey = SettlementObservation.observationFromExecution(earlier)
    expect(() =>
      SettlementObservation.buildSettlementObservationWindow({
        samples: [duplicate, { ...sameKey, transactionKey: duplicate.transactionKey } as never],
      }),
    ).toThrow("transaction key is duplicated")
  })

  test("rejects tampered samples and window digest drift", async () => {
    const input = await makeExecution("tamper", 10)
    const sample = SettlementObservation.observationFromExecution(input)
    expect(() =>
      SettlementObservation.buildSettlementObservationWindow({
        samples: [{ ...sample, providerExecutionAllowed: true } as never],
      }),
    ).toThrow("sample is invalid")

    const window = SettlementObservation.buildSettlementObservationWindow({ samples: [sample] })
    expect(() =>
      SettlementObservation.assertSettlementObservationWindow({ ...window, windowDigest: "0".repeat(64) }),
    ).toThrow("window digest drifted")
  })

  test("accepts an empty window as insufficient and preserves a canonical digest", () => {
    const window = SettlementObservation.buildSettlementObservationWindow({ samples: [], minimumSamples: 1 })

    expect(window.status).toBe("insufficient-observations")
    expect(window.startAtMs).toBe(0)
    expect(window.endAtMs).toBe(0)
    expect(window.sampleCount).toBe(0)
    expect(() => SettlementObservation.assertSettlementObservationWindow(window)).not.toThrow()
  })

  test("merges independently captured windows without losing append order", async () => {
    const first = await makeExecution("merge-first", 10)
    const second = await makeExecution("merge-second", 20)
    const firstWindow = SettlementObservation.buildSettlementObservationWindow({
      samples: [SettlementObservation.observationFromExecution(first)],
      minimumSamples: 2,
    })
    const secondWindow = SettlementObservation.buildSettlementObservationWindow({
      samples: [SettlementObservation.observationFromExecution(second)],
      minimumSamples: 2,
    })

    const merged = SettlementObservation.mergeSettlementObservationWindows({
      windows: [firstWindow, secondWindow],
      minimumSamples: 2,
    })

    expect(merged.sampleCount).toBe(2)
    expect(merged.status).toBe("ready-for-review")
    expect(merged.samples.map((sample) => sample.transactionID)).toEqual([
      "tx_observation_merge-first",
      "tx_observation_merge-second",
    ])
    expect(() => SettlementObservation.assertSettlementObservationWindow(merged)).not.toThrow()
  })

  test("rejects reversed windows and a tampered source window", async () => {
    const first = await makeExecution("merge-reversed-first", 10)
    const second = await makeExecution("merge-reversed-second", 20)
    const firstWindow = SettlementObservation.buildSettlementObservationWindow({
      samples: [SettlementObservation.observationFromExecution(first)],
      minimumSamples: 2,
    })
    const secondWindow = SettlementObservation.buildSettlementObservationWindow({
      samples: [SettlementObservation.observationFromExecution(second)],
      minimumSamples: 2,
    })

    expect(() =>
      SettlementObservation.mergeSettlementObservationWindows({ windows: [secondWindow, firstWindow] }),
    ).toThrow("windows are not monotonic")
    expect(() =>
      SettlementObservation.mergeSettlementObservationWindows({
        windows: [firstWindow, secondWindow],
        minimumSamples: 1,
      }),
    ).toThrow("minimumSamples cannot be lowered")
    expect(() =>
      SettlementObservation.mergeSettlementObservationWindows({
        windows: [{ ...firstWindow, windowDigest: "0".repeat(64) } as never, secondWindow],
      }),
    ).toThrow("window digest drifted")
  })

  test("round-trips a restart-safe checkpoint and continues its immutable prefix", async () => {
    const first = await makeExecution("checkpoint-first", 10)
    const second = await makeExecution("checkpoint-second", 20)
    const observerID = "postgres-settlement-soak:fixture"
    const firstCheckpoint = SettlementObservation.buildSettlementObservationCheckpoint({
      observerID,
      window: SettlementObservation.buildSettlementObservationWindow({
        samples: [SettlementObservation.observationFromExecution(first)],
        minimumSamples: 2,
      }),
    })
    const checkpoint = SettlementObservation.appendSettlementObservationCheckpoint({
      observerID,
      checkpoint: firstCheckpoint,
      sample: SettlementObservation.observationFromExecution(second),
      minimumSamples: 2,
    })
    const serialized = JSON.parse(JSON.stringify(checkpoint)) as unknown
    SettlementObservation.assertSettlementObservationCheckpoint(serialized)
    const resumed = SettlementObservation.resumeSettlementObservationCheckpoint(serialized)

    expect(checkpoint.checkpointDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(resumed.sampleCount).toBe(2)
    expect(resumed.status).toBe("ready-for-review")
    expect(resumed.samples.map((sample) => sample.transactionID)).toEqual([
      "tx_observation_checkpoint-first",
      "tx_observation_checkpoint-second",
    ])
    const invariant = await Effect.runPromise(
      SettlementCoordinatorInvariant.inspect(RuntimeInvariants.createRuntimeInvariantRegistry(), {
        kind: "observation-checkpoint",
        checkpoint: serialized,
      }),
    )
    expect(invariant.passedAll).toBe(true)
    expect(invariant.results).toMatchObject([
      { owner: "settlement-coordinator", key: "observation-checkpoint", status: "passed" },
    ])
  })

  test("rejects checkpoint observer, prefix, and digest drift before append", async () => {
    const input = await makeExecution("checkpoint-drift", 10)
    const sample = SettlementObservation.observationFromExecution(input)
    const checkpoint = SettlementObservation.buildSettlementObservationCheckpoint({
      observerID: "observer-a",
      window: SettlementObservation.buildSettlementObservationWindow({ samples: [sample] }),
    })
    expect(() =>
      SettlementObservation.appendSettlementObservationCheckpoint({
        observerID: "observer-b",
        checkpoint,
        sample,
      }),
    ).toThrow("observerID drifted")
    expect(() =>
      SettlementObservation.assertSettlementObservationCheckpoint({
        ...checkpoint,
        checkpointDigest: "0".repeat(64),
      }),
    ).toThrow("checkpoint digest drifted")
    expect(() =>
      SettlementObservation.appendSettlementObservationCheckpoint({
        observerID: "observer-a",
        checkpoint,
        sample: {
          ...sample,
          transactionID: "tx_observation_checkpoint-earlier",
          transactionKey: "settlement:checkpoint-earlier",
          observedAtMs: 5,
        },
      }),
    ).toThrow("timestamps are not monotonic")
  })

  test("requires an explicit long-term review window before presenting readiness", async () => {
    const first = await makeExecution("review-first", 100)
    const second = await makeExecution("review-second", 250)
    const third = await makeExecution("review-third", 400)
    const window = SettlementObservation.buildSettlementObservationWindow({
      samples: [
        SettlementObservation.observationFromExecution(first),
        SettlementObservation.observationFromExecution(second),
        SettlementObservation.observationFromExecution(third),
      ],
      minimumSamples: 3,
    })
    const review = SettlementObservation.reviewSettlementObservationWindow({
      window,
      policy: {
        minimumSamples: 3,
        minimumWindowDurationMs: 300,
        maximumSampleGapMs: 200,
      },
    })

    expect(review).toMatchObject({
      kind: "settlement-observation-review",
      sampleCount: 3,
      durationMs: 300,
      observedMaximumGapMs: 150,
      blockers: [],
      status: "ready-for-review",
      reviewOnly: true,
      promotionAuthorized: false,
      providerExecutionAllowed: false,
    })
    expect(review.reviewDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => SettlementObservation.assertSettlementObservationReview(review)).not.toThrow()
    const invariant = await Effect.runPromise(
      SettlementCoordinatorInvariant.inspect(RuntimeInvariants.createRuntimeInvariantRegistry(), {
        kind: "observation-review",
        review,
      }),
    )
    expect(invariant.passedAll).toBe(true)
    expect(invariant.results).toMatchObject([
      { owner: "settlement-coordinator", key: "observation-review", status: "passed" },
    ])
  })

  test("keeps sample, duration, and gap blockers explicit and rejects review drift", async () => {
    const first = await makeExecution("review-hold-first", 100)
    const second = await makeExecution("review-hold-second", 1_000)
    const window = SettlementObservation.buildSettlementObservationWindow({
      samples: [
        SettlementObservation.observationFromExecution(first),
        SettlementObservation.observationFromExecution(second),
      ],
    })
    const review = SettlementObservation.reviewSettlementObservationWindow({
      window,
      policy: {
        minimumSamples: 3,
        minimumWindowDurationMs: 2_000,
        maximumSampleGapMs: 100,
      },
    })
    expect(review.status).toBe("hold")
    expect(review.blockers).toEqual(["insufficient-samples", "insufficient-duration", "sample-gap-too-large"])
    expect(() =>
      SettlementObservation.assertSettlementObservationReview({ ...review, reviewDigest: "0".repeat(64) }),
    ).toThrow("review digest drifted")
  })
})
