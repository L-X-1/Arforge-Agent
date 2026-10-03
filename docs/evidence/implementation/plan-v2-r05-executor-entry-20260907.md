# R05：公开 prompt/command 融合到已装配执行器

## 整文件复验完成（2026-09-08）

上轮持续运行的 `bun test test/session/prompt.test.ts --timeout 30000 --rerun-every` 已退出 0：**137 pass / 6 skip / 0 fail / 1428 断言 / 655.27 秒**。原九个失败场景均在该整批中通过，六个跳过保留其平台/旧 projector 边界，不算验收通过。该进程启动早于本轮 LLMClient 的 R06 修改，结果证明前批 R05 测试迁移后的整文件，不冒充 R06 改后整文件回归。

R06 改后另跑正式标题、缺 usage 标题和 scheduled child **3 pass / 49 断言 / 18.62 秒**，其他改后范围见 [准备结果消费证据](./plan-v2-r06-prepare-drift-20260908.md)。R05/R17 的共享预算、真实故障恢复和产品交付退出条件并未因此全部满足；全计划保持进行中，full sandbox 最后。

## 四项剩余失败的测试接线修正（2026-09-08）

本批继续上轮整文件失败清单，未新增产品执行器或修改权限规则：

- Snapshot 审批使用原 pollWithTimeout 就绪信号，将默认 2 秒窗口改为 10 秒，保留实际审批、写入前后快照、文件差异及总结断言。专项耗时 22.74 秒，包括后续工具和摘要工作；不是增加固定睡眠。
- 两项附件读取中断测试只验证 admission 的工具取消，原 fixture 无 canonical execution owner，却调用需要执行器的 prompt。现显式 noReply:true 进入原输入准备链；Windows 文件/目录 URL 改用 pathToFileURL。保持 read 工具阻塞、取消调用及 fiber 中断，额外等待并断言原 read 清理信号，不把单纯 fiber Failure 当作工具清理证据。
- 未知命令测试迁入已有 Formal/Core 装配，继续核验 NamedError.Unknown、缺失命令名及可用命令提示，不改变 requireExecution 的失败关闭规则。

四项专项 **4 pass / 0 fail / 23 断言 / 35.39 秒**。Arforge typecheck 退出 0；格式不变、diff-check 通过；单文件 lint **30 warnings / 0 errors**，历史告警未清零。仅修改测试，没有产品代码改动。

已启动 `bun test test/session/prompt.test.ts --timeout 30000 --rerun-every` 进行整文件重新验收；本条写入时进程尚在运行，不能以专项通过替代整批结果。上轮首批 128/6/9 的历史结果保留，不改写成通过。R05/R02/R28 保持开放，真实三平台 full sandbox 最后；本批无真实用户数据、凭据或远程 Provider 操作。

## 正式入口整文件回归与三项旧测试融合（2026-09-08）

本批扩大到整个 packages/arforge/test/session/prompt.test.ts，首轮命令 bun test test/session/prompt.test.ts --rerun-every，结果 **128 pass / 6 skip / 9 fail / 1392 断言 / 728.40 秒**。该命令遗漏包脚本的 --timeout 30000，不得称整文件通过。权限继承和 pending Shell 取消两例按 30 秒复验分别通过（9 断言、9 断言）；运行中追加输入在 30 秒仍失败，不能统称所有失败都是机器慢。

三项历史测试仍用未装配 canonical SessionExecution 的 makeHttp fixture：运行中追加输入、简单回复、流中取消。现迁入已有 formalIntegration（包含旧 processor 抛错哨兵），不新增/恢复旧执行器；assistant 事实改查原 Core 存储，兼容返回仍验证第二次输入 parentID，且明确检查旧 assistant 写入为零。取消遵从正式接口的中断 Failure，而非旧接口的成功返回加 MessageAbortedError；等待 assistant 启动后取消，保留部分输出、持久中断错误、完成时间及零旧存储断言。中间误用 Core assistant.parentID 和等待未完成文本落库均使测试失败，已分别改用兼容返回关联和实际 assistant 就绪信号，不以新字段/固定睡眠掩盖差异。

最终三场景 **3 pass / 0 fail / 25 断言 / 18.72 秒**；随后仅格式整理。单文件 lint **30 warnings / 0 errors**，未清除历史告警。本批没有产品代码变更，没有再跑整份文件；首轮启动于修改之前，不代表改后整文件结果。

明确待查的四个失败：即时工具的快照命令审批缺失、text/plain 附件读中断、directory 附件读中断、unknown command 的具名错误断言。另有六个跳过，包括平台限定和旧 projector 场景，不按通过计。下一轮先处理上述实际失败，R05/R02/R28 继续开放；全平台 full sandbox 最后。未操作用户真实数据库、配置或外部 Provider。

并行诊断已复现 R06 的 prepare/stream body 漂移，见 [R06 请求准备漂移](./plan-v2-r06-prepare-drift-20260908.md)。修复该功能前仍须保留正式入口的失败清单；不能因扫描 fresh 或局部通过关闭阶段。

## 预留与结算采用一致的会话行锁顺序（2026-09-08）

实码核查此前仅锁单个 run 的事件序号，不足以表达 PostgreSQL 上不同 run 同属一会话时的预留互斥。原 Runner 新增局部 lockBillingSession，使用同一可信事务对既有 SessionTable 的目标行做 id=id，且显式 time_updated=time_updated，避免 Drizzle 的 onUpdate 默认值将取锁误写成用户活动。返回行数不是一行时拒绝。预留扫描/写入与正常/恢复结算都统一为 session 行 → 原 run 租约锁，继续由原 transactionAsPrincipal 提供主体作用域；未增加锁表、预算表或执行 owner。

原 pending-before-send 测试增加 TEMP trigger，专门观察 UPDATE OF id 且 id/time_updated 均不变的写入。实现前预留已落库但探针零行；实现后发送前一条、结算后两条，均为原 session ID。现有原用量行状态转换与请求数断言保留。此是锁定消费接线的前后对照，不声称在 SQLite 上复现了 PostgreSQL 不同 run 同时越过扫描的竞态。

专项发送前/发送后接管、历史断裂与预留 **4 pass / 28 断言 / 3.81 秒**。最终 billing/durable-run/SessionRunner/lease-process 四完整文件 **209 pass / 0 fail / 1220 断言 / 145.31 秒**；正式默认标题、缺 usage 标题、scheduled child **3 pass / 49 断言 / 21.49 秒**。Core/Arforge 类型、双文件格式与 diff-check 通过，lint **63 warnings / 0 errors**。各批重叠不累加。

边界：本批证明既有事务里的会话锁接线和时间戳保留，并保留原 SQLite run 锁跨进程回归；未新增两个完整 Runner 跨 run 同时预留或真实 PostgreSQL/RLS 压力证明。不同 run 仍各自核算预算，不因串行扫描变成共享预算。网络发送窗口、用户归属变更矩阵、锁顺序大规模压力和共享父子预算/证据事务继续待完成。R05/R17 不关闭，full sandbox 最后；未操作真实用户库、凭据或外部服务。

## 同库双进程租约事务互斥与提交/回滚（2026-09-08）

新增 test-only lease-transaction-worker 与两场景测试，两个独立 Bun 进程装配原 Database/EventV2/DurableRun，访问同一个临时 SQLite 文件。holder 创建原 run/lease，两个进程都完成初始化后由 IPC 放行。holder 用原 transactionAsPrincipal + validateLease(transaction) 持锁并发布 locked 信号；此时尚未写探针，避免用其他写入冒充租约锁生效。

contender 通过原 releaseLease 尝试接管，测试连接 busy_timeout=0，实际报 SQLite locked，原 EventV2 有界重试耗尽。此时完整 run snapshot 不变，独立连接读探针仍为空。holder 收到 commit/rollback 后才插入探针并结束事务；提交保留一行，回滚零行。holder 进程退出后，原 contender 再经 releaseLease/acquireLease 成功取得 replacement-owner，并看到对应探针状态。不是同进程 fiber 竞争，也不是不同数据库副本。

首批功能断言已通过，仅因 stdout 预期为空而失败：原服务会输出 Event commit conflict exhausted retries 警告。改为明确检查该预期日志、退出 0 和 stderr 为空，没有关闭日志或放宽租约规则。durable-run 与新进程测试两完整文件 **43 pass / 0 fail / 190 断言 / 9.67 秒**；清理新增 consistent-return 告警后跨进程专项 **2 pass / 14 断言 / 5.64 秒**。Core typecheck 再次通过，两个新增文件格式与 lint **0 warnings / 0 errors**，diff-check 通过。进程退出后才清理临时目录，IPC 使用明确就绪信号及有界进程超时，不用固定睡眠猜测就绪。

本批只有测试/证据修改，未重跑 Formal/整个 Runner，不沿用旧批作为本批新验证。证明 SQLite 上既有租约事务的跨进程互斥和释放，不是两个完整 Runner 预算授权竞争、PostgreSQL 行锁/RLS 或强杀事务恢复矩阵。跨 run 会话预留互斥、完整共享预算/证据事务、真实对账及用户恢复继续未完成。R05/R17 不关闭，full sandbox 最后；未操作真实用户数据、配置或凭据。

## 调用前预留进入原租约事务并核对持久预算历史（2026-09-08）

扩展原 root 接管 fixture，在模型解析就绪屏障期间替换 lease，再放行旧执行者。修复前用量表从空变成一条 reserved 记录，说明仅保护最终结算不足以阻止旧执行者预留。现 executeProviderStream 使用原 Database.transactionAsPrincipal：在原 run 序号行锁下验证本次 executionLease、扫描同会话同 principal 的未结算回执；严格 billing 时读取同 run/session/principal 既有用量行，通过原 makeRunScope/resumeReservation 核对持久历史与本次准备的预留状态连续，再写原 SessionRunUsageTable。无第二份账本或预算规则。

只有事务成功返回后才设置 pendingBillingReceipt；失败不伪造已落库事实。提交后、进入 makeProviderStream 前再次校验原 lease。发送前已被接管时零预留/零 Provider 请求；发送后接管仍保留原 pending、不结算，接管者完整 snapshot 不变。三场景专项 **3 pass / 20 断言 / 3.72 秒**。

新增两步实际 Runner 预算历史测试：第一步工具请求实际费用 1 落库，第二次模型解析暂停；仅将临时库该行 billing_receipt 置 null 后继续，Runner 拒绝第二请求，requests=1、observer=1，原测试修改行保持且无第二预留。此证明新的持久历史核对被消费，不只依赖旧内存预算。专项 **1 pass / 6 断言 / 1.98 秒**。

最终 billing/durable-run/SessionRunner 三完整文件 **207 pass / 0 fail / 1204 断言 / 140.59 秒**；正式默认标题、缺 usage 标题、scheduled child **3 pass / 49 断言 / 22.24 秒**。Core/Arforge typecheck、双文件格式和 diff-check 通过，lint **63 warnings / 0 errors**。各批重叠不累加。

边界：锁定单个 run，尚未证明不同 run 共用会话的 PostgreSQL 并发扫描互斥；同库跨进程争用也未验收。提交后复核到远程实际发送仍有窗口，不能把数据库事务说成网络 exactly-once；持久调用身份/真实对账仍需继续。全部祖先预算、价格精度政策、流式投影执行权和用户恢复体验未完成。R05/R17 保持开放，full sandbox 最后；未操作真实用户库、凭据或外部服务。

## 正常逐次结算与恢复共用强制租约事务校验（2026-09-08）

新增根任务接管测试先复现真实缺口：实际调用预留已落库、Provider 流在就绪屏障等待时，以原 DurableRun 换租约并写接管者检查点；释放旧流后，旧任务返回 Success，observer=1、成功计费统计=1。原恢复已有执行权保护，但正常 persistBillingSettlement 调用没有传 lease，这是同一结算入口的接线缺失。

现 ExecutionLease 沿原 runLoop → runTurn/runAfterOverflowCompaction → runTurnAttempt 显式传递，同模型重试闭包、模型 fallback 递归及压缩后继续保留本次身份。正常与恢复调用同一 persistBillingSettlement，其 executionLease 由可选改为必填，事务内 validateLease 不再有跳过分支。仍用原 DurableRun/事件历史/数据库事务，不建环境内第二份租约状态或新结算服务。checkpoint 的 child execution 仍保留其独立语义，没有把 root 伪装成 child。

修复后该专项 **1 pass / 6 断言 / 2.33 秒**：旧任务 Failure，observer/统计均零，原 pending 行完全不变，接管者完整 run snapshot 不变，请求数仍 1。最终 billing/durable-run/SessionRunner 三完整文件 **205 pass / 0 fail / 1192 断言 / 149.68 秒**；正式默认标题、缺 usage 标题、scheduled child **3 pass / 49 断言 / 23.83 秒**。Core/Arforge 类型、双文件格式与 diff-check 通过，lint **63 warnings / 0 errors**。各批重叠不累加。

边界：这是严格 billing 配置进入同一持久结算路径的保护，不是没有 billing 配置时全部费用与输出投影完成。尚无同库跨进程锁竞争/真实 PostgreSQL 证明；原调用前预留的原子授权、发送与流式投影的全部执行权窗口、共享父子预算/证据事务、真实账单与用户恢复体验仍待完成。R05/R17 保持开放，full sandbox 最后；未操作真实用户库、凭据或外部服务。

## 恢复结算复用原事务内租约校验（2026-09-08）

原 DurableRun.validateLease 增加可选的可信 Database.Transaction 入参；有入参时，对既有 EventSequenceTable 中本 run 行做 seq=seq 的无值变更写入，持有行锁后用同一传入句柄读取原事件序号和事件历史，再用原解码/租约身份/有效期规则校验。load 的历史解释仍只有一份；普通调用保持原独立读取事务。不增加租约表、复制投影或新 owner，也不把账务事实写入事件序号。

原 persistBillingSettlement 改用已有 Database.transactionAsPrincipal。恢复调用传本次 executionLease，在该事务内执行上述原租约校验，再以同一 transaction 更新原用量行 CAS；事务提交成功后才发布统计和 observer。普通逐次结算也使用原事务封装，但尚未统一传入 executionLease，因此本批只证明恢复分支的事务内执行权接线，不能扩张成所有模型调用和共享预算完成。

新增真实临时 SQLite 事务测试：TEMP trigger 观察 seq 不变的行写入，合法校验产生一条探针；错误 owner 校验及合法校验后调用方失败，事务内探针及调用方写入均回滚，完整 run snapshot 不变。初版 trigger 使用绑定变量被 SQLite 拒绝，修正测试 DDL 后通过，未修改数据库产品限制。专项 **1 pass / 7 断言 / 1.51 秒**。恢复接管/回执竞争/新进程专项 **3 pass / 85 断言 / 25.33 秒**。

最终 billing/durable-run/SessionRunner 三完整文件 **204 pass / 0 fail / 1186 断言 / 132.90 秒**；正式默认标题、缺 usage 标题、scheduled child **3 pass / 49 断言 / 22.48 秒**。workspace typecheck **22/22**（20 缓存，Core/Arforge 重跑）；新增测试后 Core 类型再次通过。清理新增 consistent-return 告警后事务/竞争专项 **3 pass / 35 断言 / 3.18 秒**；三文件 lint **51 warnings / 0 errors**。最后仅格式重排，最终格式及 diff-check 通过。各批重叠不累加；缓存不是全仓重新检查。

边界：SQLite 事务回滚与正式恢复接线已验证，尚无第二个真实进程竞争锁的证明，也没有真实 PostgreSQL/RLS 事务运行结果。锁定期间仅原 run 事件发布受序号行协调；不是父子/预算/证据所有 owner 的共享事务关闭证明。普通流式结算执行权、原子预算授权、到期边界、真实账单和用户恢复体验仍待完成。R05/R17 保持开放，full sandbox 最后；未操作真实用户库、凭据或外部服务。

## 恢复对账期间的租约接管与回执竞争（2026-09-08）

新增两个原 Runner 故障分支，用 Deferred 明确等到恢复对账回调开始后再修改测试状态。takeover 分支释放旧 lease、通过原 DurableRun 取得 replacement lease 并写新检查点；迟到用量放行后，旧恢复失败，完整 replacement snapshot 和 pending 用量行不变，Provider 请求仍只有最初一次，结算 observer 和成功统计均零。receipt-change 分支仅改临时库的原回执摘要；旧恢复的原行 CAS 拒绝 Pending billing reservation changed before settlement，保留修改后的完整行，不发送或发布结算成功。两个场景在加固前已通过，不能描述为新修复的已复现漏洞。

额外实码加固：恢复原先先 load 当前 run，再以当前 lease 构造 validateLease 入参，存在把后来接管者的身份当作自身授权的结构问题。runLoop 现显式接收本次 executionLease：root 使用外层本次 leaseID/workerID，borrowed child 使用既有 child execution；恢复查询前后都验证该固定元组，不从新 snapshot 接受替换身份。不新增 lease owner/恢复器/预算服务。此次未单独故障注入“进入恢复查询之前已经替换”的窗口；该窗口的改进依据是显式身份数据流，不能冒称已有独立竞态证明。

加固前两故障 **2 pass / 28 断言 / 2.75 秒**；加固后两故障与新进程恢复专项 **3 pass / 85 断言 / 25.78 秒**。最终 billing/SessionRunner **163 pass / 0 fail / 1010 断言 / 141.84 秒**；正式默认标题、缺 usage 标题、scheduled child **3 pass / 49 断言 / 23.99 秒**。Core/Arforge 类型、格式与 diff-check 通过，双文件 lint **63 warnings / 0 errors**；各批重叠不累加。

边界：同进程受控租约接管、真实临时 SQLite 回执竞争，不是跨进程同时竞争或 PostgreSQL 事务矩阵；lease 最后检查与 SQL 写入仍非同一原子事务。跨 owner 原子性、真实对账适配、用户恢复交互与完整故障矩阵继续待完成。R05/R17 不关闭，full sandbox 最后；未操作真实用户库、凭据或远程服务。

## 待对账记录的真实新进程恢复与再次冷启动（2026-09-08）

复用既有 billing-recovery-worker，新增 pending-available/missing/estimated/rejected/idle 分支。live Core Runner 在实际发送前置预留落库后取消，真实 5 秒对账超时留下 paused run 与 reserved 行；通过 VACUUM INTO 创建四个临时 SQLite 副本，不手填用量或 run 状态。每个副本启动独立 Bun 进程，按原 Core Runner/Database/Projector 服务恢复，无原 RunScope 或暂停 fiber。

四分支中实际用量按原价格结算 4，下一请求按新价格结算 6，连续预算为 10；核对原价格版本、新请求 before.settledMinor、原 run ID 与唯一新请求。缺用量、估算、查询拒绝均不发请求、原用量行完全不变、run 保持 paused；该进程退出后再启动新进程提供实际用量，仍恢复同一 run。每个成功副本再启动 idle worker，零对账、零 Provider 请求、用量表完全不变。四条路径共 11 次独立 worker 启动；原父测试进程仍存活，原数据库始终 paused 且只有原 pending 行。

专项 **1 pass / 57 断言 / 26.56 秒**。随后独立保留 lookupBindingValid，防止 fixture 的身份错配异常被产品归类为普通查询失败而误判负例通过，并清理新增不必要断言。最终 billing/SessionRunner 两完整文件 **161 pass / 0 fail / 982 断言 / 132.58 秒**；Core typecheck、双文件格式与 diff-check 通过。双文件 lint **40 warnings / 0 errors**，worker 单独 **0 warnings / 0 errors**。本批仅测试和证据修改，没有新产品 owner；未重跑 Formal，不将上批 Formal 结果当作本批新证据。

边界：受控模型流和对账回调不是真实 Provider 账单查询；源任务是受控取消暂停，不是杀掉原进程后自动接管。不同副本不证明同库双进程竞争；同库串行进程退出与再次恢复已验证。原 attempt 限制、跨 owner/lease 与结算原子性、价格精度变更、多用户权限和用户可操作恢复继续待完成。R05/R17 不关闭，full sandbox 后置；未操作真实用户库、凭据或远程服务。

## 待对账预留接回原 Runner 与同一结算写入（2026-09-08）

原 runLoop 先重建已结算预算，再校验并接回同一 run 的一条持久 pending 预留。恢复查询使用原 run/reservation/provider/model/request digest；只接受配置的对账回调返回 provider 来源用量，按原回执冻结费率结算，再允许后续模型发送。正常结算与恢复共用 persistBillingSettlement，对原用量行执行身份、未结算标记和回执 CAS，不新增账本、恢复服务或第二个执行器。

无回执、估算回执、查询拒绝或超时保持 pending；具名 ReconciliationPendingError 使原 run 保持 paused，不把暂时无法对账转成业务完成。恢复查询前后核验 lease，借用子任务再核验原 child execution。现有 attempt 上限仍适用，不是无限次重试。多个 pending 或损坏历史仍明确拒绝；未提供 billing policy 的既有错误路径没有整体重做。

受控 Runner 四个 timeout 恢复分支验证：无实际用量时不发送、不改原行并保持暂停；随后取得实际用量可恢复原 run。原价格结算为 4，即使未来请求价格改为两倍也不回溯重算；后续请求预算包含原费用。闲置唤醒不再对账或发送。完整 billing/SessionRunner **160 pass / 0 fail / 915 断言 / 109.31 秒**；正式入口默认标题、缺 usage 标题、scheduled child **3 pass / 0 fail / 49 断言 / 22.96 秒**，Core/Arforge 类型通过。

随后补强纯预算恢复断言：缺少前序历史、错误模型绑定、重复接回预留均拒绝且状态引用不变；合法恢复结算保留前序 15。首次因测试误用 RuntimeBilling 对象而非平面导出失败，修正测试导入，未更改产品接口。最终 billing **17 pass / 0 fail / 84 断言 / 291 毫秒**，Core 类型再次通过。四文件格式及 diff-check 通过；四文件 lint **64 warnings / 0 errors**，没有宣称历史告警清零。完整批次早于最后仅测试断言补充，各批重叠不累加。

边界：回调是本地受控替身，不是真实 Provider 账单适配；本批 pending 恢复不是新进程/强杀证明。lease 检查和用量写入尚非一个原子事务；Gateway/用量/共享预算跨 owner 一致性、归属变更、费用界面投影、恢复后的价格精度政策、用户可操作恢复和完整并发矩阵仍待完成。R05/R17 保持开放，full sandbox 最后；未操作真实用户库、凭据或外部模型服务。

## 取消请求等待逐次结算，超时保留待对账事实（2026-09-08）

新增 readiness gate 复现发送后取消：reconcileUsage=1，但 onSettlement=0、原行未结算。诊断还观察到已中断 fiber 的异步返回未按期望进入后续处理；仅插入诊断/收尾包装会改变结果，不能据此判定修复。最终将逐次结算收敛到 runProviderStream 的 onExit，使用继承当前服务/身份、由父收尾明确 join 的 Effect child fiber 执行原 settleProviderBilling；不 detach、不新建任务队列/预算 owner。重试与最终流程只消费本次已结算结果，不再次调用结算；结算失败不得继续重试或将缺结果当成功。未修改 Effect 依赖或声称定位并修复其通用实现。

原异步对账将结果显式接纳为 Exit，错误仍沿原具名估算策略；对账等待现在有 5 秒上限。超时保留 reserved 行并返回未解决状态，不释放/猜填实际费用。迟到的 Promise 结果不进入结算写入；这不证明底层远程 HTTP 请求已被物理取消。同步/异步成功均按对账用量落库；取消本身保持取消结果，不转成业务成功。

五场景覆盖同步 provider 回执、异步 gated 回执、无回执、拒绝、超时；async/timeout 验证对账完成前 cancellation 未返回。正常前两项一笔实际 4，缺失/拒绝明确 source=estimated 且等于原预留估算；TestClock 推进 6 秒验证 timeout 零结算通知、原行 reserved，迟到结果不改行。最后使用 Deferred 就绪信号替换轮询，再跑 **5 pass / 39 断言 / 0 fail / 4.41 秒**。

完整 billing/SessionRunner **157 pass / 0 fail / 839 断言 / 104.47 秒**（含八个预算恢复分支）；正式默认标题、缺 usage 标题、严格 scheduled child **3 pass / 49 断言 / 20.49 秒**。双包类型通过，最后测试就绪清理后 Core 类型再次通过，双文件格式/diff-check 通过，lint **62 warnings / 0 errors**。完整批早于最后仅测试同步方式清理，不是全仓或真实账单验收。临时诊断输出已移除。

剩余：超时/强杀后持久 pending 的自动对账、真实 Provider 适配、共享事务与原子预算、Gateway 回执与用量提交的跨 owner 故障一致性、失败费用界面投影及多用户/新进程全部中断窗口。R05/R17 不关闭，严格标题限制保持，full sandbox 最后；无真实用户库、凭据、外部服务操作。

## 已结算预算的真实新进程恢复验证（2026-09-08）

