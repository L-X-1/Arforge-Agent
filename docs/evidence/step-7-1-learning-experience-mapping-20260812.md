# Step 7.1 — LearningV2 与 ExperienceRecord 映射证据

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`

## 已实现

- `Learning.Outcome` 增加可选的 durable provenance：`runID`、`actionID`、`evaluationID`、`evidenceIDs`、`terminal`、`verifierPassed`。
- `Learning.recordVerified()` 是受约束的 outcome 映射入口，强制 run/action/evaluation/evidence 引用、合法 ID 前缀和 terminal；success 额外要求 verifier passed。
- `ExperienceV2.fromVerifiedOutcome()` 只接受上述 verified outcome，生成 `AgentRuntime.ExperienceRecord`；只有 terminal 且 verifier-backed 的 success 才能 `reusable=true`。
- 旧 `Learning.record()` 继续作为历史观察入口，未绑定 durable provenance 的记录不能直接成为 reusable Experience。
- 用户纠正/反馈仍走独立 `FeedbackV2` 表和入口，学习 outcome 只保存关联，不覆盖原始 outcome。
- SQLite 与 PostgreSQL migration 均已生成并通过 migration consistency check：`20260812134845_learning_verified_outcomes`。

## 验证

```text
bun run --cwd packages/core db:generate:postgres-schema PASS
bun run --cwd packages/core migration --check        PASS
bun run --cwd packages/core typecheck                PASS
bun run --cwd packages/schema typecheck               PASS
bun test --cwd packages/core test/learning.test.ts    PASS (7 tests)
```
