import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime, Effect } from "effect"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"

const makeEntry = (target = "src/index.ts"): AgentRuntime.MutationIntentEntry => ({
  target,
  operation: "write",
  beforeDigest: "b".repeat(64),
  afterDigest: "a".repeat(64),
  afterByteLength: 3,
  recovery: "restore-from-volatile-journal",
})

const makeIntent = (options?: {
  readonly actionID?: AgentRuntime.ActionID
  readonly phase?: AgentRuntime.MutationIntentPhase
  readonly entries?: ReadonlyArray<AgentRuntime.MutationIntentEntry>
  readonly updatedAt?: DateTime.Utc
}) => {
  const actionID = options?.actionID ?? AgentRuntime.ActionID.create()
  const entries = options?.entries ?? [makeEntry()]
  const now = DateTime.makeUnsafe(1_000)
  return AgentRuntime.MutationIntent.make({
    version: 1,
    transactionID: AgentRuntime.MutationTransactionID.create(),
    actionID,
    intentDigest: "d".repeat(64),
    idempotencyKey: `idem-${actionID}`,
    phase: options?.phase ?? "prepared",
    entries,
    manifestDigest: MutationIntent.manifestDigest(entries)!,
    automaticRetryAllowed: false,
    createdAt: now,
    updatedAt: options?.updatedAt ?? now,
  })
}

