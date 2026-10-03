/**
 * Multi-agent write-conflict control.
 *
 * A child may inspect a workspace in read-only mode, or mutate it through an
 * explicitly selected isolation mode.  A merge is only a plan for a separate
 * L2/L3 Action: this module never applies a diff and never overwrites a
 * changed file on behalf of a caller.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { join, resolve, win32 } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Exit } from "effect"
import { AgentV2 } from "../agent"
import { ActionGateway } from "../action-gateway"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { canonicalHash } from "../util/canonical-hash"
import { Flock } from "../util/flock"

export const WRITE_CONFLICT_SCHEMA_VERSION = 1 as const

export type WriteAccess = "read" | "write"
export type WriteIsolation = "read-only" | "workspace-exclusive" | "isolated-worktree"
export type MergeRiskTier = "L2" | "L3"
export type MergeAuthorization = "scoped-grant" | "human-approved"

export type WriteConflictErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PATH"
  | "INVALID_DIGEST"
  | "LANE_CONFLICT"
  | "STALE_BASE"
  | "FILE_CONFLICT"
  | "MERGE_NOT_AUTHORIZED"
  | "VERIFICATION_REQUIRED"

export class WriteConflictError extends Error {
  constructor(
    readonly code: WriteConflictErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "WriteConflictError"
  }
}

export interface WriteLaneRequest {
  readonly parentRunID: string
  readonly childRunID: string
  readonly nodeID: string
  readonly ownerID: string
  readonly workspace: string
  readonly access: WriteAccess
  readonly isolation?: WriteIsolation
}

export interface WriteLanePolicy {
  readonly schemaVersion: typeof WRITE_CONFLICT_SCHEMA_VERSION
  readonly parentRunID: string
  readonly childRunID: string
  readonly nodeID: string
  readonly ownerID: string
  readonly workspaceKey: string
  readonly laneKey: string
  readonly mode: WriteIsolation
  readonly canMutate: boolean
  readonly policyDigest: string
}

export interface WriteLaneOptions {
  /** Stable process-shared directory; mainly overridden by isolated tests. */
  readonly lockDirectory?: string
}

export interface ActiveWriteClaim {
  readonly ownerID: string
  readonly childRunID?: string
  readonly changedPaths: ReadonlyArray<string>
}

export type FileChangeStatus = "added" | "modified" | "deleted"

export interface FileChange {
  readonly path: string
  readonly status: FileChangeStatus
  readonly beforeDigest?: string
  readonly afterDigest?: string
}

export interface TestReceipt {
  readonly name: string
  readonly status: "passed" | "failed"
  readonly resultDigest: string
}

export interface WriteChangeReceipt {
  readonly schemaVersion: typeof WRITE_CONFLICT_SCHEMA_VERSION
  readonly parentRunID: string
  readonly childRunID: string
  readonly nodeID: string
  readonly workspaceKey: string
  readonly isolation: Exclude<WriteIsolation, "read-only">
  readonly baseHeadDigest: string
  readonly headDigest: string
  readonly files: ReadonlyArray<FileChange>
  readonly tests: ReadonlyArray<TestReceipt>
  readonly diffDigest: string
}

export interface MergeActionPlan {
  readonly planID: string
  readonly actionKind: "repository.merge"
  readonly riskTier: MergeRiskTier
  readonly authority: "scoped_grant" | "human"
  readonly authorization: MergeAuthorization
  readonly requiresActionGateway: true
  readonly parentRunID: string
  readonly childRunID: string
  readonly nodeID: string
  readonly workspaceKey: string
  readonly baseHeadDigest: string
  readonly headDigest: string
  readonly diffDigest: string
  readonly changedPaths: ReadonlyArray<string>
  readonly tests: ReadonlyArray<TestReceipt>
  readonly resources: ReadonlyArray<string>
  readonly inputDigest: string
  readonly planDigest: string
}

export interface MergeActionSessionSubject {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly runID: AgentRuntime.RunID
  readonly stepID?: AgentRuntime.StepID
}

export interface MergeActionBinding {
  readonly planID: string
  readonly input: ActionGateway.Input
  readonly authorization: ActionGateway.AuthorizationPlan
}

export interface MergeRepositoryObservation {
  readonly headDigest: string
  readonly diffDigest: string
  readonly changedPaths: ReadonlyArray<string>
}

export interface MergeActionExecutionResult<A> {
  readonly value: A
  readonly observation: MergeRepositoryObservation
  readonly tests: ReadonlyArray<TestReceipt>
}

export interface MergeActionExecutor<A, E, R> {
  readonly inspect: () => Effect.Effect<MergeRepositoryObservation, E, R>
  readonly apply: (
    capability: ActionGateway.AuthorizationGrantCapability,
    plan: MergeActionPlan,
  ) => Effect.Effect<A, E, R>
  readonly verifyTests: (plan: MergeActionPlan) => Effect.Effect<ReadonlyArray<TestReceipt>, E, R>
  readonly successSummary?: (value: A) => string
  readonly estimatedCostMicros?: number
  readonly costMicros?: (value: A) => number
}

export interface MergeEvaluationInput {
  readonly receipt: WriteChangeReceipt
  readonly currentHeadDigest: string
  readonly activeClaims?: ReadonlyArray<ActiveWriteClaim>
  readonly riskTier: MergeRiskTier
  readonly authorization: MergeAuthorization
}

