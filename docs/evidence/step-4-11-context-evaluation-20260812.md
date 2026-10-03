# Step 4.11 Context Evaluation 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.11

状态：已完成

## Evaluation Core

`packages/core/src/context-evaluation.ts` 的 `evaluate()` 从 Context Package 和外部评估 observation 计算：

- required evidence recall@K；
- irrelevant token ratio；
- citation coverage；
- instruction contamination rate；
- protected fact retention；
- context build latency；
- input token 与 cost；
- task success。

每个 observation 必须带 dataset id、revision、query IDs 和 `external`/`recorded` source；baseline 和 candidate 必须使用同一 dataset revision。结果保存 package digest、dataset provenance、metric numerator/denominator/applicability，避免把不适用指标伪装成高分。

## Baseline / Promotion

`compare()` 先生成 baseline；没有 candidate 或没有显式 threshold 时返回 `not-evaluated`，不会自动 promotion。只有调用方提供 threshold 后才返回 `promoted` 或 `rejected`，并列出具体失败指标。threshold 不包含默认成功率/召回率数字。

## 验证结果

- `context-evaluation.test.ts`：3 pass、0 fail、16 assertions；
- 覆盖 external baseline、recall@K、citation、protected fact、token/cost/latency/task delta、显式 promotion threshold、instruction contamination rejection、dataset mismatch；
- 后续 Step 4.1–4.11 联合回归与全仓 typecheck/lint 将作为阶段门禁结果记录。

## 数据安全

评估测试使用固定 synthetic payload 作为 external-query-set fixture 的本地记录，不调用网络、不保存 prompt body 或 API key；生产接入时必须替换为真实外部 query set，并保留 dataset provenance。
