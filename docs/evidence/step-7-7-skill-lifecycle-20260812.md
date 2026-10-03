# Step 7.7 — Skill Eval、Canary 与 Rollback 验证证据

日期：2026-08-12

## 实现范围

- 新增 `packages/core/src/skill-lifecycle.ts`，提供 isolated evaluation、baseline/candidate 对比、utility/regression、permission expansion、secret/egress 门禁。
- isolated evaluation 在临时 workspace 中运行 runner，并在成功或异常后清理 workspace；候选 digest 写入 workspace 作为不可变输入标记。
- canary cohort 由 candidate digest 与 cohort key 确定性分配；启动时校验评测 digest、流量范围和候选状态，观测只能来自启动时的同一 cohort。
- promotion 需要离线评测通过、足量观测、成功率达标且无 safety incident；失败安全事件会阻断 promotion。
- active/canary 可立即 rollback；rollback 只追加状态和 audit/evidence，不删除观测或审计记录。

## 验证结果

```text
bun test --cwd packages/core test/skill-lifecycle.test.ts
4 pass, 0 fail

bun run --cwd packages/core typecheck
passed

bunx prettier --check packages/core/src/skill-lifecycle.ts packages/core/test/skill-lifecycle.test.ts
passed

bunx oxlint packages/core/src/skill-lifecycle.ts packages/core/test/skill-lifecycle.test.ts
0 warnings, 0 errors

git diff --check
passed
```

测试覆盖：隔离 workspace 清理、baseline/candidate utility、权限扩张拒绝、regression/secret/egress 拒绝、确定性 cohort、canary promotion、safety incident 阻断，以及 rollback 后保留 observations/audit/evidence。

## 当前限制

本步骤实现的是可复核的进程内生命周期原型；跨进程 durable 状态、真实 provider 评测、人工 actor approval 和统一 ActionGateway 接入按计划留在后续 Evolution Runtime/Promotion Gate 工作包，不在本步骤伪造完成。
