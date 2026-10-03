# Step 5.4 — Memory 写入与激活政策

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.4
状态：纯策略门禁完成；统一 durable writer 接入留到 Step 5.5。

## 决策合同

`packages/core/src/memory-policy.ts` 的 `evaluateWrite` 使用固定 `memory-write-policy-v1`，对 source、拟定 class、scope、sensitivity、user authority、cross-workspace、credential-like、short-term-state 做确定性决策：

| 场景 | 决策 | trust / 隔离 | 说明 |
|---|---|---|---|
| user + explicit authority | `active` | trusted / 不隔离 | 仍要求后续 audit/revision |
| user-corrected + explicit authority | `active_revision` | trusted / 不隔离 | 必须新 revision/supersedes，禁止原地改历史 |
| imported | `candidate` | untrusted-memory / 隔离 | 默认 review |
| model / auto | `candidate` | derived / 隔离 | 规则或人工激活前不进入 active |
| secret / credential-like / short-term / working | `reject` | derived / 隔离 | 默认拒绝 |
| global 或 cross-workspace 且无 explicit authority | `reject` | derived / 隔离 | 不能仅靠 source 字段放大权限 |
| quarantined source | `reject` | derived / 隔离 | 不允许用隔离状态绕过写政策 |

## 当前 cutover 边界

本步骤建立并测试统一策略函数，但旧 `MemoryV2.create/update` 仍保持既有兼容 API，尚未把 actor/principal、revision、evidence refs 接入其持久化写入。这是有意的步骤边界：Step 5.5 将先建立 durable writer 的 provenance/revision 合同，再将策略决策作为唯一写入口；在此之前不能宣称“所有长期写入已被 V1 策略接管”。

## 验证

- `packages/schema/src/memory-policy.ts`：可共享的输入/决策 schema。
- `packages/core/src/memory-policy.ts`：纯、可重放的策略实现。
- `packages/core/test/memory-policy.test.ts`：user、correction、imported、model/auto、secret、credential、working、short-term、global/cross-workspace、quarantine 覆盖。
