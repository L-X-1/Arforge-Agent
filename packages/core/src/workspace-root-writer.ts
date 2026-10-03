import * as ActionGateway from "./action-gateway"
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  planWorkspaceRootMutation,
  type WorkspaceRootMutationAuthorization,
  type WorkspaceRootMutationPlan,
  type WorkspaceRootMutationRequest,
  type WorkspaceRootMutationStateSnapshot,
  type WorkspaceRootStateDigest,
  readWorkspaceRootMutationStateAt,
  workspaceRootMutationIntentDigest,
  workspaceRootMutationStateDigest,
} from "./workspace-roots"
import { Effect, Exit } from "effect"

/** Reasons exposed by the disabled-by-default workspace writer seam. */
export type WorkspaceRootWriterReason =
  | "writer_disabled"
  | "seam_missing"
  | "authorization_invalid"
  | "plan_mismatch"
  | "state_malformed"
  | "state_conflict"
  | "rollback_unavailable"
  | "outbox_unavailable"
  | "recovery_required"
  | "cas_rejected"
  | "audit_unavailable"

/** A payload-free, typed failure; filesystem/provider details stay out of user output. */
export class WorkspaceRootWriterError extends Error {
  readonly _tag = "WorkspaceRootWriterError"

  constructor(readonly reason: WorkspaceRootWriterReason) {
    super(`workspace root writer blocked: ${reason}`)
    this.name = "WorkspaceRootWriterError"
  }
}

export type WorkspaceRootMutationState = WorkspaceRootMutationStateSnapshot

export type WorkspaceRootRollbackArtifact = Readonly<{
  /** An opaque durable reference; the artifact contents never enter this seam. */
  readonly artifactID: string
  /** Digest of the exact pre-CAS state captured by the artifact owner. */
  readonly stateDigest: WorkspaceRootStateDigest
}>

export type WorkspaceRootRecoveryOutboxRecord = Readonly<{
  readonly schemaVersion: 1
  readonly action: WorkspaceRootMutationRequest["action"]
  readonly intentDigest: string
  readonly phase: "prepared" | "committed" | "recovery_required"
  readonly before: WorkspaceRootStateDigest
  readonly after: WorkspaceRootStateDigest
  readonly rollbackArtifactID: string
}>

export type WorkspaceRootMutationAudit = Readonly<{
  readonly action: WorkspaceRootMutationRequest["action"]
  readonly intentDigest: string
  readonly phase: "prepared" | "committed" | "recovery_required"
  readonly before: WorkspaceRootStateDigest
  readonly after: WorkspaceRootStateDigest
  readonly rollbackArtifactID: string
}>

/**
 * The persistence/recovery owner that a future workspace writer must supply.
 * These callbacks are intentionally narrow: no callback receives file bytes,
 * prompts, credentials, or a provider response.  `enabled` is false by
 * default and the production CLI does not construct this owner yet.
 */
