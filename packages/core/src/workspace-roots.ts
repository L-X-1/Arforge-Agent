import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { canonicalHash } from "./util/canonical-hash"

/** Version of the profile-level workspace authorization files. */
export const WORKSPACE_ROOTS_SCHEMA_VERSION = 1 as const
/** Version of the read-only workspace-root mutation admission contract. */
export const WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION = 1 as const

const MAX_WORKSPACE_ROOT_ENTRIES = 64
const SHA256 = /^[a-f0-9]{64}$/

const truthy = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase())

const activeHome = (): string => resolve(process.env.ARFORGE_HOME?.trim() || join(homedir(), ".arforge"))

/** Resolve the profile directory used by the canonical TypeScript/Core owner. */
export const workspaceRootProfileDirectory = (): string => activeHome()

const canonicalPath = (value: string): string => {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

export const isPathInside = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate)
  return (
    remainder === "" ||
    (remainder !== ".." &&
      !remainder.startsWith(".." + "/") &&
      !remainder.startsWith(".." + "\\") &&
      !isAbsolute(remainder))
  )
}

const readJson = (file: string): unknown => {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown
  } catch {
    return undefined
  }
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Read the durable trust decision only; the automation bypass is separate. */
export function isPersistedWorkspaceTrusted(workspace = process.cwd()): boolean {
  const payload = objectRecord(readJson(join(activeHome(), "trusted_workspaces.json")))
  const trusted = payload?.workspaces
  return Array.isArray(trusted) && trusted.includes(canonicalPath(workspace))
}

/** Match the Python trust screen's explicit automation bypass for local use. */
export function isWorkspaceTrusted(workspace = process.cwd()): boolean {
  return truthy(process.env.ARFORGE_TRUST_WORKSPACE) || isPersistedWorkspaceTrusted(workspace)
}