export interface MergeDecision {
  readonly schemaVersion: typeof WRITE_CONFLICT_SCHEMA_VERSION
  readonly allowed: boolean
  readonly action: "blocked" | "ready"
  readonly failedChecks: ReadonlyArray<string>
  readonly reason: string
  readonly inputDigest: string
  readonly decisionDigest: string
  readonly plan?: MergeActionPlan
}

export interface ParentMergeVerificationInput {
  readonly plan: MergeActionPlan
  readonly binding: MergeActionBinding
  readonly observedActionID: AgentRuntime.ActionID
  readonly observedActionIntentDigest: string
  readonly actionStatus: "settled" | "blocked" | "cancelled"
  readonly observedParentRunID: AgentRuntime.RunID
  readonly parentStatus: AgentRuntime.RunStatus
  readonly observedHeadDigest: string
  readonly observedDiffDigest: string
  readonly observedChangedPaths: ReadonlyArray<string>
  readonly tests: ReadonlyArray<TestReceipt>
}

export interface ParentMergeVerification {
  readonly verifier: "parent"
  readonly passed: boolean
  readonly failedChecks: ReadonlyArray<string>
  readonly evidenceDigest: string
  readonly summary: string
}

export type DurableParentMergeVerificationInput = Omit<
  ParentMergeVerificationInput,
  "actionStatus" | "observedActionID" | "observedActionIntentDigest" | "observedParentRunID" | "parentStatus"
>

export interface DurableMergeActionSnapshot {
  readonly action: {
    readonly id: AgentRuntime.ActionID
    readonly status: AgentRuntime.Action["status"]
    readonly intentDigest?: string
  }
  readonly observation?: { readonly status: AgentRuntime.Observation["status"] }
}

export interface DurableMergeActionReader<E = never> {
  readonly load: (actionID: AgentRuntime.ActionID) => Effect.Effect<DurableMergeActionSnapshot, E>
}

export interface DurableMergeParentReader<E = never> {
  readonly load: (
    runID: AgentRuntime.RunID,
  ) => Effect.Effect<{ readonly run: { readonly id: AgentRuntime.RunID; readonly status: AgentRuntime.RunStatus } }, E>
}

const digestPattern = /^[a-f0-9]{64}$/i
const MAX_PATHS = 4096
const MAX_TESTS = 256
const MAX_PATH_LENGTH = 1024
const MAX_TEST_NAME_LENGTH = 256
const WRITE_ISOLATIONS = ["workspace-exclusive", "isolated-worktree"] as const

type WriteIsolationMode = (typeof WRITE_ISOLATIONS)[number]

const requireWriteIsolation = (value: unknown, field: string): WriteIsolationMode => {
  if (value === "workspace-exclusive" || value === "isolated-worktree") return value
  throw new WriteConflictError("INVALID_REQUEST", `${field} must be workspace-exclusive or isolated-worktree`)
}

const requireText = (value: string, field: string) => {
  const normalized = value.trim()
  if (!normalized) throw new WriteConflictError("INVALID_REQUEST", `${field} must be non-empty`)
  return normalized
}

