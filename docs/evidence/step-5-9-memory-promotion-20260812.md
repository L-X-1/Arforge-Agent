# Step 5.9 — Run→Memory Promotion

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.9
状态：Promotion gate 完成；尚未接入 durable Run projector/Memory writer。

## 门禁

`evaluatePromotion` 只有在以下条件全部满足时产生 `candidate`：

- Run status 为 `completed`；
- verifier passed；
- 至少一个 Observation reference；
- 至少一个 Evidence；
- Evidence 与 Run/Observation 可追溯，且不是 confidential/secret、rejected 或 expired；
- target class/scope policy allow；
- dedup/conflict 不是 duplicate/conflict；
- 敏感内容必须有 explicit user confirmation；确认只允许进入 Candidate，不绕过单独的敏感激活政策。

任何条件失败都产生 `reject`。即使成功，也只生成 Candidate，不能直接写 active Memory；active activation 仍由 Step 5.4 policy + Step 5.5 revision writer + actor authority 决定。

## 当前边界

本步骤没有复制 Run/Event/Observation 原文到 Memory，也没有建立第二事实源。Candidate 只保存引用和 digest/provenance 边界；真正的持久化与 additive migration 按 Step 5.11 执行。

## 验证

`packages/core/test/memory-promotion.test.ts` 覆盖 completed/failed、verifier、Observation/Evidence traceability、sensitivity、expiry/rejection、dedup/conflict、policy 和 candidate-only 输出。