export type WorkspaceRootWriterSeams = Readonly<{
  readonly enabled?: boolean
  readonly readState: () => Effect.Effect<WorkspaceRootMutationState, unknown, never>
  /** Re-check the target immediately before the CAS; remove does not require a directory. */
  readonly targetIsDirectory: (target: string) => Effect.Effect<boolean, unknown, never>
  readonly createRollbackArtifact: (input: {
    readonly before: WorkspaceRootMutationState
    readonly plan: WorkspaceRootMutationPlan
  }) => Effect.Effect<WorkspaceRootRollbackArtifact, unknown, never>
  /** Append before the state CAS and again after it; this is the recovery owner. */
  readonly appendRecoveryOutbox: (record: WorkspaceRootRecoveryOutboxRecord) => Effect.Effect<void, unknown, never>
  /** The sole state writer; it must atomically compare `expected` before applying `next`. */
  readonly compareAndSwap: (input: {
    readonly action: WorkspaceRootMutationRequest["action"]
    readonly intentDigest: string
    readonly expected: WorkspaceRootStateDigest
    readonly nextTrustedWorkspaces: ReadonlyArray<string>
    readonly nextConfiguredRoots: ReadonlyArray<string>
    readonly rollbackArtifactID: string
  }) => Effect.Effect<boolean, unknown, never>
  /** Append-only metadata audit; failure after CAS is recovery-required, never success. */
  readonly audit: (record: WorkspaceRootMutationAudit) => Effect.Effect<void, unknown, never>
  /**
   * Optional exact-replay probe used by a concrete owner after another
   * process has already committed the same immutable plan.  The owner must
   * verify a committed outbox receipt and matching audit coverage; it must
   * never infer success from the state image alone.
   */
  readonly findExactCommittedMutation?: (input: {
    readonly action: WorkspaceRootMutationRequest["action"]
    readonly intentDigest: string
    readonly before: WorkspaceRootStateDigest
    readonly after: WorkspaceRootStateDigest
  }) => Effect.Effect<WorkspaceRootRollbackArtifact | undefined, unknown, never>
  /**
   * Optional owner transaction boundary.  A file/database owner can hold its
   * exclusive lock across read → prepare → CAS → receipt → audit so duplicate
   * processes cannot observe a half-finalized commit.
   */
  readonly withExclusive?: <A>(operation: () => Effect.Effect<A, unknown, never>) => Effect.Effect<A, unknown, never>
}>

export type WorkspaceRootMutationCommit = Readonly<{
  readonly status: "committed" | "noop"
  readonly action: WorkspaceRootMutationRequest["action"]
  readonly intentDigest: string
  readonly before: WorkspaceRootStateDigest
  readonly after: WorkspaceRootStateDigest
  readonly rollbackArtifactID?: string
}>

const fail = (reason: WorkspaceRootWriterReason): Effect.Effect<never, WorkspaceRootWriterError> =>
  Effect.fail(new WorkspaceRootWriterError(reason))

const sameDigest = (left: WorkspaceRootStateDigest, right: WorkspaceRootStateDigest): boolean =>
  left.trusted === right.trusted && left.configured === right.configured

const samePlan = (left: WorkspaceRootMutationPlan, right: WorkspaceRootMutationPlan): boolean =>
  left.intentDigest === right.intentDigest &&
  left.action === right.action &&
  left.primary === right.primary &&
  left.target === right.target &&
  left.status === right.status &&
  left.changed === right.changed &&
  left.authorization.receiptID === right.authorization.receiptID &&
  left.authorization.actionID === right.authorization.actionID &&
  sameDigest(left.before, right.before) &&
  sameDigest(left.after, right.after) &&
  JSON.stringify(left.nextTrustedWorkspaces) === JSON.stringify(right.nextTrustedWorkspaces) &&
  JSON.stringify(left.nextConfiguredRoots) === JSON.stringify(right.nextConfiguredRoots)

const safeRollbackArtifact = (artifact: WorkspaceRootRollbackArtifact): WorkspaceRootRollbackArtifact | undefined => {
  if (
    typeof artifact.artifactID !== "string" ||
    artifact.artifactID.length === 0 ||
    artifact.artifactID.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(artifact.artifactID)
  )
    return undefined
  if (
    !artifact.stateDigest ||
    !/^[a-f0-9]{64}$/.test(artifact.stateDigest.trusted) ||
    !/^[a-f0-9]{64}$/.test(artifact.stateDigest.configured)
  )
    return undefined
  return artifact
}

const mapSeamError =
  (reason: WorkspaceRootWriterReason) =>
  (error: unknown): WorkspaceRootWriterError =>
    error instanceof WorkspaceRootWriterError ? error : new WorkspaceRootWriterError(reason)

const hasWriterSeams = (writer: WorkspaceRootWriterSeams): boolean =>
  typeof writer.readState === "function" &&
  typeof writer.targetIsDirectory === "function" &&
  typeof writer.createRollbackArtifact === "function" &&
  typeof writer.appendRecoveryOutbox === "function" &&
  typeof writer.compareAndSwap === "function" &&
  typeof writer.audit === "function"

