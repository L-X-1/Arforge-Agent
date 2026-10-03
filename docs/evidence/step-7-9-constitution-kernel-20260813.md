# Step 7.9 — Constitution Kernel 不可演进区验收证据

日期：2026-08-13

分支：`codex/phase-0-checkpoint`

## 结论

Step 7.9 已完成。Evolution 的可部署目标仍严格限制为 5 个 bounded advice namespace，
未扩大任何能力；Constitution Kernel 升级至 v2.0，并将计划规定的九类边界固化为
code-owned、frozen、fail-closed 的永久保护区。普通候选既不能把保护域作为 target，
也不能通过公开状态副本、低层 Durable 写入或篡改后的数据库 manifest 改写保护表。

## 永久保护映射

| V2 计划保护项           | 内核保护 namespace                                            |
| ----------------------- | ------------------------------------------------------------- |
| identity / ownership    | `identity`、`ownership`                                       |
| permission / policy     | `authority`、`permission`、`policy`、`approval`、`capability` |
| privacy / secret        | `privacy`、`secret`、`credential`、`retention`                |
| audit / event integrity | `audit`、`event`                                              |
| evolution gates         | `evolution`、`constitution`                                   |
| source-write authority  | `source`、`repository`                                        |
| release / signing       | `release`、`signing`、`signature`                             |
| rollback                | `rollback`                                                    |
| budget hard limits      | `budget.hard`、`budget.limit`、`budget.cap`                   |

既有 `security`、`sandbox`、`network`、`egress` 继续作为 permission/policy 边界的一部分永久保护。

## 强制点

- `ALLOWED_TARGETS`、`PROTECTED_PREFIXES`、`HUMAN_ACTOR_PREFIXES` 均为冻结只读值；
  Constitution class/prototype 同样冻结，运行时调用方不能追加目标或伪造 human actor class。
- `public()` 只返回数组副本；修改状态查询结果不影响真实内核。
- `validateTarget()` 先拒绝保护 namespace，再拒绝 allowlist 外未知目标。
- `DurableEvolutionV1.createProposal()` 在任何 artifact/事件/审计写入前验证 target，
  并要求 proposal target、manifest target、proposal Constitution version、manifest Constitution version 一致。
- Durable projection 在每次读取时重新验证 manifest target；即使数据库内容被越权篡改，
  也会 fail closed，而不会进入 evaluation、exposure 或 promotion 路径。
- 允许目标没有变化：`learning.failure`、`learning.fix`、`learning.preference`、
  `routing.advice`、`tool.advice`。
- self approval 与 source mutation 继续为 `false`；`runtime:` actor 仍不能获得人工授权身份。

## 可复现验证

```text
bun run --cwd packages/core test \
  test/evolution-candidate.test.ts test/evolution-durable.test.ts \
  test/evolution-exposure.test.ts test/evolution-governed.test.ts \
  test/evolution-runtime.test.ts test/evolution.test.ts
32 pass, 0 fail, 292 assertions

bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/schema typecheck
all passed

bunx oxlint packages/core/src/evolution/durable.ts \
  packages/core/test/evolution-durable.test.ts \
  packages/core/test/evolution-governed.test.ts
0 warnings, 0 errors

bunx oxlint packages/core/src/evolution/runtime.ts \
  packages/core/test/evolution-runtime.test.ts
204 warnings, 0 errors
```

`runtime.ts` 是保留的 3,400+ 行 filesystem compatibility reader；全文件 lint 仍暴露
204 条既有类型收窄/历史风格 warning，本步骤不把它们误报为 zero-warning。新增的
Constitution 测试区间没有 lint 告警；该兼容层债务保留到阶段 0–7 强制质量审查统一处理。

新增回归覆盖：九类保护域及关键子域、未知 target、冻结集合、公开副本隔离、
human actor class 不可扩展、Durable protected target 拒绝、manifest target/version 绑定、
数据库 manifest 篡改后的读取拒绝，以及允许目标正常通过。

因此可进入 Step 7.10；阶段 7 尚未完成，阶段 8 仍受阶段 0–7 全面质量审查门禁约束。
