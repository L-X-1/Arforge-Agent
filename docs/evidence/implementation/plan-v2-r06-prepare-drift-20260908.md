# R06：prepare 与发送重新编译的实码复现

日期：2026-09-08；更新至 2026-09-12。状态：主会话、标题与压缩摘要已接 preparation/持久化核验；下列验证范围以最新条目为准，完整 R06 不关闭。

后续消费者进展：已修复 PersonalJob 恢复/暂停导致输入 ID 改变的问题，见[2026-09-12 原输入身份融合](./plan-v2-r07-personal-job-occurrence-20260912.md)。该批为生命周期/SQLite 故障注入与正常 Formal 执行，不代表 PersonalJob 自身强杀恢复、原结果及费用补记完成。下文各批保留其实际验证边界。

## 2026-09-12：一次执行约束隔离与受限请求的真实冷恢复

本批继续 R06/R07，并验证原 RuntimeBilling 的恢复结算边界。生产修改仅在原 `SessionRunCoordinator.settle`；没有新增执行器、恢复队列、凭据服务或计费 owner。

### 修复与实际验证范围

- 真实缺陷：`runWith` 成功结束时若已有普通 `wake` / `wakeAndWait` 排队，原 coordinator 复用包含 options 的同一 entry，下一次 drain 继承前一轮凭据、预算和结算回调。两条 Deferred 同步的新增 Core 回归在修复前均失败，实际观察到下一轮仍持有 options；不是仅凭静态推测。
- 修复：只允许无显式 options 的普通 drain 复用 generation；有一次执行 scope 的 entry 完成后走原有 successor 分支，新 entry 不带 options，并保留后续唤醒方 context、等待者和执行串行性。显式调用方只等待自己的原 generation，普通后续任务不会阻止其完成。
- 正式入口回归使用原 Credential、SessionPrompt、Formal/Core Runner、SQLite 和本地模型 HTTP。首轮绑定测试凭据/预算，原 terminal observer 暂停收尾时接受第二条普通输入；最终两条原 run 均完成，第二条 admission 没有继承凭据或计费约束、回调只触发一次、计费 receipt 只属于第一条 run。没有调用旧 Loop。
- 独立进程测试扩展原 AppRuntime 强杀夹具：通过原 Integration/Credential 保存公开假密钥，每个新进程从当前连接和当前 Catalog 取得测试约束，显式调用原 `resumeWith`。测试在 prepared COMMIT 后终止实际 worker，等待原租约自然过期，再由新进程续接；没有直接改数据库模拟这次崩溃。
- 原约束一致时，同一 run 恢复至 completed、attempt=2，实际 HTTP 的 URL/body 与原持久请求相同，Authorization 使用原存储凭据；只有一次发送、一个非零计费 receipt，结算后活动预留为 0。第三个新进程普通空唤醒不再发送，run 与 usage 摘要不变。
- 缺少运行约束、预算变化、凭据范围变化三种情况均拒绝，实际 HTTP=0，原 run、历史、待处理输入和 usage 摘要不变。原持久 envelope 只有凭据身份、不含假密钥正文；worker 输出同样不含假密钥。
- 夹具使用隔离目录/SQLite、公开测试主密钥和本地 HTTP，不访问用户密钥链、真实凭据或远端模型。测试价目表属于 fixture，不冒充真实商业价格或 PersonalJob 产品配置。

### 已结束的测试批次

同一场景的单项、筛选批、扩大批相互重叠，不累计成完成率。

| 检查 | 实际结果及边界 |
|---|---|
| Core 两个新 scope 回归，修复前 | **0 pass / 2 fail / 31 filtered / 2 断言 / 217ms**；下一轮 options 未清除 |
| Core `bun test --rerun-every test/session-run-coordinator.test.ts test/durable-run.test.ts test/durable-run-recovery.test.ts` | **109 pass / 0 fail / 474 断言 / 5.95 秒**；包含完整 coordinator 33 项及原 pending 取消规则 |
| Core coordinator + personal-job-executor 两文件 | **47 pass / 0 fail / 128 断言 / 982ms**；PersonalJob 此批为既有注入式生命周期单测，不是其实际冷恢复验收 |
| Arforge 正式 HTTP 原七类及新增 scope 筛选批 | **28 pass / 0 fail / 143 filtered / 301 断言 / 127.32 秒**；主请求、存储凭据、计费、标题和压缩相关回归。之后仅给新增测试 generator 补显式 void 返回，并用下行重新验证 |
| 最终 `bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal scoped execution'` | **1 pass / 0 fail / 170 filtered / 15 断言 / 10.39 秒** |
| 最终 `bun test --timeout 160000 test/session/request-recovery-process.test.ts` | **14 pass / 0 fail / 388 断言 / 594.96 秒**；全部原 10 场景及新增受限恢复 4 场景，包含最终计费金额/活动预留断言 |
| 最终 `bun test --timeout 220000 test/cli/session-recovery-process.test.ts` | **10 pass / 0 fail / 88 断言 / 171.92 秒**；原只读检查、明确取消和保留输入续接旅程，覆盖共享 worker 的改动 |

workspace `bun run typecheck` **22/22 successful，22 cached**，不将缓存重放称为实际重查；另在 Core/Arforge 分别直接运行类型检查，均 exit 0。五文件 Prettier 和 `git diff --check` 均 exit 0。最终 scoped lint **60 warnings / 0 errors**（原 coordinator 1、原 prompt 测试 59），本批新增 consistent-return 告警已修，两个新 Core 测试及 worker/进程测试未增加告警；不是整仓 lint 清零。所有本批恢复 worker 已退出，无遗留测试进程。

来源台账：composition=`7ae0cf6b707c1207788ed3a4e446b8d34583d6c0a7ce95c867e2e68dcd62fdae`；runner-negative=`5218ba24d95db92ea563b7604e39b3433dc8e97decc97d5fb2d62bef28726f58`；dependencies=`329ee51f1b955b2bdcd0411f4caee7fcff05a1cb43aebcb99128940d200354eb`（7278 文件、7478 叶、6 assets）。台账用于来源核对，不代表能力全部验收。

### 下一项产品缺口，不在本批完成范围

不能从原 admission 复制旧权限来自动构造执行 scope。原 `SessionExecution.resumeWith` 明确是一轮作用域，冷恢复必须由原任务发起方重新提供当前授权与预算。

已读到 PersonalJob 原消费者的具体边界：`recover` 将失联任务重新排队并增加 revision；`start` 再次增加 revision、重建 execution 并覆盖 `time.started`；`runPreparedWith` 以 started revision 生成消息 ID 并再次 prompt。这是重复入队风险的实码路径，**尚未以实际 PersonalJob 强杀旅程复现，不写成已观察事故**。不能用 time.started 简单替代 ID，它当前同样会变化；须在原 PersonalJob/Session 状态内区分原 occurrence 的恢复和下一次周期执行、绑定原输入/run，再接当前权限与预算，不新建平行任务状态。

此外，原生产 billing adapter 在当前模型缺少有效 priceCatalog 时返回 undefined；有价目表时按 PersonalJob 剩余预算创建 scope。仍须核对缺价策略、部分结算后恢复的原 run 预算与当前任务额度、原结果/费用补记及发起方取消/暂停，不能把上述 fixture 当作这些消费者已接通。

运行中撤权、跨进程 busy/idle 与输入一致性、outcome_unknown 的用户决策、摘要/标题发送阶段、其余父子结算、PostgreSQL、多租户、桌面完整旅程和大历史性能仍待验收。**R06/R07/R09/R17/R30 均未关闭，R31 真实全平台 sandbox 仍最后执行。** 未改真实用户数据、全局 CLI、PATH 或持久凭据配置。

## 2026-09-12：旧 pending 的只读检查、明确取消与原输入续接

本批补 R07 的用户处理入口，并继续使用原 TS CLI / Core DurableRun / SessionStore / EventV2；没有新增任务表、恢复调度器、执行器或 Python 路径。

- 原 DurableRun 新增 `sessionRecovery` 只读投影和 `cancelPendingSession`。投影返回 run/session、状态、原 revision、恢复约束是否存在、租约到期时间及取消阻塞原因，不返回请求正文或凭据。
- 取消必须精确匹配会话与刚查看的 revision，仅允许没有执行事实的根任务 draft/preflight/queued/awaiting_authorization。有效租约、已启动 attempt/非零用量、checkpoint/子预算、跨 aggregate 请求/Action/child 引用及 usage 记录均阻断；不会把未知结果当成未启动。原 RunStateChanged 事务内再次检查版本、依赖事实和 CurrentCheck，不对更新后的版本自动重试。
- 正式命令为 `arforge session recovery <sessionID> [--json]` 和 `arforge session cancel-pending <sessionID> <runID> --revision <整数> [--json]`，注册在原 SessionCommand。CLI 私有组合只加载原 SessionStore 与 DurableRun 及其数据库/事件依赖，使用既有 makeRuntime / shared memoMap；不加载完整 AppRuntime、LocationServiceMap、后台扫描器或插件执行服务。该组合没有业务状态和自己的恢复逻辑。
- `recovery` 在 handler 边界选择既有数据库只读模式，前置全局 flags 也不能绕过。缺 profile 不创建 SQLite，无法识别的旧 schema 不迁移、原文件字节不变；取消保留正常写入模式和原事务校验。
- 人读提示与 JSON 成功结果写 stdout，错误写 stderr 并非零退出。明确说明：取消的是未启动运行记录，不撤回原输入；之后继续此会话，保留的输入仍会执行。命令不自动开始执行，也不删会话来解除阻塞。缺 sessionID/缺 revision、负数、小数、NaN、超安全整数均有提示，不打开数据库。复用原 yargs / CliError，仅补命令的安全固定用法提示，不回显任意参数内容。

实际验证（Windows / Bun 1.3.14，独立进程、隔离 SQLite、本地 HTTP；以下批次不重复累计）：

| 验证 | 实际结果及边界 |
|---|---|
| `packages/arforge`：`bun test --timeout 220000 test/cli/session-recovery-process.test.ts` | **10 pass / 0 fail / 88 断言 / 184.11 秒**。原 SessionPrompt 接收输入，旧无 admission 根记录由原 DurableRun.create 建立；实际 CLI 查看→错误版本/跨会话拒绝→取消→重复取消拒绝，独立 worker 读取原事实验证历史、输入和另一会话不变。再次通过原 AppRuntime 执行原输入，旧 run cancelled/attempt=0，新 run completed/attempt=1，HTTP 恰好一次且含原文本，输入队列正常消费 |
| 同一 CLI 文件的只读边界 | 原 DurableRun 准入及 lease 自然过期后，查看不改 event、event_sequence、session_input、usage，模型次数为 0；有效 lease 时明确取消被拒绝。此项使用原 create 构造待检查状态，不冒充强杀测试。另测缺 profile、全局 flags 前置、旧 schema、错误参数及 help |
| `packages/core`：`bun test --rerun-every test/durable-run.test.ts test/durable-run-recovery.test.ts` | 最终 **76 pass / 0 fail / 386 断言 / 5.47 秒**。其中新文件 13 项覆盖四类 pending、错误会话/版本/有效 lease/checkpoint/请求/运行中，以及取消提交前版本、跨 aggregate 请求和访问权限变化；原 run 与预算保持 |
| `packages/arforge`：`bun test --timeout 160000 test/session/request-recovery-process.test.ts` | **10 pass / 0 fail / 272 断言 / 396.09 秒**。原 prepared/dispatching/inflight/有效 lease/两类竞争/四阶段真实强杀恢复全部通过。此批覆盖共享 worker 扩充；其间后续仅对取消提交回调补显式 void 返回及 CLI 文案/参数/测试做最终整理，取消语义由最终 Core 与 CLI 批再次验证 |

调试记录：最初人读成功结果沿 UI.println 写 stderr，已改为 stdout；旧完整 AppRuntime 下的短时过期查看回归没有复现自动执行，不把静态风险写成已观察事故。另一个回归真实复现只读查看缺 profile 却创建数据库，修复后通过；扩大 CLI 一度 **8 pass / 1 fail**，发现缺 revision 的既有全局 yargs fail 分支直接退出且无提示。现保留 required 约束，补命令级固定用法错误；专项及最终 10 项均通过。没有通过移除断言、放宽取消条件或隐式填写 revision 修测试。

