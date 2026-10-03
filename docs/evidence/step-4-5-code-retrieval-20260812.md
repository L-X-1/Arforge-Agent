# Step 4.5 Code Retrieval 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.5

状态：已完成

## Retrieval contract

`packages/core/src/code-retrieval.ts` 接收已经由 Source Adapter 限长的 `Document`，不直接读取网络或无限原始 payload。每个 `Hit` 保留：

- source/path 与 bounded line snippet；
- lexical score；
- 现有 `RuntimeEmbedding` 的 semantic score 与实际 backend（hashing/configured fallback）；
- structure score（优先使用注入的 LSP/tree-sitter facts，没有时使用受限语法 fallback）；
- freshness score；
- content digest、file fingerprint、Evidence ID。

实现不引入向量数据库：hashing vector 直接复用 `packages/core/src/runtime/embedding.ts`；configured embedding 仍由现有 best-effort API/fallback 负责。最终综合权重不在本步骤决定，留给 Step 4.6 Hybrid Ranking。

## 安全与边界

- 空 query、已取消 query、过期 deadline fail closed；
- snippet 最大 1,000 bytes，结果最大 100 条；
- source/Evidence identity 原样沿用，不把检索分数升级为 instruction authority；
- 结构信息可由宿主的 LSP/tree-sitter adapter 注入，Core 不创建第二结构索引。

## 验证

- `bun run --cwd packages/core typecheck`：通过；
- `bun test --cwd packages/core test/code-retrieval.test.ts`：3 pass、0 fail；
- `oxlint`：Code Retrieval 新增文件 0 warnings、0 errors；
- 覆盖 lexical/semantic/structure/freshness/fingerprint、Source Adapter→Retrieval 衔接、bounded snippet 与 cancellation/deadline。
