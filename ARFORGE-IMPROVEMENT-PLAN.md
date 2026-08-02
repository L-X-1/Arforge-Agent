# Arforge Agent 完善计划：从"能跑"到"真能干活、能把活干好"

> 版本：v1 · 2026-06-25
> 依据：2026-06-25 第三方独立审查（源码审查 + 真实运行测试）+ 本日两轮工程修复后的真实状态。
> 目标定义：
>   - "能干活" = 单仓库内可独立完成"理解需求→探索代码→改动→跑测试→自纠错→交付"。
>   - "把活干好" = 成功率≥85%、可复现、有可观测报告、安全可控、长任务不崩、可回滚。
> 对标基准：业界领先的本地 CLI code agent。
> 约束：所有阶段必须留下命令/日志/验收证据；不得用"测试全过"等同"真实可用"。

---

## 0. 当前真实起点（2026-06-25 修复后）

| 维度 | 状态 |
|---|---|
| agentic 循环 | ✅ 真实合格（function-calling、并行、循环检测、熔断、Tracer） |
| 工具表面 | ✅ 16 个有效工具（file/shell/code/data/web/task） |
| trust-cwd 真实项目操作 | ✅ 已打通 |
| 写→跑→测闭环 | ✅ 已打通（hello/calc/string_utils/探索既有代码/CSV 分析 全过） |
| 安全模型 | ✅ 永不 shell=True + 白名单 + 危险守卫 + 管道 |
| 长任务稳定性 | ⚠️ 未压测（max_steps=10，复杂任务可能中途耗尽） |
| 自纠错质量 | ⚠️ 有 verify/retry，但无"失败→定位→改方案"的结构化反思 |
| 可观测报告 | ❌ 每次任务无结构化"干了什么/读了哪些/为什么这么改"报告 |
| 真实 dogfood 数据 | ❌ 几乎为零（学习系统空转） |
| 多语言 | ⚠️ Python 闭环稳；JS/Go/Rust 仅靠 run_cmd，无符号级理解 |
| 桌面/签名/Ship Gate | ❌ 仍 DO NOT SHIP |

一句话：**核心闭环已通，差的是"广度 + 打磨 + 可观测 + 数据"。**

---

## 阶段 1 — P0：把"能干活"做扎实（预计 1~2 周）

目标：让 agent 在 Python 单仓库上，对中等任务稳定成功、可观测、可回滚。

### 1.1 结构化任务报告（P0，最高优先）
- **问题**：现在任务结束只给 token/成本，用户不知道它读了哪些文件、改了哪些、为什么、是否回滚。
- **做**：在 `run_tool_loop` / `AgentLoopV2.run_agentic` 产出结构化报告：
  - explored_files（code_read/search 读过的）
  - modified_files（edit/write 改的，含 diff 摘要）
  - commands_run（run_cmd 的命令 + exit code）
  - verifications（触发的校验 + 通过/失败）
  - rollback_events（是否回滚、为什么）
  - final_answer
- **落地**：`arforge/core/run_report.py` 新模块；CLI 末尾打印精简版，`--report out.json` 落盘。
- **验收**：3 个真实任务都能产出报告；测试 `test_run_report.py`。

### 1.2 自纠错升级：失败→定位→换方案（P0）
- **问题**：当前 retry 只是重试同一工具；真正的 code agent 是"跑挂了→读错误→改代码→再跑"。
- **做**：在 agentic loop 里，当 run_cmd 失败或测试失败，把 stderr/失败堆栈作为 tool result 回灌模型，并在系统提示强化"失败时先分析错误再改，不要原样重试"。
- **落地**：`core/agentic.py` 已有回灌机制；补 `core/self_correct.py`：识别"重复同错误≥2次"→注入反思提示→必要时建议中止。
- **验收**：给一个故意带 bug 的任务，agent 能自己定位并修（当前会卡在重试）。

### 1.3 max_steps 与长任务（P0）
- **问题**：默认 max_steps=10，复杂任务（多文件重构）会撞顶被强行 _finalize。
- **做**：
  - 按任务复杂度动态设 max_steps（简单 10、中等 25、复杂 40），由 planner/意图分析定档。
  - 撞顶时不静默收尾，而是产"未完成报告 + 已完成步骤 + 建议下一步"。
  - 支持任务暂停/恢复（save messages 到磁盘，下次 continue）。
- **验收**：一个 5 文件重构任务能在 25 步内完成；中断后能 resume。

### 1.4 Plan Mode 真落地（P0）
- **问题**：plan 模式目前基本是"只读"，没有"先给方案→用户确认→再执行"的闭环。
- **做**：
  - plan 模式：agent 先探索 + 出方案（涉及哪些文件、风险、是否可回滚、预计步骤），**停下等确认**。
  - 用户批准后切到 acceptEdits/auto 执行。
  - 方案结构化（JSON），Desktop 可渲染成卡片。
- **验收**：复杂任务在 plan 模式先出方案，确认后才动手；CLI 有 y/n/编辑选项。

### 1.5 回滚与安全网（P0）
- **问题**：edit_file/write_file 有 backup，但 agent 没有整任务级"一键撤销本轮所有改动"。
- **做**：每个 agentic run 开一个事务，记录所有写入；提供 `arforge revert <run_id>` 一键回滚本轮。复用 `backup_manager`。
- **验收**：跑一个改动任务后 `revert` 能把工作区恢复到 run 前。

**阶段 1 出口标准**：Python 单仓库中等任务成功率≥85%（用下方评估集度量），每个任务有报告、可回滚、复杂任务能 plan。

---

## 阶段 2 — P1：评估体系 + 真实 dogfood（预计 1~2 周）

目标：从"我感觉它行"变成"有数据证明它行"。

### 2.1 固定评估集（P1）
- **做**：建 `evals/` 目录，20 个真实任务，每任务含：prompt、初始仓库 fixture、期望结果断言、评分函数。
  - 分类：修 bug / 加 feature / 写测试 / 重构 / 读架构问答 / 数据处理 / 多文件改动。
  - 自动跑：`arforge eval --suite core`，输出成功率、平均步数、平均 token、失败分布。
- **验收**：20 任务基线跑通，成功率作为每次改动的回归门禁（不允许下降）。

### 2.2 dogfood 数据闭环（P1）
- **问题**：学习系统设计完整但无真实数据。
- **做**：每次真实 `arforge code` 任务记录 outcome（成功/失败/用户纠正/步数/工具使用），写入 `~/.arforge/dogfood.jsonl`。
  - `/dogfood status` 看累计统计；失败自动生成 error_pattern 候选进学习系统。
- **验收**：累计 50+ 真实任务有结构化记录；能按失败类型汇总。

### 2.3 检索质量评估（P1）
- **问题**：code_indexer/符号索引/TF-IDF 等资产多，但"召回准不准"无量化。
- **做**：建 retrieval eval：给定问题，断言召回的文件/符号是否正确；给回答加"依据哪些文件"。
- **验收**： retrieval 命中率有数字基线，回答能引用来源。

**阶段 2 出口标准**：20 任务评估集成功率≥85%；50+ dogfood 记录；检索命中率有基线。

---

## 阶段 3 — P1：广度——多语言与更多场景（预计 2~3 周）

目标：从"Python code agent"扩到"通用 code agent"。

### 3.1 多语言符号理解（P1）
- **现状**：Python 有 AST 索引；JS/TS/Go/Rust 只能靠 run_cmd + 文本搜索。
- **做**：
  - JS/TS：接 `tsc`/`tree-sitter` 做符号索引；code_search 支持 .ts/.js。
  - Go/Rust：tree-sitter 或各自 LSP（gopls/rust-analyzer）轻量集成。
  - 优先级：JS/TS > Go > Rust（按用户量）。
- **验收**：在 React/Go 项目里 code_search/code_read 能定位符号。

### 3.2 Git 工作流（P1）
- **做**：真实 git 工具集（非只 run_cmd）：
  - git_diff / git_log / git_blame / git_status（只读，低风险）
  - branch / commit / checkout（写，需确认）
  - 智能提交信息（agent 读 diff 生成 conventional commit）
- **验收**：agent 能"改完→生成提交信息→提交到 feature 分支"。

### 3.3 测试运行与解读（P1）
- **做**：统一 test runner 抽象：detect(pytest/jest/cargo/go test)→run→parse 失败→回灌。
- **验收**：agent 跑 pytest/jest 失败时能解析失败用例并定位修复。

### 3.4 MCP 生态接入（P1）
- **现状**：有 mcp_client 骨架。
- **做**：把外部 MCP server 的工具动态注册进 Agent 工具表（按用户配置）。
- **验收**：接 1 个真实 MCP server（如 filesystem/github）工具可调用。

**阶段 3 出口标准**：JS/TS 闭环可用；git 工作流闭环；多 test runner 支持。

---

## 阶段 4 — P2：差异化与可观测（持续）

### 4.1 学习系统激活（P2）
- 用阶段 2 的 dogfood 数据真正喂学习层；`/learn status` 显示最近学习、置信度、是否参与注入；加 `/learn undo`。
- **验收**：跨会话能看到学习条目影响后续回答。

### 4.2 多模态最小闭环（P2）
- OCR（本地优先）→ 错误文本提取 → code_search → 修复建议。
- Document（PDF/Word）文本抽取进上下文。
- **验收**：截图报错→OCR→定位→修复，至少 2 条链路通。

### 4.3 可观测/成本（P2）
- 每次 run 的 token/成本/缓存命中率 dashboard（CLI `arforge stats` + Desktop）。
- 缓存命中率作为 DeepSeek Native 的硬指标追踪。

### 4.4 桌面对齐（P2）
- Desktop 每个 UI 元素对应真实 Bridge 方法；Plan Mode 卡片、运行报告、回滚按钮接真实数据流。

---

## 阶段 5 — 发布门禁（按既有"剩余五步交付路线"，不跳步）

签名候选 → 升降级矩阵 + 可访问性 → 安全/数据/Git 治理 → staging/load → Ship Gate。
**只有全部通过，公开结论才可从 DO NOT SHIP 改为可交付。**

---

## 执行纪律（贯穿所有阶段）
1. 每阶段先建评估/验收标准，再写代码——避免"感觉行"。
2. 每次改动跑评估集 + 改动面回归 + 全量回归（当前基线 1063 passed）。
3. 真实任务验收 > 单元测试数量 > 模块数量。
4. 任何"对标 X%"必须有可复现命令/日志支撑，不得主观打分。
5. 安全/回滚/可观测是底线，不为功能牺牲。
6. 改动同步更新本计划状态 + 桌面 txt（追加，不删旧）。

---

