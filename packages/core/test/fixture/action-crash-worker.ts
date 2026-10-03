import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DateTime, Effect } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { RollbackArtifactStore } from "@arforge-ai/core/runtime/rollback-artifact"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  action,
  artifactMutationEntries,
  artifactMutationManifestDigest,
  mutationAction,
  mutationEntries,
  mutationManifestDigest,
  runtimeLayer,
} from "./action-crash-contract"

const [databasePath, sideEffectMarker, readyMarker, mode = "guarded", mutationPath, artifactRoot] = Bun.argv.slice(2)
if (!databasePath || !sideEffectMarker || !readyMarker) throw new Error("missing SIGKILL crash fixture arguments")
const mutationPhaseByMode: Readonly<Record<string, AgentRuntime.MutationIntentPhase>> = {
  mutation: "prepared",
  "mutation-prepared": "prepared",
  "mutation-committed": "committed",
  "mutation-postprocessing": "postprocessing",
  "mutation-outcome-unknown": "outcome_unknown",
  "mutation-rollback-required": "rollback_required",
  "mutation-rollback-blocked": "rollback_blocked",
  "mutation-settled": "settled",
}
const artifactMode = mode === "mutation-artifact-rollback-required"
if (mode !== "guarded" && mutationPhaseByMode[mode] === undefined && !artifactMode)
  throw new Error("unknown SIGKILL crash fixture mode")
if (artifactMode && (!mutationPath || !artifactRoot))
  throw new Error("artifact crash fixture requires target and store root")

const program = Effect.gen(function* () {
  const gateway = yield* ActionGateway.Service
  const selectedAction = mode === "guarded" ? action() : mutationAction()
  yield* gateway.execute(selectedAction, {
    execute: () =>
      Effect.gen(function* () {
        if (artifactMode) {
          const artifacts = new RollbackArtifactStore({ root: artifactRoot! })
          mkdirSync(dirname(mutationPath!), { recursive: true })
          writeFileSync(mutationPath!, "before", { encoding: "utf8", flag: "wx" })
          const artifact = yield* Effect.promise(() => artifacts.put(new TextEncoder().encode("before")))
          const entries = artifactMutationEntries(artifact)
          const now = yield* DateTime.now
          const transactionID = AgentRuntime.MutationTransactionID.create()
          if (!gateway.recordMutationIntent) throw new Error("mutation recorder is unavailable")
          yield* gateway.recordMutationIntent({
            actionID: mutationAction().actionID,
            transactionID,
            phase: "prepared",
            entries,
            manifestDigest: artifactMutationManifestDigest(artifact),
            createdAt: now,
            updatedAt: now,
            summary: "prepared artifact-backed mutation before SIGKILL",
          })
          writeFileSync(mutationPath!, "after", { encoding: "utf8" })
          yield* gateway.recordMutationIntent({
            actionID: mutationAction().actionID,
            transactionID,
            phase: "committed",
            entries,
            manifestDigest: artifactMutationManifestDigest(artifact),
            createdAt: now,
            updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1),
            summary: "committed artifact-backed mutation before SIGKILL",
          })
          yield* gateway.recordMutationIntent({
            actionID: mutationAction().actionID,
            transactionID,
            phase: "rollback_required",
            entries,
            manifestDigest: artifactMutationManifestDigest(artifact),
            createdAt: now,
            updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 2),
            summary: "rollback required after SIGKILL artifact probe",
          })
        } else if (mode !== "guarded") {
          if (!gateway.recordMutationIntent) throw new Error("mutation recorder is unavailable")
          const now = yield* DateTime.now
          const transactionID = AgentRuntime.MutationTransactionID.create()
          const targetPhase = mutationPhaseByMode[mode]!
          const linearPhasePath: ReadonlyArray<AgentRuntime.MutationIntentPhase> = [
            "prepared",
            "committed",
            "postprocessing",
            "outcome_unknown",
          ]
          const phasePath: ReadonlyArray<AgentRuntime.MutationIntentPhase> =
            targetPhase === "rollback_required"
              ? ["prepared", "rollback_required"]
              : targetPhase === "rollback_blocked"
                ? ["prepared", "rollback_required", "rollback_blocked"]
                : targetPhase === "settled"
                  ? ["prepared", "committed", "postprocessing", "settled"]
                  : linearPhasePath.slice(0, linearPhasePath.indexOf(targetPhase) + 1)
          const postProcessing =
            targetPhase === "postprocessing"
              ? [
                  {
                    sequence: 0,
                    stage: "formatter" as const,
                    status: "started" as const,
                    target: "sigkill-mutation.txt",
                  },
                  {
                    sequence: 1,
                    stage: "formatter" as const,
                    status: "completed" as const,
                    target: "sigkill-mutation.txt",
                  },
                  {
                    sequence: 2,
                    stage: "lsp_touch" as const,
                    status: "started" as const,
                    target: "sigkill-mutation.txt",
                  },
                ]
              : undefined
          for (const [index, phase] of phasePath.entries()) {
            yield* gateway.recordMutationIntent({
              actionID: selectedAction.actionID,
              transactionID,
              phase,
              entries: mutationEntries(),
              manifestDigest: mutationManifestDigest(),
              createdAt: now,
              updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + index),
              ...(phase === "postprocessing" && postProcessing === undefined ? {} : { postProcessing }),
              summary: `${phase} before SIGKILL mutation probe`,
            })
          }
        }
        if (mutationPath && !artifactMode) writeFileSync(mutationPath, "c", { encoding: "utf8", flag: "wx" })
        // This write represents an external side effect that happened after
        // the durable attempt boundary but before a result was observed.
        writeFileSync(sideEffectMarker, "side-effect-before-sigkill", { encoding: "utf8", flag: "wx" })
        writeFileSync(readyMarker, "ready", { encoding: "utf8", flag: "wx" })
        yield* Effect.never
      }),
  })
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))))