const requireDigest = (value: string, field: string) => {
  const normalized = value.trim().toLowerCase()
  if (!digestPattern.test(normalized))
    throw new WriteConflictError("INVALID_DIGEST", `${field} must be a sha256 digest`)
  return normalized
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const pathIdentity = (path: string) => path.toLowerCase()

export const normalizeWorkspaceKey = (workspace: string) => {
  const raw = requireText(workspace, "workspace")
  if (raw.includes("\0")) throw new WriteConflictError("INVALID_REQUEST", "workspace contains a null byte")
  const lexical = (
    /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("//") ? win32.normalize(raw) : resolve(raw)
  ).replaceAll("\\", "/")
  const normalized = lexical === "/" || /^[A-Za-z]:\/$/.test(lexical) ? lexical : lexical.replace(/\/+$/, "")
  if (!normalized) throw new WriteConflictError("INVALID_REQUEST", "workspace must contain a path")
  return normalized.toLowerCase()
}

export const normalizeRelativePath = (input: string) => {
  const value = requireText(input, "path").replaceAll("\\", "/")
  if (
    value.length > MAX_PATH_LENGTH ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new WriteConflictError("INVALID_PATH", `path must be a bounded repository-relative path: ${input}`)
  return value
}

const normalizedPaths = (paths: ReadonlyArray<string>) => {
  if (paths.length === 0 || paths.length > MAX_PATHS)
    throw new WriteConflictError("INVALID_PATH", `changed paths must contain between 1 and ${MAX_PATHS} paths`)
  const result = paths.map(normalizeRelativePath).toSorted(compareText)
  if (new Set(result.map(pathIdentity)).size !== result.length)
    throw new WriteConflictError("INVALID_PATH", "changed paths must be unique, including case-insensitive aliases")
  return result
}

const normalizedFiles = (files: ReadonlyArray<FileChange>) => {
  if (files.length === 0 || files.length > MAX_PATHS)
    throw new WriteConflictError("INVALID_PATH", `file changes must contain between 1 and ${MAX_PATHS} files`)
  const result = files
    .map((file) => {
      const path = normalizeRelativePath(file.path)
      if (!(<ReadonlyArray<FileChangeStatus>>["added", "modified", "deleted"]).includes(file.status))
        throw new WriteConflictError("INVALID_REQUEST", `unsupported file change status for ${path}`)
      const beforeDigest =
        file.beforeDigest === undefined ? undefined : requireDigest(file.beforeDigest, `${path}.beforeDigest`)
      const afterDigest =
        file.afterDigest === undefined ? undefined : requireDigest(file.afterDigest, `${path}.afterDigest`)
      if (file.status === "added" && beforeDigest !== undefined)
        throw new WriteConflictError("INVALID_REQUEST", `added file ${path} cannot have a before digest`)
      if (file.status === "deleted" && afterDigest !== undefined)
        throw new WriteConflictError("INVALID_REQUEST", `deleted file ${path} cannot have an after digest`)
      if (file.status === "modified" && (beforeDigest === undefined || afterDigest === undefined))
        throw new WriteConflictError("INVALID_REQUEST", `modified file ${path} requires before and after digests`)
      if (file.status === "modified" && beforeDigest === afterDigest)
        throw new WriteConflictError("INVALID_REQUEST", `modified file ${path} must change its content digest`)
      if (file.status === "added" && afterDigest === undefined)
        throw new WriteConflictError("INVALID_REQUEST", `added file ${path} requires an after digest`)
      if (file.status === "deleted" && beforeDigest === undefined)
        throw new WriteConflictError("INVALID_REQUEST", `deleted file ${path} requires a before digest`)
      return {
        path,
        status: file.status,
        ...(beforeDigest ? { beforeDigest } : {}),
        ...(afterDigest ? { afterDigest } : {}),
      }
    })
    .toSorted((left, right) => compareText(left.path, right.path))
  if (new Set(result.map((file) => pathIdentity(file.path))).size !== result.length)
    throw new WriteConflictError(
      "INVALID_PATH",
      "file changes must contain one entry per path, including case-insensitive aliases",
    )
  return result
}

const normalizedTests = (tests: ReadonlyArray<TestReceipt>) => {
  if (tests.length === 0 || tests.length > MAX_TESTS)
    throw new WriteConflictError("VERIFICATION_REQUIRED", `test receipts must contain between 1 and ${MAX_TESTS} tests`)
  const result = tests
    .map((test) => {
      const name = requireText(test.name, "test name")
      if (name.length > MAX_TEST_NAME_LENGTH)
        throw new WriteConflictError(
          "VERIFICATION_REQUIRED",
          `test name must not exceed ${MAX_TEST_NAME_LENGTH} characters`,
        )
      return {
        name,
        status: (() => {
          if (!(<ReadonlyArray<TestReceipt["status"]>>["passed", "failed"]).includes(test.status))
            throw new WriteConflictError("VERIFICATION_REQUIRED", `unsupported test status for ${test.name}`)
          return test.status
        })(),
        resultDigest: requireDigest(test.resultDigest, `test ${test.name} resultDigest`),
      }
    })
    .toSorted((left, right) => compareText(left.name, right.name))
  if (new Set(result.map((test) => test.name)).size !== result.length)
    throw new WriteConflictError("VERIFICATION_REQUIRED", "test receipts must be unique by name")
  return result
}

const digestOf = (value: unknown, field: string) => {
  const result = canonicalHash(value)
  if (!result) throw new WriteConflictError("INVALID_REQUEST", `${field} is not canonically hashable`)
  return result
}

const canonicalResourceSet = (resources: ReadonlyArray<string>) => {
  const canonical = resources.map((resource) => requireText(resource, "authorization resource")).toSorted(compareText)
  if (new Set(canonical).size !== canonical.length)
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "authorization resources must be unique")
  return canonical
}

export const makeWriteLanePolicy = (request: WriteLaneRequest): WriteLanePolicy => {
  const parentRunID = requireText(request.parentRunID, "parentRunID")
  const childRunID = requireText(request.childRunID, "childRunID")
  const nodeID = requireText(request.nodeID, "nodeID")
  const ownerID = requireText(request.ownerID, "ownerID")
  const workspaceKey = normalizeWorkspaceKey(request.workspace)
  if (!(<ReadonlyArray<WriteAccess>>["read", "write"]).includes(request.access))
    throw new WriteConflictError("INVALID_REQUEST", "write lane access must be read or write")
  if (
    request.isolation !== undefined &&
    !(<ReadonlyArray<WriteIsolation>>["read-only", "workspace-exclusive", "isolated-worktree"]).includes(
      request.isolation,
    )
  )
    throw new WriteConflictError("INVALID_REQUEST", "unsupported write lane isolation")
  const mode: WriteIsolation = request.access === "read" ? "read-only" : (request.isolation ?? "workspace-exclusive")
  if (request.access === "read" && request.isolation !== undefined && request.isolation !== "read-only")
    throw new WriteConflictError("INVALID_REQUEST", "read children cannot request a write isolation mode")
  if (request.access === "write" && mode === "read-only")
    throw new WriteConflictError("INVALID_REQUEST", "write children cannot use read-only isolation")
  const laneKey =
    mode === "isolated-worktree"
      ? `worktree:${workspaceKey}:${childRunID}`
      : mode === "workspace-exclusive"
        ? `workspace:${workspaceKey}`
        : `read:${workspaceKey}`
  const policyDigest = digestOf(
    {
      schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
      parentRunID,
      childRunID,
      nodeID,
      ownerID,
      workspaceKey,
      laneKey,
      mode,
    },
    "write lane policy",
  )
  return {
    schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
    parentRunID,
    childRunID,
    nodeID,
    ownerID,
    workspaceKey,
    laneKey,
    mode,
    canMutate: mode !== "read-only",
    policyDigest,
  }
}

const writeLaneLockDirectory = join(tmpdir(), "arforge-write-lanes-v1")

/**
 * Host-wide workspace-exclusive lane backed by the repository's heartbeat
 * file lock. Isolated worktrees get independent write lanes; their eventual
 * merge still goes through evaluateMerge, which rejects a stale base or an
 * overlapping active claim.
 */
export async function withWriteLane<T>(
  request: WriteLaneRequest,
  signal: AbortSignal,
  work: (policy: WriteLanePolicy) => Promise<T>,
  options: WriteLaneOptions = {},
): Promise<T> {
  const policy = makeWriteLanePolicy(request)
  if (!policy.canMutate) return work(policy)
  try {
    return await Flock.withLock(
      policy.laneKey,
      async () => {
        if (signal.aborted) throw new WriteConflictError("LANE_CONFLICT", "write lane was interrupted")
        return await work(policy)
      },
      {
        dir: options.lockDirectory ?? writeLaneLockDirectory,
        signal,
      },
    )
  } catch (error) {
    if (error instanceof WriteConflictError) throw error
    throw new WriteConflictError(
      "LANE_CONFLICT",
      signal.aborted ? "write lane acquisition was interrupted" : "workspace write lane could not be acquired safely",
    )
  }
}

export const overlappingPaths = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): ReadonlyArray<string> => {
  const leftSet = new Set(normalizedPaths(left).map(pathIdentity))
  return normalizedPaths(right).filter((path) => leftSet.has(pathIdentity(path)))
}

