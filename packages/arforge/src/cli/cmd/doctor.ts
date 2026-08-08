import { Database } from "@arforge-ai/core/database/database"
import { usesPostgres } from "@arforge-ai/core/database/dialect"
import { nativeHealth } from "@arforge-ai/core/capability-catalog"
import { Global } from "@arforge-ai/core/global"
import { InstallationVersion } from "@arforge-ai/core/installation/version"
import { Effect, Schema } from "effect"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import type { Argv } from "yargs"
import { effectCmd } from "../effect-cmd"

interface DoctorCheck {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

const productRoot = path.resolve(import.meta.dir, "../../../../..")

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\b(postgresql|postgres|mysql):\/\/[^\s]+/gi, "$1://[REDACTED]")
    .replace(/\b(password|passwd|pwd|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500)
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "")
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved
  }
  return normalize(left) === normalize(right)
}

async function storageCheck() {
  const directories = [Global.Path.data, Global.Path.config, Global.Path.state, Global.Path.cache, Global.Path.log]
  await Promise.all(
    directories.map(async (directory) => {
      await fs.mkdir(directory, { recursive: true })
      await fs.access(directory, constants.R_OK | constants.W_OK)
    }),
  )
  return `${directories.length} 个私人数据目录可读写`
}

export const DoctorCommand = effectCmd({
  command: ["doctor [workspace]", "status [workspace]"],
  describe: "检查统一运行时、PostgreSQL、私人目录和 Agent 能力引擎",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("workspace", {
        type: "string",
        describe: "要检查的工作区，默认为当前目录",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      })
      .option("require-postgres", {
        type: "boolean",
        default: true,
        describe: "把未启用 PostgreSQL 视为失败",
      }),
  handler: Effect.fn("Cli.doctor")(function* (rawArgs) {
    const args = rawArgs
    const workspace = path.resolve(args.workspace ?? process.cwd())
    const runtimeRoot = path.resolve(process.env.ARFORGE_AGENT_RUNTIME_ROOT || productRoot)
    const checks: DoctorCheck[] = []

    checks.push({
      id: "runtime",
      label: "统一运行时",
      ok: samePath(runtimeRoot, productRoot),
      detail: samePath(runtimeRoot, productRoot)
        ? `Arforge ${InstallationVersion} · Bun ${Bun.version}`
        : "Agent 运行时指向当前产品目录之外",
    })

    const workspaceExists = yield* Effect.promise(() =>
      fs
        .stat(workspace)
        .then((item) => item.isDirectory())
        .catch(() => false),
    )
    checks.push({
      id: "workspace",
      label: "工作区",
      ok: workspaceExists,
      detail: workspaceExists ? workspace : "工作区不存在或不是目录",
    })

    const storage = yield* Effect.promise(() =>
      storageCheck().then(
        (detail) => ({ ok: true, detail }),
        (error) => ({ ok: false, detail: safeMessage(error) }),
      ),
    )
    checks.push({ id: "storage", label: "私人目录", ...storage })

    // Acquiring Database.Service is itself a real connectivity/schema check:
    // the PostgreSQL layer opens the pool and inspects/applies its migration
    // ledger before exposing the service.
    yield* Database.Service
    const database = {
      ok: !args["require-postgres"] || usesPostgres,
      detail:
        args["require-postgres"] && !usesPostgres
          ? "当前回退到 SQLite；私人产品要求 PostgreSQL"
          : `${usesPostgres ? "PostgreSQL" : "SQLite"} 连接与 Schema 检查正常`,
    }
    checks.push({ id: "database", label: "数据库", ...database })

    const health = nativeHealth()
    const bridge = {
      ok: health.status === "ok" && health.brand.startsWith("Arforge"),
      detail: health.status === "ok" ? `Arforge Agent ${health.version}（原生 TS）` : "Agent 健康响应不符合契约",
    }
    checks.push({ id: "agent-bridge", label: "Agent 能力引擎", ...bridge })

    const passed = checks.filter((item) => item.ok).length
    const report = {
      schemaVersion: 1,
      product: "Arforge",
      version: InstallationVersion,
      workspace,
      database: usesPostgres ? "postgresql" : "sqlite",
      passed,
      failed: checks.length - passed,
      ok: passed === checks.length,
      checks,
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
    } else {
      process.stdout.write(`Arforge Doctor · ${passed}/${checks.length} 项通过${EOL}`)
      for (const item of checks) {
        process.stdout.write(`${item.ok ? "✓" : "✗"} ${item.label}：${item.detail}${EOL}`)
      }
    }
    if (!report.ok) process.exitCode = 1
  }),
})
