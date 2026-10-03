# R07：PersonalJob 原输入身份融合

日期：2026-09-12。对应 R07，并涉及 R17/R23 的后续恢复；本批完成输入身份缺陷的融合修复及下列验证，不关闭任何整阶段。

## 本批需求与验收边界

同一次 PersonalJob 在 heartbeat、失联恢复、暂停/继续后，必须复用原输入身份；下一次周期执行必须取得新身份。沿用原 PersonalJob 事件状态、Core SessionInput 和 Formal Runner，不另建调度、去重或任务状态服务。凭据授权与预算仍由原执行发起方提供，不从输入标记推断新权限。

## 实际复现与修复

- 两条修复前回归使用真实 PersonalJob 服务和 SQLite 事件，通过受控 Session 边界与丢失结算故障注入，观察原执行器提交的消息 ID：恢复从 `_2` 变成 `_4`，暂停/继续从 `_2` 变成 `_5`。测试实际 **0 pass / 2 fail / 9 filtered / 7 断言**；这是生命周期注入，不冒充真实进程强杀。
- 在现有 `PersonalJob.Info` 增加可选 `Occurrence`（version=1、messageID、digest）。首次 start 将输入身份与原状态变更一起持久化；heartbeat、recover、pause/resume 保留；只有原周期 tick 准入下一次执行时更新。复用原事件事务和 revision/CAS，没有新增数据库表或独立 writer。
- digest 绑定 jobID、sessionID、原 prompt 和 messageID。原历史回放检查绑定、原输入/归属及合法变更阶段；替换 messageID、篡改摘要、移除绑定和修改原 prompt 均拒绝。摘要是完整性检查，不是签名或授权。
- 原 `PersonalJobExecutor` 消费持久化 messageID，不再用每次 start 的新 revision 重新计算。原 Core SessionInput 已有按 ID 准入去重，继续使用同一入口。扩大回归把两次执行的输入提交接到原 SessionInput/SessionProjector，SQLite 队列始终只有一条原文本输入。
- 旧事件可正常解码，缺少 occurrence 时编码不输出 undefined，也不自动填造身份。已经尝试过但没有可验证输入身份的旧任务，start 返回明确错误，原任务不变、不自动重发。旧任务的显式安全接续仍须后续迁移/恢复旅程完成；拒绝重发不等于其恢复已完成。
- 使用原客户端生成器更新 Promise/Effect 客户端，复用同一 Schema/Protocol；未手写第二份契约。

## 已结束的验证

环境为本机 Windows、Bun 1.3.14。Core 使用隔离内存 SQLite；Formal 夹具使用临时工作区、原产品服务和本地 HTTP 模型服务，不请求真实远端模型，不改真实用户数据库或凭据。重叠批不累计。

| 检查 | 结果与证明范围 |
|---|---|
| Core `bun test --rerun-every test/personal-job.test.ts test/personal-job-executor.test.ts` | **30 pass / 0 fail / 129 断言 / 2.10 秒**：恢复/暂停输入复用、原队列唯一记录、heartbeat 保留、下一周期新身份、旧 schema/拒绝猜测恢复、4 类历史漂移及既有生命周期 |
| 最终 Core 上述两文件加 `test/session-run-coordinator.test.ts` | **63 pass / 0 fail / 217 断言 / 2.48 秒**；覆盖上一批非继承 scope 与原串行执行规则 |
| 最终 Arforge `bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal PersonalJob\|Formal scoped execution'` | **2 pass / 0 fail / 170 filtered / 32 断言 / 15.18 秒**；原 PersonalJobExecutor 服务、Session、Formal/Core Runner 和本地真实 HTTP 连续完成两次周期执行：两条不同输入、两条 completed run、正确文本结果、无残留队列/activeAttempt/lease。旧 processor 为抛错哨兵；另一项为前轮 scope 隔离回归 |
| Server `bun test src/personal-job-openapi.test.ts` | **1 pass / 0 fail / 2 断言 / 1.84 秒**；验证正式执行/dispatch OpenAPI 入口仍在，不是 HTTP 用户冷恢复验收 |
| Client `bun run generate` 后 `bun test` | 生成 exit 0；**32 pass / 0 fail / 147 断言 / 7.09 秒**，含 Core/Server 契约身份、生成一致性、Promise/Effect 与导入边界 |
| Workspace `bun turbo typecheck --concurrency=2 --force` | **22/22 successful，0 cached，69.179 秒**；Schema/Core/Arforge/Server/Protocol/Client 等实际重查。之后仅对测试做无语义格式整理，并重新通过上方最终 Formal 批 |
| 最终格式与差异检查 | 六个源/测试文件和两个生成目录 Prettier 通过，`git diff --check` 通过 |
| 六文件 scoped lint | **67 warnings / 0 errors**：既有 PersonalJob 7、executor 测试 1、prompt 测试 59；本批新增范围没有告警，不宣称整仓清零 |

调试中 Core 类型检查发现测试将 branded 消息 ID 保存为普通 string，已改成原 SessionMessage.ID 数组；首次 workspace 类型检查又发现 Formal 断言包含未收窄的可选 occurrence，已加明确缺失错误再读取 ID，并用强制全工作区重查确认。不删断言、不放宽产品输入校验来换取通过。

## 尚未证明、下一步必须完成

1. 本批恢复回归为原生命周期/数据库上的故障注入；正式 HTTP 项只验证正常首次和周期执行。**尚未验证 PersonalJob 自己的 SIGKILL→新进程恢复**，不能用此前 Session AppRuntime 的 14 项强杀测试替代。
2. 将 occurrence 继续绑定原 run、原结果/assistant 与结算 receipt。当前执行器仍以“执行前没有出现过的 assistant ID”选结果；若原结果已完成而 Job 结果尚未提交，或恢复更新原 assistant，该策略不能作为可靠恢复证明，必须用原执行事实核验，不猜测最新一条消息。
3. 原生产 billing adapter 缺少有效价目表时仍可能返回 undefined；本批正常 Formal 旅程不声称验证费用上限。还需处理当前凭据授权、缺价策略、部分计费后的原预算与当前额度、费用/结果恰好一次补记、取消与暂停的竞争。
4. 当前 older-task 错误避免未知重发，但需要接明确的用户处置与可证明安全的旧输入/run 对照。运行中权限变化、busy/idle 投影、跨进程并发、PostgreSQL、完整租户边界、桌面旅程及大历史性能继续未验收。

R06/R07/R09/R17/R23/R30 保持未关闭，R31 真实三平台 full sandbox 仍按用户要求最后执行。没有修改全局 CLI、PATH、真实凭据配置，也未新增 Python 产品路径。

## 来源台账

composition=`79429fd8efebe8f888e82801bc83bb972cb67cd3ec500557262a8fc8d843effe`；runner-negative=`271dfa6d60c8a3db52127ae93f3cb38f49014553535c661525679b40a062a77a`；dependencies=`fed5bb080bffc7166e4949820e1a0a14f7b9ef1b7b44676634f47fb316983d2e`（7278 文件、7478 叶、6 assets）。完整来源输入由本批重新生成的 source-snapshot 和 migration-freshness 核验；来源有效不是功能完成率。
