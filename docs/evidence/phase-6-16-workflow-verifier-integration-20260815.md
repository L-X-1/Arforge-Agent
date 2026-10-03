# Step 6.16 Workflow 独立完成验证证据

- 日期：2026-08-15
- 计划基线：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`
- 范围：开发期 Workflow 完成门禁、API 投影、桌面用户可见性；不包含发布、部署、staging 或 signed release
- 分支：`codex/phase-0-checkpoint`
- 远程状态：未执行 push

## 发现的缺口

Step 6.16 要求“完成”由独立 verifier 和 completion gate 决定，而不是由模型停止原因直接决定。此前生产 Workflow 路径在所有节点成功后可以直接从 `verifying` 转为 `completed`，没有把 `VerifierRegistry` 结果和完成证据持久化到 `DurableRun`。

## 本次实现

1. `DurableWorkflowGraphRuntime` 在节点全部 settle 后先进入 `verifying`，冻结 workflow intent、observation、artifact ref、run/action/observation ID，并调用默认 `VerifierRegistry`。
2. 通过 `completionGate` 统一检查节点 settle、action settle 和 checkpoint 完整性；gate 不允许时进入 `failed`，不允许直接完成。
3. 将 `schema_version/action_kind/action_version/passed/total/passed_count/failed_checks/evidence_digest/evaluated_at` 作为受限验证摘要写入 DurableRun 状态、事件和 `RunRecord`，不写入 prompt、credential 或 secret。
4. Server schema、HTTP API、client generated types 和桌面 Workflow 技术详情同步暴露验证结果；普通用户看到“完成验证/验证检查/验证证据摘要”，内部字段仍只在技术详情中渐进展示。
5. 桌面 E2E 修复两处验收误报：批准后重新展开详情；完成状态等待条件改为匹配状态行，避免把“已完成 1”进度统计误判为运行已完成。
6. 桌面 E2E 的审批收尾改为点击审批弹层自身的关闭按钮，而不是向全局弹层栈发送 Escape；这样在审批请求刚完成、旧 DOM 仍处于 100ms 关闭动画时，不会误关闭底下的设置上下文。

## 验证结果

```text
packages/core typecheck                                      PASS
packages/core workflow/verifier tests                         19 pass, 0 fail, 95 expects
packages/arforge durable workflow API test                    1 pass, 0 fail, 17 expects
packages/arforge HttpApi/OpenAPI regression                   20 pass, 0 fail, 579 expects
packages/schema/server/client/app typecheck                   PASS
packages/app typecheck:e2e                                   PASS
```

新鲜单轮桌面验收通过，`artifacts/desktop-typescript-runtime-visibility-audit-closebutton2.json` 记录：

```text
rendererErrors=0
failedRequests=0
workflowUserExperienceVisible=true
workflowDeepFieldsLocalized=true
workflowApprovalCompleted=true
```

## 重复性状态

先前的诊断运行曾在插件更新阶段暴露首次引导/控制中心路由竞争：审批请求已从服务端消失，但旧审批 DOM 尚未完成关闭，测试发送 Escape 时可能误关闭底下的设置弹层。该中间失败没有作为通过证据。

修复审批弹层收尾后，完整桌面验收运行器重新启动了 3 轮隔离测试，最终报告通过：

```text
artifacts/desktop-repeatability-audit.json
requested_rounds=3, completed_rounds=3, passed=true
round 1: duration_ms=65531, exit_code=0
round 2: duration_ms=65101, exit_code=0
round 3: duration_ms=64795, exit_code=0
flaky_failures_ignored=false
isolated_profile_per_round=true
```

此前 Step 6.12/6.13 的三轮桌面基线仍记录在 `docs/evidence/phase-6-12-workflow-deep-fields-20260815.md`；本次新增单轮和三轮重复性验证覆盖了独立完成验证字段，并确认审批收尾不会破坏设置上下文。

## 边界

- 本次没有发布、部署、staging、canary、rollback 或 push。
- 本次没有调用外部 provider，也没有读取、记录或写入任何密钥。
- 工作树中其他阶段的既有修改保持不动；本 checkpoint 只纳入本次 verifier 集成、API/UI 投影、E2E 断言修复、测试与本证据。