export const makeWriteChangeReceipt = (input: {
  readonly parentRunID: string
  readonly childRunID: string
  readonly nodeID: string
  readonly workspace: string
  readonly isolation: Exclude<WriteIsolation, "read-only">
  readonly baseHeadDigest: string
  readonly headDigest: string
  readonly files: ReadonlyArray<FileChange>
  readonly tests: ReadonlyArray<TestReceipt>
}): WriteChangeReceipt => {
  const isolation = requireWriteIsolation(input.isolation, "write receipt isolation")
  const baseHeadDigest = requireDigest(input.baseHeadDigest, "baseHeadDigest")
  const headDigest = requireDigest(input.headDigest, "headDigest")
  if (baseHeadDigest === headDigest) throw new WriteConflictError("INVALID_REQUEST", "a write receipt must change HEAD")
  const files = normalizedFiles(input.files)
  const tests = normalizedTests(input.tests)
  const parentRunID = requireText(input.parentRunID, "parentRunID")
  const childRunID = requireText(input.childRunID, "childRunID")
  const nodeID = requireText(input.nodeID, "nodeID")
  const workspaceKey = normalizeWorkspaceKey(input.workspace)
  const diffDigest = digestOf(
    {
      schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
      parentRunID,
      childRunID,
      nodeID,
      workspaceKey,
      isolation,
      baseHeadDigest,
      headDigest,
      files,
    },
    "write diff",
  )
  return {
    schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
    parentRunID,
    childRunID,
    nodeID,
    workspaceKey,
    isolation,
    baseHeadDigest,
    headDigest,
    files,
    tests,
    diffDigest,
  }
}

const canonicalReceipt = (receipt: WriteChangeReceipt): WriteChangeReceipt => {
  if (receipt.schemaVersion !== WRITE_CONFLICT_SCHEMA_VERSION)
    throw new WriteConflictError("INVALID_REQUEST", "unsupported write receipt schema version")
  const canonical = makeWriteChangeReceipt({
    parentRunID: receipt.parentRunID,
    childRunID: receipt.childRunID,
    nodeID: receipt.nodeID,
    workspace: receipt.workspaceKey,
    isolation: receipt.isolation,
    baseHeadDigest: receipt.baseHeadDigest,
    headDigest: receipt.headDigest,
    files: receipt.files,
    tests: receipt.tests,
  })
  const suppliedDiffDigest = requireDigest(receipt.diffDigest, "diffDigest")
  if (suppliedDiffDigest !== canonical.diffDigest)
    throw new WriteConflictError("INVALID_DIGEST", "write receipt diff digest does not match its canonical file list")
  const suppliedProjection = {
    schemaVersion: receipt.schemaVersion,
    parentRunID: receipt.parentRunID,
    childRunID: receipt.childRunID,
    nodeID: receipt.nodeID,
    workspaceKey: receipt.workspaceKey,
    isolation: receipt.isolation,
    baseHeadDigest: receipt.baseHeadDigest,
    headDigest: receipt.headDigest,
    files: receipt.files,
    tests: receipt.tests,
    diffDigest: receipt.diffDigest,
  }
  if (digestOf(suppliedProjection, "write receipt") !== digestOf(canonical, "canonical write receipt"))
    throw new WriteConflictError("INVALID_REQUEST", "write receipt must use canonical normalized fields and ordering")
  return canonical
}