最终 workspace 类型 **22/22 successful，20 cached，37.656 秒**；Core/Arforge 实际重查。五文件格式与 diff-check 通过；lint **23 warnings / 0 errors**（DurableRun 原有 22、session delete 原有 1），三个测试/worker 文件零告警；本批新增的四处静态告警已修，不宣称整仓告警清零。

本批来源：composition=`f1b1a6e2c77d9b5a81e065d207818ff809e5e511c2ccfade7b021e16d3f48905`；runner-negative=`3b3f7734e782d73b3dad6cbba0237d534b2127bd57b014760b13780115bcdacf`；dependencies=`34a9210d1f2028c2a5b41a212eae05834f84cb2c5d65da63c80d4d240b94f240`（7278 文件、7478 叶、6 assets）。静态来源关联不代替功能验收。

后续仍须完成受限 credential/billing 策略的产品级冷重建、运行中权限变化、跨进程 busy/idle 与输入投影、outcome_unknown 的明确用户决策、摘要/标题发送阶段、父子预算结算与其余故障点。当前取消命令不处理已启动任务、子任务、未知外部副作用；不是取消后自动恢复或撤回输入。PostgreSQL 引用查询/并发提交未实测；完整租户权限、桌面旅程与大量历史记录下性能仍需对应验收。R06/R07/R09/R17/R30 均未关闭，真实三平台 full sandbox 最后。未改真实用户数据库、凭据、全局入口或持久配置。

## 2026-09-12：启动准入强杀恢复与原约束绑定

真实 AppRuntime 于 RunCreated COMMIT 后强杀，首先复现 draft 原任务无法续接：resume 报 SessionAdmissionConflict，原任务未被误删，也没有创建替代任务。这说明上一批排他准入保护有效，但启动恢复存在缺口。

修复融合到原 Schema / DurableRun / Core Runner / RuntimeBilling：

- 原 SessionRun 增加可选、版本化的 admission，保存 root Runner 身份、非秘密 credential ID 范围、计费预算和 estimator ID；不保存密钥、回调或第二份业务状态。旧 @1 记录仍能解码，缺标记不自动推断是可授权的 root draft。
- 原 RunCreated @1 事件可同时提交 initialLease。新 root 创建使用原排他事务，任务和初始租约一起提交；没有嵌套 publish、第二锁服务或创建后再补租约的裸露窗口。重放校验初始租约所属 run、generation=0、时间及有效期限；损坏记录拒绝并提供不回显记录正文的可读错误。
- 原 recoverable / orphaned 扫描识别租约自然过期的已标记 draft/preflight/queued，不接管有效租约、等待授权或无来源标记的旧 pending run；扫描不受展示页前 100 条限制。正式扫描器沿原 coordinator 消费，不另建恢复器。
- Runner 续接同一 run，只执行尚未提交的准入阶段；阶段变更和 beginAttempt 绑定原 lease/owner/attempt，attempt=0 不例外。恢复旧 active attempt 的 finishAttempt 同样传执行身份；实际调用回归先验证缺失，再修正到原结算接口。
- 恢复前核对原 project/location、authority/risk、credential 范围及计费约束；不符时原完整 run、输入队列、用量表保持不变且不发送请求。计费身份检查复用 RuntimeBilling，与既有 receipt 恢复统一，不新建预算服务；paused 空唤醒仍为无操作，不要求提供执行计费配置。

验证（Windows / Bun 1.3.14，隔离 SQLite 与本地 HTTP；重叠批不累计）：

| 验证 | 实际结果及边界 |
|---|---|
| Arforge `bun test --timeout 160000 test/session/request-recovery-process.test.ts` | **10 pass / 0 fail / 272 断言 / 409.26 秒**。新增四阶段真实 COMMIT→SIGKILL→新进程 resume，保持原 run/权限预算摘要、attempt=1、一次实际 HTTP、完整回答及终态清理；draft 强杀前另起 probe，原有效租约保护及零发送成立。原 prepared/dispatching/inflight/lease-held/两类竞争继续通过 |
| 最终恢复身份改动后的进程专项 `-t 'termination: prepared$\|termination: race-expired$'` | **2 pass / 8 filtered / 73 断言 / 102.03 秒**。全文件测试较早两个场景在最终 finishAttempt 接线修正前启动，故显式补此批，不把较早输出冒充最终接线证明 |
| Core `bun test --rerun-every test/durable-run.test.ts test/session-runner.test.ts test/session/checkpoint.test.ts test/billing.test.ts` | **288 pass / 0 fail / 1770 断言 / 189.81 秒**，在最后 finishAttempt 接线修正前完成 |
| 最终 Core 两文件专项 `-t 'root admission\|closes an expired worker\|root checkpoint\|preserves queued input without'` | **27 pass / 235 filtered / 192 断言 / 12.78 秒**，包含原约束不符、到期/接管、损坏 initialLease、旧 schema 可解码与 optional 字段省略、原结算调用确实收到执行身份 |
| Arforge 正式 HTTP 入口原七类筛选回归 | **27 pass / 143 filtered / 286 断言 / 127.30 秒**；主请求、凭据、预留、标题与压缩边界。不是 CLI/TUI/desktop 全旅程 |

调试记录：初版扩大回归 **260 pass / 9 fail**，发现 paused 空唤醒过早做执行约束校验、计费拒绝语义与原 owner 不一致，以及旧测试仍要求首次租约独立事件；修复产品 guard 顺序、复用原计费语义，测试明确首次租约在 RunCreated、后续 takeover 独立事件。另一次进程全文件 **9 pass / 1 fail**，本地服务收到无正文 GET 后无条件解析 JSON；其来源未确认，未据此归因为产品重复发送。夹具现明确 POST `/v1/chat/completions`，其他方法 405、其他路径 404，增加主动 GET→405/模型计数不变回归；正式 Provider 请求仍必须正确路由、JSON、认证并完成回答。损坏历史提示初版为空，已提供可读失败说明。最后调用身份测试的可选 lease 类型问题也经检查纠正；没有跳过测试或删除拒绝边界。

最终 workspace 类型 **22/22 successful，21 cached，7.242 秒**；此前同批 Schema/Core/Arforge 均有实际重查。八文件格式检查及 scoped diff-check 通过；最后测试文件格式告警经 formatter 修复并单独复查通过。八文件 lint **108 warnings / 0 errors**，两个进程夹具文件零告警；已有告警未清零，不以退出 0 宣称全部静态问题解决。

本批来源：composition=`d479b164ad2c767e1251e9244a2485dbacf165a8051577e309b02205828878d4`；runner-negative=`37063000c06453aa4af7ce4a7155083ee5d764266a39087c747af1a6d12798eb`；dependencies=`b367d87c4f2548f06502fd4c36a53b5e3287c6d0368aeb6fb13457ce869d0d02`（7276 文件、7463 叶、6 assets）。新鲜度只表示来源绑定，不替代本节未完成项的验收。

边界：本批不是 R07 全部故障点验收；没有验证 PostgreSQL、多宿主或真实三平台 OS enforcement。旧未标记 pending 记录的明确恢复/取消入口、受限凭据/计费策略的产品级冷重建、启动中途策略变动、跨进程 busy/idle 与待处理输入投影、未知发送结果的用户决策、摘要/标题自身发送游标及父子预算结算仍需继续。R06/R07/R09/R17 和 R30 保持开放，真实 full sandbox 仍在最后。未改用户真实数据、凭据、全局入口或配置。

## 2026-09-12：真实多进程同时首发与过期接管验证

沿原 request-recovery sidecar 新增两个竞争场景，不新建协调器。新请求由原 SessionPrompt.noReply 录入后，初始化进程正常退出，实际 run=0、请求准备事件=0；测试报告中的 unstarted/null 只描述不存在的记录，不写入产品数据库。过期恢复场景继续在 prepared 真实 COMMIT 后强杀原进程，并保留原 DB/run/lease。

两场景各启动两个原 AppRuntime 进程，先完成原服务/实例初始化与持久记录读取。恢复场景必须等待原 lease 自然过期。父进程收到两个独立 PID 的就绪报告后，核对 history/run/request 摘要相同、HTTP=0，再通过各自 stdin 同时放行原 SessionExecution.resume；不在生产代码放故障开关，也不修改时间或租约。服务端收到获胜请求后继续阻塞响应，直到另一竞争进程已报告被拒绝，防止获胜者太早结束将竞争变成两个先后成功任务。

| 场景 | 真实结果 |
|---|---|
| race-new：同一已接收输入、两个新进程同时执行 | 一个获胜、一个拒绝；同 Session 只有一条 run、attempt=1、一条 RequestEnvelope、一笔本地 HTTP；完整回答存在，实际 URL/body/认证匹配记录 |
| race-expired：原 prepared run 到期、两个新进程同时恢复 | 一个获胜、一个拒绝；保持原 run ID、原唯一事件及 envelope，attempt=2；HTTP 总共一次，完整回答存在，最终 active attempt/lease 清理 |

另复现原 LeaseHeldError.message 为空，只有类型而无可读解释。现只在原错误类增加 message getter，说明另一个执行拥有该 run、应等其结束或租约到期后再恢复；不改变获取/释放/过期规则。真实 DurableRun.acquireLease 正反调用的新增测试先失败后通过；产品竞争测试要求拒绝原因具有可读信息，而非仅匹配任意 Failure。

最终 Windows / Bun 1.3.14 验证（均退出 0，重叠不累计）：

- Arforge `bun test --timeout 160000 test/session/request-recovery-process.test.ts`：**6 pass / 0 fail / 184 断言 / 211.02 秒**。包含原 prepared、dispatching、inflight、lease-held、completed 第三进程唤醒与新增两类竞争；此前仅竞争筛选 2 pass/62 断言为中间批。
- Core `bun test --rerun-every test/durable-run.test.ts`：**53 pass / 0 fail / 234 断言 / 2.82 秒**，含原准入/租约/事件/检查点回归和新增可读提示。
- Arforge `bun test --timeout 30000 test/session/prompt.test.ts -t 'Formal request dispatch recovery|Formal HTTP transmission'`：**6 pass / 164 filtered / 64 断言 / 28.12 秒**；本批未重新跑前批 Core 249 或正式入口 27 项，不冒充新全量。
- workspace 类型 **22/22 successful，20 cached，27.653 秒**；四文件格式/diff-check 通过；lint **29 warnings / 0 errors**，两个 sidecar 文件零告警，保留已有 Core 告警边界。

夹具调试：新请求没有 run，初版将 JSON.stringify(undefined) 交给摘要函数失败，现明确序列化 null，不伪造 run。stdin 放行的 write/end 现全部等待；移除一处多余非空断言，未用静默忽略错误修测试。

来源：composition=`2b7bd05554768d3a7a0f73c473fc46c335f528a3e8de8993cdf86b47020398a0`；runner-negative=`ac216a91bc3fa86f7833d3fd94054f19a7195a9962caffe03ccb4d13a57dda52`；dependencies=`0b67b19124bdff7ffab0ff31a9cac8ed5d8953bec625ba165f771488c259c73d`（7276 文件、7463 叶、6 assets）。

边界：这是 Windows 同宿主独立进程、原正式 AppRuntime、同一隔离 SQLite 和本地真实 HTTP 的验证；不是 PostgreSQL 并发、多宿主或 CLI/TUI/desktop 全旅程。原准入 draft/preflight/queued 到 request-prepared 之间的强杀恢复仍未闭合，不能把禁止重复创建当成原未完成任务已经可恢复。下一步先验证这些阶段的原 run 续接与授权/预算保持，再继续状态投影、未知结果用户处理、计费、摘要/标题等剩余边界。R06/R07/R09/R17、R30 不关闭，全平台 full sandbox 最后；无真实用户数据、凭据、配置或外部服务操作。

## 2026-09-12：有效租约下跨进程重复建 run 的实码修复

