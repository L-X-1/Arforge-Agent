import { describe, expect, test } from "bun:test"
import {
  workflowAccessLabel,
  workflowAttemptLabel,
  workflowConditionLabel,
  workflowDateTime,
  workflowDependencyLabel,
  workflowDurationLabel,
  workflowExecutionModeLabel,
  workflowNodeKindLabel,
  workflowNodeSummary,
  workflowPermissionLabel,
  workflowParallelismHelp,
  workflowParallelismLabel,
  workflowProgressBreakdownLabel,
  workflowProgressLabel,
  workflowRunStatusLabel,
  workflowSchedulingFailureLabel,
  workflowSchedulingSummary,
  workflowSchedulingActionLabel,
  workflowSplitReasonLabel,
} from "./workflow-presentation"

describe("workflow presentation", () => {
  test("turns internal workflow fields into concise Chinese labels", () => {
    expect(workflowRunStatusLabel("waiting_approval", "zh")).toBe("等待批准")
    expect(workflowNodeKindLabel("command", "zh")).toBe("命令任务")
    expect(workflowAccessLabel("write", "zh")).toBe("可修改文件")
    expect(workflowPermissionLabel("acceptEdits", "zh")).toBe("允许编辑")
    expect(workflowSchedulingActionLabel("candidate", "zh")).toBe("候选（未自动启用）")
    expect(workflowExecutionModeLabel("multi", "en")).toBe("Multi-agent")
    expect(workflowRunStatusLabel("running", "zht")).toBe("執行中")
    expect(workflowNodeKindLabel("checkpoint", "zht")).toBe("檢查點")
    expect(workflowAccessLabel("read", "zht")).toBe("唯讀")
    expect(workflowProgressLabel({ settled: 2, total: 5, percent: 40 }, "zh")).toBe("已处理 2/5 个步骤（40%）")
    expect(workflowProgressLabel({ settled: 2, total: 5, percent: 40 }, "zht")).toBe("已處理 2/5 個步驟（40%）")
    expect(workflowAttemptLabel(0, 3, "zh")).toBe("尚未尝试 · 最多 3 次")
    expect(workflowAttemptLabel(0, 3, "zht")).toBe("尚未嘗試 · 最多 3 次")
    expect(workflowDependencyLabel(["plan", "review"], "zh")).toBe("等待：plan、review")
    expect(workflowProgressBreakdownLabel({ completed: 2, waiting_approval: 1, failed: 0 }, "zh")).toBe(
      "已完成 2、等待批准 1",
    )
    expect(workflowConditionLabel(null, "zh")).toBe("始终执行")
    expect(workflowConditionLabel({ when_step: "", when_statuses: [] }, "zh")).toBe("始终执行")
    expect(workflowConditionLabel(null, "zht")).toBe("始終執行")
    expect(workflowConditionLabel(false, "zht")).toBe("條件不滿足")
    expect(workflowConditionLabel({ branch: "safe" }, "en")).toBe('{"branch":"safe"}')
    expect(workflowDurationLabel(90_000, "zh")).toBe("2 分钟")
  })

  test("keeps stable technical values readable instead of pretending to translate them", () => {
    expect(workflowRunStatusLabel("provider_specific_state", "zh")).toBe("provider specific state")
    expect(workflowNodeSummary({ status: "failed", attempt: 2, maxAttempts: 3, locale: "en" })).toBe(
      "Failed · Attempt 2/3",
    )
  })

  test("formats valid timestamps and preserves invalid backend evidence", () => {
    expect(workflowDateTime(null, { locale: "zh", intl: "zh-Hans" })).toBe("尚未发生")
    expect(workflowDateTime("not-a-date", { locale: "zh", intl: "zh-Hans" })).toBe("not-a-date")
    expect(workflowDateTime("2026-08-15T08:00:00.000Z", { locale: "en", intl: "en" })).toContain("2026")
  })

  test("keeps duration units readable for short and long workflow budgets", () => {
    expect(workflowDurationLabel(650, "en")).toBe("650 ms")
    expect(workflowDurationLabel(3_600_000, "en")).toBe("1.0 hr")
  })

  test("explains requested versus effective multi-agent scheduling without overpromising", () => {
    const candidate = {
      action: "candidate",
      execute_mode: "single",
      eligible: true,
      requested_max_parallel: 4,
      effective_max_parallel: 1,
    }
    expect(workflowSchedulingSummary(candidate, "zh")).toBe(
      "任务结构允许拆分，但尚未通过固定数据集收益门禁；本次仍使用单执行。",
    )
    expect(workflowParallelismLabel(candidate, "zht")).toBe("請求上限 4 · 實際 1")
    expect(workflowParallelismHelp("en")).toContain("requested ceiling")
    expect(workflowSplitReasonLabel("independent-dag-node", "zh")).toBe("DAG 中的独立节点")
    expect(workflowSchedulingFailureLabel("fixed-dataset multi-agent benefit evidence is missing", "zht")).toBe(
      "缺少固定資料集上的收益證據",
    )
  })
})
