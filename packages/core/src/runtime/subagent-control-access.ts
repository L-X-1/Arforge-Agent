import { and, eq } from "drizzle-orm"
import { Context, Effect } from "effect"
import { Database } from "../database/database"
import { IdentityTenantMemberTable, IdentityUserTable } from "../identity/sql"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { ControlRunClaimTable } from "./control-claim-index.sql"
import { ControlPrincipal } from "./control-principal"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { DurableRun } from "./durable-run"

// Scoped to the original durable control handoff, never serialized or accepted
// from a client. Autonomous parent-lease calls retain their existing contract.
export const CurrentCheck = Context.Reference<
  Effect.Effect<void, AccessDeniedError | TreeScopeError | DurableRun.NotFoundError | DurableRun.CorruptHistoryError>
>("@arforge/SubagentControl/current-access-check", { defaultValue: () => Effect.void })

// A reserved child is not yet visible in listChildren. Its original publisher
// supplies the session being materialized only for the transaction callback.
export const PendingSession = Context.Reference<string | undefined>("@arforge/SubagentControl/pending-session", {
  defaultValue: () => undefined,
})

export class TreeScopeError extends Error {
  readonly _tag = "SubagentControl.TreeScopeError"
}

// Shared, bounded preflight. This is a snapshot check, not a lock against
// later admission or ownership changes inside durable cancellation.
export const assertDescendantsReadable = Effect.fnUntraced(function* (
  database: Database.Interface,
  durable: Pick<DurableRun.Interface, "listChildren">,
  childRunID: AgentRuntime.RunID,
  principal: Principal,
  scope: { readonly project: string; readonly location: string },
) {
  const pending = [childRunID]
  const seen = new Set<AgentRuntime.RunID>(pending)
  while (pending.length) {
    const parentRunID = pending.pop()!
    const children = yield* durable.listChildren({ parentRunID, includeTerminal: true, limit: 1_000 })
    if (children.length >= 1_000)
      return yield* Effect.fail(
        new TreeScopeError("The cancellation tree exceeds the complete authorization scan limit."),
      )
    for (const child of children) {
      if (seen.has(child.run.id) || seen.size >= 1_000)
        return yield* Effect.fail(new TreeScopeError("The cancellation tree cannot be safely authorized."))
      if (
        child.run.child.parentRunID !== parentRunID ||
        child.run.project !== scope.project ||
        String(child.run.location ?? "") !== scope.location
      )
        return yield* Effect.fail(new TreeScopeError("The cancellation tree contains an invalid workspace binding."))
      yield* assertSessionReadable(database, child.run.sessionID, principal)
      seen.add(child.run.id)
      pending.push(child.run.id)
    }
  }
})

export class AccessDeniedError extends Error {
  readonly _tag = "SubagentControl.AccessDeniedError"
  constructor() {
    super("The requested session is outside your authorized scope.")
  }
}

export type Principal = ControlPrincipal.Principal & { readonly role: "owner" | "admin" | "member" }

// One session policy for HTTP discovery and durable control recovery. A worker
// lease is deliberately not an input: it cannot grant user access.
export const assertSessionReadable = Effect.fnUntraced(function* (
  database: Database.Interface,
  sessionID: string,
  principal: Principal,
) {
  const row = yield* database.db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(
      and(
        eq(SessionTable.id, SessionSchema.ID.make(sessionID)),
        eq(SessionTable.tenant_id, principal.tenantID),
        ...(principal.role === "member" ? [eq(SessionTable.owner_user_id, principal.userID)] : []),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* Effect.fail(new AccessDeniedError())
})

// Resolve identity only from the original claim index; opaque subject hashes
// cannot be decoded and a caller-provided recovery identity is not trusted.
export const principalForClaim = Effect.fnUntraced(function* (
  database: Database.Interface,
  run: AgentRuntime.ControlRun,
) {
  const rows = yield* database.db
    .select({ tenantID: ControlRunClaimTable.tenant_id, userID: ControlRunClaimTable.owner_user_id })
    .from(ControlRunClaimTable)
    .where(eq(ControlRunClaimTable.run_id, run.id))
    .limit(2)
    .all()
    .pipe(Effect.orDie)
  if (rows.length !== 1) return yield* Effect.fail(new AccessDeniedError())
  const principal = rows[0]!
  if (
    ControlPrincipal.principalRef(principal) !== run.subject.principalRef ||
    ControlPrincipal.controlPlaneID(principal, {
      location: run.subject.location,
      projectID: run.subject.project,
      action: run.operation.kind,
    }) !== run.subject.id
  )
    return yield* Effect.fail(new AccessDeniedError())
  // Embedded private mode has no synthetic identity_user/member rows.
  if (ControlPrincipal.isLocalPrincipal(principal)) return { ...principal, role: "owner" as const }
  const membership = yield* database.db
    .select({ role: IdentityTenantMemberTable.role })
    .from(IdentityTenantMemberTable)
    .innerJoin(IdentityUserTable, eq(IdentityUserTable.id, IdentityTenantMemberTable.user_id))
    .where(
      and(
        eq(IdentityTenantMemberTable.tenant_id, principal.tenantID),
        eq(IdentityTenantMemberTable.user_id, principal.userID),
        eq(IdentityTenantMemberTable.status, "active"),
        eq(IdentityUserTable.status, "active"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!membership) return yield* Effect.fail(new AccessDeniedError())
  return { ...principal, role: membership.role }
})
