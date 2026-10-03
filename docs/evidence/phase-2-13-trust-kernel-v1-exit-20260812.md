# Phase 2.13 — Trust Kernel V1 退出门禁证据

- 日期：2026-08-12
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 2.13
- 分支：`codex/phase-0-checkpoint`
- 范围：Gateway、L3 fresh-human、Durable Action/Run、SQLite/PostgreSQL、Windows/Electron packaged acceptance、secret redaction、generated contracts

## 退出门禁结果

按计划要求逐项核验，七项门禁均通过：

| V2 门禁 | 结果 | 证据 |
| --- | --- | --- |
| 所有已启用外部副作用走 Gateway | 通过 | `docs/evidence/phase-2-7-gateway-bypass-audit-20260811.md`；workflow command 未绑定 canonical identity 时保持 hard-block |
| L3 未确认副作用为 0 | 通过 | Core 内置 catalog 36/36，`missing=0`、`undeclaredEffects=0`、`invalidDeadlines=0`；HTTP control operation 3/3；未知/plugin/命令类副作用统一 fail-closed 为 L3 human |
| policy、subject、resources、semantics、grant exact binding | 通过 | `docs/evidence/phase-2-8-capability-lifecycle-20260811.md`；ActionGateway focused regression 85 pass、0 fail、444 assertions |
| SQLite/PostgreSQL 合同一致 | 通过 | `schema.gen.ts` 与 `postgres-schema.gen.ts` 的生成表清单均为 49 张，关键 `event_sequence`、`event`、`session_run`、`control_run_claim`、`workflow_graph_events` 均存在；最终 packaged SQLite/PG 矩阵均通过 |
| packaged Windows/Electron crash matrix | 通过 | `docs/evidence/phase-2-12-packaged-e2e-20260811.md`；最终包的 crash acceptance 连续 3 次通过，SQLite 与 PostgreSQL 边界矩阵各连续 3 次通过 |
| snapshot/event/UI/log/artifact 无 secret | 通过 | packaged credential migration 检查 plaintext 缺失且使用 Windows DPAPI；UI、durable evidence、artifact 断言通过；最终 artifacts 与 packaged `app.asar`/可执行文件的脱敏 sentinel 扫描命中数均为 0 |
| generated contracts 无漂移 | 通过 | `bun run --cwd packages/client check:generated` 通过，随后 `git diff --exit-code -- packages/client/src/generated packages/client/src/generated-effect` 通过 |

## 本次收口修复

PostgreSQL packaged acceptance 暴露并已修复一个真实一致性问题：
`packages/core/src/event.ts` 的 `commitDurableEvent` 现在在 PostgreSQL 事务
callback 内统一使用 callback 提供的 transaction handle，`event_sequence`、
`event` 以及相关 durable projection 写入不会再错误地落到事务外的连接上。

边界 acceptance 同时增加了显式 backend 选择，并将 snapshot 断言绑定到当前
durable Run/Action，避免 PostgreSQL 主库中历史测试数据影响当前场景判断。

## 新鲜验证

- Desktop typecheck：通过。
- Desktop test：86 pass、0 fail、224 assertions。
- App typecheck 与 E2E typecheck：通过。
- Core、Server typecheck：通过。
- Client typecheck：通过。
- 最终 Windows build/package：通过；仅有既有 Vite warning。
- `git diff --check`：通过。
- 未执行 PostgreSQL schema/migration/清理/删除；仅使用已授权的本地数据库正常测试写入。

## 非本步骤退出门禁的既有基线问题

以下审计在当前仓库仍有既有基线结果，本次未修改无关文件，也不将其伪报为通过：

- 全仓 lint 仍被 `packages/website/src/layouts/SiteLayout.astro:54` 的既有语法错误阻断，另有既有 warning。
- `tier2:audit` 仍报告既有 retirement manifest/approved target 问题。
- `fusion:audit` 仍报告既有 vendored/dist/license 基线命中。
- `brand:check` 仍报告 `opencode.json` 与 attribution register 中的既有旧产品名命中。

这些结果不改变本步骤七项明确退出门禁的验证结果；应作为后续仓库卫生工作单独处理。

## 结论

V2 Step 2.13 的退出门禁已满足，可以发布“Trust Kernel V1 内部可用”结论；
该结论不等同公开 Beta。阶段 2 封板，下一步严格进入阶段 3 的 Step 3.1：
Provider/Protocol 资产盘点。

本次仅保留本地 checkpoint 分支和本地提交，未执行 Git push；未暴露任何凭据
或 secret 原值。
