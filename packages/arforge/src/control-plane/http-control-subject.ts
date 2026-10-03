export * as HttpControlSubject from "./http-control-subject"

import type * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project as ProjectSchema } from "@arforge-ai/schema/project"

export type Input = {
  readonly directory: string
  readonly projectID: typeof ProjectSchema.ID.Type
  readonly action: string
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly principal: ControlClaimIndex.Principal
}

/** The only durable control principal whose detached worker is recoverable today. */
export const LocalPrincipal: ControlClaimIndex.Principal = ControlPrincipal.LOCAL_PRINCIPAL

export function isLocalPrincipal(input: ControlClaimIndex.Principal) {
  return ControlPrincipal.isLocalPrincipal(input)
}

/**
 * One deterministic server-owned subject formula for mutation, status, and
 * approval routes. Tenant/user identity is inside the opaque ID material so
 * equal browser request IDs can never collide across authenticated owners.
 */
export function make(input: Input) {
  const principalRef = ControlPrincipal.principalRef(input.principal)
  return AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: ControlPrincipal.controlPlaneID(input.principal, {
      location: input.directory,
      projectID: input.projectID,
      action: input.action,
    }),
    location: AbsolutePath.make(input.directory),
    project: input.projectID,
    actor: "user",
    principalRef,
    requestID: input.requestID,
  })
}

export function equals(left: AgentRuntime.ControlPlaneSubject, right: AgentRuntime.ControlPlaneSubject) {
  return (
    left.type === right.type &&
    left.id === right.id &&
    left.location === right.location &&
    left.project === right.project &&
    left.actor === right.actor &&
    left.principalRef === right.principalRef &&
    left.requestID === right.requestID
  )
}

export function ownedBy(subject: AgentRuntime.ControlPlaneSubject, input: Omit<Input, "requestID">): boolean {
  return equals(subject, make({ ...input, requestID: subject.requestID }))
}
