import { resolve } from "node:path"
import { workspaceRootMutationEnableGate, workspaceRootProfileDirectory } from "./workspace-roots"
import {
  inspectWorkspaceRootFileWriter,
  makeWorkspaceRootFileWriter,
  type WorkspaceRootFileWriterPreflight,
} from "./workspace-root-file-writer"
import type { WorkspaceRootWriterSeams } from "./workspace-root-writer"

/**
 * The one production binding for workspace-root state.
 *
 * This factory deliberately constructs the concrete file owner through the
 * same Core gate used by the CLI.  Until every gate is proven, the returned
 * writer is disabled, so constructing the owner cannot create or mutate
 * profile state.  Future enablement therefore has one explicit switch rather
 * than a second Python or command-local writer.
 */
export type WorkspaceRootProductionOwner = Readonly<{
  readonly owner: "typescript-core-workspace-root-writer"
  readonly profileDirectory: string
  readonly primary: string
  readonly enabled: boolean
  readonly gate: ReturnType<typeof workspaceRootMutationEnableGate>
  readonly writer: WorkspaceRootWriterSeams
  /**
   * Read-only persisted-boundary inspection for the bound profile.
   *
   * This is intentionally a method instead of an eager value: binding the
   * owner remains filesystem-free, while callers can request an auditable
   * snapshot at the point they need it.  The preflight itself never acquires
   * the writer lock or mutates state.
   */
  readonly preflight: () => WorkspaceRootFileWriterPreflight
}>

export type WorkspaceRootProductionOwnerOptions = Readonly<{
  readonly profileDirectory?: string
  readonly primary?: string
}>

/** Bind the canonical owner without performing any filesystem operation. */
export const makeWorkspaceRootProductionOwner = (
  options: WorkspaceRootProductionOwnerOptions = {},
): WorkspaceRootProductionOwner => {
  const profileDirectory = resolve(options.profileDirectory ?? workspaceRootProfileDirectory())
  const primary = resolve(options.primary ?? process.cwd())
  const gate = workspaceRootMutationEnableGate()
  const writer = makeWorkspaceRootFileWriter({
    profileDirectory,
    primary,
    enabled: gate.ready,
  })
  return Object.freeze({
    owner: "typescript-core-workspace-root-writer" as const,
    profileDirectory,
    primary,
    enabled: gate.ready,
    gate,
    writer,
    preflight: () => inspectWorkspaceRootFileWriter({ profileDirectory, primary }),
  })
}
