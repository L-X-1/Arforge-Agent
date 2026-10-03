# R07：PersonalJob 原运行与结果恢复首批

## 最新接续：原 owner 补记结果不消耗尝试次数（2026-09-12）

本节为最新状态；下方“首批”保留历史范围，不重复累计。当前仍不关闭 R06/R07/R17/R23 或整计划。

实际复现：原 HTTP 回归增加次数断言后，普通恢复 attemptsUsed 从 1 变 2；maxAttempts=1 则被 recover 先写 failed，原完成结果无法补记。修复前 **0 pass / 2 fail / 23 断言 / 14.13 秒**。

原位融合：

- 将上一批原结果读取与摘要/附件编码移动到 `personal-job-result.ts` 这个无状态内部模块，只有一份实现。原 PersonalJob 服务消费既有 DurableRun.globalNode、SessionStore、EventV2/Database，复用原运行与消息 owner；Executor 不再保留另一套生产结果读取路径。该 helper 没有服务注册、状态表、轮询器或写入职责。
- 原 PersonalJob 增加内部 `reconcileResult(jobID, expectedRevision)`。只接受原任务身份与版本，不接受调用者提供的结果、run 或权限摘要。内部验证原 occurrence、原 run/checkpoint/request/assistant/receipt 后，使用原 `mutate→persistChanged→PersonalJob.Changed` 写结果。`recordResult` 与 reconcile 共用同一个结果校验和状态构造函数。
- execute/launch 在新 start 前先调用原 owner 补记；原 recover 在判耗尽和重新排队前先补记。若已有完成事实，不创建执行、输入、租约、attempt 或 Provider 请求；重复补记保持原完整 Job 不变。暂停/取消不复活；queued 的已执行 occurrence 可以在用户恢复后补记；原状态版本/CAS继续保护并发。
- 补记在原 EventV2 提交事务内再次读取原证明；消息/请求/结果证据变化时整个写入回滚。重新排队/耗尽失败的提交也再次检查原结果，避免沿过期的首次读取覆盖刚可见的完成事实；这一后置检查没有被宣称为真实跨进程时序验收。
- 另实际复现了附件凭证摘要不一致：Executor 已按 wire 编码 DateTime，原 PersonalJob.recordResult 仍直接对含 DateTime 的对象计算摘要，真实 owner 拒绝结果。专项修复前 **0 pass / 1 fail / 1.239 秒**。现两者共用原结果编码 helper，仅哈希明确结果字段，不混入已有 digest/recordedAt；保留 schema 编码与完整摘要检查，非取消完整性校验。新增真实 owner 写入/回放测试通过；测试凭证并不代表该 fixture 路径上的文件实际存在或可取。

本机 Windows/Bun 1.3.14、隔离 SQLite、本地 HTTP；以下重叠批不累计：

