# R14 Embedding 外发事实审计切片（2026-09-14）

## 结论

本批把 Embedding 的外发结果接入现有 `RuntimeInsight.auditRecord`，没有新增审计存储、网络策略或执行器。API 模式下每次显式远程决策都会记录一次 `embedding.egress`：授权前拒绝记录 `egress=denied`，进入 transport 后成功或失败保留 `egress=sent`，发送后取消保留 `egress=unknown`。默认 hashing 且没有远程请求时不产生噪声审计；配置为 API 但未提供授权请求时记录拒绝事实。

审计资源只保留协议和 host/port，不保留 URL path、query、fragment 或 user content。metadata 只包含后端、外发状态、是否本地、transport 是否开始、文本数、请求体字节数、consent、凭据名称和有限错误类别；不包含 embedding 输入、API key 或解析后的凭据值。记录继续复用 RuntimeInsight 已有的 hash-chain 和可选数据库 persistence adapter（现有 persistence 是 best-effort，内存链仍是权威事实）。

## 实现

- `packages/core/src/runtime/embedding.ts`
  - 新增安全的 `auditResource` 投影，去除 query/fragment，并对无效 URL 使用固定资源名。
  - 新增 `auditEmbeddingEgress`，在无授权、授权拒绝、成功和 fallback 结果分支统一写入既有 `RuntimeInsight`。
  - 审计记录与 `EmbeddingBatch.localOnly/egress/fallbackReason` 使用同一结果对象，避免隐私报告与真实 transport 状态分叉。
- `packages/core/test/runtime/embedding.test.ts`
  - 拒绝场景证明零网络且审计不含 query secret/输入文本。
  - 成功场景证明审计记录 `sent`、`transportStarted=true`，且 hash-chain 仍有效、不含 fixture secret 和 query 文本。
  - 远程失败场景证明 fallback 仍保留 `sent` 外发风险。
  - in-flight `AbortSignal` 取消场景证明 fetch 实现抛出 `AbortError` 时仍记录 `egress=unknown`，不把已进入 transport 的 fallback 误报为本地。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| RuntimeEmbedding | 11 pass / 0 fail / 35 assertions，exit 0 | [原始输出](./plan-v2-r14-embedding-egress-audit-20260914.txt) |
| Memory + CodeRetrieval regression | 14 pass / 0 fail / 89 assertions，exit 0 | [原始输出](./plan-v2-r14-embedding-egress-audit-20260914.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [原始输出](./plan-v2-r14-embedding-egress-audit-20260914.txt) |
| 修改文件 Oxlint | 0 warnings / 0 errors | [原始输出](./plan-v2-r14-embedding-egress-audit-20260914.txt) |
| 差异空白检查 | `git diff --check` exit 0 | [原始输出](./plan-v2-r14-embedding-egress-audit-20260914.txt) |

所有 HTTP 均为隔离 loopback fixture；未使用真实用户内容、真实凭据或外部服务。

## 计划归属与边界

对应 R14 的“外发事实/隐私报告”基础切片。它证明审计记录与 transport 状态同源，并能进入既有 RuntimeInsight persistence seam；不等于数据库强持久化故障恢复、生产 Memory 远程注入、全部 LLM/embedding/MCP/skill/plugin/web/telemetry/child 入口矩阵，也不关闭 R14。R08、R09、R13、R17、R26、R30 仍开放；真实 Linux/macOS/Windows full sandbox 仍按用户要求在全阶段完成后执行。
