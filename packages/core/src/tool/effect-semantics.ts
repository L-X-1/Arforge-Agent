import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

type Scope = {
  readonly filesystemScope?: ReadonlyArray<string>
  readonly networkScope?: ReadonlyArray<string>
  readonly secretScope?: ReadonlyArray<string>
  readonly externalServices?: ReadonlyArray<string>
  readonly expectedArtifacts?: ReadonlyArray<string>
  readonly successCriteria?: ReadonlyArray<string>
}

const values = (items?: ReadonlyArray<string>) => (items ? [...items] : [])

/**
 * Canonicalizes the effect contract before it becomes part of an action
 * intent. Tool authors and control adapters may describe the same resource in
 * different orders, but durable recovery must compare one stable value.
 */
export function canonicalEffectSemantics(
  semantics: AgentRuntime.EffectSemantics,
  authority = semantics.authority,
): AgentRuntime.EffectSemantics {
  const resources = (items: ReadonlyArray<string>) =>
    [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort()
  const compensation = semantics.compensation?.trim()
  return AgentRuntime.EffectSemantics.make({
    ...semantics,
    authority,
    ...(compensation ? { compensation } : {}),
    filesystemScope: resources(semantics.filesystemScope),
    networkScope: resources(semantics.networkScope),
    secretScope: resources(semantics.secretScope),
    externalServices: resources(semantics.externalServices),
    expectedArtifacts: resources(semantics.expectedArtifacts),
    successCriteria: resources(semantics.successCriteria),
  })
}

export const automaticRead = (scope: Scope = {}) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L0",
    authority: "automatic",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "not_applicable",
    filesystemScope: values(scope.filesystemScope),
    networkScope: values(scope.networkScope),
    secretScope: values(scope.secretScope),
    externalServices: values(scope.externalServices),
    expectedArtifacts: values(scope.expectedArtifacts),
    successCriteria: values(scope.successCriteria),
  })

export const scopedChange = (
  scope: Scope & {
    readonly idempotency?: "idempotent" | "conditional" | "non_idempotent"
    readonly retryability?: "safe" | "guarded" | "never"
    readonly reversibility?: "not_applicable" | "reversible" | "compensatable" | "irreversible"
    readonly compensation?: string
  } = {},
) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L2",
    authority: "scoped_grant",
    idempotency: scope.idempotency ?? "conditional",
    retryability: scope.retryability ?? "guarded",
    reversibility: scope.reversibility ?? "irreversible",
    filesystemScope: values(scope.filesystemScope),
    networkScope: values(scope.networkScope),
    secretScope: values(scope.secretScope),
    externalServices: values(scope.externalServices),
    ...(scope.compensation ? { compensation: scope.compensation } : {}),
    expectedArtifacts: values(scope.expectedArtifacts),
    successCriteria: values(scope.successCriteria),
  })

export const majorImpact = (scope: Scope = {}) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L3",
    authority: "human",
    idempotency: "non_idempotent",
    retryability: "never",
    reversibility: "irreversible",
    filesystemScope: values(scope.filesystemScope),
    networkScope: values(scope.networkScope),
    secretScope: values(scope.secretScope),
    externalServices: values(scope.externalServices),
    expectedArtifacts: values(scope.expectedArtifacts),
    successCriteria: values(scope.successCriteria),
  })

/**
 * Session-local projections are durable writes, but they do not mutate the
 * product's external world. Keep them visible as L1 state changes instead of
 * silently inheriting the L3 undeclared fallback.
 */
export const sessionProjectionChange = (scope: Scope = {}) =>
  AgentRuntime.EffectSemantics.make({
    ...automaticRead(scope),
    riskTier: "L1",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "reversible",
    compensation: "restore the previous session projection",
  })

export type ToolCallSemanticsInput = {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly workspace?: string
}

const strings = (input: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
  keys.flatMap((key) => (typeof input[key] === "string" && input[key] ? [input[key] as string] : []))

/**
 * Compatibility classifier used while the mature desktop tools converge on
 * the canonical Tool definition. Unknown/plugin tools fail closed at L3.
 */
export function forToolCall({ name, input, workspace }: ToolCallSemanticsInput) {
  const normalized = name.toLowerCase()
  const fileScope = strings(input, ["path", "filePath", "file_path", "directory", "workdir"])
  const networkScope = strings(input, ["url", "uri", "server"])
  const fallbackScope = workspace ? [workspace] : []

  if (
    ["read", "glob", "grep", "lsp", "skill", "question", "invalid", "plan_exit", "structuredoutput"].includes(
      normalized,
    )
  )
    return automaticRead({
      filesystemScope: fileScope.length > 0 ? fileScope : fallbackScope,
      successCriteria: [`${name} returns a bounded, validated result`],
    })

  if (
    ["webfetch", "websearch", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(
      normalized,
    )
  )
    return automaticRead({
      networkScope,
      externalServices: strings(input, ["server"]),
      successCriteria: [`${name} returns authorized read-only data`],
    })

  if (["todowrite", "todo"].includes(normalized))
    return AgentRuntime.EffectSemantics.make({
      ...automaticRead({ successCriteria: ["task-local planning state is updated"] }),
      riskTier: "L1",
    })

  if (["edit", "write", "apply_patch"].includes(normalized))
    return scopedChange({
      filesystemScope: fileScope.length > 0 ? fileScope : fallbackScope,
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "reversible",
      compensation: "restore the pre-action file snapshot",
      expectedArtifacts: fileScope,
      successCriteria: ["requested file change is persisted and can be diffed"],
    })

  if (normalized === "task")
    return scopedChange({
      filesystemScope: fallbackScope,
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "compensatable",
      compensation: "cancel the delegated child task and retain its audit trail",
      successCriteria: ["delegated result is returned within the parent authority and budget"],
    })

  if (["bash", "shell"].includes(normalized)) {
    // A command-prefix regex cannot prove the effects of shell composition:
    // redirects, pipes, command substitution, PowerShell aliases, invoked
    // scripts, and inherited environments can all expand its impact. Keep all
    // shell execution at human approval until a shell-specific AST effect
    // parser supplies complete filesystem, network, secret, and process scope
    // to the Action Gateway. Do not restore an L2 fast path here.
    return majorImpact({
      filesystemScope: fileScope.length > 0 ? fileScope : fallbackScope,
      networkScope: ["command-declared network access"],
      secretScope: ["command-visible environment"],
      externalServices: ["command-declared external services"],
      successCriteria: ["command result and actual impact are captured"],
    })
  }

  return majorImpact({
    filesystemScope: fileScope.length > 0 ? fileScope : fallbackScope,
    networkScope,
    externalServices: strings(input, ["server", "service"]),
    successCriteria: [`${name} returns a validated result after explicit approval`],
  })
}
