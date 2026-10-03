# 阶段 3.8 OpenTelemetry 与 Runtime Insight 收敛

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.8
状态：已完成；Run→Step→ModelCall→Action→Verifier 的 traceID 关联、bounded Insight projection、approval wait metric 与 OTLP export smoke 均已验证。

## 已实现

- 复用 `packages/core/src/observability/otlp.ts` 的现有 OTLP tracing layer，不新增网络出口；`Effect.withSpan` 为 Run、Step、ModelCall 和 Action 增加安全属性：run/session/trace/action ID、provider/model ID、request digest、risk tier、attempt、mode。
- Durable Run 的持久 `traceID` 现在贯穿 Runner 的 Run/Step/ModelCall，并写入恢复分支的 durable Action 输入及 Action span；retry/fallback 不会创建脱离原 Run 的 trace。
- `packages/core/src/runtime/verifier.ts` 提供统一 `verify` Effect facade：复用纯检查函数、记录带 run/trace/action 引用的 VerificationRecord，并挂载 `Arforge.Verifier` 安全 span。
- `packages/core/src/observability/otlp.ts` 支持受控 endpoint 覆盖；本地 HTTP collector smoke 已收到非空 `/v1/traces` payload。
- `packages/core/src/runtime/insight.ts` 新增 bounded `ModelCallRecord` 与 `MetricRecord` projection，并在 reset/snapshot/read API 中保持边界可见。
- Session Runner 记录 ModelCall 的 primary/retry/fallback、成功/失败/中断、分类、可见输出边界、tool-call 边界与 latency；retry/fallback、billing tokens/cost、verification、approval/recovery audit 会形成对应 metric projection；ActionGateway 记录审批等待时长 `approval.wait`。
- 所有新增属性只使用 ID、digest、计数、状态、分类、延迟和成本单位；没有写入 prompt、secret 或原始 provider/tool body。

## 验证结果

- `bun run typecheck`：22/22 packages 通过。
- `packages/core/test/runtime/insight.test.ts`：10 pass，0 fail，31 expect。
- `packages/core/test/action-gateway.test.ts`：85 pass，0 fail，446 expect；控制面 L3 测试验证 `approval.wait` 的 granted 状态与毫秒时长。
- SessionRunner retry/fallback targeted tests：各 1 pass，且 Step 3.7 durable Attempt 断言保持通过。
- traceID 关联测试：RuntimeInsight 10 pass，SessionRunner retry/fallback 各 1 pass；两条 ModelCall 记录均与 Durable Run 的 traceID 相同。
- Verifier/OTLP/Insight 联合 targeted 测试：15 pass，0 fail；其中 OTLP 本地 collector smoke 1 pass。
- SessionRunner full regression：94 pass，1 pre-existing fail，303 expect；失败仍为 Memory 注入断言（`session-runner.test.ts:716`），未新增回归失败。

## 阶段边界

- `verify` facade 只负责把已准备好的 check 结果接入 trace/Insight，不把命令执行本身伪装成验证事实；后续 Evaluation/Replay 负责提供真实 verifier 输入。
- OTLP 与本地 Insight 都是观测投影，不替代 durable evaluation/action/event truth。
