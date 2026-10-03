import { describe, expect, test } from "bun:test"
import { windowRecoveryCopy } from "./window-recovery-copy"

describe("window recovery copy", () => {
  test("provides actionable Simplified Chinese crash recovery text", () => {
    const copy = windowRecoveryCopy("zh-CN")
    expect(copy.terminated).toBe("Arforge 窗口意外终止")
    expect(copy.unresponsiveDetail).toContain("导出诊断日志")
    expect(copy.actions).toEqual({
      relaunch: "重新启动",
      export_logs: "导出日志",
      keep_waiting: "继续等待",
      quit: "退出 Arforge",
    })
  })

  test("keeps Traditional Chinese and English copy separate", () => {
    expect(windowRecoveryCopy("zh-TW").actions.export_logs).toBe("匯出日誌")
    expect(windowRecoveryCopy("en-US").actions.export_logs).toBe("Export Logs")
  })
})