在上一批原 AppRuntime sidecar 中增加 `lease-held`：seed 于原 prepared COMMIT 后保持运行，另起 probe 进程立即调用原 SessionExecution.resume，不等待 lease 过期。实际复现 **success=true / runCount=2 / HTTP=1**，而原进程仍持有 running/active attempt 1。原 Runner 的 recoverable 排除有效租约 run，却把没有 recoverable 当成可以 create，进程内 coordinator 无法拦截另一个进程。

修复沿既有 owner：DurableRun.create 增加仅由可信调用方启用的 exclusiveSession 选项，Core 主会话唯一 create 调用启用；检查在原 RunCreated 的 EventV2 commit 回调中读取同一 Session 的完整未终结 run 列表，发现即以 SessionAdmissionConflict 拒绝。SQLite 使用原 EventV2 BEGIN IMMEDIATE，不能被两个不同候选 run ID 绕过；PostgreSQL 分支在同一事务内先锁原 Session 行，再读列表，缺 Session 行拒绝。没有新表、锁服务、第二执行器或额外状态源。低层默认 create 与 createChild 排队语义保留，不将该选项冒充所有调用者已完成的全局迁移证明。

拒绝时原 run/attempt/checkpoint/request 记录不变，不产生候选创建事件或 event_sequence 行；completed/failed/cancelled 不阻止后续正常新 run。已有 draft/preflight/awaiting_authorization/queued/running/paused/recovering 均阻止平行新建，**这不是这些状态都已经能自动恢复的声明**，启动中断的恢复分派仍须单独实现/验证，不能靠另建 run 绕过原工作。

额外体验回归先失败：TaggedError 虽持有 reason，Cause.pretty 只显示类型名及空消息。现原错误类型的 message 明确返回 reason；最终双进程断言不仅验证被拒绝，还验证 probe 观察时原 lease 确实未过期、提示包含未完成执行原因、原唯一 run/attempt/checkpoint/事件保持、HTTP=0。

验证（Windows / Bun 1.3.14；以下最终均退出 0，重叠批不累加）：

- Core `bun test --rerun-every test/durable-run.test.ts test/session-runner.test.ts test/session/checkpoint.test.ts`：**249 pass / 0 fail / 1530 断言 / 139.03 秒**。本批运行后仅整理条件表达式及补错误 message、清理新增测试非空断言；最终相关 11 项另跑如下。
- Core `bun test --rerun-every test/durable-run.test.ts -t 'exclusive Session admission'`：**11 pass / 41 filtered / 55 断言 / 1.79 秒**，10 种状态及 6 个候选同时竞争；单 Session 仅 1 个创建成功，其余 5 个失败。
- Arforge `bun test --timeout 160000 test/session/request-recovery-process.test.ts`：**4 pass / 120 断言 / 153.53 秒**，原三类强杀与 completed 第三进程验证仍保留。补 lease 实时性及可读消息断言后，最终 `-t lease-held`：**1 pass / 3 filtered / 22 断言 / 20.45 秒**。不能把较早的 120 改写成未实际重跑整文件的 122。
- Arforge `bun test --timeout 30000 test/session/prompt.test.ts -t 'Formal request dispatch recovery|Formal stored.*credential version|Formal credential billing boundary|Formal HTTP transmission|Formal title request persistence|Formal compaction HTTP'`：**27 pass / 143 filtered / 286 断言 / 100.39 秒**，在最终只读错误 message getter 前完成。
- 最终 workspace 类型 **22/22 successful，21 cached，5.229 秒**；前批有 Core/Arforge 两项实际重查，Core 独立类型最后亦通过。五文件格式/diff-check 通过；最终 lint **52 warnings / 0 errors**，两个 sidecar 文件零告警，未宣称已有 Core 告警清零。

来源：composition=`a0fffc4555482d170ec451a0b90a3f0cbd8c8d127970c4fa402f8e9fac3d12e8`；runner-negative=`44fa3fe0521433ad3c0e433a8d3ca1a87355efbb6d2fe734db7d375fa846600f`；dependencies=`0f33c9b3c11bc22dee75dca73fadf3f22c1c339582fafbf4f0af6f3662756f01`（7276 文件、7463 叶、6 assets）。

下一步：真正同时冷启动的新请求准入、原 lease 到期时的多进程竞争接管、准入各阶段强杀恢复、跨进程 busy/idle 与待处理输入一致性。上述六候选创建是同进程 SQLite 并发，不冒充多进程首发或 PostgreSQL 实测；PostgreSQL 行锁分支尚未做真实环境验证。未知结果的用户处理入口、未决计费/预算、摘要/标题、权限和旧记录边界继续开放。R06/R07/R09/R17、R30 不关闭，真实三平台 full sandbox 最后；未改真实用户数据库、凭据、配置或外部服务。

## 2026-09-12：原 AppRuntime 强杀后新进程恢复首批验收

新增 `packages/arforge/test/session/request-recovery-process.test.ts` 与纯测试 sidecar `test/fixture/request-recovery-worker.ts`。子进程直接加载产品原 AppRuntime（包含正式 SessionExecutionFormal 绑定、原 InstanceStore bootstrap、原模型解析），通过原 SessionPrompt 创建会话并请求；不是组件重建 worker，也没有新建恢复器或替换 Provider/Runner。所有 profile、SQLite 和工作目录均在既有 tmpdir 夹具中隔离，Provider 为父测试进程的本地 HTTP 服务，认证为公开虚构 test-key。

seed 仅包装共享 DB 的原 transaction：先完成真实 COMMIT，再核验原 RunCheckpointCreated receipt 与 SessionCheckpoint，报告原 session/run/lease/request 元数据。在 prepared 或 dispatching 边界等待父进程强制结束；inflight 场景不阻塞发送，父进程还必须收到实际 HTTP 请求才强杀，HTTP 响应保持未返回。父进程确认 seed 非零退出后，启动另一进程，只传目录、受控 endpoint、session/run ID；不传旧 envelope 内容或 prepared 对象，不复制数据库、不手工改 lease/run/attempt，不触发原进程 finalizer。

新进程从同一 SQLite 读取原状态，轮询真实时钟直到原 30 秒租约自然过期，再调用原 SessionExecution.resume。三场景均核对冷启动前仍是原 running/active attempt 1、原 checkpoint、原请求事件和 lease owner；恢复后仍只有原一条 run，attempt=2，active attempt/lease 正确清理。

| 场景 | 可复验结果 |
|---|---|
| prepared 提交后、尚未发送 | seed HTTP=0；新进程复用同一事件、envelope 和请求摘要，唯一 HTTP 的完整 URL/body 与原 transmission 相等，认证匹配，完整回答存在，原 run completed |
| dispatching 提交后、HTTP 前 | 初始及恢复 HTTP 均为 0；恢复报告可能已发送，原 run paused，原 checkpoint 不变，不把测试已知未发的事实冒充产品持久事实 |
| HTTP 服务端已收到、响应尚未返回 | 强杀前实际 HTTP=1；恢复后总数仍为 1，原 run paused/原 checkpoint 不变，没有重复发送或伪造回答 |
| completed 后第三个独立进程唤醒（包含在 prepared 用例） | 原 wakeAndWait 不再请求模型；完整 run 快照摘要、事件摘要、attempt=2 和单 run 不变，原回答仍可读取 |

最终验证（Windows / Bun 1.3.14，全部实际退出 0）：

- Arforge `bun test --timeout 160000 test/session/request-recovery-process.test.ts`：**3 pass / 0 fail / 100 断言 / 135.74 秒**，包含第三进程 completed 唤醒；此前 3 pass/75 断言为新增完整状态断言前的历史批，不累加。
- Arforge `bun test --timeout 30000 test/session/prompt.test.ts -t 'Formal request dispatch recovery|Formal stored.*credential version|Formal credential billing boundary|Formal HTTP transmission|Formal title request persistence|Formal compaction HTTP'`：**27 pass / 143 filtered / 0 fail / 286 断言 / 101.35 秒**。
- 最终 workspace `bun run typecheck`：**22/22 successful，21 cached，26.261 秒**；Arforge 独立类型前一批亦通过。新增两文件 prettier、scoped diff-check 通过；仓库根执行 oxlint：**0 warnings / 0 errors**。本批未重新运行 Core 八文件，不复用前批结果冒充新跑。

调试事实：首版测试尝试直接取得 AppRuntime 未对外暴露的 Core Session/SessionStore，分别以 Service not found 失败；改用原 SessionHistory.load 与共享 DB 读取结果，不扩张产品 root 或替换服务。类型检查同时纠正 Snapshot 的真实 attemptsUsed 字段、事务包装的错误通道、Bun stdout reader 及自引用类型。最初在包目录执行 oxlint 因根 typeAware 配置解析失败；最终从仓库根运行通过，并移除新增五个 lint 告警。无产品逻辑改动，无生产故障钩子。

来源扫描：composition=`c46adf14a7b04b0e5bf225b0b7c584ec444ac05a50fc32776a0d7b9f88de3596`，runner-negative=`c12e9b9c54bdfe256eccd47dd4d064581fbba464b7b33bc864602dba984e28a6`；dependencies=`30ac1241d829ecbad1abf7efaa1130760af05d376251e557e1321fa1906c8153`（7276 文件、7463 叶、6 assets）。测试加入没有改变生产 composition/runner 摘要，不把扫描新鲜度当成功能验收。

边界及下一步：这是正式产品运行时的独立 sidecar 强杀测试，不是完整 CLI/TUI/桌面重启旅程，也不是全部 R07 故障点或外部账号验收。当前只有原租约过期后的单新进程接管，**接下来先验证原 lease 仍有效时另一进程的正式 resume 是否会错误另建 run，再验证并行过期接管**。计费预留未结算、父子预算、权限/凭据变更、旧记录首次阶段间隙、摘要/标题自身发送阶段、新输入及未知结果的用户处理入口仍开放。R06/R07/R09/R17、R30 不关闭；真实三平台 full sandbox 仍最后，未修改真实用户数据、配置、凭据或服务。

## 2026-09-12：发送阶段持久化与正式恢复首批分派

主请求沿原 DurableRun/SessionCheckpoint 保存版本化 dispatch 元数据：实际已提交 RequestEnvelope 的 event ID/digest、turnStep、执行 attempt、进程内 providerAttempt，以及 prepared/dispatching。没有另建状态表、恢复队列或发送服务；原 Loop 游标及子代理容器字段保留，所有新增检查点写入复用原 lease/owner/attempt 条件保护。阶段写入失败必须先于发送失败；dispatching 只表示可能进入发送，不能证明交付成功、未计费或零发送。

原 Runner 现在实际消费这些状态：

1. 恢复先沿原计费流程处理未决账单。dispatching 且尚无可靠续接游标时返回具名 RecoveryRequiredError，并保留 paused/原检查点；没有输出或仅有确认用量都不能授权重发。队列/steer 输入保留，不因唤醒被提前消费。
2. prepared 恢复从同一 Session 的真实 EventV2 行读取原事件，校验事件、run、step、attempt、schema 和 digest 绑定。重新解析模型/凭据、组装当前上下文及工具、准备传输；除新执行 attempt 外，当前完整 envelope 必须与原记录一致。成功复用原事件和摘要，经原 rebuildRequest/streamPrepared 发送；不追加另一份准备事件，不把更新后的请求冒充原请求重建。变化、缺失或损坏则暂停且零目标发送。
3. prepared 请求之后有新待处理输入时，在进入 runTurn、提升输入及执行计划子任务之前暂停。此保护不提供自动舍弃旧请求或新输入的决策；用户处理入口仍待补齐。
4. 原主请求已确定返回上下文超限时，以同一检查点记录可恢复游标，再进入既有摘要事务，避免把已知结束的主请求误判为仍在发送。实际收到部分回答/工具调用后，先等待工具清理及错误结果落库，再写下一步游标；这是续接已有输出，不是重放原请求。未决账单仍在后续运行前阻断。
5. 发现纯取消被 maintain(false) 写为学习失败，导致未发送请求恢复时凭空多出 Learning 上下文。现纯中断不记录任务失败学习/记忆维护；真实失败与正常完成继续沿原维护链。

