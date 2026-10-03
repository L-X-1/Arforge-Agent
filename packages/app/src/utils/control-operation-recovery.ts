import {
  listPendingControlOperations,
  type ControlOperationOptions,
  type ControlOperationStatusLookup,
  type ServerControlOperationStatus,
  validateServerControlOperationStatus,
} from "./control-operation-intent"

export type { ControlOperationPhase, ServerControlOperationStatus } from "./control-operation-intent"

export type { ControlOperationStatusLookup } from "./control-operation-intent"

export type ControlOperationRecoveryTarget = {
  /** A configured server scope. It is not an authorization identity. */
  readonly scope: string
  /** Read-only ClaimIndex status lookup. It must never issue a mutation. */
  readonly lookup?: ControlOperationStatusLookup
}

export type StartedControlOperationRecovery = {
  readonly corruptKeys: ReadonlyArray<string>
  readonly unavailableServerScopes: ReadonlyArray<string>
  /**
   * A local intent exists for this configured server, but no authoritative
   * status could be read. The local intent remains only a reconnect hint.
   */
  readonly blockedServerScopes: ReadonlyArray<string>
  /** Server-authoritative phase projections, safe to display but never execute. */
  readonly statuses: ReadonlyArray<{
    readonly scope: string
    readonly status: ServerControlOperationStatus
  }>
  /**
   * Deliberately empty. A renderer restart must never issue a destructive
   * mutation merely because localStorage retained an intent.
   */
  readonly tasks: ReadonlyArray<never>
}

/**
 * Inspect locally recorded operation identities without replaying them. This
 * helper is deliberately layout-independent so the desktop root can report
 * blocked recovery for both the legacy and new layouts.
 *
 * The browser record is only a reconnect hint. A successful ClaimIndex lookup
 * is the sole source for displayed phase; an unknown/invalid response stays
 * blocked. This helper never retries, approves, or otherwise issues a
 * mutation from browser state.
 */
export async function startControlOperationRecovery(
  targets: ReadonlyArray<ControlOperationRecoveryTarget>,
  options?: ControlOperationOptions,
): Promise<StartedControlOperationRecovery> {
  const pending = await listPendingControlOperations(options)
  const byScope = new Map<string, ControlOperationRecoveryTarget>()
  for (const target of targets) {
    if (!byScope.has(target.scope)) byScope.set(target.scope, target)
  }

  const unavailableServerScopes = new Set<string>()
  const blockedServerScopes = new Set<string>()
  const statuses: Array<{ readonly scope: string; readonly status: ServerControlOperationStatus }> = []
  for (const intent of pending.intents) {
    const target = byScope.get(intent.binding.server)
    if (!target) {
      unavailableServerScopes.add(intent.binding.server)
      continue
    }
    if (!target.lookup) {
      blockedServerScopes.add(target.scope)
      continue
    }
    try {
      const status = validateServerControlOperationStatus(
        await target.lookup({
          requestID: intent.requestID,
          operation: intent.binding.kind,
          location: intent.binding.location,
        }),
        { requestID: intent.requestID, operation: intent.binding.kind },
      )
      statuses.push({ scope: target.scope, status })
    } catch {
      // Unknown aliases, auth failures, malformed replies, and unavailable
      // servers are indistinguishable to recovery. None permits a replay.
      blockedServerScopes.add(target.scope)
    }
  }

  return {
    corruptKeys: pending.corruptKeys,
    unavailableServerScopes: [...unavailableServerScopes],
    blockedServerScopes: [...blockedServerScopes],
    statuses,
    tasks: [],
  }
}