## 优先级速查
- **立刻做（P0）**：1.1 任务报告 → 1.2 自纠错 → 1.3 max_steps/长任务 → 1.4 Plan Mode → 1.5 回滚
- **紧接着（P1）**：2.1 评估集 → 2.2 dogfood → 3.1 多语言 → 3.2 git → 2.3 检索质量
- **差异化（P2）**：4.1 学习 → 4.2 多模态 → 4.3 可观测 → 4.4 桌面
- **发布**：阶段 5（不跳步）

完成阶段 1+2 = "能干活且有数据证明"；+阶段 3 = "通用 code agent"；+阶段 4 = "有差异化"；+阶段 5 = "可对外发布"。

---
---

# 附录 v2 — 对标业界 CLI code agent 的查漏补缺

> 版本：v2 增补 · 2026-06-26 · **append-only，未改动上方 v1 任何文字**
> 方法：对当前源码做了一次复核（证据见 §E，全部标到 文件:行）。
> 用途：v1 已搭好"核心闭环 + 5 阶段"骨架，本附录针对"像业界领先 CLI agent
> 一样**能干活、且能把活干好**"补齐 v1 没覆盖或覆盖不足的能力。
> 一句话诊断：**v1 的 5 个阶段方向对，但 90% 还停在"计划"，且漏掉了让 code agent
> 真正"能干大活"的几个结构性能力——任务编排、子代理、改后即验证、交付门禁、项目约定加载。**

---

## §A 复核结论：计划自述 vs 代码现状（带证据）

v1 §0 的"当前真实起点"表里有几项写得偏乐观，复核后修正如下：

| v1 自述 | 代码现状（证据见 §E） | 修正结论 |
|---|---|---|
| agentic 循环 ✅ 合格 | `run_agentic(max_steps=10)`，`_run_code` 传 12，**硬编码**；循环内**无** planner / 报告 / 子代理 / 自纠错模块调用 | 闭环在，但只是"裸 loop"，编排能力缺位 |
| 1.1 任务报告 | `run_agentic` 内**无** run_report；CLI 只打印 token/cost | **未开工** |
| 1.2 自纠错 | 无 `self_correct` 调用，仅 stderr 回灌 | **未开工**（仅雏形） |
| 1.3 max_steps 动态 | 仍硬编码 12 | **未开工** |
| 1.4 Plan Mode | 权限三模式已实现，但"先出方案→停下等确认"闭环未接 | **半成品** |
| 子代理能力 | code 流程 `ArforgeAgent(multiagent_enabled=False)` | **干活主流程未用子代理** |
| 项目约定加载 | 只加载本仓库 `ARFORGE.md`，**不发现**被操作项目的 AGENTS.md/项目规则文件 | **关键缺口** |
| git 工作流 | 无结构化 git 工具，仅 run_cmd 白名单含 `git` | 同 v1 §3.2，仍缺 |
| 已经做扎实的部分 | 三模式权限 / 审计 / 预算 / 压缩 / 注入分类 hooks 已接入；`edit_file` 已是"精确唯一替换" | ✅ 这几项是真的，地基好 |

**含义**：v1 不缺"想法"，缺的是①把已规划项真正落进 `run_agentic` 主循环；②补上 v1 整体漏掉的结构性能力（见 §B）。

---

## §B 21 个缺口（按 8 个能力层组织）

> 标记：🔴=v1 完全没提；🟡=v1 沾边但不足；编号 G1–G21 供后续引用。
> 每条给：业界 CLI agent 怎么做 → Arforge 现状 → 要补什么 → 验收。

### 层 1 · 上下文获取（理解项目）
- **G1 ✅ 项目约定自动发现加载 —— 2026-06-26 落地**
  业界做法：从 cwd 逐级向上发现 `AGENTS.md`/项目规则文件，按目录就近、可嵌套注入。
  原状：只加载本仓库 `ARFORGE.md`（`prompt.py:_load_arforge_rules`），换到用户项目里读不到该项目的规矩。
  做：新增 `core/project_context.py`——逐级发现 `AGENTS.md`/`.arforgerules`/兼容规则文件，限额注入系统提示。
  验收：在含 AGENTS.md 的外部仓库跑 `arforge code`，回答能遵守该文件里的约定。
  已落地：`core/project_context.py`(discover_project_conventions：从 WORKSPACE 逐级向上[限 4 层]发现 AGENTS.md/.arforgerules/.cursorrules 等项目规则，
  就近优先、限 6000 字) + `cli._run_code` 把约定拼进 extra_system（项目规矩在前）；`tests/test_g1_project_context.py` 9 passed、ruff clean、回归 1119/0。
- **G2 🟡 大仓库检索规模化**（v1 §2.3 只谈"准不准"，没谈"扛不扛得住大库"）
  做：增量索引 + `.gitignore`/`.arforgeignore` 感知 + 二进制/超大文件跳过 + 索引缓存落盘。
  验收：10万+ 文件仓库首次索引可控、二次秒级、不读垃圾文件。
- **G3 🔴 文件状态跟踪**
  CC：读过的文件记指纹，不重复读；文件被外部改动会提示"已过期"。
  做：run 内维护 file-state 表，重复读命中缓存、改动后失效。
  验收：同一文件不被无谓重读，token 明显下降。

### 层 2 · 任务编排（干大活不迷路）—— **最高杠杆，v1 最大盲区**
- **G4 ✅ 自驱任务清单（TodoWrite 式）—— 2026-06-26 落地**
  CC/Codex：复杂任务先拆成可见 todo，边做边勾选，长任务不跑偏。
  原状：`run_agentic` 无任务清单；`task_tools` 是给用户的待办，不是 agent 自驱的。
  做：新增 `core/task_ledger.py`——agent 在 loop 内维护/更新结构化 todo（pending/in_progress/done），CLI 实时渲染。
  验收：多文件任务能看到 agent 自建并推进的清单。
  已落地：`core/task_ledger.py`(TaskLedger 单例 + 强容错 parse_plan) + `tools/plan_tools.py`(update_plan，read 类、三模式放行) +
  `agent_loop_v2.run_agentic(extra_system=)` 注入规划引导 + `cli._run_code` 每轮重置/实时渲染清单；
  `tests/test_g4_task_ledger.py` 22 passed、ruff clean、全量回归 1085 passed/0 失败、update_plan 已进工具表。
- **G5 ✅ 子代理编排进 code 流程 —— 2026-06-26 落地**
  CC：Task/Explore 子代理做并行探索、上下文隔离的子任务，避免主上下文爆掉。
  原状：`multiagent_enabled=False`；`multiagent/` 模块已存在却没在干活流程用。
  做：提供 `spawn_subagent(task, role)` 工具——子代理独立上下文、只读探索、结果摘要回主线。
  验收：大重构任务里主上下文不爆，子代理并行探索 N 个模块。
  已落地：`core/subagent.py`(run_subagent：隔离 messages + 只读工具集 + executor 硬拦截 + 防递归，复用 run_tool_loop) +
  `tools/subagent_tools.py`(spawn_subagent，read 类) + `cli._run_code` 绑定主 adapter(模块级带锁，run 后清理)；
  `tests/test_g5_subagent.py` 10 passed、ruff clean、全量回归 1129/0。（v1：子代理只读探索；可写实现型子代理留待后续）
- **G6 🟡 任务级 checkpoint / resume**（v1 §1.3 提了一句，需独立成体系）
  现状：`session_runtime.py` 的 resume/save 只服务桌面聊天，`arforge code` 任务不能续跑。
  做：复用 session store，把 agentic run 的 messages/todo/已改文件存盘，`arforge code --resume <run_id>`。
  验收：中断一个长任务后能从断点继续。

### 层 3 · 编辑执行（改得准、改得对）
- **G7 ✅ 改后即验证（edit after-hook）—— Codex 的命门 · 2026-06-26 落地**
  CC/Codex：每次写文件后自动跑语法检查/格式化/类型检查，错了立刻回灌。
  原状：`edit_file` 改完即返回，无任何校验。
  做：POST_TOOL_USE 上挂"按语言校验"（py: `compile`/ruff；ts: `tsc`；json/yaml: parse），失败即作为 tool result 回灌。
  验收：故意写出语法错的改动，agent 当步即发现并修。
  已落地：`core/edit_verify.py`(verify_path 校验 py/json/yaml + verify_edit_hook 挂 POST_TOOL_USE，失败经 ctx.feedback 回灌) +
  `cli._run_code` 安装(仅 code 流程，环境变量 `ARFORGE_EDIT_VERIFY` 可关，不碰 config.py)；
  `tests/test_g7_edit_verify.py` 15 passed、ruff clean、全量回归 1100 passed/0 失败。
- **G8 🟡 跨文件一致性改动**（v1 §3.1 只提"符号理解"）
  做：rename symbol / 改签名→同步所有调用点 / import 维护，基于符号索引。
  验收：改一个被多处引用的函数签名，调用点全部同步、测试仍过。
- **G9 🔴 大型/批量补丁**
  做：`apply_patch` 多 hunk 一次性应用 + 超大文件分段编辑，减少多轮 round-trip。
  验收：一次补丁改动同文件多处不出错。

### 层 4 · 验证交付（"把活干好"的硬门禁）
- **G10 ✅ 交付前质量门禁（Done = 验证通过）—— "干好"的出口闸 · 2026-06-26 落地**
  CC/Codex：交付前自动跑受影响测试 + lint + 构建/类型检查，**不过不算完成**。
  原状：v1 §1.2 是过程自纠错，**没有出口 gate**；完成与否靠模型自述。
  做：交付前按项目类型跑 test/lint/build，全过才标 success，否则进自纠错或如实报"未完成"。
  验收：改动若破坏测试，任务不会被标成功。
  已落地（v1 范围：静态门禁，跑测试见 G11）：`core/change_tracker.py`(POST_TOOL_USE 登记本次改动文件，G11/报告复用) +
  `tools/verify_tools.py`(verify_work：交付前对所有改动文件汇总语法/格式校验，返回 pass/fail + 改动清单) +
  `cli._run_code` 安装 + 系统提示要求"完成前必调 verify_work"；`tests/test_g10_verify_work.py` 10 passed、ruff clean、回归 1110/0。
- **G11 🟡 回归保护（跑受影响测试）**
  做：改动文件→定位关联测试→只跑这批（快）；必要时全量。
  验收：能指出"本次改动跑了哪些测试、是否回归"。
- **G12 🔴 代码质量标准（写"好"代码，不只是"能跑"）**
  CC 系统提示强调 match 周边代码风格、最小 diff、不过度工程、文档/注释同步。
  做：把这些写进 code agent 系统提示 + 在报告里体现 diff 行数/是否动了无关代码。
  验收：产出代码风格贴合项目、diff 精简、无多余重写。

