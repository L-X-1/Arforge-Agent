import { describe, expect, it } from "bun:test"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime, Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  intentEntry,
  inspectMutationIntent,
  inspectMutationProjection,
  makeIntentRecorder,
  recordBestEffort,
  runPostProcessingStage,
  runPostProcessingTransaction,
  stageIntentEntries,
  target,
} from "../../src/tool/file-mutation"
import type { MutationIntentRecorder, MutationJournal } from "../../src/tool/file-mutation"

describe("tool.file-mutation durable intent bridge", () => {
  it("stages inverse bytes before prepared and records only an immutable artifact reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-rollback-stage-"))
    try {
      const before = new TextEncoder().encode("raw-before-content")
      const [entry] = await Effect.runPromise(
        stageIntentEntries([
          {
            target: target("C:\\worktree", "C:\\worktree\\src\\main.ts"),
            operation: "write",
            before,
            after: new TextEncoder().encode("raw-after-content"),
            recovery: "restore-from-volatile-journal",
          },
        ]).pipe(Effect.provide(RollbackArtifact.layerWith(root))),
      )

      expect(entry?.recovery).toBe("restore-from-artifact")
      expect(entry?.rollbackArtifact?.artifactID).toBe(`rollback-${entry?.beforeDigest}`)
      expect(entry?.rollbackArtifact?.byteLength).toBe(before.byteLength)
      expect(JSON.stringify(entry)).not.toContain("raw-before-content")
      const stored = await new RollbackArtifact.RollbackArtifactStore({ root }).read(entry!.rollbackArtifact!)
      expect(new TextDecoder().decode(stored.content)).toBe("raw-before-content")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails closed before prepared when inverse artifact staging exceeds the quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-rollback-stage-limit-"))
    try {
      const result = await Effect.runPromiseExit(
        stageIntentEntries([
          {
            target: target("C:\\worktree", "C:\\worktree\\src\\main.ts"),
            operation: "write",
            before: new TextEncoder().encode("too-large-for-this-store"),
            after: new TextEncoder().encode("next"),
            recovery: "restore-from-volatile-journal",
          },
        ]).pipe(Effect.provide(RollbackArtifact.layerWith(root, 1))),
      )
      expect(result._tag).toBe("Failure")
      expect(JSON.stringify(result)).toContain("too_large")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("binds all phases to one gateway transaction without storing file bytes", async () => {
    const entries = [
      intentEntry({
        target: target("C:\\worktree", "C:\\worktree\\src\\main.ts"),
        operation: "write",
        before: new TextEncoder().encode("raw-before-content"),
        after: new TextEncoder().encode("raw-after-content"),
        recovery: "restore-from-volatile-journal",
      }),
    ]
    const records: Array<
      NonNullable<ActionGateway.Interface["recordMutationIntent"]> extends (input: infer Input) => unknown
        ? Input
        : never
    > = []
    const gateway: Pick<ActionGateway.Interface, "recordMutationIntent"> = {
      recordMutationIntent: (input) => {
        records.push(input)
        return Effect.succeed({} as DurableAction.Snapshot)
      },
    }
    const recorder = makeIntentRecorder({
      gateway,
      actionID: AgentRuntime.ActionID.create(),
      entries,
    })

    expect(recorder).toBeDefined()
    await Effect.runPromise(recorder!.record("prepared", "prepared"))
    await Effect.runPromise(recorder!.record("committed", "committed"))

    expect(records).toHaveLength(2)
    expect(records[0]!.transactionID).toBe(records[1]!.transactionID)
    expect(records[0]!.manifestDigest).toBe(records[1]!.manifestDigest)
    expect(records[0]!.entries).toEqual(entries)
    expect(JSON.stringify(records[0])).not.toContain("raw-before-content")
    expect(JSON.stringify(records[0])).not.toContain("raw-after-content")
    expect(records[0]!.phase).toBe("prepared")
    expect(records[1]!.phase).toBe("committed")
  })

  it("does not interrupt rollback when best-effort durable recording defects", async () => {
    const gateway: Pick<ActionGateway.Interface, "recordMutationIntent"> = {
      recordMutationIntent: () => Effect.die(new Error("durable store unavailable")),
    }
    const recorder = makeIntentRecorder({
      gateway,
      actionID: AgentRuntime.ActionID.create(),
      entries: [
        intentEntry({
          target: target("C:\\worktree", "C:\\worktree\\new.ts"),
          operation: "create",
          after: new TextEncoder().encode("new"),
          recovery: "remove-if-matching",
        }),
      ],
    })

    await Effect.runPromise(recordBestEffort(recorder, "rollback_required", "recover"))
    expect(recorder).toBeDefined()
  })

  it("persists immutable append-only semantic checkpoints for each side-effect stage", async () => {
    const entries = [
      intentEntry({
        target: target("C:\\worktree", "C:\\worktree\\src\\main.ts"),
        operation: "write",
        before: new TextEncoder().encode("before"),
        after: new TextEncoder().encode("after"),
        recovery: "restore-from-volatile-journal",
      }),
    ]
    const records: Array<
      NonNullable<ActionGateway.Interface["recordMutationIntent"]> extends (input: infer Input) => unknown
        ? Input
        : never
    > = []
    const gateway: Pick<ActionGateway.Interface, "recordMutationIntent"> = {
      recordMutationIntent: (input) => {
        records.push(input)
        return Effect.succeed({} as DurableAction.Snapshot)
      },
    }
    const recorder = makeIntentRecorder({ gateway, actionID: AgentRuntime.ActionID.create(), entries })!

    await Effect.runPromise(recorder.record("prepared", "prepared"))
    await Effect.runPromise(recorder.record("committed", "committed"))
    await Effect.runPromise(recorder.recordPostProcessingStage!("formatter", "started", "src/main.ts"))
    await Effect.runPromise(recorder.recordPostProcessingStage!("formatter", "completed", "src/main.ts"))

    expect(records.map((record) => record.phase)).toEqual(["prepared", "committed", "postprocessing", "postprocessing"])
    expect(records[2]!.postProcessing).toEqual([
      { sequence: 0, stage: "formatter", status: "started", target: "src/main.ts" },
    ])
    expect(records[3]!.postProcessing).toEqual([
      { sequence: 0, stage: "formatter", status: "started", target: "src/main.ts" },
      { sequence: 1, stage: "formatter", status: "completed", target: "src/main.ts" },
    ])
    // The first durable record is a snapshot, not a view over mutable recorder state.
    expect(records[2]!.postProcessing?.[0]?.status).toBe("started")
  })

  it("orders a stage checkpoint around its effect and leaves no checkpoint for compatibility recorders", async () => {
    const order: string[] = []
    const recorder: MutationIntentRecorder = {
      transactionID: AgentRuntime.MutationTransactionID.create(),
      entries: [],
      record: () => Effect.void,
      recordPostProcessingStage: (stage, status) => Effect.sync(() => order.push(`${stage}:${status}`)),
    }
    const result = await Effect.runPromise(
      runPostProcessingStage({
        recorder,
        stage: "diagnostics",
        effect: Effect.sync(() => {
          order.push("effect")
          return 7
        }),
      }),
    )
    expect(result).toBe(7)
    expect(order).toEqual(["diagnostics:started", "effect", "diagnostics:completed"])

    const compatibility = await Effect.runPromise(
      runPostProcessingStage({
        recorder: { transactionID: recorder.transactionID, entries: [], record: () => Effect.void },
        stage: "watcher",
        effect: Effect.succeed("compat"),
      }),
    )
    expect(compatibility).toBe("compat")
  })

  it("uses one ordered post-processing transaction and settles after diagnostics", async () => {
    const phases: AgentRuntime.MutationIntentPhase[] = []
    let rollbackCount = 0
    const recorder: MutationIntentRecorder = {
      transactionID: AgentRuntime.MutationTransactionID.create(),
      entries: [],
      record: (phase) => Effect.sync(() => phases.push(phase)),
    }
    const journal: MutationJournal = {
      add: () => undefined,
      refresh: () => undefined,
      rollback: () => Effect.sync(() => (rollbackCount++, [])),
    }

    const result = await Effect.runPromise(
      runPostProcessingTransaction({
        recorder,
        journal,
        operation: "Edit",
        effect: Effect.succeed({ diagnostics: 0 }),
      }),
    )

    expect(result).toEqual({ diagnostics: 0 })
    expect(phases).toEqual(["postprocessing", "settled"])
    expect(rollbackCount).toBe(0)
  })

  it("compensates the journal before returning a post-processing failure", async () => {
    const phases: AgentRuntime.MutationIntentPhase[] = []
    let rollbackCount = 0
    const recorder: MutationIntentRecorder = {
      transactionID: AgentRuntime.MutationTransactionID.create(),
      entries: [],
      record: (phase) => Effect.sync(() => phases.push(phase)),
    }
    const journal: MutationJournal = {
      add: () => undefined,
      refresh: () => undefined,
      rollback: () => Effect.sync(() => (rollbackCount++, [])),
    }

    const result = await Effect.runPromiseExit(
      runPostProcessingTransaction({
        recorder,
        journal,
        operation: "Patch",
        effect: Effect.fail(new Error("diagnostics failed")),
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(String(result)).toContain("Patch post-processing failed. diagnostics failed")
    expect(phases).toEqual(["postprocessing", "rollback_required", "rolled_back"])
    expect(rollbackCount).toBe(1)
  })

  it("records outcome_unknown when durable settlement fails after side effects", async () => {
    const phases: AgentRuntime.MutationIntentPhase[] = []
    let rollbackCount = 0
    const recorder: MutationIntentRecorder = {
      transactionID: AgentRuntime.MutationTransactionID.create(),
      entries: [],
      record: (phase) =>
        phase === "settled"
          ? Effect.die(new Error("durable settlement unavailable"))
          : Effect.sync(() => phases.push(phase)),
    }
    const journal: MutationJournal = {
      add: () => undefined,
      refresh: () => undefined,
      rollback: () => Effect.sync(() => (rollbackCount++, [])),
    }

    const result = await Effect.runPromiseExit(
      runPostProcessingTransaction({
        recorder,
        journal,
        operation: "Write",
        effect: Effect.succeed({ diagnostics: 1 }),
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(String(result)).toContain("durable settlement is unknown")
    expect(phases).toEqual(["postprocessing", "outcome_unknown"])
    expect(rollbackCount).toBe(0)
  })

  it("re-observes post-restart fingerprints and rejects workspace escape", async () => {
    const entry = intentEntry({
      target: target("C:\\worktree", "C:\\worktree\\src\\main.ts"),
      operation: "write",
      before: new TextEncoder().encode("raw-before-content"),
      after: new TextEncoder().encode("raw-after-content"),
      recovery: "restore-from-volatile-journal",
    })
    const intent = AgentRuntime.MutationIntent.make({
      version: 1,
      transactionID: AgentRuntime.MutationTransactionID.create(),
      actionID: AgentRuntime.ActionID.create(),
      intentDigest: "d".repeat(64),
      idempotencyKey: "mutation-inspection",
      phase: "outcome_unknown",
      entries: [entry],
      manifestDigest: MutationIntent.manifestDigest([entry])!,
      automaticRetryAllowed: false,
      createdAt: DateTime.makeUnsafe(1_000),
      updatedAt: DateTime.makeUnsafe(2_000),
    })
    const files: Pick<FileMutation.Interface, "fingerprint"> = {
      fingerprint: ({ target: observedTarget }) =>
        Effect.succeed(
          observedTarget.resource === "src/main.ts"
            ? {
                digest: entry.afterDigest!,
                size: entry.afterByteLength!,
                mode: 0,
                identity: "test",
                mtimeMs: 1,
              }
            : undefined,
        ),
    }

    const projection = await Effect.runPromise(inspectMutationIntent({ files, worktree: "C:\\worktree", intent }))
    expect(projection.decision).toBe("postimage_matches")
    expect(projection.automaticRetryAllowed).toBe(false)
    const projectedInspection = await Effect.runPromise(
      inspectMutationProjection({
        files,
        worktree: "C:\\worktree",
        projection: { mutationIntent: intent },
      }),
    )
    expect(projectedInspection?.decision).toBe("postimage_matches")
    expect(projectedInspection?.automaticRetryAllowed).toBe(false)

    const escapedEntry = { ...entry, target: "../outside.ts" }
    const escaped = AgentRuntime.MutationIntent.make({
      ...intent,
      entries: [escapedEntry],
      manifestDigest: MutationIntent.manifestDigest([escapedEntry])!,
    })
    const rejected = await Effect.runPromise(
      inspectMutationIntent({ files, worktree: "C:\\worktree", intent: escaped }).pipe(Effect.exit),
    )
    expect(rejected._tag).toBe("Failure")
    expect(String(rejected)).toContain("outside the workspace")
  })
})
