export * as ControlPrincipal from "./control-principal"

import { createHash } from "node:crypto"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export type Principal = {
  readonly tenantID: string
  readonly userID: string
}

export const LOCAL_PRINCIPAL: Principal = Object.freeze({
  tenantID: "ten_local",
  userID: "usr_local",
})

/**
 * Derives the only principal reference accepted by the control plane. The
 * reference is intentionally opaque on the wire, while the server can
 * recompute it from the authenticated tenant/user tuple at every boundary.
 */
export const principalRef = (principal: Principal): AgentRuntime.ControlPrincipalRef =>
  AgentRuntime.ControlPrincipalRef.make(
    `prn_${createHash("sha256")
      .update(`arforge.control-principal/v1\0${principal.tenantID}\0${principal.userID}`)
      .digest("hex")
      .slice(0, 32)}`,
  )

export type ControlPlaneBinding = {
  readonly location: string
  readonly projectID: string
  readonly action: string
}

/**
 * Derives the only control-plane ID formula accepted by Core. The request ID
 * is intentionally absent: retries are aliases of one durable operation, not
 * new control-plane identities. Tenant/user identity is represented by the
 * opaque principal reference and therefore cannot be replaced by renderer
 * input.
 */
export const controlPlaneID = (
  principal: Principal,
  binding: ControlPlaneBinding,
): AgentRuntime.ControlPlaneID =>
  AgentRuntime.ControlPlaneID.make(
    `ctl_${createHash("sha256")
      .update(
        `arforge.control-subject/v3\0${principalRef(principal)}\0${binding.location}\0${binding.projectID}\0${binding.action}`,
      )
      .digest("hex")
      .slice(0, 32)}`,
  )

export const isLocalPrincipal = (principal: Principal) =>
  principal.tenantID === LOCAL_PRINCIPAL.tenantID && principal.userID === LOCAL_PRINCIPAL.userID
