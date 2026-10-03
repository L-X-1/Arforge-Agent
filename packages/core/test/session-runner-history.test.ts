import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionID } from "@arforge-ai/schema/session-id"
import { EventV2 } from "@arforge-ai/core/event"
import * as History from "@arforge-ai/core/session/runner/history"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "bun:test"

const sessionID = SessionID.make("ses_history")
const runID = AgentRuntime.RunID.make("run_history")
const digest = "a".repeat(64)

const formalData = {
  timestamp: 1,
  sessionID,
  runID,
  turnStep: 1,
  attempt: 1,
  schemaVersion: "1.0" as const,
  requestDigest: digest,
  envelope: '{"request":"redacted"}',
}

const matureData = {
  timestamp: 2,
  sessionID,
  runID,
  turnStep: 1,
  attempt: 1,
  schemaVersion: 1 as const,
  runtime: "native" as const,
  mode: "native-envelope" as const,
  requestDigest: digest,
  contextDigest: digest,
  toolSetRevision: digest,
  routeConfigRevision: digest,
  compilerRevision: "mature-request/v1",
}

const terminalRows = (): ReadonlyArray<EventV2.SerializedEvent> => [
  {
    id: EventV2.ID.make("evt_history_terminal_created"),
    aggregateID: runID,
    seq: 0,
    type: EventV2.versionedType(AgentRuntime.Event.RunCreated.type, 1),
    data: {
      runID,
      sessionID,
      run: {
        id: runID,
        sessionID,
        status: "running",
        initiator: "user",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "history collector test",
        budget: {
          maxAttempts: 3,
          maxDurationMs: 30_000,
          maxCostMicros: 5_000,
          maxTokens: 10_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        },
        traceID: "trace_history_terminal",
        visibility: "summary",
        time: { created: 1, updated: 1 },
      },
    },
  },
  {
    id: EventV2.ID.make("evt_history_terminal_attempt"),
    aggregateID: runID,
    seq: 1,
    type: EventV2.versionedType(AgentRuntime.Event.RunAttemptFinished.type, 1),
    data: {
      runID,
      sessionID,
      attempt: 1,
      outcome: "completed",
      durationMs: 1,
      costMicros: 0,
      tokens: 2,
      finishedAt: 3,
    },
  },
  {
    id: EventV2.ID.make("evt_history_terminal_checkpoint"),
    aggregateID: runID,
    seq: 2,
    type: EventV2.versionedType(AgentRuntime.Event.RunCheckpointCreated.type, 1),
    data: {
      runID,
      sessionID,
      checkpoint: {
        id: AgentRuntime.CheckpointID.make("chk_history_terminal"),
        runID,
        eventSequence: 2,
        stateDigest: digest,
        resumeToken: "resume_history_terminal",
        state: { phase: "idle" },
        createdAt: 2,
      },
    },
  },
  {
    id: EventV2.ID.make("evt_history_terminal_state"),
    aggregateID: runID,
    seq: 3,
    type: EventV2.versionedType(AgentRuntime.Event.RunStateChanged.type, 1),
    data: {
      runID,
      sessionID,
      from: "running",
      to: "completed",
      reason: "private terminal reason",
      changedAt: 4,
    },
  },
]

