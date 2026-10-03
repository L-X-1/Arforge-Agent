import { describe, expect, test } from "bun:test"
import {
  candidateBlockLabel,
  candidateReasonLabel,
  candidateReviewCopy,
  candidateValueLabel,
} from "./memory-candidate-review-copy"

describe("Memory Candidate review copy", () => {
  test("localizes deep lifecycle values without exposing raw workflow tokens", () => {
    expect(candidateValueLabel("proposed", "zh")).toBe("等待审查")
    expect(candidateValueLabel("near_duplicate", "zh")).toBe("可能重复")
    expect(candidateValueLabel("until_review", "zht")).toBe("保留至下次審查")
    expect(candidateValueLabel("activated", "en")).toBe("Activated")
  })

  test("explains fail-closed policy and credential handling", () => {
    expect(candidateBlockLabel("policy_not_allow", "zh")).toContain("明确拒绝")
    expect(candidateBlockLabel("secret_or_credential", "en")).toContain("cannot be approved")
    expect(candidateReviewCopy("zh").redacted).toContain("已隐藏")
    expect(candidateReasonLabel("Legacy model write routed to candidate review.", "zh")).toBe(
      "模型生成的记忆已转入候选审查。",
    )
  })
})
