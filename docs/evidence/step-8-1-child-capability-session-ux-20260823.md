# Step 8.1 Child Capability Session 与授权 UX 证据

- 日期：2026-08-23
- 计划位置：阶段 8 / Step 8.1 — 统一 Child Run 模型
- 分支：`codex/phase-0-checkpoint`
- 前置 checkpoint：`510d3751 fix(audit): harden phase 0-7 quality gates`
- 范围：显式 child capability 的 session 权限落地、父权限上限、恢复幂等、授权可见性
- 非目标：自动 fan-out、远程 A2A、真实 provider、token/cost 跨仓结算、发布与部署

## Definition of Ready

- 一句话目标：子代理只获得显式下放且不超过父 Agent + 父会话有效权限的能力，用户在批准前可看见动作、读写级别和资源范围。
- owner：`packages/core`（统一 admission）、`packages/arforge`（permission materialization）与 `packages/app`/`packages/ui`（授权呈现）。
- Schema/API/DB：不改数据库，不新增 API；复用已存在的 `AgentRuntime.ChildCapability` 和 permission metadata。
- 风险：权限扩大、恢复后旧规则残留、超大 metadata、授权 UI 隐瞒写能力。
- 回滚：本地 checkpoint 可逆；不修改远程状态。
- 用户可见行为：Task 授权卡显示“默认只读”或“请求写入”，并逐项显示 action 与 scope。

## 实现结果

### 1. Bounded admission 前移

TaskTool 在请求用户授权和创建 child session 之前执行与 DurableRun 一致的边界检查：

- capability 最多 64 项；
- action 长度 1–256；
- resources 为 1–128 项；
- 每个 resource 长度 1–1024。

超限输入直接失败，不创建授权请求，也不创建 child session。省略或传入空 capability 数组仍收敛为默认只读合同。

### 2. Fail-closed session permission

Durable capability 被转换为成熟工具权限 allow-list：

- 规则以 `* deny` 起始；
- 默认 `* / read` 只映射到 read、grep、glob、list、web fetch/search 和 MCP resource read；
- edit/write/apply_patch 与 shell 只有在显式 write capability 下可达；
- task 与 todowrite 未显式下放时保持 deny；
- 未下放的 `external_directory` 始终保持 deny。

父 Agent 与父 session 的规则只投影到已下放能力，保持原有 allow/ask/deny 顺序。这样父级 `ask` 不会在 child 中升级为 `allow`，同时父规则也不能让未下放工具从 deny 变成 ask/allow。

### 3. 恢复幂等

恢复旧 task session 时，系统用当前 bounded capability contract 替换旧/宽泛规则，不再重复追加。回归覆盖旧 session 中存在 `* allow` 的情形，并验证连续恢复不会增长或改变规则集。

### 4. 用户授权可见性

后端 Task permission request metadata 现在包含：

- `capability_mode`：`default-read-only` 或 `explicit`；
- `capabilities[]`：action、access、resources。

授权卡对 metadata 做独立 bounded validation，并以渐进披露方式显示：

- 默认只读说明；
- 写能力警告；
- 每项 Read/Write、action 和 scope；
- malformed 或超限 metadata 不显示误导性摘要。

英文、简体中文和繁体中文提供本地化文案，其余现有语言按项目既有回退机制使用英文基线。

## 新鲜验证

| 门禁 | 结果 |
| --- | ---: |
| Arforge capability + Task 定向 | 32 pass、0 fail、135 assertions |
| Prompt external-directory fail-closed | 1 pass、0 fail、7 assertions |
| App permission/i18n 定向 | 8 pass、0 fail、259 assertions |
| Core Durable child admission | 6 pass、0 fail、23 assertions |
| Arforge Agent + Task 扩大回归 | 76 pass、0 fail、250 assertions |
| App 全量 unit | 1034 pass、0 fail、3582 assertions |
| UI 全量 | 19 pass、0 fail、78 assertions |
| `packages/core` typecheck | pass |
| `packages/arforge` typecheck | pass |
| `packages/app` typecheck | pass |
| `packages/ui` typecheck | pass |

## 计划判定与后续

本子包关闭 Step 8.1 的 `allowed tools/capabilities` 用户路径和 fail-closed session enforcement。Step 8.1 尚未整体关闭：当前工作树中的 `maxTokens/tokensUsed`、child budget reservation/settlement 和真实 session usage 结算属于下一独立子包，必须与 Schema/Core/Arforge 测试一起审查和 checkpoint。

本轮未调用真实模型、未迁移数据库、未运行发布/部署/签名/staging，也未 push。
