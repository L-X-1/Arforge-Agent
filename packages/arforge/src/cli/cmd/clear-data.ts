import { Global } from "@arforge-ai/core/global"
import { EOL } from "node:os"
import path from "node:path"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import {
  createClearDataPlan,
  executeClearDataPlan,
  type ClearDataScope,
} from "./clear-data-operations"

interface ClearDataArgs {
  readonly workspace?: string
  readonly scope: ClearDataScope
  readonly execute?: string
  readonly confirm?: string
  readonly "backup-directory"?: string
  readonly "postgres-bin"?: string
  readonly "key-file"?: string
  readonly json: boolean
}

const productRoot = path.resolve(import.meta.dir, "../../../../..")

export const ClearDataCommand = cmd<{}, ClearDataArgs>({
  command: "clear-data [workspace]",
  describe: "先盘点并加密备份，再用一次性短语清理私人 PostgreSQL 数据",
  builder: (yargs: Argv) =>
    yargs
      .positional("workspace", {
        type: "string",
        describe: "workspace 范围的绝对路径；默认为当前目录",
      })
      .option("scope", {
        type: "string",
        choices: ["workspace", "all"] as const,
        default: "workspace" as const,
        describe: "清理当前工作区，或清理全部业务数据",
      })
      .option("execute", {
        type: "string",
        describe: "执行已生成的计划 ID；省略时只生成清单和加密备份",
      })
      .option("confirm", {
        type: "string",
        describe: "计划阶段显示的一次性确认短语",
      })
      .option("backup-directory", {
        type: "string",
        describe: "加密 PostgreSQL 备份目录",
      })
      .option("postgres-bin", {
        type: "string",
        describe: "PostgreSQL 客户端工具目录",
      })
      .option("key-file", {
        type: "string",
        describe: "DPAPI 保护的备份密钥文件",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  async handler(args) {
    const databaseUrl = process.env.ARFORGE_DB_URL?.trim()
    if (!databaseUrl) throw new Error("clear-data 需要 ARFORGE_DB_URL")
    const planDirectory = path.join(Global.Path.state, "clear-data-plans")
    const postgresBin = args["postgres-bin"] || process.env.ARFORGE_POSTGRES_BIN

    if (args.execute) {
      if (!args.confirm) throw new Error("--execute 必须同时提供 --confirm 一次性短语")
      const completed = await executeClearDataPlan({
        planID: args.execute,
        confirmation: args.confirm,
        databaseUrl,
        adminDatabaseUrl: process.env.ARFORGE_DB_ADMIN_URL?.trim(),
        planDirectory,
        postgresBin,
      })
      if (args.json) {
        process.stdout.write(JSON.stringify(completed, null, 2) + EOL)
      } else {
        process.stdout.write(`清理完成：${completed.scope} · ${completed.inventory.total} 条盘点记录${EOL}`)
        process.stdout.write(`计划：${completed.id}${EOL}`)
        process.stdout.write(`加密备份：${completed.backup.backup}${EOL}`)
      }
      return
    }

    const result = await createClearDataPlan({
      scope: args.scope,
      workspace: args.workspace,
      databaseUrl,
      adminDatabaseUrl: process.env.ARFORGE_DB_ADMIN_URL?.trim(),
      planDirectory,
      backupDirectory: args["backup-directory"],
      postgresBin,
      keyFile: args["key-file"],
      backupScript: path.join(productRoot, "script", "postgres-backup.ps1"),
    })
    const output = {
      ...result.plan,
      confirmationPhrase: result.confirmationPhrase,
      executeCommand: `arforge clear-data --execute ${result.plan.id} --confirm "${result.confirmationPhrase}"`,
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(output, null, 2) + EOL)
      return
    }
    process.stdout.write(`清理计划已生成（15 分钟有效，尚未删除数据）${EOL}`)
    process.stdout.write(`范围：${result.plan.scope}${result.plan.workspace ? ` · ${result.plan.workspace}` : ""}${EOL}`)
    process.stdout.write(`盘点：${result.plan.inventory.total} 条记录${EOL}`)
    for (const [table, count] of Object.entries(result.plan.inventory.records)) {
      process.stdout.write(`- ${table}: ${count}${EOL}`)
    }
    process.stdout.write(`加密备份：${result.plan.backup.backup}${EOL}`)
    process.stdout.write(`计划 ID：${result.plan.id}${EOL}`)
    process.stdout.write(`一次性短语：${result.confirmationPhrase}${EOL}`)
    process.stdout.write(`确认执行：${output.executeCommand}${EOL}`)
  },
})
