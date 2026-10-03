# 阶段 3.3 Capability Probe 证据

日期：2026-08-12
计划位置：V2 第 10 节，Step 3.3
状态：离线 fixture、本地故障回环、Core 策略闸门和本次明确授权的 DeepSeek live probe 已完成。

## 已落地的合同

- `packages/llm/src/probe.ts` 提供纯 adapter probe contract。
- 探测用例固定为 `text-generation`、`streaming`、`tool-calling`、`structured-output` 四类。
- 所有用例使用固定非敏感 prompt：`ARFORGE_CAPABILITY_PROBE_V1: Reply with exactly OK.`。
- adapter 只返回 `supported` / `unsupported` 与可选耗时；报告只保留能力状态、错误分类、HTTP 状态和重试性。
- `Probe.fromLLMError` 不复制 Provider message、原始响应、提示词或模型输出。
- `packages/core/src/model-probe.ts` 将 probe 结果映射到 `Model.Profile` 的 capability observations。
- live source 默认拒绝；只有显式 `liveAuthorized`、正的 currency-aware budget、Provider allowlist 和 Model allowlist 同时满足时才允许调用 adapter。

## 三层验证

1. 离线 recorded fixture：`packages/llm/test/fixtures/probes/capabilities-v1.json`，验证固定 prompt 和报告不携带 Provider 内容。
2. 本地故障层：
   - 真正的 `127.0.0.1` loopback HTTP server 验证 HTTP 429；
   - 确定性 HTTP 层验证 HTTP 503；
   - 确定性 SSE 层验证 malformed stream；
   - 断流验证 terminal-loss。当前 LLM 错误合同将“断流后没有 terminal finish”归为 `invalid-output`，因此 Probe 保留该既有分类，不伪造 transport 分类。
3. 真实 Provider（已授权范围）：
   - Provider：DeepSeek；Model：`deepseek-v4-flash`；凭据入口：`ANTHROPIC_API_KEY`；预算：¥5（500 分）。
   - 命令：`ARFORGE_RUN_LIVE_PROBE=true bun test --cwd packages/core test/model-probe-deepseek.live.test.ts --timeout 30000`。
   - 结果：1 pass，0 fail；报告包含 4 个 `source=live` observations；结算 `overBudget=false`。
   - 测试只使用固定 probe prompt，原始响应、prompt 和凭据值没有输出或持久化。

## 验证结果

- `bun run --cwd packages/llm typecheck`：通过。
- `bun test --cwd packages/llm test/probe.test.ts --timeout 30000`：7 pass，0 fail。
- `bun test --cwd packages/llm --timeout 30000`：301 pass，30 skip，0 fail，647 assertions。
- `bun run --cwd packages/core typecheck`：通过。
- `bun test --cwd packages/core test/model-probe.test.ts --timeout 30000`：3 pass，0 fail，8 assertions。
- `bun test --cwd packages/core test/model-probe-deepseek.live.test.ts --timeout 30000`（显式启用 live）：1 pass，0 fail，4 assertions。
- `git diff --check`：通过。

## 范围边界

- 本次只关闭用户明确授权的 DeepSeek / `deepseek-v4-flash` live 范围；其他 Provider/Model 仍需分别授权。
- live 预算闸门已与 Step 3.5 的 CNY minor-unit 内存结算核心连接；数据库持久化和生产运行时接线仍属于 Step 3.5 未完成项。
