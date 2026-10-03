# Step 6.12 — Workflow Graph 收敛证据

日期：2026-08-12

## 结论

Workflow Graph 已收敛到现有 `DurableRun` / `SessionRun` authority。生产 HTTP handler 不再创建或写入 `workflow_graph_runs`、`workflow_graph_nodes`、`workflow_graph_events`，旧 `WorkflowGraphRuntime` 仅保留为迁移与兼容输入。

## 实施映射

| 计划要求            | 实现                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| WorkflowRun family  | 使用现有 `AgentRuntime.SessionRun` 作为 workflow parent run；不新增第二套 lease authority。                                             |
| immutable Artifact  | workflow definition、`schema_version`、source path 和 canonical digest 以 `workflow-definition` artifact 固定在 DurableRun checkpoint。 |
| graph node → Step   | `DurableWorkflowGraphRuntime.stepsFor()` 投影为 `AgentRuntime.Step`；HTTP 仍输出兼容的 WorkflowNode 视图。                              |
| agent node          | 创建 child `SessionRun`，使用 child run 的状态与 checkpoint 完成节点。                                                                  |
| command node        | 只接受注入的 Shell Action executor；生产路径未提供 executor 时 fail-closed，不直接 spawn process。                                      |
| approval/checkpoint | 不调用模型；approval 由授权接口恢复，checkpoint 只记录工作流状态。                                                                      |
| lease/CAS/scheduler | worker 使用 DurableRun transition、checkpoint、lease、heartbeat 和 recovery；旧 graph lease 不再参与生产调度。                          |
| import/idempotency  | 相同 run ID + 相同 definition digest 返回既有 run；相同 ID + 不同 digest 返回 `RUN_DIGEST_CONFLICT`。                                   |

`permission_mode` 也固定在 checkpoint，并在恢复与 HTTP view 中保持一致；事件内部使用 1-based sequence，HTTP 层转换为公开 `type/data/next_after` 合约。

## 验证

- `bun run --cwd packages/core typecheck` — passed
- `bun run --cwd packages/server typecheck` — passed
- `bun test --cwd packages/core test/durable-workflow.test.ts test/workflow-graph.test.ts` — 11 passed
- `bun test --cwd packages/arforge test/cli/durable-workflow-api.test.ts` — 1 passed

HTTP E2E 覆盖：`workflowStart → waiting_approval → approve → child SessionRun → checkpoint → completed → workflowRunEvents`。