验证（Windows / Bun 1.3.14，最终均退出 0；重叠批次不累计）：

- Core `bun test --rerun-every test/session-runner.test.ts test/session/checkpoint.test.ts test/session/compaction-checkpoint.test.ts test/session-compaction.test.ts test/billing.test.ts test/session-title-generation.test.ts test/session/request-envelope.test.ts test/session/request-rebuild-process.test.ts`：**268 pass / 1611 断言 / 149.47 秒**，八个实际文件。
- 最后新增 pending input 保护后的专项：`bun test --rerun-every test/session-runner.test.ts test/session/checkpoint.test.ts -t 'prepared request recovery|request dispatch|silent interrupted provider|preserves queued input without|preserves steering input without|resumes from the semantic|promotes the first queued'`：**16 pass / 181 filtered / 142 断言 / 7.61 秒**。
- Arforge `bun test --timeout 30000 test/session/prompt.test.ts -t 'Formal request dispatch recovery|Formal stored.*credential version|Formal credential billing boundary|Formal HTTP transmission|Formal title request persistence|Formal compaction HTTP'`：**27 pass / 143 filtered / 286 断言 / 104.99 秒**。新增两项在共享数据库原事务真实提交后中断，再从原 SessionExecution.resume 进入 Core；prepared 恢复的实际 HTTP body/URL 等于原记录并返回完整回答；dispatching 中断后零额外 HTTP、原检查点不变。
- Core 独立类型曾通过；最终 workspace `bun run typecheck` **22/22 successful，21 cached，6.725 秒**。六文件格式和 scoped diff-check 通过；六文件 lint **140 warnings / 0 errors**，未宣称告警清零。

故障证据：阶段 barrier 的四组合包括真实 SQLite INSERT trigger 失败与提交后中断，断言零发送及已预留额度零费用释放；静默 Provider 已真正进入受控流后中断，恢复被阻断。prepared 恢复五项包含不变、配置变更、缺失事件、损坏事件和新输入；原子代理容器保留及同请求跨合法新 attempt 的纯更新验证通过。旧账单 worker 已改为“确认主请求账单但结果未知仍 paused/零重发”，保留原价、原行、同 run 和 idle 零重放核对；摘要新进程的原价结算及新价续答仍保留。

调试记录：prepared 夹具初误读 checkpoint 返回结构，修正后四项真实复现另建请求/漂移仍发送；静默恢复同样先失败。首次扩大回归 **255 pass / 12 fail**，涉及旧的未知结果重发预期、部分输出/已知超限游标遗漏、取消摘要已完成 aborted 的旧断言，以及 wake 后仅 yieldNow 的时序假设。修正产品边界并分别调整到真实新合同；idle 测试改等待原 wakeAndWait，不用固定睡眠。正式夹具曾因不同作用域服务拦截不到、node 覆盖产生依赖冲突、把已解码 DateTime 当序列化值再解码而失败；最终只委托共享 DB 的原事务，在真实 commit receipt 后注入中断，并使用原 schema 的 Type 校验，退出恢复原方法。没有保留试验性 node 替换或生产故障钩子。

证据刷新：composition=`c46adf14a7b04b0e5bf225b0b7c584ec444ac05a50fc32776a0d7b9f88de3596`；runner-negative=`c12e9b9c54bdfe256eccd47dd4d064581fbba464b7b33bc864602dba984e28a6`；dependencies=`d5d4cb4ee728dc004894cb48d3c83e7b555e855afade1c05896418017028ad39`（7274 文件、7461 叶、6 assets）。这些是来源/扫描证据，不是功能完成率。

仍未闭合：正式产品强杀后新进程恢复、并行接管和所有持久化临界窗口；发送结果未知的显式核对/放弃/另起请求及新输入处理界面；仅 prepared 但账单预留未清理时的直接零发送证明与恢复；缺 dispatch 的历史/事件与阶段首次提交间隙；摘要及标题自身的发送阶段与完整冷分派；环境/内联凭据版本、权限变更、跨父子预算和标题维护额度。本批正式 HTTP 为本机受控服务、同进程恢复；已有独立进程请求重建测试仍是共享函数层，不能冒充完整产品冷恢复。R06/R07/R09/R17 保持开放，真实三平台 full sandbox 最后；未操作真实用户数据库、凭据或外部 Provider，未发布。

## 2026-09-12：正式恢复前置——主会话检查点接入同一执行身份保护

核查正式恢复发现：runLoop 主要消费 nextStep/needsContinuation，尚未完整持久区分 prepared 与已进入发送但结果未知的请求；不能把无输出解释为未发送。扩展该状态前发现两个原检查点写入点仅传 childAttempt.execution，主会话缺少已有 DurableRun.checkpoint 的 lease/owner/attempt 条件保护。

新增原 Runner × completed-turn/tool-continuation × lease/attempt 四种确定性交错：在原 checkpoint 委托执行前，通过同一 DurableRun 的 release/acquire 或 finishAttempt/beginAttempt 接管，写入合法替代检查点，再放行旧调用。修复前 **0 pass / 4 fail**：部分旧调用返回 Success，另有明确替代检查点被覆盖，甚至多发下一步请求。现 Runner 内部 ExecutionLease 使用已有 DurableRun.CheckpointExecution，原主会话进入 runLoop 时冻结 beginAttempt 返回的 attempt，两处检查点均传原执行身份；子代理继续使用原借用身份，不重新认领。根退出清理同时检查 activeAttempt，不能把同一租约下的新 attempt 当成自己清理。不新增 lease 服务、表或检查点 owner。

修复后四场景旧调用失败，原身份参数正确、替代 DurableRun 完整快照不变、仅一次原受控 Provider 调用。测试包装退出时恢复原方法；对注入操作的失败转 defect，不改委托 checkpoint 的正常错误合同。首轮类型检查暴露测试的错误 Effect 类型、readonly 方法赋值及注入操作的额外错误类型，已按原 Snapshot/Interface 与委托包装修正。

验证（Windows / Bun 1.3.14，最终均退出 0）：

- Core `bun test --rerun-every test/session-runner.test.ts -t 'root checkpoint preserves replacement execution|resumes from the semantic checkpoint|durably fails blocked local tools'`：**7 pass / 171 filtered / 36 断言 / 5.35 秒**。
- Core `bun test --rerun-every test/session-runner.test.ts test/session/checkpoint.test.ts test/session/compaction-checkpoint.test.ts`：**190 pass / 1198 断言 / 137.88 秒**。全量批启动后只修测试包装的类型表达；最终专项另跑上述七项，不累加。
- Arforge `bun test --timeout 30000 test/session/prompt.test.ts -t 'Formal stored.*credential version|Formal credential billing boundary|Formal HTTP transmission|Formal title request persistence|Formal compaction HTTP'`：**25 pass / 143 filtered / 261 断言 / 94.73 秒**。
- Core 独立类型通过；workspace 类型 **22/22 successful，21 cached，6.141 秒**；两文件格式/diff-check 通过，lint **73 warnings / 0 errors**，没有宣称告警清零。

范围：新增竞争为原真实 SQLite 服务内的受控交错，不是多宿主/强杀；Provider 为 Core 受控流，正式 HTTP 批只做回归，并未注入本轮 checkpoint 接管。这里只关闭这两处遗漏执行身份的写入问题；不证明所有状态写入、租约临界过期、检查点提交后的接管与用户终态均已闭合。

下一步仍需原检查点记录已提交 RequestEnvelope 的明确引用与发送阶段，正式恢复先处理未决计费，再按当前授权、原请求/凭据身份与发送不确定性决定重建或阻断；无输出不能作为零发送证明。不得另建恢复队列，也不得把上一批测试 worker 当成正式恢复器。R06/R07/R17 不关闭，全平台 sandbox 最后；本批未操作真实用户凭据或数据库。

## 2026-09-12：重建凭据身份校验与独立进程 HTTP 验证

实码确认原 rebuildRequest 只验证模型/路由/endpoint 和通用请求摘要，没有把旧 envelope 的 credential_identity 与新解析模型的身份比较。新增缺失身份、不同 ID、不同版本的单测，修复前第一条即复现“不抛错”。现沿原函数增加 resolvedCredential 参数：有持久化身份时，缺失或不匹配均拒绝，匹配时仍执行原摘要/路由验证；调用者必须从当前模型解析取得身份，不从待验证记录复制。原 Runner 主请求、标题准备及 TitleGeneration.generate 已传递原 SessionRunnerModel 绑定，无新凭据库或第二请求管理器。发送前既有实时凭据验证保留，重建匹配不替代权限/版本的再次检查。

新增 request-rebuild-process.test.ts 和纯测试 request-rebuild-worker.ts，四场景各启动独立 seed/rebuild 进程。seed 使用真实 Catalog、Integration、Credential（原 AES 加密实现配公开测试根密钥）、模型解析、LLM prepare 和 EventV2 publish/readCommitted，准备后零网络并退出。下一进程从同一隔离 SQLite 的真实 EventTable 行解码旧 envelope，重新解析模型/凭据、调用原 rebuildRequest/prepare/assertPreparedRequestEnvelope/streamPrepared；不传入前一进程的 envelope 字符串或可执行 prepared 对象。凭据不变时实际本地 HTTP body/完整 URL 等于记录，认证匹配测试原密钥且得到完整回答；原 update 更换版本或 create 更换 ID 时模型确已解析新身份，但重建拒绝、HTTP=0；remove 时目录模型不可用、HTTP=0。四种情况下旧事件 ID/内容均不变，输出无两个测试密钥。

此为**共享重建能力的跨进程测试，不是完整产品冷恢复调度验收**：SessionInfo 是夹具，准备事件挂原 EventV2 的 no-op 测试 projector；没有执行 SessionExecution 的 cold admission、旧租约接管、未决发送判定或共享预算。进程正常退出，不是强杀；Provider 是本机真实 HTTP 受控响应，非外部账号。没有身份的历史记录、环境/内联认证仍不能据此宣称精确凭据重建。后续须把同一身份检查与 R07/R17 的合法恢复分派/不重复发送/预算约束贯通，不可用测试 worker 充当产品实现。

调试记录：第一版新 worker 未注册 Integration 目录导致 seed 模型不可用，且缺 LLMClient runtime 导致类型检查失败/重建失败；补齐原 Integration 与 LayerNodePlatform.llmClient 后通过，没有替换模型或 HTTP 为 stub。两条多余断言和 URL 隐式字符串转换的新增 lint 告警已消除。

本轮 Windows / Bun 1.3.14 验证（均退出 0，重叠批次不累计）：

- Core `bun test --rerun-every test/session-runner.test.ts test/session-compaction.test.ts test/session-title-generation.test.ts test/session/request-envelope.test.ts test/session/request-rebuild-process.test.ts test/session-runner-model.test.ts`：**239 pass / 1385 断言 / 147.81 秒**，六个实际文件。
- 补删除拒绝原因断言并清理新告警后，Core `bun test --rerun-every test/session/request-envelope.test.ts test/session/request-rebuild-process.test.ts`：**25 pass / 140 断言 / 9.05 秒**；已包含四种新进程场景。
- Arforge `bun test --timeout 30000 test/session/prompt.test.ts -t 'Formal stored.*credential version|Formal credential billing boundary|Formal HTTP transmission|Formal title request persistence|Formal compaction HTTP'`：**25 pass / 143 filtered / 261 断言 / 100.13 秒**。
- workspace `bun run typecheck`：**22/22 successful，20 cached，33.638 秒**；Core 独立类型另通过。六文件格式检查/diff-check 通过；最终六文件 lint 仍有 **51 warnings / 0 errors**，其中两个新进程测试文件 **0 warnings / 0 errors**，未将既有告警说成清零。

R06/R09/R17 保持开放，环境/内联凭据、权限变化、正式冷恢复分派、父子预算和标题额度继续待做；真实三平台 full sandbox 最后执行。本批没有操作真实用户密钥、数据库或外部服务。

## 2026-09-12：凭据变更与正式计费预留边界

