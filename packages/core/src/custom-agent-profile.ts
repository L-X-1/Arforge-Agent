import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { extname, join, resolve } from "node:path"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { BuiltInToolManifest } from "./tool/effect-catalog"
import { canonicalHash } from "./util/canonical-hash"
import { isPathInside, isWorkspaceTrusted } from "./workspace-roots"

export { isWorkspaceTrusted } from "./workspace-roots"

/** The versioned, data-only contract for project-scoped custom agents. */
export const SCHEMA_VERSION = 1 as const
export const PROFILE_DIRECTORY = join(".arforge", "agents")
export const ROLE_PREFIX = "CustomAgent."

const NAME_RE = /^[a-z][a-z0-9-]{2,47}$/
const TOOL_RE = /^[a-z][a-z0-9_]{1,79}$/
const SUPPORTED_FIELDS = new Set([
  "schema_version",
  "name",
  "description",
  "system_prompt",
  "tools",
  "capabilities",
  "max_steps",
  "max_tokens",
  "timeout_seconds",
])
const KNOWN_CAPABILITIES = new Set([
  "planning",
  "context_search",
  "safe_modify",
  "code_search",
  "code_review",
  "security_review",
  "test_generation",
  "command_execution",
  "memory_search",
  "multimodal_inspection",
  "data_analysis",
])

/**
 * Names retained by the Python compatibility package.  They remain accepted
 * as data until runtime execution is fully owned by the TS/Core tool bridge;
 * this command never executes a profile or registers a second tool registry.
 */
const LEGACY_TOOL_NAMES = [
  "apply_patch_batch",
  "calculate",
  "cancel_background_cmd",
  "capture_screen",
  "check_page",
  "code_consistency_plan",
  "code_read",
  "code_search",
  "code_summary",
  "code_symbols",
  "compact_context",
  "computer_interact",
  "create_file",
  "csv_preview",
  "delete_file",
  "edit_file",
  "enter_plan_mode",
  "exit_plan_mode",
  "file_state",
  "get_background_output",
  "git_add",
  "git_blame",
  "git_branch",
  "git_checkout",
  "git_commit",
  "git_diff",
  "git_log",
  "git_status",
  "interact_browser",
  "json_pretty",
  "list_background_commands",
  "list_code_files",
  "list_files",
  "list_workflows",
  "multimodal_diagnose",
  "open_file",
  "patch_plan",
  "preview_workflow",
  "python_symbol_rename",
  "read_file",
  "read_file_if_changed",
  "run_background_cmd",
  "run_cmd",
  "run_impacted_tests",
  "run_script",
  "run_tests",
  "schedule_create",
  "schedule_delete",
  "schedule_list",
  "schedule_run_missed",
  "set_permission_mode",
  "skill_read",
  "skill_route",
  "spawn_subagent",
  "spawn_write_subagent",
  "team_create",
  "team_delete",
  "team_get",
  "team_member_add",
  "team_member_remove",
  "team_message_list",
  "team_message_send",
  "team_shutdown_request",
  "team_shutdown_respond",
  "test_browser",
  "time",
  "tool_search",
  "verify_work",
  "web_fetch",
  "web_search",
  "write_file",
] as const

/**
 * Compatibility spellings that have a direct, conservative projection onto
 * the canonical TypeScript tool catalog.  Profiles may continue to describe
 * the historical Python names, but runtime activation must never invent a
 * second tool registry: an entry is usable only when it resolves to a
 * BuiltInToolManifest key.
 */
const RUNTIME_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  apply_patch_batch: "apply_patch",
  code_read: "read",
  code_search: "grep",
  code_summary: "read",
  create_file: "write",
  edit_file: "edit",
  get_background_output: "bash",
  list_code_files: "glob",
  list_files: "glob",
  list_background_commands: "bash",
  open_file: "read",
  patch_plan: "edit",
  python_symbol_rename: "edit",
  read_file: "read",
  read_file_if_changed: "read",
  run_background_cmd: "bash",
  run_cmd: "bash",
  run_impacted_tests: "bash",
  run_script: "bash",
  run_tests: "bash",
  skill_read: "skill",
  skill_route: "skill",
  spawn_subagent: "task",
  spawn_write_subagent: "task",
  web_fetch: "webfetch",
  web_search: "websearch",
})

