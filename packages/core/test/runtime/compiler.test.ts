import { describe, expect, it } from "bun:test"
import { compileContext, CONTEXT_LAYER_NAMES, estimateTokens } from "@arforge-ai/core/runtime/compiler"

describe("RuntimeCompiler", () => {
  it("keeps the caller's input order and reports per-layer tokens", () => {
    const compiled = compileContext([
      { layer: "L5", name: "memory", text: "记忆内容" },
      { layer: "L1", name: "agent", text: "agent prompt" },
      { layer: "L3", name: "baseline", text: "项目事实" },
    ])
    expect(compiled.layers.map((layer) => layer.layer)).toEqual(["L5", "L1", "L3"])
    expect(compiled.parts).toEqual(["记忆内容", "agent prompt", "项目事实"])
    expect(compiled.layers.every((layer) => layer.kept)).toBe(true)
    expect(compiled.layers.every((layer) => layer.source.length > 0)).toBe(true)
    expect(compiled.totalTokens).toBe(compiled.layers.reduce((sum, layer) => sum + layer.tokens, 0))
  })

  it("protects L0-L2 while pruning high layers under a budget", () => {
    const big = "x".repeat(400)
    const compiled = compileContext(
      [
        { layer: "L0", name: "constitution", text: "宪法内容" },
        { layer: "L4", name: "learning", text: big },
        { layer: "L5", name: "memory", text: big },
        { layer: "L7", name: "tools", text: big },
      ],
      200,
    )
    const kept = compiled.layers.filter((layer) => layer.kept)
    expect(kept.some((layer) => layer.layer === "L0")).toBe(true)
    expect(compiled.totalTokens).toBeLessThanOrEqual(200)
  })

  it("truncates remaining high layers when dropping is not enough", () => {
    const big = "y".repeat(1000)
    const compiled = compileContext(
      [
        { layer: "L0", name: "constitution", text: "宪法" },
        { layer: "L4", name: "strategy", text: big },
        { layer: "L5", name: "memory", text: big },
      ],
      100,
    )
    expect(compiled.totalTokens).toBeLessThanOrEqual(100)
    const strategy = compiled.layers.find((layer) => layer.name === "strategy")
    expect(strategy?.kept).toBe(true)
    expect(strategy?.chars).toBeLessThan(1000)
  })

  it("keeps all layers when no budget is provided", () => {
    const compiled = compileContext([{ layer: "L7", name: "tools", text: "tools" }])
    expect(compiled.layers[0].kept).toBe(true)
  })

  it("exposes the blueprint layer names", () => {
    expect(CONTEXT_LAYER_NAMES["L0"]).toBe("宪法与安全约束")
    expect(CONTEXT_LAYER_NAMES["L5"]).toBe("检索到的相关记忆")
  })

  it("estimates tokens as chars / 4", () => {
    expect(estimateTokens("1234")).toBe(1)
    expect(estimateTokens("")).toBe(0)
  })
})
