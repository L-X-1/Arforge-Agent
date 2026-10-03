# Step 7.10 — Evolution L0–L5 能力边界验收证据

日期：2026-08-13

分支：`codex/phase-0-checkpoint`

## 结论

Step 7.10 已完成。Arforge 现有独立于 ActionGateway risk tier 的 Evolution Level 合同；
L0–L4 的允许行为由冻结矩阵定义，L5 虽可作为拒绝输入被解析，但永远不是可执行能力。
等级进入 canonical proposal、immutable manifest、durable lifecycle projection、状态 API、
protocol client 和 JavaScript SDK 类型，不再只是文档标签。

## 等级门禁

| 等级 | 实现约束                                                                                  |
| ---- | ----------------------------------------------------------------------------------------- |
| L0   | 仅 `suggest` / `report`，无 mutation 操作                                                 |
| L1   | 仅 `runtime.parameter.*`；必须 `securityCritical=false` 且 `reversible=true`              |
| L2   | 仅 prompt/workflow/skill candidate；offline evaluation 必须 isolated                      |
| L3   | 仅 isolated、reversible sandbox/canary；真实 canary 必须由 approved L2 进入               |
| L4   | 仅 human/policy approved、controlled、rollback-ready promotion；真实路径从 L3 canary 进入 |
| L5   | `modify_core_source` / `publish_core` 始终抛出 `EvolutionLevelViolation`                  |

## 强制点

- `AgentRuntime.EvolutionProposal` 必须带 `evolutionLevel`；当前可创建候选只能声明 L2。
- immutable candidate manifest 同时绑定 `evolution_level: L2`；proposal/manifest 不一致时，
  Durable 层在 artifact、event、audit 写入前拒绝。
- `EvolutionLevels.MATRIX` 及每个 level definition/operations 列表均冻结；状态 API 返回副本。
- candidate projection 顶层恒为 L2 artifact；state 根据 durable status 映射为 L0/L2/L3/L4。
- evaluate、approve/reject、canary、promote、rollback 的 state transition 显式写入相应等级；
  automatic rollback 只能把 active L3/L4 影响降回 L2。
- Core Learning 自动路径仍只能 create/evaluate L2 review candidate，不能进入 L3/L4。
- Durable 层拒绝 `code`/L5 candidate、L2→L4 直跳、未审批 L3 和非受控 L4。
- compatibility runtime 同步执行相同 L2 evaluation、L3 canary、L4 promotion 和 L5 禁令，
  但保持 read-only production 默认值。
- exposure E2E 不再用低层 DB 直写伪造 canary，而是走 create→evaluate→approve→startCanary 的真实治理链。
- schema、protocol client 与 JavaScript SDK 生成物已同步；SDK 同步同时补齐此前阶段已在
  protocol 中落地但尚未生成的 durable Evolution、controlled share/revert 和维护删除合同。

## 可复现验证

```text
bun run --cwd packages/core test \
  test/evolution-level.test.ts test/evolution-candidate.test.ts \
  test/evolution-durable.test.ts test/evolution-exposure.test.ts \
  test/evolution-governed.test.ts test/evolution-runtime.test.ts \
  test/evolution.test.ts
35 pass, 0 fail, 334 assertions

bun run --cwd packages/core test test/action-gateway.test.ts
85 pass, 0 fail, 446 assertions

bun run --cwd packages/schema typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client typecheck
bun run --cwd packages/sdk/js typecheck
6/6 passed

bun run --cwd packages/sdk/js test
2 pass, 0 fail, 3 assertions

client generated trees: generate-before/after SHA-256 set unchanged
SDK v2 generated tree: build-before/after SHA-256 set unchanged

bunx oxlint packages/core/src/evolution/level.ts \
  packages/core/test/evolution-level.test.ts \
  packages/core/test/evolution-candidate.test.ts
0 warnings, 0 errors

Prettier check: passed
git diff --check: passed
```

扩大到 10 个 Evolution/schema 变更文件的 lint 复核为 0 errors；其中 compatibility runtime
历史测试仍报告 12 个 unsafe-assertion warnings，本阶段未新增这些告警，且新 Level 合同及其直接测试为
0 warnings。

因此 Step 7.10 的功能、生成确定性与质量门禁均已闭合，可以进入 Step 7.11。
