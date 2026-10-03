# Step 5.3 — Memory Candidate

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.3
状态：Candidate 合同完成；active 写入尚未切换，等待 Step 5.4 写入与激活政策。

## 已冻结字段

`packages/schema/src/memory-candidate.ts` 的 `MemoryCandidate.Candidate` 覆盖：

- `candidateID`；
- `proposedClass` / `content`；
- `sourceEvidenceIDs`；
- `scope`；
- `sensitivity`；
- `confidence`；
- `dedup`（status、比较过的 memory IDs、可选 similarity）；
- `retention`（mode、expiry、reason）；
- `proposer`（kind、principalRef、runID）；
- `policy`（status、policyVersion、reason）；
- `status` 与 `reason`；
- created/updated/expiry 时间。

Candidate 使用独立 `mcan_` identity，不复用 `mem_`；`working`、`secret`、未批准、待 review、duplicate、conflict candidate 均不能通过 `isActivationEligible`。

## 边界

本步骤只建立可验证合同和 activation gate，未把 candidate 当作 active Memory，也未给现有 `memory` 表伪造 candidate 状态。Step 5.4 将把 user explicit、user-corrected、imported、model/auto、secret 和 global/cross-workspace 写入政策接入 Candidate；Step 5.11 再增加持久化表和 additive migration。

## 验证

- `bun test --cwd packages/core test/memory-candidate.test.ts test/memory-class.test.ts test/memory.test.ts`：应保持既有 Memory 回归并覆盖 Candidate gate。
- `bun run typecheck`：schema/core 及 monorepo 其他 package 通过。
