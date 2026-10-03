import { statSync } from "node:fs"
import { resolve } from "node:path"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project } from "@arforge-ai/schema/project"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import {
  readWorkspaceRootMutationStateAt,
  workspaceRootMutationIntentDigest,
  type WorkspaceRootMutationAction,
  type WorkspaceRootMutationRequest,
} from "@arforge-ai/core/workspace-roots"
import { executeWorkspaceRootMutation } from "@arforge-ai/core/workspace-root-writer"
import type { WorkspaceRootProductionOwner } from "@arforge-ai/core/workspace-root-owner"
import { Effect } from "effect"

/**
 * The single CLI/HTTP/Desktop adapter for workspace-root mutations.
 *
 * This module deliberately does not write files and does not infer permission
 * from ARFORGE_TRUST_WORKSPACE. It only builds a canonical control-plane
 * ActionGateway input from the bound Core owner, then delegates the actual
 * CAS/rollback/outbox/audit work to `executeWorkspaceRootMutation`. The
 * production owner is still disabled by the aggregate gate, so wiring this
 * adapter cannot accidentally expose a second or partially implemented
 * writer.
 */
export type WorkspaceRootControlInput = Readonly<{
  readonly owner: WorkspaceRootProductionOwner
  readonly gateway: Pick<ActionGateway.Interface, "execute">
  readonly principal: ControlPrincipal.Principal
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly action: WorkspaceRootMutationAction
  readonly target: string
  readonly projectID?: Project.ID
}>

export type WorkspaceRootControlRequest = Readonly<{
  readonly action: ActionGateway.Input
  readonly request: WorkspaceRootMutationRequest
  readonly subject: AgentRuntime.ControlPlaneSubject
}>

const actionName = (action: WorkspaceRootMutationAction): string => `workspace.root.${action}`

const canonicalTarget = (target: string): string => resolve(target)

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const semantics = (primary: string, target: string): AgentRuntime.EffectSemantics =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L3",
    authority: "human",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "reversible",
    compensation: "restore-workspace-root-state",
    filesystemScope: [primary, target],
    networkScope: [],
    secretScope: [],
    externalServices: [],
    expectedArtifacts: ["workspace root state"],
    successCriteria: ["workspace root state committed"],
  })

/**
 * Re-read the profile state and construct the exact request identity used by
 * the writer. The state arrays are never accepted from renderer/CLI input;
 * they come from the canonical Core profile reader immediately before the
 * ActionGateway request is sealed.
 */
export const buildWorkspaceRootControlRequest = (
  input: Omit<WorkspaceRootControlInput, "gateway">,
): WorkspaceRootControlRequest => {
  const primary = resolve(input.owner.primary)
  const target = canonicalTarget(input.target)
  const state = readWorkspaceRootMutationStateAt(input.owner.profileDirectory, primary)
  const request: WorkspaceRootMutationRequest = {
    action: input.action,
    primary,
    primaryIsDirectory: isDirectory(primary),
    target,
    // The writer rechecks add/trust targets under its lock. This snapshot is
    // only the immutable preflight identity; remove intentionally tolerates a
    // vanished target because the configured-root list is the source of truth.
    targetIsDirectory: isDirectory(target),
    trustedWorkspaces: state.trustedWorkspaces,
    configuredRoots: state.configuredRoots,
  }
  const name = actionName(input.action)
  const resources = Object.freeze([primary, target].toSorted((left, right) => left.localeCompare(right)))
  const inputDigest = workspaceRootMutationIntentDigest(request)
  const projectID = input.projectID ?? Project.ID.make("global")
  const subject = AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: ControlPrincipal.controlPlaneID(input.principal, {
      location: primary,
      projectID,
      action: name,
    }),
    location: AbsolutePath.make(primary),
    project: projectID,
    actor: "user",
    principalRef: ControlPrincipal.principalRef(input.principal),
    requestID: input.requestID,
  })
  const effectSemantics = semantics(primary, target)
  const actionID = ActionGateway.stableControlPlaneActionID({
    subject,
    name,
    resources,
    inputDigest,
    policyVersion: ActionGateway.POLICY_VERSION,
  })
  const action: ActionGateway.Input = {
    kind: "control-plane",
    actionID,
    inputDigest,
    controlPlane: subject,
    name,
    resources,
    semantics: effectSemantics,
    reasonSummary: `修改 workspace root：${input.action}`,
    initiator: "user",
    traceID: `workspace-root:${subject.id}:${subject.requestID}`,
  }
  return Object.freeze({ action, request, subject })
}

/** Execute a mutation through the shared ActionGateway and canonical writer. */
export const executeWorkspaceRootControl = Effect.fn("WorkspaceRootControl.execute")(function* (
  input: WorkspaceRootControlInput,
) {
  const prepared = buildWorkspaceRootControlRequest(input)
  return yield* executeWorkspaceRootMutation({
    gateway: input.gateway,
    action: prepared.action,
    request: prepared.request,
    writer: input.owner.writer,
  })
})