describe("SessionRunner durable history adapter", () => {
  it("retains session sequence validation without mixing requests from different runs", () => {
    const rows = [
      { aggregateID: sessionID, sequence: 0, type: History.runnerHistoryTypes.formalRequest, data: formalData },
      {
        aggregateID: sessionID,
        sequence: 1,
        type: History.runnerHistoryTypes.formalRequest,
        data: { ...formalData, runID: AgentRuntime.RunID.make("run_later"), requestDigest: "b".repeat(64) },
      },
      {
        aggregateID: sessionID,
        sequence: 2,
        type: History.runnerHistoryTypes.matureBinding,
        data: { ...matureData, runID: AgentRuntime.RunID.make("run_later") },
      },
    ]
    const history = History.fromRows(rows, { sessionID, runID })
    expect(history.formalRequest?.requestDigest).toBe(digest)
    expect(history.matureBinding).toBeUndefined()
    expect(History.fromRows(rows, { sessionID, runID: "run_missing" }).formalRequest).toBeUndefined()
    expect(() => History.fromRows([rows[0], rows[2]], { sessionID, runID })).toThrow("not contiguous")
    expect(() =>
      History.fromRows([{ ...rows[0], data: { ...formalData, sessionID: "ses_foreign" } }], { sessionID, runID }),
    ).toThrow("identity")
  })

  it("decodes formal and mature metadata from immutable event rows", () => {
    const history = History.fromRows(
      [
        {
          aggregateID: sessionID,
          sequence: 0,
          type: History.runnerHistoryTypes.formalRequest,
          data: formalData,
        },
        {
          aggregateID: sessionID,
          sequence: 1,
          type: History.runnerHistoryTypes.matureBinding,
          data: matureData,
        },
      ],
      { sessionID, runID },
    )

    expect(history.formalRequest).toMatchObject({ runID, turnStep: 1, attempt: 1 })
    expect(history.matureBinding).toMatchObject({ runID, turnStep: 1, attempt: 1, runtime: "native" })
    expect(history.attempts).toEqual([])
    expect(Object.isFrozen(history)).toBe(true)
    expect(Object.isFrozen(history.attempts)).toBe(true)
  })

  it("accepts committed EventV2 rows through one strict serialized-row adapter", () => {
    const history = History.fromEventRows(
      [
        {
          id: EventV2.ID.make("evt_history_formal"),
          aggregateID: sessionID,
          seq: 0,
          type: History.runnerHistoryTypes.formalRequest,
          data: formalData,
        },
      ],
      { sessionID, runID },
    )

    expect(history.formalRequest).toMatchObject({ runID, turnStep: 1, attempt: 1 })
    expect(() =>
      History.fromEventRows(
        [
          {
            id: "not-an-event-id" as EventV2.ID,
            aggregateID: sessionID,
            seq: 0,
            type: History.runnerHistoryTypes.formalRequest,
            data: formalData,
          },
        ],
        { sessionID, runID },
      ),
    ).toThrow("Serialized EventV2 runner row is invalid")
  })

  it("keeps the committed row source injectable without changing history ownership", () => {
    const queries: History.RunnerEventQuery[] = []
    const source = History.makeRunnerEventRowSource((input) => {
      queries.push(input)
      return Effect.succeed([
        {
          id: EventV2.ID.make("evt_history_source"),
          aggregateID: runID,
          seq: 0,
          type: "runner.synthetic.1",
          data: {},
        },
      ])
    })

    const rows = Effect.runSync(source.collect({ sessionID, runID }))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.aggregateID).toBe(runID)
    expect(queries).toEqual([{ sessionID, runID }])
    expect(Object.isFrozen(source)).toBe(true)

    const unavailable = History.runnerEventRowSourceFromEventV2({})
    const unavailableExit = Effect.runSync(unavailable.collect({ sessionID, runID }).pipe(Effect.exit))
    expect(String(unavailableExit)).toContain("EventV2 serialized reader is unavailable")
  })

  it("keeps logical owner projections isolated while validating the shared session sequence", () => {
    const historyRows = [
      {
        id: EventV2.ID.make("evt_history_formal_owner"),
        aggregateID: sessionID,
        seq: 0,
        type: History.runnerHistoryTypes.formalRequest,
        data: formalData,
      },
      {
        id: EventV2.ID.make("evt_history_mature_owner"),
        aggregateID: sessionID,
        seq: 1,
        type: History.runnerHistoryTypes.matureBinding,
        data: matureData,
      },
    ]

    const formal = History.fromEventRows(historyRows, { sessionID, runID, owner: "formal" })
    const mature = History.fromEventRows(historyRows, { sessionID, runID, owner: "mature" })
    expect(formal.formalRequest).toBeDefined()
    expect(formal.matureBinding).toBeUndefined()
    expect(mature.formalRequest).toBeUndefined()
    expect(mature.matureBinding).toBeDefined()
  })

  it("rejects gaps and malformed recognized rows before evidence projection", () => {
    expect(() =>
      History.fromRows(
        [
          { aggregateID: sessionID, sequence: 0, type: "session.next.synthetic.1", data: {} },
          { aggregateID: sessionID, sequence: 2, type: History.runnerHistoryTypes.formalRequest, data: formalData },
        ],
        { sessionID, runID },
      ),
    ).toThrow("not contiguous")

    expect(() =>
      History.fromRows(
        [
          {
            aggregateID: sessionID,
            sequence: 0,
            type: History.runnerHistoryTypes.formalRequest,
            data: { ...formalData, requestDigest: "invalid", envelope: "secret prompt" },
          },
        ],
        { sessionID, runID },
      ),
    ).toThrow("failed strict schema decoding")
    try {
      History.fromRows(
        [
          {
            aggregateID: sessionID,
            sequence: 0,
            type: History.runnerHistoryTypes.formalRequest,
            data: { ...formalData, requestDigest: "invalid", envelope: "secret prompt" },
          },
        ],
        { sessionID, runID },
      )
    } catch (error) {
      expect(String(error)).not.toContain("secret prompt")
    }
  })

  it("does not compose evidence when durable cursor or owner events are missing", () => {
    const history = History.fromRows(
      [
        {
          aggregateID: sessionID,
          sequence: 0,
          type: History.runnerHistoryTypes.formalRequest,
          data: formalData,
        },
        {
          aggregateID: sessionID,
          sequence: 1,
          type: History.runnerHistoryTypes.matureBinding,
          data: matureData,
        },
      ],
      { sessionID, runID },
    )

    expect(() => History.checkpointFromHistory(history)).toThrow("missing a semantic checkpoint")
    expect(() => History.formalEvidenceFromHistory(history)).toThrow("missing a semantic checkpoint")
    expect(() => History.matureEvidenceFromHistory(history)).toThrow("missing a semantic checkpoint")
  })

  it("requires the committed terminal transition and settled attempt to agree", () => {
    const history = {
      sessionID,
      runID,
      runCreated: {} as History.RunnerHistory["runCreated"],
      stateChanges: [
        {
          runID,
          sessionID,
          from: "running" as const,
          to: "completed" as const,
          reason: "done",
          changedAt: DateTime.makeUnsafe(4),
        },
      ],
      checkpoint: {} as History.RunnerHistory["checkpoint"],
      attempts: [
        {
          runID,
          sessionID,
          attempt: 1,
          outcome: "completed" as const,
          durationMs: 1,
          costMicros: 0,
          tokens: 2,
          finishedAt: DateTime.makeUnsafe(3),
        },
      ],
      formalRequest: undefined,
      matureBinding: undefined,
    } satisfies History.RunnerHistory

    const summary = History.assertTerminalHistory(history, { status: "completed", attempt: 1 })
    expect(summary).toMatchObject({
      sessionID,
      runID,
      status: "completed",
      attempt: 1,
      checkpointPresent: true,
    })
    expect(Object.isFrozen(summary)).toBe(true)
    expect(summary.transition).toMatchObject({ from: "running", to: "completed" })
    expect(summary.transition).not.toHaveProperty("reason")

    expect(() => History.assertTerminalHistory(history, { status: "failed", attempt: 1 })).toThrow(
      "state transition does not match",
    )
    expect(() =>
      History.assertTerminalHistory({ ...history, checkpoint: undefined }, { status: "completed", attempt: 1 }),
    ).toThrow("missing the semantic checkpoint")
  })

  it("caches the validated committed source for trusted settlement collectors", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rows = terminalRows()
        let reads = 0
        const source = History.makeRunnerEventRowSource(() =>
          Effect.sync(() => {
            reads += 1
            return rows
          }),
        )

        const collection = yield* History.collectTerminalHistoryWithSource(
          source,
          { sessionID, runID },
          { status: "completed", attempt: 1 },
        )
        expect(collection.summary).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })

        const replayed = yield* collection.source.collect({ sessionID, runID })
        expect(replayed).toEqual(rows)
        expect(Object.isFrozen(replayed)).toBe(true)
        expect(Object.isFrozen(replayed[0])).toBe(true)
        expect(reads).toBe(1)
        const wrongPair = yield* collection.source
          .collect({ sessionID, runID: AgentRuntime.RunID.make("run_history_other") })
          .pipe(Effect.exit)
        expect(String(wrongPair)).toContain("scoped to its settled session/run pair")
      }),
    ))

  it("fails closed instead of overflowing cumulative usage during budget folding", () => {
    const budget = AgentRuntime.Budget.make({
      maxAttempts: Number.MAX_SAFE_INTEGER,
      maxDurationMs: Number.MAX_SAFE_INTEGER,
      maxCostMicros: Number.MAX_SAFE_INTEGER,
      maxTokens: Number.MAX_SAFE_INTEGER,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    })
    expect(() =>
      History.budgetFromHistory({
        runCreated: { run: { budget } } as never,
        attempts: [
          { attempt: 1, durationMs: Number.MAX_SAFE_INTEGER, costMicros: 0, tokens: 0 } as never,
          { attempt: 2, durationMs: 1, costMicros: 0, tokens: 0 } as never,
        ],
      }),
    ).toThrow("durationMs usage exceeds safe integer")

    const initialHighWatermark = AgentRuntime.Budget.make({
      maxAttempts: 3,
      maxDurationMs: Number.MAX_SAFE_INTEGER,
      maxCostMicros: 5_000,
      maxTokens: 10_000,
      attemptsUsed: 0,
      durationMsUsed: Number.MAX_SAFE_INTEGER,
      costMicrosUsed: 0,
      tokensUsed: 0,
    })
    expect(() =>
      History.budgetFromHistory({
        runCreated: { run: { budget: initialHighWatermark } } as never,
        attempts: [{ attempt: 1, durationMs: 1, costMicros: 0, tokens: 0 } as never],
      }),
    ).toThrow("durationMs usage exceeds safe integer")

    expect(() =>
      History.budgetFromHistory({
        runCreated: { run: { budget } } as never,
        attempts: [{ attempt: 2, durationMs: 0, costMicros: 0, tokens: 0 } as never],
      }),
    ).toThrow("attempt sequence has a gap or rollback")

    expect(() =>
      History.budgetFromHistory({
        runCreated: { run: { budget } } as never,
        attempts: [{ attempt: 0, durationMs: 0, costMicros: 0, tokens: 0 } as never],
      }),
    ).toThrow("attempt sequence has a gap or rollback")
  })

  it("projects execution evidence through the history owner without side reuse", () => {
    const budget = AgentRuntime.Budget.make({
      maxAttempts: 3,
      maxDurationMs: 30_000,
      maxCostMicros: 5_000,
      maxTokens: 10_000,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    })
    const checkpoint = SessionCheckpoint.make({
      sessionID,
      nextStep: 2,
      needsContinuation: false,
      lastTurn: {
        turnStep: 1,
        requestDigest: digest,
        contextDigest: digest,
        toolSetRevision: digest,
        routeConfigRevision: digest,
        compilerRevision: "history-test/v1",
      },
    })
    const evidence = History.executionEvidenceFromHistory({
      sessionID,
      checkpoint: { checkpoint: { state: checkpoint } } as never,
      runCreated: { run: { budget } } as never,
      attempts: [],
    })

    expect(evidence.checkpoint.nextStep).toBe(2)
    expect(evidence.budget.maxAttempts).toBe(3)
    expect(Object.isFrozen(evidence)).toBe(true)
  })

  it("rejects a provider request projection owned by another run", () => {
    expect(() =>
      History.evidenceFromHistories({
        provider: { runID } as never,
        formal: {} as never,
        mature: {} as never,
        providerRequest: {
          schemaVersion: 1,
          runID: "run_other",
          turnStep: 1,
          attempt: 1,
          requestDigest: digest,
          contextDigest: digest,
          toolSetRevision: digest,
          routeConfigRevision: digest,
          compilerRevision: "history-test/v1",
        },
      }),
    ).toThrow("does not match the provider history")
  })
})