扩展原暂停预算场景为 live 测试：同进程四分支及 fresh-process 四分支共用相同前置。Provider 返回明确 usage、原结算已落库后，在工具等待时暂停原 run；用 VACUUM INTO 创建临时 SQLite 一致副本，再启动独立 Bun worker 装配原 Core Runner/Projector/Database。新进程不共享原 RunScope、统计或暂停 fiber；不手填预算、checkpoint 或 settlement。原测试数据库保持暂停且用量行不变，副本随 fixture 清理。

新 worker 在余额足够时只发送一次受控 LLM 请求，新回执 before.settledMinor=1、结算后=4，原回执行未变，仍同一个 run。余额不足、未提供 billing policy、改变上限三分支分别拒绝且 providerCalls=0，无第二用量行/第二 run。模型解析和流为本地受控替身、Snapshot 使用原 noopLayer，Config 使用隔离空文档，不读取真实用户凭据或外发模型请求。本批新增 fixture worker，不新增产品服务/恢复器。

初次执行失败来自新增测试的语法错误及 worker 未将 Database.node 暴露给顶层测试读取；均修正测试装配，没有借此宣称产品 bug 修复。八场景 **8 pass / 0 fail / 70 断言 / 12.47 秒**；最终 SessionRunner 完整文件 **135 pass / 0 fail / 726 断言 / 101.55 秒**，Core typecheck 与双文件格式/diff-check 通过。双文件 lint **40 warnings / 0 errors**，新 worker 单独零告警；不是生产四文件历史告警清零。依赖库存已刷新为 7269 files / 7457 leaves / 6 assets，计数不是完成率。

这是从已暂停快照启动新进程，不是杀掉原 worker 后原服务自动接管，也不是相同数据库上的双进程竞争/真实 Provider 账单验证；原父测试进程仍存活，不能称作旧进程已退出。待结算请求的恢复对账、原子预算授权、重复冷启动及真实 PostgreSQL 等继续未完成。R05/R17 保持开放，full sandbox 最后；未操作真实用户数据、配置或凭据。

## 恢复原 run 的已结算预算，不重新开空额度（2026-09-08）

实码确认两处恢复装配均重新 makeRunScope，原 factory 总是 openBudget。新增三笔含零费用的持久回执测试先复现 settledMinor 预期 15、实际 0。现同一 factory 接受原用量行，沿 RuntimeBilling.decodeReceipt 验证身份和价格，再按单线 Runner 的预算状态关系重建：每笔 before 必须等于前态 reserve 后的状态，结算后态使用已验证回执。排序使用累计费用和零费用优先，不用墙钟时间；缺行造成的状态断链、重复 reservation、错误 run/行绑定、缺版本回执、币种/预算上限改变及历史货币精度改变拒绝。不是直接 sum 统计值，也不新增账本。

原 runLoop 在任何模型工作之前读取同 run/session/principal 的既有用量行并恢复同一 RunScope；root 与借用 child 共用。已有严格回执却不传 billing 配置时拒绝，不悄悄变为普通无限额调用；待结算行保持要求对账，不猜填费用。新 run 无历史时保持原初始化行为。

真实隔离 Core Runner 四分支：Provider 返回明确 usage 后，在工具等待阶段暂停，清空 RuntimeInsight，再进入同一 durable run。余额充足时第二次请求正常完成，新回执 before 保留旧费用且旧行不变；余额不足、缺配置、改变上限时拒绝，requests=1、旧用量行不变、未分配第二个 run。初版测试在发送中断时遇到 amount=null，确认尚有未结算中断边界，改为本批实际针对的“已结算后暂停”，不把未结算当已修复。另一次样例费用触发外层 DurableRun 额度，夹具改用 minorUnit=6 以隔离本批严格预算检查；未放宽产品预算。

完整 billing/SessionRunner **148 pass / 0 fail / 764 断言 / 98.42 秒**；正式默认标题、缺 usage 标题、严格 scheduled child **3 pass / 49 断言 / 0 fail / 22.52 秒**。清理新增不必要断言和 return 告警后再跑五专项 **5 pass / 42 断言 / 4.20 秒**；Core/Arforge typecheck 通过，最终四文件格式/diff-check 通过，lint **63 warnings / 0 errors**。完整批次早于最后仅 lint 清理，专项为清理后的新证据；不是全仓验收。

剩余：真实新进程恢复、未结算请求的 Provider 对账与自动恢复、跨进程原子授权、完整历史存在性/归属变更证明、恢复后新价格精度政策、用户可操作的恢复反馈。状态链校验不证明零费用遗漏或整套一致篡改不存在，不是签名或完整审计日志验证。R05/R17 开放，full sandbox 最后；未操作真实用户库/凭据。

## 待结算回执读取校验接入续跑入口（2026-09-08）

在原 RuntimeBilling 补 decodeReservationReceipt，写入端复用同一校验，避免读写两套规则。解码验证版本/摘要格式、冻结费率完整性、估算与预留金额一致、预算/价格币种一致、预留存在及全部 active IDs 无重复；另核对数据库行的 run/reservation/provider/model 绑定。原 Runner 同租户/用户未结算扫描现读取该行并先校验，再明确要求对账，不因校验通过放行或自动释放预算。未新建恢复器、账本或数据库。

新增测试先因 decode 出口不存在失败，后覆盖 JSON 日期/状态往返、四种绑定错配、坏预算/价格/版本/摘要。真实临时 SQLite 结算失败场景在普通/严格续跑保护后，移除测试触发器并仅篡改测试行 receipt.runID；原 Runner 拒绝 storage identity mismatch，requests 仍为 1，成功计费统计仍零。专项 **4 pass / 47 断言**；最终 billing/SessionRunner 两完整文件 **143 pass / 0 fail / 722 断言 / 76.54 秒**。Core typecheck、四文件格式/diff-check 通过；lint **63 warnings / 0 errors**。本批没有重跑 Formal 或真实 PostgreSQL，不沿用旧批次作为本批新验证。

这是持久回执的读取前置，不是新进程恢复验收；尚无真实账单对账、跨记录预算重建、原子授权或自动解锁。租户/用户归属沿用原查询边界，未宣称覆盖归属变更矩阵；JSON 内部一致性不是签名防篡改。R05/R17 开放，full sandbox 最后，无真实用户数据/凭据操作。

## 调用前预留落库与结算失败保护（2026-09-08）

严格 Runner 现于原发送边界验证后，在既有 SessionRunUsageTable 写入 version=1、phase=reserved 的价格/预算预留回执，再调用 Provider。结算使用原行 ID、run/session/principal、未结算标志和原 JSON 回执作条件更新；仅更新一行成功后通知统计和 onSettlement，不新增账本或执行器。预留行金额保持 null，不冒充实际收费。任一同会话、同 principal 未结算回执阻止后续发送，包括调用者不再传 billing 配置的路径。

新增 readiness gate 测试观察请求进行时已存在预留，完成后仍是同一行且无活跃预留。原 INSERT 故障测试曾因期待旧行为 requests=1 失败；现在确认预留失败 requests=0，更新此断言。新增真实临时 SQLite UPDATE 拒绝触发器：已发送一次、结算写失败时不重试、不报告结算成功、保留 reserved 原行；同进程随后分别以普通/严格配置继续均拒绝，原行不变。三专项 3 pass / 29 断言；最终 billing/SessionRunner/database-migration 三完整文件 **161 pass / 0 fail / 763 断言 / 79.09 秒**。

正式入口三个场景分别运行：默认标题 1 pass / 14 断言 / 8.64 秒；缺 usage 标题 1 pass / 16 断言 / 7.86 秒；严格计费 scheduled child 1 pass / 19 断言 / 10.47 秒。不是整份 Formal 全量。Core/Arforge typecheck、三文件格式和 diff-check 通过；lint **63 warnings / 0 errors**，未清零。三份生成库存已刷新，库存有效不等于能力验收。

边界：预留扫描与 INSERT 尚非跨进程原子预算授权，RunScope 仍为进程内状态；保留未结算记录并拒绝续发不是自动对账恢复。实际发送前后崩溃区分、冷恢复消费、跨记录预算重建、多用户变更/并发事务矩阵、CAS 被竞争修改及真实 PostgreSQL 仍待验证。严格标题继续安全跳过，不将这一切片当作 R05/R17 完成；真实 full sandbox 最后。未操作真实用户数据库、配置或凭据。

## 原用量表保存版本化价格与预算回执（2026-09-08）

核查确认既有用量行只有价格版本号/金额，不能还原原费率与预留结算状态。现在原 SessionRunUsageTable 增加可空 billing_receipt JSON 字段；严格结算的同一次 INSERT 保存 version=1、run/provider/model、原请求摘要、完整冻结 PriceCatalog（含单位、精度、生效日期）、reservation、estimatedUsage、结算前 BudgetState 及实际 usage/charge/settlement。未新建账本、数据库、队列或执行器，不保存请求正文/凭据。

编解码位于原 RuntimeBilling，读取时用保存的费率重新校验估算预留、实际 charge，以及原 settle 函数计算的预算变换；不一致、重复 active reservation、未知版本拒绝。JSON 往返保留 DateTime 值；此为内部一致性检查，不是签名或对协同修改全部字段的防篡改认证，也尚未校验整条跨记录预算历史。

改动前执行 migration --check 无漂移。通过原生成器产生 SQLite 迁移 20260908114322_runtime_billing_receipt，并同步 snapshot/registry/full schema；另添加同名 PostgreSQL ALTER TABLE 和更新生成注册表。SQLite 实测旧表含旧行时升级，旧行数据保持、receipt=null，重复 applyOnly 不重复加列；未向旧记录猜填价格或预算。PostgreSQL 仅生成/类型验证，没有操作真实数据库或宣称真实迁移通过。

新增编解码测试先因缺出口失败，实现后验证日期/状态往返、金额或费率不一致拒绝。原失败对账正式 Core 测试从数据库解码回执，核对 run/模型、价格版本、结算前后状态和请求摘要；清空统计后数据保留，不把它当新进程恢复。专项 **3 pass / 0 fail / 20 断言**；最终 billing/database-migration/SessionRunner 三完整文件 **159 pass / 0 fail / 740 断言 / 78.55 秒**，正式受影响三场景 **3 pass / 49 断言 / 0 fail / 18.84 秒**。Core/Arforge typecheck、SQLite migration --check、格式/diff-check 通过，六文件 lint **65 warnings / 0 errors**，未清零。

仍待：调用前持久预留与事务协调、未结算调用识别/对账、跨记录和外部身份绑定、冷恢复读取接线、失败费用展示及真实 PostgreSQL 验证。本批仅补已结算调用的原始事实，不是恢复功能完成或预算授权来源切换。严格标题维护继续安全跳过，R05/R17 不关闭，full sandbox 最后；无真实用户数据/凭据操作。

## 严格计费回执等待原用量表落库（2026-09-08）

实测失败调用虽已返回对账费用，Core fixture 的 session_run_usage 仍为零行。原因是严格结算只调用 RuntimeInsight.recordBilling，默认无适配器或 best-effort 适配器不能保证返回前落库。现严格 Runner 在原结算路径等待既有 SessionRunUsageTable 写入成功，使用当前 Database principal 的 tenant/user 字段；成功后才更新内存统计及调用 onSettlement，之后才能继续重试。原字段映射提取为 billingStorageValues，旧适配器和严格写入共用，不新增表、数据库或费用 owner。

RuntimeInsight.recordBilling 新增仅用于已落库调用的 persist:false；统计与指标仍保留，但不再交给旧适配器重复插入。默认调用保持原 best-effort 行为，未宣称所有统计写入都已改成可靠账本。

新增失败对账测试先复现预期一行、实际零行；修复后验证 USD 6 minor units、原 provider 用量已存储，清空内存统计后行不变。真实临时 SQLite BEFORE INSERT 拒绝触发器验证落库失败时：run 失败、Provider requests=1、不发送重试、onSettlement=0、不伪造内存成功回执，表中零行。触发器随夹具移除，没有操作用户库。统计专项验证已持久回执不调用适配器，普通回执仍调用一次。

专项 **3 pass / 0 fail / 16 断言 / 2.42 秒**；最终 Core billing/SessionRunner/RuntimeInsight 三完整文件 **151 pass / 0 fail / 707 断言 / 79.92 秒**。正式受影响切片 **3 pass / 0 fail / 49 断言 / 18.61 秒**；Core/Arforge typecheck 退出 0，五文件格式/diff-check 通过，lint **67 warnings / 0 errors**，未清零。专项和完整批次重叠，不累计。

边界：本批只有结算回执可靠写入，不是调用前持久预算授权。预算仍在 RunScope 内存，记录还不含完整冻结价格和预算状态；崩溃窗口、原子预留/结算、冷恢复消费、失败会话费用投影、租户隔离全矩阵及全部取消场景仍须继续验证。清空统计不等于新进程恢复。严格标题维护继续安全跳过，R05/R17 不关闭，真实 full sandbox 最后；未操作真实用户数据或凭据。

## 模型回退费用与缺用量回执的区分（2026-09-08）

继续实际核验失败调用的计费链。新增 fallback 回归先复现：两笔费用虽已进入原 RunScope，最终会话 cost 仅包含 fallback 尝试，缺少原失败调用的 0.02。预算耗尽后阻止 fallback 发送的分支原本已通过，不将它计为新修复。现仅在原 runTurnAttempt 的内部 fallback 递归中传递已结算费用，最终同一 Step.Ended 投影合并；逐笔 onSettlement 不重复记账，不新增会话写入口或账本。

同时复现严格计费的无 usage 成功响应被当成 provider 来源零用量。原 publisher 将缺回执归一为全零 tokens，丢失是否报告的信息。现同一 stepSettlement 保留可选原 usage，最终 finish 回执只补齐缺失的 step 回执；已有明确零值不被覆盖。严格计费消费者仅在确有回执时采用 provider 用量，否则沿原 prepareCall 的具名估算和冻结价格结算，source=estimated，保留既定输出额度，不将短回答或缺失值伪装成实测零费用。

专项 **8 pass / 0 fail / 63 断言 / 3.70 秒**，覆盖 step/final 两种回执位置、明确零、无回执、同模型重试/跨模型回退及余额耗尽；成功分支两笔独立预留，估算来源明确、会话总费用与结算总额一致。最终 Core billing/SessionRunner/tool-events 三完整文件 **149 pass / 0 fail / 690 断言 / 78.05 秒**。正式受影响切片 **3 pass / 0 fail / 49 断言 / 19.01 秒**，不是 Formal 全量；Core/Arforge typecheck 退出 0，四文件格式/diff-check 通过，lint **80 warnings / 0 errors**，未清零。

边界：缺回执估算不是真实账单对账，非严格会话统计和客户端来源展示尚未全面验收；全部失败/取消、压缩后继续及跨进程的费用投影仍待处理，内部费用传递不是持久预留。RunScope 仍进程内，严格标题维护仍安全跳过。R05/R17 不关闭，真实三平台 full sandbox 最后；未操作真实用户库、配置或凭据。

## 严格计费传输重试逐次预留与结算（2026-09-08）

在检查维护预算前置时发现主 Runner 的真实计费缺口：prepareCall 位于传输重试循环之外，失败后直接再次 runProviderStream，最终只对最后结果结算；失败后重试成功时 reconcileUsage 根本不调用。新增余额充足/首次失败耗尽预算两场景均先失败（预期一次对账，实际零次）。这不是持久预算完成证明，而是必须先修的现存漏计。

现将原结算代码提取为同一 Runner 内的 settleProviderBilling，不新建账本或另一个结算器。决定重试时先对失败调用执行原 reconcileUsage/估算和 settleCall，再经原 prepareCall 为下一次发送生成独立预留；新预留不足直接失败，不构建下一条 Provider stream。成功重试后的 Step.Ended.cost 包含此前失败尝试费用，onSettlement 与统计仍逐笔写入，不只显示最后一笔。原严格标题维护跳过仍保留。

专项四场景 **4 pass / 0 fail / 28 断言 / 3.25 秒**，其中新增两场景证明：余额足够两次请求、两次不同 reservation 结算、第一笔结算观察发生于第二次发送之前、累计余额和会话费用一致；首次失败占满额度时 requests=1、只有一次结算、无活跃预留。既有无计费重试和失败对账保留。最终 SessionRunner 完整文件 **121 pass / 0 fail / 583 断言 / 79.37 秒**；billing 完整文件另跑 **14 pass / 45 断言 / 0 fail**。首次扩大命令误写 runtime-billing.test.ts，只匹配 Runner，发现后以实际 billing.test.ts 补跑，未把不存在路径计入覆盖。

正式入口受影响切片 **3 pass / 0 fail / 49 断言 / 18.87 秒**，涵盖 scheduled child 严格计费、默认标题及缺回执降级；不是全量 Formal。Core/Arforge typecheck 退出 0；两文件格式与 diff-check 通过，lint **62 warnings / 0 errors**，未清零。上述专项与完整文件重叠，不累计。

剩余边界：RunScope 仍为进程内预算，RuntimeInsight 的异步写入仍非授权事实；持久预留、崩溃窗口、失败后 fallback 的全链费用投影和全部对账故障仍未完成。不能用本修复开放严格标题预算或关闭 R05/R17。全平台 full sandbox 最后，无真实用户数据或凭据操作。

## 自动标题选模接入既有 TS Catalog（2026-09-08）

核查发现 TS Catalog.model.small 已有候选与成本/时间评分策略，不需要复制旧 Provider 的家族排序。现原 SessionRunnerModel 增加可选 resolveSmall：查询同 Provider 的原 small 候选，再核验 available、支持的协议及全部所需输入类型；不可用/不支持则返回 undefined，标题沿原主模型解析。选中时调用原 resolveCandidate，继续受 CredentialScope 与 Integration 凭据解析限制；不继承主模型专属 variant。显式 title.model（含前批迁入的 small_model）仍优先，不走自动候选。

标题 Runner 接线只增加上述查询，原 Action、请求冻结、发送与结算不变。文本加附件 MIME 作为所需输入；选中候选不支持图片时保留原主模型，未悄悄删除图片或转成猜测文本。没有新增 Provider 服务、排名器、状态 owner 或凭据 fallback。

新增真实 SessionRunnerModel 层测试在实现前以“Small model resolution is not connected”失败。实现后验证受限凭据、空凭据拒绝、图片能力不足返回空、主模型未知 variant 不误带入、候选离开 available 后不采用。测试 Catalog/Integration 为受控替身；原 Catalog 独立完整测试另行覆盖。正式 prompt 夹具的模型解析本来就是本地替身，本批扩充其 resolveSmall seam，并验证自动返回模型进入实际 HTTP 请求、显式和迁移配置优先、禁用不调用、图片回到主模型；不能把此夹具说成真实远程 Catalog/账号的端到端联调。

最终 Core Catalog/SessionRunnerModel/SessionRunner 三完整文件 **149 pass / 0 fail / 618 断言 / 73.48 秒**，Core typecheck 退出 0。正式标题筛选批 **23 pass / 0 fail / 208 断言 / 96.06 秒**（120 filtered）；四文件格式/diff-check 通过，lint **57 warnings / 0 errors**，未清零。前批五场景和单文件结果重叠，不累计。

边界：以 TS 既有评分为标准，不宣称与旧 Provider 的家族顺序、Bedrock 地域选择或 experimental.provider.small_model hook 完全等价；缺失显式小模型的回退、全部 MIME/平台、真实账号选择以及小输出额度模型仍需后续验证。维护预算、未结算恢复和旧无调用标题函数退役仍未完成；R05 开放，full sandbox 最后。无真实用户配置、凭据或数据库操作。

## 纯图片标题融入原消息转换管线（2026-09-08）

实码确认 scheduleTitle 只读取 first.text，空文本即返回；TitleGeneration.prepare 也只接受文本。现保留原文本调用合同，同时接受 canonical Message.content；正式 Runner 使用已有 toLLMMessages([first], model)，将首条用户的已接入附件与文本一起冻结到原 RequestEnvelope。没有新附件解析器、下载器、Provider 或状态 owner，仍由同一 Action 在发送前记录请求。纯空内容仍拒绝，严格预算分支不放宽。

新增媒体请求测试在实现前失败，实现后验证 user role、媒体内容、摘要重建和实际协议 prepare 的 body 保留 URI。正式 prompt 使用有效的 1×1 PNG，仅附件无用户文本；主回答后生成一个标题 Action，标题请求含原图片 URI，重复 wake 后请求数和完整 Action 历史不变。首次图片夹具无法解码，改用仓库现有 Photon 库生成有效 PNG；未修改或放宽产品图片解码检查，该失败不计为产品缺陷修复。

最终 Core title-generation/SessionRunner 两完整文件 **138 pass / 0 fail / 617 断言 / 76.22 秒**，Core typecheck 退出 0。正式标题筛选批 **22 pass / 0 fail / 201 断言 / 91.92 秒**（120 filtered），包括图片、文本附件、子任务首轮、配置、缺回执、改名、取消和新进程恢复。前面的三输入专项 3 pass / 32 断言与此重叠，不累计。四文件格式通过，lint **52 warnings / 0 errors**，未清零。

范围：本地受控 Provider 证明图片传输接线，不证明真实模型识图质量、音视频/其他媒体格式、选定小模型不支持视觉时的策略或全部客户端体验。自动小模型、维护预算、未结算请求恢复和旧无调用标题函数退役仍未完成；R05 保持开放，full sandbox 最后。未操作真实用户库、配置或凭据。下方“纯多模态未接通”仅图片输入子范围由本批更新。

## 子任务命令与纯文本附件的首轮标题验收（2026-09-08）

新增两个正式入口用户旅程，未修改产品实现。subtask-only 通过公开 command 执行 review：子任务、父回答、父标题总计三次模型请求；父标题请求使用原命令任务文本而非子任务回答，只有一个父标题 Action/一次 attempt。子会话保持原 TaskRuntime 的“描述 (@general subagent)”名称，无标题 Action。重复 wake 后完整父 Action/run 快照不变。首次对子会话的“默认标题”断言失败，检查实际命名代码后纠正为原描述名称；这是测试假设错误，不算产品修复。

text-attachment-only 通过公开 prompt 仅提交 text/plain data attachment，无额外用户文本；标题请求包含原已接入 Core 的文本，不传 base64 文本媒体 URI，主回答和标题两次请求、一个标题 Action，重复 wake 不增加调用或 Action 历史。未重新读取外部文件、未开第二附件处理链。

最终两场景 **2 pass / 0 fail / 23 断言 / 14.54 秒**（139 filtered）；Arforge typecheck 退出 0，测试文件格式通过，lint **30 warnings / 0 errors**，未清零。此前子任务单项另有 1 pass / 14 断言，与合并测试重叠，不累计。

本批补齐这两类输入的正式证据，不证明纯图像/音频/视频、所有附件权限、自动小模型策略或完整 UI 验收。旧无调用标题函数继续保留为待对照范围，严格维护预算和未结算恢复未完成，R05 不关闭，full sandbox 最后；测试仅使用隔离工作区/数据库与本地受控 Provider，无真实用户数据操作。

## 旧 small_model 标题配置融入 TS Agent 配置（2026-09-08）

检查旧 ensureTitle 的退役条件发现：它仍无调用，但曾消费 Provider.getSmallModel，而 Core 的 V1 配置迁移虽然识别 small_model，却没有将其传给标题 Agent。新增迁移回归先失败（model 为 undefined）。现 ConfigMigrateV1 在同一个迁移函数中将旧 small_model 归一到既有 agents.title.model；同一文档内显式 title.model 优先，prompt/disable 等字段保留，无 small_model/agent 时继续返回原空配置结果。没有新增标题选模服务或第二配置 owner。

正式入口实际测试 Provider 验证：只指定 small_model 使用 small-title-model，显式 title.model 使用 title-model，禁用时不调用标题模型；主模型和标题提示词原有断言保持。Core Config/ConfigAgent 两完整文件 **23 pass / 0 fail / 109 断言 / 1.74 秒**（含 100 次任意 V1 配置迁移属性检查）；Formal 三场景 **3 pass / 0 fail / 15 断言 / 14.63 秒**；Core/Arforge typecheck 退出 0，格式通过，三文件 lint **31 warnings / 0 errors**，未清零。

这是以 TS 配置为标准的归一：迁移后跨文档继续沿现有文档优先级合并，同文档显式值优先不代表“任意低优先级文档的旧显式值永远压过高优先级文档”。尚未验收所有混合新旧文件优先级、旧 Provider 自动小模型家族排序/插件 hook、缺失小模型的回退和纯多模态输入标题，因此本批未删除旧无调用标题函数，避免用删除隐藏能力差异。small_model 的其他历史消费者也不因此宣称迁移完成。维护预算、未结算恢复继续待做，R05 不关闭，full sandbox 最后；无真实用户配置、凭据、数据库或外部 Provider 操作。

## 维护预算前置：金额乘除的确定性精度（2026-09-08）

核查持久预算边界确认 RuntimeInsight.recordBilling 仍为异步 best-effort adapter 写入，不能作为调用前预算授权事实；本批没有将它包装成可靠账本。另实际复现 RuntimeBilling.charge 的浮点中间值错误：合法 safe-integer tokens=9007199254740991、费率=999999/1m tokens 时，应为 9007190247541737 minor units，原实现算成 9007190247541736。原 Schema 对输入/结果安全整数的检查不能阻止这种“中间乘法丢精度、最终结果仍合法”的漏算。

