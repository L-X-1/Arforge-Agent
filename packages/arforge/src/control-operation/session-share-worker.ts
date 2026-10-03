import { WorktreeControlWorker } from "./worktree-worker"

export const make = WorktreeControlWorker.makeGeneric
export const SnapshotMismatchError = WorktreeControlWorker.SnapshotMismatchError
export const RecoveryPausedError = WorktreeControlWorker.RecoveryPausedError
export const ExecutionDeadlineExceededError = WorktreeControlWorker.ExecutionDeadlineExceededError
export const InvalidExecutionWindowError = WorktreeControlWorker.InvalidExecutionWindowError
export type GenericSealedExecutor<S, E = never> = WorktreeControlWorker.GenericSealedExecutor<S, E>
export type SealedExecutor<S, E = never> = GenericSealedExecutor<S, E>
export type Interface<E = never> = WorktreeControlWorker.Interface<E>

export * as SessionShareControlWorker from "./session-share-worker"