### 层 5 · 交互操控（用户能引导）
- **G13 🔴 运行中可打断 + 中途追加指令（steerability）**
  CC：ESC 打断、跑一半补一句话纠偏。
  做：loop 支持中断信号 + 待注入指令队列，下一步纳入。
  验收：长任务跑偏时无需重来，一句话即可纠正。
- **G14 🟡 权限提示交互粒度**（现为模式级，缺单次审批）
  做：高危单步给 allow once / always / deny，记住"always"。
  验收：首次询问、之后记住，不反复打扰。

### 层 6 · 扩展生态（能处理"各种"事情）
- **G15 🔴 Skills / 可复用工作流**
  CC：SKILL.md 渐进式加载，把重复套路沉淀成可调用技能。
  做：`skills/` 目录 + 加载器，命中任务时按需注入。
  验收：把一个常见流程做成 skill，后续自动复用。
- **G16 🔴 自定义命令 + 用户级 Hooks 配置**
  做：用户 `.arforge/commands/*` 自定义 slash 命令；`.arforge/hooks` 配置自动化（如"提交前必跑测试"）。
  验收：用户加一条命令/hook 能生效。
- **G17 🟡 子代理类型库**（依赖 G5）
  做：reviewer / researcher / test-writer / debugger 等预设角色。
  验收：`arforge code` 能委派"写测试"给 test-writer 子代理。

### 层 7 · 安全沙箱（放心交给它干活）
- **G18 🟡 运行时分级沙箱**（v1 阶段5偏发布治理，缺运行时沙箱）
  Codex：FS 写边界 + 网络出口开关 + 命令审批策略可配。
  现状：已有白名单/永不 shell=True/三模式，缺"可配置沙箱档位"。
  做：`sandbox` 档（read-only / workspace-write / danger-full）+ 网络出口白名单。
  验收：workspace-write 档下越界写被拦。
- **G19 🟡 高危操作人审清单**
  做：`rm -rf` / `git push` / db migrate / 批量删除 → 强制二次确认，列入硬清单。
  验收：高危命令必经人审，auto 模式也不例外。

### 层 8 · 可观测与自我改进（可复盘、越用越好）
- **G20 🟡 trace 落盘 + 失败任务可回放**（已有 `observability/tracer.py`，缺持久化+回放）
  做：每次 run 的完整 span 树落盘，`arforge replay <run_id>` 复盘 agent 每步决策。
  验收：失败任务能事后定位"哪一步、为什么错"。
- **G21 🟡 成本主动优化**（v1 §4.3 只测不优化）
  做：prompt caching 命中率提升（稳定前缀）、工具结果裁剪、配合 G3 不重复读。
  验收：同类任务 token/成本较基线下降且可量化。

---

## §C 修订后的优先级路线（把缺口插进阶段）

### 新增 **P0.5 — 让"裸 loop"变成"会编排的 agent"**（插在 v1 阶段1 之前/并行，最高杠杆 · ✅ 2026-06-26 五项全部落地，回归 1129/0）
按"对能不能干大活、有没有干对"的影响排序，先做这 5 个：
1. **G4 自驱任务清单** ✅（2026-06-26 落地） —— 长任务不迷路的地基
2. **G7 改后即验证** ✅（2026-06-26 落地） —— 每步改动当场保证不坏
3. **G10 交付前质量门禁** ✅（2026-06-26 落地） —— "Done=验证过"，这是"干好"的定义
4. **G1 项目约定加载** ✅（2026-06-26 落地） —— 换任意项目都懂规矩（code agent 的灵魂）
5. **G5 子代理编排** ✅（2026-06-26 落地） —— 大库/大重构主上下文不爆

> 这 5 个 + v1 的 1.1 任务报告，构成"能干活且干好"的最小内核。

### 阶段增补（并入 v1 既有阶段，不另起炉灶）
- 并入**阶段1（P0）**：G6 任务 checkpoint、G9 批量补丁、G13 可打断、G19 高危人审
- 并入**阶段2（P1·评估数据）**：G11 回归保护、G20 trace 回放、G12 质量标准纳入评分维度
- 并入**阶段3（P1·广度）**：G2 检索规模化、G8 跨文件一致性、G18 分级沙箱（与 git/多语言一起）
- 并入**阶段4（P2·差异化）**：G15 Skills、G16 自定义命令/Hooks、G17 子代理类型库、G21 成本优化、G3 文件状态跟踪、G14 权限粒度

### 能力成熟度里程碑（用来对外说"到哪一档了"）
- **L1 能跑**：当前——裸 loop 能调工具完成简单任务（已达）
- **L2 能干活**：P0.5 内核 + v1 阶段1 —— 中等任务稳定、改完即验、可回滚、有报告
- **L3 干得好**：+ v1 阶段2（评估≥85% + dogfood）—— 有数据证明、回归不退
- **L4 通用**：+ v1 阶段3 + G2/G8/G18 —— 多语言、git、大库、跨文件
- **L5 像 CC/Codex**：+ 阶段4 扩展生态（Skills/命令/子代理库）+ 阶段5 发布门禁

---

## §D 能力对照总表（Arforge 现状 vs 业界 CLI agent）

| 能力 | 业界 CLI agent | Arforge 现状 | 缺口 |
|---|---|---|---|
| 工具集 | Read/Edit/Bash/Glob/Grep/Web/Task… | 16 工具，edit 精确唯一替换 | 基本齐，缺结构化 git |
| 项目约定 | 逐级 AGENTS.md/项目规则文件 | 仅本仓 ARFORGE.md | G1 |
| 任务清单 | TodoWrite 自驱 | 无 | G4 |
| 子代理 | Task/Explore 并行 | 有模块但 code 流程关闭 | G5/G17 |
| 改后验证 | 自动 lint/类型/语法 | 无 | G7 |
| 交付门禁 | 测试过才算完成 | 模型自述 | G10/G11 |
| 长任务 | todo+压缩+resume | 压缩有，编排/resume 缺 | G4/G6 |
| 可打断 | ESC + 追加指令 | 无 | G13 |
| 权限沙箱 | 分级 + 单次审批 | 三模式(已实现)，缺分级/粒度 | G14/G18/G19 |
| 扩展 | Skills/命令/Hooks/MCP | MCP 计划中，其余无 | G15/G16 |
| 上下文管理 | 压缩+文件状态跟踪 | 压缩有，状态跟踪无 | G3 |
| 可观测 | trace + 成本 | tracer 有，回放/优化缺 | G20/G21 |
| 报告 | 改了啥/为什么 | 仅 token/cost | v1 §1.1 |

---

## §E 复核证据清单（文件:行，可复现）

- `arforge/cli.py:647` `_run_code`；`:735` `ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)`；`:774` `run_agentic(task, max_steps=12, …)`（硬编码、无 planner/报告/子代理）
- `arforge/core/agent_loop_v2.py:359` `run_agentic(... max_steps=10 ...)`；grep 无 planner/run_report/subagent/self_correct/todo
- `arforge/core/agentic.py:56` `run_tool_loop`；`:248` `max_steps_reached`（撞顶静默收尾）
- `arforge/prompt.py:12` `_load_arforge_rules`（只发现本仓 `ARFORGE.md`，不发现外部项目约定文件）
- `arforge/tools/file_tools.py:135` `edit_file`（精确唯一替换，改后无校验）
- `arforge/tools/basic_tools.py`（git 仅 run_cmd 白名单，无结构化 git 工具）
- `arforge/product/session_runtime.py:191` `resume_session`（仅桌面聊天，code 任务不可 resume）
- 已落地的地基（真）：`core/permission.py`(三模式)、`core/compaction.py`(压缩)、`multiagent/security.py`(审计)、`core/budget.py`(预算)、`core/hooks.py`(总线)

- **G4 ✅（2026-06-26 落地）**：`core/task_ledger.py` + `tools/plan_tools.py`(update_plan/read) + `agent_loop_v2.py::run_agentic` 加 `extra_system` + `cli.py::_run_code` 接线（重置/渲染）；`tests/test_g4_task_ledger.py` 22 passed、ruff clean、全量回归 1085 passed/0 失败、update_plan 已入工具表。
- **G7 ✅（2026-06-26 落地）**：`core/edit_verify.py`(verify_path + verify_edit_hook，POST_TOOL_USE 失败回灌) + `cli.py::_run_code` 安装(`ARFORGE_EDIT_VERIFY` 可关)；`tests/test_g7_edit_verify.py` 15 passed、ruff clean、全量回归 1100 passed/0 失败。
- **G10 ✅（2026-06-26 落地）**：`core/change_tracker.py`(改动登记) + `tools/verify_tools.py`(verify_work 交付前汇总校验) + `cli.py::_run_code` 安装 + 系统提示"完成前必调 verify_work"；`tests/test_g10_verify_work.py` 10 passed、ruff clean、全量回归 1110 passed/0 失败。
- **G1 ✅（2026-06-26 落地）**：`core/project_context.py`(逐级发现 AGENTS.md/.arforgerules 等项目规则并注入) + `cli.py::_run_code` 拼进 extra_system；`tests/test_g1_project_context.py` 9 passed、ruff clean、全量回归 1119 passed/0 失败。
- **G5 ✅（2026-06-26 落地）**：`core/subagent.py`(run_subagent 隔离上下文 + 只读 + executor 硬拦截 + 防递归) + `tools/subagent_tools.py`(spawn_subagent) + `cli.py::_run_code` 绑定 adapter；`tests/test_g5_subagent.py` 10 passed、ruff clean、全量回归 1129 passed/0 失败。

**v1 阶段1（P0「把能干活做扎实」）✅ 2026-06-26 全部落地：**
- 1.1 结构化任务报告 ✅：`core/run_report.py`（explored/modified/commands/verifications，复用 change_tracker）+ cli 末尾打印 /`ARFORGE_RUN_REPORT` 落盘；`tests/test_v1_1_run_report.py` 9 passed。
- 1.2 自纠错升级 ✅：`core/self_correct.py`（同工具连续失败 2 次→反思、≥3 次→换方案/如实报告，POST_TOOL_USE 回灌）；`tests/test_v1_2_self_correct.py` 9 passed。
- 1.3 动态 max_steps ✅：`core/complexity.py`（简单 10 / 中等 25 / 复杂 40）+ cli 撞顶未完成提示；`tests/test_v1_3_complexity.py` 7 passed。
- 1.4 Plan Mode 真落地 ✅：`core/plan_mode.py`（plan 只读出方案→批准→切 acceptEdits 执行；auto-approve/非交互安全默认）；`tests/test_v1_4_plan_mode.py` 7 passed。
- 1.5 任务级回滚 ✅：`core/run_transaction.py`（PRE_TOOL_USE 快照原内容→落盘 ~/.arforge/runs/<id>.json）+ `arforge revert [run_id]` 命令；`tests/test_v1_5_run_transaction.py` 9 passed。
- 全量回归 **1170 passed / 0 failed**；ruff clean；README 命令表 + CLI 契约测试同步。

