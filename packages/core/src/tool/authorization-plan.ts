export * as AuthorizationPlan from "./authorization-plan"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "../action-gateway"
import { Tool } from "./tool"
import { Effect } from "effect"
import { Patch } from "../patch"
import { Egress } from "../egress"
import { TurnToolCarrier } from "./turn-carrier"

export type PlanRequest = { readonly action: string; readonly resources: ReadonlyArray<string> }

export type ResolvedTarget = { readonly resource: string; readonly external?: string }

/**
 * Static preflight derivation outcome for one tool call.
 * - `requests`: the complete exact request set; the grant must be exactly
 *   these requests — never widened with wildcards.
 * - `blocked`: a known leaf tool whose scope could not be derived statically
 *   (parse or path resolution failure); callers must block before any
 *   PermissionV2 request or attempt.
 * - `fallback`: not a known leaf tool; the separate third-party fail-closed
 *   policy applies (explicit L3 wildcard), never mixed into known tools.
 */
export type StaticPlanOutcome =
  | { readonly kind: "requests"; readonly requests: ReadonlyArray<PlanRequest> }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "fallback" }

/** Built-in leaf tools with static plan derivation; their grants are exact-scoped. */
const staticLeafPlanNames = new Set([
  "edit",
  "write",
  "apply_patch",
  "bash",
  "webfetch",
  "websearch",
  "read",
  "glob",
  "grep",
  "skill",
  "goal_update",
  "todowrite",
  "question",
  "invalid",
  "lsp",
  "plan_exit",
  "notebook_read",
  "notebook_edit",
  "trigger_profiles",
  "trigger_manage",
  "team_create",
  "team_member_add",
  "team_member_remove",
  "team_shutdown_request",
  "team_delete",
  "create_task",
  "update_task",
  "claim_task",
  "complete_task",
  "delete_task",
  "multimodal_diagnose",
  "deliver_user_message",
  "StructuredOutput",
  ...TurnToolCarrier.names,
])

/**
 * Exhaustive, immutable set of every trusted built-in registration name plus
 * the fixed names reserved for opaque per-turn carriers,
 * audited from the 21 Tools.BuiltIns registration sites (single-name modules
 * export `name`; notebook/trigger/task-graph/team register multiple names).
 * Reserved names may only be registered through the trusted carrier; the
 * registry rejects untrusted registrations under any of them before
 * materialization. This set is intentionally broader than the static leaf
 * plan set: non-leaf built-ins are reserved without being forced into static
 * leaf planning. This protects normal untrusted registration paths and
 * runtime composition wiring; it is not process isolation against arbitrary
 * hostile in-process code that imports and composes builtInsNode itself.
 */
export const reservedBuiltInNames: ReadonlyArray<string> = Object.freeze([
  "apply_patch",
  "bash",
  "cooperative_wait",
  "edit",
  "glob",
  "goal_update",
  "grep",
  "multimodal_diagnose",
  "deliver_user_message",
  "question",
  "read",
  "tool_search",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
  "invalid",
  "lsp",
  "plan_exit",
  "execute",
  "notebook_read",
  "notebook_edit",
  "trigger_profiles",
  "trigger_manage",
  "create_task",
  "list_tasks",
  "search_tasks",
  "update_task",
  "claim_task",
  "complete_task",
  "delete_task",
  "team_create",
  "team_get",
  "team_member_add",
  "team_message_send",
  "team_message_list",
  "team_shutdown_request",
  "team_shutdown_respond",
  "team_member_remove",
  "team_delete",
  "StructuredOutput",
  ...TurnToolCarrier.names,
])

const reservedBuiltInNameSet = new Set(reservedBuiltInNames)

export const isReservedBuiltInName = (name: string) => reservedBuiltInNameSet.has(name)

const filesystemLeafActions = new Set(["read", "edit", "glob", "grep", "external_directory"])

const leafResourceMatches = (action: string, granted: string, requested: string) =>
  granted === requested ||
  (filesystemLeafActions.has(action) && granted.replaceAll("\\", "/") === requested.replaceAll("\\", "/"))

/**
 * Builds the leaf authorizer for a gateway-authorized operation body. The
 * granted scope comes exclusively from the opaque capability's verified
 * durable grant (never from a caller-side plan or boolean); a capability
 * belonging to a different action, or any forged capability, fails closed at
 * construction. A covered same-action same-or-narrower leaf request returns
 * without another PermissionV2 call; an unplanned action or expanded
 * resource fails with ToolAuthorizationFailure before any tool effect, never
 * opening a second interactive ask. For automatic (L0/L1) execution the
 * scope comes from the trusted Registry preflight and is verified
 * noninteractively — no leaf call ever invokes PermissionV2 after gateway
 * evaluation.
 */
