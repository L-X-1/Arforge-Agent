# R17 结算恢复 outbox ack 前故障窗口（2026-09-15）

## 结论

本切片修复了一个实际的 R17 恢复缺口：DurableRun 的 child result、parent budget 与 ExperienceStore admission Evidence 均已提交，但进程在 `SettlementOutbox.commitPromoted` 返回前退出时，恢复审计已经是 `complete`，旧实现会直接返回并永久留下 `prepared` receipt。现在 `ChildSettlementRecovery.recover` 在拥有完整、无冲突事实时仍会重建相同的 recovery-outbox plan，按声明顺序幂等补齐 owner promotion proof，再提交 outbox；该分支不调用 Provider、不重放 owner payload，也不改变 same-transaction gate。

新增真实 Bun 子进程 SIGKILL 阶段 `after-owners-before-ack` 与 `after-outbox-commit`：前者在所有 owner 已落库、receipt 仍为 `prepared` 时强杀，后者先完成 ordered promotion/commit 再强杀。新进程从同一 SQLite 文件恢复并完成 ack 或幂等确认，第二次重启与并发恢复均不产生重复 owner 写入。

## 实现

- `packages/core/src/runtime/child-settlement-recovery.ts`
  - `complete` 审计不再无条件短路；先读取/重建 immutable settlement intent 和 recovery-outbox plan。
  - 对完整事实只执行 metadata-only promotion/commit；已提交且 promotion prefix 完整时幂等返回，旧 committed 行缺少 proof 时保持人工复核，不伪造证明。
  - promotion/ack 失败继续写 bounded `recovery-required` marker（best effort），不掩盖审计结论。
- `packages/core/test/runtime/child-settlement-recovery.test.ts`
  - 新增完整 owner 已提交、outbox 尚未 ack 的恢复回归；两条并发恢复只产生一份 ordered proof，后续 replay 的 `attempted/repaired` 均为空。
- `packages/core/test/fixture/admission-settlement-cross-owner-contract.ts`
  - 新增 `after-owners-before-ack` 与 `after-outbox-commit` 两个阶段。
- `packages/core/test/fixture/admission-settlement-cross-owner-worker.ts`
  - `after-owners-before-ack` 使用正式 `DurableRun.recordChildResult` + `ExperienceStore.recordAdmissionEvidence`，在 prepared receipt 边界等待 SIGKILL；`after-outbox-commit` 再按既有 owner 顺序 promotion/commit 后等待 SIGKILL。
- `packages/core/test/runtime/admission-settlement-cross-owner-sigkill.test.ts`
  - 将跨进程故障矩阵扩展为 before-evidence、after-evidence、after-result、after-owners-before-ack、after-outbox-commit 五阶段，并断言恢复后 receipt 已 committed、第二次重启无重复修复。
- `packages/core/src/runtime/child-settlement-recovery.ts`
  - 新增有界 `recoverPending` 正式恢复入口：按租户身份和 `prepared`/`recovery-required` 状态读取 metadata-only outbox，按 `updatedAtMs → intentID` 稳定顺序逐项委托同一 `recover` owner；返回 committed/pending/recovery-required/failed 计数、逐项 owner 写入摘要与 `hasMore`，不扫描 committed、不携带 payload、不调用 Provider。
- `packages/core/test/runtime/child-settlement-recovery.test.ts`
  - 将缺失 Evidence 的真实恢复改由 `recoverPending` 驱动，验证首轮扫描提交 1 条、第二轮排除 committed receipt、非法 page limit 被拒绝，Provider 始终禁止。

## 验收证据