/** Read configured, existing and independently trusted additional roots. */
export function configuredWorkspaceRoots(): string[] {
  const payload = objectRecord(readJson(join(activeHome(), "workspace_roots.json")))
  const rawRoots = payload?.roots
  if (!Array.isArray(rawRoots)) return []

  const roots: string[] = []
  for (const raw of rawRoots) {
    if (typeof raw !== "string") continue
    const root = canonicalPath(raw)
    try {
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    if (!isPersistedWorkspaceTrusted(root) || roots.includes(root)) continue
    roots.push(root)
  }
  return roots
}

/** Return the primary workspace followed by non-overlapping authorized roots. */
export function authorizedWorkspaceRoots(primary = process.cwd()): string[] {
  const primaryRoot = canonicalPath(primary)
  const roots = [primaryRoot]
  for (const root of configuredWorkspaceRoots()) {
    if (roots.some((existing) => isPathInside(existing, root) || isPathInside(root, existing))) continue
    roots.push(root)
  }
  return roots
}

export type WorkspaceRootReport = Readonly<{
  primary: string
  roots: ReadonlyArray<{
    path: string
    primary: boolean
    trusted: boolean
  }>
}>

/** Build the same metadata-only projection emitted by Python `workspace list`. */
export function workspaceRootsReport(primary = process.cwd()): WorkspaceRootReport {
  const primaryRoot = canonicalPath(primary)
  return {
    primary: primaryRoot,
    roots: authorizedWorkspaceRoots(primaryRoot).map((root) => ({
      path: root,
      primary: root === primaryRoot,
      trusted: isPersistedWorkspaceTrusted(root),
    })),
  }
}

/** Exposed for tests and future ActionGateway contracts; the writer remains disabled here. */
export function workspaceRootsStatePath(): string {
  return join(activeHome(), "workspace_roots.json")
}

export type WorkspaceRootMutationAction = "trust" | "add" | "remove"

/**
 * The only authorization shape accepted by the future workspace writer.
 *
 * This is deliberately a receipt reference, not a locally forgeable boolean:
 * the eventual writer must resolve the receipt through ActionGateway before
 * committing. The planner below only checks the binding and digest, and never
 * treats ARFORGE_TRUST_WORKSPACE as permission for a persistent mutation.
 */
export type WorkspaceRootMutationAuthorization = Readonly<{
  readonly kind: "action-gateway"
  readonly status: "approved"
  readonly receiptID: string
  readonly actionID: string
  readonly workspace: string
  readonly target: string
  readonly intentDigest: string
}>

export type WorkspaceRootMutationRequest = Readonly<{
  readonly action: WorkspaceRootMutationAction
  readonly primary: string
  readonly primaryIsDirectory: boolean
  readonly target: string
  /** The target must be rechecked by the committing writer immediately before CAS. */
  readonly targetIsDirectory: boolean
  readonly trustedWorkspaces: ReadonlyArray<string>
  readonly configuredRoots: ReadonlyArray<string>
}>

export type WorkspaceRootMutationInput = WorkspaceRootMutationRequest &
  Readonly<{
    readonly authorization?: WorkspaceRootMutationAuthorization
  }>

export type WorkspaceRootMutationReason =
  | "authorization_required"
  | "authorization_malformed"
  | "authorization_mismatch"
  | "authorization_digest_mismatch"
  | "invalid_input"
  | "primary_not_directory"
  | "target_not_directory"
  | "primary_not_mutable"
  | "target_not_trusted"
  | "target_not_configured"
  | "root_overlap"
  | "state_malformed"

/** A typed, payload-free admission failure for a future workspace writer. */
export class WorkspaceRootMutationError extends Error {
  readonly _tag = "WorkspaceRootMutationError"

  constructor(readonly reason: WorkspaceRootMutationReason) {
    super(`workspace root mutation blocked: ${reason}`)
    this.name = "WorkspaceRootMutationError"
  }
}

type NormalizedWorkspaceRootMutationRequest = Readonly<{
  readonly action: WorkspaceRootMutationAction
  readonly primary: string
  readonly primaryIsDirectory: boolean
  readonly target: string
  readonly targetIsDirectory: boolean
  readonly trustedWorkspaces: ReadonlyArray<string>
  readonly configuredRoots: ReadonlyArray<string>
}>

export type WorkspaceRootStateDigest = Readonly<{
  readonly trusted: string
  readonly configured: string
}>

export type WorkspaceRootMutationStateSnapshot = Readonly<{
  readonly trustedWorkspaces: ReadonlyArray<string>
  readonly configuredRoots: ReadonlyArray<string>
  readonly digest: WorkspaceRootStateDigest
}>

export type WorkspaceRootMutationPlan = Readonly<{
  readonly schemaVersion: typeof WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION
  readonly action: WorkspaceRootMutationAction
  readonly status: "planned" | "noop"
  readonly primary: string
  readonly target: string
  readonly changed: boolean
  readonly intentDigest: string
  readonly authorization: Readonly<{
    readonly receiptID: string
    readonly actionID: string
  }>
  readonly before: WorkspaceRootStateDigest
  readonly after: WorkspaceRootStateDigest
  readonly nextTrustedWorkspaces: ReadonlyArray<string>
  readonly nextConfiguredRoots: ReadonlyArray<string>
  /** Explicitly prevents callers from mistaking this plan for a committed write. */
  readonly commit: Readonly<{
    readonly mode: "read-only-plan"
    readonly owner: "typescript-core-workspace-root-writer"
    readonly requires: ReadonlyArray<"action-gateway" | "cas" | "rollback" | "recovery-outbox" | "audit">
  }>
}>

/**
 * Machine-readable production enablement decision for the workspace writer.
 *
 * The planner and the injected writer seam are intentionally useful before a
 * concrete production writer is safe to expose.  Keeping this decision next
 * to the existing contract prevents a UI/CLI from inferring readiness from a
 * test fixture or from the presence of a few isolated callbacks.
 */
export type WorkspaceRootMutationEnableGate = Readonly<{
  readonly id:
    | "unique-production-owner"
    | "durable-state-owner"
    | "cas-rollback"
    | "recovery-outbox-audit"
    | "runtime-invariant"
  readonly status: "blocked" | "satisfied" | "deferred"
  readonly evidenceScope: "production" | "isolated-test" | "deferred"
  readonly requirement: string
  readonly blocker: string
}>

export type WorkspaceRootMutationEnableDecision = Readonly<{
  readonly schema_version: typeof WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION
  readonly decision: "keep-disabled"
  readonly ready: false
  readonly gates: ReadonlyArray<WorkspaceRootMutationEnableGate>
  readonly blocking_gate_ids: ReadonlyArray<WorkspaceRootMutationEnableGate["id"]>
  readonly decision_digest: string
}>

const workspaceRootMutationEnableDecisionSemantic = (
  decision: Pick<
    WorkspaceRootMutationEnableDecision,
    "schema_version" | "decision" | "ready" | "gates" | "blocking_gate_ids"
  >,
) => ({
  domain: "arforge/workspace-root-mutation-enable-gate/v1",
  schema_version: decision.schema_version,
  decision: decision.decision,
  ready: decision.ready,
  gates: decision.gates,
  blocking_gate_ids: [...decision.blocking_gate_ids],
})

/**
 * Return the one authoritative writer decision card used by the read-only
 * contract.  A gate is only `satisfied` when the production path is bound to
 * the owner; isolated Core tests prove implementation seams, not enablement.
 * The deferred cross-platform/live boundaries remain blocking by policy.
 */
export const workspaceRootMutationEnableGate = (): WorkspaceRootMutationEnableDecision => {
  const gates: ReadonlyArray<WorkspaceRootMutationEnableGate> = Object.freeze([
    {
      id: "unique-production-owner",
      status: "satisfied",
      evidenceScope: "production",
      requirement: "生产 CLI/Server 只能绑定唯一 TypeScript/Core workspace writer owner",
      blocker: "",
    },
    {
      id: "durable-state-owner",
      status: "blocked",
      evidenceScope: "isolated-test",
      requirement: "trusted_workspaces/workspace_roots 必须由同一 durable state owner 读写并可重启恢复",
      blocker: "真实文件 writer 仍是隔离测试/未来迁移 owner，生产 profile 写入尚未接入",
    },
    {
      id: "cas-rollback",
      status: "blocked",
      evidenceScope: "isolated-test",
      requirement: "ActionGateway receipt 后必须完成 CAS、rollback artifact 与目标重检",
      blocker: "CAS/rollback seam 与进程级测试已验证，但尚无 production binding 证据",
    },
    {
      id: "recovery-outbox-audit",
      status: "blocked",
      evidenceScope: "isolated-test",
      requirement: "prepared/committed/recovery-required、审计和重启恢复必须是 durable 且 payload-free",
      blocker: "outbox/audit seam 已存在并通过隔离恢复测试，生产 writer 尚未接管其生命周期",
    },
    {
      id: "runtime-invariant",
      status: "deferred",
      evidenceScope: "deferred",
      requirement: "跨 owner 事务、权限、恢复、审计、invariant 及跨平台锁/fsync 矩阵必须闭合",
      blocker: "EventV2/ExperienceStore/DurableRun 的生产同事务证据与完整 Linux/macOS/Windows 矩阵仍未完成",
    },
  ])
  const semantic = {
    schema_version: WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION,
    decision: "keep-disabled" as const,
    ready: false as const,
    gates,
    blocking_gate_ids: Object.freeze(gates.filter((gate) => gate.status !== "satisfied").map((gate) => gate.id)),
  }
  const decision_digest = canonicalHash(workspaceRootMutationEnableDecisionSemantic(semantic))
  if (decision_digest === undefined) throw new Error("workspace root mutation gate is not canonicalizable")
  return Object.freeze({ ...semantic, decision_digest })
}

/** Validate a copied workspace mutation decision before displaying or using it. */
export const assertWorkspaceRootMutationEnableGate = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("workspace root mutation enable gate is invalid")
  const record = value as Record<string, unknown>
  const expectedKeys = ["schema_version", "decision", "ready", "gates", "blocking_gate_ids", "decision_digest"]
  const actualKeys = Object.keys(record).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort()))
    throw new Error("workspace root mutation enable gate fields drifted")
  if (
    record.schema_version !== WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION ||
    record.decision !== "keep-disabled" ||
    record.ready !== false ||
    typeof record.decision_digest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.decision_digest) ||
    !Array.isArray(record.gates) ||
    !Array.isArray(record.blocking_gate_ids)
  )
    throw new Error("workspace root mutation enable gate fields are invalid")
  const gates = record.gates as unknown[]
  const expectedIDs: ReadonlyArray<WorkspaceRootMutationEnableGate["id"]> = [
    "unique-production-owner",
    "durable-state-owner",
    "cas-rollback",
    "recovery-outbox-audit",
    "runtime-invariant",
  ]
  if (
    gates.length !== expectedIDs.length ||
    gates.some((gate, index) => {
      if (gate === null || typeof gate !== "object" || Array.isArray(gate)) return true
      const entry = gate as Record<string, unknown>
      const expectedGateKeys = ["id", "status", "evidenceScope", "requirement", "blocker"]
      if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([...expectedGateKeys].sort())) return true
      if (
        entry.id !== expectedIDs[index] ||
        !(entry.status === "blocked" || entry.status === "satisfied" || entry.status === "deferred") ||
        !(
          entry.evidenceScope === "production" ||
          entry.evidenceScope === "isolated-test" ||
          entry.evidenceScope === "deferred"
        ) ||
        typeof entry.requirement !== "string" ||
        entry.requirement.trim().length === 0 ||
        typeof entry.blocker !== "string" ||
        (entry.status === "satisfied" ? entry.blocker !== "" : entry.blocker.trim().length === 0)
      )
        return true
      return false
    })
  )
    throw new Error("workspace root mutation enable gate entries are invalid")
  const expectedBlocking = gates
    .filter((gate) => {
      const status = (gate as Record<string, unknown>).status
      return status !== "satisfied"
    })
    .map((gate) => (gate as Record<string, unknown>).id)
  if (JSON.stringify(record.blocking_gate_ids) !== JSON.stringify(expectedBlocking))
    throw new Error("workspace root mutation enable gate blocking IDs drifted")
  const expectedDigest = canonicalHash(
    workspaceRootMutationEnableDecisionSemantic({
      schema_version: WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION,
      decision: "keep-disabled",
      ready: false,
      gates: gates as ReadonlyArray<WorkspaceRootMutationEnableGate>,
      blocking_gate_ids: expectedBlocking as ReadonlyArray<WorkspaceRootMutationEnableGate["id"]>,
    }),
  )
  if (expectedDigest === undefined || expectedDigest !== record.decision_digest)
    throw new Error("workspace root mutation enable gate decision digest drifted")
}

