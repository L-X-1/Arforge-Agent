export * as ToolEffectCatalog from "./effect-catalog"

import type {
  ToolConcurrency,
  ToolOutputPolicy,
  ToolSideEffect,
  ToolTimeoutMode,
} from "./metadata"

/**
 * Recovery is deliberately a small vocabulary.  A handler may provide a
 * more detailed explanation in its effect semantics, but it cannot invent a
 * second recovery policy outside the catalog.
 */
export type RecoveryBehavior = "retry" | "resume" | "reissue" | "compensate" | "manual" | "not_applicable"

export type ToolCategory = "pure" | "read" | "write" | "external"
export type ToolPlatform = "server" | "desktop" | "web" | "mcp" | "cli"
export type ToolManifestSeed = {
  readonly operation: string
  readonly deadlineMs: number
  readonly recovery: RecoveryBehavior
  readonly externalOperation: boolean
  readonly networkEgress: "none" | "host_configured" | "input_declared"
  readonly secretScope: "none" | "host_managed" | "input_scoped"
  /** Optional execution metadata overrides; omitted values use safe defaults. */
  readonly concurrency?: ToolConcurrency
  readonly sideEffect?: ToolSideEffect
  readonly timeoutMode?: ToolTimeoutMode
  readonly outputPolicy?: ToolOutputPolicy
  readonly resourceKey?: string
}

export type ToolManifest = ToolManifestSeed & {
  readonly name: string
  readonly version: string
  readonly schemaDigest: string
  readonly category: ToolCategory
  readonly riskTier: "L0" | "L1" | "L2" | "L3" | "L4"
  readonly authority: "automatic" | "scoped_grant" | "human" | "forbidden"
  readonly resources: ReadonlyArray<string>
  readonly idempotency: "idempotent" | "conditional" | "non_idempotent"
  readonly retryability: "safe" | "guarded" | "never"
  readonly compensation?: string
  readonly egress: ToolManifestSeed["networkEgress"]
  readonly secret: ToolManifestSeed["secretScope"]
  readonly outputLimitBytes: number
  readonly artifactLimitBytes: number
  readonly preflight: string
  readonly executor: string
  readonly observer: string
  readonly verifier: string
  readonly recoveryHandler: string
  readonly supportedPlatforms: ReadonlyArray<ToolPlatform>
  readonly concurrency: ToolConcurrency
  readonly sideEffect: ToolSideEffect
  readonly timeoutMode: ToolTimeoutMode
  readonly outputPolicy: ToolOutputPolicy
  readonly resourceKey?: string
}

const manifest = (input: ToolManifestSeed) => Object.freeze(input)

/**
 * The canonical built-in inventory.  EffectSemantics remains the source of
 * risk, authority, idempotency, retryability, compensation, resources,
 * artifacts, success criteria, and concrete scopes.  This catalog owns the
 * operational fields which cannot be derived from an arbitrary tool input:
 * deadline, egress class, secret ownership, and recovery policy.
 */
