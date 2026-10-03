# Step 5.8 — Recall Pipeline

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.8
状态：Core recall boundary 与 privacy-safe telemetry 完成；retention expiry 字段接入和 Memory Evaluation 留到 Step 5.10/5.11。

## 当前 pipeline

`Memory.semantic` 现在按以下顺序执行：

1. 当前 project/workspace scope 授权和 global visibility filter；
2. quarantine/source filter；
3. lexical/vector hybrid retrieval；
4. conflict truth-boundary disposition（默认当前 recall policy 的 `exclude_both`，helper 也支持 `lower_both`）；
5. deduplicate，并在 bounded top-K 之前过滤/降低冲突记录；
6. bounded result projection；
7. `prepareContext` 继续把结果渲染为 escaped untrusted data；
8. privacy-safe RuntimeInsight telemetry。

## Telemetry contract

Memory recall telemetry 只保存：scope hash、query fingerprint、algorithm、algorithm revision、latency、memory IDs、scores、source。已移除 query 原文和 hit content；UI 只显示 fingerprint、record ID、score/source，不显示召回正文。`RuntimeInsight` 仍是 bounded process projection，不是 durable truth。

## 边界

当前旧 Memory 表没有 expiry/lifecycle/revision projection，因此 semantic 仍以 source/quarantine 作为兼容过滤；Step 5.11 additive migration 后再按 lifecycle/retention/expiry 过滤。未解决冲突的 policy mode 已通过 helper 显式传入，不能把默认值解释为客观 truth。

## 验证

- `packages/core/test/memory-recall.test.ts`：fingerprint、exclude-before-top-K、lower、chosen winner、dedup。
- `packages/core/test/memory.test.ts`：既有 hybrid/CJK/quarantine/conflict 回归，telemetry 断言无 query/content 泄漏。
- `packages/core/test/runtime/insight.test.ts`：bounded recall projection 和 clone 行为。
- `packages/client` 已按协议重新生成 generated client；协议和 app typecheck 需与本证据一同验证。