/** Stable user-facing summary for the still-disabled workspace writer. */
export const workspaceRootMutationContract = () => {
  const enable_gate = workspaceRootMutationEnableGate()
  assertWorkspaceRootMutationEnableGate(enable_gate)
  return {
    schema_version: WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION,
    execution_mode: "read-only-workspace-root-mutation-contract-audit" as const,
    side_effects: "none" as const,
    status: "not_ready" as const,
    ready: false as const,
    model_invoked: false as const,
    writes: 0 as const,
    missing_requirements: [
      "action_gateway_receipt",
      "optimistic_cas",
      "rollback_artifact",
      "recovery_outbox",
      "audit_evidence",
    ] as const,
    available_primitives: {
      readOnlyReport: "available",
      deterministicMutationPlanner: "available",
      typedAuthorizationBinding: "available-shape-only",
      actionGatewayPermissionPlan: "available",
      actionGatewayCapabilityVerifier: "available-typed",
      writerCasRollbackOutboxAuditSeam: "available-disabled",
      durableWriter: "not-enabled",
    },
    runtime_invariant: {
      owner: "workspace-root-writer",
      key: "preflight",
      keys: ["preflight", "enable-gate", "production-owner"] as const,
      version: "1",
      status: "available-typed-snapshot-only",
      grants_mutation: false,
    } as const,
    enable_gate,
    legacy_source: "python-trust-screen-and-workspace-roots",
    decision: "fail-closed" as const,
    caveat:
      "当前仅生成 metadata-only 规划；TypeScript/Core 已提供 ActionGateway capability 验证和 CAS/回滚/恢复 outbox/审计 typed seam，但具体状态 owner 默认 disabled，不读取或写入旧 Python 状态。真正提交必须由唯一 writer 重新读取状态并在全部门禁成功后执行。",
  }
}

