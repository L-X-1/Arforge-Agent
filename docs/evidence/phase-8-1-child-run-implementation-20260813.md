# Step 8.1 Child Run 实现与退出闸门

日期：2026-08-13
状态：完成本阶段实现与回归，待 checkpoint 提交；Step 8.2 尚未开始。

## 范围

本阶段以已冻结的 [Child Run RFC](./phase-8-1-child-run-rfc-draft-20260813.md) 为准，将 canonical TypeScript runtime 的子代理执行统一到 `DurableRun`。没有新增平行 child-run 事实表；父子关系、预算预留/结算、取消、结果 digest 和恢复均由 EventV2 的 DurableRun aggregate 记录。

## 已实现

- `AgentRuntime` 增加 versioned child binding、bounded capability、budget reservation/settlement、deadline/cancellation 和 result receipt 合同，并加入事件 manifest。
- `DurableRun.createChild` 使用 `parentRunID + idempotencyKey` 派生稳定 child ID；校验父类型、项目/路径、显式 capability 子集、最大深度、预算、未来 deadline 和幂等漂移。
- child 的 parent reservation 与 child aggregate 创建支持崩溃间隙恢复；终态按实际 usage 结算父预算，取消递归传播到 descendants。
- `ActionGateway` 在最终 effect boundary 重新加载 child，校验 session、状态、deadline 及每个 action/resource request；read capability 不得执行 L2+ 语义，缺失或过期合同 fail-closed。
- `TaskTool` 的 foreground/background/resume 路径绑定 child Run；内部 prompt 传递 durable `runID`，结果按 completed/failed/cancelled 收敛并记录 receipt。子 Run 默认 read-only，写 capability 只能通过参数显式提出。
- Workflow agent node 使用 `createChild`，节点状态只保留 child ID 投影；父级 pause/cancel、attempt、recovery 和结果由 DurableRun 驱动。正常会话根 Run 现在持久化真实 `project/location` 及显式 delegable capability scope。
- Python CLI 的兼容 fork 配置已改为 `plan`、不继承工具，并在 prompt 中明确父上下文不授予权限。Python 角色/工具安全 hook 仍是兼容适配层；它没有被提升为新的 DurableRun 事实源，也未纳入 Step 8.2 自动调度。

## 验证结果

| 检查 | 结果 |
|---|---:|
| `bun run typecheck` | 22/22 packages 成功 |
| DurableRun child + durable-run + workflow tests | 47 pass，0 fail，198 expects |
| ActionGateway full test file | 86 pass，0 fail，448 expects |
| TaskTool test file | 21 pass，0 fail，76 expects |
| event manifest test | 2 pass，0 fail |
| Python child/fork/multi-agent boundary tests | 74 passed |
| Python Ruff（本阶段改动文件） | passed |
| `git diff --check`（本阶段改动文件） | passed；仅报告既有 CRLF→LF 提示 |

## 未宣称内容与后续边界

- 本阶段没有重新宣称完整 `packages/arforge` 全量测试通过；既有完整包运行在当前主机曾超过执行时限，因此只采用上述新鲜的 targeted gates 和全仓 typecheck。
- Step 8.2 的拆分收益模型、自动调度门禁、cost/time/token/conflict 对比尚未实现。
- Team/TaskGraph/mailbox 保留现有业务投影；Mailbox 新绑定协议属于 Step 8.3。Python CLI 兼容路径仍需后续明确退役或通过正式 A2A/bridge 接入 canonical DurableRun，不能直接写入新的 child-run事实源。
- 没有新增数据库 migration；当前事件 payload 足以承载本阶段合同，既有 SQLite/PostgreSQL schema、RLS、backup/restore 证据继续适用。
