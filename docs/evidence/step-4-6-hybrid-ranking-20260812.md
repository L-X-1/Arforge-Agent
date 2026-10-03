# Step 4.6 Hybrid Ranking 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.6

状态：已完成

## Versioned ranking contract

`packages/core/src/hybrid-ranking.ts` 将 Code Retrieval 的 channels 与治理特征组合为可复现的 `RankedCandidate`：

- lexical、vector、symbol distance、recency；
- user intent、file/path scope；
- source trust；
- prior usefulness；
- token cost；
- duplicate penalty；
- model relevance candidate feature。

默认 profile 为 `hybrid-v1`，每个结果记录 `weightVersion`、原始 `features`、加权 `contributions`、rank 和解释文本。Hostile/untrusted source 不会因模型 relevance 自动获得 authority；model relevance 只是低权重 candidate feature，不能成为唯一排序来源。

同一 content digest/duplicate key 会产生 duplication penalty；结果排序在分数、trust、path 上使用稳定 tie-break，结果数量与 token cost 有界。无向量数据库、无第二事实源、无模型直接写分数的路径。

## 验证

- `bun run --cwd packages/core typecheck`：通过；
- `bun test --cwd packages/core test/hybrid-ranking.test.ts`：4 pass、0 fail；
- `oxlint`：新增 Hybrid Ranking 文件 0 warnings、0 errors；
- 覆盖 versioned weights、trust-aware score、duplicate penalty、deterministic tie-break、model-only 防护与非法 profile fail closed。