describe("MutationIntent", () => {
  it("hashes only the metadata manifest and rejects tampering", () => {
    const entries = [makeEntry()]
    const digest = MutationIntent.manifestDigest(entries)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(MutationIntent.manifestDigest([makeEntry("src/other.ts")])).not.toBe(digest)

    const intent = makeIntent({ entries })
    expect(JSON.stringify(intent)).not.toContain("original-file-content")
    expect(
      MutationIntent.validate(intent, {
        actionID: intent.actionID,
        intentDigest: intent.intentDigest,
        idempotencyKey: intent.idempotencyKey,
      }),
    ).toBeUndefined()

    const changed = AgentRuntime.MutationIntent.make({
      ...intent,
      manifestDigest: digest!,
      entries: [makeEntry("src/other.ts")],
    })
    expect(
      MutationIntent.validate(changed, {
        actionID: intent.actionID,
        intentDigest: intent.intentDigest,
        idempotencyKey: intent.idempotencyKey,
      }),
    ).toContain("manifest digest")

    const artifactEntry: AgentRuntime.MutationIntentEntry = {
      ...makeEntry(),
      recovery: "restore-from-artifact",
      rollbackArtifact: {
        version: 1,
        artifactID: `rollback-${"b".repeat(64)}`,
        digest: "b".repeat(64),
        byteLength: 3,
      },
    }
    const artifactIntent = makeIntent({ entries: [artifactEntry] })
    expect(
      MutationIntent.validate(artifactIntent, {
        actionID: artifactIntent.actionID,
        intentDigest: artifactIntent.intentDigest,
        idempotencyKey: artifactIntent.idempotencyKey,
      }),
    ).toBeUndefined()
    const forgedArtifact = AgentRuntime.MutationIntent.make({
      ...artifactIntent,
      entries: [
        {
          ...artifactEntry,
          rollbackArtifact: { ...artifactEntry.rollbackArtifact!, artifactID: `rollback-${"a".repeat(64)}` },
        },
      ],
      manifestDigest: MutationIntent.manifestDigest([
        {
          ...artifactEntry,
          rollbackArtifact: { ...artifactEntry.rollbackArtifact!, artifactID: `rollback-${"a".repeat(64)}` },
        },
      ])!,
    })
    expect(
      MutationIntent.validate(forgedArtifact, {
        actionID: forgedArtifact.actionID,
        intentDigest: forgedArtifact.intentDigest,
        idempotencyKey: forgedArtifact.idempotencyKey,
      }),
    ).toContain("artifact ID")
  })

  it("allows only deterministic phase advancement and classifies restart conservatively", () => {
    const prepared = makeIntent()
    const committed = AgentRuntime.MutationIntent.make({
      ...prepared,
      phase: "committed",
      updatedAt: DateTime.makeUnsafe(2_000),
    })
    expect(
      MutationIntent.validate(
        committed,
        {
          actionID: prepared.actionID,
          intentDigest: prepared.intentDigest,
          idempotencyKey: prepared.idempotencyKey,
        },
        prepared,
      ),
    ).toBeUndefined()
    const stale = AgentRuntime.MutationIntent.make({ ...prepared, phase: "settled" })
    expect(
      MutationIntent.validate(
        stale,
        {
          actionID: prepared.actionID,
          intentDigest: prepared.intentDigest,
          idempotencyKey: prepared.idempotencyKey,
        },
        prepared,
      ),
    ).toContain("cannot transition")

    const recovery = MutationIntent.projectRecovery(committed)
    expect(recovery.decision).toBe("inspect")
    expect(recovery.automaticRetryAllowed).toBe(false)
    expect(recovery.reason).toContain("inspect")
  })

  it("keeps post-processing checkpoints append-only and pairs started/completed stages", () => {
    const committed = makeIntent({ phase: "committed", updatedAt: DateTime.makeUnsafe(2_000) })
    const started = AgentRuntime.MutationIntent.make({
      ...committed,
      phase: "postprocessing",
      updatedAt: DateTime.makeUnsafe(2_001),
      postProcessing: [{ sequence: 0, stage: "formatter", status: "started", target: "src/index.ts" }],
    })
    expect(
      MutationIntent.validate(
        started,
        {
          actionID: committed.actionID,
          intentDigest: committed.intentDigest,
          idempotencyKey: committed.idempotencyKey,
        },
        committed,
      ),
    ).toBeUndefined()

    const completed = AgentRuntime.MutationIntent.make({
      ...started,
      updatedAt: DateTime.makeUnsafe(2_002),
      postProcessing: [{ sequence: 0, stage: "bom", status: "started", target: "src/index.ts" }],
    })
    expect(
      MutationIntent.validate(
        completed,
        {
          actionID: committed.actionID,
          intentDigest: committed.intentDigest,
          idempotencyKey: committed.idempotencyKey,
        },
        started,
      ),
    ).toContain("rewrite or remove")

    const completedByAppend = AgentRuntime.MutationIntent.make({
      ...started,
      updatedAt: DateTime.makeUnsafe(2_002),
      postProcessing: [
        ...started.postProcessing!,
        { sequence: 1, stage: "formatter", status: "completed", target: "src/index.ts" },
      ],
    })
    expect(
      MutationIntent.validate(
        completedByAppend,
        {
          actionID: committed.actionID,
          intentDigest: committed.intentDigest,
          idempotencyKey: committed.idempotencyKey,
        },
        started,
      ),
    ).toBeUndefined()
    expect(MutationIntent.canAppendPostProcessing(started, completedByAppend)).toBe(true)
    expect(MutationIntent.projectRecovery(completedByAppend).postProcessing).toEqual(completedByAppend.postProcessing!)

    const overlapping = AgentRuntime.MutationIntent.make({
      ...completedByAppend,
      updatedAt: DateTime.makeUnsafe(2_003),
      postProcessing: [
        ...completedByAppend.postProcessing!,
        { sequence: 2, stage: "diagnostics", status: "started" },
        { sequence: 3, stage: "watcher", status: "started" },
      ],
    })
    expect(
      MutationIntent.validate(
        overlapping,
        {
          actionID: committed.actionID,
          intentDigest: committed.intentDigest,
          idempotencyKey: committed.idempotencyKey,
        },
        completedByAppend,
      ),
    ).toContain("cannot start before")
  })

  it("classifies the side-effect/settlement gap from the durable checkpoint chain", () => {
    const committed = makeIntent({ phase: "committed" })
    expect(MutationIntent.postProcessingRecoveryOf(committed)).toEqual({
      status: "not_started",
      reason: expect.stringContaining("not entered"),
    })

    const started = AgentRuntime.MutationIntent.make({
      ...committed,
      phase: "postprocessing",
      updatedAt: DateTime.makeUnsafe(2_001),
      postProcessing: [{ sequence: 0, stage: "lsp_touch", status: "started", target: "src/index.ts" }],
    })
    expect(MutationIntent.postProcessingRecoveryOf(started)).toEqual({
      status: "in_flight",
      stage: "lsp_touch",
      target: "src/index.ts",
      sequence: 0,
      reason: expect.stringContaining("may have completed"),
    })

    const completed = AgentRuntime.MutationIntent.make({
      ...started,
      updatedAt: DateTime.makeUnsafe(2_002),
      postProcessing: [
        ...started.postProcessing!,
        { sequence: 1, stage: "lsp_touch", status: "completed", target: "src/index.ts" },
      ],
    })
    expect(MutationIntent.postProcessingRecoveryOf(completed).status).toBe("completed_unsettled")

    expect(
      MutationIntent.postProcessingRecoveryOf(
        AgentRuntime.MutationIntent.make({ ...completed, phase: "settled", updatedAt: DateTime.makeUnsafe(2_003) }),
      ).status,
    ).toBe("settled")
    expect(
      MutationIntent.postProcessingRecoveryOf(
        AgentRuntime.MutationIntent.make({
          ...completed,
          phase: "rolled_back",
          updatedAt: DateTime.makeUnsafe(2_003),
        }),
      ).status,
    ).toBe("rolled_back")
    expect(MutationIntent.projectRecovery(started).postProcessingRecovery.status).toBe("in_flight")
  })

  it("classifies fresh post-restart images without authorizing retry", () => {
    const intent = makeIntent({ phase: "outcome_unknown" })
    const postimage = MutationIntent.inspect(intent, [
      {
        target: "src/index.ts",
        present: true,
        digest: "a".repeat(64),
        byteLength: 3,
      },
    ])
    expect(postimage.decision).toBe("postimage_matches")
    expect(postimage.entries[0]?.state).toBe("postimage_matches")
    expect(postimage.automaticRetryAllowed).toBe(false)
    expect(postimage.reason).toContain("postimage")

    const preimage = MutationIntent.inspect(intent, [
      {
        target: "src/index.ts",
        present: true,
        digest: "b".repeat(64),
        byteLength: 3,
      },
    ])
    expect(preimage.decision).toBe("preimage_matches")

    const mixed = MutationIntent.inspect(intent, [])
    expect(mixed.decision).toBe("manual_review")
    expect(mixed.entries[0]?.state).toBe("unobserved")
    expect(JSON.stringify(mixed)).not.toContain("original-file-content")
  })

  it("keeps workspace fingerprint observation in the Core mutation owner", async () => {
    const intent = makeIntent({ phase: "outcome_unknown" })
    const projection = await Effect.runPromise(
      FileMutation.inspectIntent({
        files: {
          fingerprint: ({ target }) =>
            Effect.succeed({
              digest: "a".repeat(64),
              size: 3,
              mode: 0o644,
              identity: target.resource,
              mtimeMs: 1,
            }),
        },
        worktree: process.cwd(),
        intent,
      }),
    )
    expect(projection.decision).toBe("postimage_matches")
    expect(projection.entries[0]?.target).toBe("src/index.ts")
    expect(projection.automaticRetryAllowed).toBe(false)
  })

  it("binds human review decisions to the fresh inspection and legal phase transition", () => {
    const committed = makeIntent({ phase: "committed", updatedAt: DateTime.makeUnsafe(2_000) })
    expect(
      MutationIntent.validateReview(
        {
          transactionID: committed.transactionID,
          expectedPhase: "committed",
          decision: "settle_postimage",
          inspectedDecision: "postimage_matches",
          observationDigest: "a".repeat(64),
          reviewedAt: DateTime.makeUnsafe(2_001),
        },
        committed,
      ),
    ).toBeUndefined()
    expect(MutationIntent.reviewPhase("confirm_rolled_back")).toBe("rolled_back")
    expect(
      MutationIntent.validateReview(
        {
          transactionID: committed.transactionID,
          expectedPhase: "committed",
          decision: "settle_postimage",
          inspectedDecision: "preimage_matches",
          observationDigest: "a".repeat(64),
          reviewedAt: DateTime.makeUnsafe(2_001),
        },
        committed,
      ),
    ).toContain("fresh fingerprint inspection")
    expect(
      MutationIntent.validateReview(
        {
          transactionID: committed.transactionID,
          expectedPhase: "committed",
          decision: "confirm_rolled_back",
          inspectedDecision: "preimage_matches",
          observationDigest: "a".repeat(64),
          reviewedAt: DateTime.makeUnsafe(2_001),
        },
        committed,
      ),
    ).toContain("cannot transition")
    expect(
      MutationIntent.validateReview(
        {
          transactionID: committed.transactionID,
          expectedPhase: "committed",
          decision: "settle_postimage",
          inspectedDecision: "postimage_matches",
          observationDigest: "not-a-sha256-digest",
          reviewedAt: DateTime.makeUnsafe(2_001),
        },
        committed,
      ),
    ).toContain("observation digest is invalid")
  })
})
