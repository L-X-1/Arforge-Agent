# Step 8.1 Child Run V1 — RFC

状态：已冻结（用户确认推荐策略），进入代码实现。本文冻结 Step 8.1 的最小边界；Mailbox/A2A/Personal AI OS 留到后续步骤。

## 目标

把现有 `task` 子代理、Team/TaskGraph 的执行关联统一到 `DurableRun`，使一次子代理执行具备可恢复、可取消、可审计的父子关系，同时不改变旧 SessionRun 历史的解码合同。

## 拟议模型

Child Run 仍是一个 `SessionRun`，其 `id` 是 `childRunID`，并携带不可变的 delegation binding：

- `parentRunID`：父 DurableRun；禁止环、禁止跨租户/跨项目引用。
- `delegatedObjective`：经过长度限制和脱敏的目标描述。
- `allowedCapabilities`：服务端结构化的 action/resource 范围；不携带 token、secret 或 opaque capability 对象。
- `budget`：子 Run 的 attempts/duration/cost 上限，不能超过父 Run 当前可下放额度。
- `project/location`：子 Run 的固定执行作用域。
- `expectedDeliverable`：摘要、允许的 artifact/evidence 类型以及 verifier 约束。
- `deadlineAt` 与 durable cancellation state：到期或取消后不得开始新 attempt，正在执行的 attempt 必须进入 interrupted/cancelled 收敛路径。

结果不写入临时内存作为事实来源；由 DurableRun 事件记录 `resultDigest/status/artifactRefs/evidenceRefs`，查询端只暴露 safe projection。

## 不可突破的安全规则

1. Child 默认 read-only；父权限不自动继承。
2. 每个允许的 action/resource 必须在创建时显式下放，并在 ActionGateway 再次校验 parent/child binding、policy version 和剩余预算。
3. Child 不能创建更高权限的 child；递归深度和并发数由 DurableRun admission gate 限制。
4. Parent、Child、Session、TaskGraph、Team 的 ID 分别保留各自语义；现有 session `parentID` 只表示会话树，不替代 `parentRunID`。
5. 旧 `agent.run.*` 事件保持可回放；Child 专用字段采用向后兼容的可选 schema 或新的版本化事件，不修改旧事件的必填语义。
6. Parent 取消/到期时，未完成的 descendants 进入 durable cancellation；恢复时 fail-closed，不依赖单进程 Fiber 或 BackgroundJob 状态。

## 最小实现面

- Schema：Child delegation、result receipt、cancel/deadline；父子 Run 合同和 bounded errors。
- DurableRun：`createChild`、`listChildren`、admission（capability subset、budget、depth、deadline）、cancel/recover。
- Event manifest：创建、取消、结果记录的版本化 durable events。
- SQLite/PostgreSQL：如事件 payload 已足够，不新增平行事实表；必要 projection 必须同时有 migration/RLS/restore 合同。
- Task tool vertical slice：现有子代理创建/恢复/前台等待/后台通知改为由 Child Run 状态驱动，旧 session UI 作为 projection。
- 测试：正常、越权 capability、预算超额、循环父子、deadline、取消竞态、崩溃恢复、幂等、SQLite/PostgreSQL。

## 暂不实现

- 跨主机 A2A 和远端 agent identity；
- Mailbox 新协议（Step 8.3）；现有 Team message 只作为兼容 projection，不获得 capability；
- 自动多代理拆分收益策略（Step 8.2）；
- 多租户平台发布与计费。

## 已确认策略

1. 父类型限制为 `SessionRun -> Child SessionRun`；`ControlRun` 作为后续受控编排能力，本阶段不扩展为子运行。
2. Capability 采用显式 `action + resources` 白名单；Child 默认只读，任何写操作都必须逐项授予，不因父运行权限更高而隐式继承。
3. Child admission 时从父运行剩余预算中预留子预算；完成后按实际使用量结算并释放未使用预留。父运行取消或到期时，递归取消所有非终态 descendants；取消传播失败按 fail-closed 处理。

上述策略是 Step 8.1 的实现约束；后续代码、测试和证据均以此为准。
