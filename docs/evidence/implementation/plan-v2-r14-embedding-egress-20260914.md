# R14 Embedding 外发与取消边界切片（2026-09-14）

## 结论

本批补齐 R14 的基础安全切片：`RuntimeEmbedding.embedBatch` 不再因为环境变量存在就直接把 memory/code 文本发往远程模型。远程调用必须由调用方显式提供已解析的 `RemoteRequest`，同时满足 consent、`Egress.Authorizer`、有界输入/响应和 `AbortSignal`；默认及未授权路径使用确定性 hashing，并明确记录 `localOnly` 与外发事实。远程响应异常后的 hashing fallback 保留 `localOnly=false`，避免把已经发生或可能发生的外发伪装成本地处理。

这不是 R14 整项完成。Memory 的受控远程服务注入、SecretProvider 在生产调用方的完整接线、真实 HTTP/外部入口的 allowed/rejected 矩阵、审计持久化及其他 LLM/embedding/MCP/skill/plugin/child 外发入口仍开放。

## 实现与唯一基础服务

- `packages/core/src/runtime/embedding.ts`
  - 新增 `RemoteRequest`、`EmbedBatchOptions`、`EmbeddingError` 和 `EmbeddingEgress`。
  - 远程请求需要显式 `consent`、已授权 `Egress`、credential scope 和调用方解析的 API key；本模块不再从 env 读取 API key。
  - 请求前检查取消/期限，限制文本数、输入字节、响应字节、向量数量/维度和 finite 数值；响应解析不使用无界 `response.json()`。
  - 远程 transport 失败后回退 hashing，但保留 `egress=sent/unknown` 和 `localOnly=false`；授权拒绝或未提供授权请求不发生网络调用。
- `packages/core/src/code-retrieval.ts`
  - `configured` embedding 通过同一 `RuntimeEmbedding`，传递 `signal`/`deadlineAt` 和可选的已授权 `embeddingRequest`；没有授权请求时保持本地 hashing。
- `packages/core/src/memory.ts` 与 `packages/schema/src/memory.ts`
  - Memory.semantic 接受可选的已授权 embedding request 和取消/期限，消费服务返回的 `localOnly`；公共 `SemanticResults.localOnly` 改为真实布尔值。
- `packages/sdk/openapi.json` 与 `packages/sdk/js/src/v2/gen/*`
  - 重新生成公开 OpenAPI/JS SDK 类型，`MemorySemanticResults.localOnly` 不再错误固定为 `true`。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| RuntimeEmbedding | 8 pass / 0 fail / 18 assertions，exit 0 | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |
| CodeRetrieval | 3 pass / 0 fail / 13 assertions，exit 0 | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |
| Memory integration/regression | 11 pass / 0 fail / 76 assertions，exit 0 | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |
| Embedding/CodeRetrieval/fixture lint | 0 warnings / 0 errors | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |
| Memory owner scoped lint | 12 个既有 `consistent-return`/assertion warnings / 0 errors | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |
| Schema/Protocol/SDK 类型 | 各 `tsgo --noEmit` exit 0；SDK 生成脚本第二次运行成功 | [embedding test](./plan-v2-r14-embedding-egress-20260914.txt) |

专项覆盖：授权拒绝前网络次数为 0；批准的本地 HTTP fixture 能收到受控 POST；服务 503 后 fallback 仍报告外发；预先取消在 transport 前失败。fixture 使用的 API key 仅为测试字符串，没有真实凭据或用户数据。

## 计划归属与边界

对应 R14 第 1—4 项的基础 RuntimeEmbedding seam 和 CodeRetrieval 取消/期限接线。该切片没有新增权限事实源或第二 embedding engine；R14、R09、R13、R17 及 R30 仍开放。真实外部 Provider、真实三平台 full sandbox 仍按用户要求后置到 R31。