原 credentialIntegration 新增 primary/summary × before-reservation/after-reservation × replace/remove 八场景。原 SessionPrompt noReply 先接收用户输入，原 SessionExecution.resumeWith 传本次 credentialIDs 与已验证价格/货币预算；未替换 Runner、Credential 或 HTTP transport。预留前通过同一 EventV2 准备记录回调变更凭据；预留后用同一 Database.transactionAsPrincipal 的泛型委托包装，在真实事务返回 reserved receipt 且 digest 匹配本次目标请求后变更，退出时恢复原方法，不新增数据库服务或修改事务结果。

断言变更确实执行、旧执行失败、目标 HTTP 零发送；预留前目标账单不存在，预留后目标 receipt 以零费用结算且 activeReservationIDs 清空；所有账单均已结算。摘要之前的原溢出 HTTP 保留一笔经受控 reconcile 确认的 2 minor units，未被错误清零；阻止发送的目标不额外查询 Provider 用量。总费用、目标 digest 账单数和结算 reservation ID 均从原 SessionRunUsageTable/receipt 核验。

首次测试误从 session/sql 导入账单表导致测试未启动，按原 runtime/sql 导出纠正，无产品变更。八项定向 **8 pass / 92 断言 / 30.85 秒**；最终含三类凭据/原 HTTP/标题持久化/摘要回归 **25 pass / 143 filtered / 261 断言 / 91.87 秒**（包含八项，不累加）。Arforge 独立 typecheck、格式/diff-check 通过；单文件 lint **52 warnings / 0 errors**。本批仅测试和证据。

边界：提交后变更是同进程真实 SQLite 事务的确定性交错，非强杀或多宿主竞争；HTTP 是本地受控 Provider，非真实外部账单。尚需权限变化、环境/内联认证版本、精确冷重建及跨父子预算/标题额度等，R06/R17 不关闭，全平台 sandbox 最后；无真实用户凭据、数据库或外部服务操作。

## 2026-09-12：标题真实凭据变更与用户结果验收

在原 credentialIntegration 正式入口夹具中新增标题 unchanged/replace/remove 三场景。使用真实模型解析与 Credential 服务，显式配置原 title agent 使用测试目录中的同一模型；监听同一 EventV2 的 ActionModelRequestPrepared，在标题准备记录落库时保持、更换或删除原凭据。主回答三场景均保留预期完整文字；正常标题任务 completed、HTTP 共两次且标题更新，变更/删除标题任务 error、仅主请求一次 HTTP、原标题保持。直接读取 EventTable 的唯一标题准备记录，核对原 credential ID/version、无虚构密钥片段，正常标题 HTTP body 与持久化描述一致。原主请求/摘要成功场景另外补完整回复文字断言，不只检查 Exit.Success。

标题定向 **3 pass / 34 断言 / 14.22 秒**；最终三类凭据变更与原发送/持久化/压缩回归合并 **17 pass / 143 filtered / 0 fail / 169 断言 / 48.62 秒**（已包含标题三项，不累加）。Arforge 独立 typecheck、单文件格式/diff-check 通过，lint **51 warnings / 0 errors**。本批仅测试与证据，没有产品逻辑改动；未把旧 workspace/Core 全量结果当成本批重新执行。

边界：凭据来自隔离真实测试库，Provider 为真实本地 HTTP 受控响应，不是外部账号验证。尚未覆盖凭据变更后的计费预留、认证 header、权限变化和新进程精确重建；环境/内联认证版本仍未实现。标题失败未影响本次主回答，但更多用户可理解的错误提示/恢复操作仍需产品旅程验收。R06 保持开放，全平台 sandbox 后置，无真实用户凭据、数据库或服务操作。

## 2026-09-09：真实凭据服务与正式 HTTP 的主请求/摘要变更验证

扩展原 formalIntegration 工厂的 realModels 选项，使用原 SessionRunnerModel.node 而非原 HTTP 夹具的模型替身，并将同一 Credential.node 暴露给测试；实际 SessionPrompt/Core Runner/Integration/Credential/SQLite/LLM HTTP 链保持原实现。在独立测试 profile 创建虚构存储凭据，监听同一 EventV2 的主/摘要 RequestPrepared：不变、原 update 替换、原 remove 删除各一项。断言准备事件确实出现、正常成功/变更失败，主请求 HTTP 1/0/0，摘要流程 HTTP 3/1/1（首个溢出请求保留，变更后无摘要及续答）。读取真实 EventTable，核对唯一目标 envelope 的 credential_identity 精确匹配创建时 ID/version，虚构新旧秘密均不在记录中，成功场景实际 HTTP body 等于记录。

初期摘要场景未配置零近期保留，没有选出压缩头；调整 preserve_recent_tokens 后，摘要又长于原请求，被原 not-smaller 检查正确拒绝。缩短摘要、使用更完整的原任务后正常压缩续答成功；未修改产品边界或放宽断言。最终新增六项 **6 pass / 56 断言 / 19.17 秒**；与原 HTTP/标题持久化/压缩筛选合并 **14 pass / 143 filtered / 133 断言 / 40.43 秒**（包含六项，不累加）。Arforge 独立 typecheck、格式/diff-check 通过；单文件 lint **48 warnings / 0 errors**。本批仅测试与证据，没有产品逻辑变动。

未覆盖标题凭据变更、计费预留专项、认证 header 抓取、跨进程凭据重建或真实外部 Provider；现有新测试正常结果核验到成功状态和发送 body，更多用户结果断言仍可补强。环境/内联凭据仍无版本保护。R06 不关闭，全平台 sandbox 最后，未接触真实用户密钥或数据库。

## 2026-09-09：模型凭据绑定接入主请求、标题与摘要

SessionRunnerModel 的原 resolveCandidate 统一消费 Integration.resolveSnapshot，主/小/备用模型沿同一 resolveBound 获取运行时绑定；非秘密 identity 冻结在以原 Model 为键的 WeakMap，验证闭包重新读取原 Credential 服务，不缓存第二份凭据。正常选中的连接消失时拒绝，不降级使用内联认证；受限 scope 必须匹配所选 credential ID。解析时即核验版本，随后原主请求在预留前及发送前核验，摘要在原 executeCompactionProvider 的预留前及 sendStarted 前核验，标题在原持久化 admission 后核验。

三类原 RequestEnvelope 的 execution.credential_identity 均从绑定模型填入，只存 ID/version，不存整个解析快照。未绑定的外部注入模型、环境和内联认证仍无版本保护，不伪造身份。本批未更改 Provider 认证实现或引入平行请求管理器。摘要校验位于 sendStarted 之前，避免已知未发送却被保守计费。

模型 primary/small 夹具增加 identity 一致、版本变化拒绝、删除拒绝及原绑定不变断言；此处凭据服务为受控夹具。模型与 Envelope 两完整文件 **36 pass / 97 断言**。Runner/Compaction 两完整文件 **177 pass / 1147 断言 / 127.85 秒**；首次命令误带不存在的 test/session/title-generation.test.ts，未计覆盖，随后单跑真实 test/session-title-generation.test.ts，**21 pass / 59 断言**。正式 HTTP 主请求/标题持久化故障/摘要筛选 **8 pass / 77 断言 / 25.90 秒**；workspace 类型 **22/22（21 cached）/ 5.128 秒**。四文件格式/diff-check 通过，lint **37 warnings / 0 errors**。

仍须正式入口真实存储凭据变更→零发送/零额外预留的专项、主/标题/摘要身份落库直接核对、凭据权限边界、恢复时重新解析对应版本、环境/内联认证版本策略。既有正式 HTTP 回归未注入存储凭据变更，不可替代上述专项；WeakMap 是进程内绑定，不是冷重建。R06 保持开放，全平台 sandbox 最后，未操作真实用户凭据。

## 2026-09-09：OAuth 刷新提交的版本条件保护

新增真实 Integration/Credential 同步闸门用例：刷新已进入并暂停，用户原 update 替换秘密或原 remove 删除凭据后，再放行旧刷新结果。修改前两项均未以失败结束。原 Credential.update 现支持 expectedVersion，沿原 ownership + credential ID WHERE 增加 value_fingerprint 条件，同一 UPDATE RETURNING 核验恰好一行；版本变化/删除拒绝，不再静默提交。Integration 唯一 refresh 路径传入读取时版本，旧 resolve 也共用此保护。无新锁服务、状态表或后台刷新器，普通不带版本更新保留原语义。

修复后三完整文件 Credential/Integration/SessionRunnerModel **32 pass / 110 断言 / 1.462 秒**；两项新测试断言旧任务失败、最新完整解密记录保持不变（删除保持不存在），不用固定等待猜测时序。Core 独立类型通过。只验证同进程共享真实 SQLite 的同步交错，不声称真实远程 OAuth 或多进程刷新已验收。后续仍需模型 identity 消费、发送前版本校验及冷重建；并发刷新去重和成员撤权的跨事务窗口仍待验证。未操作真实用户凭据，R06 不关闭。

## 2026-09-09：Integration 统一返回凭据值与版本快照

原 connection 解析逻辑移入 resolveSnapshot，返回 value 与可选 identity（原存储 ID/version）。旧 resolve 仅从同一次快照投影 value，不保留平行 OAuth 刷新实现。普通存储凭据来自同一已认证记录；过期 OAuth 经原 refresh/update 后重新读取已认证记录，使用该记录的值和版本，避免刷新前版本与刷新后值错配。若重新读取发现凭据消失，返回 undefined。环境认证保留原行为且不伪造可持久版本。返回对象包含运行时秘密值，只有 identity 可进入后续 envelope；不能直接持久化完整快照。

新增 key/OAuth 两项真实服务测试核对存储值和 identity、刷新版本变化、旧值投影一致、重复解析不再刷新、identity 无虚构秘密片段、删除后不可解析。最终 Credential/Integration/模型解析三完整文件 **30 pass / 106 断言**；测试初期 nullable 断言类型错误经显式检查 stored 修复，workspace 类型 **22/22（21 cached）/ 4.965 秒**通过。两文件格式/diff-check 通过，lint **6 warnings / 0 errors**。

仍待：SessionRunnerModel 消费 identity、主/标题/摘要 preparation 持久绑定与发送前版本校验、环境/内联认证版本、冷重建。OAuth 并发刷新与撤权的 CAS 保护尚未补齐，本批不声称刷新事务原子性。未访问真实账号或真实用户凭据，R06 不关闭。

## 2026-09-09：原 Credential 返回可追溯的加密版本

读取原 Credential/Integration/SessionRunnerModel 发现模型解析获得秘密值后缺少版本来源。现 Credential.Info 增加必需 version，由原 tenant seal 的 value_fingerprint 返回；该 fingerprint 是加密密文摘要（TenantPlatform.sealScopedValue），不是密钥明文摘要。create 在原持久化之前生成同一 sealed envelope，返回与存储一致版本；get/list/all 解密认证后返回该版本；旧明文行原迁移路径返回本次 sealed 版本。无需新增表、迁移或凭据服务。标签更新不改变版本，秘密替换更新版本；加密重新封装也会改变版本，因此它是严格的 envelope revision，不冒充单调业务序号。

原真实数据库测试增加 create/读取一致、标签稳定、秘密替换变化且读取稳定、旧行首次/再次读取稳定断言；模型测试三份 Credential.Info 夹具补必需版本。初次类型检查暴露三份夹具缺字段及 nullable 断言方向问题，已修复。最终 Credential/SessionRunnerModel 两完整文件 **19 pass / 61 断言**，workspace 类型 **22/22（21 cached）/ 4.952 秒**。本切片没有读取真实用户凭据。

尚未将版本连接至模型准备/持久化 envelope 或发送前重新解析；Integration.connection.resolve 仍仅返回 Value。后续必须在同一解析链中绑定 credential ID/version，处理 OAuth refresh、环境/内联认证，并覆盖版本变化及新进程恢复。不得据此声称凭据重建或 R06 已完成。

## 2026-09-09：重试配置漂移的发送与账单边界

