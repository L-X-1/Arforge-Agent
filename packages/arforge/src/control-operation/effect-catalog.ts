export * as ControlOperationEffectCatalog from "./effect-catalog"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export type ControlOperationManifest = {
  readonly name: "worktree.create" | "worktree.remove" | "worktree.reset"
  readonly deadlineMs: number
  readonly recovery: "manual"
  readonly externalOperation: true
  readonly networkEgress: "host_configured"
  readonly secretScope: "none"
}

export const ControlOperationManifest: Readonly<Record<ControlOperationManifest["name"], ControlOperationManifest>> =
  Object.freeze({
    "worktree.create": {
      name: "worktree.create",
      deadlineMs: 15 * 60_000,
      recovery: "manual",
      externalOperation: true,
      networkEgress: "host_configured",
      secretScope: "none",
    },
    "worktree.remove": {
      name: "worktree.remove",
      deadlineMs: 15 * 60_000,
      recovery: "manual",
      externalOperation: true,
      networkEgress: "host_configured",
      secretScope: "none",
    },
    "worktree.reset": {
      name: "worktree.reset",
      deadlineMs: 15 * 60_000,
      recovery: "manual",
      externalOperation: true,
      networkEgress: "host_configured",
      secretScope: "none",
    },
  })

export type ControlOperationEffectInput = {
  readonly filesystemScope: ReadonlyArray<string>
  readonly expectedArtifacts: ReadonlyArray<string>
  readonly successCriteria: ReadonlyArray<string>
  readonly networkScope?: ReadonlyArray<string>
}

/**
 * One semantic constructor for all sealed worktree operations. The snapshot
 * handler supplies only operation-specific resources and verification
 * criteria; risk, authority, retryability, and egress policy stay here.
 */
export const worktreeEffectSemantics = (input: ControlOperationEffectInput) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L3",
    authority: "human",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "irreversible",
    filesystemScope: [...input.filesystemScope],
    networkScope: ["git-filter-processes", ...(input.networkScope ?? [])],
    secretScope: [],
    externalServices: ["git", "project-registry", "repository-configured-processes"],
    expectedArtifacts: [...input.expectedArtifacts],
    successCriteria: [...input.successCriteria],
  })

export type ControlOperationCatalogAudit = {
  readonly expected: number
  readonly observed: number
  readonly missing: ReadonlyArray<string>
  readonly invalidDeadlines: ReadonlyArray<string>
}

export function auditControlOperationCatalog(): ControlOperationCatalogAudit {
  const names = Object.keys(ControlOperationManifest).sort()
  const invalidDeadlines = names.filter((name) => {
    const deadline = ControlOperationManifest[name as keyof typeof ControlOperationManifest]?.deadlineMs
    return deadline === undefined || !Number.isInteger(deadline) || deadline <= 0
  })
  return { expected: 3, observed: names.length, missing: [], invalidDeadlines }
}
