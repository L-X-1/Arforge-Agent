# 阶段 3.9 EvaluationResult 持久化

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.9
状态：已完成

## 已实现

- `packages/core/src/runtime/evaluation.ts` 新增 Core `RuntimeEvaluation` service，提供不可变 `create`、`get`、按 Run 限定的 `list`；没有 update API，重复 EvaluationID 以 durable conflict 失败。
- `packages/core/src/runtime/sql.ts` 新增 `evaluation_result` Drizzle table，覆盖 evaluation run、suite/case revision、baseline/candidate artifact digest、environment/toolchain digest、pass/score/metrics、evidence IDs、model/provider/token/cost、reviewer/approval 和 created/evaluated time。
- `packages/core/src/database/migration/20260811203452_evaluation_results.ts` 与 PostgreSQL 同版本 RLS migration 已生成；`script/migration.ts --check` 通过。
- 输入边界拒绝缺失 evidence、非 digest artifact/environment/toolchain 值及非有限 metrics；持久 EvaluationResult 只保存不可变引用和结构化数值，禁止用自由文本替代评测结果。

## 验证结果

- Core typecheck：通过。
- `runtime/evaluation.test.ts`：2 pass，0 fail，覆盖持久化/读取/list、重复 ID 与非法引用拒绝。
- `runtime/verifier.test.ts`、OTLP/observability 与 Evaluation 联合测试：15 pass，0 fail。
- `database-migration.test.ts` empty database migration：通过。

## 事实源边界

- SQLite 与 PostgreSQL durable tables 是 EvaluationResult 的事实源；RuntimeInsight/OTLP 只记录观测投影。
- artifact/evidence 内容本身不复制进 EvaluationResult，只保存 digest/ID 引用；实际 artifact/evidence registry 将由后续 Golden Task/Replay 阶段接入。
