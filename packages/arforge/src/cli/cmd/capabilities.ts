import { AgentPython } from "@arforge-ai/core/agent-python"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { Effect, Schema } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

const productRoot = resolve(import.meta.dir, "../../../../..")
const decodeHealth = Schema.decodeUnknownEffect(AgentCapability.Health)
const decodeList = Schema.decodeUnknownEffect(AgentCapability.List)

export const CapabilitiesCommand = effectCmd({
  command: "capabilities [workspace]",
  describe: "查看通过共享 Core 接入的 Arforge Agent 特色能力",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("workspace", {
        describe: "要检查的工作区，默认为当前目录",
        type: "string",
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      })
      .option("all", {
        describe: "显示能力说明、类别和优先级",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.capabilities")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const result = yield* Effect.gen(function* () {
      const bridge = yield* AgentPython.Service
      const health = yield* bridge.call("health").pipe(Effect.flatMap(decodeHealth))
      const capabilities = yield* bridge.call("capabilities.list").pipe(Effect.flatMap(decodeList))
      if (capabilities.count !== capabilities.items.length) {
        return yield* fail("Agent 能力清单计数与内容不一致。")
      }
      return { workspace, health, capabilities }
    }).pipe(
      Effect.provide(
        AgentPython.layer({
          runtimeRoot: process.env.ARFORGE_AGENT_RUNTIME_ROOT || productRoot,
          workspace,
          pythonExecutable: process.env.ARFORGE_AGENT_PYTHON || undefined,
          home: process.env.ARFORGE_HOME || undefined,
        }),
      ),
      Effect.scoped,
      Effect.catch((error) =>
        fail(error instanceof Error ? `无法读取 Arforge Agent 能力：${error.message}` : "无法读取 Arforge Agent 能力。"),
      ),
    )

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    const enabled = result.capabilities.items.filter((item) => item.enabled)
    process.stdout.write(
      `${result.health.brand} ${result.health.version} · Python ${result.health.python} · ${enabled.length}/${result.capabilities.count} 项能力已启用${EOL}`,
    )
    process.stdout.write(`工作区：${result.workspace}${EOL}`)
    for (const item of enabled) {
      process.stdout.write(
        args.all
          ? `- ${item.name} [${item.kind}, P${item.priority}] — ${item.description}${EOL}`
          : `- ${item.name}${EOL}`,
      )
    }
  }),
})