现只将原 charge 的中间乘除、逐维向上取整与累加改为 bigint，返回前转回既有 Billing.Charge 安全整数合同，不改变 JSON/数据库表示，不新建账本。新增预算差一个最小单位的 prepareCall 用例确认 BudgetExceeded、scope 对象和预留列表均不变；最终费用超安全范围仍由既有 Schema 拒绝。初始额外非法预算测试被 Schema 提前拒绝，不是新增产品缺陷，已纠正测试范围，不计作新修复。

最终完整 billing 文件与 Runner 计费专项 **18 pass / 0 fail / 63 断言 / 3.72 秒**（115 filtered，未声称 Runner 全量）；Core typecheck 退出 0，格式通过，两文件 lint **1 warning / 0 errors**，未清零。本批修复预算算术确定性，不等于持久预留/结算接线完成。后续仍须把货币绑定、原始价格版本、预留及结算事实接入原 durable owner 的事务，不能依赖 telemetry 的异步成功。R05/R17 不关闭，full sandbox 最后；无真实用户库、凭据或外部 Provider 操作。

## 普通标题缺用量回执的显式估算降级（2026-09-08）

原正式标题即使完整返回有效文本，只要 Provider 未给 usage 就被 Gateway blocked。现仅对普通非严格计费会话的完整、有效成功结果，复用 RuntimeBilling.estimateCallUsage：以原冻结请求正文及原输出额度 256 tokens 生成命名估算（arforge:chars-per-token-v1），并在既有 TitleReceipt 中保存 Billing.TokenUsage，source 明确为 estimated；有回执时记录 provider 来源，优先使用回执。原 Gateway Token 回调消费同一估算总量；没有改 Gateway 的未知用量保护，也没有新账本/事件/执行器。

这是按原输出额度保守估算，不是将短标题字数伪装为实测输出，也不表示真实账单已核对。费用仍没有可信回执，ActionAttemptFinished 不写 costMicros，不制造零费用。空响应、失败或中断没有有效成功结果时不会使用这一成功降级；缺回执的空响应仍 blocked、无成功 Observation。严格 billing 分支仍跳过未预留的标题维护，未放宽货币额度。旧 TitleReceipt 无 usage 字段可读，不补造来源；新版实际写入均保存来源。

更新预期后缺回执专项先失败（后台 error 而非 completed），接入后通过。正式首轮、配置、空响应、有/无回执、改名/取消及新进程恢复 **13 pass / 0 fail / 124 断言 / 64.73 秒**；验证估算来源/输出额度、Token 持久事件仅一次、费用字段缺失、重复 wake Action 快照不变，新进程恢复估算标题不调用模型且不重复计量。Core billing/SessionRunner 两完整文件 **130 pass / 0 fail / 605 断言 / 75.38 秒**；workspace 类型 **22/22 successful、20 cached、35.609 秒**，格式通过，两文件 lint **52 warnings / 0 errors**，未清零。

此项补齐普通成功标题的无回执行为，不证明所有 Provider 的估算精度、失败请求外部对账、估算标识的客户端展示或严格维护预算。持久预算分配、未结算 Action 的发送中恢复和完整用户体验仍待做，R05/R17 不关闭，full sandbox 最后。以下“缺 usage 一律 blocked”记录为历史，本批仅替代普通有效成功结果的子范围；无真实用户数据/凭据/外部 Provider 操作。

## 标题历史查询收窄到所需事件（2026-09-08）

上一批改名保护读取完整会话历史，包含不需要的消息/工具事件正文。现扩展既有 EventV2.readSerialized 的可选 types 条件，在 SQL 层按精确持久事件类型（含版本）筛选；省略保持既有行为，空数组返回空集，非法空类型拒绝，重复类型去重。SessionProjector 仅查询 Created/Updated/TitleGenerated 三类事件，仍在原事件事务中执行，保留完整相关历史和原聚合/序列顺序，不用截断最近 N 条的方式丢失用户早期改名。

新增筛选断言在实现前失败；实现后 Core EventV2/SessionProjector 两完整文件 **59 pass / 0 fail / 128 断言 / 3.41 秒**。测试同一聚合中的混合事件、不同版本、无匹配、空集合和多聚合隔离。正式新进程恢复、普通 touch、跨进程改名保护和生成中改名保护 **4 pass / 0 fail / 40 断言 / 25.67 秒**；Core typecheck 退出 0，三文件格式通过，lint **25 warnings / 0 errors**（本批文件范围不同，不代表整仓告警下降）。

本批证明查询语义和恢复保护未退化，不是大规模性能压测。相关 metadata 历史仍随会话增长，尚无分页/增量检查点的成本证明；未宣称所有查询均有界或旧历史全部完备。维护预算、缺回执、未结算 Action 冷恢复及完整用户验收继续待做，R05/R17 不关闭，三平台 full sandbox 最后；没有操作真实用户数据/凭据/外部 Provider。

## 用户改名后改回默认值的覆盖保护（2026-09-08）

新增正式 Provider 屏障回归复现真实缺陷：生成期间 setTitle 改为自定义值，再改回原默认值，原标题结果覆盖用户最终选择（初次单项失败）。现 SessionProjector 在原 TitleGenerated 事务中通过 EventV2.readSerialized 重建已有 Created/Updated/TitleGenerated 标题变化；发现 Updated 的标题与前序状态不同即拒绝自动覆盖。将既有生成事件纳入重建，避免将生成后的普通 touch/full-info 更新误当成手动改名。没有新数据库、状态服务、事件类型或并行执行器。

初次实现漏用持久事件的版本后缀，正式七场景仍为 6 pass / 1 fail；改用 EventV2.versionedType 后通过。类型检查随后指出 durable 可选，现装配时明确校验定义的持久属性再捕获版本，不用非空断言压过错误。正式首轮/恢复/改名取消最终 **12 pass / 0 fail / 103 断言 / 59.48 秒**；最终类型修正后新进程改回默认值与生成中改回默认值再次 **2 pass / 19 断言**（重叠不累计）。Core projector 全文件 **12 pass / 38 断言**；workspace 类型 **22/22 successful、20 cached、38.333 秒**，格式通过；两文件 lint **43 warnings / 0 errors**，未清零。

额外验证：普通 touch 后丢失投影仍可恢复；已结算后用户改名再改回默认值，进程内及独立 Bun worker 都保持用户选择，模型解析/请求为 0，Action/run 历史不增加。独立进程仍使用隔离 SQLite 一致性副本，不是发送中强杀。当前重建读取完整会话事件，长历史查询成本尚未压测；旧缺历史记录、用户显式设置同一个值而没有可见变化、所有写入入口及跨进程事务竞争仍不能据此宣称覆盖。维护预算和缺 usage 仍未完成，R05/R17 不关闭，full sandbox 最后，无真实用户库/凭据/外部 Provider 操作。

## 已结算标题的新进程恢复（2026-09-08）

正式首轮生成后，测试在原隔离数据库中模拟标题投影丢失，用 SQLite VACUUM INTO 生成一致性临时副本，再启动独立 Bun worker。worker 重新装配原 Core Runner、SessionProjector、DurableAction/Run 与 SessionStore，启用 fixture title Agent，不携带父进程后台 registry 或缓存结果。模型 resolver 和 Provider stream 使用调用即失败的哨兵；两次非 force run 后，标题正确、模型解析与请求均为 0，完整 Action/run 快照不变。父进程原数据库仍保持丢失投影，证明恢复只发生在副本，随后原进程恢复也通过。

首轮两次失败分别来自测试未提供 Location 服务、原 fixture 是内存 SQLite；已改用会话 projectID 和 SQLite 一致性导出，未改产品实现或放宽断言。worker 初次类型检查缺根节点暴露依赖，已明确列入原节点，未使用类型抑制。最终四场景 **4 pass / 0 fail / 37 断言 / 24.08 秒**（128 filtered）；新进程单项独立跑另有 1 pass / 13 断言，与四场景重叠不累计。Arforge typecheck 退出 0，格式通过，worker lint 0 warnings/0 errors；原 prompt 测试文件 30 warnings/0 errors，未清零。

此为真实新进程重放已结算结果，但投影丢失仍是故障注入；没有声称发送中强杀、未结算 Action 的租约接管、自动启动扫描或所有跨进程交错已经验收。维护预算核查确认现有 currency-bound RunScope 仍进程内，child 预算接口只绑定 child run，不能直接作为标题 Action 分配；严格预算跳过标题的保护继续保留。持久维护预算、缺回执策略、原默认标题 ABA 与压缩后恢复仍待处理，R05/R17 不关闭，full sandbox 最后。本批无生产代码修改，无真实用户数据库/凭据/外部 Provider 操作。

## 已结算标题的投影恢复与空闲唤醒（2026-09-08）

原标题 Action 成功后，若会话标题投影丢失，普通空闲 wake 不会补回。现将既有 Action 结果编码为 version/sessionID/messageID/expectedTitle/title 回执，不新增数据库、执行器或队列。空闲且没有可恢复 run、steer/queue 输入时，复用 DurableAction.load 校验持久结果与请求，核对标题 Action 主体及原首轮消息绑定，经过原条件投影发布标题；不再为冗余 wake 分配空 run。标题 Agent 禁用时不恢复。用户已改名或默认标题已变化时保持现值。

Formal 三种故障注入均通过：丢失原投影可恢复，自定义改名和不同默认标题不会被覆盖；重复 wake 后完整 Action/run 快照不变，模型调用仍为主回答及原标题两次。当前使用隔离 SQLite 回写标题模拟投影丢失，不是真实进程强杀或冷启动。旧字符串回执缺少绑定，不猜测迁移；压缩后首轮消息不可见、缺回执与维护预算、完整客户端体验仍未验收。

本批重新运行正式首轮/标题/取消专项 **14 pass / 0 fail / 121 断言 / 70.17 秒**（117 filtered），Core SessionRunner 完整文件 **119 pass / 0 fail / 565 断言 / 87.82 秒**，覆盖队列、恢复、取消、压缩等现有合同。Core 与 Arforge 独立 typecheck 退出 0；两文件 Prettier 检查通过，oxlint **52 warnings / 0 errors**，不称告警清零。R05 保持开放，下一步仍须持久维护预算及真实冷恢复；三平台 full sandbox 最后。未操作真实用户数据库、凭据或外部 Provider。

## 计费准备结果的 run 归属与价格快照（2026-09-08）

继续核对维护预算接线，确认 Action 尚无可直接复用的 currency-bound 维护分配接口，未放宽其默认额度。同时复现两个现有 RuntimeBilling 缺陷：prepareCall 返回配置价格表引用，配置变化能把原应计 8 改为 0；两个 run 使用同名 reservation 时，可拿前一个 run 的 PreparedCall 结算后一个 run。新增用例修复前 9 pass / 2 fail。

现原 PreparedCall 绑定 runID，settleCall 在任何价格计算/预算修改前核对归属；原 prepareCall 复制并冻结价格版本、费率与生效时间快照，保留用户原配置对象可更新。返回的准备结果及 reservation 冻结，不新增 owner/账本。补测发现 Schema.make 会复制嵌套 Struct，先冻结输入并不足够；已改成冻结构造后的价格快照，并验证原配置未被冻结、正常结算金额/版本仍为原值、错误归属时两边状态不受误伤、合法各自结算和重复结算拒绝。

最终完整 billing 文件与 Runner 计费专项合计 15 pass / 0 fail / 58 断言，115 filtered（3.82 秒），不冒称 Runner 全文件重跑。workspace 类型 22/22 successful、20 cached（41.019 秒）；最后调整冻结实现后 Core 独立类型再次复验。两文件格式/diff-check 通过，oxlint 1 遗留 warning / 0 errors。收尾补测日期读取曾复现 TypeError：DateTime 有内部可写缓存，不能冻结；现生效日期使用独立副本但保留库缓存可写，价格版本与费率仍冻结，公共日期读取回归通过。

边界：runID 是原进程内计费准备结果的归属绑定，不是持久授权 capability，也不是跨进程共享预算分配。严格标题预算仍未接通，Action 额度未上调；冷恢复的预算预留、对账结果持久化、缺 usage 策略仍须继续。R05/R17 未关闭，full sandbox 最后，无真实用户数据/外部 Provider 操作。

## 维护预算前置：未定价用量不能当成免费（2026-09-08）

检查标题计费接线时发现公共 RuntimeBilling.charge 已返回 unpricedCategories，但 prepareCall 和 settleCall 无条件使用不完整 amountMinor。新增测试实际复现：缺输入价格仍以 0 预留，实际用量含未定价 image-input 时仍释放预留并报结清（修复前 7 pass / 2 fail）。现在原预留和结算入口增加同一完整价格检查，抛出携带价格版本与类别的 UnpricedUsageError；未改只读 charge 的诊断语义，也未新增账本。拒绝时 scope.state 对象不变；真实零价格保留可用，未消耗维度不强制配置价格。

Core Runner 真实执行链新增输入/输出缺价格两项测试：请求次数为 0、无成功账单、主 run failed；原正常计费与失败用量核对保持通过。最终 billing/SessionRunner 两完整文件 128 pass / 0 fail / 593 断言（81.90 秒）；带计费配置的正式自动子任务入口另跑 1 pass / 19 断言（13.73 秒），child 仍一个 run/一次 attempt/7 tokens、无旧 assistant。Core typecheck、三文件格式/diff-check 通过，oxlint 41 warnings / 0 errors（遗留告警未清零）。

此处保留预留是既有 RunScope 的进程内状态，不是新的持久待对账队列，不证明进程重启可恢复这笔预留。标题严格预算仍未接通，仍跳过维护；共享预算分配、缺回执和未定价结果的持久恢复/用户提示仍待完成。本批不关闭 R05/R17，也不声称完整计费交付；full sandbox 最后，无真实用户库或外部 Provider 操作。

## 正式首轮标题、配置与取消接线（2026-09-08）

标题维护已接入原 Core Runner 的成功终态结算之后，交给现有 BackgroundJob，不启动第二 SessionRun 或旧 Loop。根会话仍是原默认标题、有首个真实用户文本及 assistant、且 title Agent 未禁用时，使用既有模型 resolver（保留配置模型/variant 与调用凭据作用域）构建标题请求。稳定 Action 身份绑定 session/首个 assistant/session.title；原 Gateway 独占 attempt、发送前保存精确 envelope、记录可用 Token 回执与 durable title result，再发布原 TitleGenerated 条件投影。Action 不归入主 run，维护失败不反改已结算主回答。使用调用方提供的既有 instance-scoped 后台 facade，使任务可由原 list/wait/cancelSession 操作，不另起产品任务列表。

正式测试先重新确认默认标题失败（1 pass / 1 fail），初次接线后仍失败；定位到请求已发送两次且标题 Action blocked：原 llm.text 夹具没有 usage，原 Gateway 正确拒绝未知计量的成功结算。未放松 Gateway，将成功场景明确提供 12+3 的受控 HTTP Provider 回执，并单独保留 missing-usage 失败场景。无回执目前仍不应用标题，不声称已解决缺 usage Provider 的估算/对账。诊断期一次位置引用写错导致测试失败，修正后定位；临时诊断输出均已移除。

最终正式入口 11 pass / 0 fail / 97 断言（60.31 秒）：用户自定义标题保护；成功生成、Action 单次 attempt/15 tokens/请求记录/无新 run；两次重复 wake 不多发请求；指定标题模型与提示词；禁用 title Agent；空结果/缺 usage 后主 run 仍 completed；请求中途改名不覆盖；公开 cancel 取消原后台任务且保留主 run completed；原公开子任务取消、新回合及两项 Shell 取消回归。配置模型验证沿测试既有 resolver seam 及本地 HTTP，并非真实外部供应商认证。Core Gateway/Runner/录制 Runner/标题组件四完整文件 249 pass / 0 fail / 1243 断言（96.84 秒）；Core 与 Arforge 独立 typecheck 退出 0，格式/diff-check 通过。两改动文件 oxlint 存在遗留告警，未以全绿静态检查冒称交付。

明确未完成：严格 currency-bound billing 目前警告并跳过标题维护，尚未绑定共享预算预留；普通路径缺 verified monetary receipt 时不填写 costMicros，不声称免费；缺 usage 不估成 0；真正新进程恢复/扫描、跨进程发送与投影窗口、历史输入被压缩后的身份恢复、所有客户端显示及全部协议仍未验收。旧未调用 ensureTitle 仍待最终替代后退出。下一步优先闭合维护预算/缺回执策略与冷恢复，不将当前有回执普通会话成功称为整个自动标题或 R05 交付完成，full sandbox 最后。全程只用隔离数据库及本地测试 HTTP，未操作真实用户数据或外部 Provider。

## 标题请求消费已有 Agent 配置（2026-09-08）

确认 Core plugin/agent 已提供隐藏 title Agent，ConfigAgentPlugin 可覆盖其 system/request；原标题 prepare 却忽略这些配置。现 prepare 接受既有 Agent.Info 的 system/request 字段，使用配置提示词与 HTTP 配置，仍通过原精确 envelope 冻结和重建，不新增配置模型或执行 owner。无配置时保持原默认提示词；工具为空、toolChoice=none 和 256 输出上限保持。

新增离线真实 LLMClient.prepare 验证，Auth.custom 仅观察本地 transport 组装的正文/headers，不发送网络请求：配置正文及 header 保留，提示词进入协议正文，配置对象事后修改不改变已冻结请求。tools/messages/max_tokens 三类原始覆盖由现有 transport 拒绝；未声称已验证全部协议或所有别名。最初测试缺凭据造成拒绝用例提前失败，已修正固定离线凭据并断言 protocol-owned 原因，修复前准确复现 14 pass / 4 fail。修复后最终标题组件/标题策略/request-envelope 三完整文件 33 pass / 0 fail / 86 断言（354 毫秒），Core typecheck 退出 0，两文件 oxlint 0 warnings / 0 errors，格式通过。误调用 ESLint 因仓库无该配置失败，随后使用仓库实际 oxlint，不把前者算作通过。

本次仍未将正式 Runner 接入生成组件；标题模型选择、费用预算归属、后台触发、冷恢复去重和主任务隔离仍待完成。原正式自动标题失败不关闭，R05 不关闭，三平台 full sandbox 最后。没有操作真实用户数据、真实凭据或外部 Provider。

## Action 内的精确模型请求持久记录（2026-09-08）

原 Action 只保留 intent hash，没有可重建的请求正文。现沿原 Action 聚合新增 ActionModelRequestPrepared，进入原 durable inventory；新 proposal 保存原 inputDigest（旧记录允许缺失）。Gateway 的原 OperationExecutionContext 增加 recordModelRequest，复用 commitOwned 的 lease/capability/CAS 检查，只有 executing 且 activeAttempt 存在时可写。先以原 requestEnvelopeJson/parseRequestEnvelopeJson 校验规范形式、摘要和秘密字段，再绑定 immutable inputDigest 与可选 runID，限制 65,536 UTF-8 字节。相同记录幂等；不同请求拒绝。未另建 Runner、队列、数据库，也没有把维护请求塞入主会话的 RequestEnvelopePrepared 历史。

DurableAction 读取原事件重建 modelRequest，复核输入摘要、主体、attempt、lease ID/generation、记录时间和执行状态；非法或重复事件拒绝，不把缺失旧 inputDigest 猜成可用请求。Gateway 重放同时复核已存 inputDigest（存在时）。标题组合夹具在 stream 前确认请求已落库，重复记录不追加 sequence；成功与空标题失败原计量保持。额外验证请求漂移、settled 后 captured context 写入拒绝、直接篡改已存 envelope 导致 CorruptHistoryError、中文多字节请求超字节限额时不写请求事件/不发送，以及跨 run 或缺输入绑定拒绝。没有证明真实新进程恢复、发送中 lease takeover 的全部交错或外部 Provider prepare 边界。

组合接线前 0 pass / 2 fail，接入并修正本地 Effect.try 调用后通过。最终 Gateway/DurableAction/request-envelope 三完整文件 **148 pass / 0 fail / 732 断言 / 14.38 秒**；Core 独立类型通过，workspace 22/22 successful、20 cached（Core/Schema 重跑），Arforge 独立类型另行复核。六文件格式/diff-check 通过，lint 123 warnings / 0 errors，未清零。测试只使用隔离 SQLite 和受控模型流，不涉及真实用户数据/凭据。

Arforge 独立 typecheck 最终退出 0。

本批提供原 Action 请求存储与组合测试，不等于正式自动标题触发完成。费用预算归属、正式后台维护接线、冷恢复去重和主任务隔离继续待做，R05 不关闭，full sandbox 最后。

## 标题回执保留并验证原 Gateway 计量（2026-09-08）

标题组件增加同步 onUsage 回执观察接口，交给原 owner 的全结果计量回调消费，不创建独立账本。收到带 usage 的事件先保留/通知，再验证标题；无 usage 的最终 finish 不覆盖此前 step-finish 回执。空标题时观察列表为空、step usage 被丢失两种产品缺陷均先复现失败；初始 step-finish 夹具缺 index 的测试构造错误已修正后重新复现真实缺陷。组件保留最终成功结果中的 usage，也验证已收到回执后取消、30 秒超时和流 defect 不会抹掉观察到的回执。

原 Gateway 完整夹具新增两种组合验证：用真实标题组件、真实 Gateway/临时 SQLite Action 聚合，受控内存 Provider 分别返回可用标题和空标题；执行时已有合法 capability 与 executing attempt，两种结果 tokensUsed 均 15，Observation 分别 succeeded/failed，activeAttempt 清理、发送仅一次。夹具的模型调用费用明确为 0；这不证明真实 Provider 免费，也不证明请求原文已持久保存（仅原 inputDigest 绑定）。本批没有在测试外接入标题触发。

最终 Gateway/标题组件/标题规则/request-envelope 四完整文件 **139 pass / 0 fail / 655 断言 / 12.12 秒**，Core typecheck 退出 0；三个改动文件已格式化、diff-check 通过。标题组件及其测试 lint 0 warnings / 0 errors，原 Gateway 测试文件 48 warnings / 0 errors。仍须正式 owner 的持久请求、费用预算归属、实际触发与主任务隔离；onUsage 只是已收到回执的观察接口，不是冷恢复或外部账单核对。正式自动标题失败尚未修复，R05 不关闭，full sandbox 最后，无真实数据/凭据/外部 Provider 操作。

## 失败/取消计量与清理先于结算（2026-09-08）

原 Gateway 的 costMicros/tokens 仅在成功返回时调用。新增失败/取消两项回归先得到 0 pass / 2 fail：模拟已知费用及 Token 用量未记入预算。现将原两个测量回调统一扩展为接收 operation Exit（含 lease 丢失），成功、失败、中断都在同一结算路径消费，不新增平行计量服务。现有 merge adapter 按 Exit 解包；无可用失败费用时返回 undefined，不猜测零费用。

续测发现只改回调仍不足：取消回归的 cleaned=false，说明原 race 返回时操作清理尚未完成。Gateway 现持有原操作的子 fiber，取消/lease race 后显式中断并等待其结束，再撤销 capability、计量和发布 attempt。并从操作最终 Exit 保留 cleanup defect，避免将有清理异常的执行记录为纯取消。清理异常回归修复前失败，修复后通过。没有新 Runner、后台 registry 或单独数据库，也未改依赖库。

ActionAttemptFinished 的 costMicros 改为可选，旧带数值事件继续可读；新未测量费用保持字段缺失，budget 仅累加已知值。已声明测量但无法取得有效安全整数时 Action blocked，无成功 Observation；成功操作返回 RecoveryRequiredError，原失败/中断保留原 cause。新增真实 SQLite 事件断言确认 unknown cost 字段不出现，而已知 tokens=8 仍保留。预算合计不是“所有费用已经核对”，不能将缺失消费当作已证明的零。当前同步回调也不是 Provider 外部对账器。

最终 Core Gateway/DurableAction/两个 write-conflict 文件 **147 pass / 0 fail / 742 断言 / 15.35 秒**；正式产品公开子任务取消后新回合、真实 Shell 取消与排队 Shell 取消 **3 pass / 36 断言 / 29.51 秒**。Core 独立类型通过，workspace 类型 22/22 successful、20 cached（Core/Schema 重跑）；五文件格式和 diff-check 通过，lint 94 warnings / 0 errors，未清零。

本批修复统一计量与取消顺序，未接正式自动标题；标题仍需捕获失败流 usage、费用预算归属、持久请求和主任务失败隔离。未验收所有跨进程清理/外部账单及全用户旅程，R05 不关闭，full sandbox 最后。未操作真实用户数据、凭据或外部 Provider。

## 统一 Action Token 计量前置修复（2026-09-08）

继续标题运行时接线时发现实际 Gateway 的 Action budget 虽有 tokensUsed，但 ActionAttemptFinished 未携带 tokens，投影不累积，执行入口也未消费 Token 估算。新增两项回归先得到 0 pass / 2 fail：58 tokens 仍投影为 0，超过 DEFAULT_MAX_TOKENS 的估算仍执行。这不是仅缺标题 helper 的问题。

