# Phase 3.1 — Provider/Protocol 资产盘点

- 日期：2026-08-12
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.1
- 分支：`codex/phase-0-checkpoint`
- 盘点原则：只依据 schema、adapter、transport、fixture/test；不把 provider 宣传能力当作已验证能力

## 资产范围

| 资产层 | 真实落点 | 盘点数量 |
| --- | --- | ---: |
| LLM protocol adapter | `packages/llm/src/protocols/*` | 6 个主协议，另有 Bedrock event-stream framing 与共享 transport |
| LLM provider facade | `packages/llm/src/providers/*` | 9 个 facade 文件；其中 Cloudflare 为 2 个 provider，OpenAI-compatible 为 7 个 family profile |
| Arforge bundled AI SDK factory | `packages/arforge/src/provider/provider.ts` | 23 个 bundled SDK factory |
| Core plugin provider modules | `packages/core/src/plugin/provider/*` | 31 个 provider module |
| Canonical model/provider schema | `packages/schema/src/model.ts`、`packages/schema/src/provider.ts` | 已有 Model/Provider V2 基础；尚未冻结 Step 3.2 的 ModelProfile V1 |

## Canonical protocol matrix

符号：`✓` 为 adapter/schema 已直接证明，`△` 为 provider/model 依赖或由公共层承诺，`—` 为当前 adapter 未提供，`?` 为没有 live probe 不能确认。

| Protocol | Transport / endpoint | Streaming | Tool call | Vision / audio / document | Reasoning controls | Structured output | Prompt caching | Token usage / error mapping |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Anthropic Messages | HTTPS JSON POST + SSE | ✓ | ✓ tool_use / tool_result / provider-executed server tools | image ✓ / audio — / document — | ✓ thinking、reasoning signature | ✓ 公共层 synthetic tool；未宣称 native JSON response_format | ✓ `cache_control`，含 TTL 与 breakpoint 上限 | ✓ input/cache token、provider error；公共 executor 处理 429/503/504/529 与 Retry-After |
| Bedrock Converse | HTTPS JSON POST + AWS event stream | ✓ | ✓ toolSpec / toolChoice / tool result | image ✓ / audio — / document ✓ | ✓ reasoning content/signature | ✓ 公共层 synthetic tool；未宣称 native JSON response_format | ✓ `cachePoint`，含 TTL 与 breakpoint 上限 | ✓ usage/cache token、throttling/input-too-long；SigV4 auth |
| Gemini | HTTPS JSON POST + SSE (`alt=sse`) | ✓ | ✓ function declarations / calls | image ✓ / audio ✓ / video ✓ / document — | ✓ thinking config、thought signature | ✓ 公共层 synthetic tool；未宣称 native JSON response_format | △ provider out-of-band cache；公共 auto policy 对 Gemini 不改写 wire marker | ✓ usage/cache/thought token、finish/content-filter mapping |
| OpenAI Chat | HTTPS JSON POST + SSE | ✓ | ✓ tools / tool_choice | image ✓ / audio — / document — | △ `reasoning_content` compatibility | ✓ 公共层 synthetic tool；native response format 未作为本 adapter 的统一能力 | △ provider implicit cache；公共 auto policy no-op | ✓ prompt/cache/reasoning usage 与 HTTP/mid-stream errors |
| OpenAI Responses | HTTPS JSON POST + SSE；另有 JSON WebSocket route | ✓ | ✓ function call/output 与 hosted tool events | image ✓ / audio — / document — | ✓ reasoning summary、encrypted continuation、effort | ✓ 公共层 synthetic tool；native response format 未作为本 adapter 的统一能力 | ✓ `prompt_cache_key` / `store` 等 provider options | ✓ input/output/cache/reasoning usage 与 `response.failed`/stream error mapping |
| OpenAI-compatible Chat | HTTPS JSON POST + SSE | ✓ | ✓ 复用 OpenAI Chat tool contract | image ✓ / audio — / document — | △ `reasoning_content` / provider-specific options | ✓ 公共层 synthetic tool；具体 provider native 能力不继承 | △ 由 profile/provider options 决定，不能作统一保证 | ✓ 标准 OpenAI usage 时可映射；协议错误走公共 executor |

## Provider 到 protocol 的绑定

| Provider facade / family | Adapter | Auth / endpoint 证据 | 已有 recorded/fixture 或回环测试 |
| --- | --- | --- | --- |
| `anthropic` | Anthropic Messages | API key → `x-api-key`；可配置 baseURL | Anthropic route、cache、tool/image/error tests；部分 recorded fixture |
| `amazon-bedrock` | Bedrock Converse | AWS SigV4 或 bearer；region 参与 endpoint | Bedrock event-stream、cache、tool/image/document、SigV4 tests；recorded text/tool loop |
| `google` | Gemini | API key → `x-goog-api-key`；可配置 baseURL | Gemini multimodal/tool/reasoning/cache/error tests；部分 recorded fixture |
| `openai` | OpenAI Responses、OpenAI Chat、Responses WebSocket | bearer `OPENAI_API_KEY`；可配置 baseURL/query | Chat/Responses/WS/tool/image/reasoning/error tests；部分 recorded fixture |
| `azure` | OpenAI Responses 或 OpenAI Chat | `api-key` header；resourceName/baseURL 与 api-version | Azure auth/route/provider option tests；无 live probe |
| `cloudflare-ai-gateway`、`cloudflare-workers-ai` | OpenAI-compatible Chat | Cloudflare bearer/token aliases；derived account endpoint 或 baseURL | Cloudflare route/auth tests与 recorded text/tool fixtures |
| `openai-compatible` family：Baseten、Cerebras、DeepInfra、DeepSeek、Fireworks、Groq、TogetherAI | OpenAI-compatible Chat | bearer；profile 提供默认 baseURL，可覆盖 | generic compatible route/profile tests；部分 recorded fixture |
| `openrouter` | OpenAI-compatible Chat | bearer `OPENROUTER_API_KEY`；OpenRouter endpoint | route/options tests；部分 recorded fixture |
| `xai` | OpenAI Responses 或 OpenAI-compatible Chat | bearer `XAI_API_KEY`；可配置 baseURL | route/options tests；部分 recorded fixture |

