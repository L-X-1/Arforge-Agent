import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { Location } from "@arforge-ai/core/location"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { DateTime, Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, ActionGateway.node, DurableAction.node]),
  [[Location.node, current]],
)
const it = testEffect(runtimeLayer)

describe("DurableAction", () => {
  type Fixture = {
    readonly actionID: AgentRuntime.ActionID
    readonly sessionID: SessionSchema.ID
    readonly subject: AgentRuntime.SessionSubject
    readonly action: AgentRuntime.SessionAction
  }

  const propose = Effect.fn("DurableActionTest.propose")(function* (riskTier: AgentRuntime.RiskTier = "L0") {
    const events = yield* EventV2.Service
    const actionID = AgentRuntime.ActionID.create()
    const sessionID = SessionSchema.ID.create()
    const now = yield* DateTime.now
    const subject = AgentRuntime.SessionSubject.make({
      type: "session",
      sessionID,
      agent: "build",
      assistantMessageID: SessionMessage.ID.create(),
      toolCallID: `call-${actionID}`,
    })
    const action = AgentRuntime.SessionAction.make({
      id: actionID,
      sessionID,
      subject,
      name: "lease-test",
      status: "proposed",
      semantics: AgentRuntime.EffectSemantics.make({
        riskTier,
        authority: ActionGateway.authorityFor(riskTier),
        idempotency: "idempotent",
        retryability: "safe",
        reversibility: "not_applicable",
        filesystemScope: [],
        networkScope: [],
        secretScope: [],
        externalServices: [],
        expectedArtifacts: [],
        successCriteria: [],
      }),
      resources: [],
      idempotencyKey: actionID,
      intentDigest: "a".repeat(64),
      initiator: "agent",
      authority: ActionGateway.authorityFor(riskTier),
      riskTier,
      reasonSummary: "lease test",
      budget: {
        maxAttempts: 1,
        maxDurationMs: 1,
        maxCostMicros: 1,
        maxTokens: 1_000_000,
        attemptsUsed: 0,
        durationMsUsed: 0,
        costMicrosUsed: 0,
        tokensUsed: 0,
      },
      traceID: actionID,
      visibility: "details",
      time: { created: now, updated: now },
    })
    yield* events.publish(
      AgentRuntime.Event.ActionProposed,
      { actionID, sessionID, subject, action },
      { expectedSequence: -1 },
    )
    return { actionID, sessionID, subject, action }
  })

  const policy = Effect.fn("DurableActionTest.policy")(function* (fixture: Fixture) {
    const events = yield* EventV2.Service
    const decidedAt = yield* DateTime.now
    const decision = AgentRuntime.PolicyDecision.make({
      actionID: fixture.actionID,
      subject: fixture.subject,
      authority: fixture.action.authority,
      riskTier: fixture.action.riskTier,
      decision:
        fixture.action.authority === "forbidden" ? "deny" : fixture.action.authority === "automatic" ? "allow" : "ask",
      reason: "fixture policy",
      policyVersion: ActionGateway.POLICY_VERSION,
      decidedAt,
    })
    yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, {
      actionID: fixture.actionID,
      sessionID: fixture.sessionID,
      subject: fixture.subject,
      decision,
    })
    return decision
  })

  const transition = Effect.fn("DurableActionTest.transition")(function* (
    fixture: Fixture,
    from: AgentRuntime.ActionStatus,
    to: AgentRuntime.ActionStatus,
  ) {
    const events = yield* EventV2.Service
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: fixture.actionID,
      sessionID: fixture.sessionID,
      subject: fixture.subject,
      from,
      to,
      reason: "fixture transition",
      changedAt: yield* DateTime.now,
    })
  })

  const toExecuting = Effect.fn("DurableActionTest.toExecuting")(function* (fixture: Fixture) {
    yield* policy(fixture)
    yield* transition(fixture, "proposed", "policy_evaluated")
    yield* transition(fixture, "policy_evaluated", "authorized")
    yield* transition(fixture, "authorized", "executing")
  })

  const finishAttempt = Effect.fn("DurableActionTest.finishAttempt")(function* (
    fixture: Fixture,
    outcome: "succeeded" | "failed" | "interrupted",
    tokens?: number,
  ) {
    const events = yield* EventV2.Service
    const startedAt = yield* DateTime.now
    yield* events.publish(AgentRuntime.Event.ActionAttemptStarted, {
      actionID: fixture.actionID,
      sessionID: fixture.sessionID,
      subject: fixture.subject,
      attempt: 1,
      startedAt,
    })
    const finishedAt = yield* DateTime.now
    yield* events.publish(AgentRuntime.Event.ActionAttemptFinished, {
      actionID: fixture.actionID,
      sessionID: fixture.sessionID,
      subject: fixture.subject,
      attempt: 1,
      outcome,
      durationMs: DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt),
      costMicros: 0,
      ...(tokens === undefined ? {} : { tokens }),
      finishedAt,
    })
    return finishedAt
  })

  const expectCorrupt = Effect.fn("DurableActionTest.expectCorrupt")(function* (actionID: AgentRuntime.ActionID) {
    const actions = yield* DurableAction.Service
    const loaded = yield* actions.load(actionID).pipe(Effect.exit)
    expect(String(loaded)).toContain("DurableAction.CorruptHistoryError")
  })

  it.effect("replays legacy missing, measured zero, and positive attempt tokens without inventing measurements", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      for (const tokens of [undefined, 0, 58]) {
        const fixture = yield* propose()
        yield* toExecuting(fixture)
        yield* finishAttempt(fixture, "succeeded", tokens)
        expect((yield* actions.load(fixture.actionID)).action.budget.tokensUsed).toBe(tokens ?? 0)
        const row = yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(
            and(eq(EventTable.aggregate_id, fixture.actionID), eq(EventTable.type, "agent.action.attempt-finished.1")),
          )
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing persisted attempt finish")
        expect(Object.hasOwn(row.data, "tokens")).toBe(tokens !== undefined)
      }
    }),
  )

  it.effect("reconstructs and lists the settled action linked to its run", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const context = {
        sessionID: SessionSchema.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-durable-action",
      }
      const runID = AgentRuntime.RunID.create()
      const actionID = ActionGateway.stableActionID(context)

      yield* gateway.execute(
        {
          ...context,
          actionID,
          runID,
          agent: AgentV2.ID.make("build"),
          name: "read",
          resources: ["README.md"],
          semantics: AgentRuntime.EffectSemantics.make({
            riskTier: "L0",
            authority: "automatic",
            idempotency: "idempotent",
            retryability: "safe",
            reversibility: "not_applicable",
            filesystemScope: ["README.md"],
            networkScope: [],
            secretScope: [],
            externalServices: [],
            expectedArtifacts: [],
            successCriteria: ["read succeeds"],
          }),
          reasonSummary: "Read project documentation",
          inputDigest: "digest-durable-action",
        },
        { execute: () => Effect.succeed("content") },
      )

      const loaded = yield* actions.load(actionID)
      const listed = yield* actions.list({ sessionID: context.sessionID, runID })

      expect(loaded.action.status).toBe("settled")
      expect(loaded.action.runID).toBe(runID)
      expect(loaded.observation?.status).toBe("succeeded")
      expect(listed.map((item) => item.action.id)).toEqual([actionID])
    }),
  )

  it.effect("pages durable action proposals with a stable continuation cursor", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const first = yield* propose()
      const second = yield* propose()
      const third = yield* propose()

      const page1 = yield* actions.listPage({ limit: 1 })
      expect(page1.items).toHaveLength(1)
      expect(page1.nextCursor).toBeDefined()

      const page2 = yield* actions.listPage({ limit: 1, cursor: page1.nextCursor })
      expect(page2.items).toHaveLength(1)
      expect(page2.nextCursor).toBeDefined()

      const page3 = yield* actions.listPage({ limit: 1, cursor: page2.nextCursor })
      expect(page3.items).toHaveLength(1)
      expect(page3.nextCursor).toBeUndefined()

      expect(new Set(page1.items.concat(page2.items, page3.items).map((item) => item.action.id))).toEqual(
        new Set([first.actionID, second.actionID, third.actionID]),
      )
      const invalid = yield* actions.listPage({ cursor: "not-a-durable-cursor" }).pipe(Effect.exit)
      expect(String(invalid)).toContain("DurableAction.InvalidListCursorError")
    }),
  )

  it.effect("records read-only reconciliation evidence without executing or changing action status", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const context = {
        sessionID: SessionSchema.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-reconcile-durable",
      }
      const actionID = ActionGateway.stableActionID(context)
      const input = {
        ...context,
        actionID,
        agent: AgentV2.ID.make("build"),
        name: "reconcile-read",
        resources: ["external-operation"],
        semantics: AgentRuntime.EffectSemantics.make({
          riskTier: "L0",
          authority: "automatic",
          idempotency: "idempotent",
          retryability: "safe",
          reversibility: "not_applicable",
          filesystemScope: [],
          networkScope: [],
          secretScope: [],
          externalServices: ["api"],
          expectedArtifacts: [],
          successCriteria: ["operation observed"],
        }),
        reasonSummary: "Check the already completed external operation",
        inputDigest: "reconcile-input",
      } as const
      let executions = 0
      yield* gateway.execute(input, {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "completed"
          }),
      })
      const before = yield* actions.load(actionID)
      const observedAt = yield* DateTime.now
      const decision = {
        kind: "confirmed",
        state: "known_success",
        evidence: {
          state: "known_success",
          evidenceDigest: "b".repeat(64),
          source: "external-api",
          observedAt: DateTime.toEpochMillis(observedAt),
          summary: "The read-only operation lookup confirmed completion.",
        },
        automaticRetryAllowed: false,
        reason: "External state was confirmed; no retry was executed.",
      } as const
      const request = {
        actionID,
        actionKind: "api",
        actionVersion: "1",
        intentDigest: before.action.intentDigest!,
        idempotencyKey: before.action.idempotencyKey,
      }
      const returned = yield* gateway.reconcile(request, decision)
      const replayed = yield* actions.load(actionID)
      expect(executions).toBe(1)
      expect(returned.automaticRetryAllowed).toBe(false)
      expect(replayed.action.status).toBe(before.action.status)
      expect(replayed.lastSequence).toBe(before.lastSequence + 1)
      expect(replayed.reconciliation).toMatchObject({
        actionID,
        intentDigest: before.action.intentDigest,
        idempotencyKey: before.action.idempotencyKey,
        state: "known_success",
        evidenceDigest: "b".repeat(64),
        source: "external-api",
        automaticRetryAllowed: false,
      })
      expect(replayed.reconciliation?.summary).toBe("The read-only operation lookup confirmed completion.")
    }),
  )

  it.effect("rejects drift and forged retry permission before appending reconciliation evidence", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const context = {
        sessionID: SessionSchema.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-reconcile-validation",
      }
      const actionID = ActionGateway.stableActionID(context)
      yield* gateway.execute(
        {
          ...context,
          actionID,
          agent: AgentV2.ID.make("build"),
          name: "reconcile-validation",
          resources: [],
          semantics: AgentRuntime.EffectSemantics.make({
            riskTier: "L0",
            authority: "automatic",
            idempotency: "idempotent",
            retryability: "safe",
            reversibility: "not_applicable",
            filesystemScope: [],
            networkScope: [],
            secretScope: [],
            externalServices: [],
            expectedArtifacts: [],
            successCriteria: [],
          }),
          reasonSummary: "Validate reconciliation input",
          inputDigest: "reconcile-validation-input",
        },
        { execute: () => Effect.succeed(true) },
      )
      const before = yield* actions.load(actionID)
      const request = {
        actionID,
        actionKind: "api",
        actionVersion: "1",
        intentDigest: before.action.intentDigest!,
        idempotencyKey: before.action.idempotencyKey,
      }
      const evidence = {
        state: "unknown",
        evidenceDigest: "c".repeat(64),
        source: "external-api",
        observedAt: DateTime.toEpochMillis(yield* DateTime.now),
        summary: "State remains unknown; operator review is required.",
      } as const
      const forged = yield* gateway
        .reconcile(request, {
          kind: "manual_review",
          state: "unknown",
          evidence,
          automaticRetryAllowed: true,
          reason: "forged retry permission",
        } as never)
        .pipe(Effect.exit)
      expect(forged._tag).toBe("Failure")
      expect(String(forged)).toContain("ActionGateway.InvalidReconciliationError")

      const drifted = yield* gateway
        .reconcile(
          { ...request, intentDigest: "d".repeat(64) },
          {
            kind: "manual_review",
            state: "unknown",
            evidence,
            automaticRetryAllowed: false,
            reason: "operator review required",
          },
        )
        .pipe(Effect.exit)
      expect(drifted._tag).toBe("Failure")
      expect(String(drifted)).toContain("ActionGateway.ActionIntentMismatchError")
      expect((yield* actions.load(actionID)).lastSequence).toBe(before.lastSequence)
    }),
  )

  it.effect("replays reconciliation evidence and makes duplicate recording idempotent", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const fixture = yield* propose()
      const observedAt = yield* DateTime.now
      const record = {
        actionID: fixture.actionID,
        intentDigest: fixture.action.intentDigest!,
        idempotencyKey: fixture.action.idempotencyKey,
        state: "unknown" as const,
        evidenceDigest: "e".repeat(64),
        source: "registry",
        observedAt,
        summary: "No adapter could verify the external state.",
      }
      const first = yield* actions.recordReconciliation(record)
      const replayed = yield* actions.load(fixture.actionID)
      const duplicate = yield* actions.recordReconciliation(record)
      expect(first.reconciliation?.evidenceDigest).toBe("e".repeat(64))
      expect(replayed.reconciliation?.state).toBe("unknown")
      expect(replayed.lastSequence).toBe(first.lastSequence)
      expect(duplicate.lastSequence).toBe(first.lastSequence)
    }),
  )

  it.effect("persists a content-free mutation intent and rejects manifest or phase drift", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const fixture = yield* propose()
      const createdAt = yield* DateTime.now
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "src/index.ts",
          operation: "write",
          beforeDigest: "b".repeat(64),
          afterDigest: "a".repeat(64),
          afterByteLength: 3,
          recovery: "restore-from-volatile-journal",
        },
      ]
      const transactionID = AgentRuntime.MutationTransactionID.create()
      const prepared = AgentRuntime.MutationIntent.make({
        version: 1,
        transactionID,
        actionID: fixture.actionID,
        intentDigest: fixture.action.intentDigest!,
        idempotencyKey: fixture.action.idempotencyKey,
        phase: "prepared",
        entries,
        manifestDigest: MutationIntent.manifestDigest(entries)!,
        automaticRetryAllowed: false,
        createdAt,
        updatedAt: createdAt,
        summary: "volatile mutation journal prepared",
      })
      const first = yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: prepared })
      expect(first.mutationIntent?.phase).toBe("prepared")
      expect(first.mutationIntent?.transactionID).toBe(transactionID)

      const committedAt = DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 1)
      const committed = AgentRuntime.MutationIntent.make({ ...prepared, phase: "committed", updatedAt: committedAt })
      const second = yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: committed })
      const replayed = yield* actions.load(fixture.actionID)
      const duplicate = yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: committed })
      expect(second.mutationIntent?.phase).toBe("committed")
      expect(replayed.mutationIntent?.manifestDigest).toBe(prepared.manifestDigest)
      expect(duplicate.lastSequence).toBe(second.lastSequence)

      const changedEntries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        { ...entries[0]!, target: "src/other.ts" },
      ]
      const changed = AgentRuntime.MutationIntent.make({
        ...committed,
        entries: changedEntries,
        manifestDigest: MutationIntent.manifestDigest(changedEntries)!,
        phase: "postprocessing",
        updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 2),
      })
      const drifted = yield* actions
        .recordMutationIntent({ actionID: fixture.actionID, intent: changed })
        .pipe(Effect.exit)
      expect(drifted._tag).toBe("Failure")
      expect(String(drifted)).toContain("DurableAction.MutationIntentMismatchError")

      const backwards = AgentRuntime.MutationIntent.make({
        ...committed,
        phase: "prepared",
        updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 2),
      })
      const invalidPhase = yield* actions
        .recordMutationIntent({ actionID: fixture.actionID, intent: backwards })
        .pipe(Effect.exit)
      expect(invalidPhase._tag).toBe("Failure")
      expect(String(invalidPhase)).toContain("DurableAction.MutationIntentMismatchError")

      expect(second.lastSequence).toBe(first.lastSequence + 1)
      expect(JSON.stringify(replayed.mutationIntent)).not.toContain("original-file-content")
    }),
  )

  it.effect("persists bounded action progress with monotonic replay and terminal-state fencing", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const fixture = yield* propose()
      yield* toExecuting(fixture)

      const first = yield* actions.recordProgress({
        actionID: fixture.actionID,
        update: { phase: "fetching", completed: 0, total: 2, detail: "Fetching asset 1 of 2" },
      })
      const duplicate = yield* actions.recordProgress({
        actionID: fixture.actionID,
        update: { phase: "fetching", completed: 0, total: 2, detail: "Fetching asset 1 of 2" },
      })
      const second = yield* actions.recordProgress({
        actionID: fixture.actionID,
        update: { phase: "fetching", completed: 1, total: 2, detail: "Fetched asset 1 of 2" },
      })
      const replayed = yield* actions.load(fixture.actionID)

      expect(first.progress).toMatchObject({ phase: "fetching", completed: 0, total: 2, sequence: 0 })
      expect(duplicate.lastSequence).toBe(first.lastSequence)
      expect(second.progress).toMatchObject({ phase: "fetching", completed: 1, total: 2, sequence: 1 })
      expect(replayed.progress?.sequence).toBe(1)
      expect(replayed.progress?.detail).toBe("Fetched asset 1 of 2")

      const invalid = yield* actions
        .recordProgress({
          actionID: fixture.actionID,
          update: { phase: "fetching", completed: 3, total: 2 },
        })
        .pipe(Effect.exit)
      expect(invalid._tag).toBe("Failure")
      expect(String(invalid)).toContain("DurableAction.ProgressMismatchError")

      yield* transition(fixture, "executing", "blocked")
      const afterTerminal = yield* actions
        .recordProgress({
          actionID: fixture.actionID,
          update: { phase: "failed", completed: 0, total: 2 },
        })
        .pipe(Effect.exit)
      expect(afterTerminal._tag).toBe("Failure")
      expect(String(afterTerminal)).toContain("DurableAction.ProgressMismatchError")
    }),
  )

  it.effect("routes mutation intent through ActionGateway without changing action execution state", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const fixture = yield* propose()
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "src/gateway.ts",
          operation: "create",
          afterDigest: "f".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      const now = yield* DateTime.now
      const input = {
        actionID: fixture.actionID,
        transactionID: AgentRuntime.MutationTransactionID.create(),
        phase: "prepared" as const,
        entries,
        manifestDigest: MutationIntent.manifestDigest(entries)!,
        createdAt: now,
        updatedAt: now,
        summary: "gateway-bound mutation intent",
      }
      expect(gateway.recordMutationIntent).toBeDefined()
      const recorded = yield* gateway.recordMutationIntent!(input)
      const duplicate = yield* gateway.recordMutationIntent!(input)
      const replayed = yield* actions.load(fixture.actionID)

      expect(recorded.mutationIntent?.actionID).toBe(fixture.actionID)
      expect(recorded.mutationIntent?.intentDigest).toBe(fixture.action.intentDigest)
      expect(recorded.mutationIntent?.phase).toBe("prepared")
      expect(duplicate.lastSequence).toBe(recorded.lastSequence)
      expect(replayed.action.status).toBe("proposed")
      expect(replayed.mutationIntent?.summary).toBe("gateway-bound mutation intent")
    }),
  )

  it.effect("allows only append-only same-phase post-processing checkpoints", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const fixture = yield* propose()
      const createdAt = yield* DateTime.now
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "src/checkpoint.ts",
          operation: "create",
          afterDigest: "a".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      const transactionID = AgentRuntime.MutationTransactionID.create()
      const base = {
        version: 1 as const,
        transactionID,
        actionID: fixture.actionID,
        intentDigest: fixture.action.intentDigest!,
        idempotencyKey: fixture.action.idempotencyKey,
        entries,
        manifestDigest: MutationIntent.manifestDigest(entries)!,
        automaticRetryAllowed: false as const,
        createdAt,
      }
      const prepared = AgentRuntime.MutationIntent.make({ ...base, phase: "prepared", updatedAt: createdAt })
      yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: prepared })
      const committed = AgentRuntime.MutationIntent.make({
        ...base,
        phase: "committed",
        updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 1),
      })
      yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: committed })
      const started = AgentRuntime.MutationIntent.make({
        ...base,
        phase: "postprocessing",
        updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 2),
        postProcessing: [{ sequence: 0, stage: "formatter", status: "started", target: "src/checkpoint.ts" }],
      })
      const startedSnapshot = yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: started })
      const completed = AgentRuntime.MutationIntent.make({
        ...started,
        updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 3),
        postProcessing: [
          ...started.postProcessing!,
          { sequence: 1, stage: "formatter", status: "completed", target: "src/checkpoint.ts" },
        ],
      })
      const completedSnapshot = yield* actions.recordMutationIntent({ actionID: fixture.actionID, intent: completed })
      expect(completedSnapshot.mutationIntent?.postProcessing).toEqual(completed.postProcessing)
      expect(completedSnapshot.lastSequence).toBe(startedSnapshot.lastSequence + 1)

      const rewritten = AgentRuntime.MutationIntent.make({
        ...completed,
        updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 4),
        postProcessing: [
          { sequence: 0, stage: "bom", status: "started", target: "src/checkpoint.ts" },
          { sequence: 1, stage: "bom", status: "completed", target: "src/checkpoint.ts" },
        ],
      })
      const rejected = yield* actions
        .recordMutationIntent({ actionID: fixture.actionID, intent: rewritten })
        .pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(
        MutationIntent.validate(
          rewritten,
          {
            actionID: fixture.actionID,
            intentDigest: fixture.action.intentDigest!,
            idempotencyKey: fixture.action.idempotencyKey,
          },
          completed,
        ),
      ).toContain("post-processing checkpoints")
    }),
  )

  it.effect("expired action lease is taken over with a new generation and rejects the old identity", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const { actionID } = yield* propose()
      const first = yield* actions.acquireLease({ actionID, ownerID: "worker-a", ttlMs: 1_000 })
      const old = first.snapshot.lease!
      const oldCapability = first.capability!

      yield* TestClock.adjust("1001 millis")
      const second = yield* actions.acquireLease({ actionID, ownerID: "worker-b", ttlMs: 1_000 })
      const replacement = second.snapshot.lease!
      expect(replacement.ownerID).toBe("worker-b")
      expect(replacement.generation).toBe(old.generation + 1)

      const oldAssert = yield* actions.assertLease(oldCapability, { actionID }).pipe(Effect.exit)
      expect(oldAssert._tag).toBe("Failure")
      expect(String(oldAssert)).toContain("DurableAction.InvalidActionLeaseCapabilityError")
    }),
  )

  it.effect("a matching terminal lease can be released and clears the replayed snapshot", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const events = yield* EventV2.Service
      const { actionID, sessionID, subject } = yield* propose()
      const leased = yield* actions.acquireLease({ actionID, ownerID: "worker-a", ttlMs: 1_000 })
      const lease = leased.snapshot.lease!
      const capability = leased.capability!
      const cancelledAt = yield* DateTime.now
      yield* events.publish(
        AgentRuntime.Event.ActionStateChanged,
        {
          actionID,
          sessionID,
          subject,
          from: "proposed",
          to: "cancelled",
          reason: "cancel test",
          changedAt: cancelledAt,
        },
        { expectedSequence: leased.snapshot.lastSequence },
      )
      const released = yield* actions.releaseLease(capability, {
        actionID,
        reason: "terminal cleanup",
      })
      expect(released.action.status).toBe("cancelled")
      expect(released.lease).toBeUndefined()
    }),
  )

  it.effect("wrong lease owner, id, or generation cannot mutate the active lease", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const { actionID } = yield* propose()
      const leased = yield* actions.acquireLease({ actionID, ownerID: "worker-a", ttlMs: 1_000 })
      const capability = leased.capability!
      const other = yield* propose()
      const cloned = { ...capability } as DurableAction.ActionLeaseCapability
      const beforeRejected = (yield* actions.load(actionID)).lastSequence
      const clonedHeartbeat = yield* Effect.exit(actions.heartbeat({ capability: cloned, actionID, ttlMs: 1_000 }))
      expect(clonedHeartbeat._tag).toBe("Failure")
      expect(String(clonedHeartbeat)).toContain("DurableAction.InvalidActionLeaseCapabilityError")
      const wrongAction = yield* Effect.exit(actions.assertLease(capability, { actionID: other.actionID }))
      expect(wrongAction._tag).toBe("Failure")
      expect(String(wrongAction)).toContain("DurableAction.InvalidActionLeaseCapabilityError")
      const clonedRelease = yield* Effect.exit(actions.releaseLease(cloned, { actionID, reason: "forged" }))
      expect(clonedRelease._tag).toBe("Failure")
      expect(String(clonedRelease)).toContain("DurableAction.InvalidActionLeaseCapabilityError")
      const crossLayer = yield* Effect.gen(function* () {
        const otherActions = yield* DurableAction.Service
        return yield* otherActions.assertLease(capability, { actionID })
      }).pipe(Effect.provide(Layer.fresh(runtimeLayer)), Effect.exit)
      expect(crossLayer._tag).toBe("Failure")
      expect(String(crossLayer)).toContain("DurableAction.InvalidActionLeaseCapabilityError")
      expect((yield* actions.load(actionID)).lastSequence).toBe(beforeRejected)
      const rotated = yield* actions.heartbeat({ capability, actionID, ttlMs: 1_000 })
      expect(rotated.capability).toBeDefined()
      const staleHeartbeat = yield* actions.heartbeat({ capability, actionID, ttlMs: 1_000 }).pipe(Effect.exit)
      expect(staleHeartbeat._tag).toBe("Failure")
      expect(String(staleHeartbeat)).toContain("DurableAction.InvalidActionLeaseCapabilityError")
      const lease = rotated.snapshot.lease!
      expect((yield* actions.load(actionID)).lease).toMatchObject({
        id: lease.id,
        ownerID: lease.ownerID,
        generation: lease.generation,
      })
    }),
  )

  it.effect("competing acquires converge through aggregate CAS to one owner", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const { actionID } = yield* propose()
      const exits = yield* Effect.all(
        ["worker-a", "worker-b"].map((ownerID) =>
          actions.acquireLease({ actionID, ownerID, ttlMs: 1_000 }).pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(1)
      expect(exits.filter((exit) => exit._tag === "Failure")).toHaveLength(1)
      expect((yield* actions.load(actionID)).lease?.ownerID).toBe(
        exits.find((exit) => exit._tag === "Success")?._tag === "Success"
          ? exits.find((exit) => exit._tag === "Success")!.value.snapshot.lease!.ownerID
          : undefined,
      )
    }),
  )

  it.effect("fails closed when replay encounters a mismatched or illegal state transition", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const events = yield* EventV2.Service
      const cases = [
        { from: "authorized", to: "executing" },
        { from: "proposed", to: "settled" },
      ] as const

      for (const transition of cases) {
        const { actionID, sessionID, subject } = yield* propose()
        const before = yield* actions.load(actionID)
        yield* events.publish(
          AgentRuntime.Event.ActionStateChanged,
          {
            actionID,
            sessionID,
            subject,
            from: transition.from,
            to: transition.to,
            reason: "forged out-of-band transition",
            changedAt: yield* DateTime.now,
          },
          { expectedSequence: before.lastSequence },
        )
        const replay = yield* actions.load(actionID).pipe(Effect.exit)
        expect(replay._tag).toBe("Failure")
        expect(String(replay)).toContain("DurableAction.CorruptHistoryError")
      }
    }),
  )

  it.effect("fails closed when a second proposal tries to revive a terminal action", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const events = yield* EventV2.Service
      const { actionID, sessionID, subject } = yield* propose()
      const proposed = yield* actions.load(actionID)
      const blockedAt = yield* DateTime.now
      yield* events.publish(
        AgentRuntime.Event.ActionStateChanged,
        {
          actionID,
          sessionID,
          subject,
          from: "proposed",
          to: "blocked",
          reason: "terminal replay guard",
          changedAt: blockedAt,
        },
        { expectedSequence: proposed.lastSequence },
      )
      const blocked = yield* actions.load(actionID)
      if (!("sessionID" in blocked.action)) throw new Error("Expected a session action fixture")
      yield* events.publish(
        AgentRuntime.Event.ActionProposed,
        {
          actionID,
          sessionID,
          subject: blocked.action.subject,
          action: AgentRuntime.SessionAction.make({
            ...blocked.action,
            status: "proposed",
            time: { ...blocked.action.time, updated: yield* DateTime.now },
          }),
        },
        { expectedSequence: blocked.lastSequence },
      )

      const replay = yield* actions.load(actionID).pipe(Effect.flip)
      expect(replay._tag).toBe("DurableAction.CorruptHistoryError")
      if (replay._tag !== "DurableAction.CorruptHistoryError") throw new Error("Expected corrupt history")
      expect(replay.reason).toContain("exactly one proposal")
    }),
  )

  it.effect("fails closed when an aggregate event appears before its proposal", () =>
    Effect.gen(function* () {
      const actions = yield* DurableAction.Service
      const events = yield* EventV2.Service
      const actionID = AgentRuntime.ActionID.create()
      const sessionID = SessionSchema.ID.create()
      yield* events.publish(
        AgentRuntime.Event.ActionStateChanged,
        {
          actionID,
          sessionID,
          from: "proposed",
          to: "blocked",
          reason: "forged event before proposal",
          changedAt: yield* DateTime.now,
        },
        { expectedSequence: -1 },
      )

      const replay = yield* actions.load(actionID).pipe(Effect.flip)
      expect(replay._tag).toBe("DurableAction.CorruptHistoryError")
      if (replay._tag !== "DurableAction.CorruptHistoryError") throw new Error("Expected corrupt history")
      expect(replay.reason).toContain("proposal must be the first")
    }),
  )

  it.effect("reads the raw aggregate and rejects unknown tails, middle gaps, and cross-family events", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const actions = yield* DurableAction.Service

      const unknown = yield* propose()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(EventTable)
              .values({
                id: EventV2.ID.create(),
                aggregate_id: unknown.actionID,
                seq: 1,
                type: "agent.action.unknown-tail.1",
                data: {},
              })
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(EventSequenceTable)
              .set({ seq: 1 })
              .where(eq(EventSequenceTable.aggregate_id, unknown.actionID))
              .run()
              .pipe(Effect.orDie)
          }),
        )
        .pipe(Effect.orDie)
      yield* expectCorrupt(unknown.actionID)

      const gap = yield* propose()
      const acquired = yield* actions.acquireLease({ actionID: gap.actionID, ownerID: "worker", ttlMs: 1_000 })
      const lease = acquired.snapshot.lease!
      yield* actions.heartbeat({
        capability: acquired.capability!,
        actionID: gap.actionID,
        ttlMs: 1_000,
      })
      yield* db
        .delete(EventTable)
        .where(and(eq(EventTable.aggregate_id, gap.actionID), eq(EventTable.seq, 1)))
        .run()
        .pipe(Effect.orDie)
      yield* expectCorrupt(gap.actionID)

      const crossFamily = yield* propose()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(EventTable)
              .values({
                id: EventV2.ID.create(),
                aggregate_id: crossFamily.actionID,
                seq: 1,
                type: EventV2.versionedType(AgentRuntime.Event.RunStateChanged.type, 1),
                data: {},
              })
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(EventSequenceTable)
              .set({ seq: 1 })
              .where(eq(EventSequenceTable.aggregate_id, crossFamily.actionID))
              .run()
              .pipe(Effect.orDie)
          }),
        )
        .pipe(Effect.orDie)
      yield* expectCorrupt(crossFamily.actionID)
    }),
  )

  it.effect("uses strict schemas and rejects excess fields in persisted action events", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const fixture = yield* propose()
      const row = yield* db
        .select({ id: EventTable.id, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, fixture.actionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error("expected proposed action row"))
      yield* db
        .update(EventTable)
        .set({ data: { ...row.data, untrustedExtraField: true } })
        .where(eq(EventTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
      yield* expectCorrupt(fixture.actionID)
    }),
  )

  it.effect("requires one exact policy decision before policy_evaluated", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service

      const missing = yield* propose()
      yield* transition(missing, "proposed", "policy_evaluated")
      yield* expectCorrupt(missing.actionID)

      const duplicate = yield* propose()
      const decision = yield* policy(duplicate)
      yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, {
        actionID: duplicate.actionID,
        sessionID: duplicate.sessionID,
        subject: duplicate.subject,
        decision,
      })
      yield* expectCorrupt(duplicate.actionID)
    }),
  )

  it.effect("requires every subject-bound non-lease event to carry the frozen canonical subject", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service

      const omitted = yield* propose()
      const omittedAt = yield* DateTime.now
      yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, {
        actionID: omitted.actionID,
        sessionID: omitted.sessionID,
        decision: AgentRuntime.PolicyDecision.make({
          actionID: omitted.actionID,
          subject: omitted.subject,
          authority: "automatic",
          riskTier: "L0",
          decision: "allow",
          reason: "outer subject omitted",
          policyVersion: ActionGateway.POLICY_VERSION,
          decidedAt: omittedAt,
        }),
      })
      yield* expectCorrupt(omitted.actionID)

      const mismatched = yield* propose()
      const forgedSubject = AgentRuntime.SessionSubject.make({
        ...mismatched.subject,
        assistantMessageID: SessionMessage.ID.create(),
      })
      const mismatchedAt = yield* DateTime.now
      yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, {
        actionID: mismatched.actionID,
        sessionID: mismatched.sessionID,
        subject: forgedSubject,
        decision: AgentRuntime.PolicyDecision.make({
          actionID: mismatched.actionID,
          subject: forgedSubject,
          authority: "automatic",
          riskTier: "L0",
          decision: "allow",
          reason: "outer subject forged",
          policyVersion: ActionGateway.POLICY_VERSION,
          decidedAt: mismatchedAt,
        }),
      })
      yield* expectCorrupt(mismatched.actionID)
    }),
  )

  it.effect("rejects duplicate grants and binds them to the exact policy and action", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fixture = yield* propose("L2")
      yield* policy(fixture)
      yield* transition(fixture, "proposed", "policy_evaluated")
      yield* transition(fixture, "policy_evaluated", "awaiting_approval")
      const issuedAt = yield* DateTime.now
      const grant = AgentRuntime.SessionGrant.make({
        id: AgentRuntime.AuthorizationGrantID.create(),
        actionID: fixture.actionID,
        toolName: fixture.action.name,
        requests: [{ action: "edit", resources: ["src"] }],
        authority: "scoped_grant",
        riskTier: "L2",
        policyVersion: ActionGateway.POLICY_VERSION,
        bindingDigest: "fixture-binding",
        proofProvider: "fixture",
        proof: "fixture-proof",
        issuedAt,
        expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(issuedAt) + 60_000),
        sessionID: fixture.sessionID,
        agent: fixture.subject.agent,
        assistantMessageID: fixture.subject.assistantMessageID,
        toolCallID: fixture.subject.toolCallID,
        subject: fixture.subject,
      })
      for (let index = 0; index < 2; index++)
        yield* events.publish(AgentRuntime.Event.ActionAuthorizationGranted, {
          actionID: fixture.actionID,
          sessionID: fixture.sessionID,
          subject: fixture.subject,
          grant,
        })
      yield* expectCorrupt(fixture.actionID)
    }),
  )

  it.effect("pairs attempts monotonically and binds observations to the finished outcome", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service

      const active = yield* propose()
      yield* toExecuting(active)
      const startedAt = yield* DateTime.now
      for (let index = 0; index < 2; index++)
        yield* events.publish(AgentRuntime.Event.ActionAttemptStarted, {
          actionID: active.actionID,
          sessionID: active.sessionID,
          subject: active.subject,
          attempt: 1,
          startedAt,
        })
      yield* expectCorrupt(active.actionID)

      const failed = yield* propose()
      yield* toExecuting(failed)
      const finishedAt = yield* finishAttempt(failed, "failed")
      yield* events.publish(AgentRuntime.Event.ActionObserved, {
        actionID: failed.actionID,
        sessionID: failed.sessionID,
        subject: failed.subject,
        observation: AgentRuntime.Observation.make({
          id: AgentRuntime.ObservationID.create(),
          actionID: failed.actionID,
          status: "succeeded",
          summary: "forged success",
          artifactIDs: [],
          observedAt: finishedAt,
        }),
      })
      yield* expectCorrupt(failed.actionID)

      const duplicateObservation = yield* propose()
      yield* toExecuting(duplicateObservation)
      const succeededAt = yield* finishAttempt(duplicateObservation, "succeeded")
      const observation = AgentRuntime.Observation.make({
        id: AgentRuntime.ObservationID.create(),
        actionID: duplicateObservation.actionID,
        status: "succeeded",
        summary: "real success",
        artifactIDs: [],
        observedAt: succeededAt,
      })
      for (let index = 0; index < 2; index++)
        yield* events.publish(AgentRuntime.Event.ActionObserved, {
          actionID: duplicateObservation.actionID,
          sessionID: duplicateObservation.sessionID,
          subject: duplicateObservation.subject,
          observation,
        })
      yield* expectCorrupt(duplicateObservation.actionID)
    }),
  )

  it.effect("cannot project observed or settled state without its matching observation", () =>
    Effect.gen(function* () {
      const fixture = yield* propose()
      yield* toExecuting(fixture)
      yield* finishAttempt(fixture, "succeeded")
      yield* transition(fixture, "executing", "observed")
      yield* expectCorrupt(fixture.actionID)
    }),
  )

  it.effect("rejects overlapping, forged, revived, and time-reversing lease events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const actions = yield* DurableAction.Service

      const overlap = yield* propose()
      const first = (yield* actions.acquireLease({ actionID: overlap.actionID, ownerID: "worker-a", ttlMs: 1_000 }))
        .snapshot.lease!
      yield* events.publish(AgentRuntime.Event.ActionLeaseAcquired, {
        actionID: overlap.actionID,
        lease: AgentRuntime.ActionLease.make({
          ...first,
          id: AgentRuntime.LeaseID.create(),
          ownerID: "worker-b",
          generation: first.generation + 1,
        }),
      })
      yield* expectCorrupt(overlap.actionID)

      const wrongOwner = yield* propose()
      const ownerLease = (yield* actions.acquireLease({
        actionID: wrongOwner.actionID,
        ownerID: "worker-a",
        ttlMs: 1_000,
      })).snapshot.lease!
      yield* events.publish(AgentRuntime.Event.ActionHeartbeatRecorded, {
        actionID: wrongOwner.actionID,
        leaseID: ownerLease.id,
        ownerID: "worker-b",
        generation: ownerLease.generation,
        heartbeatAt: ownerLease.heartbeatAt,
        expiresAt: ownerLease.expiresAt,
      })
      yield* expectCorrupt(wrongOwner.actionID)

      const expired = yield* propose()
      const expiredLease = (yield* actions.acquireLease({
        actionID: expired.actionID,
        ownerID: "worker-a",
        ttlMs: 1_000,
      })).snapshot.lease!
      yield* events.publish(AgentRuntime.Event.ActionHeartbeatRecorded, {
        actionID: expired.actionID,
        leaseID: expiredLease.id,
        ownerID: expiredLease.ownerID,
        generation: expiredLease.generation,
        heartbeatAt: expiredLease.expiresAt,
        expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(expiredLease.expiresAt) + 1_000),
      })
      yield* expectCorrupt(expired.actionID)

      const reversedRelease = yield* propose()
      const releaseLease = (yield* actions.acquireLease({
        actionID: reversedRelease.actionID,
        ownerID: "worker-a",
        ttlMs: 1_000,
      })).snapshot.lease!
      yield* events.publish(AgentRuntime.Event.ActionLeaseReleased, {
        actionID: reversedRelease.actionID,
        leaseID: releaseLease.id,
        ownerID: releaseLease.ownerID,
        generation: releaseLease.generation,
        releasedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(releaseLease.heartbeatAt) - 1),
        reason: "forged time reversal",
      })
      yield* expectCorrupt(reversedRelease.actionID)
    }),
  )
})