export const scopedPermission = (input: {
  readonly capability: ActionGateway.AuthorizationGrantCapability
  readonly expectedActionID: AgentRuntime.ActionID
  /** Trusted noninteractive automatic (L0/L1) scope derived by the Registry preflight. */
  readonly automaticRequests?: ReadonlyArray<PlanRequest>
}): Tool.LeafAuthorizer => {
  const granted = ActionGateway.capabilityGrant(input.capability)
  if (granted && granted.actionID !== input.expectedActionID)
    throw new Error("The authorization grant capability does not belong to this action")
  const requests = granted ? ActionGateway.capabilityRequests(input.capability) : input.automaticRequests
  const failure = (action: string, resources: ReadonlyArray<string>, reason: string) =>
    new Tool.ToolAuthorizationFailure(action, [...resources], reason, requests ?? [])
  return {
    assert: (leaf) => {
      if (!requests)
        return Effect.fail(
          failure(leaf.action, leaf.resources, "No trusted authorization scope is bound to this tool call"),
        )
      const matching = requests.filter((request) => request.action === leaf.action)
      if (matching.length === 0)
        return Effect.fail(failure(leaf.action, leaf.resources, `Unplanned permission action ${leaf.action}`))
      const covered = leaf.resources.every((resource) =>
        matching.some((request) =>
          request.resources.some((granted) => granted === "*" || leafResourceMatches(leaf.action, granted, resource)),
        ),
      )
      return covered
        ? Effect.void
        : Effect.fail(
            failure(
              leaf.action,
              leaf.resources,
              `Leaf scope ${leaf.resources.join(", ")} exceeds the trusted authorization scope`,
            ),
          )
    },
  }
}

/**
 * Builds the second, protocol-level check for HTTP tools. The egress guard is
 * bound to the same opaque Gateway capability as the leaf permission and uses
 * only the exact resources exposed by that capability.
 */
export const scopedEgress = (input: {
  readonly capability: ActionGateway.AuthorizationGrantCapability
  readonly expectedActionID: AgentRuntime.ActionID
  readonly automaticRequests?: ReadonlyArray<PlanRequest>
  readonly action: string
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly allowedMethods: ReadonlyArray<Egress.HttpMethod>
}): Egress.Authorizer => {
  const granted = ActionGateway.capabilityGrant(input.capability)
  if (granted && granted.actionID !== input.expectedActionID)
    throw new Error("The authorization grant capability does not belong to this action")
  const requests = granted ? ActionGateway.capabilityRequests(input.capability) : input.automaticRequests
  const grantedResources = requests
    ?.filter((request) => request.action === input.action)
    .flatMap((request) => request.resources)
  return Egress.make({
    action: input.action,
    networkScope: input.networkScope,
    secretScope: input.secretScope,
    allowedMethods: input.allowedMethods,
    grantedResources,
  })
}

const unique = (values: ReadonlyArray<string>) =>
  values.filter((value, index) => value.length > 0 && values.indexOf(value) === index)

const stringValue = (input: Readonly<Record<string, unknown>>, ...keys: string[]) => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

const parsePatchTargets = (patchText: string) => {
  try {
    return Patch.parse(patchText)
      .map((hunk) => hunk.path)
      .filter((path) => path.length > 0)
  } catch {
    return []
  }
}

/**
 * Statically derives the canonical permission requests for one known leaf
 * tool call before authorization. Paths are resolved through the injected
 * read-only resolver (never mutated); `external_directory` is requested only
 * for paths resolved outside the active root. Grants are exact: no wildcard
 * is ever added beside exact resources. A known tool whose scope cannot be
 * derived completely is `blocked`; unknown tools fall through to the separate
 * third-party fallback policy.
 */