const samePaths = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const normalizedLeft = normalizedPaths(left)
  const normalizedRight = normalizedPaths(right)
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((path, index) => pathIdentity(path) === pathIdentity(normalizedRight[index]))
  )
}

const canonicalClaims = (claims: ReadonlyArray<ActiveWriteClaim>) =>
  claims
    .map((claim) => ({
      ownerID: requireText(claim.ownerID, "active claim ownerID"),
      ...(claim.childRunID === undefined
        ? {}
        : { childRunID: requireText(claim.childRunID, "active claim childRunID") }),
      changedPaths: normalizedPaths(claim.changedPaths),
    }))
    .toSorted((left, right) => compareText(digestOf(left, "active claim"), digestOf(right, "active claim")))

const mergeInputDigest = (input: {
  readonly receipt: WriteChangeReceipt
  readonly currentHeadDigest: string
  readonly activeClaims: ReadonlyArray<ActiveWriteClaim>
  readonly riskTier: MergeRiskTier
  readonly authorization: MergeAuthorization
}) =>
  digestOf(
    {
      schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
      receipt: input.receipt,
      currentHeadDigest: input.currentHeadDigest,
      activeClaims: input.activeClaims,
      riskTier: input.riskTier,
      authorization: input.authorization,
    },
    "merge input",
  )

/**
 * Pure preflight for the separate merge Action.  A ready decision grants no
 * mutation capability; callers must bind the returned inputDigest/resources
 * to ActionGateway at L2 or L3 before applying anything.
 */
export const evaluateMerge = (input: MergeEvaluationInput): MergeDecision => {
  let inputDigest = ""
  const failedChecks: string[] = []
  try {
    const receipt = canonicalReceipt(input.receipt)
    const currentHeadDigest = requireDigest(input.currentHeadDigest, "currentHeadDigest")
    if (!(["L2", "L3"] as ReadonlyArray<string>).includes(input.riskTier))
      failedChecks.push("merge must be an L2 or L3 Action")
    if (!(["scoped-grant", "human-approved"] as ReadonlyArray<string>).includes(input.authorization))
      failedChecks.push("merge authorization is invalid")
    const activeClaims = canonicalClaims(input.activeClaims ?? [])
    inputDigest = mergeInputDigest({
      receipt,
      currentHeadDigest,
      activeClaims,
      riskTier: input.riskTier,
      authorization: input.authorization,
    })
    if (receipt.baseHeadDigest !== currentHeadDigest) failedChecks.push("current HEAD differs from the child base HEAD")
    if (receipt.tests.some((test) => test.status !== "passed"))
      failedChecks.push("all required child tests must pass before merge")
    if (input.riskTier === "L2" && input.authorization !== "scoped-grant")
      failedChecks.push("L2 merge requires a scoped grant")
    if (input.riskTier === "L3" && input.authorization !== "human-approved")
      failedChecks.push("L3 merge requires explicit human approval")
    const receiptPaths = receipt.files.map((file) => file.path)
    for (const claim of activeClaims) {
      const overlap = overlappingPaths(receiptPaths, claim.changedPaths)
      if (overlap.length > 0)
        failedChecks.push(`active write claim overlaps ${overlap.join(", ")}; automatic overwrite is forbidden`)
    }
    if (failedChecks.length === 0) {
      const authority: MergeActionPlan["authority"] = input.riskTier === "L2" ? "scoped_grant" : "human"
      const resources = [`workspace:${receipt.workspaceKey}`, ...receiptPaths.map((path) => `file:${path}`)]
      const planProjection = {
        actionKind: "repository.merge" as const,
        riskTier: input.riskTier,
        authority,
        authorization: input.authorization,
        requiresActionGateway: true as const,
        parentRunID: receipt.parentRunID,
        childRunID: receipt.childRunID,
        nodeID: receipt.nodeID,
        workspaceKey: receipt.workspaceKey,
        baseHeadDigest: receipt.baseHeadDigest,
        headDigest: receipt.headDigest,
        diffDigest: receipt.diffDigest,
        changedPaths: receiptPaths,
        tests: receipt.tests,
        resources,
        inputDigest,
      }
      const planDigest = digestOf(planProjection, "merge action plan")
      const plan: MergeActionPlan = {
        planID: `merge_${planDigest.slice(0, 32)}`,
        ...planProjection,
        planDigest,
      }
      const decisionWithoutDigest = {
        schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
        allowed: true,
        action: "ready" as const,
        failedChecks: [],
        reason: "merge preflight passed; execute only through the bound ActionGateway action",
        inputDigest,
        plan,
      }
      return { ...decisionWithoutDigest, decisionDigest: digestOf(decisionWithoutDigest, "merge decision") }
    }
  } catch (error) {
    failedChecks.push(error instanceof Error ? error.message : String(error))
  }
  const blocked = {
    schemaVersion: WRITE_CONFLICT_SCHEMA_VERSION,
    allowed: false,
    action: "blocked" as const,
    failedChecks: [...new Set(failedChecks)],
    reason: "merge preflight failed closed; no merge action may execute",
    inputDigest,
  }
  return { ...blocked, decisionDigest: digestOf(blocked, "merge decision") }
}

