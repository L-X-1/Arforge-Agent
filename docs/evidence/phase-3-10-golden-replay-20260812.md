# 阶段 3.10 Golden Task 与 Replay Harness

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.10
状态：进行中

## 已实现

- `packages/core/src/runtime/golden.ts` 建立统一 GoldenCase manifest，包含 immutable fixture digest、objective、allowed tools/policy、正负断言、Verifier revision、token/cost/time budget、supported platform、nondeterminism 与 evidence retention。
- 已迁移历史 `arforge/eval/formal_tasks.py::_pricing` 的 `pricing_1` case，保留其 Python source reference、fixture 和回归断言；没有把 Python 结果直接写成 TS 结果。
- `replayDeterministic` 明确使用 `deterministic-tool-fixture` 类型，调用统一 `RuntimeVerifier.verify`，生成结构化 `EvaluationCreateInput`；Replay 的 run/trace/evidence/artifact digest 保持可追溯。
- `makeRecordedProviderFixture` 与 `replayRecordedProvider` 已接入统一 Replay Harness：记录 provider/model、request digest 与 provider-neutral `LLMEvent[]`，通过生产 `LLMResponse` reducer 离线重放，不建立网络连接、不读取 API key、不产生模型调用费用。
- `decodeRecordedProviderFixture` 提供 JSON 归档边界；测试已完成 fixture JSON round-trip，解码后的事件和 fixture digest 与内存夹具一致。
- recorded-provider replay 校验 request/fixture digest，提取 text、finish reason、工具调用数和 usage 等结构化结果，执行统一 Verifier，并只向 Insight 写入 ID、摘要和计数类安全指标；EvaluationResult 保留 provider/model/token references。
- `replayLiveModel` 已建立独立 live-model lane：要求显式 `approved/actorID/reason`、case cost/token/time budget、估算费用与结算费用均不超授权上限；超时、无 terminal finish、无 provider token usage 或 token 超限均 fail closed。客户端通过依赖注入，当前只用假客户端验证，不触发任何真实 provider 请求。
- live-model lane 成功路径复用生产 `LLMResponse` reducer、统一 Verifier 和 Evaluation Core draft；Insight 只记录 provider/model/request/fixture digest、事件/令牌/费用/延迟等安全摘要，不记录 prompt 或 response body。
- Python formal manifest 已继续冻结 `formal-slug-01`、`formal-retry-01`、`formal-state-01`、`formal-refactor-01` 和 `formal-architecture-01`，并生成 7 个 family 的完整 50-case manifest；均通过 deterministic replay 进入同一 Evaluation Core draft。
- capability-eval 已登记 26 个确定性基础设施 contract，包含 immutable fixture、正/负断言与“不得调用模型”策略，并全部通过 deterministic replay 进入同一 Evaluation Core draft。
- `GoldenFixture.supportingFiles` 已支持并冻结多文件 legacy fixture；state/architecture 补齐服务层文件，10 个 multistack toolchain 的全部 5 个 index case（共 50 个，SQL、JavaScript、Java、Rust、C、C++、C#、Go、PHP、Ruby）均已生成完整 service/package/header/policy/contract fixture，避免只迁移单一主文件。
- fixture digest、Verifier revision、断言缺失、重复断言 ID、预算/平台/legacy metadata 缺失均 fail closed；deterministic replay 只统计自身类型，不冒充 recorded provider 或 live model 能力。

## 验证结果

- `runtime/golden.test.ts`：19 pass，0 fail；覆盖 Python formal、capability-eval、50 个 multistack deterministic replay、完整 Golden manifest 回放与候选退化阻断、recorded-provider 成功 replay、live-model 假客户端成功路径、未授权阻断、manifest 完整性拒绝、Verifier/Insight projection、fixture 篡改拒绝与 request digest 不匹配拒绝。
- `runtime/evaluation.test.ts`：3 pass，0 fail；其中一项把 deterministic replay draft 写入 Evaluation Core durable fact。
- `runtime/python-manifest.test.ts`：通过 UTF-8 JSON 边界逐字段比较 Python builder 生成的全部 50 个 formal case、50 个 multistack case 与 26 个 capability-eval case（含逐文件多文件 fixture）。
- Core 相关回归集合：72 pass，0 fail，1919 expects；全仓 typecheck 22/22 通过。

## 尚未关闭的计划要求

- recorded-provider 已完成本地 provider-neutral event replay；尚需把真实历史 provider event/response 归档格式接入统一 Runner，并补充跨 provider fixture 登记。
- live-model 的本地门禁和假客户端闭环已完成；真实 DeepSeek 调用仍需用户在具体执行前再次确认费用上限、模型配置和网络授权，当前未读取或发送任何 API key，也未产生费用。
- packaged desktop E2E 仍需要独立环境门禁，不能用当前 deterministic 或假客户端 fixture 代替。
- multistack 的 50 个 manifest/fixture 与 deterministic replay 已完成；各 toolchain 的真实 runtime smoke、真实历史 provider event 归档和 packaged desktop E2E 仍需后续批次；capability-eval manifest 本批已登记，但尚未进行真实模型双跑。
