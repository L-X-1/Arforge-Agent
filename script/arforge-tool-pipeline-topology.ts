import { readdir } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/arforge/src",
  "packages/plugin/src",
  "packages/sdk-next/src",
] as const

const CORE_BRIDGE = "packages/arforge/src/tool/core-bridge.ts"
const CORE_REGISTRY = "packages/core/src/tool/registry.ts"
const FORMAL_EXECUTION = "packages/arforge/src/session/execution-formal.ts"
const CORE_RUNNER = "packages/core/src/session/runner/llm.ts"
const SESSION_TOOLS = "packages/arforge/src/session/tools.ts"
const MATURE_TOOL_DECLARATION = "packages/arforge/src/tool/tool.ts"
const PLUGIN_TOOL_DECLARATION = "packages/plugin/src/tool.ts"
const PLUGIN_SOURCE_ADAPTER = "packages/arforge/src/tool/plugin-source-adapter.ts"
const DEBUG_AGENT = "packages/arforge/src/cli/cmd/debug/agent.handler.ts"
const DEBUG_EXPLICIT_APPROVAL = "packages/arforge/src/cli/cmd/debug/explicit-tool-approval.ts"

export type ToolPipelineTopologyFinding = {
  readonly code: "ATP-001" | "ATP-002" | "ATP-003"
  readonly path: string
  readonly line?: number
  readonly detail: string
}

export type ToolPipelineTopologySite = {
  readonly path: string
  readonly line: number
  readonly kind:
    | "core-definition"
    | "core-source-adapter"
    | "mature-definition"
    | "native-transport-adapter"
    | "sandbox-interpreter-adapter"
    | "provider-tool-transport-adapter"
    | "structured-output-adapter"
    | "mature-direct-execution"
    | "plugin-source-definition"
  readonly disposition: "canonical" | "definition" | "transport-only" | "transitional"
  readonly expression: string
}

export type ToolPipelineTopologyReport = {
  readonly schema_version: "1.0"
  /** No unknown or structurally invalid route was found. */
  readonly valid: boolean
  /** True only after every explicitly transitional execution route is gone. */
  readonly fully_canonical: boolean
  readonly counts: {
    readonly canonical: number
    readonly definitions: number
    readonly transport_only: number
    readonly transitional: number
  }
  readonly sites: readonly ToolPipelineTopologySite[]
  readonly findings: readonly ToolPipelineTopologyFinding[]
}

export type ToolPipelineTopologyOptions = {
  /** Fixture tests can focus on route classification without reproducing the whole application graph. */
  readonly enforceRequiredSeams?: boolean
}

const normalize = (value: string) => value.replaceAll("\\", "/")

const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

const expressionText = (source: ts.SourceFile, node: ts.Node) =>
  node
    .getText(source)
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*\.\s*/g, ".")

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
  if (!config.error) {
    return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options
  }
  return {
    allowJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  }
}

const importNames = (source: ts.SourceFile, moduleName: string, importedName: string) => {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== moduleName) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      if ((binding.propertyName?.text ?? binding.name.text) === importedName) names.add(binding.name.text)
    }
  }
  return names
}

const originKinds = (source: ts.SourceFile) => {
  const kinds = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "origin" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const kind = node.initializer.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === "kind",
      )
      if (kind && ts.isStringLiteral(kind.initializer)) kinds.add(kind.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return kinds
}

const requiredCallPosition = (
  calls: readonly {
    readonly path: string
    readonly callee: string
    readonly position: number
    readonly arguments: ReadonlyArray<string>
  }[],
  file: string,
  predicate: (callee: string) => boolean,
) => calls.find((call) => call.path === file && predicate(call.callee))?.position