export const staticPlanRequests = Effect.fn("AuthorizationPlan.static")(
  (input: {
    readonly toolName: string
    readonly permissionAction: string
    readonly semantics: AgentRuntime.EffectSemantics
    readonly rawInput: Readonly<Record<string, unknown>>
    readonly trusted: boolean
    readonly resolve: (path: string, kind: "file" | "directory") => Effect.Effect<ResolvedTarget | undefined>
  }): Effect.Effect<StaticPlanOutcome> =>
    Effect.gen(function* () {
      const { toolName, permissionAction, semantics, rawInput, trusted, resolve } = input
      // Trust is provenance, never the tool name: an untrusted registration
      // under a reserved built-in name must fall through to the third-party
      // fail-closed policy instead of inheriting static/automatic scope.
      if (!trusted || !staticLeafPlanNames.has(toolName)) return { kind: "fallback" }
      const declaredNetworkServiceSecret = unique([
        ...semantics.networkScope,
        ...semantics.secretScope,
        ...semantics.externalServices,
      ])

      // A validated final projection has no external side effect and needs no
      // permission scope. It still traverses ActionGateway and the complete
      // canonical settlement pipeline.
      if (toolName === "StructuredOutput") return { kind: "requests", requests: [] }

      if (toolName === "invalid" || toolName === "plan_exit") return { kind: "requests", requests: [] }

      if (toolName === "task") {
        const subagent = stringValue(rawInput, "subagent_type")
        return subagent
          ? { kind: "requests", requests: [{ action: "task", resources: [subagent] }] }
          : { kind: "blocked", reason: "task provided no subagent_type for static scope resolution" }
      }

      if (toolName === "read_user_attachment") {
        const file = stringValue(rawInput, "filePath")
        if (!file)
          return { kind: "blocked", reason: "read_user_attachment provided no filePath for static scope resolution" }
        const target = yield* resolve(file, "directory")
        if (!target) return { kind: "blocked", reason: "read_user_attachment target could not be statically resolved" }
        // The durable User message is the exact grant for this attachment.
        // Keep the leaf read scope exact, including an external absolute path,
        // without opening a second external_directory approval.
        return { kind: "requests", requests: [{ action: "read", resources: [target.resource] }] }
      }

      const fileTargets = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
        const resolved: Array<{ resource: string; external?: string }> = []
        const externals: string[] = []
        for (const file of paths) {
          const target = yield* resolve(file, "file")
          if (!target) return undefined
          resolved.push(target)
          if (target.external) externals.push(target.external)
        }
        return { resolved, externals: unique(externals) }
      })

      if (permissionAction === "edit") {
        if (toolName === "apply_patch") {
          const patchText = stringValue(rawInput, "patchText", "patch_text")
          if (!patchText)
            return { kind: "blocked", reason: "apply_patch provided no patchText for static scope resolution" }
          const targets = yield* fileTargets(parsePatchTargets(patchText))
          if (!targets || targets.resolved.length === 0)
            return { kind: "blocked", reason: "apply_patch targets could not be statically resolved" }
          const requests: PlanRequest[] = [
            { action: "edit", resources: unique(targets.resolved.map((t) => t.resource)) },
          ]
          if (targets.externals.length > 0)
            requests.push({ action: "external_directory", resources: targets.externals })
          return { kind: "requests", requests }
        }
        const file = stringValue(rawInput, "path", "filePath", "notebook_path")
        if (!file) return { kind: "blocked", reason: `${toolName} provided no path for static scope resolution` }
        const target = yield* resolve(file, "file")
        if (!target) return { kind: "blocked", reason: `${toolName} target could not be statically resolved` }
        const requests: PlanRequest[] = [{ action: "edit", resources: [target.resource] }]
        if (target.external) requests.push({ action: "external_directory", resources: [target.external] })
        return { kind: "requests", requests }
      }

      if (permissionAction === "bash") {
        const requests: PlanRequest[] = []
        const command = stringValue(rawInput, "command")
        if (!command) return { kind: "blocked", reason: "bash provided no command for static scope resolution" }
        requests.push({ action: "bash", resources: [command] })
        const workdir = stringValue(rawInput, "workdir")
        if (workdir) {
          const target = yield* resolve(workdir, "directory")
          if (!target) return { kind: "blocked", reason: "bash workdir could not be statically resolved" }
          if (target.external) requests.push({ action: "external_directory", resources: [target.external] })
        }
        return { kind: "requests", requests }
      }

      if (permissionAction === "webfetch" || permissionAction === "websearch") {
        const exact = stringValue(rawInput, "url", "query")
        if (!exact) return { kind: "blocked", reason: `${toolName} provided no exact scope for static resolution` }
        if (permissionAction === "webfetch") {
          // Non-HTTP schemes are rejected before any permission request or
          // transport: a file:// URL must never prompt for approval.
          let parsed: URL | undefined
          try {
            parsed = new URL(exact)
          } catch {
            parsed = undefined
          }
          if (!parsed || !["http:", "https:"].includes(parsed.protocol))
            return { kind: "blocked", reason: "webfetch only supports http and https URLs" }
        }
        return {
          kind: "requests",
          requests: [{ action: permissionAction, resources: unique([exact, ...declaredNetworkServiceSecret]) }],
        }
      }

      if (permissionAction === "skill") {
        const name = stringValue(rawInput, "name")
        return name
          ? { kind: "requests", requests: [{ action: "skill", resources: [name] }] }
          : { kind: "blocked", reason: "skill provided no name for static scope resolution" }
      }

      if (permissionAction === "goal_update") {
        const goalID = stringValue(rawInput, "goalID", "goal_id")
        return goalID
          ? { kind: "requests", requests: [{ action: "goal_update", resources: [goalID] }] }
          : { kind: "blocked", reason: "goal_update provided no goalID for static scope resolution" }
      }

      if (permissionAction === "trigger_manage") {
        const profile = stringValue(rawInput, "profile") ?? "local"
        return { kind: "requests", requests: [{ action: "trigger_manage", resources: [profile] }] }
      }

      if (
        permissionAction === "trigger_profiles" ||
        permissionAction === "todowrite" ||
        permissionAction === "question" ||
        permissionAction === "lsp"
      ) {
        // These leaf permissions are declared as wildcard by design.
        return { kind: "requests", requests: [{ action: permissionAction, resources: ["*"] }] }
      }

      if (permissionAction === "notebook_read") {
        const file = stringValue(rawInput, "notebook_path")
        if (!file)
          return { kind: "blocked", reason: "notebook_read provided no notebook_path for static scope resolution" }
        const target = yield* resolve(file, "file")
        if (!target) return { kind: "blocked", reason: "notebook_read target could not be statically resolved" }
        const requests: PlanRequest[] = [{ action: "notebook_read", resources: [target.resource] }]
        if (target.external) requests.push({ action: "external_directory", resources: [target.external] })
        return { kind: "requests", requests }
      }

      if (permissionAction === "multimodal_diagnose") {
        const file = stringValue(rawInput, "filename")
        if (!file)
          return { kind: "blocked", reason: "multimodal_diagnose provided no filename for static scope resolution" }
        const target = yield* resolve(file, "file")
        if (!target) return { kind: "blocked", reason: "multimodal_diagnose target could not be statically resolved" }
        return { kind: "requests", requests: [{ action: "multimodal_diagnose", resources: [target.resource] }] }
      }

      if (permissionAction === "read") {
        const file = stringValue(rawInput, "path", "filePath")
        if (!file) return { kind: "blocked", reason: "read provided no path for static scope resolution" }
        // The read leaf resolves with directory semantics (it can list or page a
        // directory); the preflight must resolve identically.
        const target = yield* resolve(file, "directory")
        if (!target) return { kind: "blocked", reason: "read target could not be statically resolved" }
        const requests: PlanRequest[] = [{ action: "read", resources: [target.resource] }]
        if (target.external) requests.push({ action: "external_directory", resources: [target.external] })
        return { kind: "requests", requests }
      }

      if (permissionAction === "glob" || permissionAction === "grep") {
        const pattern = stringValue(rawInput, "pattern")
        if (!pattern) return { kind: "blocked", reason: `${toolName} provided no pattern for static scope resolution` }
        return { kind: "requests", requests: [{ action: permissionAction, resources: [pattern] }] }
      }

      if (permissionAction === "team_create" || permissionAction === "team_delete") {
        return { kind: "requests", requests: [{ action: permissionAction, resources: ["team"] }] }
      }
      if (
        permissionAction === "team_member_add" ||
        permissionAction === "team_member_remove" ||
        permissionAction === "team_shutdown_request"
      ) {
        const member = stringValue(rawInput, "memberName", "member_name")
        const agentID = stringValue(rawInput, "agentID", "agent_id")
        const resources = unique([...(member ? [member] : []), ...(agentID ? [agentID] : [])])
        return resources.length > 0
          ? { kind: "requests", requests: [{ action: permissionAction, resources }] }
          : { kind: "blocked", reason: `${toolName} provided no member for static scope resolution` }
      }
      if (permissionAction === "deliver_user_message") {
        const rawAttachments = rawInput.attachments
        const attachments = Array.isArray(rawAttachments)
          ? rawAttachments.filter((value): value is string => typeof value === "string")
          : []
        if (attachments.length !== (Array.isArray(rawAttachments) ? rawAttachments.length : 0))
          return { kind: "blocked", reason: "deliver_user_message provided invalid attachment paths" }
        const targets = yield* fileTargets(attachments)
        if (!targets) return { kind: "blocked", reason: "deliver_user_message attachment could not be resolved" }
        const requests: PlanRequest[] = [
          { action: permissionAction, resources: ["*"] },
          ...(targets.resolved.length > 0
            ? [{ action: "read", resources: unique(targets.resolved.map((target) => target.resource)) }]
            : []),
        ]
        if (targets.externals.length > 0)
          requests.push({ action: "external_directory", resources: unique(targets.externals) })
        return { kind: "requests", requests }
      }
      if (permissionAction === "create_task") {
        return { kind: "requests", requests: [{ action: "create_task", resources: ["task-graph"] }] }
      }
      if (
        permissionAction === "update_task" ||
        permissionAction === "claim_task" ||
        permissionAction === "complete_task" ||
        permissionAction === "delete_task"
      ) {
        const taskID = stringValue(rawInput, "taskID", "task_id")
        return taskID
          ? { kind: "requests", requests: [{ action: permissionAction, resources: [taskID] }] }
          : { kind: "blocked", reason: `${toolName} provided no taskID for static scope resolution` }
      }

      return { kind: "fallback" }
    }),
)