/** Canonical Core names plus frozen Python names accepted by the data schema. */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(BuiltInToolManifest),
  ...LEGACY_TOOL_NAMES,
])

/** Check a runtime tool ID against own manifest keys, never inherited object properties. */
export const isCanonicalRuntimeTool = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(BuiltInToolManifest, name)

export class CustomAgentProfileError extends Error {
  override readonly name = "CustomAgentProfileError"
}

export type CustomAgentProfile = Readonly<{
  name: string
  description: string
  system_prompt: string
  tools: ReadonlyArray<string>
  capabilities: ReadonlyArray<string>
  max_steps: number
  max_tokens: number
  timeout_seconds: number
  source_path: string
  role_name: string
}>

export type CustomAgentProfilePublic = Readonly<{
  name: string
  role: string
  description: string
  tools: ReadonlyArray<string>
  capabilities: ReadonlyArray<string>
  max_steps: number
  max_tokens: number
  timeout_seconds: number
  path: string
}>

/** Metadata carried by an admitted project profile into the existing
 * provider-neutral child-run path.  It contains no prompt bytes or tool
 * implementation and is safe to persist alongside Agent.Info.options. */
export type CustomAgentRuntimeMetadata = Readonly<{
  schema_version: 1
  provider: "in-process"
  role: string
  profile_path: string
  /** Digest of the exact profile/runtime binding; prompt bytes are excluded. */
  descriptor_digest: string
  declared_tools: ReadonlyArray<string>
  canonical_tools: ReadonlyArray<string>
  capabilities: ReadonlyArray<string>
  max_steps: number
  max_tokens: number
  timeout_seconds: number
  /** Optional payload-free proof carried into a durable child binding. */
  admission_evidence?: AgentRuntime.CustomAgentAdmissionEvidence
}>

export type CustomAgentRuntimeProjection = Readonly<{
  role: string
  declared_tools: ReadonlyArray<string>
  canonical_tools: ReadonlyArray<string>
  unsupported_tools: ReadonlyArray<string>
  ready: boolean
}>

export type CustomAgentRuntimeAdmissionStatus =
  | "admitted"
  | "opt_in_required"
  | "workspace_untrusted"
  | "unsupported_tools"
  | "collision"

/** A payload-free, deterministic explanation of profile runtime admission. */
export type CustomAgentRuntimeAdmission = Readonly<{
  schema_version: 1
  role: string
  profile_path: string
  status: CustomAgentRuntimeAdmissionStatus
  reason: string
  workspace_trusted: boolean
  opt_in: boolean
  ready: boolean
  descriptor_digest?: string
  declared_tools: ReadonlyArray<string>
  canonical_tools: ReadonlyArray<string>
  unsupported_tools: ReadonlyArray<string>
}>

export type CustomAgentRuntimeAdmissionEvidence = Readonly<
  Omit<AgentRuntime.CustomAgentAdmissionEvidence, "status"> & {
    status: CustomAgentRuntimeAdmissionStatus | "invalid"
  }
>

const objectRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const requiredText = (payload: Record<string, unknown>, field: string, minimum: number, maximum: number): string => {
  const value = payload[field]
  if (typeof value !== "string") throw new CustomAgentProfileError(`${field} must be a string`)
  const text = value.trim()
  if (text.length < minimum || text.length > maximum)
    throw new CustomAgentProfileError(`${field} must contain ${minimum}-${maximum} characters`)
  if ([...text].some((char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 32 && code !== 9 && code !== 10 && code !== 13
  }))
    throw new CustomAgentProfileError(`${field} contains an unsupported control character`)
  return text
}

