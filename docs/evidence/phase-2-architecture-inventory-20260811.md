# 阶段 2.1–2.2：AgentRuntime 对象与 Task 语义只读盘点

> 登记时间：2026-08-11；本文件只记录当前源码事实和 V2 规定的语义决策，不执行数据库迁移、备份恢复、RLS 变更或桌面打包。
> 计划来源：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`。

## 1. 本轮范围

本轮对应 V2：

- Step 2.1：冻结 `AgentRuntime` V1 对象表的事实基线；
- Step 2.2：列出 Goal、TaskGraph、Workflow node、Session todo、Run/Step 的 owner、生命周期和持久化落点，避免产生第二套 Task 状态机。

检查的主要落点：

- `packages/schema/src/agent-runtime.ts`
- `packages/schema/src/goal.ts`
- `packages/schema/src/task-graph.ts`
- `packages/core/src/goal.ts`、`packages/core/src/goal/sql.ts`
- `packages/core/src/task-graph.ts`、`packages/core/src/task-graph/sql.ts`
- `packages/core/src/session/sql.ts`、`packages/arforge/src/session/todo.ts`
- `packages/core/src/event.ts`、`packages/core/src/event/sql.ts`
- `packages/core/src/runtime/durable-run.ts`
- `packages/core/src/runtime/durable-action.ts`
- `packages/core/src/runtime/sql.ts`、`packages/core/src/runtime/control-claim-index.sql.ts`

## 2. AgentRuntime V1 对象事实表

| 对象 | 当前 schema / identity | 当前 owner 与生命周期 | 当前持久化事实 | V2 处理结论 |
|---|---|---|---|---|
| Task | `AgentRuntime` 当前没有独立 `Task` schema；Run 的 `taskID` 使用 `TaskGraph.ID` | 业务目标语义尚未在 AgentRuntime 冻结 | 现有 `task_graph_task` / `task_graph_edge` 由 TaskGraph service 管理 | 必须只有一个业务 Task authority；先确定 adapter 方向，不新增并行状态机 |
| Run | `SessionRun`、`ControlRun`，ID 前缀 `run_`；包含 goal/task 引用、主体、预算、状态和时间 | `DurableRun`；draft → preflight/queued/running/recovering/verifying → terminal 等受限转换 | `EventSequenceTable` + `EventTable` 按 Run ID 形成 durable aggregate；`DurableRun.load` 严格校验顺序、schema、主体和状态重放 | 保持现有 durable aggregate，不再引入第二套 Run 状态机 |
| Step | `AgentRuntime.Step`，ID 前缀 `stp_`，绑定 `runID`、标题、序号和 Run 状态 | 当前只有 schema 级定义；执行节点 owner 尚未形成独立 service | 当前盘点未发现独立 `StepTable` 或 Step durable aggregate | 后续由 workflow/plan 投影为 Step；不能把 Step 当作业务 Task |
| Action | `SessionAction` / `ControlAction`，ID 前缀 `act_`，携带 semantics、resources、authority、run/step 关联 | `DurableAction` + `ActionGateway`；proposed → policy/approval → executing → observed/verifying/settled 等受限转换 | `EventSequenceTable` + `EventTable` 按 Action ID；`ActionProposed`、policy、authorization、state、attempt、observed、lease 事件重放 Snapshot | 保持 ActionGateway 为副作用唯一入口的收敛方向 |
| Observation | `AgentRuntime.Observation`，ID 前缀 `obs_`，绑定 Action，保存结果摘要、输出摘要、artifact 引用 | 由 Action observation 阶段产生；生命周期由 Action aggregate 约束 | 当前作为 `ActionObserved` durable event 的 payload 和 Snapshot 字段恢复，未发现独立 Observation 表 | 作为 Action 结果事实，不单独形成第二个执行状态机 |
| Artifact | `AgentRuntime.Artifact`，ID 前缀 `art_`，绑定 Action，带 URI、digest、kind 和可逆性 | 由副作用执行/观察阶段产出；实际存储由具体 artifact 工具决定 | 当前 schema 由 Observation 引用；本轮未发现统一 Artifact durable service/table | 后续按 Evidence/Artifact 合同补齐投影，不在本轮扩展 |
| Event | `EventV2`，事件 ID 与 durable version/aggregate/sequence 合同 | `EventV2.Service` 负责发布、序列 CAS、订阅和 replay | `event_sequence` 保存聚合序列，`event` 保存事件数据；DurableRun/DurableAction 共用这条事实源 | 继续作为 Run/Action 的唯一 durable 事件事实源 |
| Checkpoint | `AgentRuntime.Checkpoint`，ID 前缀 `chk_`，绑定 Run、event sequence、state digest、resume token | `DurableRun.checkpoint` / `checkpointControl` 产生；随 Run 恢复校验 | 作为 `RunCheckpointCreated` / control 对应 durable event payload 保存，当前无独立 Checkpoint 表 | 作为 Run 恢复点，不转成独立任务状态 |
| Evidence | `AgentRuntime.Evidence`，ID 前缀 `evd_`，含 source digest、trust、instructionAllowed 和摘要 | 当前主要是 schema 合同；Evidence service/投影尚未完成 | 本轮未发现统一 Evidence 表或 durable aggregate | 后续按 V2 Step 4 补齐来源、验证和投影 |
| MemoryRecord | 当前不在 `AgentRuntime` V1 schema 中 | 由现有 Memory 域管理 | 未映射为 AgentRuntime durable object | 后续阶段 4 做 Evidence/Memory 绑定，不在阶段 2 临时复制 schema |
| ExperienceRecord | `AgentRuntime.ExperienceRecord`，ID 前缀 `exp_`，绑定 Run 和 Evidence IDs | 当前是记录型 schema，完整 Verified Run → Experience pipeline 尚未形成 | 本轮未发现独立 Experience durable service/table | 后续阶段 3 处理，当前只冻结边界 |
| Skill | 当前不在 `AgentRuntime` V1 schema 中 | 由现有 Skill runtime/registry 管理 | 未映射为 AgentRuntime durable object | 后续阶段 5 通过受控编译链映射，不在阶段 2 新建平行 authority |
| PolicyDecision | `AgentRuntime.PolicyDecision`，绑定 Action、subject、authority、riskTier、decision、policyVersion | `ActionGateway` 计算；`DurableAction` 验证并重放 | 作为 `ActionPolicyEvaluated` durable event payload，并进入 Action Snapshot | 继续绑定 Action intent，不单独变成可漂移策略状态机 |
| EvaluationResult | `AgentRuntime.EvaluationResult`，ID 前缀 `eva_`，带 baseline/candidate、样本、差异、evidence | 当前为 schema scaffold，评测 service 尚未形成 | 本轮未发现独立 Evaluation 表 | 后续阶段 3 持久化，当前不提前迁移 |

## 3. 现有产品概念的 owner / 生命周期 / 持久化

| 概念 | owner | 生命周期 | 持久化落点 | 是否为 AgentRuntime Task authority |
|---|---|---|---|---|
| Goal | `packages/core/src/goal.ts` Goal service | queued/active/running/paused/blocked/completed/cancelled；每 Session 维护 active/queue 约束 | SQLite `goal`，session 外键、revision、queue、时间字段和 active partial unique index | 否；是用户/系统目标队列与产品 API projection，需通过 adapter 接入统一 Task 语义 |
| TaskGraph task | `packages/core/src/task-graph.ts` TaskGraph service | pending/in_progress/completed/cancelled；claim/release、revision 和 dependency edge | SQLite `task_graph_task`；依赖关系在 `task_graph_edge` | 是当前最接近业务 Task 的现有 authority 候选，但尚未以 `AgentRuntime.Task` 名义冻结 |
| Workflow node | Workflow domain / workflow service | 节点定义与运行节点分离；运行态尚待 V2 workflow 步骤统一 | 现有 workflow 表/定义域；本轮不把它当作 Task 表 | 否；应映射为 Run 内 Step 或 workflow projection |
| Session todo | `packages/arforge/src/session/todo.ts` UI tool/projection | replace-all 更新；按 position/status/priority 展示 | SQLite `todo`，按 session 和 position 保存 | 否；明确是 UI projection，不是 durable Task authority |
| Run | `DurableRun` | 一次执行，可恢复、租约、checkpoint、attempt 和 terminal 状态 | EventV2 durable aggregate | 否；一次执行，不是业务目标 |
| Step | 当前 schema/未来 workflow projection | Run 内计划节点 | 当前未形成独立 durable authority | 否；是 Run 内节点 |

## 4. 2.2 语义裁决与未决选择

V2 已明确的不可变规则：

1. Task 只表示用户或系统要完成的业务目标；
2. Run 表示一次执行；
3. Step 表示 Run 内的计划节点；
4. Goal/TaskGraph 若继续保留产品 API，必须通过 adapter 映射到 Task，不得长期双写两个 Task 状态机；
5. Session todo 只能是 UI projection。

当前源码事实显示：

- `AgentRuntime` 尚无独立 Task schema；
- `SessionRun.taskID` 与 `ControlRun.taskID` 已经指向 `TaskGraph.ID`；
- TaskGraph 已有 session-scoped durable CRUD、revision、owner claim 和 dependency edge；
- Goal 已有独立 queue/active 语义；直接把 Goal 当 Task 会把队列调度语义与业务目标语义混在一起；
- Session todo 已是事务性 replace-all 投影，不应升级为执行事实源。

## 4.1 产品 API 影响面

只读追踪到的现有入口进一步表明，两个 API 暴露的是不同的产品能力，而不是两个可以直接合并的状态机：

- `server.goal` / CLI `goal`：面向自主目标队列，包含 queue/active 约束、启动 Prompt、暂停/恢复、阻塞、取消、重排和 revision；`goal.run` 会创建 queued Session prompt 并唤醒普通 Session 执行。
- `server.taskGraph` / CLI `task`：面向 session-owned durable task，包含依赖图、环检测、claim/release、owner 冲突、revision、完成/取消和清理。
- `AgentRuntime.SessionRun.taskID` 与 `ControlRun.taskID` 当前已经是 `TaskGraph.ID`；若另建 `Task.ID`，需要同步修改 Run schema、RunCreated durable event、control claim 输入、协议/HTTP 合同和现有数据库数据。
- 因此 adapter 应放在 Core domain boundary：保留 Goal 与 TaskGraph 的外部合同，在统一 Task 语义下复用 TaskGraph identity；不得让 HTTP handler、UI 或 Python/CLI 自己维护映射状态。

因此本项目建议采用：**TaskGraph 作为现有 durable Task authority，Goal 通过 adapter 暴露 Goal/queue 产品 API，Session todo 继续作为 UI projection，Run/Step 只承载执行语义。** 这与 V2 的“保留产品 API、adapter 映射、禁止第二套状态机”一致，并能复用现有 Run 对 `TaskGraph.ID` 的引用，避免立刻进行破坏性 ID/表迁移。

但“是否正式把现有 `TaskGraph` 冻结为唯一 Task authority”属于会影响后续 schema、API、迁移和事件合同的产品/架构选择。本轮只读盘点到此为止，未擅自改动 schema 或数据库。

## 4.2 Step 2.2 实施结果

用户已确认采用推荐方案，已完成最小可验证实现：

- `packages/schema/src/agent-runtime.ts` 新增 `AgentRuntime.TaskID`、`TaskStatus` 和 `Task` 合同；Task 只承载业务 objective、session、状态、revision 和时间，不复制 graph dependency 或执行状态。
- `SessionRun.taskID` / `ControlRun.taskID` 改用同一底层 `TaskGraph.ID` 的 `AgentRuntime.TaskID` 别名；序列化 ID 与既有 durable event 合同不变。
- `packages/core/src/task.ts` 新增 `TaskV2` 只读 facade，仅提供 `get/list`，将现有 `TaskGraph.Info` 投影为 `AgentRuntime.Task`；没有 create/update/claim/complete 等写入口。
- `packages/core/src/location-services.ts` 注册 `TaskV2.node`，保证 UI、Handler、CLI 若需要统一 Task 语义只能通过 Core service 获取。
- `packages/core/test/task.test.ts` 2/2 验证 graph record 到业务 Task 的字段投影、schema 构造和 Core facade 真实读取；现有 `packages/core/test/task-graph.test.ts` 5/5 继续通过。

验证结果：`packages/schema` typecheck 通过，`packages/core` typecheck 通过，Task adapter 测试 2/2 通过，TaskGraph 回归 5/5 通过。未执行数据库迁移，未新增表，未修改 Goal/Session todo 的写模型。

## 5. 退出状态

- Step 2.1：已完成只读对象表和持久化事实盘点；
- Step 2.2：已完成 Task authority 决策和只读 Core adapter 实现；TaskGraph 是唯一持久化 Task authority，Goal/Session todo 未被升级为执行事实源；
- Step 2.3–2.9：未开始；
- Step 2.10 PostgreSQL migration/RLS、备份恢复演练：未执行，需单独授权；
- Step 2.11 crash injection、Step 2.12 Windows/Electron packaged E2E：未执行，按计划后置。
