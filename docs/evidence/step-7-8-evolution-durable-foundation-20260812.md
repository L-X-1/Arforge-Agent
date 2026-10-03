# Step 7.8 — Evolution Runtime 统一内核迁移验收证据

日期：2026-08-13

分支：`codex/phase-0-checkpoint`
验证基线：`0ad7b8cda7778728a8c9299403faea8d4ea58b4c`

## 结论

Step 7.8 已完成。生产路径的新写入以 TypeScript Core、Drizzle/EventV2、
ControlRun/ActionGateway 为唯一事实源；filesystem JSON/JSONL 只保留显式只读兼容入口，
不存在 DB/filesystem 双写。候选创建、评估、审批、canary、promotion、receipt、archive/restore
和 rollback 均有数据库投影、审计和可重放路径。

## 实现范围

- `evolution_proposal`、`evolution_evaluation`、`evolution_observation`、
  `evolution_exposure`、`evolution_artifact`、`evolution_audit`、`evolution_lease`
  Drizzle 表均带 tenant/owner 归属和索引；SQLite/PostgreSQL migration、RLS/grant 与生成物同步。
- `DurableEvolutionV1` 保存 immutable artifact、proposal、evaluation 和 lifecycle state；
  expected revision/CAS、artifact/evaluation digest binding、tenant isolation 与 hash-chain audit 在 DB 实现。
- EventV2 commit hook 将事件、投影与 audit 放在同一 durable commit 边界。
- `GovernedEvolutionV1` 将 lifecycle mutation 冻结进 `ControlClaimIndex`，由 `DurableRun`
  lease 协调并通过 `ActionGateway` 执行；L3 人工动作需要 fresh approval。
- `ActionGateway` 只允许绑定真实 ControlRun 与有效 opaque lease 的 L1 自动控制动作；
  未绑定 L1 及 L0/L2/L4 control-plane 动作 fail-closed，L3 仍要求人工授权。
- `EvolutionCandidateV1` 提供 DB safe projection、内置隔离评估、approve/reject/startCanary/
  promote/rollback；create/evaluate/approve/canary/promote/rollback 的重复意图均可确定性收敛，
  不生成第二个副作用或第二条审计状态变更。
- Core Learning convergence 使用受信任 `system:core-learning` 身份与绑定 L1 ControlRun；
  自动路径只能创建声明为 L2/scoped candidate 的 review-only proposal 并执行离线评估，
  不能 approve、canary、promote 或 rollback。immutable evidence identity 防止可变 pattern 文本覆盖既有 artifact。
- 真实 promotion E2E 使用 candidate/control 两组各 5 条 DB observation，通过实际 canary gate 后，
  再由 fresh-human L3 动作推广至 100%。
- `EvolutionExposureV1` 保存 digest-bound ticket、receipt 和 observation；同 outcome 重试幂等，
  不同 terminal data 冲突。公开投影不暴露 raw cohort key 或 evidence body。
- outcome 先持久化 receipt，再由候选协调层对账自动 rollback。候选组 safety incident 立即回退；
  candidate observations 达阈值且成功率/对照差值不健康时触发 health rollback。
- 自动 rollback 使用受信任 `system:evolution-monitor`、绑定 L1 ControlRun，且只能从
  canary/promoted 降到 rolled_back。治理层独立复核 recorded receipt、candidate digest、cohort、
  safety flag 或健康阈值；伪造 exposure/状态/actor/reason 均 fail-closed，不发起人工批准。
- receipt 已提交而 rollback 尚未完成时，重复 `recordOutcome` 会继续 reconciliation；
  Durable transition 支持 exact-state replay，覆盖副作用提交后、观察或 ControlRun 完成前的崩溃窗口。
- DB-native exposure archive/restore 实现 preview digest、state/revision binding、4 MiB artifact 边界、
  manifest/evidence/completion digest、CAS、冲突/容量门禁、immutable receipt 与跨代际幂等；
  apply 路径同样经过 L3 ActionGateway/ControlRun。
- server 与默认 `EvolutionV2` facade 从 request-scoped principal 派生 tenant/user 和受信任 actor；
  只有无请求上下文的本地模式使用 `ten_local/usr_local`。UI/API 仅查询 safe projection。
- 显式 filesystem compatibility layer 与直接构造的旧 `EvolutionRuntime` 默认 read-only；
  只有 `legacyWriteMode: "test-only"` 的隔离兼容测试可启用旧 writer。

## 可复现验证

```text
bun run --cwd packages/core test \
  test/evolution-candidate.test.ts test/evolution-durable.test.ts \
  test/evolution-exposure.test.ts test/evolution-governed.test.ts \
  test/evolution-runtime.test.ts test/evolution.test.ts
30 pass, 0 fail, 258 assertions

bun run --cwd packages/core test test/action-gateway.test.ts
85 pass, 0 fail, 446 assertions

bun run --cwd packages/core test test/tenant-ownership.test.ts
2 pass, 0 fail, 133 assertions

cd packages/schema && bun test test/evolution-exposure-audit.test.ts
5 pass, 0 fail, 13 assertions

bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/schema typecheck
all passed

bun run --cwd packages/core migration --check
passed; no incremental schema drift; full migration generated successfully

bunx oxlint packages/core/src/evolution/{candidate,durable,governed}.ts
0 warnings, 0 errors

bunx oxlint <all nine changed TypeScript/test files>
167 warnings, 0 errors
```

广范围 oxlint 的 167 条 warning 主要位于既有大型 exposure/action-gateway 实现及历史测试规则债务；
本证据不将其误报为 zero-warning。封板前另执行 Prettier check 与 `git diff --check`。

## 退出条件核对

- lifecycle mutation：统一 ActionGateway/ControlRun，完成。
- trusted actor：完成，renderer/product placeholder 不可写。
- metadata/status：Drizzle/EventV2，完成。
- immutable artifact：artifact store，完成。
- filesystem：只读 import/compat source，完成，无双写。
- expected revision/CAS：完成，并补 exact replay。
- cross-process owner/lease：DurableRun，完成。
- UI/API：safe projection，完成。
- promotion/rollback：真实 observation gate、fresh approval、自动安全回退与审计均完成。

因此可进入 Step 7.9；阶段 7 尚未完成，且阶段 8 仍受“阶段 0–7 全面质量审查”门禁约束。