export const validateMergeActionPlan = (plan: MergeActionPlan): MergeActionPlan => {
  if (plan.actionKind !== "repository.merge")
    throw new WriteConflictError("INVALID_REQUEST", "merge plan action kind is invalid")
  if (!plan.requiresActionGateway)
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge plan must require ActionGateway")
  if (!(["L2", "L3"] as ReadonlyArray<string>).includes(plan.riskTier))
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge plan must use L2 or L3 risk")
  if (!(["scoped-grant", "human-approved"] as ReadonlyArray<string>).includes(plan.authorization))
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge plan authorization is invalid")
  const expectedAuthority: MergeActionPlan["authority"] = plan.riskTier === "L2" ? "scoped_grant" : "human"
  const expectedAuthorization: MergeAuthorization = plan.riskTier === "L2" ? "scoped-grant" : "human-approved"
  if (plan.authority !== expectedAuthority || plan.authorization !== expectedAuthorization)
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge plan authority does not match its risk tier")

  const parentRunID = requireText(plan.parentRunID, "merge plan parentRunID")
  const childRunID = requireText(plan.childRunID, "merge plan childRunID")
  const nodeID = requireText(plan.nodeID, "merge plan nodeID")
  const workspaceKey = normalizeWorkspaceKey(plan.workspaceKey)
  const baseHeadDigest = requireDigest(plan.baseHeadDigest, "merge plan baseHeadDigest")
  const headDigest = requireDigest(plan.headDigest, "merge plan headDigest")
  const diffDigest = requireDigest(plan.diffDigest, "merge plan diffDigest")
  const inputDigest = requireDigest(plan.inputDigest, "merge plan inputDigest")
  if (baseHeadDigest === headDigest) throw new WriteConflictError("INVALID_REQUEST", "merge plan must change HEAD")
  const changedPaths = normalizedPaths(plan.changedPaths)
  const tests = normalizedTests(plan.tests)
  if (tests.some((test) => test.status !== "passed"))
    throw new WriteConflictError("VERIFICATION_REQUIRED", "merge plan contains a failed child test")
  const resources = [`workspace:${workspaceKey}`, ...changedPaths.map((path) => `file:${path}`)]

  const projection = {
    actionKind: "repository.merge" as const,
    riskTier: plan.riskTier,
    authority: expectedAuthority,
    authorization: expectedAuthorization,
    requiresActionGateway: true as const,
    parentRunID,
    childRunID,
    nodeID,
    workspaceKey,
    baseHeadDigest,
    headDigest,
    diffDigest,
    changedPaths,
    tests,
    resources,
    inputDigest,
  }
  const suppliedProjection = {
    actionKind: plan.actionKind,
    riskTier: plan.riskTier,
    authority: plan.authority,
    authorization: plan.authorization,
    requiresActionGateway: plan.requiresActionGateway,
    parentRunID: plan.parentRunID,
    childRunID: plan.childRunID,
    nodeID: plan.nodeID,
    workspaceKey: plan.workspaceKey,
    baseHeadDigest: plan.baseHeadDigest,
    headDigest: plan.headDigest,
    diffDigest: plan.diffDigest,
    changedPaths: plan.changedPaths,
    tests: plan.tests,
    resources: plan.resources,
    inputDigest: plan.inputDigest,
  }
  if (digestOf(suppliedProjection, "supplied merge plan") !== digestOf(projection, "canonical merge plan"))
    throw new WriteConflictError("INVALID_REQUEST", "merge plan must use canonical normalized fields and ordering")
  const planDigest = digestOf(projection, "merge action plan")
  const planID = `merge_${planDigest.slice(0, 32)}`
  if (requireDigest(plan.planDigest, "merge plan planDigest") !== planDigest || plan.planID !== planID)
    throw new WriteConflictError("INVALID_DIGEST", "merge plan identity does not match its canonical content")
  return { planID, ...projection, planDigest }
}

export const bindMergeAction = (plan: MergeActionPlan, subject: MergeActionSessionSubject): MergeActionBinding => {
  const canonical = validateMergeActionPlan(plan)
  if (String(subject.runID) !== canonical.parentRunID)
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge Action run does not match the parent run")
  const toolCallID = `repository.merge:${canonical.planID}`
  const actionID = ActionGateway.stableActionID({
    runID: subject.runID,
    sessionID: subject.sessionID,
    assistantMessageID: subject.assistantMessageID,
    toolCallID,
  })
  const input: ActionGateway.Input = {
    kind: "session",
    sessionID: subject.sessionID,
    agent: subject.agent,
    assistantMessageID: subject.assistantMessageID,
    toolCallID,
    actionID,
    runID: subject.runID,
    ...(subject.stepID ? { stepID: subject.stepID } : {}),
    name: "repository.merge",
    resources: canonical.resources,
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: canonical.riskTier,
      authority: canonical.authority,
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "compensatable",
      filesystemScope: [canonical.workspaceKey],
      networkScope: [],
      secretScope: [],
      externalServices: [],
      compensation: "restore the approved base HEAD through a separate authorized repository action",
      expectedArtifacts: ["merge observation", "post-merge test receipt"],
      successCriteria: ["approved HEAD", "approved diff", "parent verifier passes"],
    }),
    reasonSummary: `Merge verified child result ${canonical.childRunID}`,
    initiator: "agent",
    traceID: `merge:${canonical.planDigest}`,
    inputDigest: canonical.planDigest,
  }
  const authorization = ActionGateway.canonicalPlan({
    requests: [{ action: "repository.merge", resources: canonical.resources }],
    metadata: {
      domain: "arforge.repository-merge/v1",
      planID: canonical.planID,
      planDigest: canonical.planDigest,
      childRunID: canonical.childRunID,
      nodeID: canonical.nodeID,
      baseHeadDigest: canonical.baseHeadDigest,
      headDigest: canonical.headDigest,
      diffDigest: canonical.diffDigest,
    },
  })
  return { planID: canonical.planID, input, authorization }
}