const requiredInteger = (
  payload: Record<string, unknown>,
  field: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number => {
  const value = payload[field] ?? defaultValue
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new CustomAgentProfileError(`${field} must be an integer between ${minimum} and ${maximum}`)
  return value
}

const requiredStringList = (
  payload: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  allowed?: ReadonlySet<string>,
): string[] => {
  const value = payload[field] ?? (minimum === 0 ? [] : undefined)
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new CustomAgentProfileError(`${field} must contain ${minimum}-${maximum} items`)
  if (!value.every((item) => typeof item === "string"))
    throw new CustomAgentProfileError(`${field} must contain only strings`)
  const normalized = value.map((item) => (item as string).trim())
  if (normalized.some((item) => item.length === 0) || new Set(normalized).size !== normalized.length)
    throw new CustomAgentProfileError(`${field} cannot contain empty or duplicate values`)
  if (allowed) {
    const unsupported = [...new Set(normalized.filter((item) => !allowed.has(item)))].sort()
    if (unsupported.length > 0)
      throw new CustomAgentProfileError(`${field} contains unsupported values: ${unsupported.join(", ")}`)
  }
  return normalized
}

/** Parse and validate one data-only profile without reading or writing files. */
export function parseCustomAgentProfile(
  value: unknown,
  sourcePath = "<memory>",
  knownTools: ReadonlySet<string> = KNOWN_TOOL_NAMES,
): CustomAgentProfile {
  const payload = objectRecord(value)
  if (!payload) throw new CustomAgentProfileError("profile must be a JSON object")

  const unknownFields = Object.keys(payload).filter((field) => !SUPPORTED_FIELDS.has(field)).sort()
  if (unknownFields.length > 0)
    throw new CustomAgentProfileError(`unsupported fields: ${unknownFields.join(", ")}`)
  if ((payload.schema_version ?? SCHEMA_VERSION) !== SCHEMA_VERSION)
    throw new CustomAgentProfileError(`schema_version must be ${SCHEMA_VERSION}`)

  const name = requiredText(payload, "name", 3, 48)
  if (!NAME_RE.test(name)) throw new CustomAgentProfileError("name must be lowercase kebab-case")
  const description = requiredText(payload, "description", 1, 500)
  const system_prompt = requiredText(payload, "system_prompt", 20, 8_000)
  const tools = requiredStringList(payload, "tools", 1, 24)
  if (tools.some((tool) => !TOOL_RE.test(tool)))
    throw new CustomAgentProfileError("tools must contain registered tool names")
  const unsupportedTools = [...new Set(tools.filter((tool) => !knownTools.has(tool)))].sort()
  if (unsupportedTools.length > 0)
    throw new CustomAgentProfileError(`tools contains unsupported values: ${unsupportedTools.join(", ")}`)
  const capabilities = requiredStringList(payload, "capabilities", 0, 12, KNOWN_CAPABILITIES)

  const source = resolve(sourcePath)
  return {
    name,
    description,
    system_prompt,
    tools,
    capabilities,
    max_steps: requiredInteger(payload, "max_steps", 8, 1, 25),
    max_tokens: requiredInteger(payload, "max_tokens", 4_096, 256, 16_000),
    timeout_seconds: requiredInteger(payload, "timeout_seconds", 60, 10, 600),
    source_path: source,
    role_name: `${ROLE_PREFIX}${name}`,
  }
}

export function publicProfile(profile: CustomAgentProfile): CustomAgentProfilePublic {
  return {
    name: profile.name,
    role: profile.role_name,
    description: profile.description,
    tools: [...profile.tools],
    capabilities: [...profile.capabilities],
    max_steps: profile.max_steps,
    max_tokens: profile.max_tokens,
    timeout_seconds: profile.timeout_seconds,
    path: profile.source_path,
  }
}

/** Resolve profile tool names to the one canonical built-in catalog. */
export function projectCustomAgentRuntime(profile: CustomAgentProfile): CustomAgentRuntimeProjection {
  const canonical: string[] = []
  const unsupported = new Set<string>()
  for (const declared of profile.tools) {
    const candidate = isCanonicalRuntimeTool(declared) ? declared : RUNTIME_TOOL_ALIASES[declared]
    if (!candidate || !isCanonicalRuntimeTool(candidate)) {
      unsupported.add(declared)
      continue
    }
    if (!canonical.includes(candidate)) canonical.push(candidate)
  }
  return {
    role: profile.role_name,
    declared_tools: [...profile.tools],
    canonical_tools: canonical,
    unsupported_tools: [...unsupported].sort((left, right) => left.localeCompare(right)),
    ready: unsupported.size === 0 && canonical.length > 0,
  }
}

/**
 * Build a stable, payload-free identity for one admitted profile descriptor.
 * The digest binds the version, profile path, canonical tools and all runtime
 * ceilings, so a durable child can reject a changed profile on recovery.
 */
export function customAgentRuntimeDescriptorDigest(
  profile: CustomAgentProfile,
  projection = projectCustomAgentRuntime(profile),
): string | undefined {
  if (!projection.ready) return undefined
  return canonicalHash({
    schema_version: SCHEMA_VERSION,
    provider: "in-process",
    role: profile.role_name,
    profile_path: profile.source_path,
    declared_tools: [...projection.declared_tools],
    canonical_tools: [...projection.canonical_tools],
    capabilities: [...profile.capabilities],
    max_steps: profile.max_steps,
    max_tokens: profile.max_tokens,
    timeout_seconds: profile.timeout_seconds,
  })
}

/**
 * Explain why a profile can or cannot enter the existing Agent/Task runtime.
 * This is an observation-only receipt: it never writes state or authorizes a
 * child run, and its digest excludes prompt/payload bytes.
 */
export function customAgentRuntimeAdmission(
  profile: CustomAgentProfile,
  workspace = process.cwd(),
  options: Readonly<{ collision?: boolean }> = {},
): CustomAgentRuntimeAdmission {
  const projection = projectCustomAgentRuntime(profile)
  const workspace_trusted = isWorkspaceTrusted(workspace)
  const opt_in = truthy(process.env.ARFORGE_ENABLE_CUSTOM_AGENTS)
  const descriptor_digest = customAgentRuntimeDescriptorDigest(profile, projection)
  const status: CustomAgentRuntimeAdmissionStatus = !opt_in
    ? "opt_in_required"
    : !workspace_trusted
      ? "workspace_untrusted"
      : !projection.ready
        ? "unsupported_tools"
        : options.collision
          ? "collision"
          : "admitted"
  const reason =
    status === "admitted"
      ? "profile is ready for the existing in-process durable child path"
      : status === "opt_in_required"
        ? "explicit ARFORGE_ENABLE_CUSTOM_AGENTS opt-in is required"
        : status === "workspace_untrusted"
          ? "the workspace must be explicitly trusted before profile activation"
          : status === "unsupported_tools"
            ? `no canonical TS ToolManifest owner exists for: ${projection.unsupported_tools.join(", ")}`
            : "profile role collides with an existing Agent pool entry"
  const receipt = Object.freeze({
    schema_version: SCHEMA_VERSION,
    role: profile.role_name,
    profile_path: profile.source_path,
    status,
    reason,
    workspace_trusted,
    opt_in,
    ready: status === "admitted",
    ...(descriptor_digest === undefined ? {} : { descriptor_digest }),
    declared_tools: [...projection.declared_tools],
    canonical_tools: [...projection.canonical_tools],
    unsupported_tools: [...projection.unsupported_tools],
  })
  assertCustomAgentRuntimeAdmission(receipt)
  return receipt
}

const ADMISSION_STATUSES = new Set<CustomAgentRuntimeAdmissionStatus>([
  "admitted",
  "opt_in_required",
  "workspace_untrusted",
  "unsupported_tools",
  "collision",
])
const ADMISSION_DIGEST_RE = /^[a-f0-9]{64}$/i
const ADMISSION_PAYLOAD_FIELDS = new Set([
  "system_prompt",
  "prompt",
  "payload",
  "messages",
  "user_input",
  "tool_arguments",
])

const admissionList = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : []

/**
 * Project and validate the immutable admission receipt as bounded evidence.
 * This is deliberately read-only: it does not load a profile, authorize a
 * child, persist an event, or inspect prompt/payload bytes.
 */
export function customAgentRuntimeAdmissionEvidence(value: unknown): CustomAgentRuntimeAdmissionEvidence {
  const record = objectRecord(value)
  const role = typeof record?.role === "string" ? record.role : ""
  const profile_path = typeof record?.profile_path === "string" ? record.profile_path : ""
  const rawStatus = record?.status
  const status: CustomAgentRuntimeAdmissionEvidence["status"] =
    typeof rawStatus === "string" && ADMISSION_STATUSES.has(rawStatus as CustomAgentRuntimeAdmissionStatus)
      ? (rawStatus as CustomAgentRuntimeAdmissionStatus)
      : "invalid"
  const ready = record?.ready === true
  const workspaceTrusted = record?.workspace_trusted === true || record?.workspace_trusted === false
  const optIn = record?.opt_in === true || record?.opt_in === false
  const reason = typeof record?.reason === "string" ? record.reason.trim() : ""
  const descriptorDigest = typeof record?.descriptor_digest === "string" ? record.descriptor_digest : undefined
  const declaredTools = admissionList(record?.declared_tools)
  const canonicalTools = admissionList(record?.canonical_tools)
  const unsupportedTools = admissionList(record?.unsupported_tools)
  const projectionReady = unsupportedTools.length === 0 && canonicalTools.length > 0
  const unique = (items: ReadonlyArray<string>) => new Set(items).size === items.length
  const toolProjectionConsistent =
    declaredTools.length > 0 &&
    unique(declaredTools) &&
    unique(canonicalTools) &&
    unique(unsupportedTools) &&
    canonicalTools.every(isCanonicalRuntimeTool) &&
    !canonicalTools.some((tool) => unsupportedTools.includes(tool)) &&
    (unsupportedTools.length > 0 || canonicalTools.length > 0)
  const descriptorDigestConsistent =
    (descriptorDigest === undefined || ADMISSION_DIGEST_RE.test(descriptorDigest)) &&
    (projectionReady ? descriptorDigest !== undefined : descriptorDigest === undefined)
  const statusConsistent =
    status !== "invalid" &&
    typeof record?.ready === "boolean" &&
    workspaceTrusted &&
    optIn &&
    ready === (status === "admitted") &&
    role.startsWith(ROLE_PREFIX) &&
    profile_path.length > 0 &&
    reason.length > 0 &&
    (status === "admitted"
      ? record?.workspace_trusted === true && record?.opt_in === true && projectionReady
      : status === "opt_in_required"
        ? record?.opt_in === false && !ready
        : status === "workspace_untrusted"
          ? record?.opt_in === true && record?.workspace_trusted === false && !ready
          : status === "unsupported_tools"
            ? unsupportedTools.length > 0 && !ready
            : record?.workspace_trusted === true && record?.opt_in === true && projectionReady && !ready)
  const payloadFree =
    record !== undefined && [...ADMISSION_PAYLOAD_FIELDS].every((field) => !Object.hasOwn(record, field))
  const violations: string[] = []
  if (!statusConsistent) violations.push("status and admission flags are inconsistent")
  if (!descriptorDigestConsistent) violations.push("descriptor digest is missing, malformed, or unexpected")
  if (!toolProjectionConsistent) violations.push("tool projection is malformed or not canonical")
  if (!payloadFree) violations.push("admission evidence contains prompt or payload fields")
  const frozenViolations = Object.freeze([...violations])
  const valid = frozenViolations.length === 0
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    kind: "custom-agent-admission" as const,
    role,
    profile_path,
    status,
    decision: valid && status === "admitted" ? ("admitted" as const) : ("blocked" as const),
    reason: reason || "admission receipt is malformed",
    ready,
    ...(descriptorDigest === undefined ? {} : { descriptor_digest: descriptorDigest }),
    checks: Object.freeze({
      status_consistent: statusConsistent,
      descriptor_digest_consistent: descriptorDigestConsistent,
      tool_projection_consistent: toolProjectionConsistent,
      payload_free: payloadFree,
    }),
    declared_tool_count: declaredTools.length,
    canonical_tool_count: canonicalTools.length,
    unsupported_tool_count: unsupportedTools.length,
    valid,
    violations: frozenViolations,
  })
}