现直接扩充原 Operation 的 estimatedTokens/tokens 接口与原 ActionAttemptFinished 可选 tokens 字段；不创建新账本、服务 owner、事件家族或数据库。入口核验安全整数与剩余 Action Token 额度，子 Action 上限同时受父 maxTokens 约束（仍不是共享额度池）。成功操作的实测 tokens 进入原 CAS 事件，DurableAction 从持久历史累积；已 settled 结果重放不重复执行或计量。测量回调非法/抛错时完成 attempt 记录后将 Action blocked，不产生成功 Observation，不允许盲目重放；审计不包含回调错误内容。旧未计量事件保持字段缺失，实测 0 明确编码为 0，不能把历史预算合计 0 解释为已测得零消耗。

最终 Gateway/DurableAction 完整两文件 **130 pass / 0 fail / 664 断言 / 14.09 秒**；包含新增非法估算、测量失败、持久重放与旧事件兼容回归。Core、Schema 独立类型通过；workspace 类型 22/22 successful、20 cached（Core/Schema 重跑）。五文件格式/diff-check 通过；前四文件 lint 93 warnings / 0 errors，新增涉及的 durable-action 测试文件 6 warnings / 0 errors，未清理遗留告警。

边界：这是统一计量基础，当前标题组件尚未调用新接口，正式自动标题仍未修复；失败/中断后的可计费 usage 核对、费用预算、原始 Provider prepare/发送绑定、独立维护的预算归属及主任务失败隔离继续待做。不得把这次改动称作全模型计量完成或 R05 完成。费用 Action 默认额度仍为 0，未为接通标题擅自放宽。full sandbox 最后；未操作真实用户库、凭据或外部 Provider。

## 标题超时清理与 usage 传递续验（2026-09-08）

新增三个组件回归：以 Deferred 确认进入授权/Provider 阶段，再推进 TestClock 30 秒，验证 TimeoutError、停滞操作 finalizer 已运行，授权停滞时 Provider 调用为零；成功响应保留完整 usage 供原 owner 结算。没有真实等待 30 秒，没有外部请求。三文件合并 23 pass / 0 fail / 54 断言（253 毫秒），Core typecheck 退出 0；去掉新增测试不必要断言后专项 lint 0 warnings / 0 errors。只证明组件超时与用量传递，不证明费用已结算、正式运行链已接入或冷恢复完成。正式自动标题缺口仍未关闭，R05 保持开放，下一步继续真实 Gateway/持久请求/预算与结果投影接线。

## 标题模型请求组件与精确重建边界（2026-09-08）

Core 新增 session/title-generation.ts，使用原 LLM.request、createRequestEnvelope/rebuildRequest 和标题 normalizer，不创建服务 owner、Loop、后台 registry 或第二数据库。prepare 生成无工具、toolChoice=none、输出上限 256 tokens 的标题请求及原规范 envelope；generate 先校验重建，再调用必填 authorizeAndRecord，成功后才 stream。收集上限 8192 字符、30 秒 timeout；只有 stop 终态和可用标题才返回，空/未闭合推理/未完成/超限/provider-error 都失败，中断保持中断，不返回假成功。返回标题和可选 Provider usage，实际预算结算仍须由调用 owner 接入。

组件测试使用受控流，不是实际 Provider 或正式产品接线：验证 record→send 顺序、envelope 精确重建、无工具、拒绝时调用零次、未完成/空/超限拒绝和纯中断。最终组件/规则/请求重建三文件 **20 pass / 0 fail / 46 断言 / 0.245 秒**，Core typecheck 退出 0，新增两文件 lint 0 warnings/0 errors，格式已修正通过。30 秒超时设定尚无专门 TestClock 回归，usage 结算、配置指定标题模型/策略、输入预算及真实流失败需继续验证。

关键边界：authorizeAndRecord 目前是强制调用接口及测试替身，并未接真实 Gateway/持久 claim；没有声称“回调存在=授权已经实现”。正式 Runner 尚不调用此组件，原自动标题回归仍未修复。下一步将真实 owner 的持久身份/请求记录/预算/恢复语义接入该接口，并把成功结果送入原 TitleGenerated 条件投影；不得传 Effect.void 在产品绕过授权，也不得只用进程内 BackgroundJob ID 宣称冷恢复去重。R05 不关闭，full sandbox 最后，无真实用户数据/凭据/外部 Provider 操作。

## 标题结果接入原会话事件的条件投影（2026-09-08）

新增当前 SessionEvent.TitleGenerated（session.next.title.generated）单一可序列化合同，进入原 durable/current 会话事件 inventory；它表示生成结果提议，不表示必然覆盖了当前标题。包含原默认标题、生成标题和源 messageID，后续用于 Core 维护结果提交。SessionProjector 复用原 EventV2 事务，将 expectedTitle 必须为默认形状、标题必须已通过共用 normalizer 作为前提；单条 SQL WHERE 限制同一 session、当前 title=expectedTitle、parent_id IS NULL，仅更新 title，显式保留 time_updated。不覆盖费用、元数据等其余字段，不调用兼容层整份 info 更新。消息 updater 将此元数据事件视为无消息变更，不把标题塞入模型会话历史。

以真实临时 SQLite/event 层测试默认未变、用户已改名、子会话三场景。未接 projector 时 **2 pass / 1 fail / 7 断言 / 1.333 秒**，默认标题没有更新；接入后通过。追加幂等验证曾错误地重复 publish 同一个 event ID，原事件层明确拒绝，**14 pass / 3 fail**；已改成读取真实序列化事件并调用原 replay API，未放宽 EventV2 的重复发布保护。最终投影/纯规则两文件 **17 pass / 0 fail / 59 断言 / 1.71 秒**；重放事件数仍 1、投影行不变，另一个过期生成提议也不能覆盖已变化标题，模型消息表为空。

Schema 类型通过；workspace 类型 **22/22 successful、19 cached、34.295 秒**，修正测试缺失 row 的类型收窄后 Core 独立类型再次退出 0。四文件格式/diff-check 通过，lint 无 errors、有遗留 warnings。本批没有接入模型生成、持久请求 claim、调用预算/去重或客户端消费，因此原 Formal 自动标题失败仍未解决，不能称标题交付完成。当前同值比较也不证明用户改名后改回原默认值的 ABA 场景、跨进程全交错或客户端显示验收。下一步继续生成请求与维护生命周期接线，R05 不关闭，full sandbox 最后；无真实用户数据操作。

## 标题规则收敛到 Core；生成接线仍未完成（2026-09-08）

新增 Core session/title.ts 纯规则模块，不含执行器、后台队列或存储：默认标题前缀/严格形状识别、仅根会话且当前标题等于原默认标题的替换资格、生成文本清理。清理剔除完整 think 块，拒绝未闭合推理/空文本/默认标题，取首个非空行，按 Unicode code point 限制 100 字符并保留省略号。旧 Session.isDefaultTitle 直接重导出同一 Core 函数，Core 创建和兼容创建共用前缀，旧待迁移标题函数复用同一 normalizer；没有保留两套规则。

Core 纯规则 **5 pass / 21 断言 / 0.040 秒**，覆盖自定义/变化的默认标题、子会话、推理及 emoji 边界；新增两文件 lint **0 warnings / 0 errors**，两包 typecheck 退出 0，格式/diff-check 通过。此处 canReplace 只是纯函数，不是数据库条件写入、锁、版本 fencing 或改名竞争已经解决的证据。

重跑 Formal 用户旅程仍为 **1 pass / 1 fail / 10 断言 / 16.53 秒**，自动标题未修复；未放宽或跳过失败测试。下步必须接现有 Core 模型请求与有界维护、原会话条件写入及持久去重，不能以这批规则单测代替真实生成。检查还确认旧兼容 setTitle 使用整份 info 更新事件，直接异步复用可能覆盖并发修改，需在原事件/数据库事务边界解决，不能只在写前做一次内存比较。R05/full sandbox 顺序不变，无真实用户数据操作。

## 未通过：Formal 默认标题首轮未生成标题（2026-09-08）

新增真实 Formal 回归：创建没有指定 title 的会话，确认 Session.isDefaultTitle 为 true；通过公开 prompt 完成首轮实际测试 Provider 回答，确认 assistant 和正文正确，再在有界轮询内读取原 Session 标题。最终仍是默认标题，报 Formal first turn did not generate a session title。首次单项 **0 pass / 1 fail / 3 断言 / 13.06 秒**；补强主回答断言及用户自定义标题保护后两项 **1 pass / 1 fail / 10 断言 / 16.85 秒**。用户指定标题保持不变且只有一次模型调用通过；默认标题自动生成失败。没有 skip 或将失败断言改为接受默认标题。

源码证据：旧 Prompt ensureTitle 没有调用者；Core session 创建仍写默认标题，Core runner 尚没有已验证的标题后处理调用（其维护说明列为待做）。现有 Session.setTitle 只提供写入能力，不代表会自动触发。旧函数仍保留，禁止靠删除它把功能缺失从清单消掉，也不恢复旧 Loop/旧 LLM 执行路径来规避统一 TS Core 要求。

后续修复验收要求：使用现有 Core 模型/调用与会话存储边界实现有界标题维护；只有默认标题、首个有效用户回合才有资格，不为子任务或用户已命名会话额外请求；标题调用失败/取消不能将主回答改成失败。提交时重新核对原默认标题，防止覆盖用户在生成期间的改名；重复 wake/恢复不重复请求或写入。补验证标题长度/空输出、用户改名竞争及 HTTP/客户端读回。不能用截取用户输入替代原模型生成能力，也不能新增第二标题存储或独立产品执行器。

本批仅回归与证据，未修产品逻辑。格式检查通过，lint 有遗留 warnings、无 errors；Arforge typecheck 退出 0，不替代失败的功能验收。R05 不关闭，full sandbox 最后，无真实用户数据或凭据操作。

## 清理旧子任务处理与队列帮助函数，保留正式适配器（2026-09-08）

实码引用核对后删除无调用的 handleSubtask 与 promoteQueued，原文保存于 [帮助函数恢复副本](./retired-r05-prompt-helpers-20260908.txt)。prepareScheduledSubtaskProjection 仍由正式 scheduledTaskCarrier 调用，必须保留；不能将旧帮助函数删除扩大成投影能力删除。Prompt 中未使用的 permission/sys/flags 服务局部变量移除，SystemPrompt 节点退出；Permission 静态 evaluate 仍在使用，因此保留进口，去掉本层无用服务依赖。修正文档注释中“either runner”的过期表述。

最初同时删除 RuntimeFlags 节点后，类型检查报告 Missing dependencies，正式专项 **0 pass / 10 fail / 5.59 秒**，均为缺少 RuntimeFlags 服务。这不是产品测试通过；已恢复该节点而非抑制类型或补测试替身。实际消费者是 TaskRuntime 在 Prompt 执行上下文读取 RuntimeFlags（tool/task.ts），节点旁补充原因；仅未使用的局部服务获取继续删除。最终 Arforge typecheck 退出 0，正式授权/委派/followup 完成与取消/父子取消/恢复/排队 Shell 取消 **10 pass / 0 fail / 160 断言 / 70.07 秒**。格式、diff-check 通过；Prompt 单文件 lint 8 warnings / 0 errors，未清零。

另发现旧 ensureTitle 局部函数没有调用，Core runner 说明仍列标题后台工作为待做项，尚无已验证的替代消费者证据。因此本轮保留标题函数及其依赖，不以“死代码”名义消除用户可见能力要求；下一步核验默认标题会话的真实 Formal 旅程，再按现有 Core 服务融合。标题缺口尚未通过运行时回归定性，不宣称完成或已修复。R05 继续开放，其他 unix-only Shell 合同、冷恢复和完整客户端体验仍需验收，full sandbox 最后。无真实用户库、凭据或全局入口操作。

## 旧 RunState 与通用 Runner 物理退役（2026-09-08）

核对旧独立 Runner 测试与现有 Core 协调器/正式入口后，补入两个 Core 回归：两个并发 resume 收到同一个 failure 对象、只执行一次且随后可再次运行；exclusive 工作取消时保留清理 defect、不伪装纯中断或成功，释放后可以再次占用同一槽。均使用 Deferred 就绪信号，不复制旧定时等待。最终 Core 协调器全文件 **31 pass / 84 断言 / 0.350 秒**，单文件 lint **0 warnings / 0 errors**。

旧行为的融合去向如下（这是本次删除的合同对照，不是整个 R05 完成声明）：

| 旧 Runner 要求 | 唯一 TS 实现与验收位置 |
| --- | --- |
| 开始/完成/失败、并发共享、后续重试 | Core run-coordinator：joins concurrent resumes、共享失败新增回归、failure/defect 清理 |
| 空闲取消、并发取消、取消后新输入、清理期间后续工作 | Core interrupt/清理竞争回归；Formal 公开取消与新输入回归 |
| Shell 独占、拒绝第二 Shell/活跃 drain、结束后排队运行且只运行一次 | Core exclusive/handoff 回归；Formal 真实 Shell 审批与并发回归 |
| Shell 取消、排队等待者结束、清理 defect 不被掩盖 | Core 新增 defect 回归及 interrupt 回归；Formal queued-behind-Shell 取消 |
| busy/idle 生命周期回调 | 以 Core active 作为真实 owner；Formal 状态投影/公开取消覆盖，不保留旧回调 API |
| onInterrupt 成功回退值与旧泛型结果 | 不移植旧返回形状；Core 等待者保留中断，正式 Shell 返回含 error 的可读结果，产品历史读取规范结果 |

删除 packages/arforge/src/session/run-state.ts、src/effect/runner.ts、test/effect/runner.test.ts 三个旧文件。删除前以 [JSON 文本恢复副本](./retired-r05-runner-source-20260908.txt) 保存当前原文，含 RunState 已有未提交修改；读取副本与原读取字符串逐项完全一致。副本不可执行，不重新装配旧状态机。全 packages/script TS 搜索仅剩 task.ts 一处历史注释，无旧文件进口。

删除后的 Formal Shell/排队取消和部分冻结回放 **12 pass / 158 断言 / 50.14 秒**；另跑整个冻结回放文件 **8 pass / 223 断言 / 17.62 秒**，覆盖全部六种历史合同和两个门槛测试，不重录基线、不启动 Mature，两批有重叠不累计。HTTP 装配/真实快照读取 **2 pass / 9 断言 / 14.52 秒**。Core/Arforge typecheck 退出 0，格式/diff-check 通过。库存刷新仍有 1 条历史 selector signal，不能把负向扫描称为全零。

旧状态文件实际退出，但 R05 尚有遗留帮助函数/低层 unix-only Shell 合同、冷恢复边界与完整客户端验收；没有据此关闭 R05/R30。本批不操作真实用户数据、凭据或全局 CLI；三文件可用恢复副本找回，full sandbox 仍最后。

## Shell 基础合同迁入 Formal，测试装配退出 RunState（2026-09-08）

将标准输出/错误输出、快速命令、目录列表、失败命令、切换目录和取消六类旧低层 Shell 要求迁入现有 Formal 集成夹具，均经真实 direct Shell 审批。失败命令明确检查 exitCode=1 和 stderr，不再将非零退出当作 completed，也不采用 undefined 可能通过的非零断言。目录切换使用 Shell 自身 cd，再由 Node 读取 cwd；本机 powershell.exe/cmd.exe 两种配置均验证父目录、输出和 Core 非活动状态，Provider 调用为零。非 Windows 分支保留 /bin/sh，本轮未在该平台执行。

取消场景由实际 Node 创建就绪文件后挂起，公开 cancel 返回后检查 idle、Core active 清空、调用可正常取得结果且工具为 error。初次迁移仍断言旧文案，出现 6 pass / 1 fail；实际正式错误为执行开始后中断并阻断 durable action，按该语义更新断言，不恢复旧 completed 形状。本轮移除 prompt.test.ts 的 SessionRunState import、公共根节点和 boot 服务获取/返回字段；全包 TS 检索只剩 RunState 自身定义和一处历史注释，没有测试消费者。

最终扩大 Formal Shell、取消和快照回归 **31 pass / 0 fail / 370 断言 / 165.73 秒**，89 未匹配；Arforge typecheck 退出 0，格式和 diff-check 通过，单文件 lint **30 warnings / 0 errors**。本批只迁移测试与清理测试装配，不宣称全文件/全工程通过。RunState 文件、通用旧 Runner 及其独立测试尚在；其他 unix-only Shell 合同、运行中元数据、冷恢复和客户端验收仍待完成。下一步核对旧 Runner 独立行为覆盖后物理退役，不以无引用搜索代替全部合同验收。R05 不关闭，full sandbox 最后；无真实用户数据或凭据操作。

## 后台取消职责并入 Core BackgroundJob，生产退出 RunState（2026-09-08）

将旧 run-state.ts 中完整子树选择/后代优先取消算法移入既有 Core BackgroundJob.cancelSession，直接使用同一 registry 的 list/cancel；支持 job.id 与 metadata.sessionId 身份以及 metadata.parentSessionId 关联，先固定当前 running 子树，再分层取消后代。旧实例适配 BackgroundJob 仅转发该方法，没有第二注册表。旧 RunState 中算法已移除，其保留的测试接口只委托 Core 方法。

SessionPrompt.cancelLocal 改为原 BackgroundJob.cancelSession 后发布 idle；直接 Shell 的 durable 授权取消逻辑及 Core interrupt 顺序保持不变。Prompt、app-runtime 与 HTTP app 显式移除 SessionRunState 进口/服务/装配依赖。生产源代码检索只剩 run-state.ts 自身定义和一处历史注释；旧低层 prompt 测试仍装配它，尚不能称文件物理删除。三个后台 task 回归直接改用 jobs.cancelSession，不再借旧执行状态机调用取消。

Formal 父子/准备阶段/Shell/并发取消与三项后台工具测试 **21 pass / 274 断言 / 69.90 秒**。新增 Core 元数据关联树回归以 Deferred 确认运行：孙先于子取消，其他根任务继续，重复取消不重复触发；Core BackgroundJob 全文件 **8 pass / 430 断言 / 0.199 秒**。生产装配后的 HTTP 构建/真实差异读取/忙碌删除 **3 pass / 14 断言 / 13.58 秒**。Core/Arforge 独立 typecheck 通过；workspace **22/22 successful、20 cached、25.058 秒**；八文件格式通过，lint **31 warnings / 0 errors**。

cancelSession 的范围仍是当前进程/注册表快照，不宣称覆盖取消选择后新注册的后代、跨进程持久化恢复或所有外部进程物理终止。上述限制不是靠第二管理器解决的理由，需后续按原运行时合同验收。下一步迁移旧低层 RunState 测试，删除无生产消费者的旧状态文件/Runner 依赖，继续其他旧帮助函数。R05 未关闭，full sandbox 后置；仅源码与隔离测试/证据，无真实用户数据或凭据操作。

## 消息删除忙碌保护融合进 Core 独占槽（2026-09-08）

审查 SessionRunState 消费者发现 HTTP deleteMessage 仍调用旧 assertNotBusy；旧 Loop 已退出，旧 runners map 不能反映 Core 正式工作。新增真实 Core SessionExecution.exclusive 以 Deferred 发布就绪/等待释放，期间 HTTP DELETE 原返回 200，专项 **0 pass / 1 fail / 1 断言 / 6.82 秒**。未使用假的 busy 标记或固定 sleep。

现 deleteMessage 移除 SessionRunState import/服务获取，复用 handler 已捕获的 canonical execution.exclusive 包住原 session.removeMessage。未取得独占槽按原 SessionBusyError 映射返回 409；槽内完成写入后才释放，避免仅查询 active 后再删除的本进程检查窗口。没有第二锁表、执行器或删除实现。测试验证忙碌时 409/公开错误体、会话事件不变；释放后原 DELETE 返回 200。专项连同原消息变更和错误映射 **3 pass / 0 fail / 10 断言 / 8.74 秒**；Core 协调器全文件 **29 pass / 74 断言 / 0.313 秒**，Arforge typecheck 退出 0，双文件格式通过、lint **6 warnings / 0 errors**。

本批验证本进程共享协调器，不宣称跨进程 durable mutation fencing、所有消息/part 变更入口或整个 HTTP 文件已重跑。SessionRunState 仍有 background 子树取消和旧低层测试消费者，不能直接整文件删除；后续继续融合清理职责并退出无用 ensureRunning/Runner 状态。R05 未关闭，full sandbox 后置；仅隔离测试和源码/证据，无真实用户数据操作。

## 旧 Loop 公开入口与主循环物理移除（2026-09-08）

在 Formal 快照/真实补丁查询与 HTTP 正向读回完成后，删除唯一剩余直接调用旧 prompt.loop 的 snapshot-tool-race.test.ts。其当前工作树原文（含已有 2 增/3 删修改）和被移除循环全文保存在 [只读恢复副本](./retired-r05-loop-source-20260908.txt)，不是可执行 .ts 测试，不丢弃用户已有修改。对应要求由 prompt.test.ts 的两轮真实授权命令、不同前后快照、正确文件列表/补丁/回合隔离，以及 httpapi-session.test.ts 的实际 HTTP 读取覆盖。

移除 prompt.ts 的 runLoop/loop wrapper 共 452 行区段、Interface.loop、返回对象 loop 和 LoopInput；schema 回归改为验证旧合同不再导出，正式快照测试检查实际服务无 loop 属性。全仓 TS 搜索未发现 prompt.loop 调用，剩余 runLoop 文字只在历史说明。进一步移除 Prompt 对旧 SessionProcessor/SessionCompaction/SessionSummary 的进口、服务获取和 node 依赖，以及本次退出后无用的进口/孤儿工具判断。未删除仍被其他消费者使用的服务文件，也未触碰通用 CLI 事件读取 loop。

初步 Formal 快照/中断输出及 schema **8 pass / 52 断言 / 28.11 秒**；取消与固定历史回放扩大批 **26 pass / 490 断言 / 83.26 秒**。最终移除旧装配依赖后的新鲜回归 **11 pass / 256 断言 / 36.10 秒**，包含全部六类冻结历史合同、父/子取消和快照查询。回放不重录，不重新执行 Mature。Arforge typecheck 最终退出 0、格式通过；三文件 lint **46 warnings / 0 errors**，遗留 title/handleSubtask/promoteQueued 等无用帮助函数仍需审查退役。

这完成了旧 SessionPrompt 主循环的实际代码退出，不等于全部 R05 完成：SessionRunState/通用旧 Runner、其他遗留帮助函数和服务消费者、冷恢复边界及完整客户端验收仍待处理。仅源码/隔离测试/证据；删除测试可由恢复副本找回，无真实用户数据或全局入口变动，full sandbox 后置。

## HTTP Location map 显式 Database 依赖修复（2026-09-08）

针对上一批间歇性 Database service missing，构建无外部上下文的最小回归，只装配 HTTP 实际 LocationServiceMap 替换，稳定得到同一缺服务错误，**0 pass / 1 fail / 4.58 秒**。实码根因：buildSharedLocationServiceMap 要求 Database.Service，但作为裸 Layer 传给 LayerNode replacement 时会被包装成 deps=[]；同组 sibling Database 的存在不是依赖声明，不能依赖它的构建顺序或外层上下文偶然提供。

在原 HTTP server 导出 locationServiceMapV2Node，用原 locationServiceMapV2 Layer 加 deps:[Database.node]，MoveSession、SessionV2/ScheduledPrompt、app 三处节点替换及测试 app 的替换统一使用该节点；直接 Layer.provide 仍使用原 Layer。没有第二 map 实例定义、第二数据库或变更数据库生命周期。最小回归修复后 **1 pass / 1 断言 / 4.48 秒**；随后完整 httpapi-session.test.ts 使用 --rerun-every --timeout 20000 最终 **24 pass / 0 fail / 161 断言 / 90.00 秒**，包括此前间歇失败的 Windows 等价路径和真实差异 HTTP 读取。

Arforge typecheck 退出 0，双文件格式通过，Oxlint **5 warnings / 0 errors**。这是有确定性复现及完整单文件回归的依赖修复，不声称证明所有异步清理/跨进程生命周期均无缺陷。R05 仍待旧快照消费者迁移/Loop 物理退役、差异客户端使用与冷恢复边界；full sandbox 最后。仅源码、隔离测试和证据，无真实用户库或凭据操作。

## 差异 HTTP 接线与 404 合同修复；整份回归仍有间歇失败（2026-09-08）

真实 NodeHttpServer.layerTest 路由验证发现不存在 session 的 diff 返回 500。原 handler 未调用 requireSession，端点也未声明 ApiNotFoundError；现复用同组 requireSession 并在原 diff 端点声明 BadRequest/ApiNotFoundError。仅加 handler 曾仍返回 500，补全 schema 后 404 与公开 JSON 错误体通过，未另造错误格式。

新增 HTTP 成功读取专项使用隔离 Git 目录真实 Core Snapshot.capture/文件写入，再明确种入规范编码的 Core assistant 快照历史（不是声称执行了模型工具）；真实 GET 返回唯一文件、补丁正文和 additions=1，重复读取结果相等且会话事件 ID 不增加。它与此前正式工具到查询服务的测试互补，不宣称浏览器展示或冷恢复已验收。fixture 使用 Schema.encodeSync，未用强转跳过新增数据类型检查。