/**
 * Verify that an ActionGateway-issued capability is the receipt for exactly
 * this workspace mutation.  The capability is unforgeable and the grant is
 * checked against the same action/resource scope used by the operation plan.
 */
export const authorizationFromActionGateway = (input: {
  readonly capability: ActionGateway.AuthorizationGrantCapability
  readonly action: Pick<ActionGateway.Input, "actionID" | "name">
  readonly request: WorkspaceRootMutationRequest
  readonly plan: Pick<WorkspaceRootMutationPlan, "intentDigest" | "primary" | "target">
}): WorkspaceRootMutationAuthorization => {
  let grant: ReturnType<typeof ActionGateway.capabilityGrant>
  try {
    grant = ActionGateway.capabilityGrant(input.capability)
  } catch {
    throw new WorkspaceRootWriterError("authorization_invalid")
  }
  if (
    grant === undefined ||
    grant.actionID !== input.action.actionID ||
    input.action.name !== `workspace.root.${input.request.action}` ||
    grant.authority !== "human" ||
    grant.riskTier !== "L3" ||
    grant.policyVersion !== ActionGateway.POLICY_VERSION
  )
    throw new WorkspaceRootWriterError("authorization_invalid")

  const expectedAction = `workspace-root:${input.request.action}`
  const expectedResources = [input.plan.primary, input.plan.target].sort()
  const matchingRequests = grant.requests.filter(
    (request) =>
      request.action === expectedAction &&
      JSON.stringify([...request.resources].sort()) === JSON.stringify(expectedResources),
  )
  if (matchingRequests.length !== 1 || grant.requests.length !== 1)
    throw new WorkspaceRootWriterError("authorization_invalid")

  return {
    kind: "action-gateway",
    status: "approved",
    receiptID: grant.id,
    actionID: input.action.actionID,
    workspace: input.plan.primary,
    target: input.plan.target,
    intentDigest: input.plan.intentDigest,
  }
}

/** Build the one ActionGateway permission scope used for all three mutations. */
export const actionGatewayAuthorizationPlan = (
  request: WorkspaceRootMutationRequest,
): ActionGateway.AuthorizationPlan => ({
  requests: [
    {
      action: `workspace-root:${request.action}`,
      resources: [request.primary, request.target],
    },
  ],
  metadata: {
    schemaVersion: 1,
    mutation: request.action,
    workspaceMutation: true,
  },
})

/**
 * Execute the bounded writer seam after a real ActionGateway authorization.
 * The default path is intentionally a hard block; enabling it requires every
 * persistence, rollback, recovery-outbox, CAS and audit callback above.
 */
export const executeWorkspaceRootMutation = (input: {
  readonly gateway: Pick<ActionGateway.Interface, "execute">
  readonly action: ActionGateway.Input
  readonly request: WorkspaceRootMutationRequest
  readonly writer: WorkspaceRootWriterSeams
}): Effect.Effect<WorkspaceRootMutationCommit, unknown> => {
  if (input.writer.enabled !== true) return fail("writer_disabled")
  if (!hasWriterSeams(input.writer)) return fail("seam_missing")

  const operation: ActionGateway.Operation<WorkspaceRootMutationCommit, unknown, never> = {
    authorization: actionGatewayAuthorizationPlan(input.request),
    execute: (capability) =>
      Effect.gen(function* () {
        const targetIsDirectory =
          input.request.action === "remove"
            ? input.request.targetIsDirectory
            : yield* input.writer
                .targetIsDirectory(input.request.target)
                .pipe(Effect.mapError(mapSeamError("state_malformed")))
        const request = { ...input.request, targetIsDirectory }
        const intentDigest = yield* Effect.try({
          try: () => workspaceRootMutationIntentDigest(request),
          catch: mapSeamError("plan_mismatch"),
        })
        const authorization = yield* Effect.try({
          try: () =>
            authorizationFromActionGateway({
              capability,
              action: input.action,
              request,
              plan: { intentDigest, primary: request.primary, target: request.target },
            }),
          catch: mapSeamError("authorization_invalid"),
        })
        const plan = yield* Effect.try({
          try: () => planWorkspaceRootMutation({ ...request, authorization }),
          catch: mapSeamError("plan_mismatch"),
        })
        return yield* commitWorkspaceRootMutation({ request, authorization, plan, writer: input.writer })
      }),
  }
  return input.gateway.execute(input.action, operation)
}

