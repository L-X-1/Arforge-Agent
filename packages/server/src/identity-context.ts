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