/** Fail closed when an admission receipt violates its runtime invariant. */
export function assertCustomAgentRuntimeAdmission(
  admission: CustomAgentRuntimeAdmission,
): CustomAgentRuntimeAdmissionEvidence {
  const evidence = customAgentRuntimeAdmissionEvidence(admission)
  if (!evidence.valid)
    throw new CustomAgentProfileError(`custom-agent runtime admission invariant failed: ${evidence.violations.join("; ")}`)
  return evidence
}

/** Build the metadata-only child-runtime binding for an admitted profile. */
export function customAgentRuntimeMetadata(
  profile: CustomAgentProfile,
  projection = projectCustomAgentRuntime(profile),
  admission?: CustomAgentRuntimeAdmission,
): CustomAgentRuntimeMetadata | undefined {
  if (!projection.ready) return undefined
  const descriptor_digest = customAgentRuntimeDescriptorDigest(profile, projection)
  if (!descriptor_digest) return undefined
  const admission_evidence = admission === undefined ? undefined : customAgentRuntimeAdmissionEvidence(admission)
  if (admission_evidence !== undefined && (!admission_evidence.valid || admission_evidence.decision !== "admitted"))
    return undefined
  return {
    schema_version: SCHEMA_VERSION,
    provider: "in-process",
    role: profile.role_name,
    profile_path: profile.source_path,
    descriptor_digest,
    declared_tools: [...projection.declared_tools],
    canonical_tools: [...projection.canonical_tools],
    capabilities: [...profile.capabilities],
    max_steps: profile.max_steps,
    max_tokens: profile.max_tokens,
    timeout_seconds: profile.timeout_seconds,
    ...(admission_evidence === undefined
      ? {}
      : { admission_evidence: admission_evidence as AgentRuntime.CustomAgentAdmissionEvidence }),
  }
}

