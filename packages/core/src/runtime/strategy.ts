/**
 * Reasoning strategy registry and the hypothesis-test strategy.
 *
 * Strategies are versioned, descriptive prompts selected by task heuristics.
 * The hypothesis-test strategy turns a task into falsifiable hypotheses with
 * explicit verification steps and expected evidence, instead of a single
 * direct attempt.
 */

export type StrategyID =
  | "direct"
  | "plan-execute"
  | "hypothesis-test"
  | "retrieve-verify"
  | "generate-critic"

export interface ReasoningStrategy {
  readonly id: StrategyID
  readonly name: string
  readonly when: string
  readonly prompt: string
}

export const STRATEGIES: ReadonlyArray<ReasoningStrategy> = [
  {
    id: "direct",
    name: "Direct 直接回答",
    when: "简单明确、无歧义的任务",
    prompt:
      "这是一个直接任务：基于已有信息直接完成，不需要额外规划或假设。完成前用一句话说明你的结论。",
  },
  {
    id: "plan-execute",
    name: "Plan-Execute 规划后执行",
    when: "多步骤任务、需要先后顺序",
    prompt:
      "先给出简短执行计划（步骤列表），然后按步骤执行。每完成一步用状态更新。计划改变时明确说明原因。",
  },
  {
    id: "hypothesis-test",
    name: "Hypothesis-Test 假设检验",
    when: "调试、故障排查、根因分析、行为不明确的任务",
    prompt:
      "不要直接猜测答案。先列出互斥的候选假设（带置信度），为每个假设设计一个最小验证动作（运行命令/读取文件/检索），用证据确认或证伪假设，最后只基于剩余假设给出结论。没有证据不要下结论。",
  },
  {
    id: "retrieve-verify",
    name: "Retrieve-Verify 检索验证",
    when: "依赖外部资料、文档、历史事实的任务",
    prompt:
      "先检索相关信息，为每条关键信息标注来源，交叉验证后作答。无法验证的信息明确标注为未证实。",
  },
  {
    id: "generate-critic",
    name: "Generate-Critic 生成批判",
    when: "代码审查、设计评审、文档质量要求高的任务",
    prompt:
      "先产出完整方案，然后以挑剔的评审者视角检查自己的输出：找出错误、遗漏和边界情况，修正后给出最终版本。",
  },
]

const HYPOTHESIS_KEYWORDS = [
  "debug",
  "bug",
  "失败",
  "报错",
  "错误",
  "定位",
  "根因",
  "为什么",
  "崩溃",
  "异常",
  "不生效",
  "无法",
  "失败原因",
]

const RETRIEVE_KEYWORDS = ["文档", "资料", "规范", "官网", "历史", "用法", "版本差异", "最新"]

const CRITIC_KEYWORDS = ["审查", "评审", "review", "检查质量", "重构建议"]

export function selectStrategy(task: string): ReasoningStrategy {
  const normalized = task.toLowerCase()
  if (CRITIC_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return STRATEGIES.find((strategy) => strategy.id === "generate-critic")!
  }
  if (HYPOTHESIS_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return STRATEGIES.find((strategy) => strategy.id === "hypothesis-test")!
  }
  if (RETRIEVE_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return STRATEGIES.find((strategy) => strategy.id === "retrieve-verify")!
  }
  if (normalized.length > 120) return STRATEGIES.find((strategy) => strategy.id === "plan-execute")!
  return STRATEGIES.find((strategy) => strategy.id === "direct")!
}

export function hypothesisTestPrompt(task: string): string {
  const strategy = STRATEGIES.find((candidate) => candidate.id === "hypothesis-test")!
  return [
    `## 假设检验策略（任务：${task.slice(0, 200)}）`,
    strategy.prompt,
    "输出格式：",
    "1. 假设列表：每个假设 H1/H2/...（内容 + 置信度）",
    "2. 验证计划：每个假设的最小验证动作",
    "3. 证据记录：执行结果如何支持或反驳每个假设",
    "4. 结论：剩余假设 + 下一步",
  ].join("\n")
}

export function strategyPrompt(task: string): string {
  const strategy = selectStrategy(task)
  if (strategy.id === "hypothesis-test") return hypothesisTestPrompt(task)
  return `## 推理策略：${strategy.name}\n${strategy.prompt}`
}
