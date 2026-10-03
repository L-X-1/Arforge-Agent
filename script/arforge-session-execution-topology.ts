import { readdir } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

const SOURCE_ROOTS = ["packages/core/src", "packages/arforge/src"] as const
const SESSION_PROMPT = "packages/arforge/src/session/prompt.ts"
const FORMAL_EXECUTION = "packages/arforge/src/session/execution-formal.ts"
const HTTP_SESSION = "packages/arforge/src/server/routes/instance/httpapi/handlers/session.ts"
const WORKSPACE = "packages/arforge/src/control-plane/workspace.ts"
const LOCAL_EXECUTION = "packages/core/src/session/execution/local.ts"
const HTTP_SERVER = "packages/arforge/src/server/routes/instance/httpapi/server.ts"
const APP_RUNTIME = "packages/arforge/src/effect/app-runtime.ts"
const PROMPT_SCHEMA = "packages/schema/src/prompt.ts"
const FORMAL_RUNNER = "packages/core/src/session/runner/llm.ts"

export type SessionExecutionTopologyFinding = {
  readonly code: "ASE-001" | "ASE-002"
  readonly path: string
  readonly line?: number
  readonly detail: string
}

export type SessionExecutionTopologySite = {
  readonly path: string
  readonly line: number
  readonly service: "SessionPrompt" | "SessionExecution"
  readonly method: string
}

export type SessionExecutionTopologyReport = {
  readonly schema_version: "1.1"
  readonly valid: boolean
  readonly owner: "SessionExecution"
  readonly sites: ReadonlyArray<SessionExecutionTopologySite>
  readonly findings: ReadonlyArray<SessionExecutionTopologyFinding>
  readonly formal_default: FormalDefaultReadiness
}

export type FormalDefaultCheck = Readonly<{
  readonly id: "AFD-001" | "AFD-002" | "AFD-003" | "AFD-004" | "AFD-005"
  readonly ready: boolean
  readonly detail: string
}>

export type FormalDefaultReadiness = Readonly<{
  readonly ready: boolean
  readonly selected_owner: "formal" | "mature" | "conditional"
  readonly checks: ReadonlyArray<FormalDefaultCheck>
  readonly blockers: ReadonlyArray<FormalDefaultCheck>
}>

const normalize = (value: string) => value.replaceAll("\\", "/")

const listSourceFiles = async (root: string) => {
  const files: string[] = []
  const visit = async (directory: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) files.push(target)
    }
  }
  for (const sourceRoot of SOURCE_ROOTS) await visit(path.join(root, sourceRoot))
  return files.toSorted((left, right) => left.localeCompare(right))
}