**v1 阶段2（P1「有数据证明它行」）进行中：**
- 2.2 dogfood 数据闭环 ✅ 2026-06-26：`core/dogfood.py`（每次 arforge code 把 outcome 追加 `~/.arforge/dogfood.jsonl`，成功由 trace 推断）+ `arforge dogfood` 累计统计命令；`tests/test_v1_2_2_dogfood.py` 8 passed、全量回归 1178/0、ruff clean、README+契约同步。
- G11 回归保护 ✅ 2026-06-26（并入阶段2）：`core/regression.py`（按 test_<name>.py 定位关联测试 + 子进程跑 pytest）+ `tools/regression_tools.py`（run_impacted_tests）+ cli 注册/系统提示引导；把 G10 从静态语法校验补强为真跑受影响测试；`tests/test_v1_g11_regression.py` 11 passed、全量回归 1189/0。
- G13 运行中可打断 ✅ 2026-06-26（并入阶段2）：`core/interrupt.py`（PRE_LLM_CALL hook——停止请求→block 优雅中止、待注入指令→modify 注入，**不改 run_tool_loop 核心**）+ cli 接 SIGINT（Ctrl+C 优雅停止）；`tests/test_v1_g13_interrupt.py` 8 passed、全量回归 1197/0。指令注入机制就绪，CLI 异步输入触发待后续。
- G19 高危操作人审 ✅ 2026-06-26（并入阶段2，核查后复用现有）：经核查目标**已被 basic_tools 的 ALLOWED_BINARIES 白名单 + DENY_ARG_PATTERNS（rm -rf/force-push/保护分支/format/shutdown/裸设备硬拒）+ shell 元字符拒绝**实现，且优于"二次确认"（auto 模式也绝不放行）；本次为这些关键安全行为补全回归测试 `tests/test_v1_g19_danger_guard.py` 10 passed（防未来削弱安全网）、全量回归 1207/0。**未重复造逻辑**（遵守"深度整合已有模块"）。
- G6 任务级 resume ✅ 2026-06-26（并入阶段2）：`run_transaction.save_run_messages/load_run_messages`（对话落盘 `~/.arforge/runs/<id>.messages.json`）+ `run_agentic` 加 `resume_messages` 参数 + `LoopResult.messages` 字段 + cli `--resume <run_id>`（续跑跳过 plan/初始构建，每次 run 末尾总是存对话）；`tests/test_v1_g6_resume.py` 5 passed、全量回归 1212/0、**向后兼容零回归**。
- 2.1 固定评估集 ✅ 2026-06-26：eval.py 已有 20 任务（确定性文件 / 真实代码执行 / LLM-judge）+ `core/eval_baseline.py` 回归门禁（成功率不许降 + 任务 pass→fail 检测）+ `arforge eval --save-baseline`；`tests/test_v1_2_1_eval_baseline.py` 7 passed。**真实基线 95%（19/20）**（deepseek-v4-flash，117915 tok / ¥0.046；唯一未过 explain_hashmap = judge 模型偶发调用失败，非 agent 答错），已落盘 eval_baseline.json。
- 2.3 检索质量评估 ✅ 2026-06-26：`core/retrieval_eval.py`（Arforge 自身源码金标准查询→应命中文件，本地确定性、不花钱）+ `arforge retrieval-eval`；`tests/test_v1_2_3_retrieval.py` 6 passed、**命中率基线 ≥90%**。
- **v1 阶段2（P1「有数据证明它行」）全部完成**：评估集（95% 真实基线 + 回归门禁）+ dogfood + 检索质量 + G11/G13/G19/G6；全量回归 1225/0。
- **v1 阶段3（P1 广度）进行中**：3.2 真实 git 工具集 ✅ 2026-06-26：`tools/git_tools.py`（git_status/diff/log/branch/add/commit，复用 run_command_no_shell 的白名单+危险守卫，强推/保护分支仍硬拦）+ cli 注册；`tests/test_v1_3_2_git.py` 7 passed（临时 repo 真跑 git）、全量回归 1232/0。3.3 统一 test runner ✅ 2026-06-26：`core/test_runner.py`（检测 pytest/jest/cargo/go → 跑 → 解析 passed/failed）+ `run_tests` 工具 + cli 注册；`tests/test_v1_3_3_test_runner.py` 16 passed（detect/parse 全覆盖 + pytest 真跑）、全量回归 1248/0。3.4 MCP 接入 ✅ 2026-06-26：`mcp_client.MCPConnection`（真实 stdio 子进程 + JSON-RPC initialize/tools-list/tools-call）+ `mcp_test_server` 升级为真 stdio server + `mcp_tools.register_mcp_server`（动态注册进 Agent 工具表）+ `tool_registry.execute_by_name` 支持 **kwargs 动态工具；`tests/test_v1_3_4_mcp.py` 5 passed（真实子进程通信 + 注册调用）、全量回归 1253/0。3.1 多语言符号理解 ✅ 2026-06-26：`core/symbol_index.py`（tree-sitter 解析 JS/TS/Go，提取 function/class/method/interface/type 符号 + 行号，未装 tree-sitter 时优雅降级）+ `code_symbols` 工具（Python AST + JS/TS/Go tree-sitter）+ cli 注册；装 tree-sitter + JS/TS/Go 语言包（D 盘预编译 wheel）；`tests/test_v1_3_1_symbols.py` 9 passed（真实解析）、全量回归 1262/0。**→ v1 阶段3（广度）全部完成（3.1/3.2/3.3/3.4）。**

- 可用性修复（2026-06-26）：**`arforge code --workspace <dir>`**——此前 agent 只能写工作区内，写桌面等工作区外路径被沙箱拒（"path escapes workspace"），用户遇到"无法生成桌面文件"。新增 cli `--workspace/-w` 显式指定工作目录并自动信任（导入 file_tools 前设 ARFORGE_WORKSPACE）；真实验证桌面生成文件成功（WORKSPACE_FIX_OK，¥0.0055）、全量回归 1232/0。同时支持环境变量 ARFORGE_WORKSPACE 或在目标目录内运行。

> 维护约定：本附录与 v1 一样 append-only；后续每完成一个 Gx，在本节标 ✅+证据，不删旧。

---
---

# 附录 v3 — 统一待开发清单（Unified Backlog）

> 版本：v3 · 2026-06-26 · **append-only，未改动上方 v1 + 附录 v2 任何文字**
> 来源：通读 `Arforge-Agent-项目，整合内容.txt`（14719 行），把散落在各历史层的
> 计划项、待办、缺口、发布门禁、战略路线、MCP 设计蓝图**去重 + 排序 + 标状态**
> 后整合成一份"唯一事实来源（single source of truth）"。
> 作用：v1/v2 是"分阶段叙事 + 能力缺口 G1-G21"，v3 是"**一张表看完所有待办及优先级**"。
> 优先级口径（合并 v1 §优先级速查 + v2 §C 路线 + txt 战略 spine + 发布门禁）：
>   - **P0**：阻断基本可用 / "能干活"的最小内核（多数已落地，仅剩收尾）。
>   - **P0.5**：让"裸 loop"变"会编排的 agent"（v2 §C，5 项全已落地）。
>   - **P1**：广度 + 数据证明（多语言/git/test runner/MCP 接入 + 评估/dogfood/检索）。
>   - **P2**：差异化 + 生态（学习/多模态/可观测/Skills/桌面/沙箱）。
>   - **P-Ship**：发布门禁（签名/升降级/可访问性/staging/Ship Gate）—— 与功能解耦，单独成轨。
> 状态标记：✅ 已落地（带证据） / 🟡 进行中或部分 / 🔴 未开工 / ⛔ 阻断发布（P-Ship）。

---

## 0. 阅读导航：v1 / v2 / v3 / txt 各管什么

| 文档/层 | 管什么 | 关系 |
|---|---|---|
| **v1**（本文件上方阶段1-5） | "能干活→把活干好"的 5 阶段骨架（报告/自纠错/max_steps/plan/回滚 + 评估 + 广度 + 差异化 + 发布） | 战略骨架 |
| **附录 v2**（G1-G21） | 对标 CC/Codex 的 21 个能力缺口（8 个能力层） | 能力缺口细账 |
| **附录 v3**（本节） | 所有计划项去重 + 单一优先级排序的**待办总表** | 执行清单（唯一事实来源） |
| txt（桌面总档） | 历史过程证据、战略 spine、MCP 蓝图、发布门禁证据（append-only） | 证据库 |

> 冲突仲裁：状态以"**更晚日期 + 有命令/日志/回归证据**"为准；v3 已据此把 v1/v2 中
> 被 2026-06-26 落地证伪的"未开工/半成品"条目标为 ✅。

---

## 1. 当前真实完成基线（2026-06-26，取代旧"95%"等账面数字）

| 维度 | 状态 | 证据 |
|---|---|---|
| agentic 循环 + 编排内核 | ✅ function-calling/并行/循环检测/熔断/Tracer + G4 todo/G5 子代理/G7 改后验/G10 门禁/G1 约定 | 全量回归 1253/0 |
| 工具表面 | ✅ ~16 有效 + git_tools + test_runner + mcp_tools 动态注册 | tool_registry |
| trust-cwd 真实项目操作 | ✅ `--workspace/-w` + ARFORGE_WORKSPACE | test 1232/0 |
| 写→跑→测闭环 | ✅ cwd 对齐 + 63 白名单 + 安全管道 | task A/B/C/D 全过 |
| 安全模型 | ✅ 永不 shell=True + DENY_ARG_PATTERNS + 元字符拒绝 + G19 守卫测试 | test_v1_g19 |
| 自纠错 | ✅ 失败→定位→换方案（self_correct.py） | test_v1_2 |
| 可观测报告 | ✅ run_report（explored/modified/commands/verifications） | test_v1_1 |
| 任务级回滚/resume | ✅ run_transaction + `arforge revert`/`--resume` | test_v1_5/g6 |
| 评估体系 | ✅ 20 任务基线 95% + 回归门禁 + 检索质量 ≥90% | eval_baseline.json |
| dogfood 数据闭环 | ✅ ~/.arforge/dogfood.jsonl + `arforge dogfood` | test_v1_2_2 |
| Plan Mode 真闭环 | ✅ 出方案→批准→切 acceptEdits | test_v1_4 |
| 动态 max_steps | ✅ 复杂度定档 10/25/40 + 撞顶未完成提示 | test_v1_3 |
| 运行中可打断 | 🟡 interrupt hook 就绪，CLI 异步输入触发待后续 | test_v1_g13 |
| 多语言符号 | 🔴 仅 Python AST；JS/TS/Go/Rust 待 tree-sitter | txt §3.1 |
| 真实 dogfood 量 | 🟡 机制就绪，50+ 轮真实积累待做 | txt §9.1 |
| 桌面/签名/Ship Gate | ⛔ 仍 DO NOT SHIP | txt 第5步 |

