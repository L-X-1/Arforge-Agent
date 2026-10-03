import { Global } from "@arforge-ai/core/global"
import { EOL } from "node:os"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { privacyAudit } from "./private-operations"

interface PrivacyArgs {
  readonly json: boolean
}

/** Metadata-only privacy overview shared by Python compatibility entrypoints. */
export const PrivacyCommand = cmd<{}, PrivacyArgs>({
  command: "privacy",
  describe: "显示隐私摘要和同意状态（只读）",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      type: "boolean",
      default: false,
      describe: "输出机器可读 JSON",
    }),
  async handler(args) {
    const report = await privacyAudit(Global.Path.data)
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }
    process.stdout.write(`隐私摘要：本地优先${EOL}`)
    process.stdout.write(`私人目录：${report.arforgeHome}${EOL}`)
    process.stdout.write(`目录状态：${report.arforgeHomeExists ? "存在" : "尚未创建"}${EOL}`)
    process.stdout.write(`网络使用：${report.networkUse}${EOL}`)
    process.stdout.write(`隐私同意：${report.consentRecorded ? "已记录" : "未记录"}${EOL}`)
    process.stdout.write(
      `文件：${report.inventory.files} 个，${report.inventory.bytes} 字节；凭据文件：${report.inventory.credentialsPresent ? "存在" : "未发现"}${EOL}`,
    )
    process.stdout.write(`日志：${report.inventory.logsBytes} 字节；备份：${report.inventory.backups} 个${EOL}`)
  },
})
