import { describe, expect, test } from "bun:test"
import { skillDeploymentFieldLabel, skillEvaluationCheckLabel } from "./skill-lifecycle-presentation"

describe("skill lifecycle presentation", () => {
  test("turns evaluation contract keys into user-facing labels", () => {
    expect(skillEvaluationCheckLabel("no_new_egress", "zh")).toBe("没有新增联网目标")
    expect(skillEvaluationCheckLabel("no_new_secret", "zht")).toBe("沒有新增密鑰存取")
    expect(skillEvaluationCheckLabel("future_check", "en")).toBe("future check")
  })

  test("labels deployment receipt fields without exposing raw JSON", () => {
    expect(skillDeploymentFieldLabel("active_candidate", "zh")).toBe("当前候选")
    expect(skillDeploymentFieldLabel("deployment_digest", "zht")).toBe("部署證據摘要")
  })
})