const mutationError = (reason: WorkspaceRootMutationReason): never => {
  throw new WorkspaceRootMutationError(reason)
}

const mutationPath = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || !isAbsolute(value))
    return mutationError("invalid_input")
  return canonicalPath(value)
}

const pathKey = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value)

const normalizePathList = (value: unknown, reason: WorkspaceRootMutationReason): string[] => {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_ROOT_ENTRIES) return mutationError(reason)
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const item = mutationPath(raw)
    const key = pathKey(item)
    if (seen.has(key)) return mutationError("state_malformed")
    seen.add(key)
    result.push(item)
  }
  return result
}

const normalizeMutationRequest = (input: WorkspaceRootMutationRequest): NormalizedWorkspaceRootMutationRequest => {
  if (input.action !== "trust" && input.action !== "add" && input.action !== "remove")
    return mutationError("invalid_input")
  if (typeof input.primaryIsDirectory !== "boolean" || typeof input.targetIsDirectory !== "boolean")
    return mutationError("invalid_input")
  const primary = mutationPath(input.primary)
  const target = mutationPath(input.target)
  const trustedWorkspaces = normalizePathList(input.trustedWorkspaces, "state_malformed")
  const configuredRoots = normalizePathList(input.configuredRoots, "state_malformed")
  if (!input.primaryIsDirectory) return mutationError("primary_not_directory")
  if (
    configuredRoots.some(
      (root) => pathKey(root) === pathKey(primary) || isPathInside(root, primary) || isPathInside(primary, root),
    )
  )
    return mutationError("state_malformed")
  if (
    configuredRoots.some((root, index) =>
      configuredRoots.some(
        (other, otherIndex) => index !== otherIndex && (isPathInside(root, other) || isPathInside(other, root)),
      ),
    )
  )
    return mutationError("state_malformed")
  if (configuredRoots.some((root) => !trustedWorkspaces.some((trusted) => pathKey(trusted) === pathKey(root))))
    return mutationError("state_malformed")
  return {
    action: input.action,
    primary,
    primaryIsDirectory: input.primaryIsDirectory,
    target,
    targetIsDirectory: input.targetIsDirectory,
    trustedWorkspaces,
    configuredRoots,
  }
}