export const validateMergeActionBinding = (plan: MergeActionPlan, binding: MergeActionBinding): MergeActionBinding => {
  const canonical = validateMergeActionPlan(plan)
  const input = binding.input
  if (input.kind === "control-plane" || !("sessionID" in input))
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "repository merge must be bound to its parent session")
  if (binding.planID !== canonical.planID || input.runID !== canonical.parentRunID)
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge Action is bound to a different plan or run")
  const expected = bindMergeAction(canonical, {
    sessionID: input.sessionID,
    agent: input.agent,
    assistantMessageID: input.assistantMessageID,
    runID: input.runID,
    ...(input.stepID ? { stepID: input.stepID } : {}),
  })
  if (digestOf(binding, "supplied merge Action binding") !== digestOf(expected, "canonical merge Action binding"))
    throw new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge Action binding does not match its canonical plan")
  return expected
}

const mergeObservation = (
  value: MergeRepositoryObservation,
  options: { readonly allowEmptyPaths?: boolean } = {},
): MergeRepositoryObservation => ({
  headDigest: requireDigest(value.headDigest, "merge observation headDigest"),
  diffDigest: requireDigest(value.diffDigest, "merge observation diffDigest"),
  changedPaths: options.allowEmptyPaths && value.changedPaths.length === 0 ? [] : normalizedPaths(value.changedPaths),
})

const mergeExecutionFailure = (message: string) => new WriteConflictError("STALE_BASE", message)

export function executeMergeAction<A, E, R>(
  gateway: ActionGateway.Interface,
  plan: MergeActionPlan,
  binding: MergeActionBinding,
  executor: MergeActionExecutor<A, E, R>,
) {
  const canonicalPlan = validateMergeActionPlan(plan)
  const canonicalBinding = validateMergeActionBinding(canonicalPlan, binding)
  const costMicros = executor.costMicros
  return gateway.execute<MergeActionExecutionResult<A>, E | WriteConflictError, R>(canonicalBinding.input, {
    authorization: canonicalBinding.authorization,
    execute: (capability) =>
      Effect.gen(function* () {
        const granted = yield* Effect.try({
          try: () => ActionGateway.capabilityRequests(capability),
          catch: () => new WriteConflictError("MERGE_NOT_AUTHORIZED", "merge executor received no valid gateway grant"),
        })
        const expectedRequest = canonicalBinding.authorization.requests[0]
        if (
          granted.length !== 1 ||
          granted[0]?.action !== expectedRequest.action ||
          digestOf(canonicalResourceSet(granted[0]?.resources ?? []), "merge grant resources") !==
            digestOf(canonicalResourceSet(expectedRequest.resources), "merge authorization resources")
        )
          return yield* Effect.fail(
            new WriteConflictError(
              "MERGE_NOT_AUTHORIZED",
              "merge executor grant does not match the approved resources",
            ),
          )

        const before = yield* executor.inspect().pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => mergeObservation(value, { allowEmptyPaths: true }),
              catch: (cause) =>
                cause instanceof WriteConflictError
                  ? cause
                  : new WriteConflictError("INVALID_REQUEST", "pre-merge observation is invalid"),
            }),
          ),
        )
        if (before.headDigest !== canonicalPlan.baseHeadDigest)
          return yield* Effect.fail(
            mergeExecutionFailure(
              `repository HEAD changed after merge approval (${before.headDigest.slice(0, 12)} != ${canonicalPlan.baseHeadDigest.slice(0, 12)})`,
            ),
          )
        if (before.changedPaths.length > 0)
          return yield* Effect.fail(
            new WriteConflictError(
              "FILE_CONFLICT",
              "repository has uncommitted changes before merge; automatic overwrite is forbidden",
            ),
          )

        const value = yield* executor.apply(capability, canonicalPlan)
        const after = yield* executor.inspect().pipe(
          Effect.flatMap((observed) =>
            Effect.try({
              try: () => mergeObservation(observed),
              catch: (cause) =>
                cause instanceof WriteConflictError
                  ? cause
                  : new WriteConflictError("INVALID_REQUEST", "post-merge observation is invalid"),
            }),
          ),
        )
        if (after.headDigest !== canonicalPlan.headDigest)
          return yield* Effect.fail(
            new WriteConflictError("STALE_BASE", "post-merge HEAD differs from the approved result"),
          )
        if (after.diffDigest !== canonicalPlan.diffDigest)
          return yield* Effect.fail(
            new WriteConflictError("FILE_CONFLICT", "post-merge diff differs from the approved child receipt"),
          )
        if (!samePaths(after.changedPaths, canonicalPlan.changedPaths))
          return yield* Effect.fail(
            new WriteConflictError("FILE_CONFLICT", "post-merge changed paths differ from the approved child receipt"),
          )

        const tests = yield* executor.verifyTests(canonicalPlan).pipe(
          Effect.flatMap((receipts) =>
            Effect.try({
              try: () => normalizedTests(receipts),
              catch: (cause) =>
                cause instanceof WriteConflictError
                  ? cause
                  : new WriteConflictError("VERIFICATION_REQUIRED", "post-merge test receipts are invalid"),
            }),
          ),
        )
        const expectedTests = new Set(canonicalPlan.tests.map((test) => test.name))
        if (
          tests.some((test) => test.status !== "passed") ||
          tests.length !== expectedTests.size ||
          tests.some((test) => !expectedTests.has(test.name))
        )
          return yield* Effect.fail(
            new WriteConflictError("VERIFICATION_REQUIRED", "post-merge verification did not pass the approved tests"),
          )
        return { value, observation: after, tests } satisfies MergeActionExecutionResult<A>
      }),
    successSummary: (result) =>
      executor.successSummary?.(result.value) ?? `Repository merge ${canonicalPlan.planID} committed and verified`,
    ...(executor.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: executor.estimatedCostMicros }),
    ...(costMicros
      ? { costMicros: (result) => (Exit.isSuccess(result) ? costMicros(result.value.value) : undefined) }
      : {}),
  })
}