**一句话**：code agent "能干活且干好"的最小内核（P0+P0.5+P1 大头）已落地并经真实回归验证；剩 **多语言 + 真实 dogfood 量 + 发布门禁** 三块。

---

## 2. 待开发总表（按优先级排序，统一编号 T1–T40）

> 编号 T = Task。每条给：来源(v1§x / v2-Gx / txt§x / spine第x步) + 状态 + 验收。
> 与 G1-G21 重叠的项标注"Gx"，避免双头管理。

### 🔴 P0 — 收尾即可关（基本已落地，仅剩 1 项进行中）

| # | 任务 | 来源 | 状态 | 验收 |
|---|---|---|---|---|
| T1 | 运行中可打断的 CLI 异步输入触发 | v2-G13 | 🟡 | Ctrl+C 优雅停（已✅）+ 跑一半追加指令注入（机制就绪，触发待接） |

> v1 阶段1（1.1-1.5）+ P0.5（G1/G4/G5/G7/G10）**已 100% 落地**（见 v2 §E 证据），故 P0 仅剩 T1 收尾。

### 🟡 P1 — 广度 + 数据证明（进行中，3 项待做）

| # | 任务 | 来源 | 状态 | 验收 |
|---|---|---|---|---|
| T2 | 多语言符号理解（JS/TS 优先，Go/Rust 次之） | v1-3.1 / v2-G8 关联 | 🔴 | React/Go 项目 code_search 定位符号；接 tree-sitter/tsc/gopls/rust-analyzer |
| T3 | 真实 dogfood 累计 50+ 轮 | txt §9.1 / v1-2.2 | 🟡 | 机制✅(dogfood.jsonl)；积累量待真实使用 |
| T4 | 跨文件一致性（rename/改签名/import 维护） | v2-G8 | 🔴 | 改多处引用函数签名，调用点全同步、测试仍过 |
| T5 | G6/G11/G13/G19/G20 的真实任务回归纳入 eval | v2 §C 并入阶段2 | 🟡 | 评估集覆盖这些能力的真实用例 |

### 🟢 P2 — 差异化 + 生态（未开工为主，按影响力排序）

| # | 任务 | 来源 | 状态 | 验收 |
|---|---|---|---|---|
| T6 | Skills / 可复用工作流（SKILL.md 渐进加载） | v2-G15 / txt §3.4 | 🔴 | 一个常见流程做成 skill，后续自动复用 |
| T7 | 自定义命令 + 用户级 Hooks 配置 | v2-G16 | 🔴 | `.arforge/commands/*` + `.arforge/hooks` 生效 |
| T8 | 子代理类型库（reviewer/researcher/test-writer/debugger） | v2-G17 | 🔴 | 委派"写测试"给 test-writer 子代理 |
| T9 | 学习系统用真实数据激活 | v1-4.1 | 🔴 | 跨会话学习条目影响后续回答；`/learn status`/`/learn undo` |
| T10 | 多模态最小闭环（OCR→错误提取→code_search→修复） | v1-4.2 / txt Step204-206 | 🔴 | 截图报错→OCR→定位→修复，≥2 链路通；PDF/Word 文本抽取 |
| T11 | 可观测/成本 dashboard（token/成本/缓存命中率） | v1-4.3 / v2-G21 | 🟡 | CLI `arforge stats` + Desktop；缓存命中率硬指标追踪 |
| T12 | 桌面对齐（每个 UI 元素→真实 Bridge 方法） | v1-4.4 / txt §5第1阶段 | 🟡 | Plan 卡片/运行报告/回滚按钮接真实数据流 |
| T13 | 文件状态跟踪（读过不重读、外部改动失效） | v2-G3 | 🔴 | 同文件不被无谓重读，token 下降 |
| T14 | 成本主动优化（prompt cache/结果裁剪/不重复读） | v2-G21 | 🔴 | 同类任务 token/成本较基线下降且可量化 |
| T15 | 大仓库检索规模化（增量索引/.gitignore 感知/跳二进制） | v2-G2 | 🔴 | 10万+ 文件首次可控、二次秒级 |
| T16 | 大型/批量补丁（apply_patch 多 hunk + 超大文件分段） | v2-G9 | 🔴 | 一次补丁改同文件多处不出错 |
| T17 | 代码质量标准（match 风格/最小 diff/不过度工程/文档同步） | v2-G12 | 🔴 | 产出风格贴合、diff 精简、报告体现 diff 行数 |
| T18 | 权限提示交互粒度（allow once/always/deny 记住） | v2-G14 | 🔴 | 首次询问后记住，不反复打扰 |
| T19 | 运行时分级沙箱（read-only/workspace-write/danger + 网络白名单） | v2-G18 | 🔴 | workspace-write 越界写被拦 |
| T20 | trace 落盘 + 失败任务可回放 `arforge replay <run_id>` | v2-G20 | 🔴 | 失败任务事后定位"哪一步、为什么错" |
| T21 | 多供应商扩展（除 DeepSeek 外） | txt §6 模型层 TODO | 🔴 | provider 可切换，不锁死 DeepSeek |

### ⛔ P-Ship — 发布门禁（与功能解耦，单独成轨，不跳步）

> 来源：txt "剩余五步交付路线" + v1 阶段5。**全部完成才能从 DO NOT SHIP 改可交付。**

| # | 门禁项 | txt 步骤 | 状态 | 验收 |
|---|---|---|---|---|
| T22 | 受保护 Windows MSI 生命周期 | 第1步 | ✅ 阶段验收 | 安装/启动/卸载/profile 保留（unsigned 候选） |
| T23 | 真实签名候选（Authenticode + RFC3161 时间戳 + 受保护 GH env） | 第2步 | 🔴 ⛔ | 真实证书、private key 不入库、signtool、签名前置检查失败关闭 |
| T24 | 签名升级/降级矩阵 | 第3步 | 🔴 ⛔ | signed 后做升降级路径验证 |
| T25 | 原生可访问性（键盘/屏幕阅读器/125-200% 缩放） | 第3步 | 🔴 ⛔ | 可访问性验收通过 |
| T26 | 人工安全/数据/Git 治理清零 | 第4步 | 🔴 ⛔ | credential cleanup + PostgreSQL restore drill + 凭据轮换 + 遗留文件决策 + reviewed release baseline |
| T27 | 真实 provider/staging/load/long-run dogfood | 第5步 | 🔴 ⛔ | staging 压测 + 负载 + 长跑 |
| T28 | 最终不可变 artifact Ship Gate | 第5步 | 🔴 ⛔ | 全部通过后公开结论改为可交付 |

### 🧩 MCP Server Framework（独立子轨，来自 txt 末尾蓝图 M0-M3）

> 来源：txt「附录 · MCP Server Framework 架构设计文档」落地优先级。与 code agent 路线正交。

| # | 任务 | txt 编号 | 状态 | 验收 |
|---|---|---|---|---|
| T29 | M0 地基：Protocol + StdioTransport + ToolRegistry + 基础工具 + 契约测试 | M0 | 🔴 | stdio MCP server 能 initialize/tools-list/tools-call（已有 mcp_test_server 雏形可升格） |
| T30 | M1 可用：HTTPTransport + Session + Middleware(auth/log/metrics) + Plugin 骨架 | M1 | 🔴 | 远程 MCP 可用；插件可装载 |
| T31 | M2 生产：Scheduler + Cache + CircuitBreaker + Graceful Shutdown + OTel | M2 | 🔴 | 生产级硬化到位 |
| T32 | M3 生态：Resource/Prompt 完整 + sampling 桥 DeepSeek + ExternalMCPBridge 接 Arforge 工具表 | M3 | 🔴 | MCP 工具反向注册进 Agent（落实 v1-3.4 / G15/G16） |

### 📐 战略 spine 补全（来自 txt 第五部分，简历/演示导向，可选）

| # | 任务 | spine 步 | 状态 | 验收 |
|---|---|---|---|---|
| T33 | 基线净化：删死代码/归档纸面/诚实统计 + mypy 门禁 | 第0步 | 🟡 | 16 个 learning_* 碎片合并（txt P2-11 待办）；干净仓库 |
| T34 | 代码 RAG：AST 切块→embedding→FAISS+BM25→rerank | 第2步 | 🟡 | 检索资产多（已有 retrieval_eval ≥90%）；混合检索 Recall@k 提升 |
| T35 | 产品化：FastAPI+SSE+Docker + CLI 打磨 | 第4步 | 🔴 | 容器化流式服务，可现场 demo |
| T36 | 杀手锏 Demo：2 分钟录屏（真实仓库+任务+trace+成本+自纠错） | txt §1 | 🔴 | 可对外/面试展示 |

---

## 3. 一张图：成熟度里程碑 → 对应待办

```
L1 能跑（已达）           — 裸 loop 调工具完成简单任务
   │
   ├─ L2 能干活（已达）     ✅ P0 + P0.5 全落地（报告/自纠错/max_steps/plan/回滚 + G1/G4/G5/G7/G10）
   │
   ├─ L3 干得好（基本达）   ✅ P1 大头（评估95%+dogfood机制+检索≥90% + G11/G13/G19/G6）
   │                        🟡 剩 T1(可打断触发) / T3(50+真实量) / T5(eval 覆盖)
   │
   ├─ L4 通用（未达）       🔴 T2 多语言 / T4 跨文件 / T15 大库 / T19 沙箱 + git✅/test_runner✅/MCP接入✅
   │
   ├─ L5 像 CC/Codex（未达）🔴 T6-T8 生态(Skills/命令/Hooks/子代理库) + T9-T11 差异化(学习/多模态/可观测)
   │
   └─ 可发布（未达）        ⛔ T22-T28 发布门禁全过（当前 DO NOT SHIP）
```

---

## 4. 建议执行顺序（下一批做这 5 个，杠杆最高）

