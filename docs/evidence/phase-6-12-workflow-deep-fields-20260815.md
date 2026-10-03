# Step 6.12 / 6.13 Workflow 深层字段与桌面体验证据

- 日期：2026-08-15
- 计划基线：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`
- 范围：开发期 Workflow Graph 收敛、并发/权限可见性、前端用户体验；不包含发布、部署或 staging
- 分支：`codex/phase-0-checkpoint`
- 远程状态：未执行 push

## 本次补齐

此前 durable workflow 已在 `DurableRun` checkpoint 中保存不可变定义 digest、节点状态、审批范围、预算、调度 gate、child run 和恢复信息，但 API/UI 只投影了浅层运行状态。本次完成边界层收敛：

1. Core `RunRecord` 投影 `definition_digest`、预算摘要和安全的调度摘要；不向 UI 暴露 definition prompt、credential 或 secret。
2. Core `NodeRecord` 投影节点预算预留次数和可选 `child_run_id`，同时保留旧字段兼容。
3. Workflow preview 返回 kind、access、max attempts、dependencies、continue-on-error 和 condition；这些字段在 schema 中采用可选兼容形式，旧响应仍可被读取。
4. Server API 对 run/node 深层字段执行 typed decode，生成 client 类型已重新生成。
5. 桌面 Workflow UI 增加渐进式“步骤约束”和“运行技术详情”，把 access、依赖、条件、预算、调度动作与执行模式转换为中英可读标签；定义 digest、子运行 ID 等技术值只在详情中展示。
6. 预算时长按毫秒、秒、分钟、小时显示；Workflow 控件补足触控高度，避免把内部单位直接呈现给普通用户。
7. 桌面验收新增 preview 约束、定义摘要、预算和调度字段的中英可见性断言，并修复 Windows E2E 清理阶段的无界等待。

## 计划符合性

- Step 6.12：生产执行仍由 `DurableWorkflowGraphRuntime` + `DurableRun` 负责；旧 SQL workflow runtime 保持迁移/兼容用途，不新增第二套生产 writer 或 lease authority。
- Step 6.13：独立 read 节点并发、workspace write lane 独占、child capability/budget 限制、approval downstream freeze、pause/cancel 传播和 DurableRun recovery 仍由已有核心实现负责，本次增加了可观察投影和用户验证。
- 调度 gate 继续 fail-closed：没有结构化收益证据时不会自动进入 multi-agent execute mode；UI 显示 single/candidate/multi 的安全标签和原因。

## 新鲜验证

```text
packages/core targeted workflow/child/recovery tests       23 pass, 0 fail, 101 expects
packages/arforge durable workflow operations API           1 pass, 0 fail, 15 expects
packages/arforge HttpApi/OpenAPI regression                20 pass, 0 fail, 579 expects
packages/app workflow presentation/UI regression             9 pass, 0 fail, 33 expects
packages/schema/core/server/arforge/app/client typecheck   PASS
packages/app typecheck:e2e                                  PASS
packages/app production build                               PASS
```

桌面重复性验收：

```text
artifacts/desktop-repeatability-audit.json
requested_rounds=3, completed_rounds=3, passed=true
isolated_profile_per_round=true, flaky_failures_ignored=false
round durations: 60347ms, 59042ms, 59584ms
```

三份新鲜 round audit 均满足：`rendererErrors=0`、`failedRequests=0`、`workflowUserExperienceVisible=true`、`workflowDeepFieldsLocalized=true`。每一轮均使用隔离 profile；没有把旧 round 文件与本次结果混用。

## 约束与未声明事项

- 当前证据是本地开发功能和本地桌面 E2E 证据，不是 signed release、canary、rollback、staging 或生产部署证据。
- 真实 provider、多租户 staging、跨进程 worker 和发布运维仍按计划后置；本次没有调用外部 provider，也没有读取或写入任何密钥。
- 工作树原本包含其他阶段的大量未提交修改；本 checkpoint 只纳入本次 Workflow 深层字段、前端体验、E2E 清理修复、测试和本证据文档。