const sortedPaths = (paths: ReadonlyArray<string>): string[] =>
  [...paths].sort((left, right) => pathKey(left).localeCompare(pathKey(right)))

const listDigest = (paths: ReadonlyArray<string>): string =>
  createHash("sha256")
    .update(JSON.stringify(sortedPaths(paths)))
    .digest("hex")

const stateDigest = (
  trustedWorkspaces: ReadonlyArray<string>,
  configuredRoots: ReadonlyArray<string>,
): WorkspaceRootStateDigest => ({
  trusted: listDigest(trustedWorkspaces),
  configured: listDigest(configuredRoots),
})

/**
 * Digest a workspace-root snapshot without reading or writing profile files.
 * Writers use this as their optimistic-CAS identity; callers must still
 * re-read and validate the actual state immediately before committing.
 */
export const workspaceRootMutationStateDigest = (input: {
  readonly trustedWorkspaces: ReadonlyArray<string>
  readonly configuredRoots: ReadonlyArray<string>
}): WorkspaceRootStateDigest => {
  const trustedWorkspaces = normalizePathList(input.trustedWorkspaces, "state_malformed")
  const configuredRoots = normalizePathList(input.configuredRoots, "state_malformed")
  if (
    configuredRoots.some((root) =>
      configuredRoots.some((other) => root !== other && (isPathInside(root, other) || isPathInside(other, root))),
    )
  )
    return mutationError("state_malformed")
  return stateDigest(trustedWorkspaces, configuredRoots)
}

