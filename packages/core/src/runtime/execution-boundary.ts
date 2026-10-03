/**
 * Shared execution-boundary contracts for read-only diagnostic projections.
 *
 * These values describe what a report is allowed to do; they are not an
 * authorization grant.  Keep the common fields and the state-specific field
 * in one Core owner so CLI, Desktop, and future machine clients cannot drift
 * into subtly different read-only semantics.
 */

export type ReadOnlyExecutionBoundary = Readonly<{
  readonly mode: "read-only"
  readonly writes: false
  readonly repairs_recovery: false
  readonly provider_execution_allowed: false
}>

export type WorkspaceReadOnlyExecutionBoundary = Readonly<
  ReadOnlyExecutionBoundary & {
    readonly creates_profile_state: false
  }
>

export type SettlementReadOnlyExecutionBoundary = Readonly<
  ReadOnlyExecutionBoundary & {
    readonly creates_settlement_state: false
  }
>

/**
 * Combined boundary used by diagnostics that report both profile and
 * settlement surfaces at once.  It intentionally carries both protections so
 * a UI does not have to infer one from the other.
 */
export type DiagnosticReadOnlyExecutionBoundary = Readonly<
  ReadOnlyExecutionBoundary & {
    readonly creates_profile_state: false
    readonly creates_settlement_state: false
  }
>

const commonReadOnlyBoundary = (): ReadOnlyExecutionBoundary => ({
  mode: "read-only",
  writes: false,
  repairs_recovery: false,
  provider_execution_allowed: false,
})

/** Build the workspace contract's immutable, non-authorizing boundary card. */
export const workspaceReadOnlyExecutionBoundary = (): WorkspaceReadOnlyExecutionBoundary => ({
  ...commonReadOnlyBoundary(),
  creates_profile_state: false,
})

/** Build the settlement contract's immutable, non-authorizing boundary card. */
export const settlementReadOnlyExecutionBoundary = (): SettlementReadOnlyExecutionBoundary => ({
  ...commonReadOnlyBoundary(),
  creates_settlement_state: false,
})

/** Build the combined diagnostic boundary without granting any execution. */
export const diagnosticReadOnlyExecutionBoundary = (): DiagnosticReadOnlyExecutionBoundary => ({
  ...commonReadOnlyBoundary(),
  creates_profile_state: false,
  creates_settlement_state: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  return JSON.stringify(actual) === JSON.stringify([...expected].sort())
}

const assertCommonBoundary = (value: unknown): void => {
  if (
    !isRecord(value) ||
    value.mode !== "read-only" ||
    value.writes !== false ||
    value.repairs_recovery !== false ||
    value.provider_execution_allowed !== false
  )
    throw new Error("execution boundary must remain read-only and non-authorizing")
}

/** Fail closed when a machine client attempts to cross a workspace boundary. */
export const assertWorkspaceReadOnlyExecutionBoundary = (
  value: unknown,
): asserts value is WorkspaceReadOnlyExecutionBoundary => {
  assertCommonBoundary(value)
  if (!isRecord(value) || value.creates_profile_state !== false)
    throw new Error("workspace execution boundary must not create profile state")
  if (
    !hasExactKeys(value, ["mode", "writes", "repairs_recovery", "provider_execution_allowed", "creates_profile_state"])
  )
    throw new Error("workspace execution boundary fields drifted")
}

/** Fail closed when a machine client attempts to cross a settlement boundary. */
export const assertSettlementReadOnlyExecutionBoundary = (
  value: unknown,
): asserts value is SettlementReadOnlyExecutionBoundary => {
  assertCommonBoundary(value)
  if (!isRecord(value) || value.creates_settlement_state !== false)
    throw new Error("settlement execution boundary must not create settlement state")
  if (
    !hasExactKeys(value, [
      "mode",
      "writes",
      "repairs_recovery",
      "provider_execution_allowed",
      "creates_settlement_state",
    ])
  )
    throw new Error("settlement execution boundary fields drifted")
}

/** Fail closed when a combined diagnostic boundary is incomplete or widened. */
export const assertDiagnosticReadOnlyExecutionBoundary = (
  value: unknown,
): asserts value is DiagnosticReadOnlyExecutionBoundary => {
  assertCommonBoundary(value)
  if (!isRecord(value) || value.creates_profile_state !== false || value.creates_settlement_state !== false)
    throw new Error("diagnostic execution boundary must not create profile or settlement state")
  if (
    !hasExactKeys(value, [
      "mode",
      "writes",
      "repairs_recovery",
      "provider_execution_allowed",
      "creates_profile_state",
      "creates_settlement_state",
    ])
  )
    throw new Error("diagnostic execution boundary fields drifted")
}
