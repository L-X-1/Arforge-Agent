import { describe, expect, test } from "bun:test"
import { attentionAction, attentionDetail, attentionTitle } from "./personal-workspace-attention"
import {
  personalJobApprovalLabel,
  childReceiptPresentation,
  riskTierLabel,
  runAuthorityLabel,
  runInitiatorLabel,
  statusLabel,
  visibilityLabel,
  workspaceCopy,
} from "./personal-workspace-presentation"

describe("personal workspace presentation", () => {
  test("explains receipt gaps without promising delivery or rerunning the task", () => {
    expect(childReceiptPresentation("missing", "zh").label).toBe("执行已结束，结果尚未确认")
    expect(childReceiptPresentation("missing", "zh").detail).toContain("不要为获取结果而重复执行任务")
    expect(childReceiptPresentation("missing", "zht").detail).toContain("可開啟會話檢查")
    expect(childReceiptPresentation("present", "zh").detail).toContain("不代表交付验收通过")
    expect(childReceiptPresentation("not-required", "zh").detail).toContain("取消不是成功交付")
    expect(childReceiptPresentation("pending", "en").label).toBe("Awaiting execution outcome")
    for (const value of [undefined, "future-state"])
      expect(childReceiptPresentation(value, "zh").label).toBe("结果状态未知")
    expect(childReceiptPresentation(undefined, "ko").label).toBe("Result status unknown")
  })

  test("uses user-facing Chinese terminology for operational states", () => {
    expect(statusLabel("needs_human", "zh")).toBe("需要人工处理")
    expect(statusLabel("system_automatic", "zh")).toBe("系统自动")
    expect(statusLabel("human_visible", "zht")).toBe("使用者可見")
    expect(statusLabel("memory_candidate", "zh")).toBe("等待审查")
    expect(statusLabel("completed", "ko")).toBe("Completed")
    expect(statusLabel("awaiting_authorization", "zh")).toBe("等待授权")
    expect(statusLabel("awaiting_approval", "zht")).toBe("等待批准")
    expect(statusLabel("in_progress", "zh")).toBe("进行中")
    expect(statusLabel("cancelled", "zh")).toBe("已取消")
    expect(statusLabel("artifact_ready", "zh")).toBe("成果可审查")
  })

  test("localizes workspace job and run metadata instead of exposing enums", () => {
    expect(visibilityLabel("background", "en")).toBe("Background automatic")
    expect(personalJobApprovalLabel("pending", "zh")).toBe("等待批准")
    expect(runInitiatorLabel("schedule", "zht")).toBe("排程任務")
    expect(runAuthorityLabel("scoped_grant", "zh")).toBe("范围授权")
    expect(riskTierLabel("L2", "en")).toBe("Risk L2")
  })

  test("keeps attention guidance in the selected language", () => {
    expect(attentionTitle("pending_approval", "fallback", "ko")).toBe("Automatic job review")
    expect(attentionDetail("recovery_required", "fallback", "de")).toContain("previous run")
    expect(attentionAction("cost_review", "fr")?.label).toBe("View cost summary")
  })

  test("explains the safe projection without exposing implementation jargon", () => {
    const copy = workspaceCopy("zh")
    expect(copy.title).toBe("个人工作区")
    expect(copy.safety).toContain("安全摘要")
    expect(copy.safetyNote).toContain("独立的管理授权")
    expect(copy.blockers).toBe("未解决阻塞")
    expect(copy.openSession).toBe("打开会话")
    expect(copy.control).toBe("控制子任务")
    expect(copy.retry).toContain("相同请求")
    expect(copy.terminalControl).toContain("已结束")
    expect(workspaceCopy("en").sendFollowup).toBe("Send follow-up")
  })

  test("falls back to readable labels for unknown states", () => {
    expect(statusLabel("future_state", "en")).toBe("future state")
  })
})
