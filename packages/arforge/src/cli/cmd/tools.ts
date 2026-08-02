import { Permission } from "../../permission"
import { Agent } from "../../agent/agent"
import { Provider } from "../../provider/provider"
import { ToolRegistry } from "../../tool/registry"
import { Effect } from "effect"
import { EOL } from "node:os"
import { effectCmd, fail } from "../effect-cmd"

export const ToolsCommand = effectCmd({
  command: "tools",
  describe: "列出当前代理实际可见的统一工具目录",
  builder: (yargs) =>
    yargs
      .option("agent", {
        type: "string",
        describe: "按指定代理的权限计算工具目录",
      })
      .option("verbose", {
        alias: "V",
        type: "boolean",
        default: false,
        describe: "显示说明和参数 JSON Schema",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const agentService = yield* Agent.Service
      const agents = yield* agentService.list()
      const selected = args.agent
        ? yield* agentService.get(args.agent)
        : (agents.find((item) => item.name === "build") ??
          agents.find((item) => item.mode !== "subagent") ??
          agents[0])
      const agent =
        selected ?? (yield* fail(args.agent ? `找不到代理：${args.agent}` : "当前没有可用代理。"))

      const model = agent.model ?? (yield* Provider.Service.use((service) => service.defaultModel()))
      const tools = yield* ToolRegistry.Service.use((registry) => registry.tools({ ...model, agent }))
      const disabled = Permission.disabled(
        tools.map((tool) => tool.id),
        agent.permission,
      )
      const items = tools
        .map((tool) => ({
          id: tool.id,
          enabled: !disabled.has(tool.id),
          description: tool.description,
          ...(args.verbose ? { parameters: tool.jsonSchema ?? {} } : {}),
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id))
      const report = {
        schemaVersion: 1,
        agent: agent.name,
        provider: model.providerID,
        model: model.modelID,
        count: items.length,
        enabled: items.filter((item) => item.enabled).length,
        items,
      }

      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      } else {
        process.stdout.write(
          `${report.count} 个工具 · ${report.enabled} 个已启用 · 代理 ${report.agent} · ${report.provider}/${report.model}${EOL}`,
        )
        for (const item of items) {
          process.stdout.write(
            `${item.enabled ? "✓" : "○"} ${item.id}${args.verbose ? ` — ${item.description}` : ""}${EOL}`,
          )
          if (args.verbose && "parameters" in item) {
            process.stdout.write(JSON.stringify(item.parameters, null, 2) + EOL)
          }
        }
      }
    }).pipe(
      Effect.withSpan("Cli.tools"),
      Effect.catch((error) =>
        fail(error instanceof Error ? `无法读取工具目录：${error.message}` : "无法读取工具目录。"),
      ),
    ),
})