1. **T2 多语言符号**（JS/TS 接 tree-sitter）—— 解锁"通用 code agent"（L4）的最大单项
2. **T1 可打断 CLI 触发** + **T3 真实 dogfood 50+** —— 把 L3 收口、喂活学习系统
3. **T6/T7 Skills + 自定义命令** + **T32 MCP ExternalBridge** —— 扩展生态，对齐 CC
4. **T29 MCP M0 地基** —— 独立子轨启动，不影响 code agent 主线
5. **T23 真实签名候选** —— 发布门禁第一道硬闸（P-Ship），越早动越早能交付

> 执行纪律（沿用 v1 §执行纪律 + txt §5.1）：先建验收标准再写代码；每改动跑评估集+全量回归；
> 任何"对标 X%"必须有可复现命令/日志；安全/回滚/可观测是底线。

---

## 5. v3 维护约定

- **append-only**：不改动上方 v1 + 附录 v2，也不删本节既有条目。
- 每完成一个 T#（或 Gx），在本节对应行更新状态列（🟡/🔴 → ✅ + 证据 + 日期），不删旧行。
- 新增计划项继续编号 T37+，并归入对应优先级段。
- 与 v2 G 编号交叉引用（T# 标注 "Gx"），避免双头管理；状态冲突时以本节（更新更频繁）为准。

---

## 6. 2026-07-16 增量完成记录（append-only）

| # | 任务 | 状态 | 证据 |
|---|---|---|---|
| T37 | 可配置响应样式：用户级/项目级 Markdown 样式发现、覆盖、启用、清除与安全提示注入 | ✅ | `arforge/output_styles.py`、`arforge output-style [list|show|set|clear]`、`tests/test_output_styles.py`；回归 `42 passed` |
| T38 | 桌面高频快捷键基线：新建会话、历史搜索、设置导航，且不劫持输入框普通编辑 | ✅ | desktop/src/App.tsx 全局修饰键处理与 ARIA 快捷键标注；桌面 37 passed |
| T39 | 受控自定义 Hooks 执行：清单命令、匹配、优先级与超时接入全局 Hook 总线，保留默认不执行 | ✅ | `arforge/customization.py`、`arforge custom hooks install`、Bridge 自动安装；显式启用 + 工作区信任 + 白名单 + 无 shell + 脱敏输入；定向回归 61 passed |
| T40 | 本地学习反思入口：固化学习结果后生成可审计反思摘要，提供 CLI/REPL 与 JSON 契约 | ✅ | `arforge.learning_engine.run_learning_dream()`、`arforge learning dream`、`/learn dream`；无默认模型调用；定向回归 75 passed |
| T41 | CLI 认证管理：加密凭据、当前提供商、模型与端点的安全操作入口 | ✅ | `arforge auth [status|login|logout|use|model|endpoint]`；隐藏输入、不回显密钥、复用安全模型配置；定向回归 52 passed |
| T42 | 本地 MCP HTTP/SSE 服务模式：安全监听、会话续接、鉴权与只读项目工具 | ✅ | `arforge server [--host HOST] [--port PORT]`、`arforge/mcp_runtime.py`；默认回环，远程需双重显式许可与令牌；真实 HTTP 回归 65 passed |
| T43 | MCP 插件启停生命周期：本地覆盖状态、服务显式加载与默认零执行 | ✅ | `arforge/plugin_state.py`、`arforge plugins [list|enable|disable]`、`arforge server --load-plugins`；定向回归 54 passed |
| T44 | 受控 SSH 远程工作区：连接档案、严格主机校验、审批和无 Shell 执行 | ✅ | `arforge/ssh_runtime.py`、`arforge ssh [list|add|remove|exec]`；不存密码；定向回归 70 passed |
| T45 | 签名远程特性配置：显式 HTTPS 刷新、HMAC 验证、TTL 缓存和离线回退 | ✅ | `arforge/feature_flags.py`、`arforge features refresh`、Bridge/Desktop 刷新；Python 33 passed + Desktop 38 passed |
| T46 | 显式更新检查：版本元数据、网络策略、缓存与零自动安装 | ✅ | `arforge/update_runtime.py`、`arforge update [check]`；定向回归 52 passed |
| T47 | 更新版本比较修正：省略尾部零的语义版本等价处理 | ✅ | `0.8 == 0.8.0`；更新检查定向回归 23 passed |

说明：T37 参考领先本地编码代理的输出样式目录机制实现，但保持 Arforge 的本地优先、数据配置不执行与安全系统提示不可被样式覆盖的边界。

说明：T39 的 Hooks 仅在 `ARFORGE_ENABLE_CUSTOM_HOOKS=1` 且工作区已受信任时执行。Hook 只能返回 `proceed`、`ask` 或 `block`，不能修改工具参数或绕过权限策略；失败、超时和无效输出均按失败开放处理并保留诊断结果。

说明：T40 复用既有学习结果与模式存储，不新建平行记忆库。它按“模式提取与持久化 -> 离线统计反思”的固定顺序执行；模型驱动的深度反思仍保持独立、显式调用，避免背景隐式成本与数据外发。

说明：T41 不是网页授权流程的伪实现，而是当前本地与兼容 API 提供商的真实凭据管理入口。密钥通过现有机器绑定加密存储保存；状态和 JSON 输出只暴露配置状态与来源，绝不回显凭据。

说明：T42 复用既有 MCP 传输、会话与中间件，补齐了其项目级启动入口和 HTTP 会话头续接。公开工具限定为健康、状态和本地记忆搜索；写入、执行和权限变更仍只保留在受权限控制的本地 Bridge 路径中。

说明：T43 的启停状态按清单绝对路径保存到 Arforge 本地配置，不改写第三方 `plugin.json`。普通 `plugins` 命令永远不导入插件模块；只有用户在启动服务时显式传入 `--load-plugins`，已启用且通过清单校验的工厂才会执行。

说明：T44 使用本机 OpenSSH 客户端并严格依赖现有 `known_hosts` 验证，不接受未知主机密钥，也不保存密码。远程执行需要显式 `ssh exec`、通过本地沙箱网络判定并获得高风险确认；执行参数不经过本地 Shell。

说明：T45 远程配置只在显式刷新时请求 HTTPS，并要求由本地环境中的 HMAC 密钥验证响应体。优先级固定为环境变量 > 本地覆盖 > 有效远程缓存 > 代码默认值；签名或格式失败时不会写入缓存，也不会改变正在生效的本地策略。

说明：T46 仅检查已发布版本，不执行安装、升级或任何环境修改。请求仍经过既有网络出口策略，结果短期缓存以减少无谓网络访问；安装动作留给用户明确选择的包管理流程。

说明：T47 补齐更新检查的版本规范化，避免不同书写形式的相同版本产生误报。

| T48 | 本地后台服务守护：协作式启动、真实端口就绪检查、令牌控制停止与状态诊断 | 已完成 | `arforge daemon [start|status|stop]`、`arforge/daemon_runtime.py`、`arforge/daemon_worker.py`；定向回归 30 passed |

说明：T48 仅允许回环地址绑定。守护进程不会根据 PID 强制终止任意进程，而是为每次启动生成随机本地控制令牌；Worker 仅在监听端口成功绑定后才上报运行中，并在启动失败时写入不含凭据的诊断状态。

| T49 | 文件化工作流运行时：严格 JSON DSL、多步骤依赖校验、只读 Agent 预览与显式执行 | 已完成 | `arforge/workflow_runtime.py`、`arforge workflows [list|validate|run]`、工作流只读工具；定向回归 45 passed |

说明：T49 的工作流定义仅允许结构化任务提示与依赖关系，拒绝 shell 命令、动态导入和未知字段。默认 `run` 只生成计划；仅显式传入 `--execute` 且模型提供商已配置时才进入现有 Agent 循环，报告持久化时会脱敏敏感信息。

| T50 | 多工作区授权根：显式信任、追加目录、文件工具/沙箱/多代理一致边界 | 已完成 | `arforge/workspace_roots.py`、`arforge workspace [list|trust|add|remove]`；定向回归 72 passed |

说明：T50 采用两阶段授权：目录必须先由用户显式信任，再能加入额外工作区根。相对路径仍以主工作区解释，跨目录访问必须给出绝对路径；新增根会同步进入 Agent 沙箱和多代理写路径判定，未授权目录保持阻断。

| T51 | 会话生命周期补全：持久化重命名、Bridge 协议与桌面内联标题编辑 | 已完成 | `session.rename`、`SessionRuntime.rename_session()`、桌面聊天标题编辑；后端 45 passed + Desktop 39 passed |

说明：T51 的标题会合并普通空白、拒绝不可显示控制字符、限制长度，并在存在活动操作时拒绝修改。标题变更通过现有状态存储持久化；桌面仅在会话静止时显示铅笔图标和内联输入，不会创建新会话或修改聊天记录。
| T52 | 持久化任务图增强：旧数据兼容、依赖关系、任务领取、并发写入与任务生命周期钩子 | 已完成 | `arforge/tools/task_tools.py`、`task_created`/`task_completed` 门禁事件、`tests/test_task_graph_tools.py`；新旧定向回归 61 passed |

说明：T52 保留既有 `tasks.json` 列表格式以及创建、列出、完成、删除、搜索函数，在原能力上增加描述、活动标签、负责人、元数据和双向依赖。写入采用线程锁、跨进程锁、原子替换和 ID 高水位；自依赖、缺失依赖和环形依赖失败关闭。创建/完成钩子的 `block` 或 `ask` 决策会在落盘前终止操作。
| T53 | 执行中结构化提问：终端/Bridge/Desktop 共享工具、暂停恢复、单选多选、自定义答案与预览 | 已完成 | `arforge/product/question_runtime.py`、`ask_user`、`question.get/respond/reject`、桌面问题卡；跨模块回归 98 passed，桌面 42 passed |

说明：T53 将问题绑定到当前会话和操作，回答后继续同一工具循环，不创建新的聊天轮次。重复回答、跨会话回答、无效选项和超时均失败关闭；非交互终端明确返回不可交互错误，不会无限等待。问题状态仅属于本地运行操作，不会修改工作区，也不会在重启后伪恢复。
| T54 | 标准语言服务能力：定义、引用、悬停、符号、实现、调用层级、诊断及索引降级 | 已完成 | `arforge/lsp_runtime.py`、`language_service`、`language_service_status`、真实 `pylsp` 烟雾测试；跨模块回归 101 passed |

说明：T54 复用现有多语言 tree-sitter/引用索引作为显式降级层，优先通过固定本机命令连接 Python、JavaScript/TypeScript、Go、Rust 语言服务器。进程无 Shell、环境最小化、路径受工作区授权约束，文件和消息上限 10 MB，请求有超时；未安装服务器不会伪报完整语义结果。当前机器真实验证 Python `pylsp`，其他后端按实际安装状态报告。
| T55 | 结构化笔记本能力：单元格读取、替换、插入、删除、类型转换、并发保护与过期检测 | 已完成 | `arforge/notebook_runtime.py`、`notebook_read`、`notebook_edit`；笔记本与权限专项 40 passed，跨模块回归 150 passed |

