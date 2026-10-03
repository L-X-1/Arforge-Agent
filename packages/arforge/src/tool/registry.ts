import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { httpClient } from "@arforge-ai/core/effect/app-node-platform"
import { Ripgrep } from "@arforge-ai/core/ripgrep"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { Database } from "@arforge-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@arforge-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { ModelV2 } from "@arforge-ai/core/model"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { McpCatalog } from "@/mcp/catalog"
import { safeCapabilityKey } from "@/mcp/capability-registry"
import { McpToolProjection } from "@/mcp/tool-projection"
import { McpResourceProjection } from "@/mcp/resource-projection"
import { SandboxRunner } from "@/sandbox/runner"
import { PluginToolSource } from "./plugin-source-adapter"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderV2.ID.arforge || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export function partitionCustomTools<T extends { readonly id: string }>(
  custom: ReadonlyArray<T>,
  builtin: ReadonlyArray<{ readonly id: string }>,
) {
  const reserved = new Set(builtin.map((tool) => tool.id))
  const accepted: T[] = []
  const rejected: T[] = []
  const claimed = new Set<string>()
  for (const tool of custom) {
    if (reserved.has(tool.id) || claimed.has(tool.id)) {
      rejected.push(tool)
      continue
    }
    claimed.add(tool.id)
    accepted.push(tool)
  }
  return { accepted, rejected }
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const mcp = yield* MCP.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const codeMode = flags.experimentalCodeMode ? yield* Effect.promise(() => import("./code-mode")) : undefined
    const codeModeTool = codeMode ? yield* codeMode.CodeModeTool : undefined

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries(mod)) {
            if (!PluginToolSource.isDefinition(def)) continue
            custom.push(
              PluginToolSource.make(id === "default" ? namespace : `${namespace}_${id}`, def, {
                instance: ctx,
                agents,
                truncate,
              }),
            )
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(PluginToolSource.make(id, def, { instance: ctx, agents, truncate }))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          ...(codeModeTool ? { execute: Tool.init(codeModeTool) } : {}),
        })

        const builtin = [
          tool.invalid,
          ...(questionEnabled ? [tool.question] : []),
          tool.shell,
          tool.read,
          tool.glob,
          tool.grep,
          tool.edit,
          tool.write,
          tool.task,
          tool.fetch,
          tool.todo,
          tool.search,
          tool.skill,
          tool.patch,
          ...(tool.execute ? [tool.execute] : []),
          ...(flags.experimentalLspTool ? [tool.lsp] : []),
          ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
        ]
        const partitioned = partitionCustomTools(custom, builtin)
        for (const rejected of partitioned.rejected) {
          yield* Effect.logWarning("Ignoring conflicting third-party tool name", {
            tool: rejected.id,
            reason: builtin.some((item) => item.id === rejected.id)
              ? "reserved by a built-in tool"
              : "already claimed by another third-party tool",
          })
        }

        return {
          custom: partitioned.accepted,
          builtin,
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const describeCodeMode = Effect.fn("ToolRegistry.describeCodeMode")(function* (input: {
      agent: Agent.Info
      permission?: PermissionV1.Ruleset
    }) {
      if (!codeMode) return
      const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
      const tools = Permission.visibleTools(yield* mcp.tools(), ruleset)
      if (Object.keys(tools).length === 0) return
      return codeMode.describeCatalog(tools, Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize))
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      const mcpDefinitions = flags.experimentalCodeMode
        ? []
        : yield* Effect.gen(function* () {
            const mcpTools = yield* mcp.tools()
            // Compatibility mocks and transitional providers may expose only
            // tools; the production MCP service always supplies all catalogs.
            const mcpPrompts = mcp.prompts ? yield* mcp.prompts() : {}
            const mcpResources = mcp.resources ? yield* mcp.resources() : {}
            const mcpResourceTemplates = mcp.resourceTemplates ? yield* mcp.resourceTemplates() : {}
            if (
              Object.keys(mcpTools).length === 0 &&
              Object.keys(mcpPrompts).length === 0 &&
              Object.keys(mcpResources).length === 0 &&
              Object.keys(mcpResourceTemplates).length === 0
            )
              return [] as Tool.Def[]
            const clientNames = Object.keys(yield* mcp.clients())
            const existing = new Set(filtered.map((tool) => tool.id))
            const projected: Tool.Def[] = []

            const add = (tool: Tool.Def) => {
              if (existing.has(tool.id)) {
                return
              }
              existing.add(tool.id)
              projected.push(tool)
            }

            for (const [key, entry] of Object.entries(mcpTools).sort(([a], [b]) => a.localeCompare(b))) {
              if (existing.has(key)) {
                yield* Effect.logWarning("Ignoring MCP tool with a conflicting native tool name", {
                  tool: key,
                  reason: "native ToolRegistry entry already owns the name",
                })
                continue
              }
              const server = McpCatalog.serverForToolKey(key, clientNames)
              projected.push(
                McpToolProjection.make({
                  key,
                  server,
                  entry,
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
              existing.add(key)
            }

            const promptEntries = Object.entries(mcpPrompts).sort(([a], [b]) => a.localeCompare(b))
            for (const [capabilityID, entry] of promptEntries) {
              const key = McpCatalog.nativeCapabilityName("prompt", entry.client, entry.name)
              add(
                McpResourceProjection.makePrompt({
                  key,
                  capabilityID,
                  server: entry.client,
                  generation: entry.generation,
                  entry,
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            }

            const resourceEntries = Object.entries(mcpResources).sort(([a], [b]) => a.localeCompare(b))
            for (const [, entry] of resourceEntries) {
              const key = McpCatalog.nativeCapabilityName("resource", entry.client, entry.uri)
              add(
                McpResourceProjection.makeResource({
                  key,
                  // Public catalog keys preserve the provider URI for display,
                  // while the registry identity is redacted and canonicalized
                  // (including query/fragment removal).  Recompute that
                  // identity at the projection boundary so a URI containing
                  // credentials cannot make the tool carry a different ID
                  // from the generation lease that readResource validates.
                  capabilityID: safeCapabilityKey(entry.client, entry.uri),
                  server: entry.client,
                  generation: entry.generation,
                  entry,
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            }

            const templateEntries = Object.entries(mcpResourceTemplates).sort(([a], [b]) => a.localeCompare(b))
            for (const [, entry] of templateEntries) {
              const key = McpCatalog.nativeCapabilityName("resource_template", entry.client, entry.uriTemplate)
              add(
                McpResourceProjection.makeResourceTemplate({
                  key,
                  capabilityID: safeCapabilityKey(entry.client, entry.uriTemplate),
                  server: entry.client,
                  generation: entry.generation,
                  entry,
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            }

            if (Object.keys(mcpPrompts).length > 0)
              add(
                McpResourceProjection.makePromptList({
                  key: "list_mcp_prompts",
                  server: "mcp",
                  kind: "prompt",
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            if (Object.keys(mcpResources).length > 0)
              add(
                McpResourceProjection.makeResourceRead({
                  key: "read_mcp_resource",
                  server: "mcp",
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            if (Object.keys(mcpResources).length > 0)
              add(
                McpResourceProjection.makeResourceList({
                  key: "list_mcp_resources",
                  server: "mcp",
                  kind: "resource",
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            if (Object.keys(mcpResourceTemplates).length > 0)
              add(
                McpResourceProjection.makeResourceTemplateList({
                  key: "list_mcp_resource_templates",
                  server: "mcp",
                  kind: "resource_template",
                  mcp,
                  plugin,
                  agents,
                  truncate,
                }),
              )
            return projected
          })

      const codeModeDescription = filtered.some((tool) => tool.id === "execute")
        ? yield* describeCodeMode(input)
        : undefined
      const visible = [...filtered, ...mcpDefinitions].filter((tool) => tool.id !== "execute" || codeModeDescription)

      return yield* Effect.forEach(
        visible,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === "execute" ? codeModeDescription : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            origin: tool.origin,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Config.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    Skill.node,
    Session.node,
    BackgroundJob.node,
    Provider.node,
    LSP.node,
    Instruction.node,
    FSUtil.node,
    EventV2Bridge.node,
    httpClient,
    CrossSpawnSpawner.node,
    Format.node,
    Truncate.node,
    RuntimeFlags.node,
    SandboxRunner.node,
    MCP.node,
    Database.node,
    SubagentChildExecutor.node,
    Ripgrep.node,
  ],
})

export * as ToolRegistry from "./registry"
