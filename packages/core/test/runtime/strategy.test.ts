import { describe, expect, it } from "bun:test"
import { STRATEGIES, hypothesisTestPrompt, selectStrategy, strategyPrompt } from "@arforge-ai/core/runtime/strategy"

describe("RuntimeStrategy", () => {
  it("exposes the blueprint reasoning strategies", () => {
    const ids = STRATEGIES.map((strategy) => strategy.id)
    expect(ids).toContain("direct")
    expect(ids).toContain("plan-execute")
    expect(ids).toContain("hypothesis-test")
    expect(ids).toContain("retrieve-verify")
    expect(ids).toContain("generate-critic")
  })

  it("selects hypothesis-test for debugging tasks", () => {
    expect(selectStrategy("帮我定位这个 bug 的根因").id).toBe("hypothesis-test")
    expect(selectStrategy("报错信息无法理解，为什么失败").id).toBe("hypothesis-test")
  })

  it("selects retrieve-verify for documentation tasks", () => {
    expect(selectStrategy("查一下这个 API 的最新文档用法").id).toBe("retrieve-verify")
  })

  it("selects generate-critic for review tasks", () => {
    expect(selectStrategy("请审查这段代码").id).toBe("generate-critic")
  })

  it("selects direct for simple tasks and plan-execute for long ones", () => {
    expect(selectStrategy("1+1等于几").id).toBe("direct")
    expect(selectStrategy("x".repeat(200)).id).toBe("plan-execute")
  })

  it("generates a falsifiable hypothesis-test prompt", () => {
    const prompt = hypothesisTestPrompt("服务启动失败")
    expect(prompt).toContain("假设列表")
    expect(prompt).toContain("验证计划")
    expect(prompt).toContain("证据记录")
    expect(strategyPrompt("服务启动失败")).toContain("假设检验")
  })
})
