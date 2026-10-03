# 阶段 3.7 Fallback 与重试

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.7
状态：Step 3.7 已完成。安全 retry/fallback 边界已实现并接入 Session Runner，recovery 分支已写入 durable Action/Attempt。

## 已实现

- `packages/core/src/runtime/retry.ts`：
  - 将 RateLimit、ProviderInternal、Transport、Authentication、InvalidRequest、ContentPolicy、Unknown 分类；
  - 仅在没有可见 assistant 输出和 tool call 时允许 bounded transport retry；
  - retry 用尽后，只有允许类别才给出 fallback 决策；已有输出或可执行 tool call 一律 stop；
  - decision 保留 category/reason，不携带 provider 原始 body。
- `packages/core/src/session/runner/llm.ts`：
  - `run({ retry: { maxTransportRetries } })` 支持显式 retry 上限，默认 0（避免隐式增加 provider 成本/延迟）、硬上限 3；
  - raw pre-output transport failure 会重新构造 provider stream；
  - 无显式 Session model 时，可通过 `SessionRunnerModel.resolveFallback` 选择第二模型；fallback 最多一层，原模型、目标模型和错误分类写入脱敏 RuntimeInsight audit；
  - 已有 assistant/tool 输出时不 retry、不 fallback。
  - retry/fallback recovery 分支通过现有 `ActionGateway` 写入 L0 自动 Action 生命周期和 Attempt；每次 recovery call 使用新的 action identity，避免复用已 blocked action；原始 provider 错误仍保留为分类化 audit evidence。
- `packages/core/src/runtime/billing.ts` 与 Runner：
  - 失败请求支持注入 provider-side `UsageReconciler`，查询到的归一化 provider usage 优先用于结算；reconciler 失败或未配置时使用既有具名 estimator，并写入脱敏 reconciliation failure audit。
- `packages/core/src/session/runner/model.ts`：Location catalog resolver 会从可用且 supported 的其他模型中尝试 fallback，并沿用 credential/integration 解析；显式 Session model 不 fallback。

## 验证结果

- 根目录 `bun run typecheck`：22/22 packages 通过。
- Router/Billing/Retry/Insight/Migration/Probe 定向集合：44 pass，0 fail，135 expect。
- Session Runner reserve/settle、pre-output retry、second-model fallback、failure usage reconciliation：各 1 pass，0 fail；retry/fallback 均验证了对应 durable `agent.action.attempt-started.1` 事件。
- SessionRunnerModel 与 Location layer 回归：17 pass，0 fail，33 expect。
- SessionRunner 定向回归：93 pass，1 fail；唯一失败为既有 Memory 注入断言（`session-runner.test.ts:715`），与本切片无关。

## 后续边界

- 生产环境仍需由具体 provider adapter 注入 `UsageReconciler`，把 provider request ID/账单查询映射到 `Billing.TokenUsage`；未注入时系统采用保守估算，不伪称已取得 provider usage。
- 下一步 Step 3.8 将把 retry/fallback Action、billing、Run/Step 观测统一到 Trace/Metrics/Runtime Insight projection。