四项定向批初次 **3 pass / 1 fail**，普通 read routes 超过默认五秒；以 --timeout 20000 跑整文件后该项通过。首轮全文件 **22 pass / 1 fail / 158 断言 / 87.75 秒**，纯 busy 错误映射测试不必要地装配应用时缺数据库，改为 testEffect(Layer.empty) 后专项 **1 pass / 2 断言 / 4.47 秒**。最终再次整文件 **22 pass / 1 fail / 157 断言 / 83.85 秒**：Windows 等价目录拼写测试报告 Database 服务缺失，该用例前一轮通过，间歇上下文问题未修复，不能称整份测试稳定全绿。

失败后的 Windows 路径单项复验 **1 pass / 3 断言 / 7.02 秒**，这支持间歇性判断，不证明根因已修复。workspace typecheck **22/22 successful、20 cached、24.927 秒**，本次 Core/Arforge 实际执行；三文件格式/diff-check 通过，Oxlint **8 warnings / 0 errors**。R05 未关闭；后续须定位 HTTP 夹具/运行时装配的间歇失败、验证客户端消费，再处理旧快照消费者和旧 Loop 退役。仅隔离测试与源代码/证据，full sandbox 后置。

## 会话差异查询消费唯一 Core 快照（2026-09-08）

修复上批 Formal 文件已写入但 SessionSummary.diff 返回空的问题。原查询现在先验证 session 存在，读取原 SessionStore.context；找到指定 user 后只取该 user 至下一 user 之前的 assistant 快照，使用其首个 start 与最后 end，通过 session 目录对应 Location 的 Core Snapshot.diff 生成差异，再将 canonical path 薄适配成现有查询 file 字段。未传 messageID 时比较当前 Core 历史首尾快照；Core 回合无快照返回空，不从旧库拼接。仅不在 Core 中的历史消息保留旧 summary 的只读兼容。未添加新快照库/持久化 owner，也不调用旧 summarize 来制造第二份汇总。

最初依赖完整 SessionV2 服务导致 SessionExecution→Prompt→Processor→Summary→SessionV2 的装配环，已改用现有只读 SessionStore，保留现有 Session.get 校验，不靠关闭循环检测或执行器替身绕过。实际 Formal 场景先前失败，修复后 **1 pass / 10 断言 / 13.51 秒**；加强为两轮真实 L3 授权命令后最终 **1 pass / 15 断言 / 16.41 秒**：文件及不同快照存在、变更列表正确、diff 包含 snapshot-content 补丁，第二轮后第一轮结果不变，会话级查询包含两个文件，Provider 共四次。此为正式执行 + 实际查询服务，不冒称 HTTP/浏览器完成验收。

回退快照合同文件 **7 pass / 61 断言 / 2.40 秒**；Arforge typecheck 修正品牌 ID 比较及服务引用后通过，双文件格式通过、Oxlint **30 warnings / 0 errors**。仍需真实 HTTP 差异路由/客户端、跨进程读取、压缩与 rewind/多工作区/快照损坏边界，以及剩余旧 snapshot-tool-race 消费者迁移。R05 未关闭；全部测试为隔离工作区，无真实用户库/凭据/全局入口/full sandbox 变更。

## 旧中断测试退出；正式快照到会话差异仍有缺口（2026-09-08）

旧 unix-only 中断 Bash 测试的有效要求（保留输出、统一截断、可找回捕获内容）已由前批两个 Formal 场景接替；不保留“取消必须 completed”和暴露宿主管理路径的旧形状。删除该测试后，两个输出场景及 Shell 排队取消 **3 pass / 38 断言 / 18.18 秒**。prompt.test.ts 已无 prompt.loop 直接调用，但全仓仍有 snapshot-tool-race.test.ts 的调用，生产 loop/runLoop 并未退役。

为迁移剩余快照竞态要求，新增 Formal 实际 Git 工作区、真实 L3 授权 Node 写入场景。最初验证 Core 历史：文件存在、工具 assistant 的 snapshot.start/end 均存在且不同、files 包含 race-test.txt、Provider 两次，**1 pass / 9 断言 / 13.16 秒**。这只证明内部快照，不足以替代旧用户差异要求。

随后加入实际 SessionSummary.diff 查询。首次测试误未装配服务；修正夹具为该专项显式装配真实 SessionSummary、其他 Formal 测试仍沿用原替身。最终 **0 pass / 1 fail / 9 断言 / 18.21 秒**，五秒查询仍无 race-test.txt，错误为 Formal user-facing file diff missing，而不是服务缺失。源码确认现有 diff 只读取旧 user.info.summary.diffs；旧 summarize 从旧 step 快照计算，且调用点在旧 runLoop。Formal Core 已生成快照但该查询链没有消费，不能靠恢复旧 Loop 或另造快照库解决。原 snapshot-tool-race 测试保留，新失败不 skip；下一步融合查询到唯一 Core 快照/差异服务并验正式接口。

Arforge typecheck 修正 RelativePath 测试断言后最终退出 0。当前并非全部测试通过，R05 不关闭；仅隔离测试与证据改动，无真实用户数据、全局入口或 full sandbox 操作。

## 中断的模型 Bash 输出经原统一管线保留（2026-09-08）

下方此前失败的输出丢失场景已在本次范围内修复。AppProcess 合并输出流在捕获时提供观察钩子，Bash 仅保存原 1 MiB 捕获上限内的标准输出快照；ToolRegistry 的中断清理调用原 ToolOutputStore.bound，经每次调用独立的 Ref 交接给 Runner。Tool.Failed 增加可选 content/structured/artifactRefs/outputPaths，原消息投影和后续模型消息转换消费错误结果的有界文本。没有第二执行器或持久化 owner，Bash 不生成管理路径，取消仍为 error 而非成功；旧事件缺少新增字段仍可解码且编码不凭空补字段。

正式入口真实授权 Node 命令的 400000 / 1200000 字节两场景 **2 pass / 0 fail / 28 断言 / 13.72 秒**：取消后预览小于 60000 字符、原 session owner 能读取唯一 opaque receipt、无旧 outputPaths；超过捕获上限标记 truncated，后续实际本机测试 Provider 请求包含已捕获输出。这里保留的是捕获上限内内容，不宣称超过 1 MiB 的完整 stdout 都已保存，也不宣称 SIGKILL 后能恢复内存中尚未交付的快照。

扩大 Core Runner/Registry/OutputStore/事件/消息/进程六文件 **214 pass / 0 fail / 1053 断言 / 62.17 秒**。随后新增进程观察钩子三项，验证截断前观察、就绪后取消保持纯中断、观察器 defect 不变成功；进程全文件最终 **25 pass / 0 fail / 59 断言 / 3.45 秒**，与前批重叠，不相加。Core 独立 typecheck 最终退出 0；workspace typecheck 22/22 successful 且全部缓存命中，不称无缓存全工程验证。13 文件 Oxlint **102 warnings / 0 errors**，警告未清零。

R05 尚未关闭：旧截断测试与最后一处该测试文件的 prompt.loop 调用仍待合同对照后退役；旧 loop/runLoop/Runner 全仓退役、完整失败冷恢复、错误 artifact 全客户端体验尚未验收。此次只用隔离实例/测试 Provider/授权临时进程，不操作真实用户库、凭据或全局 CLI，全平台 full sandbox 仍最后执行。

## 未通过：中断的模型 Bash 输出丢失（2026-09-08）

检查最后一项旧 Loop 截断测试发现实质功能缺口，未直接删除或弱化旧要求。新增 Formal 回归调用真实 Core bash 工具，经真实 L3 审批后，Node stdout 写入 retained-output-start 和 400000 个字符，再在写回调中创建隔离目录就绪文件；测试观察文件后公开 cancel。工具状态确实 error、模型请求仅一次，但 error.state.content 是 []，不含已产生输出。专项 **0 pass / 1 fail / 5 断言 / 8.51 秒**，失败断言明确为输出缺失。保留失败测试，不 skip、不把错误状态改成 completed；本批不宣称修复或测试全绿。

实码链路：Core Bash 只在 AppProcess.run 完成后转换 RunResult；AppProcess.collectStream 的部分缓冲不会在中断时交付；ToolRegistry 统一 ToolOutputStore.bound 目前只处理完成的 PipelinePending；Runner 对中断调用发布 Tool.Failed，没有部分内容。故不能通过更换旧字段名完成迁移。仍需在同一执行/输出管线保留中断前捕获内容，并补管理存储引用的错误结果投影；不得由 Bash 自建 outputPath、另造存储 owner 或吞掉 interruption/defect。

本批仅增加实证失败回归、整理证据。格式/diff-check 通过，测试文件 lint **29 warnings / 0 errors**；类型检查另行执行，类型通过也不能替代这个失败验收。旧中断截断测试和最后一处 prompt.loop 调用暂保留，R05 继续；无真实用户库/凭据/全局入口或 full sandbox 操作。

## 取消后重复 wake 不得自动重启、忙碌保护迁入 Core（2026-09-08）

将旧“interrupted orphan 无额外请求”的要求融合到真实 scheduled=false/true 子任务取消回归，先复现普通模型 task 在取消后重复 wakeAndWait 时新增 assistant/模型请求，scheduled 场景没有触发。根因：paused 的原 semantic checkpoint 仍 needsContinuation，Core recoverable 路径不区分显式恢复与普通唤醒就领取 lease 并继续。现在原 prior 读取之后、领取 lease 之前，对 paused + force=false + 无 steer/queue 直接返回；显式 resume 和新输入保持可继续，running 的崩溃恢复不适用该拒绝条件。不清空检查点、不修改摘要、不另设恢复器。

正式测试确认两次普通 wake 后 Core 历史及完整 DurableRun 列表不变、模型请求数不增，随后显式 resume 正常回答。删掉旧 synthetic MessageV1 orphan/loop 回归，不恢复第二引擎。原 busy/idle assertNotBusy 测试融合为真实 Core.updateTags：空闲成功，公开模型请求启动后抛 Core BusyError，取消后再次成功；移除旧独立 idle 检查。不是只检查展示层 busy 标记。

最终两种子任务专项 **2 pass / 42 断言 / 14.24 秒**；此前扩大取消、新用户输入及真实忙碌保护 **6 pass / 99 断言 / 28.02 秒**（与专项重叠，不累计）；Core Runner 全文件 **117 pass / 557 断言 / 56.93 秒**。Core/Arforge typecheck 退出 0，格式/diff-check 通过，双文件 Oxlint **47 warnings / 0 errors**。源码库存、桌面计划同步。

本文件 prompt.loop 直接调用剩 1 处（中断 bash 工具截断），不是全仓旧路径只剩一个；低层旧 Shell 夹具、旧 loop/runLoop/Runner 物理退役、冷恢复及全部取消/新输入竞争仍未完整验收。paused guard 是读取时判定，不声称覆盖跨进程状态替换的全部交错。R05 不关闭，未触碰真实用户库/凭据/全局入口或后置 full sandbox。

## 旧 Shell 桥接移除与排队取消迁移（2026-09-08）

全量搜索确认产品 SessionPrompt 已不消费旧 SessionRunState.startShell；本批删除该服务接口、实现及 Latch import，不保留第二 Shell 桥接入口。通用旧 effect/Runner 的 Shell 状态代码及其单元测试尚在，不能把本次桥接移除称为完整旧状态机退役。

原 unix-only “cancel interrupts loop queued behind shell” 迁为 Formal 实际公开 Shell：授权 Node 写就绪标记后挂起，再 admission prompt 并创建两个 wakeAndWait 等待者，公开 cancel 后两者均以纯中断结束、Shell 返回可读结果、Core active 清空、Provider=0，唯一 Shell 历史保留已启动中断说明和部分输出，无幽灵 Core assistant。不把旧 Loop 返回 assistant 的形状强加给 TS 执行等待接口，也不使用固定 sleep 等待启动。

专项 **1 pass / 10 断言 / 8.87 秒**，最终 direct Shell 筛选 **15 pass / 0 fail / 129 断言 / 68.91 秒**，104 未匹配。Arforge typecheck 退出 0，格式/diff-check 通过，双文件 lint **27 warnings / 0 errors**。prompt.test.ts 旧 prompt.loop 直接调用现剩 3 处，仅是该文件的消费者计数，不是整个 R05 剩余任务数或完成率。库存/桌面证据同步。

仍需旧 orphan/忙碌检查/工具截断等消费者迁移、无正式 owner 的旧低层 Shell 夹具处理、旧 loop/runLoop/Runner 物理退役、失败重放与冷恢复等。R05 不关闭；本批仅源码与隔离测试/证据，无真实用户数据、全局入口或 full sandbox 操作。

## 直接 Shell 产品入口接入同一 Core 协调器（2026-09-08）

SessionExecution 正式合同增加 exclusive，Formal/local 适配器委托原协调器；记录专用 noop 明确拒绝执行，测试替身不伪装成功。SessionPrompt.shell 不再调用 SessionRunState.startShell，也没有缺少正式 owner 时的旧执行回退。Shell 与模型请求共用 active、独占检查、排队和 interrupt；原状态事件保留为展示投影。Shell 返回原结果形状，Gateway/语义摘要/审批级别未另造。旧状态机代码及尚未迁移的旧消费者仍存在，不宣称物理退役完成。

协调器独占工作增加 beforeInterrupt 钩子；中断先封住当前唤醒，再等待 Shell 身份就绪，执行原 cancelLocal 的 durable 授权处理和会话待审批取消，最后中断并等待清理。准备失败也打开就绪 latch，避免取消死等；没有新增第二占用表。public cancel 顺序调整为正式 owner 中断后做遗留清理，避免先取消同一 Shell 授权再重复处理。新增 Deferred 回归验证 cancel-action → cancel-session → cleanup 的顺序；Core 协调器全文件 **29 pass / 74 断言**。

五项原 direct Shell 夹具切换到 Formal。新增 approval/running 两个正式场景：审批队列或真实 Node 输出提供就绪信号，运行场景通过隔离目录中的 release 文件放行，期间第二 Shell BusyError、Provider=0；两个排队等待者最终消费一份 Shell 输出、只请求模型一次、只有一个 Core assistant，active 清空。替换两项旧 Loop 固定 sleep 并发测试；另将“模型运行中 Shell 拒绝”测试迁为公开 prompt，确认 BusyError 且 Shell Action=0。没有用仅顺序执行代替运行中等待合同。

运行场景夹具首次误用不存在的 FSUtil.writeText 后失败，改用现有 writeText fixture；两场景最终 **2 pass / 22 断言 / 13.80 秒**。扩大正式取消/direct Shell 批 **26 pass / 0 fail / 326 断言 / 105.80 秒**，93 未匹配；之后新增模型忙碌专项 **1 pass / 7 断言 / 6.46 秒**。Core 六文件 **190 pass / 811 断言 / 66.26 秒**；固定历史六场景 **8 pass / 223 断言 / 14.16 秒**，不重录。Core/Arforge typecheck 均退出 0，13 文件格式/diff-check 通过，Oxlint **130 warnings / 0 errors**（未清零，非整仓 lint）。

仍未验收：真实准备阶段取消所有交错、独占调用方断开后的完整生命周期、冷恢复与失败重放、所有旧 Shell/Loop 消费者以及 SessionRunState/旧 Runner 的物理退役。未跑整份 prompt 测试或全仓全量；旧低层无执行器 Shell 夹具需继续迁移，不能视作全绿。R05 不关闭；仅源码、隔离进程/数据测试及证据，未触碰真实用户数据、凭据、全局 CLI 或后置 full sandbox。

## Shell 同一协调器融合前置：一次性独占工作（2026-09-08）

实码确认直接 Shell 仍调用 SessionRunState.startShell，而 Formal drain 使用 Core SessionRunCoordinator，两者占用状态尚未统一。为移除该分离，在原 Core 协调器添加 exclusive(key, work)：沿用同一 active map、owner fiber、interrupt 和 settlement；忙碌返回 false 且不执行工作。一次性工作退出后排队 wake 使用全新普通 drain，不继承命令；run/wakeAndWait 在独占期间等待后继 drain，不把命令完成误当成模型请求完成。未增加另一调度器或另一个持久化 owner。

先新增三项测试验证接口缺失，再实现并扩展为五项：成功/失败均只执行一次并合并唤醒；run 与 wakeAndWait 两个并发等待者随后进入同一 drain；正常 drain 运行时拒绝独占；interrupt 完成清理、取消已有 pending wake，后续新请求仍可用。以 Deferred 控制顺序，不依赖固定 sleep。全文件 **28 pass / 0 fail / 69 断言**，Core typecheck 退出 0，格式/diff-check 通过；双文件 lint 1 warning / 0 errors（原 owner Fiber 默认类型参数告警）。

**本批仅完成共享协调器前置，不代表 Shell 产品入口已经融合。** SessionExecution/SessionPrompt 的实际接线、审批就绪取消窗口、公开 prompt 并发等待、旧 Shell 状态机退出仍为下一步；既有旧 Loop 并发回归保留。R05 不关闭，未执行 full sandbox，无真实用户库/全局入口或凭据变更。

## cmd.exe 原始命令传递修复（2026-09-08）

新增共享 CrossSpawnSpawner 回归，修复前明确复现 Node 命令空输出。只读 spawn 对比中同一命令默认 Windows argv 转义返回 0/空输出，windowsVerbatimArguments=true 返回 17/cmd-output。现共享启动层仅对 Windows 显式 cmd/cmd.exe 使用原样参数，Shell.args 以 /d /s /c 和外层引号传递完整命令，禁用 AutoRun；非 cmd 的参数转义保持原状。没有另建 Shell 启动器或放宽审批。

新增真实 cmd 含引号的可执行路径/参数和非零退出回归；原正式非零 Shell 场景扩为 PowerShell/cmd，验证输出、exitCode=17、Action blocked/failed、Core 历史及后续 Provider 消息一致。参数化测试曾因局部 shell 消息变量遮蔽配置变量失败，改名 configuredShell 后再验证。Core spawner/shell 两文件 **38 pass / 0 fail / 56 断言 / 6.10 秒**；正式 direct Shell 筛选 **11 pass / 0 fail / 90 断言 / 49.48 秒**，108 未匹配。Core/Arforge typecheck 均退出 0，四文件 Oxlint **34 warnings / 0 errors**；格式随后修整。

上述为本机 Windows 命令功能测试，不是三平台 full sandbox 验收；没有证明所有 cmd 元字符、编码、AutoRun 环境、失败重放或冷恢复组合。旧 Loop 退役和 Shell 执行中协调继续待完成，R05 不关闭。仅源码/隔离测试和证据更新，无真实用户库、凭据或全局入口改动。

## 非零 Shell 退出不再记录成功（2026-09-08）

新增回归复现非零进程被标 completed：原实现等待 handle.exitCode 却丢弃返回值。现检查宿主 Shell 退出码，非零通过 DirectShellExitError 进入既有 Gateway 失败链，不将“进程已结束”当成“命令成功”。错误携带退出码、有界输出和截断路径；原 fail 投影保留 exitCode/output 元数据并写入 Core Shell 历史。Gateway 原 Action observation=failed/status=blocked，未新增重试或第二结算 owner。

最初 Node process.exit(17) 经默认 PowerShell 返回宿主码 1；这是被执行 Shell 的退出语义，不能强行写 17。测试改为明确选择 PowerShell（POSIX 为 /bin/sh），命令输出后由 Shell 自身 exit 17，验证旧工具 error/exitCode=17/output、唯一 Action blocked/failed observation、Core 历史与随后 Provider 消息包含 code 17/输出。专项 **1 pass / 12 断言 / 8.91 秒**；全部 direct Shell 筛选 **10 pass / 0 fail / 78 断言 / 44.24 秒**，108 未匹配。Arforge typecheck 退出 0、格式/diff-check 通过，双文件 lint **38 warnings / 0 errors**。

另观察到显式 cmd.exe 配置执行同类 Node 命令时空输出且返回 0，原因尚未定位；不算验证通过、不以改测 PowerShell 掩盖，下一步需检查 Shell.args/CrossSpawnSpawner 的 Windows 命令传递。非零结果的重放/冷恢复与独立 spawn 失败仍未验收。临时诊断日志已删除，源码/库存/桌面计划同步。R05 未关闭，full sandbox 后置；仅隔离实例和授权测试命令，无真实用户数据/全局入口变更。

## 直接 Shell 拒绝及取消结果进入同一 Core 历史（2026-09-08）

新增正式拒绝/执行前取消测试先复现 Core Shell 记录为零。将上一批成功投影提取为同一个 publishShellHistory，原 fail/cancelled/handoffUncertain 分支复用，保留身份/输出一致性检查。拒绝/失败写明失败说明；执行前取消明确未启动；执行后取消明确已启动、durable action blocked for review，并携带原有界部分输出/截断说明；不把 handoff uncertain 谎称未执行。未新建事件类型、结果 owner 或自动重试路径。

三项正式测试验证唯一完成 Shell 记录、拒绝/取消说明、拒绝前不产生实际输出，真正授权 Node 输出就绪后取消的场景保留 partial marker；之后公开 prompt 的真实本机 Provider messages 包含完整说明，总模型请求仅一次。最小批 **3 pass / 28 断言 / 23.75 秒**。全部 direct Shell 筛选最终 **9 pass / 0 fail / 66 断言 / 47.96 秒**，108 未匹配，包含既有权限、重放、高输出和最小环境测试。

工作区 typecheck **22/22 successful、18 cached、38.765 秒**；Arforge/Core/LLM/Server 为本次实际执行，其余不得称 fresh 全量。格式/diff-check 通过，双文件 Oxlint **38 warnings / 0 errors**。库存/桌面计划同步。handoff uncertain 投影已接线但未在本批注入故障验证；独立 spawn 失败、非零进程退出语义、压缩后重放、半写/新进程恢复和执行中协调仍需续验，R05 不关闭。仅临时实例/授权测试进程，无真实用户库/凭据/全局入口改动，full sandbox 后置。

## 直接 Shell 已结算输出接入 Core 历史（2026-09-08）

检查旧 Shell 并发测试时先新增顺序前置回归，复现真实命令完成后，公开 prompt 的 Provider messages 不含 Shell 输出。原执行只保存旧消息，Core 已有 Shell.Started/Ended、Shell message 和 toLLMMessages 消费，但该入口没有发布。现完成路径复用这组事件，使用原 durable assistant/call 身份记录已结算命令及有界输出；随后 Formal 请求直接通过原历史转换读取，不临时拼接 prompt、不增加独立结果 owner。

重放先检查原 Core 消息身份/命令；完成输出须一致，不一致失败关闭。已有完整投影不重复发事件，未完成投影可补 Ended（该部分当前仅实码路径，尚未注入半写故障验证）。Core 历史解码错误按现有 Shell 边界传播为 defect，不吞掉错误。保留原并发等待测试，本批新测试不替代“执行中等待”的旧合同。

新增测试通过实际授权 Node Shell 输出唯一标记、重放同 messageID 后完整 Core context 不变且 Shell message 恰一条、后续实际 Provider messages 含输出、最终回答正确。最初失败复现后，专项 **1 pass / 6 断言 / 13.23 秒**；增加重放检查后连同直接 Shell 授权/重放/待审批取消/高输出/最小环境最终 **6 pass / 0 fail / 38 断言 / 26.08 秒**，108 未匹配。随后修正 MessageDecodeError 的边界类型，Arforge typecheck 最终退出 0，格式/diff-check 通过，双文件 Oxlint **38 warnings / 0 errors**。

仍未完成：Shell 失败/取消结果 Core 历史投影、执行中与正式 prompt 的协调、压缩后重放、半写/新进程恢复及事件原子性。R05 不关闭；成功输出接线不是整个 Shell 融合验收。源码/库存/桌面证据同步，仅隔离临时实例测试，未改全局 CLI、真实用户数据或 full sandbox。

## L3 Shell 拒绝与 L2 单次授权迁移（2026-09-08）

旧 L3-shell preflight 和 approved-L2 测试改走 Formal SessionExecution，不再传人工 runID。L3 即使 session bash allow 仍 requiresHumanConfirmation，保留 command/resources/tool source/riskTier 检查；审批前和拒绝后均无 marker、Action attempt=0、审批队列清空。标记命令改为当前宿主默认 Shell 可理解的 echo 重定向，不再用只适合 PowerShell 的 Set-Content 让误执行也无法留下标记。元数据按 TS 原字段，不要求旧桥接 source/tool 标记。

L2 正向用 Core write 的 path 参数，单次 once 批准后完成写入、Core/旧权限队列均为空，Provider 共两次；没有为避免二次审批而设置额外授权。最后一个 activeDurableSessionRun 调用移除后，删除其人工 create/transition/beginAttempt 辅助函数。