| 范围                                | 命令/结果                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DurableRun recovery + bounded sweep | `D:\\bun\\bin\\bun.exe test test/runtime/child-settlement-recovery.test.ts --rerun-every`：**3 pass / 0 fail / 45 assertions，exit 0**；第三场景经 `recoverPending` 扫描并提交 1 条 pending receipt，第二轮扫描 0 条，非法 page limit 拒绝                                                              |
| 真实跨进程 cross-owner 故障矩阵     | `D:\\bun\\bin\\bun.exe test test/runtime/admission-settlement-cross-owner-sigkill.test.ts --rerun-every`：**5 pass / 0 fail / 145 assertions，exit 0**；覆盖 prepared 前后与 committed 后重启                                                                                                           |
| SQLite child settlement restart     | `D:\\bun\\bin\\bun.exe test test/runtime/child-settlement-sigkill.test.ts --rerun-every`：**2 pass / 0 fail / 42 assertions，exit 0**                                                                                                                                                                   |
| Outbox owner                        | `D:\\bun\\bin\\bun.exe test test/runtime/settlement-outbox.test.ts --rerun-every`：**8 pass / 0 fail / 89 assertions，exit 0**                                                                                                                                                                          |
| Same-transaction coordinator        | `D:\\bun\\bin\\bun.exe test test/runtime/settlement-coordinator.test.ts --rerun-every`：**7 pass / 0 fail / 48 assertions，exit 0**                                                                                                                                                                     |
| Observation projection              | `D:\\bun\\bin\\bun.exe test test/runtime/settlement-observation.test.ts --rerun-every`：**12 pass / 0 fail / 49 assertions，exit 0**                                                                                                                                                                    |
| 受控 PostgreSQL owner/soak          | `ARFORGE_SETTLEMENT_SOAK_ITERATIONS=100 D:\\bun\\bin\\bun.exe run db:test:postgres-settlement`：**passed=true / 15 checks**；三 owner 同一 backend transaction、失败全回滚、事务内 SIGKILL、outbox 恢复与 tenant isolation 均通过；100/100 observation samples 成功，cleanupVerified=true，residue 全 0 |
| Core TypeScript                     | `D:\\bun\\bin\\bun.exe run typecheck`：**exit 0**                                                                                                                                                                                                                                                       |
| Scoped lint                         | `D:\\bun\\bin\\bun.exe x oxlint` 覆盖 recovery 源码/测试及 cross-owner contract、worker、SIGKILL 测试五个文件：**0 warnings / 0 errors**                                                                                                                                                                |
| 格式/差异                           | 相关源代码、测试与夹具 Prettier 通过；限定 `git diff --check` 通过                                                                                                                                                                                                                                      |
| 迁移 freshness                      | 按 Python 依赖 → TS composition → source snapshot 重生成后 `validate-migration-freshness --root .`：**valid=true**；Python 5099/6715/6，TS source 1801、composition 3/5/3，source inputs 7710，capability links 4 records / 4 missing evidence                                                          |

测试使用临时 SQLite、临时 marker 和受控子进程，不读取或修改用户数据、不使用真实凭据，不执行三平台 full sandbox。

## 未关闭项

1. 这只关闭“所有 durable owner 已提交、outbox ack 前进程退出”的 R17 子窗口；R17 的完整 child/evidence/budget/outbox 全故障矩阵、正式入口全旅程和长期受控观察仍未结束。
2. `settlementCommitEnableGate()` 继续 `ready:false` / `keep-recovery-outbox`。本切片没有证明三个生产 owner 已在真实 PostgreSQL 长时环境共享一个事务，也没有修改 gate。
3. 已执行受控 PostgreSQL **100/100** coordinator samples，但未满足建议的连续 2 小时观察；observation window 仍是 review-only，`promotionAuthorized=false`，不能换算成生产切换授权。
4. R18/R19 外部 Provider、R20—R30 及真实 Linux/macOS/Windows full sandbox 继续按计划后置；三平台 full sandbox 只能在 R30 后执行。

## 正式产品入口投影（2026-09-15）

在同一 `ChildSettlementRecovery.recoverPending` Core owner 之上补齐了三种正式入口，三者共享同一状态机、租户边界和 metadata-only 约束，不再各自实现恢复逻辑：

