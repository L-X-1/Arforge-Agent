# Step 5.7 — Retention、Decay、Forget、Delete

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.7
状态：Retention/lifecycle/delete 合同完成；统一 writer 和真实删除执行留到 Step 5.11。

## 冻结规则

- lifecycle：candidate、active、superseded、quarantined、forgotten、rejected、deleted；
- explicit user/user-corrected + authority：indefinite、`userExplicitNoDecay=true`，不自动衰减；
- candidate/auto/model：默认 decay，可带 TTL；candidate TTL 到期可 auto-forget；
- 其他 active imported/project 记录未显式提供 TTL 时不自动 decay；
- `forget` 与 `restore` 是带 expectedVersion 的可恢复状态迁移；
- `delete` 必须同时具备 maintenance actor、ActionGateway actionID、explicit destructive grant 和 redaction evidence；
- 授权 delete 的执行合同必须清 projection、revision、relations，更新 retrieval index，并记录 redaction evidence；
- tenant/user request 不能由 UI 直接物理删除。

`packages/core/src/memory-retention.ts` 只提供 deterministic policy/decay/delete decision；还未将旧 `MemoryV2.delete` 直接改成该合同，因为那需要 Step 5.5 revision writer 和 Step 5.11 additive migration 同时落地。

## 验证

`packages/core/test/memory-retention.test.ts` 覆盖 user no-decay、candidate/auto TTL+decay、active imported 默认 indefinite、delete authority/evidence 和 lifecycle contract。