const readStateArray = (file: string, key: "workspaces" | "roots"): unknown[] => {
  if (!existsSync(file)) return []
  const payload = objectRecord(readJson(file))
  const values = payload?.[key]
  if (!Array.isArray(values)) return mutationError("state_malformed")
  const version = payload?.schema_version
  if (version !== undefined && version !== WORKSPACE_ROOTS_SCHEMA_VERSION) return mutationError("state_malformed")
  return values
}

/**
 * Read the exact profile snapshot a future writer must use for its first CAS
 * check.  Invalid JSON, duplicate/overlapping roots, untrusted configured
 * roots, and vanished configured directories fail closed instead of being
 * silently normalised into a different mutation identity.
 */
export const readWorkspaceRootMutationStateAt = (
  profileDirectory: string,
  primary = process.cwd(),
): WorkspaceRootMutationStateSnapshot => {
  if (!isAbsolute(profileDirectory) || profileDirectory.includes("\0")) return mutationError("invalid_input")
  const profile = resolve(profileDirectory)
  const primaryRoot = mutationPath(primary)
  const trustedWorkspaces = normalizePathList(
    readStateArray(join(profile, "trusted_workspaces.json"), "workspaces"),
    "state_malformed",
  )
  const configuredRoots = normalizePathList(
    readStateArray(join(profile, "workspace_roots.json"), "roots"),
    "state_malformed",
  )
  if (
    configuredRoots.some(
      (root) =>
        isPathInside(root, primaryRoot) ||
        isPathInside(primaryRoot, root) ||
        !trustedWorkspaces.some((trusted) => pathKey(trusted) === pathKey(root)),
    )
  )
    return mutationError("state_malformed")
  if (
    configuredRoots.some((root, index) =>
      configuredRoots.some(
        (other, otherIndex) => index !== otherIndex && (isPathInside(root, other) || isPathInside(other, root)),
      ),
    )
  )
    return mutationError("state_malformed")
  for (const root of configuredRoots) {
    try {
      if (!statSync(root).isDirectory()) return mutationError("state_malformed")
    } catch {
      return mutationError("state_malformed")
    }
  }
  return {
    trustedWorkspaces: Object.freeze(trustedWorkspaces),
    configuredRoots: Object.freeze(configuredRoots),
    digest: stateDigest(trustedWorkspaces, configuredRoots),
  }
}

/** Read the default profile snapshot without repairing or creating files. */
export const readWorkspaceRootMutationState = (primary = process.cwd()): WorkspaceRootMutationStateSnapshot =>
  readWorkspaceRootMutationStateAt(activeHome(), primary)

/**
 * Reconstruct the exact, payload-free mutation identity used by an
 * ActionGateway receipt. State lists are sorted only for the digest, so an
 * equivalent snapshot cannot change the authorization identity due to JSON
 * insertion order.
 */
export const workspaceRootMutationIntentDigest = (input: WorkspaceRootMutationRequest): string => {
  const normalized = normalizeMutationRequest(input)
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION,
        action: normalized.action,
        primary: normalized.primary,
        primaryIsDirectory: normalized.primaryIsDirectory,
        target: normalized.target,
        targetIsDirectory: normalized.targetIsDirectory,
        trustedWorkspaces: sortedPaths(normalized.trustedWorkspaces),
        configuredRoots: sortedPaths(normalized.configuredRoots),
      }),
    )
    .digest("hex")
}

