import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import * as AssetLocalization from "@arforge-ai/core/runtime/asset-localization"
import * as AssetLocalizationAction from "@arforge-ai/core/runtime/asset-localization-action"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { project as projectToolExecution } from "@arforge-ai/core/tool/execution-state"
import {
  ASSET_BYTES,
  HTML_RESOURCE,
  HTML_SOURCE,
  action,
  discovery,
  runtimeLayer,
  workspaceLayer,
} from "../fixture/asset-localization-crash-contract"
import { tmpdir } from "../fixture/tmpdir"

describe("asset localization SIGKILL crash/restart", () => {
  test("reconciles committed assets after a child crash without replaying localization", async () => {
    const temporary = await tmpdir()
    const root = temporary.path
    const workspace = join(root, "workspace")
    const rollbackRoot = join(root, "rollback-artifacts")
    const databasePath = join(root, "asset-sigkill.sqlite")
    const committedMarker = join(root, "committed.marker")
    mkdirSync(workspace, { recursive: true })
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/asset-localization-crash-worker.ts",
        databasePath,
        workspace,
        rollbackRoot,
        committedMarker,
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
      for (let attempt = 0; attempt < 800 && !existsSync(committedMarker); attempt += 1) await Bun.sleep(25)
      if (!existsSync(committedMarker)) {
        worker.kill()
        await worker.exited
        const [stdout, stderr] = await Promise.all([
          worker.stdout ? new Response(worker.stdout).text() : Promise.resolve(""),
          worker.stderr ? new Response(worker.stderr).text() : Promise.resolve(""),
        ])
        throw new Error(`asset localization SIGKILL worker did not commit; stdout=${stdout}; stderr=${stderr}`)
      }

      const assetDigest = await crypto.subtle.digest("SHA-256", ASSET_BYTES).then((bytes) =>
        [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""),
      )
      const htmlPath = join(workspace, HTML_RESOURCE)
      const assetPath = join(workspace, "src", "vendor", "js", `${assetDigest}.js`)
      expect(readFileSync(htmlPath, "utf8")).toContain(`vendor/js/${assetDigest}.js`)
      expect(readFileSync(assetPath, "utf8")).toBe(new TextDecoder().decode(ASSET_BYTES))
      expect(readdirSync(rollbackRoot).filter((name) => name.endsWith(".bin"))).toHaveLength(1)

      worker.kill("SIGKILL")
      expect(await worker.exited).not.toBe(0)
      await Bun.sleep(1_200)

      const originalAction = action(discovery())
      const restartLayer = Layer.mergeAll(runtimeLayer(databasePath), workspaceLayer(workspace, rollbackRoot))
      let executedAfterRestart = 0
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const files = yield* FileMutation.Service
          const result = yield* gateway
            .execute(originalAction, {
              authorization: AssetLocalizationAction.authorizationPlan(discovery()),
              execute: () => Effect.sync(() => (executedAfterRestart += 1)),
            })
            .pipe(Effect.exit)
          const before = yield* actions.load(originalAction.actionID)
          const inspection = yield* FileMutation.inspectIntent({
            files,
            worktree: workspace,
            intent: before.mutationIntent!,
          })
          const reviewed = yield* gateway.reviewMutationIntent!({
            actionID: originalAction.actionID,
            transactionID: before.mutationIntent!.transactionID,
            expectedPhase: "committed",
            decision: "settle_postimage",
            inspectedDecision: inspection.decision,
            observationDigest: inspection.observationDigest,
            reviewedAt: yield* DateTime.now,
          })
          const after = yield* actions.load(originalAction.actionID)
          const projection = projectToolExecution(after, "recovery")
          return { result, before, inspection, reviewed, after, projection }
        }).pipe(Effect.scoped, Effect.provide(restartLayer)),
      )

      expect(Exit.isFailure(recovered.result)).toBe(true)
      expect(String(recovered.result)).toContain("ActionGateway.RecoveryRequiredError")
      const reason = Exit.isFailure(recovered.result)
        ? String((Cause.squash(recovered.result.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(reason).toContain("mutation")
      expect(executedAfterRestart).toBe(0)
      expect(recovered.before.mutationIntent?.phase).toBe("committed")
      expect(recovered.inspection.decision).toBe("postimage_matches")
      expect(recovered.inspection.entries).toHaveLength(2)
      expect(recovered.inspection.automaticRetryAllowed).toBe(false)
      expect(recovered.reviewed.mutationIntent?.phase).toBe("settled")
      expect(recovered.after.action.status).toBe("blocked")
      expect(recovered.projection.mutationRecovery).toMatchObject({
        phase: "settled",
        decision: "settled",
        automaticRetryAllowed: false,
      })
      expect(MutationIntent.postProcessingRecoveryOf(recovered.after.mutationIntent!)).toMatchObject({
        status: "settled",
      })

      const replay = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          return yield* gateway
            .execute(originalAction, {
              authorization: AssetLocalizationAction.authorizationPlan(discovery()),
              execute: () => Effect.sync(() => (executedAfterRestart += 1)),
            })
            .pipe(Effect.exit)
        }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
      )
      expect(Exit.isFailure(replay)).toBe(true)
      expect(String(replay)).toContain("ActionGateway.RecoveryRequiredError")
      expect(executedAfterRestart).toBe(0)
    } finally {
      worker.kill()
      await worker.exited
      await temporary[Symbol.asyncDispose]()
      rmSync(root, { recursive: true, force: true })
    }
  }, 35_000)
})