const BuiltInToolManifestSeeds: Readonly<Record<string, ToolManifestSeed>> = Object.freeze({
  apply_patch: manifest({
    operation: "filesystem.patch",
    deadlineMs: 30_000,
    recovery: "compensate",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  bash: manifest({
    operation: "process.shell",
    deadlineMs: 15 * 60_000,
    recovery: "manual",
    externalOperation: true,
    networkEgress: "input_declared",
    secretScope: "input_scoped",
  }),
  claim_task: manifest({
    operation: "task-graph.claim",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  complete_task: manifest({
    operation: "task-graph.complete",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  cooperative_wait: manifest({
    operation: "session.cooperative-wait",
    deadlineMs: 300_000,
    recovery: "resume",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  create_task: manifest({
    operation: "task-graph.create",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  delete_task: manifest({
    operation: "task-graph.delete",
    deadlineMs: 10_000,
    recovery: "manual",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  deliver_user_message: manifest({
    operation: "session.primary-delivery",
    deadlineMs: 30_000,
    recovery: "manual",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  edit: manifest({
    operation: "filesystem.edit",
    deadlineMs: 30_000,
    recovery: "compensate",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  glob: manifest({
    operation: "filesystem.glob",
    deadlineMs: 30_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  goal_update: manifest({
    operation: "goal.transition",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  grep: manifest({
    operation: "filesystem.grep",
    deadlineMs: 30_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  list_tasks: manifest({
    operation: "task-graph.list",
    deadlineMs: 10_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  multimodal_diagnose: manifest({
    operation: "filesystem.diagnose",
    deadlineMs: 60_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  notebook_edit: manifest({
    operation: "filesystem.notebook-edit",
    deadlineMs: 30_000,
    recovery: "compensate",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  notebook_read: manifest({
    operation: "filesystem.notebook-read",
    deadlineMs: 30_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  question: manifest({
    operation: "session.question",
    deadlineMs: 300_000,
    recovery: "resume",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  read: manifest({
    operation: "filesystem.read",
    deadlineMs: 30_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  search_tasks: manifest({
    operation: "task-graph.search",
    deadlineMs: 10_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  skill: manifest({
    operation: "skill.read",
    deadlineMs: 30_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_create: manifest({
    operation: "team.create",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_delete: manifest({
    operation: "team.delete",
    deadlineMs: 10_000,
    recovery: "manual",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_get: manifest({
    operation: "team.get",
    deadlineMs: 10_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_member_add: manifest({
    operation: "team.member-add",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_member_remove: manifest({
    operation: "team.member-remove",
    deadlineMs: 10_000,
    recovery: "manual",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_message_list: manifest({
    operation: "team.mailbox-read",
    deadlineMs: 10_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_message_send: manifest({
    operation: "team.mailbox-send",
    deadlineMs: 10_000,
    recovery: "manual",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_shutdown_request: manifest({
    operation: "team.shutdown-request",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  team_shutdown_respond: manifest({
    operation: "team.shutdown-respond",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  todowrite: manifest({
    operation: "session.todo-projection",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  trigger_manage: manifest({
    operation: "trigger.manage",
    deadlineMs: 60_000,
    recovery: "manual",
    externalOperation: true,
    networkEgress: "host_configured",
    secretScope: "host_managed",
  }),
  trigger_profiles: manifest({
    operation: "trigger.profiles",
    deadlineMs: 10_000,
    recovery: "retry",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  update_task: manifest({
    operation: "task-graph.update",
    deadlineMs: 10_000,
    recovery: "reissue",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
  webfetch: manifest({
    operation: "network.fetch",
    deadlineMs: 60_000,
    recovery: "retry",
    externalOperation: true,
    networkEgress: "input_declared",
    secretScope: "none",
  }),
  websearch: manifest({
    operation: "network.search",
    deadlineMs: 60_000,
    recovery: "retry",
    externalOperation: true,
    networkEgress: "host_configured",
    secretScope: "host_managed",
  }),
  write: manifest({
    operation: "filesystem.write",
    deadlineMs: 30_000,
    recovery: "compensate",
    externalOperation: false,
    networkEgress: "none",
    secretScope: "none",
  }),
})

const categoryFor = (name: string, seed: ToolManifestSeed): ToolCategory => {
  if (seed.externalOperation) return "external"
  if (
    [
      "read",
      "glob",
      "grep",
      "notebook_read",
      "list_tasks",
      "search_tasks",
      "team_get",
      "team_message_list",
      "trigger_profiles",
      "skill",
    ].includes(name)
  )
    return "read"
  if (["question", "cooperative_wait"].includes(name)) return "pure"
  return "write"
}

const riskFor = (category: ToolCategory, seed: ToolManifestSeed): ToolManifest["riskTier"] => {
  if (category === "pure" || category === "read") return "L0"
  if (seed.externalOperation) return "L3"
  return category === "write" ? "L2" : "L1"
}

const authorityFor = (riskTier: ToolManifest["riskTier"]): ToolManifest["authority"] =>
  riskTier === "L0" || riskTier === "L1" ? "automatic" : riskTier === "L2" ? "scoped_grant" : "human"

const retryabilityFor = (recovery: RecoveryBehavior): ToolManifest["retryability"] =>
  recovery === "retry" || recovery === "resume" || recovery === "not_applicable"
    ? "safe"
    : recovery === "manual"
      ? "never"
      : "guarded"

const completeManifest = (name: string, seed: ToolManifestSeed): ToolManifest => {
  const category = categoryFor(name, seed)
  const riskTier = riskFor(category, seed)
  const compensation = seed.recovery === "compensate" ? `compensate:${seed.operation}` : undefined
  return Object.freeze({
    ...seed,
    name,
    version: "1",
    schemaDigest: `manifest:${name}:v1`,
    category,
    riskTier,
    authority: authorityFor(riskTier),
    resources: [seed.operation],
    idempotency:
      category === "read" || category === "pure"
        ? "idempotent"
        : seed.recovery === "reissue"
          ? "conditional"
          : "non_idempotent",
    retryability: retryabilityFor(seed.recovery),
    ...(compensation ? { compensation } : {}),
    egress: seed.networkEgress,
    secret: seed.secretScope,
    outputLimitBytes: seed.externalOperation ? 10_000_000 : 1_000_000,
    artifactLimitBytes: 10_000_000,
    preflight: "authorization-plan.v1",
    executor: "tool-registry.v1",
    observer: "runtime-insight.tool-execute.v1",
    verifier: "tool-output-schema.v1",
    recoveryHandler: `recovery.${seed.recovery}`,
    supportedPlatforms: ["server", "desktop", "web", "mcp"] as const,
    // Safe defaults are intentionally explicit in the catalog. AF-DH-206
    // may later opt a tool into `safe` or `keyed` after a scheduler proof;
    // no old or third-party tool becomes parallel by omission.
    concurrency: seed.concurrency ?? "exclusive",
    sideEffect:
      seed.sideEffect ??
      (category === "pure" ? "none" : category === "read" ? "read" : seed.externalOperation ? "external" : "write"),
    timeoutMode: seed.timeoutMode ?? "derived",
    outputPolicy: seed.outputPolicy ?? "both",
    ...(seed.resourceKey ? { resourceKey: seed.resourceKey } : {}),
  })
}

export const makeToolManifest = (name: string, seed: ToolManifestSeed): ToolManifest => completeManifest(name, seed)

export const BuiltInToolManifest: Readonly<Record<string, ToolManifest>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BuiltInToolManifestSeeds).map(([name, seed]) => [name, completeManifest(name, seed)]),
  ),
)

export type ToolEffectDeclaration = "static" | "dynamic" | "default_deny"

export type ToolCatalogEntry = ToolManifest & {
  readonly name: string
  readonly effectDeclaration: ToolEffectDeclaration
}

export type ToolCatalogAudit = {
  readonly expected: number
  readonly observed: number
  readonly missing: ReadonlyArray<string>
  readonly undeclaredEffects: ReadonlyArray<string>
  readonly invalidDeadlines: ReadonlyArray<string>
}

export type ToolManifestContractAudit = {
  readonly valid: boolean
  readonly missingFields: ReadonlyArray<string>
  readonly invalidFields: ReadonlyArray<string>
}

export type ToolExitGateDependencies = {
  readonly observerRegistered: boolean
  readonly verifierRegistered: boolean
  readonly recoveryContractRegistered: boolean
}

export type ToolExitGateAudit = {
  readonly valid: boolean
  readonly missingContracts: ReadonlyArray<string>
  readonly securityFailures: ReadonlyArray<string>
}

export function auditToolManifestContract(manifest: ToolManifest): ToolManifestContractAudit {
  const required: ReadonlyArray<keyof ToolManifest> = [
    "name",
    "version",
    "schemaDigest",
    "operation",
    "category",
    "riskTier",
    "authority",
    "resources",
    "idempotency",
    "retryability",
    "deadlineMs",
    "egress",
    "secret",
    "outputLimitBytes",
    "artifactLimitBytes",
    "preflight",
    "executor",
    "observer",
    "verifier",
    "recoveryHandler",
    "supportedPlatforms",
    "concurrency",
    "sideEffect",
    "timeoutMode",
    "outputPolicy",
  ]
  const missingFields = required.filter((field) => {
    const value = manifest[field]
    return value === undefined || value === "" || (Array.isArray(value) && value.length === 0)
  })
  const invalidFields = [
    ...(manifest.deadlineMs <= 0 ? ["deadlineMs"] : []),
    ...(manifest.outputLimitBytes <= 0 ? ["outputLimitBytes"] : []),
    ...(manifest.artifactLimitBytes <= 0 ? ["artifactLimitBytes"] : []),
    ...(manifest.externalOperation && manifest.category !== "external" ? ["category"] : []),
    ...(manifest.egress !== manifest.networkEgress ? ["egress"] : []),
    ...(manifest.secret !== manifest.secretScope ? ["secret"] : []),
    ...(manifest.executor === manifest.verifier ? ["verifier-must-be-independent"] : []),
    ...(!["exclusive", "safe", "keyed"].includes(manifest.concurrency) ? ["concurrency"] : []),
    ...(!["none", "read", "write", "external"].includes(manifest.sideEffect) ? ["sideEffect"] : []),
    ...(!["derived", "inherited", "detached"].includes(manifest.timeoutMode) ? ["timeoutMode"] : []),
    ...(!["model", "artifact", "both"].includes(manifest.outputPolicy) ? ["outputPolicy"] : []),
  ]
  return { valid: missingFields.length === 0 && invalidFields.length === 0, missingFields, invalidFields }
}

/**
 * Exit gate for an enabled tool. The booleans are supplied by the runtime
 * registrations; this pure audit never creates an observer, executor, or
 * recovery side effect as part of checking readiness.
 */
export function auditToolExitGate(manifest: ToolManifest, dependencies: ToolExitGateDependencies): ToolExitGateAudit {
  const contract = auditToolManifestContract(manifest)
  const missingContracts = [
    ...(dependencies.observerRegistered ? [] : ["observer"]),
    ...(dependencies.verifierRegistered ? [] : ["verifier"]),
    ...(dependencies.recoveryContractRegistered ? [] : ["recovery"]),
    ...contract.missingFields,
  ]
  const securityFailures = [
    ...contract.invalidFields.filter((field) => !["verifier-must-be-independent"].includes(field)),
    ...(manifest.externalOperation && manifest.egress === "none" ? ["external-egress"] : []),
  ]
  return {
    valid:
      missingContracts.length === 0 &&
      securityFailures.length === 0 &&
      !contract.invalidFields.includes("verifier-must-be-independent"),
    missingContracts,
    securityFailures,
  }
}

export function auditBuiltInToolCatalog(entries: ReadonlyArray<ToolCatalogEntry>): ToolCatalogAudit {
  const observed = new Map(entries.map((entry) => [entry.name, entry]))
  const names = Object.keys(BuiltInToolManifest).sort()
  const missing = names.filter((name) => !observed.has(name))
  const undeclaredEffects = names.filter((name) => observed.get(name)?.effectDeclaration === "default_deny")
  const invalidDeadlines = names.filter((name) => {
    const deadline = observed.get(name)?.deadlineMs
    return deadline === undefined || !Number.isInteger(deadline) || deadline <= 0
  })
  return {
    expected: names.length,
    observed: names.filter((name) => observed.has(name)).length,
    missing,
    undeclaredEffects,
    invalidDeadlines,
  }
}
