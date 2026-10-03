# Step 5.6 — Dedup、Conflict 与 Truth Boundary

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.6
状态：决策合同完成；现有 deterministic conflict lifecycle 保留，recall adapter 接入留到 Step 5.8。

## 冻结规则

- exact digest match → `exact_duplicate`；similarity `>= 0.92` → `near_duplicate`；否则 `novel`；
- conflict kind 明确包含 mutually exclusive fact、scope mismatch、stale successor、user-vs-auto priority；
- unresolved policy 只能显式选择 `exclude_both` 或 `lower_both`；不允许 silent winner；
- resolved conflict 只给 chosen record `include`，另一条 `lower`；
- stale successor 可单独 lower，直到 lineage review；
- dismissed/undone 冲突恢复双方 ordinary recall eligibility；
- source priority 只作为 advisory metadata，不是客观 truth claim；
- 所有输出标记 `truthBoundary: governed_record`，Memory 只表示受治理记录。

`packages/core/src/memory-truth-boundary.ts` 提供纯决策函数；现有 `MemoryV2` 的 conflict scan/list/resolve/dismiss/undo 与其 schema 不删除，后续 Step 5.8 把 disposition 接入 recall pipeline。

## 注意

当前 schema 直接输出 `exclude/include/lower` projection；Step 5.8 接入召回时必须把 `exclude` 映射成实际过滤，并在集成测试中固化。

## 验证

`packages/core/test/memory-truth-boundary.test.ts` 覆盖 dedup、unresolved exclude/lower、resolved choice、stale successor、dismiss/undo 和 user-vs-auto advisory priority。
