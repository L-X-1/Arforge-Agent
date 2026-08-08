import { CAPABILITY_CATALOG, nativeHealth } from "@arforge-ai/core/capability-catalog"
import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd } from "../effect-cmd"

export const CapabilitiesCommand = effectCmd({
  command: "capabilities [workspace]",
  describe: "查看 Arforge Agent 特色能力目录",
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
    const health = nativeHealth()
    const capabilities = {
      count: CAPABILITY_CATALOG.length,
      items: CAPABILITY_CATALOG,
    }
    const result = { workspace, health, capabilities }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    const enabled = result.capabilities.items.filter((item) => item.enabled)
    process.stdout.write(
      `${result.health.brand} ${result.health.version} · 原生 TS 运行时 · ${enabled.length}/${result.capabilities.count} 项能力已启用${EOL}`,
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
