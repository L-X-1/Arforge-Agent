import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { McpCatalog } from "@/mcp/catalog"
import { ShellPreflight } from "@/tool/shell"
import path from "node:path"

export type PermissionPreflightInput = {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly workspace: string
  /** Active Location directory; the tools' own external-directory boundary. */
  readonly locationDirectory: string
  readonly riskTier: "L2" | "L3"
  readonly shellPreflight?: ShellPreflight.Preflight
}

/**
 * Compatibility projection of the mature leaf permission contract into one
 * immutable ActionGateway plan. Core ToolRegistry remains the only component
 * that consumes the plan, issues authority, and executes the tool.
 */
export function permissionPreflight(input: PermissionPreflightInput): ActionGateway.AuthorizationPlan {
  const normalized = input.name.toLowerCase()
  const requests: ActionGateway.AuthorizationRequest[] = []
  const metadata = {
    source: "action-gateway-preflight",
    tool: input.name,
    riskTier: input.riskTier,
  }
  const push = (action: string, resources: string[], omitWhenEmpty = false) => {
    const normalized = unique(resources)
    if (omitWhenEmpty && normalized.length === 0) return
    requests.push({
      action,
      resources: normalized.length > 0 ? normalized : ["*"],
    })
  }

  if (["edit", "write"].includes(normalized)) {
    push("edit", filePatterns(input.input, input.workspace))
    push("external_directory", externalDirectoryGlobs(input.input, input.locationDirectory), true)
    return { requests, metadata }
  }

  if (normalized === "apply_patch") {
    const patchText = stringValue(input.input, "patchText", "patch_text")
    const files = patchText
      ? Array.from(
          patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm),
          (match) => match[1] ?? "",
        ).filter(Boolean)
      : []
    push(
      "edit",
      files.map((file) => relativePattern(file, input.workspace)),
    )
    push(
      "external_directory",
      files.flatMap((file) => externalDirectoryGlob(file, input.locationDirectory)),
      true,
    )
    return { requests, metadata }
  }

  if (normalized === "bash" || normalized === "shell") {
    const command = stringValue(input.input, "command")?.trim()
    const resources = command ? [command] : ["*"]
    if (command && input.shellPreflight?.type === "known" && input.shellPreflight.network === "possible")
      resources.push(`process:${command}`)
    push("bash", resources)
    push(
      "external_directory",
      input.shellPreflight?.type === "known" ? [...input.shellPreflight.externalDirectoryGlobs] : [],
      true,
    )
    return { requests, metadata }
  }

  if (normalized === "task") {
    const subagent = stringValue(input.input, "subagent_type")
    push("task", subagent ? [subagent] : ["*"])
    return { requests, metadata }
  }

  // MCP, code-mode, and plugin tools retain their exposed ID as the sole
  // permission namespace. Core marks these entries untrusted and L3.
  push(input.name, ["*"])
  return { requests, metadata }
}

function externalDirectoryGlobs(input: Readonly<Record<string, unknown>>, workspace: string) {
  return ["filePath", "file_path", "path"]
    .flatMap((key) => {
      const value = input[key]
      return typeof value === "string" && value.length > 0 ? [value] : []
    })
    .flatMap((file) => externalDirectoryGlob(file, workspace))
}

function externalDirectoryGlob(file: string, workspace: string) {
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(workspace, file)
  if (containsPath(workspace, absolute)) return []
  return [normalizePermissionResource(path.join(path.dirname(absolute), "*"))]
}

function containsPath(workspace: string, absolute: string) {
  const relative = path.relative(workspace, absolute)
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function filePatterns(input: Readonly<Record<string, unknown>>, workspace: string) {
  const files = ["filePath", "file_path", "path"]
    .flatMap((key) => {
      const value = input[key]
      return typeof value === "string" && value.length > 0 ? [value] : []
    })
    .map((file) => relativePattern(file, workspace))
  return files.length > 0 ? files : ["*"]
}

export function mcpServerFor(key: string, clientNames: ReadonlyArray<string>) {
  return McpCatalog.serverForToolKey(key, clientNames)
}

function relativePattern(file: string, workspace: string) {
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(workspace, file)
  const relative = path.relative(workspace, absolute)
  return normalizePermissionResource(relative.length > 0 ? relative : ".")
}

function stringValue(input: Readonly<Record<string, unknown>>, ...keys: string[]) {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function unique(values: string[]) {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index)
}

function normalizePermissionResource(value: string) {
  return value.replaceAll("\\", "/")
}

export * as LegacyToolAuthorization from "./legacy-tool-authorization"