export const verifyParentMerge = (input: ParentMergeVerificationInput): ParentMergeVerification => {
  const failedChecks: string[] = []
  try {
    const plan = validateMergeActionPlan(input.plan)
    const binding = validateMergeActionBinding(plan, input.binding)
    const observedHeadDigest = requireDigest(input.observedHeadDigest, "observedHeadDigest")
    const observedDiffDigest = requireDigest(input.observedDiffDigest, "observedDiffDigest")
    const observedActionIntentDigest = requireDigest(input.observedActionIntentDigest, "observedActionIntentDigest")
    const expectedActionIntentDigest = ActionGateway.intentDigestOf(binding.input, binding.authorization)
    if (input.actionStatus !== "settled") failedChecks.push("merge Action did not settle successfully")
    if (input.observedActionID !== binding.input.actionID)
      failedChecks.push("settled Action ID does not match the approved merge binding")
    if (observedActionIntentDigest !== expectedActionIntentDigest)
      failedChecks.push("settled Action intent digest does not match the approved merge binding")
    if (String(input.observedParentRunID) !== plan.parentRunID)
      failedChecks.push("loaded parent Run ID does not match the approved merge plan")
    if (input.parentStatus !== "verifying" && input.parentStatus !== "completed")
      failedChecks.push("parent run is not in verifier phase")
    if (observedHeadDigest !== plan.headDigest) failedChecks.push("post-merge HEAD does not match the child result")
    if (observedDiffDigest !== plan.diffDigest)
      failedChecks.push("post-merge diff digest does not match the child receipt")
    if (!samePaths(input.observedChangedPaths, plan.changedPaths))
      failedChecks.push("post-merge changed paths do not match the approved merge plan")
    const tests = normalizedTests(input.tests)
    if (tests.some((test) => test.status !== "passed")) failedChecks.push("parent verifier tests did not all pass")
    const expectedTests = new Set(plan.tests.map((test) => test.name))
    if (tests.length !== expectedTests.size || tests.some((test) => !expectedTests.has(test.name)))
      failedChecks.push("parent verifier did not rerun the approved test set")
  } catch (error) {
    failedChecks.push(error instanceof Error ? error.message : String(error))
  }
  const evidenceDigest = digestOf(
    {
      verifier: "parent",
      planID: input.plan.planID,
      actionID: input.observedActionID,
      actionIntentDigest: input.observedActionIntentDigest,
      actionStatus: input.actionStatus,
      parentRunID: input.observedParentRunID,
      parentStatus: input.parentStatus,
      observedHeadDigest: input.observedHeadDigest,
      observedDiffDigest: input.observedDiffDigest,
      observedChangedPaths: input.observedChangedPaths,
      tests: input.tests,
      failedChecks,
    },
    "parent merge evidence",
  )
  return {
    verifier: "parent",
    passed: failedChecks.length === 0,
    failedChecks: [...new Set(failedChecks)],
    evidenceDigest,
    summary:
      failedChecks.length === 0
        ? "parent verifier passed the settled merge, HEAD, diff, changed-path, and test checks"
        : "parent verifier rejected the merge result",
  }
}

export const verifyParentMergeDurably = <ActionError, RunError>(
  durableActions: DurableMergeActionReader<ActionError>,
  durableRuns: DurableMergeParentReader<RunError>,
  input: DurableParentMergeVerificationInput,
) =>
  Effect.all({
    action: durableActions.load(input.binding.input.actionID),
    parent: durableRuns.load(AgentRuntime.RunID.make(input.plan.parentRunID)),
  }).pipe(
    Effect.map(({ action, parent }) =>
      verifyParentMerge({
        ...input,
        observedActionID: action.action.id,
        observedActionIntentDigest: action.action.intentDigest ?? "",
        observedParentRunID: parent.run.id,
        actionStatus:
          action.action.status === "settled" && action.observation?.status === "succeeded"
            ? "settled"
            : action.action.status === "cancelled"
              ? "cancelled"
              : "blocked",
        parentStatus: parent.run.status,
      }),
    ),
  )
