# R07：PersonalJob 原价目、费用补记与请求绑定

日期：2026-09-13（Asia/Shanghai）。接续 `plan-v2-r07-personal-job-result-recovery-20260912.md`。本批为原生产服务组合、本地 HTTP、隔离 SQLite 和故障注入验证；没有关闭 R06/R07/R09/R17/R23/R30，也没有执行 R31。

## 实际问题与原位修复

1. 原 PersonalJobExecutor 在价目表不存在或尚未生效时返回 `undefined`，使任务不带 billing 约束继续执行。现在复用原 `NotRunnableError`，在 `jobs.start` 和输入准入之前拒绝，给出模型、配置当前价目表及重试提示；任务状态、revision、attempts 和队列不变。显式零费率仍然有效，不把“没有价格”解释为免费。同步补齐该错误的 `message` getter，让原 HTTP Conflict 映射能得到原因；未增加协议错误类型或第二个计费入口。
2. 真实计费正例通过原 Session location 的 Catalog.transform 安装确定价目，经原 PersonalJobExecutor.Service→Session scoped execution→Formal/Core Runner→本地 HTTP→SessionRunUsage 原凭证执行。正文报告 input=2/output=3，单 token 1 micro，结果与 Job 累计成本均为 5；零费率为 0，仍有完整 billing admission/receipt。
3. 在原 PersonalJob.Changed projector 中一次性注入“原模型与账单完成、Job 结果提交失败”，实际 SQLite 事务回滚后，原 run completed、Job running/未记成本。随后删除价目、变更价目或删除原测试凭据，原 owner 仍只补记已完成事实，按原 receipt 的冻结价格记录 5 micro；不重新发送、不创建 attempt、不改原 run 或账单。删除凭据发生在原 run 完成之后，不能推导运行中撤权或待执行恢复已完成。
4. 复现了原 receipt 的 requestDigest 被改成无来源摘要后仍可补记的问题。现在原只读结果模块逐笔核验原 RequestEnvelopePrepared/Compaction.RequestPrepared，严格绑定 session、run、请求摘要、Provider 与 model；仍由原 RuntimeBilling 检查连续预算、价格与结算，不另建账本或结算器。错误只返回原因，不回显请求内容。
5. 原压缩摘要 envelope 缺少 run_id，无法证明费用属于哪次运行。原 SessionCompaction 的内部 Input 现在必需 runID，既有 proactive 和 overflow 两个 Runner 调用均传原身份，写入原 envelope.execution.run_id。沿用同一 Event/请求合同，没有独立摘要请求机制。原记录缺该身份时不能猜测迁移为已验证。
6. 再复现“摘要账单存在、正文最终账单整行丢失”仍被当成完整费用。原预算回放可以接受一个合法前缀，因此结果读取还必须确认最终完成请求有已结算凭证。现在拒绝缺失尾项，不会以摘要的 18 micro 代替真实总额 23。隔离夹具恢复原行后，同一 Job 可补记成功，HTTP 仍两次。

## 已验证场景

- execute、launch 两入口 × 价目缺失/未来生效：拒绝时 HTTP=0、Job 完全不变；补装显式零费率后原 revision 重试成功，attempts=1、HTTP=1。
- 原生产服务普通付费与显式免费执行、重复执行已完成结果：成本、账单、原 run 不重复。
- 结果写入丢失后价格删除/涨价/凭据删除：以原账单补记，不产生新授权或新请求。
- 凭证摘要漂移、凭证置空、仍未结算：拒绝补记、Job 不变，原凭证恢复后可正常补记。
- 主动摘要和正文均经原计费管线：摘要 usage=7+11，正文 usage=2+3，总成本 23 micro，两笔原凭证。故障后补记仍是同一结果、同一成本、同一 attempt。
- 最终账单整行缺失：保留摘要账单也不能成功补记。
- 既有结果恢复、暂停/取消、并发/CAS、队列/steer 隔离、周期任务、scoped 普通输入隔离、正文/摘要发送前凭据变化和实际压缩传输回归保留。

## 实际测试记录

Windows / Bun 1.3.14；均已结束。重叠批次不累计，不按断言数换算计划完成率。