说明：T55 保留既有通用文件工具，在其上增加面向 `.ipynb` JSON 结构的专用能力。写入必须携带上次读取返回的 SHA-256，并在跨进程锁内重新校验；修改代码单元会清空旧执行序号和输出，类型转换会维护合法字段形状，未知笔记本与单元格元数据保持不变。文件、单元格、源码和输出均有资源上限，写入复用现有备份、确认和原子替换边界。动态权限分类同步补齐工作区越界判断和 `notebook_path` 参数识别。
| T56 | 会话级受管工作树：进入、状态、保留/删除退出、并发隔离、重启恢复与所有权校验 | 已完成 | `arforge/worktree_runtime.py`、`arforge/workspace_context.py`、`worktree_enter/status/exit`；真实 Git 专项 13 passed，跨模块回归 192 passed |

说明：T56 保留既有 Git 分支、检出和一次性工作树创建接口，在其上增加会话所有权和完整退出生命周期。Bridge 不修改进程全局当前目录，而是在每个操作线程中绑定会话上下文，既有文件、命令、Git、代码检索、语言服务、笔记本、测试与工作流工具动态取得对应工作树。删除前统计未提交文件和基线后的新增提交，状态未知时失败关闭；仅显式 `discard_changes=true` 可丢弃工作。持久化记录采用原子替换和跨进程锁，激活与清理前重新验证受控目录、分支前缀和会话归属，状态文件被篡改也不能重定向到手工工作树或主分支。
| T57 | 会话级提示调度：五段 cron、单次/循环、会话内/跨重启、错过任务确认与并发所有权 | 已完成 | `arforge/scheduled_prompt_runtime.py`、`schedule_create/list/delete/run_missed`、Bridge 调度接口；调度与会话专项 25 passed |

说明：T57 不复用或修改 MCP 内部维护调度器，而是新增职责独立的用户提示调度层。到期提示重新进入现有会话聊天路径，因此权限、沙箱、工作树、工具审计和取消语义保持不变。循环任务使用确定性抖动并在七天后到期；进程离线期间错过的单次任务只标记为 `missed`，必须由用户明确确认后才能在当前回合执行。
| T58 | 会话标签与筛选：持久化标签、大小写无关匹配、项目/状态/标签/标题查询与分支继承 | 已完成 | `bridge_session_tags`、`session.tags.update`、扩展 `session.list`；组织与恢复专项 40 passed |

说明：T58 在既有会话表之外使用规范化关联表，不改写旧会话字段。标签限制数量、长度和控制字符，更新时要求会话静止；会话分支复制标签，重启后恢复，旧的无标签调用继续保持原行为。
| T59 | 会话检查点与安全回退：持久化检查点、预览、并发令牌、上下文重建与副作用隔离 | 已完成 | `bridge_session_checkpoints`、`session.checkpoint.*`、`session.rewind.*`；状态恢复/消息/导出联合回归 40 passed |

说明：T59 仅回退可见对话上下文。应用前必须先预览并提交 `expected_last_sequence`，历史在预览后发生变化会返回过期错误。被回退消息保留为有界本地归档并从恢复、导出、搜索、计数和模型上下文中排除；文件、命令、Git 和外部副作用不会被静默修改，仍由既有 diff 回滚或 `run.revert` 明确处理。
| T60 | 延迟工具发现与按需架构激活：核心工具常驻、重型本地/MCP 工具搜索、运行隔离和下一步可调用 | 已完成 | `arforge/tool_registry.py`、`tool_search`、动态 schema 刷新、`deferred_tool_loading`；新增 10 passed，联合回归 95 passed |

说明：T60 默认关闭功能标志时继续导出原有全量工具架构。启用后，文件、命令、测试、计划、提问、任务和子代理等核心能力立即可用，浏览器、Web、Notebook、语言服务、工作树、工作流、调度、资源处理和动态 MCP 工具通过 `tool_search` 按精确名称、`select:` 列表、关键词评分或 `+必选词` 激活。选择状态仅属于当前 Agent 运行，不跨线程、嵌套运行或会话泄漏；模型每一步调用前重新取得工具架构，因此搜索命中的工具下一步即可真实调用。同步恢复 `ToolLoopResult` 对象契约、任务恢复消息、附加系统约束和 token 回调，同时提供只读字典兼容，不替换既有调用方。
| T61 | 会话所有团队生命周期与持久邮箱：有界角色成员、定向/广播消息、优雅停机握手和无遗留清理 | 已完成 | `arforge/team_runtime.py`、`arforge/tools/team_tools.py`、Bridge 团队接口；新增 10 passed，跨模块 110 passed |

说明：T61 保留原有单次多代理 `AgentChannel` 和 Dispatcher，不把短任务子代理替换为隐藏常驻进程。新增团队控制面按 lead 会话所有，每个会话最多一个团队、最多八名协作者，每个成员唯一映射到一个已注册子代理角色。消息只能投递给本团队成员或本团队广播，子代理工具根据当前安全角色解析成员身份，不接受外部 team ID 或 session ID。成员删除必须经过 lead 停机请求和该成员自己的批准；拒绝时恢复活动状态且必须给出原因。存在活动成员时团队不能删除，存在团队时 Bridge 会话不能关闭；最终删除会原子清除团队、邮箱和停机记录，避免遗留状态。
| T62 | 生产级 MCP 客户端传输、资源与认证：有界 stdio/HTTP/SSE、重连、动态工具刷新和凭据隔离 | 已完成 | `arforge/mcp_client_runtime.py`、资源工具、服务端资源/提示协议；新增 10 passed，联合回归 115 passed |

说明：T62 保留原有 MCP 服务端、插件、资源、提示、采样和外部桥接接口，并让原有 `MCPConnection` 导入透明获得生产级 stdio 实现。stdio 子进程不经过 Shell，使用最小环境、隐藏窗口、独立代际读取队列、真实超时、取消、响应与 stderr 上限；HTTP/SSE 仅允许回环明文或远程 HTTPS，拒绝 URL 内嵌凭据和片段，支持会话头、SSE 端点引导、幂等重试与重连。Bearer 令牌按请求从指定环境变量解析；OAuth 客户端凭据通过宿主回调取得密钥，只在内存缓存短期访问令牌，公开状态、异常和对象表示不暴露令牌、密钥或 URL 查询内容。外部工具架构先完整校验再替换，刷新返回新增、移除和变更集合，规范化名称冲突使用确定性后缀，真正冲突在卸载旧工具前失败关闭；动态参数完整透传，但服务器与远端工具身份由宿主闭包固定，不能由模型参数重定向。Agent 只获得连接列表、资源读取和架构刷新工具，不能自行创建连接或读取凭据。
| T63 | 主动用户消息与本地附件交付：主回答覆盖、分类、授权校验、Bridge 持久化和桌面附件卡片 | 已完成 | `arforge/user_message_runtime.py`、`deliver_user_message`、`delivery_json`、Desktop/Tauri；专项 4 passed，联合回归 67 passed，桌面 43 passed |

说明：T63 在原有回答、推理、工具事件和产物通道之上增加独立交付元数据，不替换既有消息模型。Agent 可将普通回复或主动完成/阻塞/状态更新明确发布为主回答；一旦发布，后续模型尾声不再重复流式显示。附件仅允许当前或额外受信工作区内的现有普通文件，拒绝符号链接、越界路径、可执行类型、超限单文件和超限总量，并记录 MIME、大小、显示名、SHA-256 与稳定产物 ID。文件保持本地，协议固定声明未上传，模型没有上传端点或凭据入口。Bridge 发送 `message.delivered`，持久化 `delivery_json`，恢复、导出和会话分叉均保留分类与附件；桌面显示主动更新标识和附件卡片。Tauri 打开文件/目录前规范化并验证路径，直接调用操作系统程序，不经过 Shell。
| T64 | 提供商中立触发器 API：本地/HTTPS 配置、固定生命周期、进程内认证和 Bridge/Agent 入口 | 已完成 | `arforge/trigger_runtime.py`、`trigger_manage`、Bridge `trigger.*`；专项与联合回归 116 passed |

说明：T64 从参考实现中提取可迁移的 `list/get/create/update/run` 契约，不复制其私有托管地址、组织字段或品牌认证。保留的 `local` 配置复用 Arforge 原有会话调度器，并增加有界名称、启停、查询、部分更新和立即运行；原有 cron、持久所有权、错过任务确认、单进程调度、抖动、过期和权限链保持不变。远程配置只能由宿主通过环境 JSON 或 Python API 预置，模型与 Bridge 不能提交 URL、令牌、认证头或配置定义。非回环 HTTP 被拒绝，远程必须 HTTPS；URL 内嵌凭据、片段、查询和重定向均失败关闭。Bearer 按请求从命名环境变量读取，OAuth 复用 MCP 的内存短期令牌提供器；令牌不进入 Shell、工具参数、公开状态、对象表示或安全错误。请求/响应大小、ID、JSON 深度、超时和头字段均有边界，Agent 网络工具需要明确确认。
| T65 | 协作式等待、外部唤醒与周期检查：无 Shell、有界时长、会话隔离、取消和操作超时 | 已完成 | `arforge/wait_runtime.py`、`cooperative_wait`、Bridge `wait.active/wake`；新增 7 passed，联合回归 60 passed，桌面 43 passed |

说明：T65 在原有后台命令、任务图、调度器和结构化提问之外增加独立的协作等待原语，不替换任何已有异步能力。每个会话最多一个活动等待，时长、检查间隔和检查事件总量均有明确上限；运行时不启动 Shell 或外部休眠进程。等待继承当前会话、操作取消事件、单调时钟截止时间和 Bridge 事件回调，即使低风险工具由线程池并行执行也不会丢失上下文。宿主可使用后端签发的 wait ID 查询和唤醒，错误会话、过期 ID 和重复唤醒失败关闭；桌面仅记录开始和终态，周期检查不会刷屏。
| T66 | 桌面会话运营控制：标签编辑/筛选、计划任务生命周期、错过任务确认、检查点和二阶段回退 | 已完成 | `SessionControlCenter`、侧栏标签筛选、聊天操作接管；桌面 46 passed、生产构建通过、1440/720 视口无横向溢出 |

