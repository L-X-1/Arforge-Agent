# Step 7.5 — Skill V1 合同验证证据

日期：2026-08-12

## 实现范围

- 新增 `packages/schema/src/skill-v1.ts`，定义版本化可执行 Skill 合同：skill ID/version/digest、purpose/triggers、allowed tools/capabilities、input/output schema、instruction/asset/script refs、source Experience IDs、test/evaluation IDs、安全审查、生命周期和 rollback version。
- 新增 `packages/core/src/skill-v1.ts`，提供 bounded candidate 构造、artifact digest、生命周期迁移、security review gate、permission expansion gate，以及 legacy ManagedSkill → V1 candidate adapter。
- `packages/core/src/skill/managed.ts` 保留原有文件系统 discovery/routing/enable-disable/read 行为，并暴露显式 provenance adapter；legacy skill 不会自动成为 active Skill。
- candidate/canary/active/retired 状态与安全审查分离；canary/active 要求 security review passed，active 还要求 evaluation ID。

## 验证结果

```text
bun run --cwd packages/core typecheck
passed

bun run --cwd packages/schema typecheck
passed

bun test --cwd packages/core test/skill-v1.test.ts
5 pass, 0 fail

bun test --cwd packages/core test/skill-managed.test.ts
5 pass, 0 fail

bunx oxlint packages/schema/src/skill-v1.ts packages/core/src/skill-v1.ts packages/core/test/skill-v1.test.ts
0 warnings, 0 errors
```

测试覆盖：candidate 合同和 digest、security review 生命周期 gate、rollback version、权限扩展拒绝、unsafe path/非 Experience provenance 拒绝，以及 legacy managed skill 的显式 provenance 适配。