const validateAuthorization = (
  input: WorkspaceRootMutationInput,
  normalized: NormalizedWorkspaceRootMutationRequest,
  intentDigest: string,
): WorkspaceRootMutationAuthorization => {
  const authorization = input.authorization
  if (authorization === undefined) return mutationError("authorization_required")
  if (
    authorization.kind !== "action-gateway" ||
    authorization.status !== "approved" ||
    typeof authorization.receiptID !== "string" ||
    authorization.receiptID.trim() === "" ||
    typeof authorization.actionID !== "string" ||
    authorization.actionID.trim() === "" ||
    typeof authorization.workspace !== "string" ||
    typeof authorization.target !== "string" ||
    !SHA256.test(authorization.intentDigest)
  )
    return mutationError("authorization_malformed")
  if (
    pathKey(mutationPath(authorization.workspace)) !== pathKey(normalized.primary) ||
    pathKey(mutationPath(authorization.target)) !== pathKey(normalized.target)
  )
    return mutationError("authorization_mismatch")
  if (authorization.intentDigest !== intentDigest) return mutationError("authorization_digest_mismatch")
  return authorization
}

/**
 * Build a deterministic, read-only workspace-root mutation plan.
 *
 * This is intentionally not a writer. It proves the request, current state,
 * authorization receipt and expected post-state are compatible. A future
 * commit implementation must re-read the same state, verify the receipt via
 * ActionGateway, then apply CAS + rollback + recovery-outbox + audit in one
 * TypeScript/Core owner. No environment variable (including the automation
 * trust bypass) can satisfy this contract.
 */
export const planWorkspaceRootMutation = (input: WorkspaceRootMutationInput): WorkspaceRootMutationPlan => {
  const normalized = normalizeMutationRequest(input)
  const intentDigest = workspaceRootMutationIntentDigest(normalized)
  const authorization = validateAuthorization(input, normalized, intentDigest)
  const trusted = [...normalized.trustedWorkspaces]
  const configured = [...normalized.configuredRoots]
  const targetKey = pathKey(normalized.target)
  const primaryKey = pathKey(normalized.primary)
  const hasTrusted = trusted.some((item) => pathKey(item) === targetKey)
  const configuredIndex = configured.findIndex((item) => pathKey(item) === targetKey)
  const before = stateDigest(trusted, configured)

  if (normalized.action === "trust") {
    if (!normalized.targetIsDirectory) return mutationError("target_not_directory")
    if (!hasTrusted) trusted.push(normalized.target)
  } else if (normalized.action === "add") {
    if (!normalized.targetIsDirectory) return mutationError("target_not_directory")
    if (targetKey === primaryKey) return mutationError("primary_not_mutable")
    if (!hasTrusted) return mutationError("target_not_trusted")
    if (configuredIndex < 0) {
      if (
        isPathInside(normalized.primary, normalized.target) ||
        isPathInside(normalized.target, normalized.primary) ||
        configured.some((root) => isPathInside(root, normalized.target) || isPathInside(normalized.target, root))
      )
        return mutationError("root_overlap")
      configured.push(normalized.target)
    }
  } else {
    if (targetKey === primaryKey) return mutationError("primary_not_mutable")
    if (configuredIndex >= 0) configured.splice(configuredIndex, 1)
  }

  const after = stateDigest(trusted, configured)
  const changed = before.trusted !== after.trusted || before.configured !== after.configured
  return {
    schemaVersion: WORKSPACE_ROOT_MUTATION_SCHEMA_VERSION,
    action: normalized.action,
    status: changed ? "planned" : "noop",
    primary: normalized.primary,
    target: normalized.target,
    changed,
    intentDigest,
    authorization: { receiptID: authorization.receiptID, actionID: authorization.actionID },
    before,
    after,
    nextTrustedWorkspaces: Object.freeze(trusted),
    nextConfiguredRoots: Object.freeze(configured),
    commit: {
      mode: "read-only-plan",
      owner: "typescript-core-workspace-root-writer",
      requires: Object.freeze(["action-gateway", "cas", "rollback", "recovery-outbox", "audit"] as const),
    },
  }
}
