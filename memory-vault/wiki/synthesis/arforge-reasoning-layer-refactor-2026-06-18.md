---
title: Arforge Reasoning Layer Refactor — GLM5.2 Structured Reasoning Alignment
category: synthesis
summary: 将 Arforge Agent 推理层从关键词匹配器重构为 GLM5.2 对标的结构化多阶段推理管道（UNDERSTAND → THINK → GATHER → VERIFY → ANSWER），新建 arforge/reasoning/ 包。
tags: [arforge, reasoning, refactor, GLM5.2, chain-of-thought, structured-output]
sources: 1
updated: 2026-06-18
---

# Arforge Reasoning Layer Refactor — GLM5.2 对标

> 执行日期: 2026-06-18
> 核心目标: 将 Arforge Agent 推理层从关键词匹配重构为模型驱动的结构化多阶段推理管道

---

## 一、重构前状态

重构前 Arforge 的"推理层"实际上没有进行任何推理。所有"推理"均由 Python 关键词 if/else 匹配完成，模型只负责最后输出文字。

| 文件 | 职责 | 实现方式 | 行数 |
|------|------|----------|------|
| `planning/reasoning.py` | 任务分类 | 关键词 if/else | 28 |
| `intent_analyzer.py` | 意图分析 | 关键词 if/else | 34 |
| `core/agent_core.py` | 路由决策 | 关键词 + 长度判断 | 分散 |
| `planning/planner.py` | 计划生成 | 写死的 5 步模板 | 52 |
| `planning/orchestrator.py` | 编排 | 串联 classify + plan | 24 |
| `planning/effort_mode.py` | 努力程度 | 关键词匹配 | 21 |
| `planning/response_mode.py` | 输出格式 | 关键词匹配 | 13 |
| `model_reasoning.py` | JSON提取/摘要 | 正则截断 | 21 |

当前 Agent Loop V2 管道：
```
user_input → analyze_intent(关键词) → run_tool_if_match(正则) → call_model(直接回答)
                                                                    ↑
                                                        没有任何中间推理过程
```

与 GLM5.2 的核心差距：

| 维度 | GLM5.2 | 重构前 Arforge |
|------|--------|---------------|
| 任务理解 | 模型深度理解+分解 | 关键词 if/else |
| 逐步推理 | `<thinking>` 标签 CoT | 完全没有 |
| 证据收集 | 先找引用再回答 | 完全没有 |
| 工具调用 | 推理过程中动态决策 | 正则匹配后调用 |
| 自我反思 | 审查+修正循环 | 完全没有 |
| 结构化输出 | XML标签分离推理/答案 | 无结构化 |
| 退回机制 | 不确定时承认 | 完全没有 |
| 计划生成 | 模型动态生成 | 写死的5步模板 |

---

## 二、重构架构

### 2.1 新增文件

```
arforge/reasoning/
├── __init__.py      # 包入口，导出所有公开 API
├── prompts.py       # 4 种结构化推理 System Prompt
├── parser.py        # XML 标签解析 → ReasoningResult
└── pipeline.py      # ReasoningPipeline 统一推理引擎
```

### 2.2 推理流程

```
用户输入
  │
  ├─ UNDERSTAND   → <understanding> 深度理解任务意图 + 分解子问题
  ├─ THINK        → <thinking> Chain-of-Thought 逐步推理
  ├─ GATHER       → <evidence> 收集文件/记忆/工具结果作为证据
  ├─ VERIFY       → <reflection> 自我审查 + 承认不确定性
  └─ ANSWER       → <answer> 基于完整推理链的最终答案
```

所有 5 个阶段在单次模型调用中完成。System Prompt 指示模型按 XML 标签输出结构化内容，`ReasoningParser` 进行解析，异常格式自动 fallback。

### 2.3 4 种推理模式

| 模式 | 触发条件 | 使用 Prompt |
|------|---------|-------------|
| Quick | 简单问候/短输入 | `QUICK_REASONING_PROMPT` |
| Coding | 修复/实现/代码关键词 | `CODING_REASONING_PROMPT` |
| Planning | 架构/设计/规划关键词 | `PLANNING_REASONING_PROMPT` |
| Full | 默认 | `REASONING_SYSTEM_PROMPT` |

### 2.4 推理内容 XML 结构

```xml
<understanding>
  <intent>用户想做什么</intent>
  <subtasks>分解后的子任务</subtasks>
  <complexity>simple|medium|complex</complexity>
</understanding>

<thinking>
  <step>推理步骤 1</step>
  <step>推理步骤 2</step>
</thinking>

<evidence>
  <source type="file|memory|tool">引用的证据</source>
</evidence>

<reflection>
  <concern>潜在问题</concern>
  <correction>修正</correction>
</reflection>

<answer>
  最终用户回复
</answer>
```

---

## 三、修改文件