新增两项原 Runner 测试：首次受控 transport 失败后保持温度 0.1 或将同一 route 默认温度改为 0.9。两者均实际调用原 LLMClient.prepare 两次；不变时两次发送描述等于同一持久化 envelope，变化时第二 preparation 已产生不同温度但被原 assertPreparedRequestEnvelope 拒绝，只有首次发送和一条已结算账单，无第二预留及泄漏额度。禁用 legacy stream；读取真实 EventTable 和 SessionRunUsageTable，核对唯一 envelope、全部已发送 transmission、结算行和 activeReservationIDs。保持原产品实现，没有为测试新增 retry owner 或放宽匹配。

首次测试失败为夹具错误：误用不存在的 BillingUsageTable，并未重置跨测试 requests；已改原 SessionRunUsageTable/settlement_reservation_id 和显式重置，未改产品行为。最终新测试连同原 transport retry、retry/fallback 结算筛选 **7 pass / 167 filtered / 0 fail / 75 断言 / 4.35 秒**；Core typecheck 和格式通过。本批仅补测试证据，不宣称完整 Runner 重跑。

这证明进程内温度配置漂移在重试预留和发送前被拒绝，且不变请求可以正常重试；fixture 使用真实准备、受控发送结果，不是 HTTP 抓包或新进程重建。其他 Provider 配置/endpoint/schema、凭据版本、精确冷发送继续待验收，R06 保持开放。

## 2026-09-09：预留提交交接的取消与租约接管

主请求及摘要共用的 persistBillingReservation 将原事务与 receipt 交接置于不可中断区间，通过 onReserved 在恢复可中断性前保存已提交凭据。原 settleBillingCall 根据实际进入发送执行边界与否区分结算：明确尚未开始发送时使用零用量估算释放预留，不查询 Provider；已进入发送边界仍沿原保守结算策略，不假定 HTTP 已发送或免费。租约失效时原事务/CAS 拒绝旧执行者写账，保留 pending 给合法恢复者。摘要 Promise 先登记可等待的清理句柄再启动 Effect，继续由原事务退出等待清理。

四项新增测试在真实 SQLite 事务提交后、receipt 交接前设置确定性闸门，覆盖 primary/summary × cancel/takeover。取消先向实际执行预留的 fiber 送达中断，再释放交接；不以外层取消请求已发出代替目标收到中断。断言无额外发送、零结算及预留释放；接管断言旧任务失败、pending 行及新 owner 完整快照不变。测试进一步复现摘要接管仍返回 Success：原 validateExecution 仅校验子任务，root 为 Effect.void。现同一校验先检查原 DurableRun lease，再校验子任务绑定，并在自动/溢出压缩返回后复核；没有新增状态机。定向先 5 pass / 1 fail，修复后 **6 pass / 42 断言**（含两项旧 root 接管测试）。

最终验证：Core `bun test --rerun-every test/session-runner.test.ts test/session-compaction.test.ts test/session-checkpoint.test.ts test/billing.test.ts` 实际执行三个存在文件，**192 pass / 1208 断言 / 130.18 秒**；其中误写的 test/session-checkpoint.test.ts 不存在，未计覆盖。随后显式运行真实 `test/session/checkpoint.test.ts test/session/compaction-checkpoint.test.ts`，**12 pass / 39 断言**。正式 `prompt.test.ts` 的 Formal HTTP transmission / Formal title request persistence / Formal compaction HTTP 筛选 **8 pass / 143 filtered / 77 断言 / 26.14 秒**。Core 独立类型及 workspace **22/22 successful（21 cached）/ 5.492 秒**通过；三文件格式/diff-check 通过，lint **78 warnings / 0 errors**。

边界：临界取消是进程内同步故障测试，不是强杀后可持久证明“从未发出”；租约接管是同测试服务操作原真实数据库，不是多宿主竞争。数据库到网络不存在原子性承诺，不可中断事务的 PostgreSQL 等待上界尚未验收。摘要确认用量期间撤权/篡改、凭据版本、精确冷发送、跨父子预算及标题额度继续待办，R06/R09/R17 不关闭，全平台 sandbox 最后。未操作真实用户数据库、凭据或外部 Provider。

## 2026-09-09：摘要结算超时与独立新进程恢复续验

新增取消摘要后 reconciliation 超时的真实流程测试：等原 5 秒超时退出，不用固定睡眠猜测就绪。SQLite 中保留原 reserved receipt，run 为 paused；迟到的 Promise 用量返回不改变记录。当前进程恢复时缺确认用量失败且无新请求；确认 Provider 用量后沿原价格结算摘要，下一请求使用新价格，延续原 settledMinor 和同一 run，空闲唤醒不再发送。初期 TestClock 专项 1 pass / 19 断言，后并入 live 流程，不累计为独立覆盖。

扩展原 billing-recovery-worker，同一原 Runner/SQLite owner 支持 summary 恢复样本，不新增恢复实现。测试将已暂停的测试库 VACUUM INTO 三个隔离快照；分别启动 missing/estimated/rejected、available、idle 共 9 个独立进程。未确认用量保持 paused、不改旧行且零 Provider；确认后绑定原 reservation/provider/model/digest、原价计费、同 run 连续预算，空闲进程零重放。核验原已结算行和其他 run 保持不变、只存在原一份摘要 receipt。summary worker 使用带 20,000 context/1,000 output 的压缩可用模型，避免“缺模型 limits 导致根本不可能压缩”的假阳性。父测试库在子进程运行后保持原状，再执行当前进程恢复。

最终冷恢复筛选 **6 pass / 162 filtered / 0 fail / 149 断言 / 43.66 秒**（含四种旧已结算账单恢复、旧 pending 恢复及新增 summary 恢复）。独立早期 summary 测试 1 pass / 56 断言为重叠结果，不累计。结算/摘要故障筛选 **15 pass / 153 filtered / 0 fail / 169 断言 / 9.42 秒**。Core typecheck、两文件格式/diff-check 通过；lint **49 warnings / 0 errors**，未清零历史告警。本批仅测试和证据变动，无产品逻辑修改，未宣称重跑完整 Runner 或全工作区类型。

边界：这是暂停后复制真实测试 SQLite、用原 Runner 在独立进程恢复账单，Provider 响应受控；不是强杀现场、多进程同时争抢同一库、真实外部账单核对或精确请求冷发送验收。尚未覆盖摘要结算查询期间撤权/换 lease/账单篡改的全部专属组合，以及 reservation 提交临界取消；跨父子预算、标题维护额度、凭据版本继续待办。R06/R09/R17 不关闭，全平台 full sandbox 最后；未读取或修改真实用户数据库与密钥。

## 2026-09-09：摘要接入同一运行的计费预留与取消结算

新测试真实复现同一 billed run 发出 overflow/summary/continuation 三请求却仅落两条计费 receipt。原 Runner 中的预留事务与结算策略提为同一闭包内 persistBillingReservation/settleBillingCall，主请求与摘要共同消费：保持 session→run 锁顺序、principal、租约复核、未决账单阻断、版本化价格快照、CAS 结算与原恢复 receipt。没有新建账本/预算服务或为摘要分配独立额度。摘要在已提交 RequestEnvelope 验证后经必需 executeProvider 回调发送；自动压缩与溢出恢复均接原 run scope。Provider 用量来自原 Usage，缺失时保留原具名估算策略；已知用量摘要的 Compaction.Ended.usage.cost 改用实际结算价格。

新增五项验证：同一运行三份完整 receipt、摘要 digest 对应价格 15 minor units 与原压缩事件 usage.cost=0.15；额度不足拒绝摘要发送；摘要预留 INSERT 失败不发送；摘要结算 UPDATE 失败保留 reserved receipt、不提交摘要/不继续；发送前可查 pending receipt、取消后返回前保守估算结算完成。测试最初将成本误断言在上下文消息/事件顶层，按原 Compaction.Ended.usage 合同纠正；固定估算夹具初缺必需分类字段导致主请求前失败，补齐零分类值后通过，未放宽产品价格合同。

取消专项另复现外层 Promise 桥先返回、Runner 释放 lease 后摘要结算尚未完成的竞态。原 compactAfterOverflowImpl 现跟踪同一次摘要 Promise，并在退出前 join 其清理，使原租约仍存活；无后台 detached 结算任务。新取消用例从 pending→settled、零摘要提交验证通过。结算写入失败仍保留可恢复 pending，不伪造免费或已完成。

最终 Runner/Compaction/Checkpoint 三完整文件 **175 pass / 0 fail / 1059 断言 / 105.32 秒**，单独 Billing **17 pass / 84 断言**。首次全量命令误带不存在的 test/runtime/billing.test.ts，Bun 实际只跑上述三文件；随后显式运行真实 test/billing.test.ts，未将不存在路径算作覆盖。正式主请求 HTTP、标题及压缩 HTTP **8 pass / 143 filtered / 0 fail / 88 断言 / 24.68 秒**。workspace 类型 **22/22 successful（21 cached）/ 5.255 秒**；三文件格式/diff-check 通过，lint **77 warnings / 0 errors**，未清零历史告警。

仅证明同一运行内的货币预算共享；不是跨父子 run 的聚合额度或 DurableRun token 额度全部融合。尚待摘要专属 reconcile 超时/价格变化/冷进程恢复、reservation 提交临界取消窗口、真实计费 HTTP 故障矩阵及未配置 billing 时的用户成本展示。标题严格预算下仍跳过维护请求，不能称已完成标题共享额度。R06/R09/R17 均不因本切片关闭，凭据版本、重试漂移和精确冷重建继续，真实三平台 full sandbox 最后。无真实用户数据库、凭据或外部 Provider 操作。

## 2026-09-09：摘要终态拒绝与正式 HTTP 用户结果恢复

新增六个 Core 流故障测试；修复前 missing finish、length、tool-calls、重复 finish、finish 后 text 五项均错误提交摘要并触发第三次请求，provider-error 已正确拒绝。原摘要消费函数现在必须收到唯一 stop finish，错误状态不可被后续 stop 清除，finish 后 text 也拒绝；继续由同一事务回滚，不增加状态 owner。测试核对零 compaction/synthetic、原始用户历史保留、原错误终态，以及事件重放后上下文相等。测试数组 filter 推断排除 finish 的类型错误通过显式 LLMEvent[] 修正，没有产品类型绕过。

正式 SessionPrompt 入口增加本地真实 HTTP 两场景：413 后准备摘要，stop 成功续答，content-filter 拒绝替换历史。从 EventTable 读取本会话 Compaction.RequestPrepared，比较摘要 HTTP 的完整 JSON body、摘要 hash、实际 server origin 和 path/query，虚构认证值不在记录中。最初误将 Core keep.tokens 写到原配置入口，按现有 V1 配置迁移合同改为 preserve_recent_tokens；没有更改配置产品合同。

真实测试随后复现第二个产品缺陷：保留零近期 token 时摘要与最终回答均完成，drainAdmitted 因上下文不再含 user 而抛出 Canonical execution completed without an assistant result。原 drainAdmitted 现接收本次 admission ID（prompt 和 command 共用）；仅有 compaction 且当前窗口无 user 时，从同一 SessionStore.message 查询精确原 ID，核验同会话与 user 类型，用于原 CoreMessageCompat 返回。没有从旧 Python/旧消息 owner 回读或创建另一份结果。失败测试按实际上下文中 agent-switched 元数据改用查找 user，而非假定第一项是 user。

最终 Core Runner/Compaction/Checkpoint **170 pass / 0 fail / 1033 断言 / 99.48 秒**。正式入口扩大回归 **15 pass / 136 filtered / 0 fail / 144 断言 / 50.19 秒**，覆盖上述两场景、主请求 HTTP 四场景、命令、取消、追加输入、Shell 及普通回复；不是完整 prompt 文件全量。独立两 HTTP 场景 2 pass / 26 断言被扩大批包含，不累计。工作区类型 **22/22 successful（20 cached）/ 22.697 秒**；四文件格式/diff-check 通过，lint **102 warnings / 0 errors**，未清零历史告警。

