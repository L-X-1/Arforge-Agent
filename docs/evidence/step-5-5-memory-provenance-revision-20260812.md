# Step 5.5 — Memory Provenance 与 Revision

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.5
状态：Schema、digest/CAS helper 与链校验完成；持久化 writer/migration 留到 Step 5.11。

## 冻结合同

`packages/schema/src/memory-revision.ts` 的每个 Revision 包含：

- `revisionID`、`memoryID`、单调 `version`；
- operation：create/update/correct/activate/quarantine/restore/conflict_decision/forget/delete；
- actor kind、principalRef、可选 Run ID；
- reason、policyVersion；
- source `evidenceIDs` 与可选 runID；
- priorDigest、contentDigest、可选 successorMemoryID/candidateID；
- timestamp。

`isContiguous` 检查版本无缺口，`isDigestLinked` 检查每个 revision 都链接上一 revision digest；`packages/core/src/memory-revision.ts` 提供稳定 SHA-256 digest 与显式 CAS/version helper。

## 写入边界

该步骤没有把现有 `MemoryV2` 的原地 update 宣称为 revisionized：现有表没有 revision projection，旧 API 尚未提供 actor/evidence/policy。后续 additive migration 将新增 revision/candidate/provenance 结构，再由统一 writer 在同一 transaction 中写 projection + immutable revision；旧历史迁移必须标注 legacy/unknown provenance，不能伪造 actor 或 evidence。

## 验证

- `packages/core/test/memory-revision.test.ts` 覆盖链、断链、字段完整性、CAS、digest deterministic。
- Step 5.4 policy test 继续要求写决策先于 revision writer。