| 验证 | 已结束的实际结果 |
|---|---|
| 最终 Formal 筛选 `Formal PersonalJob\|Formal scoped execution` | **12 pass / 0 fail / 170 filtered / 192 断言 / 36.27 秒**。原结果/较新无关结果/缺绑定、单次尝试、已重新排队补记、用户暂停/取消、四候选并发补记、提交时绑定漂移回滚、普通 queue/steer 分离、连续周期和 scope 隔离 |
| 提交漂移专项 | **1 pass / 15 断言 / 6.65 秒**。原 Changed 事务的 projector 注入 Step.Started 关联变化；原回调重查拒绝，Job 和全部事件快照均保持；关闭一次性注入后正常补记，HTTP仍1。这是实际 SQLite 事务故障注入，不是进程强杀 |
| 并发/暂停/取消专项 | **3 pass / 43 断言 / 11.44 秒**。四个相同 expectedRevision 候选最终只提升 Job 一次 revision、attempts仍1；重复新版本补记不写，旧版本拒绝；暂停/取消完整快照保持 |
| Core 原 owner 六文件 | **155 pass / 0 fail / 670 断言 / 5.33 秒**。DurableRun、pending recovery、PersonalJob、executor、history、coordinator；在最后重排队/耗尽失败提交重查之前，故不单独证明该后加分支 |
| 最后原 PersonalJob/Executor 两文件 | **31 pass / 0 fail / 137 断言 / 1.72 秒**；随后 Core typecheck exit 0；覆盖原生命周期、输入身份与新增真实 owner 附件凭证摘要 |
| Client 默认 `bun test` | **32 pass / 0 fail / 147 断言 / 4.91 秒**；本批没有 wire schema/协议变化，不手改或重复生成客户端合同 |
| Server OpenAPI 原入口测试 | **1 pass / 2 断言 / 1.417 秒**；不是 HTTP 冷恢复或完整用户旅程 |
| Workspace typecheck | 强制 **22/22，0 cached，51.07 秒**。首次扩大类型检查发现故障注入夹具额外暴露 DurableRun 错误联合，改为夹具明确 defect 后通过；最后仅提交前重查/void 返回整理，Core 再查通过 |
| 格式、diff-check、lint | 五文件格式/diff-check exit 0；lint **66 warnings / 0 errors**（原 PersonalJob 7、原 Formal prompt 测试 59），新共享模块、Executor 与 Core 测试无告警；新增回调的一处 consistent-return 告警已修 |

下一步仍必须完成：有价目表的实际 PersonalJob 费用恢复/当前凭据与原预算、缺价策略、部分用量和费用恰好一次补记；failed/cancelled 原 run 及历史上已经误判 failed 的旧 Job 的显式处置；原 Job 与正在执行 Run 的租约/取消/耗尽竞争；PersonalJob 自身 SIGKILL→新进程正式恢复。当前不通过放宽任意 failed→completed 来修旧记录，也不把上述 SQLite/本地 HTTP 注入冒充强杀、PostgreSQL、多租户或桌面全旅程。R31 真实 full sandbox 最后执行。

本批来源：composition=`2386b616c68d85aaa4d40705cd78fd9e52e71e93a5ed3e47830e4afdde113767`；runner-negative=`f0f02084ed1dd0f608c496b04234fef65a2087ce9bcad76aa4315fc076b901ae`；dependencies=`ca2ac5cd3ac38ef76865be4b698f920dad4c2243602bf9f04e8285e912687c4b`（7280 文件、7478 叶、6 assets）。文档更新后重建 source snapshot 并核验 freshness；静态有效不替代能力验收。

## 上一批历史：原运行与结果恢复首批

日期：2026-09-12。接续原输入身份批次，涉及 R06/R07/R17/R23。这里只验收下列切片，不关闭整阶段，也不替代真实进程强杀、费用和用户旅程验收。

## 实际缺陷与回归

1. 正式 PersonalJob→Core Session→Formal/Core Runner→本地 HTTP 回归，在模型完成后、PersonalJob.recordResult 提交前注入进程内 defect。原 run 已 completed、job 仍 running。沿原 recover 重新排队后执行，修复前 HTTP 从 1 变成 2：**0 pass / 1 fail / 10 断言 / 10.72 秒**。这是生命周期故障注入，不是 SIGKILL。
2. 原 DurableRun.create 的事务只检查未完成 run，因此同一 occurrence 的原 run completed/failed/cancelled 后均能重新创建。三条原 owner 回归修复前 **0 pass / 3 fail / 3 断言 / 1.71 秒**，修复后 **3 pass / 12 断言 / 1.98 秒**。
3. 扩大至连续周期时真实遇到历史校验错误：Session 事件 aggregate 包含不同 run 的请求，旧读取器将合法其他 run 的请求判为身份冲突。保留完整 aggregate 连续序号和严格 schema/session 校验，只把指定 run 的请求投影进该 run 的证据。缺失指定 run 的请求不会从其他 run 借用；新增独立正反测试。

