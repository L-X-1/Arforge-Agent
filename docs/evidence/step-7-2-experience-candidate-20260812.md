# Step 7.2 — Experience Candidate 验证证据

日期：2026-08-12

## 实现范围

- 新增 `packages/core/src/experience-candidate.ts`，把 Experience Candidate 与 Evolution/Skill candidate 分离。
- 候选合同覆盖 problem signature、适用范围与条件、尝试策略、verified outcome、evidence IDs、counterexamples、confidence、support count、source run/experience IDs、expiry、review/status 和 policy version。
- 候选字段在持久化边界前统一限长并脱敏；候选 digest 使用 canonical hash，candidate ID 可由内容确定性重建。
- 只有 `reusable=true` 且已有 run/evidence 引用的 ExperienceRecord 才能作为支持来源；同一 source run 不得重复支持。
- 单次支持 confidence 为 0.2；至少 3 个独立 source run 且 confidence 达到 0.6、未过期、仍处于 pending candidate 状态并且 counterexample 未抵消支持时，才满足 promotion gate。

## 验证结果

```text
bun test --cwd packages/core test/experience-candidate.test.ts
5 pass, 0 fail

bun run --cwd packages/core typecheck
passed

bunx prettier --check packages/core/src/experience-candidate.ts packages/core/test/experience-candidate.test.ts
passed

bunx oxlint packages/core/src/experience-candidate.ts packages/core/test/experience-candidate.test.ts
0 warnings, 0 errors
```

测试覆盖：单次成功不得晋升、三次独立 run 达标、counterexample 阻断、重复 run 冲突、非 reusable 经验拒绝，以及敏感字段脱敏。

## 边界

本步骤建立候选合同和确定性晋升门槛；候选及其图关系的数据库持久化、关系类型和查询在 Step 7.3 实现，避免与已有 Evolution 审计事实源混用。