/**
 * Commit a planner result through the injected CAS/rollback/outbox/audit
 * owner.  This function has no filesystem fallback and therefore remains
 * safe to link into the CLI while the concrete writer is disabled.
 */
export const commitWorkspaceRootMutation = (input: {
  readonly request: WorkspaceRootMutationRequest
  readonly authorization: WorkspaceRootMutationAuthorization
  readonly plan: WorkspaceRootMutationPlan
  readonly writer: WorkspaceRootWriterSeams
}) =>
  Effect.gen(function* () {
    if (input.writer.enabled !== true) return yield* fail("writer_disabled")
    if (!hasWriterSeams(input.writer)) return yield* fail("seam_missing")
    const operation = Effect.gen(function* () {
      // This is deliberately the first persistence read in the commit seam:
      // callers cannot smuggle an earlier snapshot across an approval/CAS gap.
      const state = yield* input.writer.readState().pipe(Effect.mapError(mapSeamError("state_malformed")))
      const digest = yield* Effect.try({
        try: () => workspaceRootMutationStateDigest(state),
        catch: () => new WorkspaceRootWriterError("state_malformed"),
      })
      if (!sameDigest(digest, state.digest)) return yield* fail("state_malformed")
      if (!sameDigest(input.plan.before, digest)) {
        // A concrete owner may prove that another process already completed
        // this exact immutable plan.  State equality alone is insufficient:
        // the owner must report a committed receipt with matching audit
        // coverage before this path can return success.
        const exact = input.writer.findExactCommittedMutation
          ? yield* input.writer
              .findExactCommittedMutation({
                action: input.plan.action,
                intentDigest: input.plan.intentDigest,
                before: input.plan.before,
                after: input.plan.after,
              })
              .pipe(Effect.mapError(mapSeamError("state_malformed")))
          : undefined
        const exactArtifact = exact === undefined ? undefined : safeRollbackArtifact(exact)
        if (exactArtifact && sameDigest(exactArtifact.stateDigest, input.plan.before))
          return {
            status: "committed" as const,
            action: input.plan.action,
            intentDigest: input.plan.intentDigest,
            before: input.plan.before,
            after: input.plan.after,
            rollbackArtifactID: exactArtifact.artifactID,
          }
        if (exact !== undefined) return yield* fail("state_malformed")
        return yield* fail("state_conflict")
      }

      const rechecked = yield* Effect.try({
        try: () => planWorkspaceRootMutation({ ...input.request, authorization: input.authorization }),
        catch: mapSeamError("plan_mismatch"),
      })
      if (!samePlan(rechecked, input.plan)) return yield* fail("plan_mismatch")
      if (!input.plan.changed)
        return {
          status: "noop" as const,
          action: input.plan.action,
          intentDigest: input.plan.intentDigest,
          before: input.plan.before,
          after: input.plan.after,
        }

      const artifact = yield* input.writer
        .createRollbackArtifact({ before: state, plan: input.plan })
        .pipe(Effect.mapError(mapSeamError("rollback_unavailable")))
      const rollback = safeRollbackArtifact(artifact)
      if (!rollback || !sameDigest(rollback.stateDigest, input.plan.before)) return yield* fail("rollback_unavailable")

      const prepared: WorkspaceRootRecoveryOutboxRecord = {
        schemaVersion: 1,
        action: input.plan.action,
        intentDigest: input.plan.intentDigest,
        phase: "prepared",
        before: input.plan.before,
        after: input.plan.after,
        rollbackArtifactID: rollback.artifactID,
      }
      yield* input.writer.appendRecoveryOutbox(prepared).pipe(Effect.mapError(mapSeamError("outbox_unavailable")))

      const applied = yield* input.writer
        .compareAndSwap({
          action: input.plan.action,
          intentDigest: input.plan.intentDigest,
          expected: input.plan.before,
          nextTrustedWorkspaces: input.plan.nextTrustedWorkspaces,
          nextConfiguredRoots: input.plan.nextConfiguredRoots,
          rollbackArtifactID: rollback.artifactID,
        })
        .pipe(Effect.mapError(mapSeamError("cas_rejected")))

      const finalizeCommitted = Effect.gen(function* () {
        const committed: WorkspaceRootRecoveryOutboxRecord = { ...prepared, phase: "committed" }
        const recoveryRequired = { ...committed, phase: "recovery_required" as const }
        const appendCommitted = yield* input.writer.appendRecoveryOutbox(committed).pipe(Effect.exit)
        if (appendCommitted._tag === "Failure") {
          // CAS already changed durable state. Preserve an explicit
          // recovery-required marker whenever the committed receipt cannot be
          // appended; a caller must never mistake this path for an uncommitted
          // mutation.
          yield* input.writer.appendRecoveryOutbox(recoveryRequired).pipe(Effect.ignore)
          return yield* fail("outbox_unavailable")
        }
        const auditResult = yield* input.writer.audit(committed).pipe(Effect.exit)
        if (auditResult._tag === "Failure") {
          // Audit is part of the commit contract. A post-CAS audit failure is
          // therefore recovery-required, even though the state files are
          // already at the planned post-image.
          yield* input.writer.appendRecoveryOutbox(recoveryRequired).pipe(Effect.ignore)
          return yield* fail("audit_unavailable")
        }
        return {
          status: "committed" as const,
          action: input.plan.action,
          intentDigest: input.plan.intentDigest,
          before: input.plan.before,
          after: input.plan.after,
          rollbackArtifactID: rollback.artifactID,
        }
      })

      if (!applied) {
        // Another process may have won the exact same immutable plan between
        // our pre-read and CAS. Once the planned post-image is visible, finish
        // the idempotent metadata promotion instead of appending a misleading
        // recovery-required marker that would poison an otherwise committed
        // profile. A different post-image still takes the explicit conflict /
        // recovery path below.
        const observed = yield* input.writer.readState().pipe(Effect.exit)
        if (Exit.isSuccess(observed) && sameDigest(observed.value.digest, input.plan.after))
          return yield* finalizeCommitted
        const exact = input.writer.findExactCommittedMutation
          ? yield* input.writer
              .findExactCommittedMutation({
                action: input.plan.action,
                intentDigest: input.plan.intentDigest,
                before: input.plan.before,
                after: input.plan.after,
              })
              .pipe(Effect.mapError(mapSeamError("state_malformed")))
          : undefined
        const exactArtifact = exact === undefined ? undefined : safeRollbackArtifact(exact)
        if (exactArtifact && sameDigest(exactArtifact.stateDigest, input.plan.before))
          return {
            status: "committed" as const,
            action: input.plan.action,
            intentDigest: input.plan.intentDigest,
            before: input.plan.before,
            after: input.plan.after,
            rollbackArtifactID: exactArtifact.artifactID,
          }
        if (exact !== undefined) return yield* fail("state_malformed")
        yield* input.writer
          .appendRecoveryOutbox({ ...prepared, phase: "recovery_required" })
          .pipe(Effect.mapError(mapSeamError("outbox_unavailable")), Effect.ignore)
        return yield* fail("cas_rejected")
      }
      return yield* finalizeCommitted
    })
    if (input.writer.withExclusive) return yield* input.writer.withExclusive(() => operation)
    return yield* operation
  })