## 融合实现

- 原 SessionRunAdmission 增加可选 personalJob（jobID、原 occurrence），通过原 Core Session scoped execution→Formal→Core Runner 传递，随原 RunCreated 持久化。无凭据限制的任务也必须走同一 scoped 入口；不回退到未绑定的普通 resume。
- PersonalJob ID/Digest/Occurrence 提取到 Schema 的轻量叶模块，仅用于消除 PersonalJob↔AgentRuntime 的真实模块环。原公开门面重导出同一个 schema 值；不新增第二份契约，旧可选字段编码继续省略 undefined。原客户端生成器同步两个客户端目录。
- 原 Step.Started 增加可选 runID/requestDigest，由原 LLM event publisher 写入。原执行器恢复读取原 DurableRun、EventV2、Session.message 和 RuntimeBilling，不添加状态表、调度器、独立去重服务或另一个结果 writer。
- 完成结果读取核对 occurrence、已消费原输入、原终态/attempt/semantic checkpoint、canonical RequestEnvelope、原 Step.Started/Ended 及精确 assistant ID。不按“最新回答”归因，也不要求恢复后的 assistant ID 必须是新生成的。缺少原关联/回答时拒绝猜测或重新请求。
- 原 Runner 在启动前检查输入的完整 Prompt 等价和原 occurrence 摘要，拒绝漂移、已消费但无来源的旧输入、terminal occurrence 再执行，以及 job origin 接管 child attempt。原 DurableRun.create 的 RunCreated 提交事务再次检查同一 occurrence 已有 run，覆盖前置读取与创建之间的终态竞争窗口；下一周期的新 occurrence 不受此限制。
- 同一个 PersonalJob run 只从原队列提升自己的 messageID，不消费无关 queue/steer，不将后续普通输入并入该任务的 run/结果。普通执行仍沿原 coordinator 和既有 FIFO/steer 规则继续，没有另设任务队列。
- 完成结果优先从原持久事实补记；有原计费约束时，读取原 usage/receipt 并通过原 RuntimeBilling 还原连续预算，拒绝未结算、缺 receipt 或不匹配的预算。未配置价目的原行为尚未在本批改变，不能据此声称费用功能已验收。

## 已结束的验证

本机 Windows / Bun 1.3.14；隔离 SQLite、临时工作区、本地 HTTP 模型服务，不访问真实远端模型、不修改真实用户数据库或凭据。重叠批不累计。

| 检查 | 实际结果与范围 |
|---|---|
| Formal `bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal PersonalJob\|Formal scoped execution'` | 最终 **6 pass / 0 fail / 170 filtered / 94 断言 / 31.87 秒**：丢失结果恢复不重发；已有更新普通回答仍取原任务结果；缺 Step 绑定拒绝重发；直接再次执行 terminal occurrence 被拒绝；无关 queue/steer 保留后正常执行；连续两周期；原 credential/billing scope 不泄漏。最后仅去除一个类型参数的默认值声明，不改变执行语义 |
| Core DurableRun、pending recovery、PersonalJob、executor、history、coordinator 六文件 | **154 pass / 0 fail / 662 断言 / 9.14 秒**，含原事务拒绝三种 terminal occurrence 重建与下一周期可建 |
| Core Runner、history、checkpoint、billing 四文件 | **237 pass / 0 fail / 1511 断言 / 186.55 秒**。此批在最后原创建事务 guard 及结果读取 envelope 校验之前启动；不把此批冒充这些后加逻辑的证明，后加逻辑由上方 owner 专项/正式入口及最终静态检查覆盖 |
| 最终 Core PersonalJob、executor、history 三文件 | **42 pass / 0 fail / 181 断言 / 2.19 秒**；包含新增 Schema 原值身份和旧 admission 可选字段省略 |
| 原 Client 生成与默认 `bun test` | generate exit 0；最终 **32 pass / 0 fail / 147 断言 / 7.05 秒**，生成比对约 4.944 秒，Promise/Effect 及边界测试通过 |
| Workspace 强制 typecheck | **22/22 successful，0 cached，74.418 秒**。最后仅移除默认类型参数，Core 再次 typecheck exit 0 |
| 格式与 diff-check | 21 个本批源/测试文件、两个生成目录通过；最后结果读取文件另行格式检查通过 |
| scoped lint | 21 文件 **173 warnings / 0 errors** 后修掉本批最后一个默认类型参数告警；最终结果读取文件 **0 warnings / 0 errors**。其他文件保留既有告警，不能说整仓静态告警清零 |