范围仍有限：未完成所有文本块顺序的协议严格验证、真实外部 Provider、真实维护成本/共享预算、凭据版本、重试漂移、新进程精确发送与所有 Provider schema。当前 HTTP 测试不含所有摘要发布故障的真实网络注入。原配置入口与 Core 合同的进一步融合仍是计划待办，不能因使用迁移合同而称其已退役。R06/R09 与整体计划保持开放，full sandbox 最后，无真实用户库或凭据操作。

## 2026-09-09：压缩摘要复用 preparation 与原事务生命周期

原 SessionCompaction.make 接入同一个 Database/EventV2 和 LLMClient.prepare/streamPrepared；摘要请求使用原 RequestEnvelope 保存最终 transmission。新增现有 Compaction 命名空间下的 durable RequestPrepared 事件，与原压缩 messageID 绑定；发送前从实际已提交行读取、解码并核验摘要、通用请求及准备对象，缺失或不匹配不发送。事件在原消息投影中明确 no-op，不产生额外可见对话；生成客户端已同步。继续由原 runTransactional 和检查点处理失败/回滚，没有新增压缩状态机。Promise 桥显式保留原 Effect context 和取消信号。

原成功恢复测试禁用旧 stream，并直接对比发送准备描述与 SQLite envelope，保留后续回复、压缩上下文和事件重放断言。新增 BEFORE INSERT 拒绝与 AFTER INSERT 改写 envelope 两场景，均只发送原始溢出请求、不发送摘要、不生成 compaction 上下文，原始错误仍可见。首次三项失败是 setupOverflowRecovery 已有准备历史发送未随 requests 清零，修正测试观察边界后 **3 pass / 17 断言**；未放宽产品校验。

最终 Runner/Compaction/CompactionCheckpoint 三完整文件 **164 pass / 0 fail / 1003 断言 / 102.67 秒**（包含上述专项，不累计）。Protocol 四文件 **12 pass / 39 断言**，仅原协议回归，不当作新增事件专项。工作区类型 **22 successful / 22 total、19 cached**；五修改文件格式与 diff-check 通过，lint **76 warnings / 0 errors**，未清零历史告警。

边界：本批为真实协议准备、SQLite 事件与受控发送的 Core 验证，不是压缩摘要的真实 HTTP 捕获或外部模型验收。摘要终态完整性、实际维护计费、凭据 identity/version、重试漂移、新进程精确发送重建及完整 Provider schema 继续待验；不声称数据库到网络原子提交。R06 保持开放，真实三平台 full sandbox 最后执行。未操作真实用户库、凭据或外部 Provider。

## 2026-09-09：标题生成并入原 preparation 发送合同

scheduleTitle 在原通用标题请求基础上调用同一 llm.prepare，将最终 transmission 放入原 RequestEnvelope，Action inputDigest 使用该完整摘要。准备阶段单独设 30 秒超时；generate 仍保留原授权/发送的 30 秒限时，两者不是总计 30 秒承诺。TitleGeneration.generate 必须接收 prepared 和 streamPrepared，在授权记录前后核验同一对象描述，取消旧 stream(request) 接口，保留 usage 回调、输出限制、终态与取消规则。

原 Gateway operation.recordModelRequest 写入后，scheduleTitle 通过 DurableAction.load 读取原事件历史派生的 modelRequest，再解析并验证它与 Action inputDigest、原 envelope 摘要及准备描述一致，随后发送。不另建标题请求或结算 owner。此读取不是本地 serialized 字符串；也不是完整历史认证或数据库/网络原子发送。

新增单元测试验证传入原准备对象、授权时改写 body 后零发送；旧接口下新消费测试失败。原媒体/配置、拒绝、取消/超时/defect、usage/空输出及 Gateway 结算测试迁移至真实 prepare 后保持通过。正式标题生成将实际 HTTP handler 的第二次请求 body 与 Action modelRequest.transmission 深比较，摘要绑定一致且虚构认证头值不在记录中。两个 SQLite TEMP trigger 分别阻止标题请求事件插入、插入后改为 `{}`，后台 job 为原 error 终态、标题 HTTP 为零、主回答仍正常、原标题保留。测试初次误写 failed 状态，按原 BackgroundJob.Status 的 error 更正；产品状态定义未更改。

最终 Core Runner/Title/Gateway 三完整文件 **288 pass / 0 fail / 1624 断言 / 111.89 秒**。正式标题成功、两持久化故障、rename/rename-back/cancel 六场景 **6 pass / 48 断言 / 24.58 秒**；与后续扩大批重叠，不累计。工作区 typecheck **22 successful / 22 total（19 cached）**，五修改文件格式/diff-check 通过；lint **113 warnings / 0 errors**，未清零历史告警。

最终扩大标题筛选回归 **25 pass / 124 filtered / 0 fail / 224 断言 / 96.32 秒**，包含新进程投影恢复、模型配置/小模型、空输出/缺 usage、两持久化故障、重命名/取消，以及 subtask/text/image-only 首轮。该批覆盖上述六场景，不累加；不是整个 prompt 文件全量，也不是冷进程重新发送验收。

本批不关闭 R06：压缩摘要仍待同类接线；凭据 ID/version、重试配置漂移专项、完整 Provider schema、新进程精确发送重建及准备超时的产品级注入测试尚待继续。严格货币预算下的标题维护额度仍保持原跳过策略，不能以本次接线声称已补齐。full sandbox 最后，无真实用户库或外部 Provider 操作。

## 2026-09-09：正式入口真实 HTTP 与已提交事件直接对照

在既有 formalIntegration/TestLLMServer 中新增四场景，不替换 LLMClient 或 transport。由 SessionPrompt 正式入口、原 Core Runner、真实本地 Node HTTP server（系统分配端口）完成请求；从 EventTable 读取本会话的 RequestEnvelopePrepared，经原 Schema 和 parseRequestEnvelopeJson 校验后，将 transmission.body 与 HTTP handler 捕获的完整 JSON 做深比较，同时核对摘要、endpoint 与测试 server origin、实际 path/query。server 的 hits.url 使用固定解析基准，因此不把它的合成 origin 当作观测值；origin 与实际已启动 server 地址核对。用户结果保留 assistant 和完整回复文字断言，固定 title 防止维护请求混入计数。

四场景：正常发送一次；原 EventV2 projector 在发布时把同一 route 默认温度从 0 改到 0.9，实际发送仍为 0 并与记录一致；BEFORE INSERT 拒绝发布时零 HTTP/零请求事件；AFTER INSERT 改写 envelope 时零 HTTP/保留坏行。虚构认证值 test-key 不在记录中。projector 使用正式夹具显式暴露的同一个 EventV2.node，没有构造第二事件服务。最初配置突变测试误从 location 层取全局事件服务并使用错误 payload 字段，失败后修正测试服务作用域及 event.data；没有修改产品逻辑。

最终四场景加正式标题和 scheduled child 恢复 **6 pass / 141 filtered / 0 fail / 65 断言 / 21.87 秒**。Arforge typecheck、单文件格式和 diff-check 通过；lint **36 warnings / 0 errors**。本轮仅测试与证据更新，不重复宣称整份 prompt 文件全量通过；此前 Core 全量结果保持历史范围。

本批证明正常首次发送的 JSON 语义及顺序与落库内容相同，以及两个真实发送前故障拒绝；不声称 JSON 空白字节、任意 header、真实外部模型效果、数据库至网络原子性、WebSocket 网络或冷恢复已验收。后续继续标题/压缩的 preparation 绑定、重试漂移、credential identity/version、完整 schema/Provider 和新进程精确重建。R06 仍未关闭，full sandbox 最后；未接触真实用户库或密钥。

## 2026-09-09：Core Runner 消费实际已绑定的 preparation

Runner 在 compaction 决定继续后调用原 llm.prepare，将 transmission 纳入原 RequestEnvelope；发布后仍读取实际 EventV2 行，再验证通用请求与同一次 preparation。发送前再次检查，使用 streamPrepared，不再为首次发送调用 stream(request)。无最终描述不能降级发送。重试在原执行入口重新准备新的一次性句柄，须与原已提交描述一致，之后才进入原预算 reservation/lease 管线；未新建请求管理器或更改租约/结算 owner。

新增旧 stream 抛错哨兵场景先失败，切换后成功；实际准备描述与 SQLite 事件中 envelope 一致。发布失败、AFTER INSERT 改写事件两场景均不调用准备发送。另在原 EventV2 projector 中改写内存 transmission.body，发送拒绝；只改变 route 默认 temperature 为 0.9 时仍消费已固定的 0.1 描述。该 Core fixture 用真实协议 prepare、受控 streamPrepared 结果及一次性对象映射；不是完整网络捕获证据。

扩大回归首次 149 pass / 3 fail：三条 hosted tool 夹具一直使用 OpenAI Chat 路由，旧替身不编译而掩盖其不支持 inline hosted result。三场景改用原 Anthropic Messages 协议（包括压力剪裁模型），保留历史恢复、内容、剪裁和持久化断言；没有放宽 OpenAI Chat 输入规则。新进程 billing worker 同步使用真实 prepare 和原受控 streamPrepared 响应。泛型 mock 的类型错误通过显式保留 Body 泛型修复，没有让产品方法变可选。

最终 Core Runner + Envelope 两完整文件 **174 pass / 0 fail / 1021 断言 / 100.09 秒**；正式产品标题生成和 scheduled child 恢复 **2 pass / 26 断言 / 11.77 秒**。Core/Arforge 类型、三文件格式和 diff-check 通过；lint **66 warnings / 0 errors**，历史告警未清零。没有操作真实用户库、凭据或外部 Provider。

仍待验收：真实 HTTP 捕获与已提交记录直接比较、准备失败的产品体验和完整协议 schema 语义、凭据版本突变、重试时配置漂移专项、标题/压缩最终 preparation 接线、冷进程精确重建。现有 billing 新进程测试不等于最终请求冷重建验收；数据库读取至网络仍非原子事务。R06 不关闭，full sandbox 最后。

## 2026-09-09：最终 transmission 融入原 RequestEnvelope 合同

在原 request snapshot 增加可选 transmission，保存 transport、最终 body、已核验 endpoint；这些内容参与原 request_digest 和规范化序列化，不新增存储或请求 owner。旧记录仍可作为通用请求读取，但新增 assertPreparedRequestEnvelope 对缺失 transmission 明确拒绝；它独立核验实际准备结果的 model/provider/route/protocol、最终描述及记录摘要。assertRequestEnvelope/rebuildRequest 保留记录的 transmission，只证明通用请求重建；调用方必须额外执行 preparation 核验，不能把前者当作发送验证。

传输描述严格限定字段，缺 endpoint、exact=false、伪称 exact=true 的敏感 URL、body 中已识别的秘密字段均不能持久化，解析伪造记录同样拒绝。未保存完整 PreparedRequest、认证头或 transport 私有对象。真实 OpenAI Chat 编译器（不发网络）确认 HTTP overlay 进入记录，序列化无虚构认证头值，重新编译为 changed overlay 后核验失败。另测 route 错配、内容变化导致摘要变化、旧记录不能冒充准备绑定。此时的真实编译并非真实 HTTP/数据库发送闭环。

Core Envelope/Runner 完整两文件 **171 pass / 0 fail / 1011 断言 / 101.38 秒**；独立 Envelope **20 pass / 58 断言**，两者重叠不累加。Core/Arforge 类型检查通过，两文件格式完成，lint **27 warnings / 0 errors**。新增 API 的首轮测试因导出尚不存在失败；第一次类型检查发现测试断言类型方向不兼容，调整断言而未弱化产品类型后通过。

下一步必须把 Runner 在 compaction 决定后取得的同一次 prepare，绑定上述合同并经实际 EventV2 读取后由 streamPrepared 发送，同时迁移既有测试替身；当前 Runner 仍使用 stream(request)。标题/压缩、所有 Provider 工具 schema 语义、凭据版本和新进程重建还未验收。此合同扩展不关闭 R06，不把本轮算成端到端交付。

## 2026-09-09：endpoint 描述与持久化凭据边界