## Arforge bundled SDK factory 矩阵

Arforge 的 `packages/arforge/src/provider/provider.ts` 是另一条运行时路径：它通过
AI SDK factory 加载模型，不能把 `packages/llm` 的 canonical protocol fixture 直接
当成每个 SDK provider 的 live compatibility 证明。

| SDK factory 家族 | 当前协议族 / 特殊点 |
| --- | --- |
| `@ai-sdk/anthropic`、`@ai-sdk/google-vertex/anthropic` | Anthropic Messages；Vertex regional/REP endpoint 由 provider runtime 选择 |
| `@ai-sdk/amazon-bedrock` | Bedrock Converse；region/profile/web identity/bearer 选择由 runtime 处理 |
| `@ai-sdk/amazon-bedrock/mantle`、`@ai-sdk/openai`、`@ai-sdk/azure`、`@ai-sdk/xai` | OpenAI Responses/Chat family；model id 与 capability 决定 reasoning/route 选择 |
| `@ai-sdk/google`、`@ai-sdk/google-vertex` | Gemini family；thinking config 与 Vertex endpoint 由 `ProviderTransform` 处理 |
| `@ai-sdk/openai-compatible`、`@openrouter/ai-sdk-provider`、`@ai-sdk/mistral`、`@ai-sdk/groq`、`@ai-sdk/deepinfra`、`@ai-sdk/cerebras`、`@ai-sdk/togetherai` | OpenAI-compatible/SDK-specific Chat family；provider option 与 schema compatibility 由 transform 处理 |
| `@ai-sdk/cohere`、`@ai-sdk/perplexity`、`@ai-sdk/vercel`、`@ai-sdk/alibaba` | AI SDK native factory；reasoning variants 按 model/provider catalog 逐项生成，不能从 family 名称推导全部能力 |
| `@ai-sdk/gateway`、`gitlab-ai-provider`、`venice-ai-sdk-provider` | Gateway/custom SDK factory；上游 model slug、option namespace 与 reasoning 需依赖 model catalog/transform |

Core plugin provider modules 还包含 `arforge-console`、`azure-cognitive-services`、
`cloudflare-ai-gateway`、`cloudflare-workers-ai`、`dynamic`、`kilo`、`llmgateway`、
`nvidia`、`sap-ai-core`、`snowflake-cortex`、`zenmux` 等兼容/托管入口。它们已被
provider loader 和 transform tests 覆盖，
但尚未由本步骤声明统一的 native modality 或 live capability。

## Cross-cutting contract

- `LLMRequest` schema 已统一 `tools`、`toolChoice`、`responseFormat`、`cache`、`providerOptions` 和 `HttpOptions`；`generateObject` 当前通过 synthetic tool call 实现结构化结果解码。
- 公共 `route/executor.ts` 统一处理可重试 HTTP 状态、Retry-After、rate-limit headers、body redaction、stream abort 和错误分类；协议只补充 provider-specific stream error/usage 映射。
- HTTP transport 会在 Effect interruption 时中止请求流；OpenAI Responses WebSocket transport 会关闭连接并清理 listener。
- `packages/schema/src/model.ts` 当前 `Capabilities` 只有 `tools/input/output`；reasoning、cache、token usage evidence、probe expiry、region/egress policy 尚未形成 Step 3.2 的冻结 ModelProfile 合同。

## Verification

通过：

- `bun run --cwd packages/llm typecheck`
- `bun test --cwd packages/llm --timeout 30000 test/provider test/executor.test.ts test/route.test.ts test/response.test.ts test/generate-object.test.ts test/cache-policy.test.ts`：224 pass、30 skip、0 fail、448 assertions
- `bun test --cwd packages/arforge --timeout 30000 test/provider`：500 pass、0 fail、963 assertions
- 既有 `packages/llm/test/fixtures/recordings`、协议 fixture、local HTTP/WebSocket loop 均只作为 recorded/replay evidence；本步骤未执行 live provider request
- `git diff --check`：通过；本步骤盘点没有修改运行时代码或 schema

## 未宣称项与下一步

本盘点没有把“存在 SDK factory”“catalog 标记支持”或“可构造 endpoint”升级为
已验证能力。以下项目留给后续步骤：

1. Step 3.2：冻结 `ModelProfile V1`，把 modality、limits、tool/structured/reasoning/cache、token estimator、price revision、evidence/expiry、region/egress policy 写入可验证 schema。
2. Step 3.3：建立离线 recorded、local fault server 和经明确授权的 live probe 三层测试；live probe 需要单独确定 credential scope、费用预算和 provider/model 白名单。
3. 对当前 30 个 skip 的 recorded cases，补齐可复现 fixture 或明确记录为未验证，不以 skip 代替 provider compatibility 结论。

Step 3.1 的资产盘点完成，下一步严格进入 V2 Step 3.2；尚未执行外部 provider
请求、没有读取或写入任何用户 credential，也没有产生费用。