const compilerOptions = (root: string): ts.CompilerOptions => {
  const configPath = path.join(root, "packages/arforge/tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (!config.error) return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options
  return {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  }
}

const declarationPaths = (root: string, symbol: ts.Symbol | undefined) =>
  new Set(
    (symbol?.declarations ?? []).map((declaration) =>
      normalize(path.relative(root, declaration.getSourceFile().fileName)),
    ),
  )

const allowedPromptCall = (site: SessionExecutionTopologySite) => {
  if (site.method === "loop" || site.method === "runLoop") return false
  if (site.method === "cancel") return site.path === SESSION_PROMPT
  if (site.method === "admit" || site.method === "admitCommand" || site.method === "latestAssistant")
    return site.path === HTTP_SESSION
  // `prompt` and `command` remain compatibility methods inside their defining
  // module, but no production consumer may invoke them as a service method.
  if (site.method === "prompt" || site.method === "command") return site.path === SESSION_PROMPT
  return true
}

export const directPromptBypassFindings = (
  sites: ReadonlyArray<SessionExecutionTopologySite>,
): SessionExecutionTopologyFinding[] =>
  sites.flatMap((site) =>
    site.service === "SessionPrompt" && !allowedPromptCall(site)
      ? [
          {
            code: "ASE-001" as const,
            path: site.path,
            line: site.line,
            detail: `SessionPrompt.${site.method} bypasses the sole SessionExecution production owner`,
          },
        ]
      : [],
  )

export const assessFormalDefaultReadiness = (input: {
  readonly execution: string
  readonly prompt: string
  readonly promptSchema: string
  readonly formalRunner: string
  readonly httpServer: string
  readonly appRuntime: string
}): FormalDefaultReadiness => {
  const conditionalOwner =
    input.execution.includes("options?.credentialIDs.length") && input.execution.includes("return drainScoped")
  const matureLoopReachable = input.execution.includes("prompt.loop(")
  const selected_owner = conditionalOwner ? "conditional" : matureLoopReachable ? "mature" : "formal"
  const checks: FormalDefaultCheck[] = [
    {
      id: "AFD-001",
      ready: input.prompt.includes("SessionInput.admit(database.db, events"),
      detail: "Mature HTTP admission must freeze the same message identity into canonical SessionInput.",
    },
    {
      id: "AFD-002",
      ready:
        input.prompt.includes("admitWithCommand(prepared.prompt") &&
        input.prompt.includes("name: prepared.command") &&
        input.prompt.includes("arguments: prepared.arguments"),
      detail: "Slash-command admission must preserve resolved text and original command identity.",
    },
    {
      id: "AFD-003",
      ready:
        input.promptSchema.includes("system: RequestSystem.pipe(optional)") &&
        input.prompt.includes("DurableRequestSystem.create(message.info.system)") &&
        input.formalRunner.includes("PromptSystem.layer({ messageID: latestUserMessage.id") &&
        !input.prompt.includes("session.input.admission.deferred"),
      detail: "Request-scoped custom system prompts need a canonical durable schema and Formal compiler owner.",
    },
    {
      id: "AFD-004",
      ready:
        input.promptSchema.includes("scheduledTasks: Schema.Array(ScheduledTask).pipe(optional)") &&
        input.prompt.includes("scheduledTasks.length > 0 ? { scheduledTasks }") &&
        input.formalRunner.includes("SessionRunner.executeScheduledTask") &&
        input.prompt.includes("const scheduledTaskTool = Effect.fn") &&
        input.execution.includes("prompt.scheduledTaskTool({") &&
        input.execution.includes("scheduledTaskTool") &&
        input.formalRunner.includes("scheduledTaskTool: input.runtime.tool") &&
        !input.prompt.includes("scheduledTaskCarrier") &&
        !input.prompt.includes("prepareScheduledSubtaskProjection") &&
        !input.formalRunner.includes("readonly carrier: TurnToolCarrier.ScheduledTask"),
      detail:
        "Automatic subtasks must use the canonical Prompt, Core task tool, ToolRegistry and ActionGateway without a retired carrier or Mature shadow projection.",
    },
    {
      id: "AFD-005",
      ready:
        selected_owner === "formal" &&
        input.httpServer.includes("SessionExecutionFormal.node") &&
        input.appRuntime.includes("SessionExecutionFormal.node") &&
        input.execution.includes("prompt.scheduledTaskTool({") &&
        !input.execution.includes("scheduledTaskCarrier") &&
        !input.httpServer.includes("SessionExecutionMature.node") &&
        !input.appRuntime.includes("SessionExecutionMature.node"),
      detail:
        "Every integrated product root must bind Formal by default with no credential/billing-dependent owner split.",
    },
  ]
  return {
    ready: checks.every((check) => check.ready),
    selected_owner,
    checks,
    blockers: checks.filter((check) => !check.ready),
  }
}

export async function auditSessionExecutionTopology(rootInput: string): Promise<SessionExecutionTopologyReport> {
  const root = path.resolve(rootInput)
  const files = await listSourceFiles(root)
  const program = ts.createProgram({ rootNames: files, options: compilerOptions(root) })
  const checker = program.getTypeChecker()
  const sites: SessionExecutionTopologySite[] = []
  const findings: SessionExecutionTopologyFinding[] = []

  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) continue
    const relative = normalize(path.relative(root, file))
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression
        const method = node.expression.name.text
        const property = checker.getTypeAtLocation(receiver).getProperty(method)
        const declarations = declarationPaths(root, property)
        const service = declarations.has(SESSION_PROMPT)
          ? "SessionPrompt"
          : declarations.has("packages/core/src/session/execution.ts")
            ? "SessionExecution"
            : undefined
        if (service) {
          const site: SessionExecutionTopologySite = {
            path: relative,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            service,
            method,
          }
          sites.push(site)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  findings.push(...directPromptBypassFindings(sites))

  const has = (service: SessionExecutionTopologySite["service"], method: string, file: string) =>
    sites.some((site) => site.service === service && site.method === method && site.path === file)
  const requireSeam = (ok: boolean, file: string, detail: string) => {
    if (!ok) findings.push({ code: "ASE-002", path: file, detail })
  }
  const sourceText = (relative: string) => program.getSourceFile(path.join(root, relative))?.getFullText() ?? ""

  const formalDefault = assessFormalDefaultReadiness({
    execution: sourceText(FORMAL_EXECUTION),
    prompt: sourceText(SESSION_PROMPT),
    promptSchema: sourceText(PROMPT_SCHEMA),
    formalRunner: sourceText(FORMAL_RUNNER),
    httpServer: sourceText(HTTP_SERVER),
    appRuntime: sourceText(APP_RUNTIME),
  })
  requireSeam(has("SessionPrompt", "admit", HTTP_SESSION), HTTP_SESSION, "HTTP prompt must persist before execution")
  requireSeam(
    has("SessionPrompt", "admitCommand", HTTP_SESSION),
    HTTP_SESSION,
    "HTTP commands must persist before execution",
  )
  requireSeam(
    has("SessionExecution", "wakeAndWait", HTTP_SESSION),
    HTTP_SESSION,
    "Synchronous HTTP work must wait on the execution generation that owns it",
  )
  requireSeam(
    has("SessionExecution", "interrupt", HTTP_SESSION),
    HTTP_SESSION,
    "HTTP abort must interrupt SessionExecution instead of SessionPrompt directly",
  )
  requireSeam(
    has("SessionExecution", "interrupt", WORKSPACE),
    WORKSPACE,
    "Workspace handoff must interrupt the same SessionExecution owner",
  )

  // Execution may wrap the coordinator delegate with a durable
  // Database provider before exposing it to callers. Verify the semantic
  // delegation instead of requiring a property-assignment spelling that would
  // reject that context-preserving wrapper.
  const exposesWakeAndWait = (source: string) =>
    source.includes("wakeAndWait: coordinator.wakeAndWait") || source.includes("coordinator.wakeAndWait(")
  requireSeam(
    exposesWakeAndWait(sourceText(LOCAL_EXECUTION)),
    LOCAL_EXECUTION,
    "Core local SessionExecution must expose the same coordinator barrier",
  )
  requireSeam(
    exposesWakeAndWait(sourceText(FORMAL_EXECUTION)),
    FORMAL_EXECUTION,
    "Formal product SessionExecution must expose the same coordinator barrier",
  )
  requireSeam(
    sourceText(HTTP_SERVER).includes("[SessionExecution.node, SessionExecutionFormal.node]"),
    HTTP_SERVER,
    "The HTTP production graph must bind the single Formal SessionExecution service",
  )
  requireSeam(
    sourceText(APP_RUNTIME).includes("[SessionExecution.node, SessionExecutionFormal.node]"),
    APP_RUNTIME,
    "The default application runtime must bind the same Formal SessionExecution owner",
  )

  sites.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.code.localeCompare(right.code),
  )
  return {
    schema_version: "1.1",
    valid: findings.length === 0,
    owner: "SessionExecution",
    sites,
    findings,
    formal_default: formalDefault,
  }
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root")
  const root = rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1]! : process.cwd()
  const report = await auditSessionExecutionTopology(root)
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.valid ? 0 : 1)
}