原 RequestExecutor.describeEndpoint 共用现有敏感 query 分类，增加 userinfo 脱敏、fragment 移除及 exact 标志；HTTP/WS describe 读取本次已准备的实际地址，LLM preparation 的改写校验覆盖 endpoint。诊断响应回显继续使用同一 executor 的 secretValues，补 userinfo/fragment 的字面和解码形式。exact 只表示未触发已知 URL 脱敏规则，不保证识别任意命名的秘密；未修改既有短值匹配策略。

Core RequestEnvelope 原来只检查字段名，六个新增负例在修复前全部失败：base URL userinfo、key query、fragment、静态 path 的 sig query、协议相对地址 userinfo、独立 query.key。现在创建、序列化及解析共用 normalize，在精确 endpoint 字段路径复用 RequestExecutor 的分类并拒绝，不将脱敏结果替换为可重建请求。不拼接后才检查，避免 override 隐藏仍会保存的其他组件。正常 base/path/query 原样往返，普通 metadata 中的文档锚点不按 endpoint 拒绝。

最终 Core RequestEnvelope + SessionRunner 两完整文件 **168 pass / 0 fail / 992 断言 / 115.44 秒**；LLM 全包 **318 pass / 30 skip / 0 fail / 767 断言 / 1.79 秒**。Core/Arforge 类型检查通过；Core 两修改文件格式和 diff-check 通过，lint **25 warnings / 0 errors**，未清零既有告警。上述测试使用虚构凭据与隔离夹具，无外部 Provider 或真实用户库操作。

剩余边界：最终 transmission 尚未绑定原 RequestEnvelope/Runner 的实际 streamPrepared 消费；credential identity/version、标题/压缩接线、新进程重建仍需继续。动态 endpoint、未知命名或业务 body 中的敏感值不由本次规则证明安全；不得直接持久化整个 PreparedRequest。R06 不关闭，真实三平台 full sandbox 最后。

## 最新实现：最终 HTTP/WS body 描述与真实 loopback 捕获

原 PreparedRequest 增加可选 transmission（transport、body）；body 仍保留协议预览语义。两者不是两个请求 owner：原 Transport.describe 从本次已经编码的结果读取，HTTP 使用原 bodyText（包括合法 http.body overlay），WebSocket 使用原 message（包括 response.create 封装）。LLMClient.prepare 在同一次编译后获取此描述，streamPrepared 的改写检查同时覆盖协议 body 与 transmission。没有 describe 的自定义 transport 不伪造最终描述；其后续严格持久化策略仍需显式处理。

新增 HTTP overlay 测试先因 transmission 缺失失败；接入后，prepare 后修改 overlay 不改变实际发送内容。另验证 WebSocket 发送帧等于 transmission，而不等于原协议预览；两种描述都不包含测试 auth header 中的凭据值。复制、改写协议 body、改写 transmission、重复消费均拒绝且不增加请求。

真实 loopback HTTP 使用临时 Bun server（127.0.0.1、系统分配端口）与原 RequestExecutor/FetchHttpClient：准备后修改 overlay，实际网络捕获 JSON 仍为 original，并与 transmission.body 完全相同。服务由作用域清理，无固定就绪睡眠、无外部 Provider 调用。WebSocket 测试使用受控 executor，不冒充真实 WebSocket 网络验证。

最终准备专项 **7 pass / 22 断言**；LLM 全包 **315 pass / 30 skip / 0 fail / 754 断言 / 0.892 秒**（32 文件）。LLM/Core/Arforge 类型检查通过；正式标题/缺 usage 标题/scheduled child **3 pass / 49 断言 / 17.11 秒**。六文件格式与 diff-check 通过，lint **14 warnings / 0 errors**，未清零历史告警。

边界：当前描述只包含最终 JSON body，不含 URL、header 或完整 transport 重建合同。没有将原始 auth header、transport 实例或 WebSocket 连接序列化；但 body 仍可能是用户敏感内容，不能把“未复制授权头”当成允许未经原隐私规则直接持久化整个 PreparedRequest。下一步必须将最终 body 与 endpoint/credential identity/version 绑定到原 RequestEnvelope 和实际已提交事件，再接 Runner/标题/压缩与新进程重建。完整 R06 尚未达标，full sandbox 最后，无真实用户库或配置修改。

## 最新实现：Runner 读取实际已提交事件

新增原 EventV2.readCommitted(db, definition, receipt) 有界读取函数：按发布回执 id 查询原 EventTable，核对 durable 定义/version、aggregate、seq、versioned type，并将回执 data 通过原 Schema JSON 编解码归一后与实际行严格比较。返回实际 serialized row，不选择 aggregate 最新一条，不新建事件/存储 owner。Runner 保存原 RequestEnvelopePrepared 的 publish 返回值，通过该函数读取，再按原事件 schema 解码实际 envelope、进行既有请求 invariant 和重建。

新增 SQLite TEMP trigger 故障回归：publish-failure 在 INSERT 前拒绝，原实现已正确阻止发送；changed-row 在 INSERT 后将该事件 envelope 改为 `{}`，修复前 Runner 返回 Success（预期 Failure 的断言失败），修复后 Failure、Provider 请求为零且保留被测试改写的行。仅测试临时库，未修改实际用户事件。另用 EventV2 测试验证已有 newer 事件时仍读 original，并拒绝无 durable、缺失 id、seq/aggregate/version/data 不匹配的回执；拒绝后原行保持不变。

最终 EventV2 完整 **48 pass / 100 断言 / 2.15 秒**，SessionRunner 完整 **151 pass / 953 断言 / 93.49 秒**，正式标题/缺 usage 标题/scheduled child **3 pass / 49 断言 / 17.72 秒**。Core/Arforge 类型检查通过，四文件格式和 diff-check 通过；四文件 lint **75 warnings / 0 errors**，历史告警未清零。完整批次后仅格式整理，没有把重叠专项相加为独立覆盖。

边界：本批关闭的是“用本地字符串冒充读取已提交行”的实际消费缺口；不代表 EventV2 全历史防篡改、跨主体认证或数据库读取到网络发送的原子性。现仍存通用 RequestEnvelope；最终 Provider/HTTP overlay 描述、credential identity/version、标题/压缩的最终 preparation 绑定以及新进程精确发送重建仍未完成。readCommitted 不是发送授权的新 owner，预算/租约仍走原管线。R06 保持开放，full sandbox 最后；无真实用户库、凭据或外部 Provider 操作。

## 最新实现：原 LLMClient 复用准备结果

原 prepareWith 仍只编译一次，在既有 client 模块内以 WeakMap 关联公开 PreparedRequest 与原 transport preparation；授权头等 transport 私有数据不添加到公开对象。新增必填 streamPrepared，仅消费原对象且一次使用，复制/未知/已消费对象拒绝，不回退到 compile。发送前检查 body 是否被改写，拒绝时零 HTTP。普通 stream(request) 也改为 prepareWith → 同一 streamPreparedWith，不保留第二条编译发送实现。保存原 route.streamPrepared 函数，不在消费时重新选择它。

新 prepared-execution.test.ts 使用既有 HTTP 替身，证明 prepare 后 temperature 0.1→0.9、endpoint before→after，仍发送 before endpoint 和原 body；再次消费不增加请求，复制与改写 body 均具名 InvalidRequest/零请求。首次正例失败是新 SSE fixture 将 finish_reason 放错位置，改用原 deltaChunk 的第二参数后通过；不是修改协议终态规则。此前诊断的 old prepare→stream(request) 漂移仍有效：调用方须接入 streamPrepared 才会消费那次准备对象，不能声称旧调用方式自动绑定。

最终 LLM 包完整 **311 pass / 30 skip / 0 fail / 742 断言 / 1.065 秒**（32 文件），跳过的录制场景不算真实 Provider 验收。LLM/Core/Arforge 类型检查通过。新增必填方法使六处旧 mock 缺字段，显式补 die/throw 哨兵，未改可选字段或用 unknown 断言绕过类型。Core golden **19 pass / 480 断言**；Arforge native/binding 两文件 **21 pass / 65 断言**；改后正式标题/缺 usage 标题/scheduled child **3 pass / 49 断言 / 18.62 秒**。client 与新测试 lint **5 warnings / 0 errors**，新增测试无 unsafe body 强转，新静态 API 显式声明 Service 依赖；历史告警未清零。

边界：此是现有 LLMClient 内的进程内执行句柄，不是持久化 token/新请求管理服务。公开 PreparedRequest.body 仍为协议 body，不能冒充含 HTTP overlay 的完整最终传输描述；未证明所有 endpoint/auth/cache/schema 突变、新进程重建或真实凭据版本。Runner、标题和压缩尚未将最终 preparation 绑定到真实已提交事件；原通用 envelope 的内存解析缺口仍待修复。普通 stream 的一次内部准备不等于持久化的 prepare→确认→send 闭环。本批无真实用户数据、凭据、远程 Provider 操作，full sandbox 最后。

## 实际结果

在 `packages/llm` 使用原 `LLMClient.prepare`、`LLMClient.stream`、OpenAI Chat route 和既有 `test/lib/http.dynamicResponse` HTTP 替身运行。准备完成后，仅修改当前进程测试 route 的 generation.temperature。

```json
{
  "preparedTemperature": 0.1,
  "sentTemperature": 0.9,
  "bodyEqual": false,
  "transportCalls": 1,
  "externalNetworkCalls": 0
}
```

命令退出 0 表示诊断执行完成，不表示精确请求验收通过。HTTP 替身返回空 SSE，流结果由 Effect.exit 接纳；本实验只观察实际交给 HTTP 边界的 body，不声称模型调用成功。无真实凭据、用户配置或远程 Provider 操作。

## 复现代码

在 `packages/llm` 通过 `bun -e` 执行以下 TypeScript，无需新增产品服务：

```ts
import { Effect, Stream } from "effect"
import { LLM } from "./src"
import * as OpenAIChat from "./src/protocols/openai-chat"
import { Auth, LLMClient } from "./src/route"
import { dynamicResponse } from "./test/lib/http"

let sent
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://probe.invalid/v1" },
    auth: Auth.bearer("fixture-only"),
    generation: { temperature: 0.1 },
  })
  .model({ id: "fake-model" })
const request = LLM.request({ model, prompt: "fixture" })
const layer = dynamicResponse(({ text, respond }) =>
  Effect.sync(() => {
    sent = JSON.parse(text)
    return respond("", { headers: { "content-type": "text/event-stream" } })
  }),
)
await Effect.runPromise(
  Effect.gen(function* () {
    const prepared = yield* LLMClient.prepare(request)
    const before = JSON.parse(JSON.stringify(prepared.body))
    // Deliberate runtime mutation in this isolated diagnostic, not a typed caller API.
    model.route.defaults.generation.temperature = 0.9
    yield* LLMClient.stream(request).pipe(Stream.runDrain, Effect.exit)
    console.log(
      JSON.stringify({
        preparedTemperature: before.temperature,
        sentTemperature: sent?.temperature,
        bodyEqual: JSON.stringify(before) === JSON.stringify(sent),
        transportCalls: sent ? 1 : 0,
        externalNetworkCalls: 0,
      }),
    )
  }).pipe(Effect.provide(layer)),
)
```

## 原因与后续实现边界

- `packages/llm/src/route/client.ts` 的 prepareWith 调用 compile，但返回对象未承载供发送消费的原 transport preparation；streamRequestWith 再次 compile 原请求，因此重新消费可变默认值。
- Core Runner 仍以通用 RequestEnvelope 重建 request，再调用 llm.stream。现有 envelope 不是最终 Provider body 的持久化证明。
- Runner 发布事件后解析本地 serializedRequestEnvelope 字符串；这里的 persisted 命名不能作为读取已提交事件行的证据。

下一步在原 LLMClient/RequestEnvelope owner 内融合，不建立另一个请求管理器：先补“同一次准备供发送消费”的回归与 API，再把最终非秘密请求描述绑定到既有 durable publish，提交确认后才发送。常规请求、重试/fallback、标题和压缩请求均须消费同一规则。

不得持久化 transport 对象或授权头。身份/version 引用、endpoint/defaults/cache/schema 突变、新进程重建、发布失败零发送及真实本地 HTTP 捕获仍是 R06 的退出条件；本次替身诊断没有替代这些验收。
