import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import * as FileMutation from "@arforge-ai/core/file-mutation"
import { snapshot } from "@arforge-ai/core/file-guard"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { project as projectToolExecution } from "@arforge-ai/core/tool/execution-state"
import { action, mutationAction, runtimeLayer } from "../fixture/action-crash-contract"
import { location } from "../fixture/location"

describe("real SIGKILL crash/replay", () => {
  test("preserves an unknown side effect and blocks non-idempotent replay in a fresh process", async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-action-sigkill-"))
    const databasePath = join(root, "crash-replay.db")
    const sideEffectMarker = join(root, "side-effect.marker")
    const readyMarker = join(root, "ready.marker")
    const worker = Bun.spawn(
      [process.execPath, "test/fixture/action-crash-worker.ts", databasePath, sideEffectMarker, readyMarker],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
          ARFORGE_ACTION_LEASE_TTL_MS: "1000",
          ARFORGE_DISABLE_CHANNEL_DB: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
      expect(existsSync(sideEffectMarker)).toBe(true)
      expect(existsSync(readyMarker)).toBe(true)

      worker.kill("SIGKILL")
      expect(await worker.exited).not.toBe(0)

      // The worker lease is intentionally short for this probe. A new process
      // must wait for the old lease to expire before it can classify recovery.
      await Bun.sleep(1_200)

      let executedAfterRestart = 0
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const result = yield* gateway
            .execute(action(), {
              execute: () =>
                Effect.sync(() => {
                  executedAfterRestart += 1
                  return "must-not-run"
                }),
            })
            .pipe(Effect.exit)
          const state = yield* actions.load(action().actionID)
          return { result, state }
        }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
      )

      expect(Exit.isFailure(recovered.result)).toBe(true)
      expect(String(recovered.result)).toContain("ActionGateway.RecoveryRequiredError")
      const reason = Exit.isFailure(recovered.result)
        ? String((Cause.squash(recovered.result.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(reason).toContain("Tool outcome is unknown")
      expect(executedAfterRestart).toBe(0)
      expect(readFileSync(sideEffectMarker, "utf8")).toBe("side-effect-before-sigkill")
      const projection = projectToolExecution(recovered.state, "recovery")
      expect(projection.state).toBe("outcome_unknown")
      expect(projection.repair.required).toBe(true)
      expect(projection.repair.source).toBe("action-gateway-recovery")
    } finally {
      worker.kill()
      await worker.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("persists a mutation intent before SIGKILL and blocks an otherwise safe replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-mutation-sigkill-"))
    const databasePath = join(root, "crash-replay.db")
    const sideEffectMarker = join(root, "side-effect.marker")
    const readyMarker = join(root, "ready.marker")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/action-crash-worker.ts",
        databasePath,
        sideEffectMarker,
        readyMarker,
        "mutation",
      ],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
          ARFORGE_ACTION_LEASE_TTL_MS: "1000",
          ARFORGE_DISABLE_CHANNEL_DB: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
      expect(existsSync(sideEffectMarker)).toBe(true)
      expect(existsSync(readyMarker)).toBe(true)

      worker.kill("SIGKILL")
      expect(await worker.exited).not.toBe(0)
      await Bun.sleep(1_200)

      let executedAfterRestart = 0
      const actionInput = mutationAction()
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const result = yield* gateway
            .execute(actionInput, {
              execute: () =>
                Effect.sync(() => {
                  executedAfterRestart += 1
                  return "must-not-run"
                }),
            })
            .pipe(Effect.exit)
          const state = yield* actions.load(actionInput.actionID)
          const projection = yield* gateway.inspectRecovery!({ actionID: actionInput.actionID })
          return { result, state, projection }
        }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
      )

      expect(Exit.isFailure(recovered.result)).toBe(true)
      expect(String(recovered.result)).toContain("ActionGateway.RecoveryRequiredError")
      const reason = Exit.isFailure(recovered.result)
        ? String((Cause.squash(recovered.result.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(reason).toContain("Mutation recovery requires inspect")
      expect(reason).toContain("Automatic retry is blocked")
      expect(executedAfterRestart).toBe(0)
      expect(readFileSync(sideEffectMarker, "utf8")).toBe("side-effect-before-sigkill")
      expect(recovered.state.action.status).toBe("blocked")
      expect(recovered.state.mutationIntent?.phase).toBe("prepared")
      expect(recovered.projection.mutationRecovery).toMatchObject({
        phase: "prepared",
        decision: "inspect",
        automaticRetryAllowed: false,
      })
    } finally {
      worker.kill()
      await worker.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("preserves each nonterminal mutation phase across SIGKILL and refuses replay", async () => {
    const expectedPhaseByMode = {
      "mutation-committed": "committed",
      "mutation-postprocessing": "postprocessing",
      "mutation-outcome-unknown": "outcome_unknown",
      "mutation-rollback-required": "rollback_required",
      "mutation-rollback-blocked": "rollback_blocked",
      "mutation-settled": "settled",
    } as const
    for (const mode of Object.keys(expectedPhaseByMode) as Array<keyof typeof expectedPhaseByMode>) {
      const root = mkdtempSync(join(tmpdir(), `arforge-mutation-${mode}-sigkill-`))
      const databasePath = join(root, "crash-replay.db")
      const sideEffectMarker = join(root, "side-effect.marker")
      const readyMarker = join(root, "ready.marker")
      const worker = Bun.spawn(
        [process.execPath, "test/fixture/action-crash-worker.ts", databasePath, sideEffectMarker, readyMarker, mode],
        {
          cwd: join(import.meta.dir, "..", ".."),
          env: {
            ...process.env,
            ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
            ARFORGE_ACTION_LEASE_TTL_MS: "1000",
            ARFORGE_DISABLE_CHANNEL_DB: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )

      try {
        for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
        expect(existsSync(sideEffectMarker)).toBe(true)
        expect(existsSync(readyMarker)).toBe(true)

        worker.kill("SIGKILL")
        expect(await worker.exited).not.toBe(0)
        await Bun.sleep(1_200)

        let executedAfterRestart = 0
        const actionInput = mutationAction()
        const recovered = await Effect.runPromise(
          Effect.gen(function* () {
            const gateway = yield* ActionGateway.Service
            const actions = yield* DurableAction.Service
            const result = yield* gateway
              .execute(actionInput, {
                execute: () =>
                  Effect.sync(() => {
                    executedAfterRestart += 1
                    return "must-not-run"
                  }),
              })
              .pipe(Effect.exit)
            const state = yield* actions.load(actionInput.actionID)
            const projection = yield* gateway.inspectRecovery!({ actionID: actionInput.actionID })
            return { result, state, projection }
          }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
        )

        expect(Exit.isFailure(recovered.result)).toBe(true)
        expect(String(recovered.result)).toContain("ActionGateway.RecoveryRequiredError")
        expect(executedAfterRestart).toBe(0)
        expect(readFileSync(sideEffectMarker, "utf8")).toBe("side-effect-before-sigkill")
        expect(recovered.state.action.status).toBe("blocked")
        expect(recovered.state.mutationIntent?.phase).toBe(expectedPhaseByMode[mode])
        expect(recovered.projection.state).toBe("outcome_unknown")
        expect(recovered.projection.mutationRecovery).toMatchObject({
          phase: expectedPhaseByMode[mode],
          decision:
            expectedPhaseByMode[mode] === "rollback_required"
              ? "manual_rollback"
              : expectedPhaseByMode[mode] === "rollback_blocked"
                ? "blocked"
                : expectedPhaseByMode[mode] === "settled"
                  ? "settled"
                  : "inspect",
          automaticRetryAllowed: false,
        })
      } finally {
        worker.kill()
        await worker.exited
        rmSync(root, { recursive: true, force: true })
      }
    }
  }, 40_000)

  test("classifies a real post-processing file image after a child process crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-mutation-postprocess-sigkill-"))
    const databasePath = join(root, "crash-replay.db")
    const sideEffectMarker = join(root, "side-effect.marker")
    const readyMarker = join(root, "ready.marker")
    const mutationPath = join(root, "sigkill-mutation.txt")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/action-crash-worker.ts",
        databasePath,
        sideEffectMarker,
        readyMarker,
        "mutation-postprocessing",
        mutationPath,
      ],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
          ARFORGE_ACTION_LEASE_TTL_MS: "1000",
          ARFORGE_DISABLE_CHANNEL_DB: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
      expect(existsSync(mutationPath)).toBe(true)
      expect(readFileSync(mutationPath, "utf8")).toBe("c")

      worker.kill("SIGKILL")
      expect(await worker.exited).not.toBe(0)
      await Bun.sleep(1_200)

      const actionInput = mutationAction()
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const result = yield* gateway
            .execute(actionInput, {
              execute: () => Effect.die(new Error("post-crash mutation must not replay")),
            })
            .pipe(Effect.exit)
          const state = yield* actions.load(actionInput.actionID)
          const image = yield* snapshot(mutationPath)
          const intent = state.mutationIntent!
          const inspection = MutationIntent.inspect(intent, [
            {
              target: "sigkill-mutation.txt",
              present: image !== undefined,
              ...(image === undefined ? {} : { digest: image.digest, byteLength: image.size }),
            },
          ])
          return { result, state, inspection }
        }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
      )

      expect(Exit.isFailure(recovered.result)).toBe(true)
      expect(String(recovered.result)).toContain("ActionGateway.RecoveryRequiredError")
      expect(recovered.state.mutationIntent?.phase).toBe("postprocessing")
      expect(recovered.state.mutationIntent?.postProcessing).toEqual([
        { sequence: 0, stage: "formatter", status: "started", target: "sigkill-mutation.txt" },
        { sequence: 1, stage: "formatter", status: "completed", target: "sigkill-mutation.txt" },
        { sequence: 2, stage: "lsp_touch", status: "started", target: "sigkill-mutation.txt" },
      ])
      expect(recovered.inspection.decision).toBe("postimage_matches")
      expect(recovered.inspection.automaticRetryAllowed).toBe(false)
      expect(recovered.inspection.reason).toContain("settlement still requires the Action log")
    } finally {
      worker.kill()
      await worker.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("settles a postimage after SIGKILL only through fresh inspection and preserves the no-replay gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-mutation-postprocess-settle-sigkill-"))
    const databasePath = join(root, "crash-replay.db")
    const sideEffectMarker = join(root, "side-effect.marker")
    const readyMarker = join(root, "ready.marker")
    const mutationPath = join(root, "sigkill-mutation.txt")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/action-crash-worker.ts",
        databasePath,
        sideEffectMarker,
        readyMarker,
        "mutation-postprocessing",
        mutationPath,
      ],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
          ARFORGE_ACTION_LEASE_TTL_MS: "1000",
          ARFORGE_DISABLE_CHANNEL_DB: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
      expect(existsSync(mutationPath)).toBe(true)
      expect(readFileSync(mutationPath, "utf8")).toBe("c")

      worker.kill("SIGKILL")
      expect(await worker.exited).not.toBe(0)
      await Bun.sleep(1_200)

      const activeLocation = Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(root) })),
      )
      const fileLayer = AppNodeBuilder.build(
        LayerNode.group([LocationMutation.node, FileMutation.node, RollbackArtifact.node]),
        [
          [Location.node, activeLocation],
          [FSUtil.node, LayerNode.compile(FSUtil.node)],
        ],
      )
      const combinedLayer = Layer.mergeAll(runtimeLayer(databasePath), fileLayer)
      const actionInput = mutationAction()
      let executedAfterRestart = 0
      const repaired = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const files = yield* FileMutation.Service
          const result = yield* gateway
            .execute(actionInput, {
              execute: () => Effect.sync(() => (executedAfterRestart += 1)),
            })
            .pipe(Effect.exit)
          const before = yield* actions.load(actionInput.actionID)
          const inspection = yield* FileMutation.inspectIntent({
            files,
            worktree: root,
            intent: before.mutationIntent!,
          })
          const reviewed = yield* gateway.reviewMutationIntent!({
            actionID: actionInput.actionID,
            transactionID: before.mutationIntent!.transactionID,
            expectedPhase: "postprocessing",
            decision: "settle_postimage",
            inspectedDecision: inspection.decision,
            observationDigest: inspection.observationDigest,
            reviewedAt: yield* DateTime.now,
          })
          const after = yield* actions.load(actionInput.actionID)
          return { result, before, inspection, reviewed, after }
        }).pipe(Effect.scoped, Effect.provide(combinedLayer)),
      )

      expect(Exit.isFailure(repaired.result)).toBe(true)
      expect(String(repaired.result)).toContain("ActionGateway.RecoveryRequiredError")
      expect(repaired.before.mutationIntent?.phase).toBe("postprocessing")
      expect(repaired.before.mutationIntent?.postProcessing?.at(-1)?.status).toBe("started")
      expect(repaired.inspection.decision).toBe("postimage_matches")
      expect(repaired.reviewed.mutationIntent?.phase).toBe("settled")
      expect(repaired.reviewed.mutationIntent?.postProcessing?.at(-1)?.stage).toBe("lsp_touch")
      expect(repaired.after.action.status).toBe("blocked")
      expect(executedAfterRestart).toBe(0)
      expect(readFileSync(sideEffectMarker, "utf8")).toBe("side-effect-before-sigkill")

      const replayed = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          return yield* gateway
            .execute(actionInput, {
              execute: () => Effect.sync(() => (executedAfterRestart += 1)),
            })
            .pipe(Effect.exit)
        }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
      )
      expect(Exit.isFailure(replayed)).toBe(true)
      expect(String(replayed)).toContain("ActionGateway.RecoveryRequiredError")
      expect(executedAfterRestart).toBe(0)
    } finally {
      worker.kill()
      await worker.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("repairs an artifact-backed rollback_required mutation after SIGKILL and preserves rolled_back on the next restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-mutation-artifact-sigkill-"))
    const databasePath = join(root, "crash-replay.db")
    const artifactRoot = join(root, "rollback-artifacts")
    const worktree = join(root, "workspace")
    const mutationPath = join(worktree, "sigkill-artifact-mutation.txt")
    const sideEffectMarker = join(root, "side-effect.marker")
    const readyMarker = join(root, "ready.marker")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/action-crash-worker.ts",
        databasePath,
        sideEffectMarker,
        readyMarker,
        "mutation-artifact-rollback-required",
        mutationPath,
        artifactRoot,
      ],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
          ARFORGE_ACTION_LEASE_TTL_MS: "1000",
          ARFORGE_DISABLE_CHANNEL_DB: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
      if (!existsSync(readyMarker)) {
        worker.kill()
        await worker.exited
        const [stdout, stderr] = await Promise.all([
          worker.stdout ? new Response(worker.stdout).text() : Promise.resolve(""),
          worker.stderr ? new Response(worker.stderr).text() : Promise.resolve(""),
        ])
        throw new Error(`artifact crash worker did not become ready; stdout=${stdout}; stderr=${stderr}`)
      }
      expect(readFileSync(mutationPath, "utf8")).toBe("after")
      expect(readdirSync(artifactRoot).filter((name) => name.endsWith(".bin"))).toHaveLength(1)

      worker.kill("SIGKILL")
      expect(await worker.exited).not.toBe(0)
      await Bun.sleep(1_200)

      const activeLocation = Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(worktree) })),
      )
      const fileLayer = AppNodeBuilder.build(
        LayerNode.group([LocationMutation.node, FileMutation.node, RollbackArtifact.node]),
        [
          [Location.node, activeLocation],
          [FSUtil.node, LayerNode.compile(FSUtil.node)],
          [RollbackArtifact.node, RollbackArtifact.layerWith(artifactRoot)],
        ],
      )
      const combinedLayer = Layer.mergeAll(runtimeLayer(databasePath), fileLayer)
      const actionInput = mutationAction()
      let executedAfterRestart = 0
      const repaired = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const files = yield* FileMutation.Service
          const result = yield* gateway
            .execute(actionInput, {
              execute: () => Effect.sync(() => (executedAfterRestart += 1)),
            })
            .pipe(Effect.exit)
          const stateBeforeRepair = yield* actions.load(actionInput.actionID)
          const inspection = yield* FileMutation.inspectIntent({
            files,
            worktree,
            intent: stateBeforeRepair.mutationIntent!,
          })
          const receipt = yield* files.rollbackIntent({
            worktree,
            intent: stateBeforeRepair.mutationIntent!,
            observationDigest: inspection.observationDigest,
          })
          const reviewedAt = yield* DateTime.now
          const stateAfterRepair = yield* gateway.reviewMutationIntent!({
            actionID: actionInput.actionID,
            transactionID: receipt.transactionID,
            expectedPhase: "rollback_required",
            decision: "confirm_rolled_back",
            inspectedDecision: receipt.inspection.decision,
            observationDigest: receipt.inspection.observationDigest,
            reviewedAt,
          })
          return { result, stateBeforeRepair, stateAfterRepair, inspection, receipt }
        }).pipe(Effect.scoped, Effect.provide(combinedLayer)),
      )

      expect(Exit.isFailure(repaired.result)).toBe(true)
      expect(String(repaired.result)).toContain("ActionGateway.RecoveryRequiredError")
      expect(executedAfterRestart).toBe(0)
      expect(repaired.stateBeforeRepair.mutationIntent?.phase).toBe("rollback_required")
      expect(repaired.inspection.decision).toBe("postimage_matches")
      expect(repaired.inspection.rollbackAvailable).toBe(true)
      expect(repaired.receipt.inspection.decision).toBe("preimage_matches")
      expect(repaired.stateAfterRepair.mutationIntent?.phase).toBe("rolled_back")
      expect(readFileSync(mutationPath, "utf8")).toBe("before")

      const afterRestart = await Effect.runPromise(
        Effect.gen(function* () {
          const actions = yield* DurableAction.Service
          const gateway = yield* ActionGateway.Service
          const state = yield* actions.load(actionInput.actionID)
          const projection = yield* gateway.inspectRecovery!({ actionID: actionInput.actionID })
          return { state, projection }
        }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
      )
      expect(afterRestart.state.mutationIntent?.phase).toBe("rolled_back")
      expect(afterRestart.projection.mutationRecovery).toMatchObject({
        phase: "rolled_back",
        decision: "settled",
        automaticRetryAllowed: false,
      })
    } finally {
      worker.kill()
      await worker.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