export async function auditToolPipelineTopology(
  rootInput: string,
  options: ToolPipelineTopologyOptions = {},
): Promise<ToolPipelineTopologyReport> {
  const root = path.resolve(rootInput)
  const sourceFiles = await listSourceFiles(root)
  const program = ts.createProgram({ rootNames: sourceFiles, options: compilerOptions(root) })
  const checker = program.getTypeChecker()
  const findings: ToolPipelineTopologyFinding[] = []
  const sites: ToolPipelineTopologySite[] = []
  const calls: Array<{ path: string; callee: string; position: number; arguments: ReadonlyArray<string> }> = []
  const origins = new Map<string, ReadonlySet<string>>()

  const addFinding = (input: ToolPipelineTopologyFinding) => findings.push(input)
  const addSite = (input: ToolPipelineTopologySite) => sites.push(input)

  for (const file of sourceFiles) {
    const source = program.getSourceFile(file)
    if (!source) continue
    const relative = normalize(path.relative(root, file))
    const aiToolFactories = importNames(source, "ai", "tool")
    origins.set(relative, originKinds(source))

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = expressionText(source, node.expression)
        const line = lineOf(source, node)
        calls.push({
          path: relative,
          callee,
          position: node.getStart(source),
          arguments: node.arguments.map((argument) => expressionText(source, argument)),
        })

        if (callee === "Tool.make" || callee === "CoreTool.make") {
          if (relative.startsWith("packages/core/src/tool/") && callee === "Tool.make") {
            addSite({ path: relative, line, kind: "core-definition", disposition: "canonical", expression: callee })
          } else if (relative === CORE_BRIDGE && callee === "CoreTool.make") {
            addSite({
              path: relative,
              line,
              kind: "core-source-adapter",
              disposition: "canonical",
              expression: callee,
            })
          } else {
            addFinding({
              code: "ATP-001",
              path: relative,
              line,
              detail: `Core executable tool construction is not an audited canonical owner: ${callee}`,
            })
          }
        }

        if (callee === "Tool.define" || callee === "MatureTool.define") {
          if (relative.startsWith("packages/arforge/src/tool/")) {
            addSite({
              path: relative,
              line,
              kind: "mature-definition",
              disposition: "definition",
              expression: callee,
            })
          } else {
            addFinding({
              code: "ATP-001",
              path: relative,
              line,
              detail: `Mature tool definition was added outside its audited source boundary: ${callee}`,
            })
          }
        }

        if (callee === "NativeTool.make") {
          if (relative === "packages/arforge/src/session/llm/native-runtime.ts") {
            addSite({
              path: relative,
              line,
              kind: "native-transport-adapter",
              disposition: "transport-only",
              expression: callee,
            })
          } else {
            addFinding({
              code: "ATP-001",
              path: relative,
              line,
              detail: "NativeTool.make may only adapt the already-owned tool map at the provider wire boundary",
            })
          }
        }

        if (callee === "SandboxTool.make") {
          if (relative === "packages/arforge/src/tool/code-mode.ts") {
            addSite({
              path: relative,
              line,
              kind: "sandbox-interpreter-adapter",
              disposition: "transport-only",
              expression: callee,
            })
          } else {
            addFinding({
              code: "ATP-001",
              path: relative,
              line,
              detail: "SandboxTool.make may only project the CodeMode interpreter tree; it cannot own registration",
            })
          }
        }

        if (ts.isIdentifier(node.expression) && aiToolFactories.has(node.expression.text)) {
          if (relative === SESSION_TOOLS) {
            addSite({
              path: relative,
              line,
              kind: "provider-tool-transport-adapter",
              disposition: "transport-only",
              expression: callee,
            })
          } else if (relative === "packages/arforge/src/session/prompt.ts") {
            addSite({
              path: relative,
              line,
              kind: "structured-output-adapter",
              disposition: "transitional",
              expression: callee,
            })
          } else {
            addFinding({
              code: "ATP-001",
              path: relative,
              line,
              detail: "A new AI SDK executable tool factory bypasses the audited Core registration seam",
            })
          }
        }

        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "execute") {
          const receiver = node.expression.expression
          const receiverType = checker.getTypeAtLocation(receiver)
          const execute = receiverType.getProperty("execute")
          const declarationPaths = new Set(
            (execute?.declarations ?? []).map((declaration) =>
              normalize(path.relative(root, declaration.getSourceFile().fileName)),
            ),
          )
          const isMatureTool = declarationPaths.has(MATURE_TOOL_DECLARATION)
          const isPluginTool = declarationPaths.has(PLUGIN_TOOL_DECLARATION)
          let classified = false

          if (isMatureTool) {
            classified = true
            if (relative === CORE_BRIDGE) {
              addSite({
                path: relative,
                line,
                kind: "core-source-adapter",
                disposition: "canonical",
                expression: callee,
              })
            } else if (relative === SESSION_TOOLS || relative === "packages/arforge/src/session/prompt.ts") {
              addSite({
                path: relative,
                line,
                kind: "mature-direct-execution",
                disposition: "transitional",
                expression: callee,
              })
            } else {
              addFinding({
                code: "ATP-002",
                path: relative,
                line,
                detail: `Mature Tool.Def executes outside the Core adapter or an explicit migration site: ${callee}`,
              })
            }
          }

          if (isPluginTool) {
            classified = true
            if (relative === PLUGIN_SOURCE_ADAPTER) {
              addSite({
                path: relative,
                line,
                kind: "plugin-source-definition",
                disposition: "definition",
                expression: callee,
              })
            } else {
              addFinding({
                code: "ATP-002",
                path: relative,
                line,
                detail: `Plugin ToolDefinition executes outside the sole mature-to-Core source adapter: ${callee}`,
              })
            }
          }

          if (
            !classified &&
            relative === "packages/arforge/src/session/llm/native-runtime.ts" &&
            expressionText(source, receiver) === "item"
          ) {
            classified = true
            addSite({
              path: relative,
              line,
              kind: "native-transport-adapter",
              disposition: "transport-only",
              expression: callee,
            })
          }

          // Keep a syntactic fallback for incomplete fixture/module graphs.
          // The real repository uses declaration provenance above, so a renamed
          // receiver cannot evade this gate.
          if (
            !classified &&
            /^(?:item|tool|taskTool|read|def|definition)\.execute$/.test(callee) &&
            relative !== "packages/arforge/src/session/llm/native-runtime.ts"
          ) {
            addFinding({
              code: "ATP-002",
              path: relative,
              line,
              detail: `Unclassified direct tool-like execute call: ${callee}`,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  if (options.enforceRequiredSeams !== false) {
    const requireSeam = (ok: boolean, file: string, detail: string) => {
      if (!ok) addFinding({ code: "ATP-003", path: file, detail })
    }
    const bridgeMake = requiredCallPosition(calls, CORE_BRIDGE, (callee) => callee === "CoreTool.make")
    const bridgeSources = requiredCallPosition(calls, CORE_BRIDGE, (callee) => callee === "registry.tools")
    const formalRuns = calls.filter(
      (call) => call.path === FORMAL_EXECUTION && call.callee === "SessionRunner.Service.use",
    )
    const formalSnapshots = calls.filter(
      (call) =>
        call.path === FORMAL_EXECUTION &&
        call.callee === "Effect.provideService" &&
        call.arguments[0] === "SessionRunner.ExternalTools" &&
        call.arguments[1] === "toolBridge.snapshot",
    )
    const requestSnapshot = requiredCallPosition(calls, CORE_RUNNER, (callee) => callee === "externalSource")
    const requestMaterializations = calls.filter(
      (call) =>
        call.path === CORE_RUNNER &&
        call.callee === "tools.materialize" &&
        call.arguments.some((argument) => argument.includes("externalTools")),
    )
    const pipelineRun = requiredCallPosition(calls, CORE_REGISTRY, (callee) => callee === "runToolPipeline")
    const gatewayRun = requiredCallPosition(calls, CORE_REGISTRY, (callee) => callee.endsWith("gateway.execute"))
    const settleRun = requiredCallPosition(calls, CORE_REGISTRY, (callee) => callee === "settle")
    const sessionMaterialize = requiredCallPosition(calls, SESSION_TOOLS, (callee) =>
      callee.endsWith("coreRegistry.materialize"),
    )
    const sessionSettle = requiredCallPosition(calls, SESSION_TOOLS, (callee) => callee === "materialized.settle")
    const sessionStructuredOutput = calls.some(
      (call) =>
        call.path === SESSION_TOOLS &&
        call.callee.endsWith("coreRegistry.materialize") &&
        call.arguments.some((argument) => argument.includes("structuredOutput")),
    )
    const debugMaterialize = requiredCallPosition(calls, DEBUG_AGENT, (callee) =>
      callee.endsWith("registry.materialize"),
    )
    const debugDelegate = requiredCallPosition(calls, DEBUG_AGENT, (callee) => callee === "ExplicitToolApproval.settle")
    const debugSettle = requiredCallPosition(calls, DEBUG_EXPLICIT_APPROVAL, (callee) =>
      callee.endsWith("materialized.settle"),
    )
    const debugReply = requiredCallPosition(calls, DEBUG_EXPLICIT_APPROVAL, (callee) =>
      callee.endsWith("permissions.reply"),
    )

    requireSeam(bridgeMake !== undefined, CORE_BRIDGE, "Core bridge must construct the opaque Core Tool value")
    requireSeam(
      bridgeSources !== undefined,
      CORE_BRIDGE,
      "Core bridge must resolve the existing source directory for request-local canonical snapshots",
    )
    requireSeam(
      formalRuns.length >= 2 && formalSnapshots.length === formalRuns.length,
      FORMAL_EXECUTION,
      "Formal root and child executions must both provide the request-local external source resolver",
    )
    requireSeam(
      requestSnapshot !== undefined &&
        requestMaterializations.length >= 2 &&
        requestMaterializations.every((call) => requestSnapshot < call.position),
      CORE_RUNNER,
      "Normal and structured Provider requests must materialize the current external snapshot through Core",
    )
    requireSeam(
      pipelineRun !== undefined && gatewayRun !== undefined && settleRun !== undefined,
      CORE_REGISTRY,
      "Core ToolRegistry must retain Pipeline, ActionGateway and opaque settle in one owner",
    )
    requireSeam(
      sessionMaterialize !== undefined && sessionSettle !== undefined && sessionMaterialize < sessionSettle,
      SESSION_TOOLS,
      "Provider tool projection must materialize one Core snapshot and settle every invocation through it",
    )
    requireSeam(
      sessionStructuredOutput,
      SESSION_TOOLS,
      "StructuredOutput must be requested from the same Core materialization as every provider-visible tool",
    )
    requireSeam(
      debugMaterialize !== undefined && debugDelegate !== undefined && debugMaterialize < debugDelegate,
      DEBUG_AGENT,
      "Debug --tool must materialize one Core snapshot before delegating the explicit invocation",
    )
    requireSeam(
      debugSettle !== undefined && debugReply !== undefined,
      DEBUG_EXPLICIT_APPROVAL,
      "Debug --tool approval must settle through Core and reply only to a pending PermissionV2 request",
    )
    requireSeam(
      origins.get(PLUGIN_SOURCE_ADAPTER)?.has("plugin") === true,
      PLUGIN_SOURCE_ADAPTER,
      "Plugin definitions must carry source provenance before bridging",
    )
    requireSeam(
      origins.get("packages/arforge/src/mcp/tool-projection.ts")?.has("mcp") === true &&
        origins.get("packages/arforge/src/mcp/resource-projection.ts")?.has("mcp") === true,
      "packages/arforge/src/mcp",
      "MCP tools, prompts and resources must carry MCP source provenance before bridging",
    )
    requireSeam(
      origins.get("packages/arforge/src/tool/code-mode.ts")?.has("code-mode") === true,
      "packages/arforge/src/tool/code-mode.ts",
      "CodeMode must carry source provenance before bridging",
    )
  }

  sites.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind),
  )
  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.code.localeCompare(right.code),
  )
  const count = (disposition: ToolPipelineTopologySite["disposition"]) =>
    sites.filter((site) => site.disposition === disposition).length
  const valid = findings.length === 0
  const transitional = count("transitional")
  return {
    schema_version: "1.0",
    valid,
    fully_canonical: valid && transitional === 0,
    counts: {
      canonical: count("canonical"),
      definitions: count("definition"),
      transport_only: count("transport-only"),
      transitional,
    },
    sites,
    findings,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const report = await auditToolPipelineTopology(parseRoot(args))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.valid && (!args.includes("--require-canonical") || report.fully_canonical) ? 0 : 1)
}