说明：T66 只调用既有 Bridge 1.2 契约，不在桌面复制调度、标签或检查点状态。侧栏筛选将逗号分隔标签规范化后提交给 `session.list`；会话运营页支持标签保存，计划任务创建/列表/删除，以及错过单次任务的明确确认运行。错过任务返回的操作由原聊天控制器接管并重放已缓冲事件，不会静默留在后台。回退必须先取得预览，明确显示受影响消息数量和“不会撤销文件、命令、Git、外部副作用”的边界，再使用预览中的并发序号二次确认应用；成功后从 Bridge 重新载入会话正文。视觉验证覆盖 1440px 与 720px，修复了窄窗口表单挤压，横向溢出和控件重叠均为零。
| T67 | 可选模态键盘交互：默认关闭、插入/导航状态、编辑命令、输入隔离与无障碍退出 | 已完成 | `desktop_modal_keyboard`、`modalKeyboard.ts`、聊天编辑器状态控件；桌面 54 passed、生产构建与体积预算通过、1440/720 视口核验通过 |

说明：T67 复用现有受审计特性开关，不增加平行设置文件。功能默认关闭，关闭时聊天输入保持原生行为；启用后仅聊天编辑器获得插入/导航状态，支持计数、行/词/上下移动、查找与重复、插入转换、行与范围操作、寄存器粘贴、替换、大小写切换、合并和新建行。中文输入法组合事件、Ctrl/Meta/Alt 快捷键、Tab 以及标题、标签、设置、结构化提问等其他输入框不会被接管。导航状态将文本框设为只读并暂停语音输入，`Esc` 可进入导航，`i/a/I/A/o/O` 或可点击状态按钮可返回编辑。窄屏输入器同时修复为基于实际内容区收缩并允许上下文控件换行，避免右侧操作被裁切。
| T68 | 企业级兼容性与全量回归收口：旧式子代理扩展、评测双接口、运行指标、会话导出、CLI、工作区与工具契约 | 已完成 | 后端四段全量回归 `2348 passed, 2 skipped`；Desktop `54 passed`；Ruff、TypeScript/Vite、Rust 与 200 KiB 包体预算全部通过 |

说明：T68 不替换 Arforge 的多步智能体、团队、评测或指标实现，而是在其上补齐向后兼容边界。子代理仍默认走真实工具循环，但显式旧式 `_run` 扩展和测试注入可稳定回退；团队通信工具仅在团队上下文开放。评测运行器同时接受旧的 `runner(prompt)` 与新的 `runner(task, workspace)`，保留确定性检查、裁判和代码执行评分。运行指标重新以令牌数据库和 dogfood 结果为真实数据源，分别降级并合并时间序列。会话产物导出保持旧字段精简，同时按需保留图像、显示名和校验值。角色重新注册会清理对应热缓存，避免插件或测试顺序污染。禁止的参考产品名在维护源码、测试和文档扫描中为零。

---

## 7. 2026-07-16 T1-T36 当前状态审计（append-only）

本节不覆盖上方历史状态，而是以当前代码、自动化测试、真实运行和发布审计结果为准，给出可复核的最新结论。

### 7.1 已完成代码实现与自动化验收

- **T1、T2、T4-T21、T29-T32、T34、T35：已完成。**
- T1 已具备优雅中断、下一次模型调用前追加运行中指令以及控制文件触发；`tests/test_v1_g13_interrupt.py` 覆盖停止优先级、指令注入和真实轮询。
- T2/T4 已具备多语言符号、LSP 降级和跨文件一致性检查；T6-T21 均有对应生产模块和专项测试。
- T29-T32 已完成 MCP stdio、HTTP/SSE、会话、中间件、生产硬化、资源、提示、采样和外部工具桥接。
- T34 已完成代码切块与混合检索；T35 已提供 FastAPI/SSE 服务、Docker 入口和专项测试。
- T12 的桌面交互已进一步完成真实错峰验收：Bridge 流事件、推理增量、工具时间线、答案流式输出和完成状态均可见。

### 7.2 对话样式真实验收

- 桌面端与 CLI 已分别独立启动、错开实测，避免 Bridge、模型请求和终端刷新互相干扰。
- 桌面端已达到“工作计时 -> 推理增量 -> 多工具过程 -> 流式答案/完成状态”的参考节奏，不再长期停留在静态“正在思考”。
- CLI 已达到“任务提交 -> Thought 计时 -> 树形工具节点 -> 后续推理 -> token 增量答案 -> 工作完成”的参考节奏。
- 相关自动化基线：CLI 对话与流式专项 `42 passed`；Desktop `56 passed`，TypeScript/Vite 生产构建通过。

### 7.3 部分完成或依赖外部证据

| 任务 | 当前状态 | 尚缺条件 |
|---|---|---|
| T3 | 部分完成 | dogfood 机制与指标已完成，但当前真实记录仅 `6/50`，必须通过持续真实使用积累，不能用合成记录冒充 |
| T22 | 本地基础完成，发布验收未完成 | unsigned 安装器/生命周期基础存在；当前 `INSTALLER-01` 仍有人工和阻塞项，不能视为可发布候选 |
| T23 | 外部阻塞 | 需要真实 Authenticode 证书、私钥托管、RFC3161 时间戳和受保护 CI 环境 |
| T24 | 外部阻塞 | 需要基于真实签名候选执行升级/降级矩阵 |
| T25 | 外部阻塞 | 自动化无障碍检查已具备，仍需原生键盘、屏幕阅读器和 125%-200% 缩放证据 |
| T26 | 外部/人工阻塞 | 需要凭据治理清零、PostgreSQL 恢复演练、历史与遗留文件人工决策、受审发布基线 |
| T27 | 外部阻塞 | 需要真实 provider staging、负载、长跑和真实场景 dogfood |
| T28 | 外部阻塞 | 只有 T22-T27 全部通过后才能生成最终不可变发布证据并解除 `DO NOT SHIP` |
| T33 | 部分完成 | 学习模块碎片已归档/收敛且质量门禁可运行，但当前工作树并非干净发布基线，mypy 尚未成为全仓硬门禁 |
| T36 | 未完成 | 尚缺面向外部验收的正式两分钟演示成片；当前桌面和 CLI 实测截图可作为素材，不替代最终交付视频 |

### 7.4 当前发布结论

- `arforge ship-gate` 当前正确返回 **DO_NOT_SHIP**。
- 阻塞门禁包括 `INSTALLER-01`、`SIGN-01/02`、`UPGRADE-01`、`A11Y-01`、`GOV-01`、`STAGE-01` 和 `SHIP-01`。
- 因此可以表述为：**参考实现中可迁移、提供商中立且可在本地代码层完成的功能已基本融合；企业发布与真实运营验收尚未全部完成。**
- 维护源码、测试、脚本和文档的文本扫描不含禁止的参考产品品牌名；扫描应排除 `__pycache__`、构建产物和外部依赖。

### 7.5 最终质量门禁证据

- 后端全量：`2364 passed, 2 skipped, 1 warning`。唯一 warning 来自 FastAPI/Starlette 测试客户端等待迁移到 `httpx2` 的第三方弃用提示。
- 修复了 `eval` 在工作区未受信任时仍启动评测的失败关闭缺口；现在任何评测执行前先通过统一信任入口。
- 修复 Windows 评测子进程按 GBK 解码 UTF-8 输出导致的线程异常；代码执行裁判统一显式使用 UTF-8 并替换非法字节。
- Desktop：`9 test files passed, 56 tests passed`；TypeScript/Vite 生产构建通过；Rust `cargo check` 通过。
- Ruff 全仓通过；Python `compileall` 通过；核心模块导入验证 `26/26`；`git diff --check` 通过。
- 维护源码、测试、脚本和文档品牌文本扫描通过。

### 7.6 2026-07-18 本地项目就绪收口

- 完成参考实现快照的提供商中立能力复核：75 个 crate 清单、2,185 个 Rust 源文件，覆盖智能体、会话、工具、工作区、记忆、扩展、长任务和可观测性；本地能力映射见 `docs/LOCAL_PROJECT_READINESS.md`。
- 新增真实 `arforge code --workspace <dir>` 契约。目标必须是现有目录，参数不会进入模型提示；命令执行期间同时绑定 CWD、环境和 ContextVar，结束后恢复进程状态。
- 开发启动器只自动信任 Arforge 自身仓库，外部 `--workspace` 不继承自动信任；相对路径在启动器切换目录前解析。
- CLI 重复进程内调用会恢复权限默认值，避免一次完全访问模式污染后续工作区；交互式会话直接调用也恢复原状态。
- 多智能体单例直接访问会在线程安全边界内加载八个具体角色，修复临时测试/扩展覆盖可能遗留错误角色类的问题。
- 真实模型—工具只读烟雾通过：显式工作区、Plan Mode、4 步上限、1 次文件读取，最终成功、0 工具错误、无文件修改。
- 最终后端四分片回归 `2515 passed, 1 skipped`；唯一 skip 为本机未安装 Rust tree-sitter 语法包。Desktop `60 passed`，TypeScript/Vite 生产构建通过；Ruff、compileall、diff 检查和参考品牌扫描通过。

### 7.7 2026-08-01 Harness 独立复评与门禁补强

| # | 任务 | 状态 | 证据 |
|---|---|---|---|
| T69 | Harness 自评盲点补强：provider 工具选择、创建后测试顺序、版本入口、CI、可观测性隔离与双层子代理权限边界纳入确定性契约 | 已完成 | `capability-eval` 从 19 项扩展到 25 项；恢复 `.github/workflows/ci.yml`；token 计量故障改为 fail-open；`statusline` 从伪只读修正为 `workspace_cmd`；DeepSeek 兼容模型目录恢复；doctor 输出可执行的版本漂移修复指令 |

说明：T69 不把确定性组件契约冒充模型端到端成绩。`capability-eval` 继续显式声明 `model_invoked=false` 与 `autonomous_project_validated=false`；真实模型正式任务、staging、长跑和外部发布证据仍分别受既有评测与发布门禁约束。

| T70 | 两套子代理实现架构收敛：轻量 Task 入口与 DAG 编排入口共享角色注册表和 Worker Runtime | 已完成 | `SubagentRoleSpec` 成为 15 个轻量角色与 8 个编排角色的单一元数据源；`SubAgentPool` 删除重复默认表；两入口统一调用 `execute_subagent_loop`；保留 Task/Conversation/Channel/Pool 作为编排层；`capability-eval` 增加 `ma4-unified-worker-runtime` |

说明：T70 保留 `arforge.core.subagent`、`spawn_subagent` 和 `SubAgent` 公开入口作为兼容 facade。内置具体 Agent 类只声明角色身份，tools/capabilities/prompt/max_steps/required evidence 由统一规格在类创建时绑定；自定义 `CustomAgent.*` 仍由 pool 管理并保留旧式 `_run` 兼容路径。
