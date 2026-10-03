import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { and, eq } from "drizzle-orm"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import * as SettlementOutbox from "@arforge-ai/core/runtime/settlement-outbox"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import {
  customAgentRuntimeAdmission,
  customAgentRuntimeAdmissionEvidence,
  parseCustomAgentProfile,
} from "@arforge-ai/core/custom-agent-profile"
import { Cause, DateTime, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, SettlementOutbox.globalNode]),
)
const it = testEffect(runtimeLayer)

const project = ProjectID.global
const location = AbsolutePath.make("/child-run-test")

const parentBudget = AgentRuntime.Budget.make({
  maxAttempts: 4,
  maxDurationMs: 1_000,
  maxCostMicros: 1_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const childBudget = (maxAttempts = 1, maxDurationMs = 100, maxCostMicros = 100) =>
  AgentRuntime.Budget.make({
    maxAttempts,
    maxDurationMs,
    maxCostMicros,
    maxTokens: 100,
    attemptsUsed: 0,
    durationMsUsed: 0,
    costMicrosUsed: 0,
    tokensUsed: 0,
  })

const createParent = (runtime: DurableRun.Interface, extra: Partial<DurableRun.SessionCreateInput> = {}) =>
  runtime.create({
    sessionID: SessionSchema.ID.create(),
    initiator: "user",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "child-run parent",
    budget: parentBudget,
    traceID: "child-parent-trace",
    visibility: "details",
    project,
    location,
    ...extra,
  })

const running = (runtime: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runtime.transition({ runID, to: "preflight", reason: "child test preflight" })
    yield* runtime.transition({ runID, to: "queued", reason: "child test queued" })
    yield* runtime.transition({ runID, to: "running", reason: "child test running" })
  })

const createChild = (runtime: DurableRun.Interface, parentRunID: AgentRuntime.RunID, suffix: string, extra = {}) =>
  runtime.createChild({
    parentRunID,
    sessionID: SessionSchema.ID.create(),
    idempotencyKey: `child-${suffix}`,
    delegatedObjective: `inspect ${suffix}`,
    allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
    project,
    location,
    expectedDeliverable: {
      summaryRequired: true,
      artifactKinds: [],
      evidenceKinds: [],
      verifier: "parent",
    },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "delegated read-only child",
    budget: childBudget(),
    traceID: `child-${suffix}`,
    parentTraceID: "child-parent-trace",
    visibility: "details",
    ...extra,
  })

describe("DurableRun child runs", () => {
  it.effect("admits a child with an immutable parent binding and idempotent identity", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)

      const descriptorDigest = "a".repeat(64)
      const first = yield* createChild(runtime, parent.run.id, "one", { runtimeDescriptorDigest: descriptorDigest })
      const second = yield* createChild(runtime, parent.run.id, "one", { runtimeDescriptorDigest: descriptorDigest })
      const children = yield* runtime.listChildren({ parentRunID: parent.run.id })

      expect(first.run.id).toBe(second.run.id)
      expect(first.run.child.parentRunID).toBe(parent.run.id)
      expect(first.run.child.depth).toBe(1)
      expect(first.run.child.runtimeDescriptorDigest).toBe(descriptorDigest)
      expect(first.run.child.allowedCapabilities).toEqual([
        { action: "read", resources: ["workspace"], access: "read" },
      ])
      expect(children.map((item) => item.run.id)).toEqual([first.run.id])
      expect(((yield* runtime.load(parent.run.id)).run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
        attempts: 1,
        durationMs: 100,
        costMicros: 100,
        tokens: 100,
      })
    }),
  )

  it.effect("persists admitted custom-agent evidence and carries its refs into result settlement", () =>
    Effect.gen(function* () {
      const previousOptIn = process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      const previousTrust = process.env.ARFORGE_TRUST_WORKSPACE
      process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = "1"
      process.env.ARFORGE_TRUST_WORKSPACE = "1"
      try {
        const runtime = yield* DurableRun.Service
        const parent = yield* createParent(runtime)
        yield* running(runtime, parent.run.id)
        const profile = parseCustomAgentProfile(
          {
            schema_version: 1,
            name: "release-reviewer",
            description: "Reviews release changes.",
            system_prompt: "Review the supplied change carefully and report concrete issues with evidence.",
            tools: ["read_file"],
            capabilities: ["code_review"],
          },
          "profiles/review.json",
        )
        const admission = customAgentRuntimeAdmission(profile, process.cwd())
        const evidence = customAgentRuntimeAdmissionEvidence(admission)
        const descriptorDigest = admission.descriptor_digest
        if (!descriptorDigest || !evidence.valid || evidence.decision !== "admitted")
          throw new Error("expected an admitted custom-agent evidence receipt")
        const evidenceID = AgentRuntime.EvidenceID.make("evd_custom_agent_admission")
        const child = yield* createChild(runtime, parent.run.id, "admission", {
          runtimeDescriptorDigest: descriptorDigest,
          runtimeAdmission: { evidence, evidenceRefs: [evidenceID] },
        })
        const replayed = (yield* runtime.load(child.run.id)) as DurableRun.ChildSnapshot
        expect(replayed.run.child.runtimeAdmission?.evidence.decision).toBe("admitted")
        expect(replayed.run.child.runtimeAdmission?.evidenceRefs).toEqual([evidenceID])

        yield* running(runtime, child.run.id)
        yield* runtime.beginAttempt({ runID: child.run.id })
        yield* runtime.finishAttempt({
          runID: child.run.id,
          attempt: 1,
          outcome: "completed",
          durationMs: 10,
          costMicros: 1,
          tokens: 1,
        })
        yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "admission evidence test" })
        const result = yield* runtime.recordChildResult({
          runID: child.run.id,
          result: {
            status: "completed",
            summary: "admission evidence persisted",
            artifactRefs: [],
            evidenceRefs: [evidenceID],
            usage: { attempts: 1, durationMs: 10, costMicros: 1, tokens: 1 },
          },
        })
        expect(result.run.childResult?.evidenceRefs).toEqual([evidenceID])
        expect(((yield* runtime.load(parent.run.id)).run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
          attempts: 0,
          durationMs: 0,
          costMicros: 0,
          tokens: 0,
        })
      } finally {
        if (previousOptIn === undefined) delete process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
        else process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = previousOptIn
        if (previousTrust === undefined) delete process.env.ARFORGE_TRUST_WORKSPACE
        else process.env.ARFORGE_TRUST_WORKSPACE = previousTrust
      }
    }),
  )

  it.effect("rejects a blocked or digest-drifted admission before reserving parent budget", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const descriptorDigest = "e".repeat(64)
      const blockedEvidence = {
        schema_version: 1 as const,
        kind: "custom-agent-admission" as const,
        role: "CustomAgent.blocked",
        profile_path: "profiles/blocked.json",
        status: "unsupported_tools" as const,
        decision: "blocked" as const,
        reason: "no canonical tool owner",
        ready: false,
        checks: {
          status_consistent: true,
          descriptor_digest_consistent: true,
          tool_projection_consistent: false,
          payload_free: true,
        },
        declared_tool_count: 1,
        canonical_tool_count: 0,
        unsupported_tool_count: 1,
        valid: true,
        violations: [],
      }
      const blocked = yield* createChild(runtime, parent.run.id, "blocked-admission", {
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: { evidence: blockedEvidence, evidenceRefs: [] },
      }).pipe(Effect.exit)
      expect(String(blocked)).toContain("DurableRun.ChildAdmissionError")
      expect(((yield* runtime.load(parent.run.id)).run as AgentRuntime.SessionRun).childBudgetReserved).toBeUndefined()
    }),
  )

  it.effect("requires admission evidence references in the terminal child settlement", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const descriptorDigest = "f".repeat(64)
      const evidenceID = AgentRuntime.EvidenceID.make("evd_settlement_admission")
      const child = yield* createChild(runtime, parent.run.id, "settlement-admission", {
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: {
          evidence: {
            schema_version: 1,
            kind: "custom-agent-admission",
            role: "CustomAgent.settlement",
            profile_path: "profiles/settlement.json",
            status: "admitted",
            decision: "admitted",
            reason: "settlement evidence fixture",
            ready: true,
            descriptor_digest: descriptorDigest,
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
          },
          evidenceRefs: [evidenceID],
        },
      })
      yield* running(runtime, child.run.id)
      yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "settlement evidence fixture" })
      const missing = yield* runtime
        .recordChildResult({
          runID: child.run.id,
          result: {
            status: "completed",
            summary: "missing admission evidence",
            artifactRefs: [],
            evidenceRefs: [],
            usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
          },
        })
        .pipe(Effect.exit)
      expect(String(missing)).toContain("DurableRun.ChildResultConflictError")
      const accepted = yield* runtime.recordChildResult({
        runID: child.run.id,
        result: {
          status: "completed",
          summary: "admission evidence linked",
          artifactRefs: [],
          evidenceRefs: [evidenceID],
          usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        },
      })
      expect(accepted.run.childResult?.evidenceRefs).toEqual([evidenceID])
    }),
  )

  it.effect("fails closed when an explicit same-transaction settlement is requested before promotion", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "same-transaction-gate")
      yield* running(runtime, child.run.id)
      yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "same-transaction gate fixture" })

      const gate = ChildSettlement.settlementCommitEnableGate()
      expect(gate.ready).toBe(false)
      expect(gate.decision).toBe("keep-recovery-outbox")
      const result = {
        status: "completed" as const,
        summary: "same-transaction must remain gated",
        artifactRefs: [],
        evidenceRefs: [],
        usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
      }
      const blocked = yield* runtime
        .recordChildResult({
          runID: child.run.id,
          settlementMode: "same-transaction",
          result,
        })
        .pipe(Effect.exit)

      expect(String(blocked)).toContain("DurableRun.ChildResultConflictError")
      if (blocked._tag !== "Failure") throw new Error("expected same-transaction settlement to be gated")
      const blockedError = Cause.squash(blocked.cause) as { readonly reason?: unknown }
      expect(String(blockedError.reason)).toContain("Same-transaction child settlement is disabled")
      expect(String(blockedError.reason)).toContain("event-v2-shared-transaction")
      expect(
        yield* runtime.readChildSettlementIntent({
          parentRunID: parent.run.id,
          childRunID: child.run.id,
        }),
      ).toBeUndefined()
      expect(
        yield* runtime.readChildSettlementFacts({
          parentRunID: parent.run.id,
          childRunID: child.run.id,
        }),
      ).toEqual({
        childResult: { state: "missing" },
        parentBudget: { state: "missing" },
      })
      expect(((yield* runtime.load(child.run.id)).run as AgentRuntime.SessionRun).childResult).toBeUndefined()

      const committed = yield* runtime.recordChildResult({ runID: child.run.id, result })
      expect(committed.run.childResult?.summary).toBe(result.summary)
      const replayBlocked = yield* runtime
        .recordChildResult({ runID: child.run.id, settlementMode: "same-transaction", result })
        .pipe(Effect.exit)
      expect(String(replayBlocked)).toContain("DurableRun.ChildResultConflictError")
      if (replayBlocked._tag !== "Failure") throw new Error("expected same-transaction replay to remain gated")
      const replayError = Cause.squash(replayBlocked.cause) as { readonly reason?: unknown }
      expect(String(replayError.reason)).toContain("Same-transaction child settlement is disabled")
      expect(((yield* runtime.load(child.run.id)).run as AgentRuntime.SessionRun).childResult?.summary).toBe(
        result.summary,
      )
    }),
  )

  it.effect("rejects idempotency drift and capability escalation", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      yield* createChild(runtime, parent.run.id, "drift", { runtimeDescriptorDigest: "b".repeat(64) })

      const drift = yield* createChild(runtime, parent.run.id, "drift", {
        delegatedObjective: "different objective",
      }).pipe(Effect.exit)
      const descriptorDrift = yield* createChild(runtime, parent.run.id, "drift", {
        runtimeDescriptorDigest: "c".repeat(64),
      }).pipe(Effect.exit)
      const write = yield* createChild(runtime, parent.run.id, "write", {
        allowedCapabilities: [{ action: "write", resources: ["workspace"], access: "write" }],
      }).pipe(Effect.exit)
      const emptyScope = yield* createChild(runtime, parent.run.id, "empty-scope", {
        allowedCapabilities: [{ action: "read", resources: [], access: "read" }],
      }).pipe(Effect.exit)
      const invalidDescriptor = yield* createChild(runtime, parent.run.id, "invalid-descriptor", {
        runtimeDescriptorDigest: "not-a-digest",
      }).pipe(Effect.exit)

      expect(String(drift)).toContain("DurableRun.ChildIdempotencyConflictError")
      expect(String(descriptorDrift)).toContain("DurableRun.ChildIdempotencyConflictError")
      expect(String(write)).toContain("DurableRun.ChildCapabilityDeniedError")
      expect(String(emptyScope)).toContain("DurableRun.ChildAdmissionError")
      expect(String(invalidDescriptor)).toContain("DurableRun.ChildAdmissionError")
    }),
  )

  it.effect("reserves parent budget, settles actual usage, and records a digest-stable result", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "result")
      yield* running(runtime, child.run.id)
      yield* runtime.beginAttempt({ runID: child.run.id })
      yield* runtime.finishAttempt({
        runID: child.run.id,
        attempt: 1,
        outcome: "completed",
        durationMs: 25,
        costMicros: 7,
        tokens: 7,
      })
      yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "child result ready" })
      const usageMismatch = yield* runtime
        .recordChildResult({
          runID: child.run.id,
          result: {
            status: "completed",
            summary: "read-only evidence collected",
            artifactRefs: [],
            evidenceRefs: [],
            usage: { attempts: 1, durationMs: 0, costMicros: 0, tokens: 0 },
          },
        })
        .pipe(Effect.exit)
      expect(String(usageMismatch)).toContain("DurableRun.ChildResultConflictError")
      const result = yield* runtime.recordChildResult({
        runID: child.run.id,
        result: {
          status: "completed",
          summary: "read-only evidence collected",
          artifactRefs: [],
          evidenceRefs: [],
          usage: { attempts: 1, durationMs: 25, costMicros: 7, tokens: 7 },
        },
      })
      const parentAfter = yield* runtime.load(parent.run.id)
      const again = yield* runtime.recordChildResult({
        runID: child.run.id,
        result: {
          status: "completed",
          summary: "read-only evidence collected",
          artifactRefs: [],
          evidenceRefs: [],
          usage: { attempts: 1, durationMs: 25, costMicros: 7, tokens: 7 },
        },
      })

      expect(result.run.childResult?.resultDigest).toBeDefined()
      expect(result.run.childResult?.usage).toEqual({ attempts: 1, durationMs: 25, costMicros: 7, tokens: 7 })
      expect(again.run.childResult?.resultDigest).toBe(result.run.childResult?.resultDigest)
      expect((parentAfter.run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
      expect(parentAfter.run.budget).toMatchObject({
        attemptsUsed: 1,
        durationMsUsed: 25,
        costMicrosUsed: 7,
        tokensUsed: 7,
      })
      const facts = yield* runtime.readChildSettlementFacts({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      expect(facts.childResult).toMatchObject({
        state: "present",
        digest: result.run.childResult?.resultDigest,
        identity: child.run.id,
      })
      expect(facts.parentBudget).toEqual({
        state: "present",
        digest: canonicalHash({ attempts: 1, durationMs: 25, costMicros: 7, tokens: 7 })!,
        identity: child.run.id,
      })
      const intent = yield* runtime.readChildSettlementIntent({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      if (!intent) throw new Error("expected a durable child settlement intent")
      const receipt = yield* (yield* SettlementOutbox.Service).read({
        identity: Database.DefaultLocalPrincipal,
        intentID: intent.intentID,
      })
      expect(receipt).toMatchObject({
        intentID: intent.intentID,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        status: "committed",
        ownerOrder: ["child-result", "parent-budget"],
      })
    }),
  )

  it.effect("reports missing result and budget facts before settlement without mutating the child", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "facts-before-settlement")
      yield* running(runtime, child.run.id)
      yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "facts fixture" })
      const facts = yield* runtime.readChildSettlementFacts({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      expect(facts).toEqual({
        childResult: { state: "missing" },
        parentBudget: { state: "missing" },
      })
      expect(((yield* runtime.load(child.run.id)).run as AgentRuntime.SessionRun).childResult).toBeUndefined()
    }),
  )

  it.effect("recovers a child result and parent budget from the persisted settlement intent", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "settlement-intent-recovery")
      yield* running(runtime, child.run.id)
      yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "crash after intent" })
      const intentAt = yield* DateTime.now
      const resultInput = {
        status: "completed" as const,
        summary: "recovered from a durable settlement intent",
        artifactRefs: [],
        evidenceRefs: [],
        usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
      }
      const settlement = ChildSettlement.createIntent({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey: child.run.child.idempotencyKey,
        result: resultInput,
        createdAtMs: DateTime.toEpochMillis(intentAt),
      })
      const result = AgentRuntime.ChildRunResult.make({
        ...resultInput,
        resultDigest: settlement.resultDigest,
        recordedAt: intentAt,
      })
      const parentSnapshot = yield* runtime.load(parent.run.id)
      // Simulate a crash after the parent outbox intent committed but before
      // the child result event and budget settlement were appended.
      yield* events.publish(
        AgentRuntime.Event.ChildRunSettlementIntentRecorded,
        {
          runID: parent.run.id,
          sessionID: parent.run.sessionID,
          childRunID: child.run.id,
          idempotencyKey: child.run.child.idempotencyKey,
          intentID: settlement.intentID,
          idempotencyDigest: settlement.idempotencyDigest,
          result,
          intentAt,
        },
        { expectedSequence: parentSnapshot.lastSequence },
      )
      const before = yield* runtime.readChildSettlementFacts({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      expect(before).toEqual({
        childResult: { state: "missing" },
        parentBudget: { state: "missing" },
      })
      const repaired = yield* runtime.recoverChildren({ parentRunID: parent.run.id })
      expect(repaired).toBe(1)
      const after = yield* runtime.readChildSettlementFacts({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      expect(after.childResult).toMatchObject({ state: "present", digest: settlement.resultDigest })
      expect(after.parentBudget).toMatchObject({ state: "present", identity: child.run.id })
      expect(((yield* runtime.load(parent.run.id)).run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
    }),
  )

  it.effect("reconciles a result-written budget gap idempotently without replaying the child", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "settlement-budget-gap")
      yield* running(runtime, child.run.id)
      yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "crash after result" })
      const intentAt = yield* DateTime.now
      const resultInput = {
        status: "completed" as const,
        summary: "result was durable before the parent settlement",
        artifactRefs: [],
        evidenceRefs: [],
        usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
      }
      const settlement = ChildSettlement.createIntent({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey: child.run.child.idempotencyKey,
        result: resultInput,
        createdAtMs: DateTime.toEpochMillis(intentAt),
      })
      const result = AgentRuntime.ChildRunResult.make({
        ...resultInput,
        resultDigest: settlement.resultDigest,
        recordedAt: intentAt,
      })
      const parentSnapshot = yield* runtime.load(parent.run.id)
      yield* events.publish(
        AgentRuntime.Event.ChildRunSettlementIntentRecorded,
        {
          runID: parent.run.id,
          sessionID: parent.run.sessionID,
          childRunID: child.run.id,
          idempotencyKey: child.run.child.idempotencyKey,
          intentID: settlement.intentID,
          idempotencyDigest: settlement.idempotencyDigest,
          result,
          intentAt,
        },
        { expectedSequence: parentSnapshot.lastSequence },
      )
      const childSnapshot = yield* runtime.load(child.run.id)
      yield* events.publish(
        AgentRuntime.Event.ChildRunResultRecorded,
        {
          runID: child.run.id,
          parentRunID: parent.run.id,
          sessionID: child.run.sessionID,
          result,
        },
        { expectedSequence: childSnapshot.lastSequence },
      )
      const before = yield* runtime.readChildSettlementFacts({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      expect(before.childResult).toMatchObject({ state: "present", digest: settlement.resultDigest })
      expect(before.parentBudget).toEqual({ state: "missing" })
      expect(yield* runtime.recoverChildren({ parentRunID: parent.run.id })).toBe(0)
      const after = yield* runtime.readChildSettlementFacts({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      expect(after.parentBudget).toMatchObject({ state: "present", identity: child.run.id })
      expect((yield* runtime.load(child.run.id)).lastSequence).toBe(childSnapshot.lastSequence + 1)
    }),
  )

  it.effect("recursively cancels an active descendant and settles its reservation", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "cancel")
      yield* running(runtime, child.run.id)
      yield* runtime.beginAttempt({ runID: child.run.id })

      yield* runtime.cancel({ runID: parent.run.id, reason: "user stopped parent" })

      expect((yield* runtime.load(parent.run.id)).run.status).toBe("cancelled")
      expect((yield* runtime.load(child.run.id)).run.status).toBe("cancelled")
      expect(((yield* runtime.load(parent.run.id)).run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
    }),
  )

  it.effect("requires the immutable parent binding for child cancellation and is idempotent", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "parent-guard")
      yield* running(runtime, child.run.id)
      yield* runtime.beginAttempt({ runID: child.run.id })

      const wrongParent = yield* runtime
        .cancelChild({
          parentRunID: AgentRuntime.RunID.make("run_other-parent"),
          childRunID: child.run.id,
          reason: "forged parent cancellation",
          recursive: true,
        })
        .pipe(Effect.exit)
      expect(String(wrongParent)).toContain("DurableRun.ChildParentMismatchError")
      expect((yield* runtime.load(child.run.id)).run.status).toBe("running")

      const cancelled = yield* runtime.cancelChild({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        reason: "direct parent cancellation",
        recursive: true,
      })
      expect(cancelled.run.status).toBe("cancelled")
      expect(cancelled.run.childResult).toBeUndefined()

      const replay = yield* runtime.cancelChild({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        reason: "replayed direct parent cancellation",
        recursive: true,
      })
      expect(replay.run.status).toBe("cancelled")
      expect(((yield* runtime.load(parent.run.id)).run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
    }),
  )

  it.effect("validates a live SessionRun lease without accepting stale owner or expiry", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)

      const ownerID = "parent-worker"
      const leased = yield* runtime.acquireLease({ runID: parent.run.id, ownerID, ttlMs: 100 })
      const lease = leased.lease
      if (!lease) throw new Error("expected an acquired lease")

      const valid = yield* runtime.validateLease({ runID: parent.run.id, leaseID: lease.id, ownerID })
      expect(valid.run.id).toBe(parent.run.id)
      expect(valid.lease?.id).toBe(lease.id)

      const wrongOwner = yield* runtime
        .validateLease({ runID: parent.run.id, leaseID: lease.id, ownerID: "forged-worker" })
        .pipe(Effect.exit)
      expect(String(wrongOwner)).toContain("DurableRun.LeaseMismatchError")

      yield* runtime.releaseLease({
        runID: parent.run.id,
        leaseID: lease.id,
        ownerID,
        reason: "lease validation test complete",
      })
      const stale = yield* runtime.validateLease({ runID: parent.run.id, leaseID: lease.id, ownerID }).pipe(Effect.exit)
      expect(String(stale)).toContain("DurableRun.LeaseMismatchError")
    }),
  )

  it.effect("durably cancels a child when its deadline prevents a new attempt", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const now = yield* DateTime.now
      const child = yield* createChild(runtime, parent.run.id, "deadline", {
        deadlineAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 100),
      })
      yield* running(runtime, child.run.id)
      yield* TestClock.adjust("101 millis")

      const expired = yield* runtime.beginAttempt({ runID: child.run.id }).pipe(Effect.exit)

      expect(String(expired)).toContain("DurableRun.ChildDeadlineExceededError")
      expect((yield* runtime.load(child.run.id)).run.status).toBe("cancelled")
    }),
  )

  for (const field of [
    "aggregate",
    "identity",
    "parent",
    "project",
    "location",
    "binding",
    "depth",
    "session",
  ] as const)
    it.effect(`rejects a pending child reservation with an invalid ${field} binding`, () =>
      Effect.gen(function* () {
        const runtime = yield* DurableRun.Service
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const parent = yield* createParent(runtime)
        yield* running(runtime, parent.run.id)
        const child = yield* createChild(runtime, parent.run.id, `invalid-${field}`)
        yield* events.remove(child.run.id)
        const row = yield* db
          .select()
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, parent.run.id),
              eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetReserved.type, 1)),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        expect(row).toBeDefined()
        const data = structuredClone(row!.data) as any
        if (field === "aggregate") data.runID = "run_other_parent"
        if (field === "identity") data.childRun.id = "run_other_child"
        if (field === "parent") data.childRun.child.parentRunID = "run_other_parent"
        if (field === "project") data.childRun.project = "other-project"
        if (field === "location") data.childRun.location = "/other-workspace"
        if (field === "binding") data.childRun.child.location = "/other-workspace"
        if (field === "depth") data.childRun.child.depth = 2
        if (field === "session") data.sessionID = "ses_other_parent"
        yield* db.update(EventTable).set({ data }).where(eq(EventTable.id, row!.id)).run().pipe(Effect.orDie)
        const eventsBefore = yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)
        const rejected = yield* runtime.recoverChildren({ parentRunID: parent.run.id }).pipe(Effect.exit)
        expect(String(rejected)).toContain("CorruptHistoryError")
        expect(String(yield* runtime.load(child.run.id).pipe(Effect.exit))).toContain("NotFound")
        expect(yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)).toEqual(
          eventsBefore,
        )
      }),
    )

  for (const drift of ["none", "cycle", "foreign-root", "contract", "workspace"] as const)
    it.effect(`checks the ancestor chain before restoring a grandchild (${drift})`, () =>
      Effect.gen(function* () {
        const runtime = yield* DurableRun.Service
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const root = yield* createParent(runtime)
        yield* running(runtime, root.run.id)
        const parent = yield* createChild(runtime, root.run.id, `ancestor-${drift}`)
        yield* running(runtime, parent.run.id)
        const child = yield* createChild(runtime, parent.run.id, `grandchild-${drift}`)
        yield* events.remove(child.run.id)
        if (drift !== "none") {
          const row = yield* db
            .select()
            .from(EventTable)
            .where(and(eq(EventTable.aggregate_id, parent.run.id), eq(EventTable.seq, 0)))
            .get()
            .pipe(Effect.orDie)
          const data = structuredClone(row!.data) as any
          if (drift === "cycle") data.parentRunID = data.run.child.parentRunID = parent.run.id
          if (drift === "foreign-root") {
            const foreign = yield* createParent(runtime, { location: AbsolutePath.make("/foreign-root") })
            data.parentRunID = data.run.child.parentRunID = foreign.run.id
          }
          if (drift === "contract") data.run.child.delegatedObjective = "changed after admission"
          if (drift === "workspace") data.run.child.location = "/changed-binding"
          yield* db.update(EventTable).set({ data }).where(eq(EventTable.id, row!.id)).run().pipe(Effect.orDie)
        }
        const before = yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)
        const result = yield* runtime.recoverChildren({ parentRunID: parent.run.id }).pipe(Effect.exit)
        if (drift === "none") {
          expect(String(result)).toBe("Success(1)")
          expect((yield* runtime.load(child.run.id)).run).toEqual(child.run)
          expect(yield* runtime.recoverChildren()).toBe(0)
        } else {
          expect(String(result)).toContain("CorruptHistoryError")
          expect(String(yield* runtime.load(child.run.id).pipe(Effect.exit))).toContain("NotFound")
          expect(yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)).toEqual(before)
        }
      }),
    )

  for (const terminal of [false, true])
    for (const drift of ["none", "session", "parent", "contract", "workspace"] as const)
      it.effect(`validates an already published child against its reservation (${drift}, terminal=${terminal})`, () =>
        Effect.gen(function* () {
          const runtime = yield* DurableRun.Service
          const { db } = yield* Database.Service
          const parent = yield* createParent(runtime)
          yield* running(runtime, parent.run.id)
          const child = yield* createChild(runtime, parent.run.id, `existing-${drift}`)
          yield* running(runtime, child.run.id)
          yield* runtime.beginAttempt({ runID: child.run.id })
          if (terminal) {
            yield* runtime.finishAttempt({
              runID: child.run.id,
              attempt: 1,
              outcome: "completed",
              durationMs: 25,
              costMicros: 7,
              tokens: 7,
            })
            yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "ready for recovery settlement" })
          }
          const childBefore = yield* runtime.load(child.run.id)
          const row = yield* db
            .select()
            .from(EventTable)
            .where(and(eq(EventTable.aggregate_id, child.run.id), eq(EventTable.seq, 0)))
            .get()
            .pipe(Effect.orDie)
          const data = structuredClone(row!.data) as any
          if (drift === "session") data.sessionID = data.run.sessionID = "ses_changed_existing"
          if (drift === "parent") data.parentRunID = data.run.child.parentRunID = "run_changed_parent"
          if (drift === "contract") data.run.child.delegatedObjective = "changed existing contract"
          if (drift === "workspace") data.run.location = data.run.child.location = "/changed-existing"
          if (drift !== "none")
            yield* db.update(EventTable).set({ data }).where(eq(EventTable.id, row!.id)).run().pipe(Effect.orDie)
          const before = yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)
          const result = yield* runtime.recoverChildren({ parentRunID: parent.run.id }).pipe(Effect.exit)
          if (drift === "none") {
            expect(String(result)).toBe("Success(0)")
            expect(yield* runtime.load(child.run.id)).toEqual(childBefore)
            if (terminal) {
              const parentAfter = yield* runtime.load(parent.run.id)
              expect((parentAfter.run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
                attempts: 0,
                durationMs: 0,
                costMicros: 0,
                tokens: 0,
              })
              expect(parentAfter.run.budget.costMicrosUsed).toBe(7)
              const after = yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)
              expect(after.length).toBe(before.length + 1)
              expect(yield* runtime.recoverChildren({ parentRunID: parent.run.id })).toBe(0)
              expect(yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)).toEqual(after)
              return
            }
          } else expect(String(result)).toContain("CorruptHistoryError")
          expect(yield* db.select().from(EventTable).orderBy(EventTable.id).all().pipe(Effect.orDie)).toEqual(before)
        }),
      )

  it.effect("repairs the child aggregate after a crash between parent reservation and child creation", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const parent = yield* createParent(runtime)
      yield* running(runtime, parent.run.id)
      const child = yield* createChild(runtime, parent.run.id, "repair")

      yield* events.remove(child.run.id)
      const { AccessDeniedError, CurrentCheck, PendingSession } = yield* Effect.promise(
        () => import("@arforge-ai/core/runtime/subagent-control-access"),
      )
      const parentBefore = yield* runtime.load(parent.run.id)
      let observedSession: string | undefined
      const denied = yield* runtime.recoverChildren({ parentRunID: parent.run.id }).pipe(
        Effect.provideService(
          CurrentCheck,
          Effect.gen(function* () {
            observedSession = yield* PendingSession
            return yield* Effect.fail(new AccessDeniedError())
          }),
        ),
        Effect.exit,
      )
      expect(String(denied)).toContain("outside your authorized scope")
      expect(observedSession).toBe(child.run.sessionID)
      expect(String(yield* runtime.load(child.run.id).pipe(Effect.exit))).toContain("NotFound")
      expect(yield* runtime.load(parent.run.id)).toEqual(parentBefore)
      const repaired = yield* runtime.recoverChildren({ parentRunID: parent.run.id })
      const restored = yield* runtime.load(child.run.id)

      expect(repaired).toBe(1)
      expect((restored.run as AgentRuntime.SessionRun).child?.parentRunID).toBe(parent.run.id)
      expect(restored.lastSequence).toBe(0)
    }),
  )
})