- TS CLI：`settlement-recovery`（别名 `settlement-recover`）已注册到 `packages/arforge/src/cli-main.ts`。必须显式传入 `--confirm recover_settlements`；缺少确认只返回退出码 2 的结构化提示，不读取数据库、不写入、不回退 Python。`--status` 仅接受 `prepared`/`recovery-required`，`--limit` 在 1—1000 内有界，`--json` 不包含租户、用户或 payload。
- HTTP API：`POST /api/runtime-insight/settlements/recover-pending` 使用同一确认字面量、状态过滤和有界 limit；Server 只允许 Owner/Admin，返回协议化逐项 outcome/afterStatus/attempted/repaired 与 `hasMore`，禁止 Provider 执行和外部重试。OpenAPI 与 Promise/Effect 客户端已由协议生成器同步更新。
- Desktop 控制中心：Owner/Admin 才显示“结算恢复”按钮，必须经过开始 → 确认两步；结果卡仅展示计数、人工复核提示和 bounded metadata，成员不显示执行控件；`hasMore` 会明确提示继续扫描，当前页面上限固定为 100。

## 本切片验收

| 范围 | 实测结果 |
| --- | --- |
| TS CLI 正式恢复 smoke | `bun test test/cli/smokes/read-only.test.ts -t settlement-recovery --rerun-every`：**1 pass / 0 fail / 2 assertions**；无确认退出 2，精确确认的空租户 sweep 退出 0 |
| HTTP 正式恢复入口 | `bun test test/server/httpapi-runtime-insight.test.ts -t "bounded child-settlement recovery sweep" --rerun-every`：**1 pass / 0 fail / 6 assertions**；错误确认 400，正确确认 200，响应不泄漏 tenantID/userID |
| 协议与 OpenAPI | Protocol **6 pass / 16 assertions**；Server OpenAPI **2 pass / 19 assertions**；确认字面量、1—1000 边界和无 payload 投影均通过 |
| 生成客户端 | `packages/client` `bun run generate` 连续两次生成文件 SHA-256 稳定；Promise 合同 **22 pass / 0 fail / 94 assertions**，覆盖恢复入口的 POST、location query 和确认 body |
| Desktop 控制中心 | App typecheck **exit 0**；工作台文案/入口回归 **10 pass / 0 fail / 76 assertions** |
| CLI help 回归 | `help-snapshots.test.ts -u`：**1 pass / 0 fail / 94 assertions**；快照更新为当前 TS CLI 输出（新增 80 个稳定快照） |
| 限定静态检查 | 相关文件 Oxlint **61 warnings / 0 errors**；Prettier 与限定 `git diff --check` 通过。`packages/arforge` 整包 typecheck 仍被既有 OpenTUI JSX/BaseRenderable 类型不匹配阻断，未把该阻断伪装成入口通过 |
| 迁移 freshness | 依次重生成 Python dependency ledger、TS composition、source snapshot 后 `validate-migration-freshness --root .`：**valid=true**；Python **5857/6982/6**，TS source **1802**、composition **3/5/3**，source inputs **7712**，capability links **4 records / 4 missing evidence**；原始 digest 以仓库 `source-snapshot.v1.json` 为准 |

## 入口切片仍未关闭的边界

1. 当前 CLI/API/Desktop 仅证明空租户与协议/权限/投影旅程；尚未用 seeded pending receipt 完成一次 Desktop 端到端“扫描—人工复核—再次扫描”全旅程，CLI/API 也尚未提供稳定 cursor，只能依靠 `hasMore` 后重新运行页面。
2. 入口调用仍保持 review-only 语义，`settlementCommitEnableGate()` 继续 `ready:false / keep-recovery-outbox`；没有因入口可用而授权生产晋级或 Provider 重试。
3. R17 仍需完整 child/evidence/budget/outbox 故障矩阵与建议连续 2 小时观察；R18/R19、R20—R30 及 R30 后的三平台 full sandbox 继续后置。