调试记录：Core 首轮类型检查发现 SessionRun/ControlRun union 未收窄、PromptInput/已准入 Prompt 类型不同，以及把 location 级 DurableRun 直接放到 global executor 依赖图的错误。现按原 location 服务容器读取 DurableRun，保留原 scope；类型检查通过。旧 admission-only 测试补上明确抛错的 scoped resume 哨兵，不用产品回退掩盖缺失。扩大 Core 首轮 61 pass/2 fail 是夹具缺该新必需接口，修正后通过。

客户端默认 5 秒预算下两次 31 pass/1 timeout。只读完整检查内容没有差异，显式 20 秒诊断运行中比对耗时 5.675 秒，32 项通过。该测试属于全 API 生成一致性而非延迟门禁，现只给这一项明确的 15 秒上限，保留两次独立 compile 和完整输出相等断言；最终默认 bun test 通过，没有跳过比对、增加缓存或放宽功能断言。一次从包目录执行 oxlint 因根配置识别失败，改回仓库根目录执行并取得实际结果。

## 未完成项与下一落点

1. **补记结果目前仍经过 jobs.start，因而会增加 attemptsUsed。** 达到 maxAttempts 时 recover 可能先将任务写为 failed，无法再补记原 completed 结果。下一步须在原 PersonalJob owner 内融合可核验的结果补记入口，避免重新分配执行尝试；不能简单放宽所有 queued/failed→completed 转移，也不能用外部传入的摘要冒充原运行证明。
2. 本批完成读取器只识别 completed run。failed/cancelled 的原结果、暂停/用户取消竞争及缺少旧绑定的显式处置尚未完整交付。原保护会拒绝另建，不等于其用户恢复旅程已完成。
3. 有价目表的真实 PersonalJob 正式恢复、原 receipt 与请求/当前授权、部分结算和超限、费用恰好一次补记仍需端到端验证；不能用 RuntimeBilling 单元回归或无价目的本地 HTTP 成功代替。缺价策略仍需明确。
4. 需为 PersonalJob 自身建立真实 SIGKILL→新进程恢复与并发/取消验收。以前 Session AppRuntime 的强杀测试不等于 PersonalJob 服务组合的强杀证明。当前结果读取/重新 start 的并发边界仍需继续。
5. 运行中撤权、busy/idle 投影、未知发送结果用户决策、摘要/标题发送游标、父子结算、PostgreSQL、多租户、桌面用户旅程及大历史性能均保留原计划范围；R06/R07/R09/R17/R23/R30 不关闭。R31 真实全平台 sandbox 仍最后执行。

## 来源台账

composition=`ed047974eb32d5581a3d0e3f50193040cf6cd568163a17ad7d6a748630de0a16`；runner-negative=`66080f348bbf47a7f80d1b600ec4d41878905fc1fd647ce61d2ea0ac50f6cdda`；dependencies=`f00f9295467f8da948bd9273c6ccdcd14f8dd3a82b474f435eef1bcab89d875f`（7279 文件、7478 叶、6 assets）。本批随文档更新重新生成 source snapshot 并核验 migration freshness；静态来源关联不换算功能完成率。

本批未改全局 CLI/PATH、用户真实数据、凭据或持久配置，未增 Python 产品路径，未提交/推送；保留工作区无关改动。