| 检查 | 结果与范围 |
|---|---|
| 最终 Formal 筛选 | `bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal PersonalJob\|Formal scoped execution\|Formal compaction HTTP\|Formal credential billing boundary'`：**36 pass / 0 fail / 160 filtered / 633 断言 / 163.84 秒**，包括最终账单丢失修复 |
| Core 扩大六文件 | `bun test --rerun-every test/personal-job.test.ts test/personal-job-executor.test.ts test/session-compaction.test.ts test/session-runner-history.test.ts test/billing.test.ts test/session-runner.test.ts`：**263 pass / 0 fail / 1625 断言 / 166.75 秒**；在最后的账单尾项 guard 之前，不能单独证明该后加检查 |
| 最后 Core 三文件 | `bun test --rerun-every test/personal-job.test.ts test/personal-job-executor.test.ts test/billing.test.ts`：**49 pass / 0 fail / 226 断言 / 1.80 秒**；最终账单 guard 的产品证明以上方最终 Formal 批为准 |
| 类型检查 | `bun turbo typecheck --concurrency=2 --force`：**22/22，0 cached，54.987 秒**；最后账单 guard 和夹具整理之后 Core、Arforge 又分别 typecheck，均 exit 0 |
| 格式与差异检查 | 六个源/测试文件 Prettier check、git diff --check 均 exit 0 |
| Scoped lint | 六文件 **89 warnings / 0 errors**。原 Runner 23、原 prompt 测试 59、原 compaction 6、原 executor 测试 1；新结果校验模块与 executor 无警告。新增夹具的一处 consistent-return 已修，其他既有警告未清零 |

失败复现与调试边界：

- 缺价 execute/launch 修复前返回成功，违反启动前拒绝断言。初轮完整筛选是 0 pass/6 fail/26 断言/46.00 秒，但不能把它说成六个产品缺陷：有价目表正例的初始夹具使用 TestInstance 派生 location，在实际 Session 执行前未读到该价目。改为创建 Session 后从原 Session.get 取得 location，并断言 Catalog 中确有该价格后重新验证；没有把这次夹具修正记作产品费用功能修复。
- requestDigest 漂移：修复前该批 **5 pass/1 fail/126 断言/45.13 秒**，错误账单仍被接受。
- 摘要 run 绑定：修复前 **0 pass/1 fail/7 断言/6.92 秒**，原 envelope.execution.run_id 为 undefined。
- 摘要存在但最终账单删除：修复前 **0 pass/1 fail/10 断言/9.75 秒**，任务仍被补记完成。
- 一个新夹具未收窄 SessionRun/ControlRun 导致 Arforge 类型失败，已修正；主动压缩夹具曾有末尾空格和旧配置字段名错误，已分别按原 Prompt 约束 trim、使用现有 `compaction.reserved`。没有放宽产品 Schema、替换 Provider/计费服务或删除断言来通过。
- 一次 Core 命令误带不存在的 `test/runtime-billing.test.ts`，Bun 只执行其余四文件（46 pass）；该结果不充当 billing 验证，后续上表明确执行真正的 `test/billing.test.ts`。

## 仍未验收与下一步

1. 本批 Catalog.transform 是原服务的测试价目来源，不等于普通用户已通过实际配置/桌面界面完成价目设置。下一步验证既有 TS `config/provider.priceCatalog`→原 Catalog→任务入口的完整用户路径，以及缺价的后台状态提示，不能把安全拒绝当作体验交付。
2. 原 run 尚未完成、已有部分用量/结算、当前价目或凭据改变时，恢复必须保留原预算和额度，使用当前有效授权；运行中撤权、未知发送结果的用户处置、未结算账单的真实对账仍未闭合。当前证明仅是已完成原运行的结果/费用补记。
3. 多步工具任务、重试/fallback、小模型/标题费用和跨币种/精度恢复仍需其实际入口的完整证明；不能把单正文及同模型摘要两账单等同全来源计费完成。大历史查验的性能也未验收。
4. failed/cancelled 原 run、历史误判 failed 的旧 Job、原 Job/Run 租约与取消/耗尽竞争、缺少原身份的旧记录仍按原计划继续。
5. 随后执行 PersonalJob 自身 SIGKILL→新进程恢复与并发验收；以前 Session worker 测试不替代它。本批事务故障注入不冒充强杀、PostgreSQL、多租户、桌面完整用户旅程。
6. R06/R07/R09/R17/R23/R30 继续开放；R31 真实 Linux/macOS/Windows full sandbox 仅 R30 通过后执行，不考虑发布阶段。

## 来源与安全边界

- composition：`895400f7e0ea5d4e67f248cd69fa0c47bbaf158ebef4dc42afefa4a7d226799b`（1757 源文件、3 roots、5 bindings、3 Runner uses）。
- runner-negative：`362b2eb5260fff6dd4b234a143d6d93654c22ad4f351e381ef9083d2f61ea3eb`。
- dependencies：`9cb2e6c8ba92cac3eba6f1ebd260908df16e65bb832a2fe5e13f2fff4ce4a08d`（7280 文件、7478 叶、6 assets）。文档同步后重新生成 source snapshot，并只读核验 freshness；静态有效不作为能力验收证明。

本批未动真实用户账户、凭据、数据库、PATH 或全局 CLI；没有新增 Python 产品路径、协议/客户端手写合同、状态表或服务 owner。未提交/推送，保留工作区无关改动。
