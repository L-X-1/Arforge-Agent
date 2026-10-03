# 阶段 3.4 Unified LLM Exchange 证据

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.4
状态：已实现并完成离线合同验证；未发起真实 Provider 请求。

## 目标与边界

Provider adapter 只负责协议转换，Core 运行时通过统一的、Provider-neutral 的
LLM exchange 合同消费请求与响应。Provider-specific request body、raw response
payload、原始错误 message 和 raw provider body 不进入该合同，也不写入 durable event
或 UI 投影。

## 已落地的合同

- `packages/schema/src/llm.ts` 增加 `LLM.Unified` V1：
  - 请求：有序 messages/context package digest、tool schema digest、model profile
    revision、token/cost budget 和可选 deadline；
  - 响应：stream fragments、规范化 finish reason、usage、tool calls、provider
    request ID、retry/fallback evidence 和脱敏 error category；
  - 所有 digest 受 64 位小写 SHA-256 形态约束；tool input 使用 `Schema.Json`；
  - optional 字段遵循项目 optional helper，编码时省略 `undefined`。
- `packages/core/src/llm-unified.ts` 提供 Core 映射：
  - 对 messages、context package 和 tool schema 进行稳定 key-order canonical digest；
  - 将现有 LLM events 转为 text/reasoning/tool-input fragments；
  - 将现有 usage、finish reason、tool calls 转为统一结构；
  - 将 LLMError 仅映射为 category、retryable、HTTP status，不保留原始 message/body。
- retry/fallback 和 provider request ID 是显式输入 evidence；本步骤不从 Provider
  raw body 猜测或伪造这些字段。

## 验证结果

- `bun run --cwd packages/schema typecheck`：通过。
- `bun run --cwd packages/core typecheck`：通过。
- `bun test --cwd packages/schema --timeout 30000`：35 pass，0 fail，115 assertions。
- `bun test --cwd packages/core test/llm-unified.test.ts --timeout 30000`：3 pass，0 fail，9 assertions。
- Schema 专项测试验证：统一 exchange 编解码往返、optional 字段省略、非法 digest 和
  未知 finish reason 拒绝。
- Core 专项测试验证：稳定 digest 不泄漏消息/tool description、stream/usage/tool
  call/retry/provider ID 归一化，以及错误 category-only 编码。

## 未完成项与后续边界

- Step 3.5 继续负责真实 token/cost 计量、预算扣减和超限策略；本步骤只冻结请求
  budget 字段，不声称已经完成费用控制。
- Step 3.3 的真实 Provider live probe 仍需用户明确 Provider/Model 白名单、费用预算
  和凭据配置入口；本步骤未读取凭据、未发起网络请求、未产生费用。