export function profileDirectory(workspace = process.cwd()): string {
  return resolve(workspace, PROFILE_DIRECTORY)
}

/** Load one profile only when it is an existing JSON file below .arforge/agents. */
export function loadCustomAgentProfile(path: string, workspace = process.cwd()): CustomAgentProfile {
  const root = profileDirectory(workspace)
  const rootResolved = existsSync(root) ? realpathSync(root) : resolve(root)
  const candidate = resolve(path)
  let resolvedCandidate: string
  try {
    resolvedCandidate = realpathSync(candidate)
  } catch {
    throw new CustomAgentProfileError("profile must be an existing .json file")
  }
  if (!isPathInside(rootResolved, resolvedCandidate) || extname(resolvedCandidate).toLowerCase() !== ".json")
    throw new CustomAgentProfileError("profile path must be inside .arforge/agents")
  try {
    if (!statSync(resolvedCandidate).isFile()) throw new Error("not a file")
    return parseCustomAgentProfile(JSON.parse(readFileSync(resolvedCandidate, "utf8")), resolvedCandidate)
  } catch (error) {
    if (error instanceof CustomAgentProfileError) throw error
    throw new CustomAgentProfileError(`invalid profile JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Inspect all JSON profiles without importing or executing project code. */
export function discoverCustomAgentProfiles(workspace = process.cwd()): {
  profiles: CustomAgentProfile[]
  errors: Array<{ path: string; error: string }>
} {
  const root = profileDirectory(workspace)
  if (!existsSync(root) || !statSync(root).isDirectory()) return { profiles: [], errors: [] }
  const profiles: CustomAgentProfile[] = []
  const errors: Array<{ path: string; error: string }> = []
  const seenNames = new Set<string>()
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()))
  for (const entry of entries) {
    const path = join(root, entry.name)
    try {
      const profile = loadCustomAgentProfile(path, workspace)
      if (seenNames.has(profile.name)) throw new CustomAgentProfileError(`duplicate profile name: ${profile.name}`)
      seenNames.add(profile.name)
      profiles.push(profile)
    } catch (error) {
      errors.push({
        path: resolve(path),
        error: error instanceof CustomAgentProfileError ? error.message : String(error),
      })
    }
  }
  return { profiles, errors }
}

const truthy = (value: string | undefined): boolean => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase())

/** Explicit opt-in plus workspace trust; no profile or state is created here. */
export function customAgentsEnabled(workspace = process.cwd()): boolean {
  return truthy(process.env.ARFORGE_ENABLE_CUSTOM_AGENTS) && isWorkspaceTrusted(workspace)
}

export function customAgentsStatus(workspace = process.cwd()) {
  return {
    directory: profileDirectory(workspace),
    workspace_trusted: isWorkspaceTrusted(workspace),
    enabled: customAgentsEnabled(workspace),
    activation: "ARFORGE_ENABLE_CUSTOM_AGENTS=1",
  }
}

export function loadEnabledCustomAgentProfiles(workspace = process.cwd()): {
  profiles: CustomAgentProfile[]
  errors: Array<{ path: string; error: string }>
} {
  if (!customAgentsEnabled(workspace)) return { profiles: [], errors: [] }
  const discovered = discoverCustomAgentProfiles(workspace)
  return discovered.errors.length > 0 ? { profiles: [], errors: discovered.errors } : discovered
}
