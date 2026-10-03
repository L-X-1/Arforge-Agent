export * as IdentityContext from "./identity-context"

import { Context } from "effect"

export type Principal = {
  readonly userID: string
  readonly tenantID: string
  readonly email: string
  readonly role: "owner" | "admin" | "member"
  readonly sessionID: string
}

export class Current extends Context.Service<Current, Principal>()("@arforge/IdentityContext") {}

/** Fallback identity for server-owned private/basic-auth requests. */
export const LocalPrincipal: Principal = Object.freeze({
  userID: "usr_local",
  tenantID: "ten_local",
  email: "local-private@arforge.invalid",
  role: "owner",
  sessionID: "aus_local_private_server",
})