| 文件 | 改动 |
|------|------|
| `arforge/core/agent_core.py` | `ArforgeAgent.__init__()` 新增 `reasoning_enabled`(默认True) 和 `last_reasoning`；`_build_messages()` 新增 `use_reasoning` 参数；`chat()` 自动解析推理结果；新增 `call_model_with_reasoning()` |
| `arforge/core/agent_loop_v2.py` | `LoopResult` 新增 `reasoning` 和 `reasoning_summary` 字段；`run()`/`stream()`/`run_coding_task()` 全部使用推理管道 |
| `arforge/models/deepseek_adapter.py` | `generate()` 和 `stream_generate()` 捕获 `reasoning_content`（DeepSeek Reasoner 原生 CoT）；自动包装为 `<thinking>` 标签 |
| `arforge/prompt.py` | `build_system_prompt()` 新增 `with_reasoning` 参数；`build_user_prompt()` 保持向后兼容 |

### 关键设计决策

1. **单次模型调用**：5 个推理阶段在同一个 API 请求中完成，避免多次调用的延迟和成本
2. **向后兼容**：`reasoning_enabled=False` 可退回到旧行为；`build_user_prompt()` 保持原有格式
3. **DeepSeek Reasoner 原生支持**：当使用 `deepseek-reasoner` 模型时，自动捕获 API 返回的 `reasoning_content` 并注入 `<thinking>` 标签
4. **鲁棒解析**：XML 标签解析失败时依次尝试 Markdown 标题匹配、全文作为答案

---

## 四、Prompt Engineering 标准遵循

推理 Prompt 设计严格遵循 `Agent准则.md`（通用 Prompt Engineering Interactive Tutorial）中的 12 条标准：

| 技术 | 应用 |
|------|------|
| 角色分配 (Role Prompting) | "You are an expert reasoning agent" + 按任务切换角色 |
| XML 分离 (XML Separation) | 5 个推理阶段各自独立的 XML 标签对 |
| 逐步思考 (Chain of Thought) | `<thinking>` 标签强制输出推理步骤 |
| 示例驱动 (Few-Shot) | 每个 Prompt 包含完整的 XML 结构示例 |
| 防幻觉 (Hallucination Prevention) | "如果不知道就说不确定" + `<evidence>` 要求先找证据 |
| 退回机制 (Give an Out) | "如果证据不支持结论，明确说明" |
| 输出格式化 (Output Formatting) | XML 标签包裹关键输出，便于程序化提取 |
| 10要素框架 | 按 Task Context → Tone → Rules → Examples → Input → Output 构建 |

---

## 五、验证结果

| 检查项 | 结果 |
|--------|------|
| compileall (406 .py) | CLEAN |
| arforge.* 全包导入 | 198/198 OK |
| 推理包编译 | 4/4 OK |
| 推理包导入 | 全部 API 可导入 |
| prompt 选择逻辑 | 7/7 正确（含 "hi" in "architecture" 边界修复） |
| XML 解析 | 正确提取 5 个标签 + fallback 可用 |
| 兼容包装器 | models/prompt.py, model_reasoning.py, planning/* 全 OK |
| pytest (全量) | 216/218 passed (2 failed 为已存在权限确认问题) |
| Ruff | arforge/reasoning/ 0 issues |

---

## 六、推理层架构层级

重构后 Arforge 推理层在整体架构中的位置：

```
┌─────────────────────────────────────────────────────────┐
│ CLI / UI 层                                              │
├─────────────────────────────────────────────────────────┤
│ Agent Core 层 (ArforgeAgent)                             │
│   ├── call_model_with_reasoning()  ← 新增入口            │
│   └── last_reasoning               ← 推理追踪            │
├─────────────────────────────────────────────────────────┤
│ ★ Reasoning 层 (arforge/reasoning/)    ← 本次新建        │
│   ├── ReasoningPipeline             ← 统一推理引擎       │
│   ├── ReasoningResult               ← 结构化结果         │
│   ├── 4 种 Prompt 模式              ← 任务感知           │
│   └── XML Parser (鲁棒 fallback)    ← 输出解析           │
├─────────────────────────────────────────────────────────┤
│ Agent Loop V2 (推理增强执行闭环)                          │
├─────────────────────────────────────────────────────────┤
│ Model Adapter (DeepSeek + reasoning_content 捕获)        │
├─────────────────────────────────────────────────────────┤
│ Planning 层 (保留兼容，classify_task 继续服务)            │
└─────────────────────────────────────────────────────────┘
```

---

## 七、后续优化方向

1. **推理质量评估**：建立 benchmark 对比开启/关闭推理的答案质量差异
2. **推理链可视化**：CLI 中展示 `<thinking>` 和 `<evidence>` 折叠面板
3. **推理缓存**：相似问题复用推理链，降低 token 消耗
4. **推理纠正闭环**：用户纠正 → 自动注入 `<reflection>` → 更新学习模式
5. **多轮推理**：复杂任务支持暂停/继续推理，跨多轮对话保持推理状态
6. **推理成本统计**：记录每次推理的 token 消耗，优化 prompt 长度

---

## Appears in
- [[entities/arforge-agent]]
- [[synthesis/arforge-m1-m7-completion-2026-06-16]]

## Open questions
- 是否需要针对 `deepseek-reasoner` 和 `deepseek-chat` 分别优化推理 Prompt
- 推理链质量评估的自动化指标如何设计（BLEU? 人工评分? 任务完成率?）
- 推理缓存如何在保证相关性的前提下最大化命中率
