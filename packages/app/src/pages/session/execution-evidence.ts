import type { ToolPart } from "@arforge-ai/sdk/v2"
import { normalizedDevelopmentPath, parseDevelopmentConditions } from "@arforge-ai/schema/development-conditions"
import type { DiffSource } from "@arforge-ai/session-ui/session-diff"
import { pathKey } from "@/utils/path-key"
import { executionToolKey, executionToolOutput, executionToolStatus, type ExecutionTrace } from "./execution-trace-model"

type FileEvidence = {
  file: string
  toolID?: string
  diff?: DiffSource
  scope?: "outside" | "incomplete"
}

type VerificationStatus =
  | "pending" | "approval" | "active" | "running" | "passed" | "failed" | "tool-error" | "interrupted"
  | "timeout" | "incomplete" | "unexecuted" | "outside-workspace" | "workdir-unverified"
type VerificationEvidence = {
  toolID?: string
  command: string
  status: VerificationStatus
  exit?: number
  output?: string
}

export type ExecutionEvidence = {
  files: FileEvidence[]
  verifications: VerificationEvidence[]
  missingFileEvidence: boolean
}

export function countVerificationOutcomes(results: ExecutionEvidence["verifications"]) {
  const counts = { passed: 0, failed: 0, incomplete: 0 }
  const unmatched = new Set(results.filter((result) => !result.toolID).map((result) => result.command))
  for (const { status, command } of results) {
    if ((status === "outside-workspace" || status === "workdir-unverified") && unmatched.has(command)) continue
    if (status === "passed") counts.passed++
    else if (status === "failed" || status === "tool-error" || status === "timeout") counts.failed++
    else counts.incomplete++
  }
  return counts
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function fileEvidence(value: unknown, toolID: string): FileEvidence | undefined {
  if (!record(value) || typeof value.file !== "string" || !value.file) return
  const { file, patch, before, after } = value
  const diff = typeof patch === "string" && patch
    ? { file, patch }
    : typeof before === "string" && typeof after === "string" ? { file, before, after } : undefined
  return { file, toolID, diff }
}

function toolFiles(tool: ToolPart): FileEvidence[] {
  if (tool.state.status !== "completed") return []
  const metadata = tool.state.metadata
  const key = executionToolKey(tool)
  const files = Array.isArray(metadata?.files) ? metadata.files.flatMap((file) => fileEvidence(file, key) ?? []) : []
  if (files.length) return files
  const legacy = fileEvidence(metadata?.filediff, key)
  if (legacy) return [legacy]
  if (tool.tool === "write" && metadata?.operation === "write" && typeof metadata.target === "string" && metadata.target)
    return [{ file: metadata.target, toolID: key }]
  return []
}

function workspacePath(file: string, directory: string | undefined, windows: boolean) {
  const path = normalizedDevelopmentPath(file)
  if (!path) return
  const root = directory ? normalizedDevelopmentPath(directory).replace(/\/+$/, "") + "/" : undefined
  const comparable = windows ? path.toLowerCase() : path
  const prefix = windows ? root?.toLowerCase() : root
  const relative = prefix && comparable.startsWith(prefix) ? comparable.slice(prefix.length) : comparable
  if (/^(?:\/|[a-z]:)/i.test(relative) || relative.split("/").some((segment) => !segment || segment === "." || segment === ".."))
    return
  return relative
}

function isTestCommand(command: string) {
  // Compound commands can hide an earlier failure behind a later successful exit.
  if (/[\r\n;&|<>`$]/.test(command)) return false
  return /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|(?:pytest|vitest|jest|playwright\s+test)\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|(?:go|cargo|dotnet)\s+test\b|node\s+--test\b|node\s+["']?[^\s"']*(?:[._/\\-](?:test|spec)|(?:test|spec)[._/\\-])[^\s"']*\.[cm]?js\b)/i.test(command)
}

function verificationStatus(tool: ToolPart, trace: ExecutionTrace, exit: number | undefined): VerificationStatus {
  if (trace.approval && executionToolKey(trace.approval.tool) === executionToolKey(tool)) return "approval"
  const status = executionToolStatus(tool)
  if (status === "interrupted") return "interrupted"
  if (status === "error") return "tool-error"
  if (tool.state.status === "completed") {
    if (tool.state.metadata?.timeout === true) return "timeout"
    if (exit === undefined) return "incomplete"
    return exit === 0 ? "passed" : "failed"
  }
  if (trace.status === "idle") return "incomplete"
  return status === "running" || status === "active" ? status : "pending"
}

function verificationWorkdir(workdir: unknown, directory: string | undefined, windows: boolean) {
  if (workdir === undefined) return
  if (typeof workdir !== "string" || !directory) return "workdir-unverified"
  if (workdir === "." || /^\.[\\/]+$/.test(workdir)) return
  const key = (value: string) => windows ? pathKey(value.replaceAll("\\", "/")).toLowerCase() : pathKey(value)
  const path = key(workdir)
  const root = key(directory)
  if (path === root) return
  // Input alone cannot establish the canonical target of a subdirectory, which
  // can resolve through a symlink or junction. The old receipt has no resolved cwd.
  const absolute = windows ? /^(?:[a-z]:\/|\/\/)/i.test(path) : path.startsWith("/")
  if (absolute && !path.startsWith(root.endsWith("/") ? root : root + "/")) return "outside-workspace"
  return "workdir-unverified"
}

export function projectExecutionEvidence(traces: readonly ExecutionTrace[], directory?: string): ExecutionEvidence {
  const files: FileEvidence[] = []
  const verifications: VerificationEvidence[] = []
  let missingFileEvidence = false
  for (const trace of traces) {
    const conditions = parseDevelopmentConditions(trace.prompt ?? "")
    const unmatched = new Set(conditions.commands)
    const windows = !!directory && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(directory)
    const allowed = conditions.files.map((file) => windows ? file.toLowerCase() : file)
    for (const step of trace.steps) {
      for (const tool of step.tools ?? []) {
        if (step.kind === "edit") {
          const changes = toolFiles(tool)
          if (tool.state.status === "completed" && changes.length === 0) missingFileEvidence = true
          for (const change of changes) {
            const path = workspacePath(change.file, directory, windows)
            if (allowed.length && !path) change.scope = "incomplete"
            else if (allowed.length && path && !allowed.some((scope) =>
              scope.endsWith("/") ? path.startsWith(scope) : path === scope,
            )) change.scope = "outside"
            files.push(change)
          }
        }
        const input = tool.state.input.command
        const command = typeof input === "string" ? input.trim() : ""
        const requested = conditions.commands.includes(command)
        if (!requested && !((step.kind === "command" && isTestCommand(command)) || tool.tool === "test" || tool.tool === "test_runner"))
          continue
        const workdir = verificationWorkdir(tool.state.input.workdir, directory, windows)
        if (requested && !workdir) unmatched.delete(command)
        const metadata = "metadata" in tool.state ? tool.state.metadata : undefined
        const exit = typeof metadata?.exit === "number" && Number.isSafeInteger(metadata.exit) ? metadata.exit : undefined
        const status = verificationStatus(tool, trace, exit)
        verifications.push({
          toolID: executionToolKey(tool),
          command: command || tool.tool,
          status: tool.state.status === "completed" && workdir ? workdir : status,
          exit,
          output: executionToolOutput(tool) ?? (tool.state.status === "error" ? tool.state.error : undefined),
        })
      }
      if (step.kind === "edit" && step.sections?.some((section) => section.kind === "detail")) missingFileEvidence = true
    }
    for (const command of unmatched) {
      verifications.push({ command, status: trace.status === "idle" ? "unexecuted" : "pending" })
    }
  }
  return { files, verifications, missingFileEvidence }
}
