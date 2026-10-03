export * as WorktreeControlExecutor from "./worktree-executor"

import { Effect } from "effect"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Worktree } from "@/worktree"
import { WorktreeControlWorker } from "./worktree-worker"

/**
 * Location-bound production adapter for the ControlRun worker.  The adapter
 * deliberately forwards only the sealed snapshot, opaque capabilities, and
 * the location-bound DurableRun verifier. Legacy `Prepared*` values remain
 * inside Worktree's guarded implementation.
 */
export const makeWorktreeExecutor = (
  worktree: Worktree.Interface,
  durable: DurableRun.Interface,
): WorktreeControlWorker.SealedExecutor<Worktree.Error> => ({
  execute: (input) =>
    worktree.executeSealedControl({ ...input, durable }).pipe(Effect.mapError((error) => error as Worktree.Error)),
})

export const fromService: Effect.Effect<
  WorktreeControlWorker.SealedExecutor<Worktree.Error>,
  never,
  Worktree.Service | DurableRun.Service
> = Effect.gen(function* () {
  return makeWorktreeExecutor(yield* Worktree.Service, yield* DurableRun.Service)
})