最小两项 **2 pass / 16 断言 / 12.42 秒**；最终含 L2 拒绝与 direct Shell 授权/结果重放 **5 pass / 0 fail / 44 断言 / 21.34 秒**，108 未匹配。Arforge typecheck 最终退出 0，Prettier/diff-check 通过，Oxlint **27 warnings / 0 errors**。无产品运行逻辑改动，只有测试/库存/桌面证据更新；该拒绝用例由零 attempt 和无文件证明未进入执行，不额外声称采集过 OS spawn 跟踪。Shell 输出/并发等旧消费者及物理 loop 退役仍未完成，R05 不关闭，真实 full sandbox 最后执行。

## 写入结算与 L2 拒绝迁入 Formal（2026-09-08）

旧 mature-write 与 L2-preflight 两项测试改用正式 SessionExecution，不再人工创建 active runID 或调用旧 loop；从真实 ActionProposed 的 session/name 取得实际 run。保留文件内容、L2/scoped_grant、成功 observation 摘要及 authorized→executing→observed→settled 转换断言，禁止 executing 后再次等待审批。

最初沿用旧 filePath 参数导致正式 schema 拒绝、无文件/无审批，修正为现有 Core write 的 path；随后旧桥接 metadata.source/tool 断言失败，改验 TS 原 authority/filesystemScope/riskTier 和 tool source，不为旧测试增加兼容字段。L2 请求仍为 edit，审批前文件不存在且 Action attempt=0；拒绝后新增检查 attempt 仍零、唯一 write 为 error、审批队列清空、旧 assistant=0。无生产逻辑或权限放宽。

初步两项 **2 pass / 22 断言 / 10.73 秒**；加强拒绝断言并连同已有“写入成功后 EOF/继续不覆盖用户修改”测试最终 **3 pass / 0 fail / 43 断言 / 13.42 秒**，110 未匹配。Arforge typecheck 最终退出 0，Prettier/diff-check 通过，Oxlint **27 warnings / 0 errors**。这是隔离临时文件/HTTP/SQLite，不是实际用户库、全平台文件系统或全仓验收。R05 其他旧工具/Shell 消费者仍待迁移，full sandbox 后置；依赖库存及桌面计划同步。

## 取消工具终态断言融合、移除旧 task.execute 替身（2026-09-08）

将旧 cancel-finalizes-subtask 用例的生命周期要求融合到已有 scheduled=false/true 正式元数据回归：取消后按原 call ID 找父工具，必须 error、assistant completed、structured.sessionId 保留；BackgroundJob 必须 cancelled，SessionExecution 不再活动。原有唯一 child、DurableRun cancelled、无 attempt/lease、无额外请求和旧 assistant=0 检查仍保留。先以两项 **2 pass / 34 断言 / 12.71 秒** 验证，再删除旧整项测试及其 task.execute 临时改写、abort 监听替身与旧 loop 调用。

这是将可观察取消生命周期融合到实际父子执行链，不再依赖旧回调替身的 abort 信号，也不将“取消”错误地要求成成功 finish；不宣称已验证所有外部工具/网络连接的物理中止。最终连同父/子取消、公开 slash 取消 **5 pass / 0 fail / 71 断言 / 25.81 秒**，108 未匹配。Arforge typecheck 退出 0，格式/diff-check 通过，Oxlint **27 warnings / 0 errors**。没有产品代码改动，依赖库存/桌面计划同步。旧 Loop 其他行为消费者仍待迁移，R05 未关闭，full sandbox 后置；仅隔离测试和证据更新。

## 模型准备阶段取消竞态迁入 Formal（2026-09-08）

旧 processor-create 竞态用例改到正式 SessionRunnerModel 解析前的测试屏障：共享 Formal HTTP 工厂可注入 beforeModelResolve，仅此专用夹具在 Deferred 就绪后暂停，其他 Formal 夹具默认无屏障。连续两次公开 prompt 在屏障处被公开 cancel，中断原因保留，Provider=0，Core assistant=0，执行 active 清空、状态 idle、DurableRun paused 且无 lease；第三次公开输入成功且只产生一次 Provider 请求/一个有效 assistant，旧 assistant 始终零。

不再要求旧引擎预建两个空 assistant 并补 MessageAbortedError；按 TS 原消息创建时序验证没有幽灵输出。旧 blockingProcessor、processorCreateStarted、raceNoLLMServer 和三个旧工厂的 blocking 选项已移除，不保留专用于旧 Processor 的执行替身。专用 Deferred 队列由测试前后清理；无固定 sleep，无生产行为改动。

最小专项 **1 pass / 25 断言 / 6.71 秒**；最终连同无响应取消、MCP 根/child、失败子模型与 slash 取消 **7 pass / 0 fail / 91 断言 / 29.99 秒**，107 未匹配。Arforge typecheck 退出 0，格式/diff-check 通过，Oxlint **27 warnings / 0 errors**。本批未跑整文件或整仓；测试模拟模型解析暂停，不是所有准备步骤、新进程或外部服务取消验收。R05 其余旧消费者和 loop/runLoop 退役尚未完成，full sandbox 后置。依赖库存及桌面计划同步，仅隔离测试与证据更新。

## Slash 子任务取消后父工具残留 running 修复（2026-09-08）

将旧 slash 取消测试迁入真正公开 command（配置 review/subtask=true），不再用旧 user/addSubtask/loop 模拟命令。新增断言先复现：child DurableRun cancelled、attempt/lease 已释放，父 task 仍 running。原 failInterruptedTools 为保留 scheduled 恢复身份一律跳过；executeScheduledTask 中断直接退出，父终态缺少投影。

复用原 failInterruptedTools，在父 run onExit 已核对 lease 身份之后，专门投影当前 run 下 Gateway 已 blocked/cancelled 的 scheduled task：发布既有 Tool.Failed、Step.Failed，保留原 structured 元数据。没有改 Gateway 状态，也不将跨执行边界后的 blocked 谎称安全取消；最初只匹配 cancelled 的修复仍失败，实际诊断为 blocked 后才修正。其他 run、未终结 Action 和启动恢复路径继续保留原前缀，不清除可恢复任务。临时诊断日志已删除。

公开 command → child 请求 → prompt.cancel → 新 prompt 测试验证父/子 idle、child cancelled/无 attempt/lease、父 tool error/assistant completed/原 sessionId 保留；重复取消后 context 不变，新输入正常回答，child 始终一个、Provider 共两次、旧 assistant 为零。相关最终批 **10 pass / 129 断言 / 44.55 秒**，104 未匹配；六类固定历史基线文件 **8 pass / 223 断言 / 16.71 秒**。补消息联合类型判别后专项再跑 **1 pass / 20 断言 / 8.65 秒**，Core/Arforge typecheck 最终均退出 0；格式/diff-check 通过，双文件 Oxlint **44 warnings / 0 errors**。

本批没有覆盖租约检查后被替换的所有竞态或真实冷恢复；剩余旧消费者/旧 loop 物理退役仍待推进，R05 未关闭，full sandbox 后置。仅源码、隔离临时测试和证据，不触碰真实用户数据/凭据/全局入口。

## 运行中任务元数据、取消和状态投影迁移（2026-09-08）

原 running subtask / running task tool 两项测试融合成 scheduled=false/true 的 Formal 场景：公开 prompt admission、SessionExecution 唤醒，等待实际 child Provider 请求就绪，从 Core context 读取运行中的 task。验证唯一子会话、structured.sessionId 与该子会话一致、title=inspect bug、model 与原 ref 一致。替换旧 MessageV2/loop 消费，状态异常不再悄悄 return。通过公开 prompt.cancel 后，子 DurableRun cancelled、无 activeAttempt、无 lease，请求总数保持 model task 两次或 scheduled 一次，旧 assistant=0。

原 busy→idle 测试也改用 Formal，保留现有 SessionStatus 用户提示投影，新增与 SessionExecution.active 的一致性断言：admission-only 为 idle/非活动，Provider 启动后 busy/活动，取消收尾后 idle/非活动，模型请求恰一次。未新建状态 owner，未修改产品运行时。

两项元数据最小验证 **2 pass / 24 断言 / 12.59 秒**；最终三项加原父/子取消回归 **5 pass / 0 fail / 50 断言 / 23.50 秒**（109 未匹配）。最终 Arforge typecheck 退出 0、Prettier/diff-check 通过；Oxlint **26 warnings / 0 errors**。本文件旧 prompt.loop 调用从 19 处降至 16 处，不换算总体完成率；本批未重跑前批的 64 项筛选或整仓全量。

剩余旧 orphan/取消竞态/写入和 Shell 行为消费者仍待退出，旧 loop/runLoop 尚未物理退役，R05 不关闭。上述为隔离 HTTP/SQLite 实例，不是实际用户界面或真实 Provider 全旅程。依赖库存及桌面计划同步；未操作真实用户数据、凭据、全局 CLI 或 full sandbox。

## 已完成回合重复唤醒迁移及扩大回归（2026-09-08）

原 stop-finish 测试不再 seed 旧消息或调用旧 loop。通过公开 prompt 实际完成一次 Formal 请求，再连续两次 wakeAndWait；断言原 Core assistant finish=stop、完整 context 不变、Provider 总请求保持一次、旧 assistant 为零。没有为兼容测试增加第二执行器或修改生产语义。本文件旧 prompt.loop 直接调用从 20 处降至 19 处，不表示任务数或总体完成率。

最小专项 **1 pass / 8 断言 / 6.58 秒**；随后 `bun test test/session/prompt.test.ts --test-name-pattern 'Formal|direct Shell' --rerun-every` 最终 **64 pass / 0 fail / 789 断言 / 237.36 秒**，50 项未匹配，非整文件或整仓全量。扩大覆盖近期模型夹具路由、MCP 根/child 权限上下文、审批正反和持久化前缀，以及原恢复、取消、结构化输出和直接 Shell 场景。

Arforge typecheck 退出 0，Prettier 与受影响文件 diff-check 通过；仓库 Oxlint 为 **27 warnings / 0 errors**。曾误调用不适用的 ESLint，因仓库无其配置退出，未作为验证通过；随后使用仓库 Oxlint，未改项目依赖。依赖库存已再生。下一组为运行中子任务元数据/取消等旧消费者；R05 尚未关闭，真实 Provider/MCP、冷恢复完整边界和用户验收不能由本地夹具替代，full sandbox 仍后置。仅测试和证据更新，未操作真实用户数据或全局入口。

## 审批前已持久化工具记录的 Formal 复用（2026-09-08）

原 scheduled subtask recovery 用例退出旧 loop/旧消息写入。先通过实际正式请求建立语义 epoch，再 admission 子任务并按当前 cutoff 提升一次 steer，以 Core 事件构造审批前的 running tool。固定 assistant ID 遵循现有 session/task 哈希身份，使用正式 resume 验证不重建 assistant/call，Action subject 绑定原 ID；拒绝后 child=0、同 ActionProposed 恰一次、旧 assistant=0，父任务仍正常回复。没有人工指定 runID，也未改产品恢复逻辑。

初始夹具误提升 queue，造成来源未进入历史；已按 admission 实际 steer 类型修正并断言提升数=1。普通 wake 与显式 resume 的语义区分保留。此为手工 Core 事件模拟的持久化前缀，不是 SIGKILL/新进程恢复证明。

审批批准/拒绝加前缀复用最终批 **3 pass / 44 断言 / 17.44 秒**（111 未匹配）；随后补显式 assistant 类型谓词，Arforge typecheck 最终退出 0，格式已重整、diff-check 通过；本文件 lint **27 warnings / 0 errors**。R05 其他旧消费者、完整恢复和用户验收仍未完成，full sandbox 后置。仅隔离测试与证据，无真实用户数据或外部服务操作。

## 子任务审批正反场景迁入 Formal（2026-09-08）

原 scheduled subtask 审批测试不再人工注入 runID 或调用旧 loop；通过正式 prompt admission 和 SessionExecution 执行，从真实 ActionProposed 读取原 run 归属。保留请求 action/task、general 资源、Gateway L2 元数据、旧权限队列为空、审批前无 Action attempt/child 的断言，并增加审批前 Provider=0。

扩展批准/拒绝双场景：批准后一个 child、一个原 Action attempt、child/parent 两次请求、task completed；拒绝后 child/attempt 均零、task error，父任务发一次请求回复用户。初次扩展误预期拒绝后总 Provider=0，实际父任务需要消费拒绝结果；现按原正常继续语义断言父回复文本，不把拒绝误改为取消整轮。两条路径都清空 Core 待审批列表，不新增权限 owner。

补齐 Action 联合类型 sessionID 判别后最终专项 **2 pass / 32 断言 / 13.15 秒**，112 项未匹配；Arforge typecheck 最终退出 0，格式已重整，diff-check 通过，单测试文件 lint **26 warnings / 0 errors**。本批未改产品逻辑。原审批恢复、取消竞态等旧 Loop 消费者仍待迁移，R05 未关闭，不代表新进程审批恢复或全部用户旅程已验收。仅隔离测试与证据更新，未触碰真实用户数据/全局 CLI/full sandbox。

## 空错误兜底及失败子任务元数据迁移（2026-09-08）

BackgroundJob.errorText 原先直接返回 Error.message，空 Error、空白消息、带结构化字段但无 message 的 Schema 错误均会留下空提示。新增回归先失败，现在同一函数对空白消息返回 Background task failed without an error message.；不展开结构化私有字段/堆栈，已有非空错误原样保留。测试同时断言 status=error、原 sessionId 元数据保留；全文件 **7 pass / 425 断言 / 187 毫秒**。

旧 failed subtask 测试迁到 Formal/Core，删除缺少 assistant/tool 时悄悄 return 的路径。原夹具模型解析器固定 test-model，不适合验证模型缺失；现本机模拟 resolver 保留实际 session.model 的 ID/provider，HTTP 400 明确模拟子模型不可用。测试确认两次请求、第一请求 missing-model、工具 error 含 Provider 原失败消息，structured 中保留 child sessionId 和 missing-model。该调整不改生产模型路由，也不将模拟 400 称为真实模型目录校验。测试期限 15 秒容纳真实父子初始化，未跳过失败断言。

最终外部子工具批准、命令子任务、失败元数据、权限不继承四项 **4 pass / 48 断言 / 22.31 秒**（109 未匹配）；Core/Arforge typecheck、格式/diff-check 通过，三文件 lint **27 warnings / 0 errors**。未执行整个 Formal 筛选或整仓全量；R05 其余旧 Loop 消费者、真实用户验收及真实平台 sandbox 后置要求不变。仅修改源码、隔离测试和证据，不接触真实用户数据、凭据或外部 Provider。

## 无命令子任务检查点摘要失配修复（2026-09-08）

将外部目录权限不继承用例迁入正式 prompt 子任务 admission 时，新增真实执行断言先失败：child 已创建，但父请求只有一次、task 错误为空。隔离诊断追到 DurableRun.CorruptHistoryError，sequence=1 的检查点摘要/恢复令牌校验拒绝。根因是 Core scheduledTaskInput 无条件写 command: undefined；canonicalHash 明确区分缺失字段与 undefined，JSON 持久化却丢弃后者。原构造器现仅在 command 存在时写入，不改变摘要算法或放宽损坏校验。诊断用临时日志、审计读取均已撤去，不保留调试输出。

