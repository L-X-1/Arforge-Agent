import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { Wildcard } from "@arforge-ai/core/util/wildcard"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { Agent } from "./agent"
import { Permission } from "../permission"

const READ_ONLY_PERMISSIONS = [
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "websearch",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const

const FILE_WRITE_PERMISSIONS = ["edit", "write", "apply_patch"] as const

export function childCapabilityContractError(capabilities: ReadonlyArray<AgentRuntime.ChildCapability>) {
  if (
    capabilities.length > 64 ||
    capabilities.some(
      (capability) =>
        capability.action.length === 0 ||
        capability.action.length > 256 ||
        capability.resources.length === 0 ||
        capability.resources.length > 128 ||
        capability.resources.some((resource) => resource.length === 0 || resource.length > 1_024),
    )
  )
    return "Child capability scope is empty or exceeds the bounded admission contract."
}

const normalizedResources = (resources: ReadonlyArray<string>) =>
  resources
    .map((resource) => resource.replaceAll("\\", "/"))
    .map((resource) => (resource === "workspace" ? "*" : resource))
    .filter((resource, index, all) => resource.length > 0 && all.indexOf(resource) === index)

/**
 * Convert the durable child capability vocabulary to the mature v1
 * permission vocabulary. A wildcard read grant is deliberately limited to
 * read-like tools; it never turns into the agent's broad `* allow` rule.
 */
export function childCapabilityPermissions(capability: AgentRuntime.ChildCapability): ReadonlyArray<string> {
  const action = capability.action.trim().toLowerCase()
  if (action.length === 0) return []
  if (action === "*") return capability.access === "read" ? READ_ONLY_PERMISSIONS : ["*"]
  if (action === "read") return ["read"]
  if (["edit", "write", "apply_patch"].includes(action))
    return capability.access === "write" ? FILE_WRITE_PERMISSIONS : []
  if (action === "bash" || action === "shell") return capability.access === "write" ? ["bash", "shell"] : []
  return [action]
}

/**
 * Whether a capability contract contains an actionable grant for a mature
 * permission name. This is used for the explicit task/todo denies that are
 * kept in the persisted session rules for UI/tool discovery compatibility.
 */
export function childCapabilityAllows(capabilities: ReadonlyArray<AgentRuntime.ChildCapability>, permission: string) {
  return capabilities.some((capability) => {
    if (normalizedResources(capability.resources).length === 0) return false
    return childCapabilityPermissions(capability).some(
      (candidate) => candidate === "*" || candidate === permission || (candidate === "bash" && permission === "shell"),
    )
  })
}

/**
 * Materialize a child capability contract as a restrictive session ruleset.
 * The leading wildcard deny is intentional: permissions not named by the
 * contract must not fall through to a broad agent or user-configured allow.
 */
export function childCapabilityRules(capabilities: ReadonlyArray<AgentRuntime.ChildCapability>): PermissionV1.Ruleset {
  const rules: PermissionV1.Rule[] = [{ permission: "*", pattern: "*", action: "deny" }]
  for (const capability of capabilities) {
    const permissions = childCapabilityPermissions(capability)
    const patterns = normalizedResources(capability.resources)
    if (permissions.length === 0 || patterns.length === 0) continue
    for (const permission of permissions) {
      for (const pattern of patterns) rules.push({ permission, pattern, action: "allow" })
    }
  }
  return rules
}

function parentCapabilityCeilings(
  parentPermission: PermissionV1.Ruleset,
  capabilityRules: PermissionV1.Ruleset,
): PermissionV1.Ruleset {
  const grants = capabilityRules.filter((rule) => rule.action === "allow")
  const ceilings: PermissionV1.Rule[] = []
  for (const parentRule of parentPermission) {
    for (const grant of grants) {
      if (!Wildcard.match(grant.permission, parentRule.permission)) continue
      if (grant.pattern === "*") {
        ceilings.push({ permission: grant.permission, pattern: parentRule.pattern, action: parentRule.action })
        continue
      }
      if (parentRule.pattern === "*" || parentRule.pattern === grant.pattern) {
        ceilings.push({ permission: grant.permission, pattern: grant.pattern, action: parentRule.action })
        continue
      }
      // Intersecting arbitrary glob patterns safely requires a real glob
      // algebra. A narrower parent allow is therefore ignored when it cannot
      // be proven to cover the child resource, while ask/deny conservatively
      // cap the complete explicit child grant.
      if (parentRule.action !== "allow") {
        ceilings.push({ permission: grant.permission, pattern: grant.pattern, action: parentRule.action })
      }
    }
  }
  return ceilings
}

/**
 * Apply the selected subagent's own permission rules as a second hard
 * ceiling.  Child capabilities describe what the parent is willing to
 * delegate; they must not turn an agent that is explicitly read-only into a
 * writer.  We materialize a decision for each admitted capability so a
 * profile's wildcard deny can coexist with exact allow entries without
 * relying on rule ordering or a second permission evaluator.
 */
function subagentCapabilityCeilings(
  subagentPermission: PermissionV1.Ruleset,
  capabilityRules: PermissionV1.Ruleset,
): PermissionV1.Ruleset {
  if (subagentPermission.length === 0) return []
  return capabilityRules
    .filter((rule) => rule.action === "allow")
    .flatMap((grant) => {
      const decision = Permission.evaluate(grant.permission, grant.pattern, subagentPermission)
      return decision.action === "allow" ? [] : [{ ...grant, action: decision.action }]
    })
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent's effective Agent + session rules projected onto the explicit
 *    child grants. Parent allow/ask/deny ordering remains a hard ceiling, but
 *    it can never make an ungranted child permission reachable.
 * 2. When a durable capability contract is supplied, it is materialized as
 *    an allow-list. Omitting the contract keeps the legacy helper behavior
 *    for callers that only need the old subagent session shaping.
 * 3. Default `todowrite` and `task` denies when the effective child contract
 *    does not explicitly grant them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
  capabilities?: ReadonlyArray<AgentRuntime.ChildCapability>
}): PermissionV1.Ruleset {
  const canTask = input.capabilities
    ? childCapabilityAllows(input.capabilities, "task")
    : input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.capabilities
    ? childCapabilityAllows(input.capabilities, "todowrite")
    : input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const capabilityRules = input.capabilities ? childCapabilityRules(input.capabilities) : []
  const subagentCeilings = input.capabilities
    ? subagentCapabilityCeilings(input.subagent.permission, capabilityRules)
    : []
  return [
    ...capabilityRules,
    ...(input.capabilities
      ? parentCapabilityCeilings(input.parentSessionPermission, capabilityRules)
      : input.parentSessionPermission.filter(
          (rule) => rule.permission === "external_directory" || rule.action === "deny",
        )),
    ...subagentCeilings,
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
