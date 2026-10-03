# Step 6.15 — Recovery Planner 证据

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`

## 已实现

- `packages/core/src/runtime/recovery-planner.ts` 将恢复动作限制为六个有限枚举：`replay_result`、`resume_safe_phase`、`reconcile_external_state`、`compensate`、`pause_for_manual`、`fail_terminal`。
- `RecoveryContractRegistry` 按 action kind/version 注册声明式 recovery contract；contract 只描述安全 phase、是否可 replay/reconcile、是否有 compensation，不携带执行器。
- `RecoveryPlanner.decide()` 只基于 immutable intent 是否存在、lease 是否过期、observation/verifier、external state、当前 phase 和 contract eligibility 决策；model suggestion 仅作为回显建议，不能改变结果。
- 默认覆盖 file/shell/worktree/share/browser/workflow 六类 recovery contract。
- 未知 action、缺失 intent、活动 lease、不可恢复 phase 和 terminal phase 均 fail-closed 或进入 pause-for-manual。

## 验证

```text
bun run --cwd packages/core typecheck       PASS
bun test --cwd packages/core test/runtime/recovery-planner.test.ts  PASS (5 tests)
bunx oxlint recovery-planner.ts recovery-planner.test.ts             PASS (0 warnings, 0 errors)
git diff --check                            PASS
```