正式无命令子任务与命令子任务专项 **2 pass / 28 断言 / 12.89 秒**。无命令场景确认两次模型请求、task completed，并保留全部原权限断言：项目 read allow、父 /tmp/allowed/* 的 external_directory allow 不继承、外部访问和递归 task 均 deny。Core/Arforge typecheck、格式/diff-check 通过，两文件 lint **43 warnings / 0 errors**。此修复使原错误不再触发，不等于通用空错误提示已修复；旧 failed subtask 元数据测试与该错误展示缺口仍待接续。R05 不关闭，full sandbox 后置；仅隔离临时数据测试，未触碰真实用户库或外部 Provider。

## MCP 指令接入 Formal 语义上下文（2026-09-08）

旧 MCP 指令测试切到真实 Formal 根后失败：Provider 请求没有 server instructions。原 SystemPrompt.mcp 具备权限过滤和 ContextFirewall 不可信包装，但正式 Core 上下文没有消费。现 Core SessionRunner 增加作用域 ExternalContext 来源引用，由 Formal 根/child 同时提供；结果进入原 loadSystemContext.combine 与 SessionContextEpoch.initialize/prepare，而不是在 HTTP 发送前追加字符串或注册 Location 共享闭包。Core 不依赖 Arforge/MCP 实现。

Formal 按当前 session 和实际 agent 读取原 SystemPrompt.mcp，复用权限合并及不可信来源标记，以 mcp/server-instructions 键纳入现有语义快照；指令不再可用/被权限过滤时通过原移除语义告知模型忽略此前内容。无新上下文 owner、无第二执行器，读取失败不降级回旧 Loop。原测试夹具融合到 Formal 工厂，保留旧 processor 抛错哨兵。

四项正式测试 **4 pass / 20 断言 / 17.60 秒**：根请求实际包含指令；同会话撤权后的下一请求包含移除通知；新 denied 会话无指令；child 未委派能力无指令、显式委派 lookup/read 才有。最初 child 默认可见预期失败，核对实际权限后拆成正反案例，没有放宽默认 child 权限。六类录制加真实插件发现桥接两文件 **9 pass / 233 断言 / 16.44 秒**。Core/Arforge 类型检查、格式/diff-check 通过，四文件 lint **49 warnings / 0 errors**。

这里使用 MCP 指令服务替身和本机 HTTP Provider 夹具，不是实际 MCP server/远端模型全旅程；尚未证明断线代际变化、真实来源更新、多会话并发及冷重启的全部情况。本轮未跑完整 Formal 筛选或整仓，R05/R13/R19 不能关闭。安全自检：仅源码与隔离夹具/证据，未操作用户凭据、真实用户库、全局入口或 full sandbox。

## 未知工具拒绝及继续回复迁入 Formal（2026-09-08）

原 tool-calls 用例不再注入人工 active runID、调用 prompt.loop 或要求旧 invalid 工具产生成功 Action。按实际 Core materialize.settle 合同，未知名称在进入 executor/Action 前返回 Unknown tool 错误。测试经正式 SessionExecution 验证两个 Core assistant、原 first 工具 error、错误文本及同一 call ID 进入第二次 Provider 请求、最终 second/stop、旧 assistant 为零及临时库 ActionProposed 为零。此为无注册工具的拒绝语义，不是放宽已注册工具绕过 Gateway；原授权执行由 registry 回归继续约束。

最终相关四项 Formal 测试 **4 pass / 43 断言 / 13.77 秒**（106 未匹配），Core registry 全文件 **39 pass / 306 断言 / 3.60 秒**；Arforge typecheck、Prettier、diff-check 通过，测试文件 lint **25 warnings / 0 errors**。本批仅测试及证据变更，未改产品运行时。未知工具旧 Loop 消费已移除，MCP 指令及其他旧消费者仍待迁移，R05 未关闭，full sandbox 后置。

## 普通文本和多轮消费迁移、正式入口扩大回归（2026-09-08）

两个 static loop 行为测试改用实际 Formal SessionExecution.wakeAndWait 与 Core context，不再直接调用 prompt.loop；保留文本、请求次数、响应队列耗尽和原固定 parity 预期。多轮增加 Core assistant 恰两条、旧 assistant 零条断言。该文件最后一处 fromMatureMessages 消费随之移除，使用现有 fromCoreMessages，不建立测试兼容运行器。

最小两项 **2 pass / 18 断言 / 8.76 秒**；随后 Formal/直接 Shell 整个筛选批 **53 pass / 0 fail / 685 断言 / 187.82 秒**，57 项未匹配，不冒称全文件或整仓通过。覆盖外部工具审批、子代理恢复、后台通知、取消/并发、过滤与结构化输出、EOF 及直接 Shell。Arforge typecheck、Prettier 和受影响文件 diff-check 通过，单测试文件 lint **25 warnings / 0 errors**。本批无产品逻辑改动。

剩余旧入口包括 MCP 指令、未知工具旧 invalid 语义、子任务错误元数据/权限、取消竞态等；未知工具须按 Core 注册表拒绝语义融合，不应恢复 legacy invalid 工具。R05 未关闭，真实用户流程及其他工作包验收继续有效，全平台 full sandbox 仍后置。

## 内容过滤错误语义融合及结构化误重试修复（2026-09-08）

旧内容过滤测试迁入 Formal 后实际失败：Core assistant 有 content-filter finish，但 error 未定义、没有 Step.Failed。现原 createLLMEventPublisher 在 content-filter step-finish 发布既有 failAssistant，保留部分文本；原 Step.Ended 继续保存过滤 finish、token/cost。没有新增错误存储或兼容执行器。

追加 json_schema/retryCount=2 场景后再次复现错误：收到过滤结束仍发送三次请求。原 Core Runner 现识别该终止原因，跳过结构化纠正并禁止后续 continuation，学习维护按 ContentFilterError 失败记录，不把过滤算成成功。普通格式纠正仍保留原有预算与路径。两场景验证一次 HTTP 请求、Core error 持久化、失败事件、原 finish 及部分文本；没有实际外部 Provider 调用。

六项 Formal 筛选回归 **6 pass / 59 断言 / 18.64 秒**（104 未匹配）；六类历史录制文件 **8 pass / 223 断言 / 15.06 秒**。修正测试 expected.type 字面量推断后内容过滤专项最终 **2 pass / 16 断言 / 9.09 秒**，与前批重叠不累计。Core/Arforge typecheck 最终通过；三文件 lint **60 warnings / 0 errors**，未清零。R05 仍未关闭，其他旧 Loop 行为消费者和全计划退出条件继续有效；本轮尚未迁移工具错误测试，full sandbox 后置。

## 四项旧 Loop 行为测试迁入 Formal（2026-09-08）

请求级 system 冻结且只应用一次、StructuredOutput 一次纠正成功、精确耗尽重试额度三项测试改用正式 SessionExecution 和 Core context；保留原 schema、请求内容、次数、剩余响应与语义 parity 断言。关闭自动压缩时的 Provider 413 场景改走公开 prompt 正式入口。首次直接套用旧返回对象断言失败：正式调用传播 TS LLM.Error，而非返回旧 assistant。根据既有 Core 发布逻辑验证类型化 InvalidRequest/context-overflow、一次请求、Core assistant 错误持久化、无 Core/旧 compaction、旧 assistant 记录为零；未为兼容测试恢复旧错误 owner 或改变运行时。

最终四项专项 **4 pass / 0 fail / 43 断言 / 14.49 秒**，105 项未匹配，不是全文件或整仓回归；Arforge typecheck 退出 0，Prettier 已执行。本批仅迁移既有测试和维护证据，不宣称新增运行时功能。旧 loop/runLoop 与其余行为消费者仍存在，R05 不关闭；真实平台 full sandbox 继续后置。

## Formal 每轮外部来源接线与子工具等待死锁修复（2026-09-08）

Core Runner 新增执行作用域内的 ExternalTools 来源解析引用（只返回既有 AnyTool，不执行工具）；Formal 根 drain 和 runChild 都绑定原 ToolCoreBridge.snapshot。每个普通/结构化 Provider 回合在已确定当前 session/agent/model 后解析，并交给同一 ToolRegistry.materialize 的 externalTools 快照，达到步数上限时不解析/暴露普通外部工具。Core 不依赖 Arforge 源码，来源错误沿原执行失败路径传播，不切回旧 Loop。原桥接 register 已融合为 snapshot，使用当前请求的 agent/model/provider 和会话策略，不再从旧 session 默认模型猜测，不写 Location 注册表。原真实插件服务测试也随该接口迁移，未保留并行 register 入口。

正式 HTTP 录制服务测试先因 fixture 把整个 ToolRegistry mock 掉而无法准备内置任务；修正为隔离实例内仅替换 tools 来源、finalizer 恢复原方法后，实际请求中没有 plugin_echo 的缺口得到复现。接线后根调用批准/拒绝通过。子工具进一步复现：父 task 持有 exclusive 工具槽等待 child，child 的外部工具又在等同一槽，确认请求无法出现。现仅对 Core materialize 明确产生的受信任 modelTaskTool / scheduledTaskTool Registration 标记协调任务，调度器不让协调等待占用叶执行 permit 或成为 child quiesce 的自等待对象；实际工具仍走原 bounded safe/keyed/exclusive lane、Pipeline、Gateway、审批及结算。外部工具 metadata 不能设置此注册标记；普通可信 built-in、旧 carrier 或仅同名工具不获得此特权。任务 fiber 仍负责协调生命周期与取消，新增单 permit 嵌套执行/取消释放回归。

解除等待后，默认只读 child 按原策略拒绝 plugin_echo（不是接线失败）。测试没有放宽默认权限：批准/人工拒绝场景通过真实模型 task 参数明确委派 plugin_echo 的 write 能力；另保留未委派能力的拒绝场景。五个正式场景验证真实 Provider 请求可见外部工具、L3 requiresHumanConfirmation、确认前 execute=0、批准后 execute=1、拒绝/缺 capability 时 execute=0、结果进入下一 Provider 请求、child 使用 general 与自己的 Session、每轮使用实际 test/test-model。该来源目录替身不是已部署插件/MCP server；真实插件发现与 MCP generation-bound 执行另由桥接测试覆盖，不能把两者拼称生产全旅程。

最终验证：

- packages/arforge `bun test test/session/prompt.test.ts --test-name-pattern 'Formal|direct Shell' --rerun-every`：**45 pass / 0 fail / 608 expect / 178.84 秒**，64 项未匹配，不是该文件或整仓全量。
- Core registry + scheduler 两文件：**48 pass / 329 expect / 3.48 秒**，包括保留 exclusive/keyed 上限及取消/静默终止等待测试。
- 六类录制 + 两个桥接文件：**17 pass / 281 expect / 16.84 秒**；此前单独 9 项桥接与其重叠不累计。
- 工具管线审计测试：**6 pass / 18 expect**，覆盖缺 child 来源绑定与恢复旧共享 register 不能满足新检查。实际 auditToolPipelineTopology valid=true、fully_canonical=true、findings=[]；该标志只代表工具路径分类/接线静态合同，不能作为 R05 或全功能完成率。
- Core/Arforge typecheck 最终退出 0（中途 Entry 联合类型缺字段访问已用来源判别修正）；格式/diff-check 通过，本批 11 个 TS 文件 lint **76 warnings / 0 errors**，未清零。

剩余：MCP/插件在正式入口的真实来源生命周期、撤销/代际变化、并发 session 用户旅程、deferred discovery 与来源快照可见性对齐、带外部工具的冷重启接续等仍需验证；旧 loop/runLoop 及其剩余行为消费者仍需退出。不要重开已删除 Mature 执行适配器，不将普通测试重复扩展替代原 R05/R08/R12/R13/R19 退出条件。

composition digest `560dcd5a32eb31d4baa95e4bcca485355278ad367e5c5fcbacc00e8bc9a4a864`；dependency digest `11dfe9e3ac69df11f97f1a38d4ecc95a51716d0dc6b993ae7bc2fe35fb71d8e0`。安全自检：仅源码、隔离数据库/本机测试 HTTP 与文档；未使用真实用户凭据、外部 Provider/MCP、全局 CLI/PATH、发布或 full sandbox。R05 与完整目标继续保持未完成。以下 ATP-003 未通过等记述保留各历史批次边界。

## 正式外部工具接线前置：请求级 Core 快照（2026-09-08）

核查发现旧 ToolCoreBridge.register 写入 Location 共享注册表；该表同名最新注册胜出。将旧调用直接搬进 Formal，会使并发 session 的来源快照进入同一共享覆盖栈，不能满足每次请求的定义/执行一致性。实际 Formal 目前也未调用该服务；MCP/插件原定义投影留在旧 SessionTools 与桥接层。工具管线 ATP-003 继续作为未接线证据，不通过换检查字符串消除。

本批在现有 Core ToolRegistry.materialize 增加 externalTools 选项，仍仅接受原 opaque AnyTool；使用同一次 materialization 的 transient Registration 与原 settleWith/Pipeline/ActionGateway，不新增注册表、执行器或兼容工具类型。请求级工具不写入 Location/application 注册，捕获 Session 身份，拒绝跨会话调用；同名的不同 Session 快照保留各自定义与执行体。无 Session、非法名称、保留名称、与已注册项冲突均返回原 RegistrationError；普通权限过滤与 step-limit includeRegistered=false 生效。未知来源仍为 untrusted，不能靠自身 automaticRead 声明绕过 L3 人工授权。RunError 增补原 RegistrationError 类型，不吞错。

测试先证实缺少定义/未拒绝非法快照（2 fail）；实现后修正两处测试预期，实际默认字符串输出为 text、人工确认字段为 forceAsk。最终 Core `bun test test/session-runner-tool-registry.test.ts --rerun-every` **39 pass / 306 expect / 3.19 秒**，包含 4 项新增快照测试；Arforge 原 core-bridge 全文件 **8 pass / 48 expect / 3.42 秒**。Core/Arforge typecheck 退出 0，格式和 diff-check 通过，三个修改 TS 文件 lint **22 warnings / 0 errors**。不同批次不累计为验收百分比。

本批未声称并发 HTTP 用户旅程或真实 MCP server 已验收。尚须把现有来源解析融入 Formal/Core 的实际每轮请求准备，使用当前 agent/model/session 策略与该快照（包括子代理），验证 Provider 请求里的工具、执行/拒绝/结果回传和代际隔离；不能只在 root drain 临时注册一次或恢复旧 Loop。旧 register 服务待其生产消费者融合后再退出，deferred discovery 的来源设计也须对齐，不能遗忘。工具管线仍未通过、R05 未关闭、R08/R12/R13 等完整退出条件保持。

composition digest `79ad22de7b4a2302ecf2082c58d3aae242e34f410661d73d94646e8e551da9e2`；dependency digest `43a67e8657597d84e5cdc0c2b41f4bc2faf6f1df31ab09c2d130cc56e152849c`。安全自检：只修改共享 Core 管线及隔离测试、证据，不接触真实用户库、凭据、外部服务、全局入口或 full sandbox。

## 无消费者的 Mature 执行适配器退役（2026-09-08）

在六类录制迁移完成后，重新搜索实际源码导入，确认 `packages/arforge/src/session/execution.ts` 已无消费者，删除该 675 行旧适配器，不保留空壳或兼容重定向。其凭据分流、旧 Loop 调用、独立恢复扫描及结算装配随文件退出；Core/Formal 原有能力不重写。SessionPrompt.cancelLocal 不再对外暴露，内部直接 Shell/投影清理与公开 canonical cancel 保留。源码调用搜索已无 `.loop(` 生产调用，但 prompt.ts 内 loop/runLoop 定义和旧行为测试仍在，不等同整个旧状态机退役。

同步纠正审计：session-owner 不再强制旧适配器存在，恢复旧路径 loop/runLoop/cancel 调用会拒绝；composition 不再豁免旧路径 Runner 或接受 Mature provider，保留符号识别以发现重新引入，正式 fixture 使用 Formal。工具管线此前把旧 execution.ts 当 Formal 检查，现改查 execution-formal.ts。实际 session-owner valid=true；实际工具管线 **valid=false / ATP-003**，正式文件缺该注册前置接线，不能以旧适配器注册证明正式入口。必须继续检查现有工具来源与 Core 注册消费者，不为通过静态字符串检查盲目新增重复注册。

退役后六类回放 **8 pass / 223 expect / 13.85 秒**；四个审计测试文件 **20 pass / 57 expect**。Arforge typecheck 退出 0，格式/diff-check 通过；六个审计脚本 lint 7 warnings / 0 errors，prompt 源码及测试 lint 34 warnings / 0 errors。

扩大 Formal/直接 Shell 回归首轮 **38 pass / 2 fail / 521 expect**，两个失败为 preflight/failed 恢复 fixture 在构造遗留状态时被真实 scanner 抢先推进，导致 queued→preflight 非法倒退。修复只使用既有租约保护 fixture：在父 Action 结算前获取准备租约，遗留状态就绪后释放；不放宽生产状态转换、不屏蔽扫描器。六种恢复专项随后 **6 pass / 144 expect / 54.99 秒**；完整批次最终结果见下方补验。各批重叠不累加。

composition digest `dbf700a5b68fa9a6945e472c4a7faf00bf9a4cc54fcc98591102410a22584988`，Runner service uses 从 4 减至 3。dependency digest `5264a46d810187892574e72ce32d51f4060d85b9ecdd902be218435b41571944`。runner-negative 已刷新，但 learning-dream.ts 的 executionMode 仍触发现有 selector 检查，未宣称全审计通过；这与实际外部工具接线缺口均保留。R05 未关闭，后续先核实正式外部工具路径，再继续剩余 Loop 消费者退役。

最终补验：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal|direct Shell' --rerun-every` **40 pass / 0 fail / 565 expect / 149.89 秒**，覆盖六种 scanner、父子/后台/followup、公开取消、并发/EOF/reset、直接 Shell。64 项未匹配，不能称 prompt.test 全量通过；本批与恢复专项重叠不累计。composition validator 实际 valid=true，无 findings。learning-dream executionMode 实码是只读分析结果字段，不是执行器选择条件；现有名称匹配审计仍报出，暂不篡改结果或扩大本批修改范围。

安全自检：删除的是已无消费者的仓库旧适配器，可从 Git 基线恢复基线版本；未删除用户会话、数据库或配置，未修改全局 CLI/PATH、凭据、远程 Provider、发布或 full sandbox。以下为历史切片，不把此前“execution.ts 仍存在”当作当前状态。

## 六类录制完成独立 Formal 回放（2026-09-08）

最后的 action-replay 场景已解除 Mature：原 Core 工具 execute 计数为 1，两个完成工具结果均携带准确输出、完成时间；三条 assistant 正常结束，SQLite Action proposed/observed/settled 各一次，单次 run 结算与重新读取数据库一致，active 清理。三条严格 recorded request 的工具 schema 不变，第二条请求含一次结果、第三条含两次结果；固定历史 trace/budget/cursor/digest 与篡改检查保留。仅证明该确定性工具同 run 重放，不代替真实文件副作用强杀或冷恢复。

同时清理整个文件失去消费者的共享旧装配：Mature root/buildMatureCassetteLayer、旧 Prompt root、录制开关/服务、TestLLMServer、旧工具注册及可变回调、旧配置/插件/MCP/LSP 替身、admitParityEntry 和相关 import。实码搜索确认该文件无 SessionExecutionMature、旧 prompt/execution import、Mature history 比较或 record 分支；不为测试保留第二个可执行引擎。文件名暂保留 `mature-runner-recorded.test.ts` 以保持现有命令定位，内容已是六类 Formal/Provider 回放与中立历史 JSON，不据名字判旧引擎仍在执行。

专项 **1 pass / 30 expect**；共享清理后最终 packages/arforge `bun test test/session/mature-runner-recorded.test.ts --rerun-every`：**8 pass / 0 fail / 223 expect，13.63 秒**。Arforge typecheck 退出 0，Prettier 完成、diff-check 通过，单文件 lint **40 warnings / 0 errors**。dependency digest `0d6150bfaf7319818e9d4a69609ca795da2e262918645e19b34b4393add19088`。快于此前不作为功能完成率或性能承诺；专项与整批不累计。

这是 R05 中“六类录制比较不再依赖活 Mature 引擎”的实际完成切片，不是整个 R05 关闭。再次检查生产源码，`packages/arforge/src/session/execution.ts` 仍在第 358 行调用 prompt.loop，仍导出 SessionExecutionMature；prompt.test 等旧行为消费者尚须收齐后才能删除旧 loop/runLoop 与专属状态机。下一步从这些剩余消费者和 R05 逐入口退出项继续，不重新扩展已迁移的普通录制比较。安全自检：仅隔离测试及证据，无真实用户库、凭据、外部 Provider、全局 CLI/PATH、发布或 full sandbox 操作。

## Structured-output 场景解除 Mature 执行依赖（2026-09-08）

结构化输出场景改为原 Formal/Core + Provider replay 与固定 JSON，移除其旧 record 开关、Mature cassette layer/testRoot。原无效/有效录制响应及历史基线不变。保留两 assistant、首次 StructuredOutput 工具因缺 founded 字段进入 error 且不产生 structured 值、末条精确 structured 对象/stop/无 error、完成时间及无 pending/running 工具。固定历史步骤、预算/请求身份投影检查继续；单次结算事件重新读取 SQLite 逐项一致、active 清空。

两次请求仍要求 tool_choice=required、工具 schema 不变且仅一项，重试提示从 1 次变为 0 次，第二请求包含准确缺字段错误且不提前包含最终对象。这里只覆盖“一次无效后有效”，不冒充所有 schema、重试耗尽或取消路径验证。

专项 **1 pass / 26 expect**；最终 packages/arforge `bun test test/session/mature-runner-recorded.test.ts --rerun-every`：**8 pass / 0 fail / 232 expect，21.53 秒**。Arforge typecheck 退出 0，Prettier 完成、diff-check 通过，单文件 lint **46 warnings / 0 errors**。dependency digest `2b1705d57e9c24705702c9b8dbc13fd442b7f18a827bd68eb4b3752aa530151b`。专项重叠不累计，未跑整仓。

五类录制场景已不执行 Mature；仅 action-replay 仍需迁移，随后清理共享旧测试装配。产品旧 Loop 与其他消费者未退役，R05 及整体目标仍未完成。安全自检：只有隔离测试/证据，未操作真实用户库、凭据、外部 Provider、全局入口、发布或 full sandbox。

## Compaction 场景解除 Mature 执行依赖（2026-09-08）

压缩录制场景已改为原 Formal/Core + Provider replay 与固定历史 JSON，不构建其 Mature layer。移除压缩 record 开关、旧 cassette/testRoot、旧消息 compaction marker 准备及只供其使用的 PartID import。原 cassette/JSON 不变，不以重新录制绕过请求差异。

迁移前实际重跑原三方压缩比较（1 pass / 23 expect，11.20 秒），短暂观察 checkpoint reason，确认前四阶段未设置 reason，committed/closed 为 compacted；临时日志已随旧块替换移除。新的 Formal 断言保留单操作 committed/closed、prepared→summarizing→summarized→revalidated→committed→closed 六阶段及上述原因值，准确的自动摘要与最终答复、单次结算/SQLite 重读一致性和 active 清理。两条严格请求分别含旧上下文、含摘要及近期消息，第二请求不再含被压缩旧长文本；固定历史 budget/游标/请求摘要门禁保持。语义 trace 的 compactionCount 不能替代这里真实操作/checkpoint 断言。

最终 packages/arforge `bun test test/session/mature-runner-recorded.test.ts --rerun-every`：**8 pass / 0 fail / 240 expect，28.06 秒**；迁移后专项 **1 pass / 24 expect** 与其重叠不累计。Arforge typecheck 退出 0，Prettier 完成、diff-check 通过，单文件 lint **46 warnings / 0 errors**。dependency digest `31a8d473fbfbd499fef44584d672c4cc224f50e4a97861e0871a9eb0547db8e2`。

queue/steer/cancel/compaction 四类不再执行 Mature；structured-output/action-replay 两类仍待迁移，产品旧 Loop 也未删除。本批为正常压缩与继续回答，不验证压缩执行中强杀、事务竞争或跨进程恢复；相关 R09 等退出项不缩减。R05 和完整目标保持未完成，full sandbox 最后。安全自检：只有隔离测试及证据，无真实用户数据、凭据、远程 Provider、全局入口或发布操作。

## Cancel/接续场景解除 Mature 执行依赖（2026-09-08）

取消录制场景已改为原 Formal/Core + Provider 离线 replay 和固定 JSON，不运行 Mature。移除取消专属旧工具注册、可变回调、record 开关、Mature cassette layer/testRoot；其余场景共享依赖保留，原 cassette/历史 JSON 不变。

验证活跃工具 Deferred 屏障后的纯中断、第一次 paused/attempt=1/continuation checkpoint、工具准确 `Tool execution interrupted` 错误及完成时间、调用退出和 active 清理；再验证同一 run 的第二次 attempt、checkpoint 推进到 idle/nextStep=3、准确恢复请求游标、原消息完整前缀不变、不新增 user、第二条 assistant 正确答复且无模型错误。取消前后两次 callback 事件均重新读取 SQLite 对照，严格两次结算；两条 recorded request 和固定历史比较/篡改负例保留。

首次专项失败源于错误移植旧 MessageAbortedError 语义：要求 Core assistant.error 存在。检查 Runner 实码可知 Provider 已结束，只有活跃 assistant 才发布 Provider turn interrupted；此时应将失败保留在被中断工具上，而非伪造模型错误。修正断言为 assistant 无 Provider error、工具有准确中断错误后专项 **1 pass / 31 expect**。接续后原 run 仍为 **failed**（已有工具失败），但产生正确答复；不把此场景描述为整个 run 成功，也未擅自修改终态政策。

最终 packages/arforge `bun test test/session/mature-runner-recorded.test.ts --rerun-every`：**8 pass / 0 fail / 239 expect，32.97 秒**。Arforge typecheck 退出 0，Prettier 完成、diff-check 通过，单文件 lint **49 warnings / 0 errors**。dependency digest `a01ae3b3a3daa859a21c1cb3701aa0f535b2afa7403030f1c0ecb002846b4274`。专项重叠不累计；这是同进程显式 resume 的隔离录制验证，不是冷重启/公开 CLI/Desktop 验收。

现在 queue/steer/cancel 三类不执行 Mature；compaction/structured-output/action-replay 三类及产品旧 Loop 仍待迁移退役。下一步接压缩外围事务/检查点/内容断言。R05 和整体目标未完成，full sandbox 最后。安全自检：仅隔离测试和证据，无真实用户数据库、凭据、外部 Provider、全局入口或发布操作。

## Steer 场景解除 Mature 执行依赖（2026-09-08）

steer 录制测试现在只装配原 Formal/Core 与 Provider replay，直接消费固定历史 JSON；移除该场景的旧工具注册器、可变执行回调、Mature cassette layer、record 开关及 steerTestRoot。共享取消/重放使用的 location 配置保留，不机械删除同名共享项。HTTP cassette 和基线内容未改，不重新录制预期。

保留并迁移运行中工具 Deferred 屏障、steer 持久入队、active 运行状态、放行后输入消费清空、单次结算和 callback/SQLite 事件一致性；验证两 user/两 assistant、原 steer message ID 和准确文本、工具 completed、最终准确答复/完成时间/无 error，第二个严格请求含 steer 文本。固定历史 trace、budget、request cursor/digest 与完整六结果门禁/六种篡改负例继续执行。原 Mature 专属存储 phase、消息 parts 结构和“两个活引擎互比”断言不作为新框架标准重复保留。

首次专项失败是迁移断言误读 Core User.content；实码 User 定义为 text，改用准确 User.text 后通过（1 pass / 22 expect）。最终 packages/arforge `bun test test/session/mature-runner-recorded.test.ts --rerun-every`：**8 pass / 0 fail / 249 expect，40.12 秒**。Arforge typecheck 退出 0，Prettier 完成、diff-check 通过，完整单文件 lint **54 warnings / 0 errors**。较小批次不累计；断言数减少源于旧引擎重复断言退出，不能换算全项目进度。dependency digest `d980be73d66da637a661362521544a7be6b5cbba932469dba9bcc5d1190bf94d`。

目前 queue/steer 两场景无 Mature 执行，cancel/compaction/structured-output/action-replay 四场景仍在旧装配上，产品旧 Loop 未删除。此为隔离录制 Core 验证，不是远程 Provider、新进程恢复或 CLI/Desktop 全旅程验收。下一步迁移取消及其恢复断言；R05 与整体计划仍未完成，full sandbox 最后。安全自检：仅测试/证据，未触及真实用户数据、凭据、全局入口、发布或外部服务。

## Queue 场景解除 Mature 执行依赖（2026-09-08）

第一个旧录制场景已实际迁移：queue 改用空外层 testEffect + 原 Formal/Core 层和 Provider 严格离线 replay，不再构建该场景的 Mature layer 或调用旧 SessionPrompt。移除 queue 专用 record 开关、HTTP recorder/Mature cassette layer 和初始化 testRoot；既有 HTTP cassette 与唯一历史 JSON 保留。其余五场景仍使用旧适配器，未声称整个文件无 Mature import。

外围断言迁入 Formal：准确的持久 prompt/system/route、单次结算、回调收集的事件与重新读取 SQLite 逐项一致、终态/语义 checkpoint、runCreated/completed 事件、用户/assistant 各一条、准确回答 ok/finish/无 error/完成时间、active 清空、队列消费完毕、严格单请求与 system 顺序。六结果汇总使用同一 HistoricalResult，不再要求现场构造六份 Mature 结果；仍保留每个未迁移场景原三方专项门禁，未以假 Mature 值凑数。固定基线比较和六种篡改检查继续执行。

补 admission 断言首先失败：listPending(queue) 为空。检查实码发现 Core Session.prompt 默认 delivery=steer，原 Formal queue fixture 实际未显式排队；现明确 delivery=queue 后通过，模型请求仍匹配原 cassette。初次新增 active 检查直接取未导出的 execution layer service 导致 typecheck 失败，改用原 SessionV2.active，未新增执行器装配。首个扩展批 5 pass / 3 fail（queue 与两个依赖其结果的门禁）；这些失败已修复，不隐藏。

最终 packages/arforge `bun test test/session/mature-runner-recorded.test.ts --rerun-every`：**8 pass / 0 fail / 256 expect，48.59 秒**；queue 专项 **1 pass / 27 expect** 与整批重叠不累计。Arforge typecheck 退出 0，Prettier unchanged、diff-check 通过，单文件 lint **56 warnings / 0 errors**。dependency digest `84e8073f941100f525822525038d7bc55e0c4f7213541c1657402f24c01e26db`。

边界：queue 使用原 Core 服务/Runner 的隔离录制装配，不是新一轮真实 CLI/server/Desktop 用户验收；原公开 prompt 入口证据另见前文，不能混称本次覆盖。下五项 steer/cancel/compaction/structured-output/action-replay 的外围断言、旧录制装配清理和产品旧 Loop 退役继续，R05 未关闭。安全自检：仅隔离测试及证据，没有真实用户库、Provider 网络、全局 CLI/PATH、发布或 full sandbox 操作。

## 固定 JSON 消费与篡改负例（2026-09-08）

上一批 Bun snapshot 的六项数据完整转为 `packages/arforge/test/fixtures/recordings/session/historical-runner-baseline.v1.json`，保留来源/日期，移除本任务刚生成的 `.snap`，不保留两个独立可更新基线。转换只去除 snapshot 包装及 JSON 尾逗号，没有执行 snapshot 文本，没有改语义数据。

原 admitParityEntry 现在将 **Formal 自身**的 trace、执行证据、请求投影与 transport digest 交给固定基线断言；断言函数不接受 Mature 当次结果。完整比较 trace（仅替换 producer 标记为 formal-runner），固定预算字段、请求 cursor 和 HTTP cassette 摘要；checkpoint 依照既有比较规则将历史 owner phase 解释为 idle/continuation。完整矩阵末尾仍核对当次 Mature 投影与固定 JSON 完全相同，以维持冻结来源的复核，在余下断言迁移完成前不删除旧链。

新增六种克隆数据篡改负例：tokensUsed、requestCount、turnStep、transport digest、缺少 queue、重复 queue。均使用已完成的 Formal 结果触发同一断言失败，不重跑旧引擎、不覆盖基线文件。六场景、完整矩阵及负例共 **8 pass / 0 fail / 241 expect，57.10 秒**（packages/arforge：`bun test test/session/mature-runner-recorded.test.ts --rerun-every`）。首次 typecheck 因 JSON 数字/string 推断不能满足 Bun toEqual 的窄泛型失败；显式将这两处跨类型完整值断言设为 unknown 后 typecheck 重跑退出 0，未用强制转换冒充已验证 schema。该修订仅类型参数，不改变通过的运行逻辑。Prettier unchanged、diff-check 通过；单文件 lint **60 warnings / 0 errors**，其中显式泛型与数组非空断言有新增提示，未声称清零。

dependency digest `c23c5bf530533d5acd7c90dab2885994b0413f2cf5b0371abca02df6b9e75bf5`。当前基线比较函数已经不依赖当次 Mature 值，但**测试运行仍包含 Mature，尚未完成 Formal 独立测试装配或旧引擎退役**。下一步迁移六场景外围的正式入口/事务/最终内容断言，移除旧 Layer、record 分支及动态三方门禁；不允许把固定语义投影的零计数当作副作用/压缩真实次数。R05 不关闭，其他工作包及最后 sandbox 范围不变。安全自检：只改隔离测试、基线与证据，无真实用户数据、凭据、外部 Provider 或全局入口操作。

## 历史基线冻结第一步（2026-09-08）

`mature-runner-recorded.test.ts` 完整矩阵门禁新增历史快照，产物为 `packages/arforge/test/session/__snapshots__/mature-runner-recorded.test.ts.snap`。六场景保存旧引擎的语义 trace、checkpoint、稳定预算计数/上限、request cursor 和严格 HTTP cassette 的请求摘要。明确排除随机 run ID、实际耗时和含运行身份的请求摘要；没有将这些值归零伪装精确重建，完整发送身份仍由后续 R06 验收。

快照由真实录制比较运行生成，而非手写预期：`bun test test/session/mature-runner-recorded.test.ts --rerun-every --update-snapshots` 为 7 pass / 179 expect、1 snapshot added（56.44 秒）。随后**不带更新参数**完整重跑为 7 pass / 0 fail / 179 expect、1 snapshot matched（53.23 秒），证明跨本次两轮随机身份/计时下固定值稳定。Arforge typecheck 退出 0、Prettier unchanged、diff-check 通过；完整单文件 oxlint 为 57 warnings / 0 errors，未宣称告警清零。dependency digest `cde6d9471caecf43f69ca65bc57fbf2ae3d892c12d6e6c71da052bcb7a9a3957`。

边界：此为数据冻结的第一步，测试**仍运行 Mature**，还不是 Formal 独立消费中立 fixture。快照中的 actionStatusCounts/compactionCount 是旧语义投影值（部分为零），不能用它取代现有测试对 SQLite Action 行、实际 executor 次数、压缩 checkpoint 阶段和最终内容的额外断言。下一步迁移这些必要断言并接入固定数据消费者，做篡改负例，再解除旧引擎依赖；不得把快照生成当作 R05/基线迁移完成。只改测试/快照及证据，未操作用户数据、真实 Provider、全局入口或 sandbox。

## 当前核验与后续批次（2026-09-08）

响应正文前取消的新增 Formal 测试已在实码核对：等待真实本机 HTTP 请求到达后取消，连续两轮均返回纯中断、无 assistant 空壳、run 为 paused 且 lease 已释放；第三次明确新输入正常回答，三条 user/一条 assistant、总请求三次。这不是模型准备阶段取消，也不是新进程恢复；原 `finalizes assistant when cancelled before processor creation completes` 仍保留，不能将它计为已迁移。

上一批最终关联命令与下节相同，增加此项后为 **23 pass / 270 expect / 81 filtered / 0 fail，76.17 秒**；Arforge typecheck 退出 0、格式/diff-check 通过，lint 23 warnings / 0 errors。此为此前执行结果的补录，不冒充本次重跑。dependency digest 为 `fd55220fa778092ebd4c46043054ac2597b831c6b81aaa95cb4206f25033544f`。

本次新鲜执行：在 packages/arforge 运行 `bun test test/session/mature-runner-recorded.test.ts --rerun-every`，**7 pass / 0 fail / 178 expect，48.45 秒**。六场景为 queue、steer、cancel、compaction、structured-output、action-replay，另有完整矩阵门禁。使用既有本机录制回放与隔离状态，不是远端 Provider 验收。源码仍 import `SessionExecutionMature` 并装配 matureRoot；运行中生成的 completedParityEntries 仅在内存，不是已冻结的中立历史文件。通过证明当前比较基线可用，不证明第二引擎已退出。

按主计划 R05 原有五项实施要求，后续集中为以下批次，不改变全计划范围或验收条件：

| 批次 | 必须完成的实际工作 | 退出证据 |
|---|---|---|
| 1. 冻结比较基线 | 将上述六场景的历史行为、请求投影、预算/工具结果等必要比较值冻结为可校验的中立 fixture，Formal 对其回放；保留差异检测，不直接删断言 | 测试不再装配 Mature；篡改关键 fixture 会失败；六场景和完整性门禁通过 |
| 2. 收齐旧行为消费者 | 逐项归类并迁移 prompt.test 中的准备/取消、工具/审批、子任务和压缩等旧 loop 消费，保留用户可观察语义，不保留旧存储合同作唯一标准 | 相关正式入口成功/失败/取消测试通过；旧 processor 抛错哨兵成立；无静默 return/skip 代替迁移 |
| 3. 退役第二引擎 | 在前两批证据成立后移除 loop/runLoop、Mature 及专属状态机，保留确有消费者的投影/直接 Shell 清理并明确归属 | 源码消费者检查与运行时负例共同证明唯一执行 owner；受影响包 typecheck、回归及组合门禁通过 |
| 4. R05 汇总验收 | 对照 prompt/slash/定时任务/child/followup/恢复，验证 owner、取消隔离、lease 与一次预算结算，复核已有证据不足的入口 | 逐项关联实际测试与当前源码；未验证项明确保留，全部满足才关闭 R05 |

完整请求冻结归 R06、通用语义恢复归 R07、工具全来源归 R08、压缩故障闭环归 R09、结算策略归 R17；这些后续项不能被从计划删除，也不应全部塞入普通取消测试迁移。R05 自身的恢复/一次结算要求仍保留。当前仍处 B/R05，无可信全计划完成百分比；全平台 full sandbox 按用户要求最后。安全自检：未操作真实用户库、凭据、全局 CLI/PATH、外部服务或发布配置。

## 当前迁移（2026-09-08）：公开取消的历史与持久错误

原 cancel-interrupts-loop 与 MessageAbortedError 两项旧测试替换为 Formal 公开 prompt/cancel，移除两处 loop。分别验证首轮/已有真实完成首轮的会话：响应开始后取消，调用返回中断 Cause，Core 最后一条 assistant 记录准确的 Provider turn interrupted、完成时间和部分文本；既有消息逐项不变。再次取消消息和请求数不变，旧 assistant 副本为零。既有历史来自真实 Core 首轮，不再手工 seed 旧格式；不把旧 MessageAbortedError 名字当新框架合同。

最终 packages/arforge：`bun test test/session/prompt.test.ts -t 'Formal cancellation|Formal glob|Formal continues after|Formal preserves|Formal concurrent|Formal drain|Formal public|missing canonical owner|cancelling a pending direct Shell' --rerun-every`，22 pass / 248 expect / 81 filtered，50.81 秒，退出 0；typecheck 退出 0，格式/diff-check 通过，lint 23 warnings / 0 errors。专项 2 pass / 24 expect 与其重叠不累加。仅测试改动，dependency digest `a8179ec8d7f3aa59cb1c9d281d8fc44c906633ad5faf48ebc63703b72a78a439`。

范围为 assistant 已创建后的取消；响应开始前、工具/子任务/压缩中的取消窗口仍待迁移验证，Mature 尚未退出，R05 不关闭。安全自检：只有隔离 fixture 与文档/台账，无真实用户库、凭据、外部服务、发布或 full sandbox。

## 当前修复（2026-09-08）：公开 cancel 接入正式执行器

新增同一取消旅程的 prompt.cancel 入口，修复前实际失败：cancel 返回后 Formal active 仍为 true。原 cancel 仅清理 SessionRunState/direct Shell，并未停止 Core；不能用上批直接 execution.interrupt 的通过替代公开入口验收。

现公开 cancel 在调用边界解析已有 SessionExecution，先做原本地清理再 interrupt；直接 Shell 独立调用无执行器时保留原本地清理语义。原清理主体抽为标注 @internal 的 cancelLocal，Mature 两处内部收尾改用它，避免公开 cancel→Mature.interrupt→公开 cancel 的递归。此钩子不创建/选择执行器，不新增状态 owner；随旧适配器退役继续收束。实现首轮误用了不存在的 CoreSession 别名而失败，已改成文件原 DurableSessionSchema，未保留失败路径。

最终 packages/arforge：`bun test test/session/prompt.test.ts -t 'Formal cancellation|Formal glob|Formal continues after|Formal preserves|Formal concurrent|Formal drain|Formal public|missing canonical owner|cancelling a pending direct Shell' --rerun-every` 为 20 pass / 224 expect / 83 filtered（65.44 秒）；`bun test test/session/mature-runner-recorded.test.ts -t 'cancel|interrupt' --rerun-every` 为 1 pass / 35 expect / 6 filtered，覆盖 provider/formal/mature 活动工具取消（12.09 秒总计）。Arforge typecheck 退出 0，三文件格式/diff-check 通过，lint 34 warnings / 0 errors。待授权 direct Shell 保持零 spawn、终态 cancelled；公开取消与执行器取消都验证双方退出、原失败消息保留、同会话新用户输入成功。未跑整个录制文件或整仓。

composition digest `b0ae87c3534035232b246335de3c3986304be6ced67f2a1bccf6bee237bd6540`；dependency digest `192d13077a2796ad2584e2af7b4332f5ba8b9c9811d46e95bb3ccecf4b1b2365`。R05 仍未完成：其余子任务/Shell 取消来源、审批交错、旧 Loop/Mature 消费者与压缩迁移待继续。安全自检：仅原 TS 服务/隔离测试/文档，无真实用户库、凭据、外部 Provider、全局 CLI/PATH、发布或 full sandbox 操作。

## 当前修复（2026-09-08）：取消不能遗留并发 resume 等待者

迁移原 cancel-with-queued-callers 测试时，Formal interrupt 已返回且 active 为空，但等待者超时。分别观察 Fiber 后确认第一个退出、第二个不退出；独立 Core 三等待者测试也先失败（0 pass / 1 fail），排除 HTTP 与并行 Effect.all 收集写法。当前依赖 Deferred.doneUnsafe 的同步通知循环与中断取消订阅存在交互，不能让多个加入者共用同一 done。

在原 SessionRunCoordinator 复用 completionWaiters：每个加入者分配独立完成凭据，run/runWith 等待已有 generation 的分支统一接入；首个拥有者仍用原 done。通知前 splice 取出列表，防止同步 finalizer 改动待遍历列表；等待者自己退出时移除注册，不积累取消的加入者。不改底层依赖、不新增运行器/队列、不吞掉中断或改成成功。

Formal 测试不再调用旧 loop/cancel 和 sleep(50)：两个正式 resume、等待真实模型请求及 assistant 创建、原 execution.interrupt；双方中断、失败消息一条、请求一次、active 清空。随后公开 prompt 新输入正常完成，原失败消息不变、请求共两次。该场景不等于等待审批/工具进程/子任务的所有取消来源。

最终：Core `bun test test/session-run-coordinator.test.ts --rerun-every` 为 23 pass / 40 expect；Arforge `bun test test/session/prompt.test.ts -t 'Formal cancellation|Formal glob|Formal continues after|Formal preserves|Formal concurrent|Formal drain|Formal public|missing canonical owner' --rerun-every` 为 18 pass / 201 expect / 84 filtered（58.94 秒）。两包 typecheck 退出 0，三文件格式与 diff-check 通过，lint 24 warnings / 0 errors。小批次重叠不累计，未跑全仓。composition digest `220ba72868a02ecb5de44a8ee8257de4f0b4fa5b2bf1442602b16a39e3611c79`；dependency digest `68b1a0639fc5dd8b5b7585133537ecd831c241fe3e1b696a16089f3650f5fcfd`。

R05 仍待其他取消、压缩、工具与 Mature 消费者退出。安全自检：只改原协调器、隔离测试及证据，无真实用户库、外部 Provider、全局 CLI/PATH、发布或 full sandbox。

## 当前迁移（2026-09-08）：glob 与 stop/tool 续轮

原 glob instance-context 和 stop-with-tool 两项旧测试替换为 Formal/Core：均通过 admission-only + 原 SessionExecution.wakeAndWait，真实 glob 检索临时文件，Core 两条 assistant、一条 completed 工具、旧 assistant 为零、两次模型请求。第二项使用真实 glob 取代旧未注册 first 工具，原 Provider finish=stop 保持；检查第二请求包含文件结果和原 tool call ID，最后正常 stop。移除原两处 prompt.loop 调用及 glob 缺工具直接 return 的静默通过路径，不新增工具 owner 或执行器。

初步运行 2 pass / 20 expect，但 typecheck 揭示 tool state 可能 pending；新增明确 throw 的类型收窄（不是遇到非 completed 就提前成功），并补请求结果断言。最终 packages/arforge：`bun test test/session/prompt.test.ts -t 'Formal glob|Formal continues after|Formal preserves|Formal concurrent|Formal drain|Formal public|missing canonical owner' --rerun-every`，17 pass / 185 expect / 85 filtered，58.20 秒，退出 0；typecheck 退出 0，格式及 diff-check 通过，单文件 lint 23 warnings / 0 errors。dependency digest `28e33bdb08ae9e743bc81acc3c82a326f9997529bc1e79bd8315b2936d3f7c8b`。未改产品源码，未跑整包/整仓。

本批只迁移这两项行为，不代表跨工作区权限、工具全量、取消、压缩或 Mature 录制迁移完成；R05 尚未关闭。安全自检：仅隔离测试和证据，未操作真实文件、凭据、外部 Provider、全局 CLI/PATH、发布或 full sandbox。

## 当前续验（2026-09-08）：真实 write 完成后 EOF 与用户接续

新增 Formal 公开 prompt 场景：Core write 在临时工作区真实写文件，第二个模型响应没有语义终止事件，公开调用失败且最后 assistant 保存 EOF 错误。write 工具仍 completed、Action 仅一条。模拟用户在失败后修改该临时文件，再通过公开 prompt 新输入接续：回复成功，原完整工具结果及 Action 快照不变，用户修改未被覆盖，模型请求合计三次（工具请求/断流/新输入）。这是明确用户输入触发的接续，不是自动重试；文件和 Action 不变共同约束重复写入，不能仅凭最终同样的正文判幂等。

首两次失败来自 fixture 使用旧 write 参数 filePath，Core 正确拒绝缺少 path；改用正式 schema 的 path 后通过。没有放宽工具 schema、权限或 Gateway。测试采用临时 session 的显式 allow 权限，不代表 ask/deny 授权旅程。产品代码本批未修改。

最终 packages/arforge 命令：`bun test test/session/prompt.test.ts -t 'Formal preserves|Formal concurrent|Formal drain|Formal public|missing canonical owner' --rerun-every`，15 pass / 163 expect / 87 filtered，51.64 秒，退出 0；包 typecheck 退出 0，单文件格式完成，lint 23 warnings / 0 errors。dependency digest `b57878d89a7f0c40fa95320ae018ba6b6c82a0fa32c979d5dfcce0aff78fb280`。专项与筛选批重叠，不累加；未做整包/整仓全量。

范围：只验证 write 已结算后下一模型请求 EOF；写入执行中断流/强杀、审批和取消竞争、新进程重建以及真实远端 Provider 尚待验收。其余旧工具/压缩/取消测试和 Mature 退出仍待推进，R05 未完成。安全自检：仅临时文件、测试会话与证据，没有真实用户文件、外部 Provider、发布或三平台 full sandbox 操作。

## 当前续验（2026-09-08）：真实本机连接 reset 与用户继续提问

扩展原 TestLLMServer.reset：有 wait 屏障时先发送并 flush 响应头/head，然后等待显式放行再调用真实 Node ServerResponse.destroy；无 wait 的原 reset 行为保留。不用 sleep 假定连接已建立。Formal 夹具在 Core assistant 已创建后才放行断连，证明开始处理了响应；两个 resume 等待者得到同一原传输错误（Failed to read，而非 EOF 替换），一条失败 assistant，已接收文本保留，active 清理、模型请求一次。

接着在同一会话通过公开 prompt 提交新的用户输入，正常完成第二条 assistant，原失败消息完全不变、请求总数两次、active 再次清空。只验证用户明确提交的新请求，不把它称为自动 retry 或跨进程恢复。未修改产品运行时。

首轮等待正文持久化超时（0 pass / 1 fail）；正文聚合尚未 flush，改为等待已落库的 assistant 开始标记，并在失败结束后严格检查原正文。最终专项 1 pass / 19 expect；关联命令在 packages/arforge 执行 `bun test test/session/prompt.test.ts test/session/processor-effect.test.ts -t 'Formal concurrent|Formal drain|Formal public|missing canonical owner|retries' --rerun-every`，15 pass / 151 expect / 101 filtered，48.39 秒，退出 0。包含原无屏障 reset 重试测试。Arforge typecheck 退出 0，两文件格式完成，lint 28 warnings / 0 errors。首次 formatter 路径误用 cwd 没有格式化文件，已从根目录正确重跑。

依赖 digest：`3066140def90ec0d83fecc04262a28f31141395ee5afbc56c126214fb8bc6ea7`。本批只有测试/夹具改动；没有重跑 LLM 全包或整仓。仍待工具已产生副作用时的断流、取消/恢复交错、HTTP/UI 用户错误提示及真实远端网络/Provider 验收。旧 Loop/Mature 迁移及 R05 未完成，三平台 full sandbox 最后。安全自检：仅本机隔离 HTTP/临时会话及证据，无真实用户库、凭据或外部服务操作。

## 当前修复（2026-09-08）：未完成响应的 EOF 必须失败

根因：generate 已校验完整响应，但 Core 使用的 stream 在正常 EOF 后未校验终止事件。空响应/部分文本两条正确编码回归先失败（0 pass / 2 fail）。首轮部分文本 fixture 误传数组触发协议解码错误，纠正后才作为 EOF 证据。

既有 Route.streamPrepared 在协议 onHalt 后追加每次订阅独立的 finish/provider-error 检查；缺少时返回原 InvalidProviderOutput。不缓存文本，不新增会话状态机；检查只在正常上游结束后执行，保留取消、上游错误。未完成工具输入原测试改为检查已发增量和错误，仍不产生可执行 tool-call。原 prefix 取消、HTTP 错误、传输失败测试均通过。

Formal 并发测试扩展为 invalid、empty EOF、partial EOF，均验证两个等待者共享错误对象、同一持久失败 assistant、一次请求、active 清理；部分正文保留。沿用 Core failAssistant/Step.Failed，无 Core 持久化改动。明确 SSE DONE 不能替代语义 finish。

最终命令及结果（Windows/Bun 1.3.14，受控 fixture，无真实 Provider）：

- packages/llm：`bun test --rerun-every`，308 pass / 30 skip / 0 fail，732 expect，31 文件，退出 0。无 RECORD/RECORDED 环境过滤，跳过为原缺 cassette 分支，不计通过。
- packages/arforge：`bun test test/session/prompt.test.ts -t 'Formal concurrent|Formal drain|Formal public|missing canonical owner' --rerun-every`，13 pass / 128 expect / 87 filtered，40.56 秒，退出 0。
- 两包 `bun run typecheck` 退出 0；三文件 Prettier 完成，oxlint 28 warnings / 0 errors。较小批次不累计；没有整仓回归含义。
- dependency digest：`9d30acceeff7e459aee1a07a8c7ddfc4ce264044dcc26095d50eefd0c94aa80a`；composition 重新生成保持 `b349fa18bf577b25ea7c9800b702cb62069114becf9dd9342cf91ae94aa4950a`。

仅关闭正常 EOF 缺终止信号的已复现缺陷。真实连接 reset、合法 Chat SSE error envelope、公开 prompt/HTTP/UI 完整错误体验、工具副作用中的断流、恢复仍需验收；共享校验不证明所有 parser 均无提前 finish。旧 Loop/Mature 退出及 R05 整体仍未完成。安全自检：仅原 TS 管线、隔离测试、台账/文档，无真实用户库、凭据、外部操作、发布或 full sandbox。

## 当前续进（2026-09-08）：并发结果与协议错误测试迁移

原两项旧 Loop 并发测试现使用 Formal/Core：已完成会话的两个 wake 等待者读取相同 Core 结果、仅一条 assistant、模型请求一次；活动请求的两个 resume 等待者在 Deferred 放行无效 SSE JSON 后均失败，收到同一错误对象，读取同一条持久失败 assistant，执行器退出 active 集合，模型请求仍一次。沿用原 Formal 夹具的旧 processor 抛错哨兵，不新增执行器或存储副本。

验证命令：`bun test test/session/prompt.test.ts -t 'Formal concurrent|Formal drain|Formal public|missing canonical owner' --rerun-every`（packages/arforge）。最终 11 pass / 103 expect / 87 filtered，37.13 秒，退出 0；Arforge typecheck 退出 0，Prettier 已格式化，单文件 oxlint 23 warnings / 0 errors。定向并发批 2 pass / 18 expect 与上述重叠，不累计。依赖摘要更新为 `99159fdeadcd10a6feaa3719b2dacb9ee70a5af1251cceaf79ffaf5b3309659e`；产品源码未改，本批不声称全量回归通过。

失败与待办保留：最初使用 `reply().wait(gate).streamError(...)`，实际 1 pass / 1 fail，resume 返回成功且 Core context/messages 都没有 assistant。该 helper 在服务器端让流失败，不把传入错误文本编码到 HTTP 响应；不能要求客户端拿到这个文本。改用明确无效 SSE 对象后触发现有 InvalidProviderOutput，必须捕获 resume 的 Effect.exit 再检查持久消息，不能把旧 Loop 的“返回错误消息”契约照搬为 Core 的成功返回。测试现准确命名为 invalid provider response，不宣称覆盖合法 Provider error envelope。

**下一步必须补提前结束流的独立回归与修复评估**：当前观察不能当作断流成功验收；需区分无终止事件 EOF、真实连接 reset、合法 HTTP/SSE Provider 错误，核对失败持久化及所有等待者退出。无效响应测试通过不关闭该缺口。其他并发取消、工具、压缩、Mature 录制适配器与旧 loop/runLoop 仍待迁移，R05 未完成。

安全自检：仅隔离测试、自动台账和文档；无真实用户库、凭据、外部 Provider、全局 CLI/PATH、发布或 full sandbox 操作。

## 当前续进：steer 行为测试迁移到 Formal

原两项 mature steer 测试改用正式 SessionExecution/Core 持久消息。执行前输入：不手工调用 promoteSteers，原 steer ID 仅产生一个 Core user，路由、模型、结果一致，待处理队列清空；再次 wakeAndWait 后完整 Core context 不变且请求仍一次。执行中输入：用首个模型请求就绪信号和 Deferred 屏障，入队后仍只有一次请求且 steer 仍 pending，放行后原 Core runner 发起第二次请求，最后 user 输入严格等于 steer 文本，原 ID 仅消费一次、无旧 assistant 副本。

最终筛选回归 9 pass / 85 expect / 89 filtered（29.44 秒）；Arforge typecheck 退出 0，测试文件格式通过，lint 23 warnings / 0 errors。只改原测试，不引入新 promotion/执行状态机；原两处 loop 消费已移除。其余并发、工具、压缩和 Mature 录制适配器仍待迁移，R05 未关闭。安全自检：仅隔离测试及证据，无真实用户库、凭据、Provider、CLI/PATH、发布或 full sandbox。

## 当前续进：两项旧 Loop 行为测试迁移到 Formal

原“loop calls LLM and returns assistant message”改为 Formal admission-only → SessionExecution.wakeAndWait：入队后模型请求为零、执行后只有一条 Core assistant、旧 assistant 副本为零且请求一次。原“mature loop promotes and drains the canonical durable queue”改为先完成真实 Core 首轮，再入队指定 agent/model 的第二轮；核对原入队 ID、Core assistant 路由/正文、实际第二请求文本、队列清空、总请求两次、旧 assistant 为零。不再构造旧 assistant 作为起始状态，也不调用旧 loop。

两项沿用 Formal 集成夹具，旧 processor 始终抛错；测试期限采用该类正式集成已有的 30 秒标准，不声称修复了旧 Loop 的性能。保留用户行为合同，移除对旧存储投影的实现耦合。这是实际减少旧引擎测试消费者，不是新增另一套执行机制。

最终筛选回归 7 pass / 63 expect / 91 filtered（23.68 秒），包括两项迁移、公开 prompt/command、缺 owner 负例和正式 scheduled child。Arforge typecheck 退出 0，测试文件格式通过，lint 23 warnings / 0 errors。仅测试文件改动；未重新跑上批全部 18 场景或全工程。显式 loop、Mature 录制适配器、其余 steer/并发/工具/压缩旧行为仍待迁移；R05 不关闭。

安全自检：仅隔离测试和计划/证据，无真实用户库、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

## 实码问题与修改

HTTP handler 已通过 admit/admitCommand + SessionExecution.wakeAndWait 执行，但 SessionPrompt.prompt/command 自身仍直接调用旧 loop。Formal 已装配时新增直接 prompt 回归，旧 processor 抛错哨兵实际触发（0 pass / 1 fail），证明不是单纯无消费者文本残留。

现两方法调用调用方上下文中的 SessionExecution.wakeAndWait，执行后从 Core SessionStore 取最后 user 之后的 assistant，通过已有 CoreMessageCompat 返回兼容结果，不写第二份 assistant。执行器在调用时解析以避免 Formal→Prompt→Formal 的层构建循环；缺失则 admission 前失败关闭，不回退旧 Loop。noReply 仍仅 admission；携带 runID 的直接 prompt 被拒绝，child 必须走原验证过的 childAttempt 路径。command 原 Executed 事件保留。

未引入新 Runner、队列、执行选择开关或状态 owner。仍未删除显式 loop/runLoop、Mature adapter 及其旧行为测试；如果刻意装配 Mature，此共享接口仍可能进入旧执行器，故不能宣称第二执行器已退出。依赖无执行器却调用 prompt/command 的旧测试和集成需按新契约迁移，不能恢复隐式 fallback。

## 验证

- Formal 筛选回归：18 pass / 311 expect / 78 filtered，153.17 秒；覆盖公开 prompt/command、模型 task/followup、后台通知、取消、orphan 恢复。旧 processor 始终为抛错哨兵。
- 新缺失 owner 负例：2 pass / 12 expect；均在 admission 前拒绝，消息/Provider 调用为零。
- admission/命令 admission 兼容回归通过。共同运行的一项显式旧 Loop 测试在默认 5 秒超时，首次批次 2 pass / 1 fail；单独用 CLI --timeout 20000 诊断重跑通过（用例耗时 4960ms，1 pass / 5 expect）。未修改测试默认超时，不把诊断通过当作默认门禁稳定性已解决。
- Arforge typecheck 退出 0；两文件已格式化，lint 33 warnings / 0 errors，告警未清零。未跑全项目或整个旧 prompt 测试文件。

## 下一步与边界

继续追踪显式 SessionPrompt.loop、Mature adapter、旧 task/manual 路径和录制测试消费者，完成中立 fixture 迁移后再删除旧执行层。R05 尚未完成；R06 及其余计划范围不因本切片而关闭，全平台 full sandbox 仍最后执行。

安全自检：仅原 TS 服务、隔离测试与证据；没有真实用户库、凭据、外部 Provider、CLI/PATH、发布或沙箱操作。
