import { describe, expect, test } from "bun:test"
import { attentionAction, attentionDetail, attentionTitle } from "./personal-workspace-attention"

describe("personal workspace recovery guidance", () => {
  test("routes recovery-required attention to an actionable runtime view", () => {
    expect(attentionAction("recovery_required", "zh")).toEqual({
      target: "arforge-runtime",
      label: "查看恢复详情",
    })
    expect(attentionAction("recovery_required", "en")?.label).toBe("View recovery details")
    expect(attentionAction("pending_approval", "zh")).toEqual({
      target: "session-automation",
      label: "审查后台任务",
    })
    expect(attentionAction("pending_approval", "zh", "run")).toEqual({
      target: "arforge-runtime",
      label: "查看待授权执行",
    })
    expect(attentionTitle("pending_approval", "Run", "zh", "run")).toBe("执行等待授权")
    expect(attentionDetail("pending_approval", "fallback", "zh", "run")).toContain("授权前不会继续")
    expect(attentionAction("pending_approval", "zh", "run", true)).toEqual({
      target: "arforge-runtime",
      label: "查看待授权执行",
    })
    expect(attentionAction("recovery_required", "zh", "run", true)).toEqual({
      target: "arforge-runtime",
      label: "查看恢复详情",
    })
    expect(attentionAction("artifact_ready", "zh")).toEqual({
      target: "session-automation",
      label: "审查成果",
    })
    expect(attentionAction("artifact_ready", "zh", "personal_job", true)).toEqual({
      target: "session-automation",
      label: "打开所属会话",
    })
    expect(attentionAction("memory_candidate", "zht")?.label).toBe("查看候選資訊")
    expect(attentionAction("cost_review", "en")?.target).toBe("#personal-workspace-cost")
    expect(attentionAction("future_attention", "zh")).toBeUndefined()
  })

  test("localizes backend attention details without leaking mixed-language copy", () => {
    expect(attentionDetail("recovery_required", "Run 需要恢复或人工检查。", "zh")).toBe(
      "上次执行未正常完成。请先查看恢复详情，确认当前状态后再继续。",
    )
    expect(attentionDetail("recovery_required", "Run 需要恢复或人工检查。", "en")).toBe(
      "The previous run did not finish normally. Review its recovery details before continuing.",
    )
    expect(attentionDetail("future_attention", "Preserved fallback", "en")).toBe("Preserved fallback")
  })
})
