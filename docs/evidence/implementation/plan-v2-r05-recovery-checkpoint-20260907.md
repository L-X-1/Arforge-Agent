# 当前续验：重新授权后同一请求新进程接续（2026-09-07）

原跨进程撤权夹具在变更前保存目标 session 的真实 tenant_id；拒绝 worker 完全退出后，仅恢复这一行原租户，不修改 run、attempt、预算、claim 或历史。completed 案例启动新 replay；running 案例启动 recover-settled 后再启动独立 replay，全部沿原 controlRunID 和原 Gateway，direct 抛错哨兵保持。原 worker 已有的 receipt canonicalHash、maxAttempts=1/attemptsUsed=1、operation 不变及 activeAttempt 清空检查继续生效。

最终 HTTP private/users 两项通过（87.50 秒），Server typecheck 退出 0，修改的夹具格式通过、lint 0 warnings / 0 errors。只改测试夹具，不新增恢复授权 API 或状态 owner。此为临时库会话归属恢复后的共享 Gateway 接续，不代表完整产品重新授权 UI、全部身份变化或提交内部竞争验收。安全自检：仅隔离副本和测试/证据，未触碰真实用户库、凭据、Provider、CLI/PATH、发布或 full sandbox。

下一落点回到 R05 唯一执行器退出：当前源码 SessionPrompt.prompt 与 command 仍可调用 loop（本次读取约 2034/2810 行），须检查实际消费者并通过正式入口回归后融合，不能直接删掉可达路径。R05 保持未完成。

# 历史续验：遗留 running attempt 的跨进程撤权（2026-09-07）

在 prepare-settled 强杀后、任何恢复前保存只读 SQLite serialize 一致性快照。新增 recover-revoke 模式必须加载到 running 且原 activeAttempt 存在，否则失败，不能用 completed 重放冒充接管。沿用真实 Gateway 结果返回屏障，另一进程精确改变副本中目标会话的租户归属，再放行共享 executeControlGateway。

拒绝后比较完整 run 和原 activeAttempt（含开始时间/编号），必须不变且无恢复 lease；原预算随完整 run 一起核对，不重置/追加尝试。direct 保持抛错哨兵，已结算 Action 不执行第二次。原 completed replay 撤权案例保留，两种模式采用独立 ready/release 标记，避免复用已存在 marker 导致未真正暂停。

最终 HTTP private/users 两项通过（83.68 秒），Server typecheck 退出 0，两文件格式通过、lint 0 warnings / 0 errors。本批只有夹具/测试改动，没有运行时新增 owner。两种撤权均使用原真实 users 身份、持久会话和 Gateway，但只覆盖结果返回时的会话跨租户变更；不等于事务提交内部竞争、全部身份变更矩阵、真实 Provider 副作用或撤权后恢复授权旅程。R05 仍未完成。安全自检：仅临时库副本、测试和证据，无真实用户数据/凭据、Provider、CLI/PATH、发布或 full sandbox。

# 历史续验：结果就绪后的真实跨进程撤权（2026-09-07）

原 worker 新增 replay-revoke：调用真实 Gateway.execute 后只增加暂停屏障，不替代其结果、授权或结算实现。协调进程等待结果 ready，从已验证的临时 SQLite 一致性副本中将精确目标 session 改属另一个已存在租户，确认只更新一行后放行。恢复调用必须返回 AccessDenied，完整 completed run 不变、无 activeAttempt、无残留 control lease；不要求事件序号不变，因为合法 lease 获取/释放本身有持久事件。direct 保持抛错哨兵。

此场景在原强杀/双进程/周期扫描之后执行；副本隔离原 HTTP scanner，不修改用户库或原 HTTP 测试身份。所有 worker 持续消费输出、有期限并等待退出后清理。测试屏障超时使用 defect 保持原 Gateway 泛型错误合同，不把超时当拒绝成功。最终 HTTP private/users 两项通过（83.77 秒），Server typecheck 退出 0，格式已修正，两文件 lint 0 warnings / 0 errors。产品运行时本批未改。

边界：本批验证真实持久权限变化发生在 completed replay 的 Gateway 返回后；不是 running/activeAttempt 接管中途撤权，也不证明最后检查与结算提交原子化、全部身份变更种类、真实 Provider 或旧 Loop 全入口退出。R05 仍不关闭。安全自检：只使用隔离测试库及其副本，不涉及真实用户数据/凭据、Provider、CLI/PATH、发布或 full sandbox。

# 历史修复：Gateway 结果返回后重新验证当前权限（2026-09-07）

发现 settled-result 分支不进入 execute callback，因此在入口权限检查后、Gateway 返回前撤权时，原 executeControlGateway 仍可向调用方返回 receipt，并结束遗留 running attempt。新增 running/activeAttempt 与 completed 两个定向替身回归，修复前均失败（12 pass / 2 fail，实际返回 Success）。现于 Gateway 返回后、控制 attempt 收尾前调用同一 assertAccess，不新建授权 owner；拒绝后不返回 receipt，running 的 activeAttempt 保留，completed 仍 completed，direct 不执行。

本轮第一次补丁误放在前置位置，回归仍失败；移至 Gateway 返回后的正确边界才转绿。最终 Core 四文件 103 pass / 430 expect（5.82 秒），真实临时 HTTP private/users 两项通过（79.24 秒，含周期扫描、双进程和强杀窗口），Core/Server typecheck 退出 0，两文件格式通过；两文件 lint 41 warnings / 0 errors，未清零。

新增撤权证据为确定性的 Gateway/权限替身测试；HTTP 扩大回归验证原合法路径未破坏，不冒称这两个撤权窗口已在真实跨进程身份库中复现。此修复不撤销 Gateway 已完成的副作用，也不证明最后权限读取与后续跨 aggregate 提交之间原子化；跨进程撤权、事务竞争、真实 Provider 与旧 Loop 全入口退出仍待完成，R05 不关闭。安全自检：仅原 TS 共享恢复函数、隔离测试与证据，无真实用户数据/凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 历史进度：有效租约跳过与真实周期扫描已通过（2026-09-07）

新增 prepare-periodic/recover-scan-periodic 场景：原 claim 取得 8 秒 lease 并开始 attempt 后强杀；恢复前不等待过期，两新 worker 屏障启动原恢复服务。启动时必须还剩至少 1.5 秒有效 lease，1 秒后完整 ControlSnapshot 与原值一致；此后不调用 start/recover，只轮询完成，且完成不得早于启动后的 29 秒。使用原 30 秒 Schedule、不改写 lease 时间；最终仍 maxAttempts=1/attemptsUsed=1，第三进程 Gateway replay 不执行 direct。

首次失败显示原 HTTP host 的独立 scanner 会先于新 worker 的周期接管，不能用该结果证明新进程周期扫描。因此仅周期场景在 SIGKILL 后通过只读 SQLite serialize 创建一致性临时快照（包含 WAL 已提交页），新 worker 使用该副本，隔离原 HTTP scanner；其他两个窗口仍使用原临时数据库。测试 parent lease 从 60 秒改为 120 秒、外层测试期限从 90 秒改为 120 秒，以容纳新增真实 30 秒等待；未改变产品预算、控制租约默认值或扫描周期。

最终 HTTP private/users 两项通过（80.42 秒，其中 users 70.48 秒），Server typecheck 退出 0、四文件格式通过。四文件 lint 6 warnings / 0 errors，原 route-child 告警未清零；两份 worker/协调夹具专项 lint 0 warnings / 0 errors。本批仅测试及证据改动，不宣称新增产品恢复机制。

范围：隔离 Windows SQLite、两个同步启动 scanner 的有效租约保护与定时 wait 接管；不证明恢复途中撤权、真实 Provider 副作用、全部事务交错或旧 Loop 全入口退出。R05 仍不关闭。安全自检：仅临时数据库及其一致性副本、测试和证据；未接触真实用户库/凭据、Provider、CLI/PATH、发布或 full sandbox。

# 历史进度：双进程屏障启动恢复扫描已通过（2026-09-07）

两个强杀窗口现各启动两个新 worker。各自先加载原 running/activeAttempt 后写 PID ready，协调夹具等两份 ready 才写 release；两 worker 随后启动原 SubagentControlRecovery.make，不直接调用 start/recover/Gateway 触发接管。各自观察 completed、activeAttempt 清空并核对 maxAttempts=1/attemptsUsed=1 与不可变 operation。等待两进程退出后，第三进程原 Gateway replay 禁止 direct，已结算窗口仍核对崩溃前 receipt；其他异常不能当成功吞掉。

首次回归发现夹具在 completed 可见、另一恢复 worker 尚未释放 lease 时立即并发 replay，正确收到 LeaseHeldError。改为恢复 worker 仅观察，全部退出后单独 replay，未放宽产品 lease 规则。最终 HTTP private/users 两项连续两次通过（45.37 秒、45.59 秒），Server typecheck 退出 0，格式通过、两文件 lint 0 warnings / 0 errors。仅测试夹具改动。composition=997109c0c91d12ae77a9a981ee4bbcdefa17f16c0fdea73598d268183f72ccfb；dependency=f4c60082a0293cdf5e6582331611f92de9d3bec1b955b77639ce0ec0fcccf248。

范围是本机临时 SQLite 的双进程同步启动扫描，不保证两个 scheduler 同时进入每条 SQL 或所有事务交错；不证明周期扫描、恢复途中撤权、真实 Provider 副作用及旧 Loop 全入口退出。R05 不关闭。安全自检：仅隔离夹具和证据，不涉及真实用户库/凭据、Provider、CLI/PATH、发布或 full sandbox。

# 历史进度：启动扫描自动接管已通过（2026-09-07）

强杀夹具的两个窗口现改由新进程构建原 SubagentControlRecovery.make 和 buildSharedLocationServiceMap，仅启动服务并轮询持久 ControlRun；不调用 start/recover/executeControlGateway 触发接管。观察 completed 且 activeAttempt 清空之后，才以 direct 抛错哨兵调用原 Gateway 验证重放。已结算窗口仍比较崩溃前 receipt 的 canonicalHash，两窗口均保留一次预算、不可变 operation 和第三进程 replay 验证。

首次测试超时（private 通过、users 失败）；夹具将 Location map 仅 provide 给 make，返回后就释放了映射作用域。将 provide 覆盖服务启动与观察全过程后通过，未修改产品恢复逻辑或延长超时。最终 HTTP 两项通过（44.76 秒），Server typecheck 退出 0，两文件格式通过、lint 0 warnings / 0 errors。

本批证明隔离 Windows SQLite、真实 users claim 在原 lease 自然过期后，由原服务启动扫描自动发现并完成 wait 控制接管；不证明 30 秒周期扫描、多个 scheduler 竞争、恢复期间撤权、真实 Provider 副作用或旧 Loop 全入口退出。R05 仍未完成。以下为历史记录，其中“后台扫描未验证”现仅启动扫描这一子范围被本批替代。安全自检：仅隔离测试与证据，无真实用户数据、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 历史续验：Action 已结算、控制 attempt 未结束的强杀窗口（2026-09-07）

原 users crash fixture 保留 prepare/recover，另增加 prepare-settled/recover-settled。prepare-settled 通过真实 ActionGateway.execute 及原 wait 完成 Action 结果持久化，保留 running/activeAttempt；使用与原恢复相同的 allowControlRecovery，不放宽运行时检查。ready 保存原 receipt 后 SIGKILL，等原 lease 自然到期，新进程调用 executeControlGateway；direct 抛错哨兵保证结果已结算时不能重新执行。

恢复返回 receipt 的 canonicalHash 与崩溃前 ready 中的真实 receipt 一致，控制 run 完成且无 activeAttempt，maxAttempts=1/attemptsUsed=1、不可变 operation 不变；再新进程 replay 不重复执行/计费。两个窗口都在同一个临时 users 旅程里执行，不通过篡改 completed 状态模拟。首次 fixture 缺 allowControlRecovery 被原 Gateway 正确拒绝，修正夹具调用后再验证，未改产品许可规则。

最终 HTTP private/users 2 外层测试通过（39.51 秒），Server typecheck 退出 0、两文件格式通过、lint 0 warnings / 0 errors。本批只有夹具/测试改动，未新增运行时机制，未重跑 Core 全套。composition=75f54ec38e562c53633f6ecb8706dfecb83a6e40726d864978d0046f466b2683；dependency=8403713ca4a9860a2afc3481c2eafc5c1402c0fcad2e888daf5c4fa13e24338a。

边界：验证的是隔离 SQLite wait 控制的已结算 Action 恢复，不等于真实 Provider 副作用过程中强杀，也没有由 SubagentControlRecovery 后台扫描自动发现/调度，恢复调用由新 worker 显式发起。后台扫描、恢复期间撤权、旧 Loop 全入口退出等仍待完成，R05 不关闭。安全自检：仅临时数据库/夹具/证据，无真实用户数据、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新修复：接管未结束逻辑 attempt，保持原一次预算（2026-09-07）

修复上一节实际 BudgetExhaustedError。executeControlGateway 在取得新独占 control lease 后保留 running 的 activeAttempt；Gateway 真正 handoff 时核对原 attempt 编号和 startedAt，以该 attempt 完成，不先 finish(interrupted) 再 begin 新 attempt。startedAt 沿用原值，耗时包含接管前时间；已用时长加未结束 elapsed 达到原 maxDuration 时 fail-closed，不调用 direct。若 Gateway 恢复已结算结果而没有 direct，则结束遗留 attempt 后完成原控制生命周期。原 schema、claimDigest、预算上限、已用计数与历史事件不改写，不新建恢复引擎。

真实 users fixture 仍用默认 maxAttempts=1 创建新 claim，原 lease/attempt 落库后 SIGKILL、自然等 lease 到期、新进程调用原 Gateway。修复后完成且 activeAttempt 清空，断言 maxAttempts=1/attemptsUsed=1、不可变 operation 完整不变；再新进程 replay 不重复执行。Core 原恢复回归新增 second-begin 抛错哨兵及超时 direct=0 边界（过期仍保留原 activeAttempt，不伪造完成）。测试编写中的类型收窄与 Effect 错误捕获类型问题已修正。

最终 Core 四文件 101 pass / 420 expect（7.37 秒），HTTP private/users 两项通过（31.17 秒）；Core/Server typecheck 退出 0、三文件格式通过，lint 38 warnings / 0 errors。composition=010de98d015b8eeb1efdeabd16085d04de35fe19f2a26a5df701972e05729cc1；dependency=0b97338bbc1af4541e5b431456ce2f5eaa33cc3996dfc7e6903efbde6f19a596。

边界：修复适用于仍有 activeAttempt 的持久请求；已经由旧代码结束并耗尽预算的历史记录不会被自动重置/复活。真实强杀发生在已持久 attempt、尚未进入直接 wait 操作的位置，不证明 Provider 副作用过程中强杀或所有 Gateway 中间状态；已结算 Action+遗留 attempt 的组合分支、后台扫描和多进程撤权仍待专门验收。R05 不关闭。安全自检：原 TS 共享控制恢复与隔离测试/证据，无真实用户库、凭据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新失败回归：运行中 ControlRun 强杀接管耗尽一次预算（2026-09-07）

本批未修复、不得验收通过。原独立 worker 增加 prepare/recover 模式，真实 users 主体通过原 SubagentControl.claim 创建新 wait claim，再用原 acquireControlLease（2 秒）、transitionControl、beginControlAttempt 持久化 running/activeAttempt 后等待。协调夹具在收到 ready 后真实 SIGKILL，等待原 expiresAt 自然到期，再启动新进程执行原 executeControlGateway；没有修改历史 status、预算或 lease 时间。所有子进程退出后由原临时目录 owner 清理。首次夹具导入错误已修正，不混作运行时缺陷。

实际结果：private 通过，users 失败（1 pass / 1 fail，21.06 秒）。恢复在结束旧 attempt 后进入新 beginControlAttempt，报 DurableRun.BudgetExhaustedError：attemptsUsed=1、maxAttempts=1、reason=attempt limit reached。SubagentControlClaim 默认 maxAttempts=1；executeControlGateway 会 finishControlAttempt(interrupted) 再 beginControlAttempt，因此现有默认真实 claim 不支持此接管路径。之前恢复替身未模拟真实预算，不能据此声称 running 接管可用。保留失败回归，未 skip/放宽断言。

下一修复必须统一恢复 attempt 计数与封存 claim 兼容：不能仅把固定上限改大而忽略旧 claim 的预算/claimDigest/重放身份，也不能重置已用预算或篡改历史。需区分正常重复执行与可证明的崩溃恢复，保持原 ActionGateway 副作用与预算边界。R05 继续未完成；已结算 replay 的上一批成功证据仍只覆盖 replay，不延伸到 running takeover。

夹具 worker/协调 helper lint 0 warnings / 0 errors，格式已执行；当前运行时源码未改。composition=d0fc92a8aff61de9ba9bf5f5cbc976a1ba75dddb278391bc254ae15c45d13f4b；dependency=70ee98ca983bf2bb49ad9afa7f6a7af5dd3d0b8c4a5dd7d84f05463f645af701。安全自检：仅真实临时数据库故障夹具和证据，无真实用户数据/凭据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续验：已结算 ControlRun 的真实 Gateway 跨进程重放（2026-09-07）

原 subagent-control-access-worker 不再仅调用权限谓词，而是构建原 ActionGateway/SubagentControl/DurableRun 服务，复用 fixture workspace 的 Location 并调用 executeControlGateway。原 completed ControlRun 的 sealed material 与父 lease 从持久数据加载，sealedKind=existing；direct 回调安装抛错哨兵，任何重复实际操作都使测试失败。没有新授权实现或新执行器，原 Gateway 的 settled-result 重放负责返回结果。

沿原真实 users owner/admin/member 测试，合法跨进程重放保持 completed/无 activeAttempt，预算完整值与此前相同；角色降权、父/子会话转外租户由 executeControlGateway 自己的 CurrentCheck 前置校验拒绝。捕获已知 AccessDenied 时重新加载并比较完整 ControlSnapshot，必须与调用前完全一致，否则测试失败。移除原提前权限探针，避免只证明手动预检而未触达原交接。

最终原 HTTP private/users 2 外层测试通过（28.28 秒），Server typecheck 退出 0、格式通过，修改的 worker 文件 lint 0 warnings / 0 errors；不将其他文件历史告警视作消失。composition=a681f5bcdd21eab326e280d3e75ae7cdaf57573214a8e74e88cb2c9b60ccde75；dependency=f8b4fc6f8a65349ab863c812055d3b2416819d4c51687be08cc0352ababd9afb。

范围严格限于已结算控制请求的共享 Gateway 新进程重放，不是 running/activeAttempt worker SIGKILL 接管、后台扫描调度或事务提交中途撤权。后者仍待独立验证，R05 不关闭。安全自检：仅原隔离 worker 测试接线与证据，使用临时库和测试主体；无真实用户数据、凭据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续验：真实 users claim 的独立进程权限探针（2026-09-07）

原 HTTP users fixture 的 persistedAccess 从同进程 Effect 改为启动独立 Bun 探针 subagent-control-access-worker.ts。仅传测试数据库、测试 workspace、controlRunID；探针加载真实 ControlRun，用原 rebuildMaterial 重建封存 envelope，principalForClaim 从原 claim 索引及当前 identity/member 行解析主体，再用原 assertSessionReadable 检查从父 run/envelope 取得的会话。没有传入 cookie/token/调用方指定 session，不新增产品权限 owner。

沿原 owner/admin/member 矩阵验证合法 claim，admin 降为 member 后拒绝、父或子会话转到外租户后拒绝；每次都新进程读取，排除依赖原 HTTP 进程身份缓存。仅已知 AccessDenied 转 denied，其他错误/缺失 marker/超时导致测试失败。每个探针 15 秒超时，持续消费 stdout/stderr，等待退出后才返回；未修改真实用户库。

最终原 HTTP 文件 private/users 2 外层测试通过（28.39 秒），Server typecheck 退出 0、两文件格式通过；lint 6 warnings / 0 errors。该外层计数不等于只有两个内部权限场景，也不把内部 throw 断言冒充 Bun 用例数量。仅测试及夹具改动，没有新的授权运行时实现。composition=d7bcae0c927376d62367fd59c32995ecb729551cc9666837124bb44298d450e0；dependency=0c0752ab736dbdd44571f8125dc88340e53a373d7c3d55ff1bfba6b7add7c881。

边界：本探针验证封存 material 重建和当前持久权限，不调用 executeControlGateway/direct，不取 control lease，不证明完整 ControlRun 新进程恢复或提交途中撤权。该端到端交接及补账授权/事务竞争仍是后续项，R05 不关闭。安全自检：隔离夹具/测试与证据，无真实用户数据、凭据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续验：双进程屏障启动的结算恢复（2026-09-07）

原强杀/恢复 fixture 增加可选 release marker：每个新进程加载 before facts 与父子序号后写自己的 ready 文件，协调测试等两个 ready 后才共同放行。两个进程的 before 均断言 childResult/parentBudget missing，不将可能先后执行的 Promise.all 启动冒称已同步读到缺口。Promise.allSettled 等全部 recovery helper 退出后才判断失败，原 15 秒期限与管道消费保留，临时目录在子进程全部退出后清理。

保留串行案例并新增双进程案例。两进程返回的 after facts/digest 一致，各自观测父/子 seq 相比屏障前都恰增加 1；之后第三个新进程重放 repaired=0、facts 与序号不变。并发 repaired 计数不作为实际插入数证明，持久序号才是本例唯一写入证据。最终五文件 102 pass / 458 expect（13.72 秒），Core typecheck 退出 0；额外专项重跑 2 pass / 42 expect（8.47 秒），两文件格式通过、lint 1 warning / 0 errors。

本批只改测试/夹具，没有新增运行时机制或改 HTTP。本地 SQLite 同步启动并发验证不保证每一个 commit 指令交错，也未强制在 SQL 事务内暂停；权限撤销、PostgreSQL、真实 Provider、其他 R05 退出项仍未验收。composition 沿用 57eaade4260511bdf9314ab660c48ed6fcd124b15d5526ae480d16f946717d3a；dependency=efe0fa43d222b8e1747cd253df4d984b3306ea32e802eb8fed2c0614e42bac0d。安全自检：仅测试临时数据与证据，无真实用户库/凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续验：强杀后两个全新进程恢复与重放（2026-09-07）

复用原 child-settlement-sigkill.test.ts / child-settlement-crash-worker.ts，给同一隔离 worker 增加 recover 模式，不新增产品恢复 owner。原 worker 在 SQLite 父结算 intent 提交后等待，被测试进程 SIGKILL；随后第一个新 Bun 进程加载同一临时文件库并调用原 recoverChildren，第二个全新进程重复。恢复不在测试主进程中执行，不能依赖上一进程的 Layer/缓存。stdout/stderr 持续消费，恢复 worker 有 15 秒退出期限，所有子进程 await exited 后才清理临时目录；失败早退可诊断。

首轮 before 的 childResult/parentBudget 均 missing，repaired=1 后两者 present；第二进程 repaired=0、前后 facts/digest 与首轮 after 完全相同，父/子 sequence 均未增加，且断言序号为整数。原 fixture 不包含外部 Provider，因此“不重试 Provider”限于没有执行器/Provider 调用参与，不等于真实远端账单验收。

扩大回归五文件 101 pass / 429 expect（9.47 秒）；随后仅新增两个序号类型断言，专项最终 1 pass / 15 expect（4.36 秒），Core typecheck 退出 0、两文件格式通过，lint 1 warning / 0 errors。没有运行时/HTTP 源码改动，未重跑 HTTP。composition 沿用 57eaade4260511bdf9314ab660c48ed6fcd124b15d5526ae480d16f946717d3a；dependency=10b87eced7a7abd61e91de4fbdcb2bd05d4dfa640930a7fc3aa7f84a817887bf。这是本机 Windows SQLite 强杀/新进程恢复证据，不是 full sandbox、用户 ControlRun 授权恢复或同时多进程补账验收，R05 不关闭。安全自检：仅隔离夹具/测试与证据，无真实用户库、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续验：终态合同拒绝与预算补账幂等（2026-09-07）

本批仅扩展原 SQLite 回归，不新增运行时机制。已发布子合同矩阵增加 terminal=true：先记录一次 completed attempt（duration=25、cost=7、tokens=7），再将子状态转换 completed，保留预算尚未补账的原恢复入口。session/parent/contract/workspace 四类漂移均拒绝且完整 EventTable 不变，证明原合同检查在终态补账前生效。

合法终态分支验证：recoverChildren 返回 repaired=0（无缺失 aggregate），子完整快照不变，父 childBudgetReserved 四项归零、costMicrosUsed=7，完整事件数恰增加 1；再次恢复返回 0 且事件表完全不变。该预算恢复不产生 childResult，因此不代表结果交付或 Evidence 已完整。未把缺结果的 completed 状态称为用户验收完成。

最终 Core 四文件 100 pass / 416 expect（5.59 秒），Core typecheck 退出 0，测试文件格式通过、lint 18 warnings / 0 errors。本批无运行时/HTTP 源码修改，未重跑 Server/HTTP，不把上一批 HTTP 结果写成本批新验收。composition 沿用未变化的 57eaade4260511bdf9314ab660c48ed6fcd124b15d5526ae480d16f946717d3a；dependency=d4d55de6c4821e2dde33df481d47b89dc4c677467c2549fb3b1ccd40db9c05e2。仍待新进程/多进程、补账授权与跨 aggregate 原子性及 R05 其他退出条件。安全自检：只改隔离测试和证据，无真实用户库、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：已发布子任务不能跳过预留合同核对（2026-09-07）

原 ensureChildAggregate 已存在/CAS 竞争路径返回 false 后，recoverChildren 现核对实际加载的 child 是否仍为原 SessionRun child，id/session/project/location 与 reservation 一致，并复用 childAdmissionFingerprint 比较不可变委派合同。检查置于原结果/预算补账分支之前；运行 status、activeAttempt、已用预算不参与不可变 fingerprint，避免合法执行进展被误拒绝。未另建状态或幂等 owner。

SQLite 新回归保留已发布并 running/activeAttempt 的子任务，分别改变其 created 数据的 parent、contract、workspace、session。修复前 30 pass / 3 fail：parent/contract/workspace 实际 Success(0)，session 被原历史回放校验拒绝；修复后全部拒绝且完整事件表不变，合法 none 保持 activeAttempt、Success(0)。最终 Core 四文件 95 pass / 401 expect（5.33 秒），HTTP private/users 两项通过（14.51 秒），Core/Server typecheck 退出 0、格式通过，lint 38 warnings / 0 errors（含故意损坏 fixture 的断言警告）。

限制：本轮新增断言针对运行中已发布 child，不冒称实际 CAS 竞争、终态补账或跨进程恢复验收。补账授权与原子性、新进程/多进程验证及其他 R05 退出项仍未完成。composition=57eaade4260511bdf9314ab660c48ed6fcd124b15d5526ae480d16f946717d3a；dependency=d43ac3af3f29f6ba004fb00a266f2e82d680242f1f1a8f9847ac4aad4ea6e13b。安全自检：仅原 TS 恢复、隔离 fixture 和证据，无真实用户库/凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：沿原预算 admission 校验恢复祖先链（2026-09-07）

原 recoverChildren 在发布/补账前迭代已加载直接父的祖先链，复用 childReservationFor 和 childAdmissionFingerprint：核对原预留的父/子/session/workspace/委派合同、每层 workspace/depth 与父 session，Set 和原 max-depth 限制循环。未引入第二恢复器或排序队列。跨 aggregate 的 seq 不是全局顺序，但合法孙任务预留要求父已创建；“父创建事件未发布、却已有孙预留”不能未经证明当作合法崩溃前缀去修补。全局异常历史应失败关闭而非伪造创建顺序。

新真实临时 SQLite 回归包含合法孙任务恢复及全局幂等重试，另四类篡改祖先 created 记录（自引用、改挂外 workspace 根、委派 objective 漂移、binding workspace 漂移）。修复前 24 pass / 4 fail，四异常均被原路径放过；修复后拒绝且孙仍 NotFound、完整事件表不变。最终 Core 四文件 90 pass / 390 expect（5.12 秒），HTTP private/users 两项通过（14.37 秒），Core/Server typecheck 退出 0、两文件格式通过；lint 37 warnings / 0 errors，包含故意篡改 fixture 的 unsafe assertion 警告。

这是基于持久 admission 的祖先完整性检查，不证明所有身份授权/新进程恢复/多进程竞争、PostgreSQL 或跨 aggregate 结算原子性。缺失父历史不会擅自重建，历史全面损坏恢复和全局规模性能仍需专门验收。R05 不关闭。composition=8d7a2391b3d0239e56cd83626fc01ac906df1f6e0b5a6f454b588ce26db8e464；dependency=b579a9858a7d6e3a59a5464deed35f8846be0eb7961277452869b973ade13bf7。安全自检：仅原 TS Core 恢复链、隔离 SQLite fixture 与证据，无真实用户数据、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：预留恢复的直接父任务绑定校验（2026-09-07）

原 recoverChildren 在 ensureChildAggregate 前核对事件 aggregate/runID、childRunID/child.id、直接父 ID、自引用、child binding 与 run 的 project/location，以及原父 SessionRun 的 session、已有工作区约束和 depth/max-depth。沿原 admission 的父工作区可选合同：父未声明 scope 不擅自变为禁止；不新增恢复 owner。错误通过原 CorruptHistoryError 返回，异常记录不会先发布再报错。

临时 SQLite 夹具制造“预算预留后子 aggregate 缺失”，分别篡改 aggregate、identity、parent、project、location、binding、depth、session 八类字段。修复前 15 pass / 8 fail，部分异常实际 Success(1)，另有先发布后发现损坏；修复后全部拒绝，child 仍 NotFound，完整 EventTable 与调用前一致。正常崩溃恢复、幂等、结算和递归取消原测试仍通过。最终 Core 四文件 85 pass / 375 expect（4.83 秒），HTTP private/users 两项通过（14.68 秒），Core/Server typecheck 退出 0，两文件格式通过；lint 36 warnings / 0 errors（包含测试故意构造坏数据的类型断言警告）。

范围：只验证每个预留与直接父绑定，不宣称完整祖先链、全局乱序恢复、多进程权限竞争、PostgreSQL 或结果/预算补账原子性已验收。R05 保持未完成。composition=31156ec0520978b60c7817e79111070e0574746b8f824f6d8589a80a72ec866d；dependency=1ee14dfafba4687f415e55e56258095afac1cc4f5f779386ff58efe2df5cb712。安全自检：仅原 Core 恢复、隔离测试与证据，无真实用户库、凭据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：待恢复子记录的提交授权与未发布会话（2026-09-07）

原 ensureChildAggregate 在补写 ChildRunCreated 的 EventV2 commit 回调中消费 CurrentCheck，拒绝由原权限错误恢复 helper 传播；recoverChildren 错误合同显式增加授权/树范围错误。未发布 child 不在 listChildren 中，因此发布者将 reservation.childRun.sessionID 通过临时 PendingSession 作用域传入，原 Gateway 的活检查额外调用同一会话读取谓词。作用域不序列化、不成为新任务 owner，普通无用户控制上下文恢复保持原行为。

原“父预算预留后、子创建前崩溃”SQLite fixture 先移除测试子 aggregate，再以拒绝检查调用 recoverChildren：回调看到准确待发布 sessionID，恢复失败，子仍 NotFound、父完整快照不变；随后无拒绝恢复仍 repaired=1、原绑定和初始序号正确。测试证明提交回调和 pending session 传递；未把它称为完整多账号新进程旅程。最终 Core 四文件 77 pass / 343 expect（4.37 秒），HTTP 2 外层测试通过（14.42 秒），Core/Server 类型、四文件格式通过；lint 57 warnings / 0 errors。

仍待：真实多进程撤权竞争、待恢复记录异常 workspace/祖先绑定的完整校验、结果/父预算补账授权策略，以及 R05 其他退出条件。原内部恢复没有用户作用域时仍依靠其已有可信所有者合同，本批不宣称所有恢复来源都已授权验收。R05 不关闭。composition=91d6bd1c49fa12b80e6fd99a8ce4bbf10ba6367de024699c79a751d41c43ce3f；dependency=844f48188f5a4260fd3bdcf062bed0aa63cc41c713a2059035434d282e5449d5。安全自检：仅原 Core 恢复发布及临时 SQLite fixture/证据，无真实用户库/凭据/外部 Provider/CLI/PATH/发布/full sandbox 操作。

# 最新续修：取消活跃 attempt 的事务内授权（2026-09-07）

原事务拒绝回归扩展 activeAttempt=true，修复前明确失败：拒绝后 activeAttempt 消失、lastSequence 4→5。原 cancelOne 现给私有 finishAttemptInternal/publishAttemptFinished 传原 EventV2 commit 回调，在取消导致的 RunAttemptFinished 插入事务中复核 CurrentCheck。正常 finishAttempt 调用未新增用户取消语义；控制 run 结算不受此回调扩张。已知权限 defect 转 typed failure 的恢复逻辑由 cancelOne 内同一 helper 复用。

修复后 active=false/true 两项事务回滚测试均通过，保留完整 child snapshot 及测试 title；最终 Core 四文件 77 pass / 339 expect（4.36 秒）。真实 users HTTP 合法取消夹具在正向操作前启动 child attempt，完成取消后检查 activeAttempt 清空、status=cancelled，后代取消保持通过；最终 HTTP 2 外层测试通过（14.49 秒）。Core/Server typecheck 退出 0，三文件格式通过，lint 31 warnings / 0 errors。

限制：attempt 结束和 cancelled 仍是两个各自授权的事件事务，不承诺整次取消全回滚；合法完成前一个事务后撤权可以留下可恢复的部分进展。父预算结算、待恢复后代发布、两进程竞争及 PostgreSQL 隔离验收仍未闭合，same-transaction settlement gate 未改。R05 不关闭。composition=d912678adede47c6b4895554c62bd067fcef4747871557d3926a00501bc996c0；dependency=44e5e6e1c94a8a9c0e642a0e02a773f9485df6230503c8a235ab7188b947b94e。安全自检：仅原 Core 取消提交链、隔离 fixture 与证据，无真实用户数据/凭据/Provider/CLI/PATH/发布/full sandbox 操作。

# 最新续修：cancelled 事件的事务内授权回调（2026-09-07）

确认原 EventV2.PublishOptions.commit 在 commitDurableEventInTransaction 插入事件与序号前执行，SQLite 使用 immediate 事务，提交后才通知订阅者。原 publishState 的 ChildRunCancelled 及 SessionRun cancelled 转换复用该回调执行 CurrentCheck；没有外包整棵树事务，没有开启 same-transaction settlement gate。EventV2 回调是无错误合同，授权失败在事务中转 defect 以回滚，再由原 cancelOne 恢复已知 AccessDeniedError/TreeScopeError，其他 defect 保留。

新 SQLite 回归在非递归、无 activeAttempt 的第三次检查（事务回调）写入测试会话 title 标记后拒绝：检查恰为 3 次，取消失败，child 完整快照不变，title 仍为原值，证明标记写入与事件提交处于同一回滚范围，而不是在事务外多做一次检查。正常真实 users/private HTTP 仍通过。最终 Core 四文件 76 pass / 335 expect（4.29 秒），HTTP 2 外层测试通过（14.32 秒），Core/Server typecheck 退出 0；两文件格式通过，lint 25 warnings / 0 errors。

限制：只验证 cancelled 事件提交点的 SQLite 事务回滚；没有两进程并发权限写入或 PostgreSQL 隔离验证。activeAttempt 结束、父预算结算、recoverChildren 内部发布未在本轮建立同等原子授权保证，已发远端中断不可撤销，整树部分取消不会回滚。R05 不关闭。composition=2a8e771401372b4b7a65d54f5e2804f965d8e01a02f84eacee5da731d09d164d；dependency=bb0a4ba4c8991752729b03c252a0e79a60d2baa8b0728d1448937084de696b73。安全自检：只复用原 TS EventV2 事务与取消路径及临时数据回归、证据，无真实用户库/Provider/CLI/PATH/发布/full sandbox 操作。

# 最新续修：原 DurableRun 逐个后代取消复核（2026-09-07）

原 cancelTree 在 recoverChildren 前后复用作用域 CurrentCheck；cancelOne 在读取目标前、结束 activeAttempt 前及写 cancelled transition 前复核。沿原递归/结算路径执行，没有另建任务树或取消 owner。cancel/cancelChild 的错误合同显式包含 AccessDeniedError/TreeScopeError，未通过 defect 吞掉授权错误。无用户控制作用域的原内部调用仍按原合同工作。

SQLite 新回归创建两个 running 孙任务，原 cancelChild 完成第一个后，测试授权检查改为拒绝；调用明确失败，只一个孙任务 cancelled，另一个 running 且全 snapshot 不变，直接子任务仍 running。保留已提交的合法部分，不伪造整树回滚或成功。控制+durable-child 两文件 24 pass / 121 expect（2.59 秒）；durable-run+恢复两文件 51 pass / 210 expect（3.15 秒）；HTTP 2 外层测试通过（15.08 秒）。Core 定向类型通过；workspace 类型 22/22 通过但 20 cached，仅 Core/Server 重跑（13.381 秒），不称全冷类型验收。两文件格式通过，lint 24 warnings / 0 errors。

限制：检查与每次写入尚未放进同一个权限隔离事务；此前合法提交不会撤销。recoverChildren 的内部发布本身、取消中的预算结算与权限原子性、新进程恢复和大树性能仍待处理。当前只证明后代之间可以停止，不证明所有 TOCTOU 已关闭。R05 不关闭。composition=2ebfa8e13e2971a24b2bc38633f9f8145551ad0fcc6c009dc0af99c05a7fd495；dependency=a3ccf9356a966897f4408ac96a3bafea83a8ac852161ce5c0bfb0ed2de56ea91。安全自检：原 TS DurableRun 和隔离回归/证据，无真实用户数据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：取消操作内部的活授权复核（2026-09-07）

原 executeControlGateway 将现有 assertAccess effect 通过作用域 CurrentCheck 传给 direct operation；它每次执行重新读 claim 主体/角色/会话及递归树，不持久化回调、不接受客户端权限字段。Core SubagentControl.authorize 消费该检查；cancel 在 Provider.cancel 返回后及 SessionExecution.interrupt 返回后再次消费，阻止撤权后的后续 durable.cancelChild。原纯 parent-lease 内部调用保留默认无附加用户检查的合同，HTTP/后台控制 handoff 必须注入；不是另建身份 owner。

原 Core SQLite fixture 两个故障场景：Provider 返回时撤权 → Provider 调用 1、本地中断 0、child 全快照不变；本地中断返回时撤权 → Provider 1、本地中断 1、child 全快照不变。恢复夹具另验证 direct 内部能收到同一实时检查，撤权后不继续；否则默认空检查会使该回归失败。最终控制/恢复两文件 19 pass / 86 expect（1494 毫秒），Core typecheck 退出 0；原 HTTP 2 外层测试通过（14.30 秒），Server typecheck 退出 0。五文件格式通过，lint 46 warnings / 0 errors。

限制：已发送的 Provider/本地中断不能撤回，测试不声称恢复远端计费或执行。此次阻止的是撤权后继续 durable 取消；检查与后续写入之间仍不是同事务，DurableRun.cancelTree 的逐个后代 mutation、recoverChildren 新发布后代及多进程恢复尚需处理。重复整树扫描的性能/限额验收也仍待做。R05 不关闭。composition=02a73d247369bd754628652973e30cd90f099791887acadb348d8ea8b08820c7；dependency=c3050eabe096c5a431972bbcc96048fa2da9583b66a470873d37428330056038。安全自检：只改原 Core 控制作用域及隔离回归/证据，无真实用户库、凭据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：递归后代预检融合到后台共享执行边界（2026-09-07）

HTTP 中的有界后代扫描移动到原 Core subagent-control-access，原 HTTP 保留轻包装调用，TreeScopeError 映射 409；会话拒绝仍 403。后台/HTTP 共用 executeControlGateway 对默认或显式 recursive:true 的 cancel，在取控制 lease 前及 Gateway execute 入口都调用同一后代检查；recursive:false 不扩大为整树扫描。保留 1,000 截断拒绝、循环/异常绑定拒绝，不新增取消执行器。

Core 原恢复 fixture 现能构造真实 cancel material/subject。新增递归截断拒绝（direct=0）、非递归不扫描且 direct=1，以及首次树为空、Gateway 交接时出现不可读后代的拒绝（两次扫描、direct=0）。最终恢复文件 10 pass / 38 expect（685 毫秒）；HTTP private/users 原文件 2 外层测试通过 / 0 fail（14.32 秒），含真实外租户孙任务拒绝、恢复合法归属后子孙取消成功。Core/Server typecheck 全部退出 0；四文件格式通过，最终 lint 43 warnings / 0 errors。

边界仍为两次快照预检，不证明取消开始后的逐个 mutation 原子授权、Provider 已发中断后的撤权、recoverChildren 发布新后代或完整新进程恢复。相关故障需继续接原 DurableRun/Provider 所有者，不在 HTTP 叠加另一套状态机。R05 不关闭。composition=0c028d000f2532f175098c0eee41a10eb1e783ea69af8483f27cd44976a8a21e；dependency=438ba6ef33d51d2ceb2135ac0cc977ffe2c46fc2dc1d8a4d89e83f23339917eb。安全自检：仅原 Core/HTTP 校验融合、隔离测试和证据，无真实用户数据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：HTTP/后台共用的持久 claim 主体复核（2026-09-07）

原 executeControlGateway 在控制 lease 前及 ActionGateway execute 回调入口新增当前权限复核。主体仅从原 ControlRunClaimTable 按 run_id 读取，要求唯一记录，并重新计算 principalRef/controlPlaneID 与原 ControlRun 匹配；缺失/多义/错配拒绝，不反解 opaque hash、不信任请求附加身份。非 local 主体查询当前 active user/member 与角色；精确 local 主体保留原嵌入模式无 identity 行约定。父、子 session 必须仍可读。HTTP 原会话读取谓词已下移到 Core subagent-control-access，由原 handler 包装映射 403，避免 HTTP/后台保留两份会话规则。

Core 原恢复夹具补数据库读取替身（此前 {} 无法证明授权），新增 before-lease/gateway-handoff 撤权两项：实际 direct 调用为 0；前者未进入 Gateway且控制 run 仍 draft。原恢复/崩溃 attempt 接管/settled replay/并发 lease 测试保持通过，共 7 pass / 27 expect（627 毫秒）。真实 users SQLite fixture 还直接从已创建 claim 解析主体并调用同一会话谓词，证明当前合法身份可用、admin 降权及父/子转外租户后 Core 校验失败，不依赖 HTTP 预拦截。最终 HTTP 2 外层测试 / 0 fail / 2 expect（14.41 秒），包含原合法递归取消和撤权重放。Core、Server typecheck 退出 0；六文件格式通过，lint 46 warnings / 0 errors。

范围限制：恢复入口复核由原共享 executeControlGateway 单元证明，SQLite 主体/角色查询由真实数据库证明，尚未把两者串成新进程崩溃恢复多用户验收。该层检查当前父子会话；后台递归后代检查、逐个 mutation 及请求途中撤权、待恢复后代发布仍需继续融合，PostgreSQL RLS 下后台读取主体的执行上下文也未验收。没有绕过失败关闭，也未把旧 lease 当作用户权限；R05 不关闭。composition=fd9833e6f3de2ebf55bf582d0d88711994d081549ecab0cd5e149231ac18d6bd；dependency=24993aa107db09468c44f505d414f59650ecb56ce6f766c802f45cca0770a36d。安全自检：原 Core/HTTP 规则融合与隔离测试、证据；无真实用户数据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：递归取消的可见后代授权预检（2026-09-07）

users fixture 新增真实 running 孙任务，直接父子会话可读而孙会话属于 foreign tenant；原 member 默认递归 cancel 实际返回 200（专项 0 pass / 1 fail）。HTTP 原 cancel 在创建 claim/调用 Provider 前，现复用 assertSessionReadable 与 DurableRun.listChildren 迭代检查可见后代、父子/工作区绑定及重复节点。listChildren 硬上限 1,000，因此满页或累计树超限时 409，不将截断结果误判完整；recursive:false 不扫描后代。不新增取消执行器。

修复后跨租户孙任务取消 403；拒绝/观测段父、子及孙 durable 快照不变。恢复孙会话合法归属后，同一 member 的新递归 cancel 返回 cancelled，原 children GET 证明孙任务也 cancelled。最终 HTTP 2 外层测试 / 0 fail / 2 expect（16.71 秒），Server typecheck 通过；额外根 workspace typecheck 实际运行 22 项全部成功、0 cached（65.716 秒；App/desktop 自身增量机制不等于清除所有内部缓存）。三文件格式通过，lint 11 warnings / 0 errors。

明确边界：这是 HTTP 入口当前可见树预检，不是原子取消授权。扫描后新增/改变归属的后代、recoverChildren 发布的待恢复子任务、后台 executeControlGateway 恢复绕过 HTTP 的校验，以及逐个 durable mutation/Provider 中断时重新授权仍待完善；1,000 节点拒绝策略未做边界性能验收。已读后台 recoverOne 目前重建原 envelope 并校验 parent scope/lease，未发现用户会话角色复核；下一步必须把可信 claim 主体的授权接入原恢复/执行边界，不可把本预检当作全修复。R05 不关闭。

composition=a81a95092c133a017fa3a409c685d75e61b21dd05af3046c90e4fc5cc177e258；dependency=724cbbc2aa1cde7ca8bf888fc663c47971dd74719c1eac5a2df6e0feb4c95ebf。安全自检：仅原 TS handler、隔离孙任务 fixture 与证据；未操作真实用户数据、Provider、CLI/PATH、发布或 full sandbox。

# 最新续验：已有控制记录的归属变更与角色降权（2026-09-07）

原 users HTTP 夹具中，owner/admin/member 各先成功创建 wait claim，再分别把 parent 或 child 会话转入 foreign tenant；同一 cookie、同一 requestID 的 status GET 与 wait POST 重放全部 403，拒绝正文无原 controlRunID/child ID。恢复归属后重放 200 且 controlRunID 与原记录相同。admin 另在保留旧登录的情况下由原成员表降为 member：GET/POST 均 403；恢复 admin 后原 claim 再次可读。没有注入假身份，没有重新登录来掩盖旧 cookie 问题，没有新增产品分支。

最终 HTTP 2 个外层测试通过 / 0 fail / 2 expect（13.26 秒；内部矩阵为 throw 检查），Server typecheck 通过；本轮唯一改动的测试 helper 格式化成功、lint 0 warnings / 0 errors。原 private 控制矩阵与 users 父子 durable 快照检查保持通过。证明的是后续请求按当前归属/角色重新授权及原 claim 幂等身份，不证明请求中途撤权、后台恢复或递归取消后代边界，也不证明真实浏览器与 PostgreSQL RLS。R05 未关闭。

composition=761620d9b743eb18e3db765d60a6cf6fc708a0162be4d23eb41e0beb70259b3e；dependency=e901bdeb31dcc6e37a3888dc6046bbf7ea433829136f74b8725d98113a4afaad。安全自检：仅临时 SQLite 测试与证据；未触及真实用户账号、凭据、Provider、CLI/PATH、发布或 full sandbox。

# 最新续修：控制入口缺少用户会话授权的越权修复（2026-09-07）

真实 users cookie 回归先复现：将父 SessionTable.owner_user_id 改为同租户他人后，member 对已有活 parent lease 的 child 发 steer，预期 403，实际 200，专项 0 pass / 1 fail。这是实际控制入口授权缺口，不是 UI 显示问题。parentLease 原来只查执行/工作区，不能代替用户权限；本轮复用已有 assertSessionReadable，在 parentLease 返回前核对父会话，在 steer/followup/wait/cancel 创建 claim 前核对子会话，status 查询 claim 前核对父子会话。保留原租约、Gateway、principal-bound claim 和父子绑定，不新增权限 owner。Protocol 五个入口补 ForbiddenError，原 Client 生成器同步。

users 隔离夹具先保留无租约只读授权矩阵与快照不变检查，再获得真实 parent lease。分别将父/子会话归属同租户他人，member 以及 foreign tenant owner 的 steer/followup/wait/cancel/status 均 403，拒绝正文无 child/control metadata。恢复成员归属后 owner/admin/member 的 wait POST 均 200，有 durable controlRunID，并可 GET 本人 claim 得到同一 ID；不以全拒绝冒充修复。该段前后父子 durable 快照不变（正常 wait 会新增自己的控制记录，不声称整个数据库无写入）。

最终 HTTP 原文件 2 pass / 0 fail / 2 expect（12.56 秒，内部矩阵为 throw 检查，不额外计数）；Protocol 4 pass / 21 expect（179 毫秒）；Server、Protocol、Client typecheck 全部退出 0，四文件格式通过，lint 10 warnings / 0 errors。Client 原生成器退出 0；未做旧 SDK JS 全生成或浏览器全回归。本批为 handler + SQLite + 真认证，非真实监听服务/浏览器/远端 Provider 全链验收。

仍待验证：会话归属/成员资格在请求中途改变的竞态、已登记控制恢复时的用户授权、递归取消跨后代边界、合法用户 steer/followup/cancel 的 users 模式完整正向旅程（private 模式已有原回归），以及 R05 的旧 Loop、冷恢复、跨 aggregate 原子性、tail/Evidence。不得把本批入口拒绝矩阵称为全系统授权完成。composition=852838fde9e8f8ba318eab9dbbc5da81fc5942083eab7d2e5c713b2b43804474；dependency=162cb4432add379135c75f7c8e316030d6e2b7902ec9532f3ca08ba74d28e4fe。安全自检：只改 TS 原入口/契约/生成客户端及临时数据库测试、文档，无真实用户数据/凭据访问，无发布或 full sandbox，R05 保持开放。

# 最新续验：真实登录态的多用户子任务只读授权（2026-09-07）

扩展原 subagent-control-route 独立进程夹具，private/users 分别使用临时 SQLite 和工作目录。users 模式通过原 UserAuth 注册、邮件验证 token 与密码登录创建 owner/admin/member/foreign 四个测试账号，再由真实 cookie authorization middleware 解析身份；没有注入伪造 IdentityContext，没有外部邮件或真实账号。父子 DurableRun 仍由原 fixture 创建，先释放父 lease，再做历史读取矩阵。

已实际通过：无 cookie/非法 cookie 为 401；member 本人的父子会话可读；owner/admin 可读同 tenant 的 member 会话；foreign tenant 的 owner 被 403 拒绝。分别只改变 parent 或 child 会话归属，member 对同租户他人会话被拒绝，admin 仍可读；归入 foreign tenant 后 owner/admin/member 全部拒绝，恢复归属后 member 再次可读。成功响应绑定正确 child，controlAvailable=false；拒绝正文不含 child ID/objectiveDigest。整个矩阵前后父子 durable 完整快照不变。仅测试归属行会受夹具调整，不声称查询完全没有认证/audit 写入。

最终原 HTTP 文件 2 pass / 0 fail / 2 expect（12.03 秒），两个外层测试分别包含 private 原控制/恢复投影矩阵与 users 新授权矩阵；内部 throw 检查不累计为独立 bun 测试数。Server typecheck、三个文件格式检查通过，lint 6 warnings / 0 errors（旧夹具断言与未使用导入等仍保留）。本轮未修改产品授权逻辑、未新增任务 owner 或并行权限系统。

边界：真实认证代码 + 进程内 HTTP handler + 临时 SQLite，不是浏览器到监听服务的完整用户旅程，也不是 PostgreSQL RLS、多进程崩溃或 OS sandbox 验收。本批只证明 children GET；steer/followup/wait/cancel 与 claim status 的多账号授权仍须单独审查，不能用 GET 通过替代。R05 继续开放，跨 aggregate 结算原子性、冷恢复、旧 Loop 可达路径和 tail/Evidence 仍待做；full sandbox 后置。

composition=0e7126a9badbdda6727d2c098d733fe55173c3f9ea4d0cbfe159189d585cabe9；dependency=e7815909a4ad20be3ed56006cc69275838d00be716f2a1dc090209e46fd835d1。安全自检：只修改隔离测试与证据，不访问真实用户库/凭据、不调用外部 Provider、不重启用户应用、不改 CLI/PATH、不发布；没有将局部通过换算整体完成率。

# 最新续修：历史子任务发现与真正的只读刷新（2026-09-07）

PersonalWorkspace 不再按 running/queued/recovering 筛父任务，查询当前快照中前 12 个执行（既有上限保留），因此已结束父任务的可读 children 可见。children 响应新增可选 controlAvailable 快照提示：父 lease 存在且未过期、父非终态才为 true；它不是授权令牌，原控制请求仍复核。Client 用原生成器同步，UI 仅显式 true 展开控制；缺字段/未知或 false 默认只读，run 回调也检查，不仅隐藏按钮。

原 ChildControlCard 新增“刷新状态（只读）”，通过原 PersonalWorkspace.snapshot/children GET 刷新，不使用 wait POST；无控制时保留打开会话与刷新及说明。刷新使用原 scope request guard，复用既有 busy/error，不增加领域状态或任务队列。中/繁/英文提示明确历史范围和读取失败可能性，控制不可用不再等同没有子任务。ui-ux-pro-max 指导只读/可操作区分与非颜色提示；未新建页面。

隔离 Chrome fixture 用 completed 父 + controlAvailable:false，只实现 snapshot/children 查询，验证历史卡可见、刷新回执 missing→present、无控制按钮。原窄屏/桌面测试追加旧服务缺 controlAvailable 时关闭已展开控制，仅保留只读查看。最终 4 passed（10.6 秒），包含原 scope 迟到响应隔离；受控 API，不等于真实账户到后端完整旅程。HTTP 原独立进程夹具新增活 parent true/释放 lease 后 false，最终 1 外层测试通过（8.07 秒），保留跨 tenant/无 lease 控制拒绝。App 单元 8 pass / 53 expect（167 毫秒）。App、Server、Schema、Protocol、Client 类型通过；七文件格式通过，lint 21 warnings / 0 errors，最终 fixture 格式再次通过。测试后 4328 无监听。

范围限制：仍是快照前 12 个父执行，不是全历史分页；个别失败 GET 被隔离但尚无逐项重试说明。controlAvailable 为查询时提示，之后过期仍由服务端拒绝，未实现实时到期 UI 倒计时。多账号/member/admin 真实授权验收、完整视觉/读屏、SDK JS 全生成、冷恢复/跨 aggregate 原子性、tail/Evidence 仍未闭合，R05 不关闭，full sandbox 后置。composition=32409b05652e109ce0cf6e31600d64d02a2aa6ef37b6b947c5ec95b9a377851f，dependency=12c5f8a463536ab5318ee1803f2666710186e7901834855a88de31f308f53801。安全自检：原 TS 查询/卡片/生成客户端、隔离夹具及证据；无用户应用重启、真实用户库、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：无父执行租约时的授权只读子任务发现（2026-09-07）

原 children handler 先调用 parentLease，父 worker 释放后即使任务归属合法仍返回 409；隔离 HTTP 前置回归已复现。该 GET 现保留原 parent/child/project/location 绑定，按既有 artifact/session 读取政策核对 SessionTable 的 tenant_id；member 另需 owner_user_id 相符，owner/admin 仅可同 tenant。每个 child 会话均校验，ForbiddenError 仅由 children 映射并在 Protocol 声明 403，避免扩大其他操作错误类型。不为读取抢占/重建租约，不修改 Core 执行合同；steer/followup/wait/cancel 仍走 parentLease 和原 Gateway。

原独立进程 HTTP 测试扩展：先释放 parent lease，GET children 返回 200；把 parent 或 child 会话分别归入另一测试 tenant 时返回 403，拒绝正文不含 child ID/objectiveDigest；恢复 fixture 归属后，四种 POST 控制操作无 lease 均 409。最终 1 个外层测试通过（7.98 秒），内部 throw 断言矩阵不计作独立 bun 测试。foreign tenant 首次 fixture 缺创建者 user 导致 FK 失败，补齐隔离用户后通过；没有改变产品 FK。未实际执行登录 member/admin 多账户旅程，不把静态角色谓词视为多用户授权全验收。

最终 Server、Protocol、Client typecheck 通过；协议原合同 4 pass / 21 expect（180 毫秒）；三文件格式通过，lint 10 warnings / 0 errors。Client 从原生成器同步 403，不手改旧异常字段。本批未改 App，仍有父 lease 筛选及 wait 按钮依赖；用户完成任务后从界面发现历史 child 的旅程尚未闭合，下一步需要保留只读查看、禁用无权控制并更新提示，不应把 wait POST 改成无授权执行捷径。

R05 不关闭；真实 restart、跨 aggregate 原子性、tail/Evidence、整体入口融合及剩余计划继续未完成，full sandbox 后置。composition=38acf8221f1a9176ee5e93f77f51beb2049b943d6253df83733a50f7dd0976c2；dependency=f4c534f65cecba1f6bd6fb3e351e02480fae4464cc908c6966dcc7a8f8ca0cc6。安全自检：仅原 TS 查询/Protocol/生成客户端和隔离数据库夹具、计划证据，无真实用户数据、外部 Provider、CLI/PATH、发布或 OS full sandbox 操作。

# 最新续修：原子任务卡显示回执缺口并给出可读说明（2026-09-07）

原 personal-workspace ChildControlCard 现在将执行状态与结果记录状态分开：missing 明示“执行已结束，结果尚未确认”，说明缺少结果记录不能据此交付、先刷新/打开会话检查、不要为获取结果重复执行；present 说明记录存在不等于验收通过；cancelled 不当作成功；缺字段/未知枚举显示未知。简体、繁体和英文共用原 presentation 文件，非中文沿用英文回退。提示位于卡片默认可见区域，role=status、aria-live=polite、文本换行和原语义颜色；wait 回应使用相同说明，操作提示不再一律绿色。遵循 ui-ux-pro-max 的可理解反馈、非颜色唯一提示及可访问性指导，无新页面/任务 owner。

App typecheck 首次发现真正消费的是 packages/client 生成客户端，而非上批 SDK JS 类型；用原 ClientApi/codegen 补齐，未用断言遮掩。再次生成前后校验两个树 9 个文件 SHA，完全一致；App tsgo -b 与 Client typecheck 通过。注意原生成树已有大范围未提交变更，git diff 总量不能视为本轮增量；预备副本命令因工作目录下路径重复未成功，未把它称为可恢复备份。生成按当前统一契约执行，不是 SDK JS 全生成验收。

单元两文件 8 pass / 53 expect（177 毫秒）；原隔离 Playwright fixture 新增 375px/1280px 两场景，与已有跨 workspace 响应隔离共 3 passed（12 秒）。agent-browser 不可用，使用仓库 Playwright 配置及本机 Chrome、独立 4328 端口；测试后端口无监听。实际 DOM 验证默认缺口文案、live region、打开会话回调目标、键盘 Enter 只发一次 wait、终态无发送/取消控件、收到 present 后提示、旧响应未知、卡片文本无横向溢出。受控 API 夹具，不证明真实产品账户/后端联调；未人工看图，不宣称全部视觉、深色对比度、真实读屏或完整导航验收。五文件格式通过，lint 6 warnings / 0 errors。

R05 仍未关闭。下一步合法无活 parent lease 的只读观测、真实接口到卡片旅程、SDK JS 完整生成核对，以及跨进程恢复、原子性、tail/Evidence 等继续待做；全平台 full sandbox 后置。composition=38ecc379aee1443ab864add9e2f5ac0af3457759b197ddb6f1f78b633b59a083；dependency=0dd7ca3e53f423ffcb78f1a56dd0527fea7b105923fd329d4239bfc073784d54。安全自检：仅 TS 原卡片/客户端、隔离测试和证据；没有重启用户应用、连接真实用户库、调用外部 Provider、修改 CLI/PATH 或进行发布/full sandbox。

# 最新续修：子任务结果回执的统一只读投影（2026-09-07）

实码确认 children 和 wait/cancel 等控制响应仅有 run.status，无法区分 completed/failed 缺回执。协议新增 resultReceiptStatus（pending/missing/present/not-required），由原 Core SubagentControl.resultReceiptStatus 从 DurableRun 的 status/childResult 派生；Server 列表与 responseFromReceipt 共用，未新增存储状态或写入路径。pending 为非终态；missing 为成功/失败终态但无回执；present 仅证明回执存在，不证明父预算/通知/最终验收；cancelled 为 not-required。为旧响应兼容字段可选，缺省是 unknown，不自动变为 present/ready。

在原隔离新进程 HTTP 测试内先增加 running 字段断言，修复前 0 pass / 1 fail；修复后覆盖 running、cancelled、completed/failed × missing/present，列表与 wait 一致、查询前后 child snapshot 不变、结果正文不泄露。最终外层 1 pass / 1 expect（7.83 秒），矩阵断言在子进程使用 throw 检查，不能伪称多个独立 bun 测试。Core 控制/恢复两文件 11 pass / 56 expect；协议含四值 roundtrip、非法 ready 拒绝、旧响应 undefined 省略的 4 pass / 21 expect，最终复验 179 毫秒。Core、Server（最终重复）、Schema、Protocol、SDK JS 与 SDK Next typecheck 均通过；六文件格式通过。

静态检查五个源/测试文件 14 warnings / 0 errors；包含现有生成 types 文件的六文件扫描 503 warnings / 0 errors，未清零。SDK JS 的两种响应类型及共享枚举用小范围 apply_patch 同步，未运行会 clean 目录的整套 SDK 生成器，以保留当前已修改生成文件；生成器可再生一致性仍须验证，不能称全 SDK 生成验收。本批未跑 Formal 全筛选，上一轮 16 项不用于本批验收。

限制：这是 API/SDK 只读投影，不是界面待处理提示已完成。下一步应在原 personal-workspace 子任务卡接入说明（不凭 missing 断言没有 intent，不自动重跑），并验证旧服务未知值及父任务无 lease 时的合法只读观测路径；现有父 scope/lease 检查未削弱。原子性、真实恢复、tail/Evidence 和其余入口仍未验收，R05 不关闭。composition=b134cae0e66f9f5d9ed726bc72f385ed302581a7941fd7b1b0eb62ba1879df29；dependency=5ec6c24ada672185350fdba764e0e3cf277c3de8707e8926382955050770c655。安全自检：仅 TS 原 owner/契约/响应、隔离 HTTP 测试及计划证据，无真实用户数据、外部 Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：Formal 重复诊断限频，不限制恢复检查（2026-09-07）

原 scanner 每 2 秒对同一失败写 warning。现在在原 Formal layer 生命周期内持有最多 1024 项的临时诊断摘要：run ID 隔离，事件序号与 Cause 摘要区分变化；首次、指纹变化、时钟回拨立即记录，相同指纹 60 秒后再记录，成功后清除。整体 scan 失败也使用同一机制。判断仅位于原 catchCause 的日志分支，实际恢复仍每 2 秒尝试；不持久化新的任务状态，不跳过授权或补账。容量满时驱逐旧诊断，极高基数可能提前再次记录，不宣称全局日志总量硬限额。

新增纯诊断边界测试 6 pass / 45 expect，覆盖间隔、变化、成功清除、任务/扫描隔离、容量和回拨。Formal completed/failed 专项 2 pass / 62 expect / 92 filtered（23.46 秒）；最终原 Formal 筛选 16 pass / 297 expect / 78 filtered / 0 fail（129.44 秒），证明恢复和通知、续接、取消未被诊断判断阻断，各批退出 0，重叠不累计。Arforge typecheck、三文件格式通过，三文件 lint 6 warnings / 0 errors。期间修正 Effect 分支 void/undefined 推断及摘要类型，未扩大业务行为。日志频率由纯边界测试证明，本批未捕获真实扫描器跨分钟的 logger 输出，不把它冒称完整产品日志验收。

用户可见的结算待处理说明尚未接通；已定位 server 原 subagent-control 查询/响应投影，后续应融合既有契约，不能新建任务状态 owner。跨 aggregate 原子性、真实新进程恢复、tail/Evidence、剩余入口融合仍未完成，R05 不关闭。composition=7a577eefc62e9b77e7b3a1f948bcb1422227bbb5c645f882003c33ff04fa82a4，dependency=5ce97861d3650ad898c855ea84286972841cacedf6823318673219ec5ddfef3c；源码快照随后用原生成器重建。安全自检：仅原 TS 扫描器日志及无持久状态辅助函数、隔离测试、计划和证据，无真实用户数据、Provider、CLI/PATH、发布或 full sandbox 操作。

# 最新续修：终态结算检查先于后台任务接纳（2026-09-07）

正式 completed/failed 遗留夹具先保留无回执、无 parent settlement intent 的前缀，连续调用两次原 recoverTask。修复前两场景均返回 Success，未同步拒绝后台接纳，回归 0 pass / 2 fail。TaskRuntime 现于冻结身份、权限和会话校验之后、metadata/BackgroundJob/通知注册之前，调用原 ChildExecutor.prepare 的终态分支：无意图返回 SettlementIncompleteError；有意图仍由原 lease/recordChildResult/父预算 owner 恢复，不引入新队列或状态机。

修复后两次无意图恢复均类型化失败，BackgroundJob 不存在，父子完整 snapshot 不变，模型请求为 0；随后写入可信意图，原 Formal 扫描仍恢复结果并仅唤醒父模型一次，失败通知保持失败语义，重复通知不增加上下文。专项 2 pass / 62 expect / 92 filtered（23.53 秒），最终 Formal 筛选 16 pass / 297 expect / 78 filtered / 0 fail（130.41 秒），Task 全文件 31 pass / 177 expect（12.34 秒），各批退出 0，重叠不累加。Arforge typecheck、两文件 prettier 通过；两文件 oxlint 44 warnings / 0 errors，告警未清零。

边界：仅消除该无意图路径的后台任务与通知写入，不是扫描节流完成。扫描器仍可能每 2 秒重复只读诊断；用户可见的待处理说明、正式策略变化/活 owner、tail 缺回执、Evidence、父 intent/子回执跨 aggregate 原子性和真实新进程恢复仍待继续，R05 不关闭。composition 摘要 539d9c139084214aa3b1f4ef30c5ea931874d11e263d5c0b4fb1adf0a5f87fc9；dependency 摘要 efdb1ced46e28623d0d8848fe98a489bf965df6ba11bc04126ec652b6d60d5d1；源码快照由后续原生成器生成并校验。安全自检：仅原 TS owner、隔离夹具及计划证据增量，无真实用户数据、外部 Provider、CLI/PATH、发布或全平台 sandbox 操作，保留既有工作树改动。

# 最新续验：Formal 失败终态恢复与通知语义（2026-09-07）

正式遗留状态矩阵增加 failed，与 completed 一样只持久化结算意图、不给子模型准备响应。恢复后状态和 childResult.status 保持 failed、原摘要保留；父通知正文明确为 Background task failed，completed 对照为 completed。两个场景 child attempts/assistant 均为 0、模型请求只发生在父收到通知后；通知重放不增加父上下文或请求。本轮仅扩充正式回归，没有新增产品分支。

首次正文断言采用嵌套不对称 matcher，后续重放通知时正文被观测为 matcher 对象而非 string，两个测试在 Schema 解码失败；这是测试夹具问题，已改成先用 Schema 解码 payload.text 后对字符串做 toContain，未改产品解码规则。最终 completed/failed 两场景 2 pass / 38 expect / 92 filtered / 0 fail（23.45 秒），Arforge typecheck、格式通过，测试 lint 22 warnings / 0 errors，未清零。前一 failed 单项 1 pass / 17 expect 与最终批重叠，不累计；没有将前一轮全部 Formal 数量冒充本批全量。

限制：仍是同进程意图前缀注入，不是跨进程故障恢复；正式策略改变/活 owner、无意图待处理与节流、通知 tail 缺回执、Evidence、跨 aggregate 原子性和真实重启仍待继续，R05 不关闭。安全自检：仅隔离测试及证据更新，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：Formal 自动发现终态缺回执并沿原 TaskRuntime 恢复（2026-09-07）

新增正式 completed 遗留夹具：通过原 Gateway/TaskRuntime 建立冻结 child，模拟终态及 parent settlement intent 已提交、childResult 尚缺失；不提供子模型回答，只准备父通知后的模型响应。原扫描路径 20 秒等待恢复/通知超时。修复 Formal 的终态快捷分支，仅 cancelled 或已有 childResult 才直接走原通知分支；SessionPrompt.recoverTask 对 completed/failed 缺回执继续通过活 lease、后台 job、已 settled 父 Action、Gateway 父授权和原 TaskRuntime 的冻结参数/权限校验，再由既有 ChildExecutor 做精确意图恢复。

修复后 completed child attempts=0、Core/旧 child assistant=0，只有父收到通知后的一个模型请求；结果由持久化意图补齐，原通知机制送达，重复扫描/显式 recoverTask 不增加请求或父上下文，坏通知夹具仍不变。不在扫描器直接调用模型，不另建恢复队列或状态 owner。

新增专项 1 pass / 17 expect / 92 filtered / 0 fail（13.71 秒，包括工具启动；测试自身 10.75 秒），与最终批重叠不累计。最终 Formal 原筛选扩至 15 pass / 252 expect / 78 filtered / 0 fail（117.05 秒），Task 完整 31 pass / 177 expect（11.99 秒）。Arforge typecheck、三文件格式通过；三文件 lint 38 warnings / 0 errors，未清零，各批退出 0。

范围：隔离同进程模拟终态意图前缀，证明正式扫描→父授权→TaskRuntime→Core 恢复→通知，不证明真实 kill/restart。失败终态自动恢复、活 owner/策略改变下的正式拒绝、无意图待处理/重试节流、通知 tail 的缺回执、Evidence 与跨 aggregate 原子性仍须继续，R05 不关闭。安全自检：原 TS 产品链内小范围接线、隔离测试及证据，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作，保留原有工作区改动。

# 最新续验：成功/失败非零用量的精确意图恢复（2026-09-07）

将前批两夹具扩为 live owner × zero/completed/failed 六组。非零组真实写入原 DurableRun attempt 完成事件（attempts=1、durationMs=25、costMicros=7、tokens=11），然后仅提交 parent intent，调用原 executor 恢复。无活 owner 时保留 completed/failed 状态和精确 usage、resultDigest/recordedAt；父预留预算清零，再次恢复父子 snapshot 不变，operation=0且禁止 readUsage。活 owner 时三组均拒绝且父子不变。本轮只补测试，不新增产品分支。failed 的测试 onTerminal 返回摘要用于检查传递，并不改变产品 Task 对失败状态的处理。

ChildExecutor 完整 39 pass / 244 expect / 0 fail（5.67 秒）；修正 receipt 类型后最终六组专项 6 pass / 39 expect（1.63 秒），重叠不累计。Core typecheck、测试格式通过，测试 lint 8 warnings / 0 errors，未清零。Formal 原筛选 14 pass / 235 expect / 78 filtered / 0 fail（109.73 秒），各批退出 0；覆盖上一轮产品修改的正常恢复、通知、续接和取消，不代表新意图恢复已由 Formal 自动触发。

下一接线点：Formal 虽枚举终态，但主要分派已有通知；缺 childResult 时 deliverTaskNotification 仍报错，尚未主动调用精确意图恢复。因此下一步必须通过已有 TaskRuntime/父授权/冻结参数恢复链融入这一路，不能普通 wake 重跑 child。无 intent 的产品待处理状态、Evidence、再次接管、跨 aggregate 原子性及真实重启继续未完成。R05 不关闭。安全自检：隔离测试及证据更新，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：复用原 owner 恢复单个终态结算意图（2026-09-07）

ChildExecutor prepare 对 completed/failed 缺回执先调用原 readChildSettlementIntent 精确验证父子绑定与意图；无意图仍返回 SettlementIncompleteError。有意图时使用 acquireUseRelease 获取原 DurableRun 新租约（reuseExisting=false），把已验证的摘要、状态、artifact/evidence refs、usage 和 admission evidence 交给原 recordChildResult，后者复用已有意图的 resultDigest/recordedAt，完成原父预算结算。释放本次 lease 后返回终态，不读取新 usage、不 beginAttempt、不调用 Provider、不扫描或恢复整个父域。

新增两个受控意图前缀夹具：无活 owner 时成功恢复原摘要、摘要值/记录时间及父预算，重复 execute 不改写父子 snapshot；活 owner 时 LeaseHeldError，父子 snapshot 完全不变。两个夹具修复前均不通过。Core 两文件 50 pass / 289 expect / 0 fail（6.05 秒），类型收窄修正后专项 2 pass / 13 expect（1.59 秒），重叠不累计；Runner 完整 117 pass / 557 expect（60.98 秒）。Core typecheck、两文件格式通过，lint 15 warnings / 0 errors，未清零，各批退出 0。本批未复跑 Formal。

边界：意图由隔离事件 API 构造，不是真实进程崩溃；本批成功恢复夹具用零 attempt/零 usage 合同，不能外推为所有已运行用量或 Evidence 场景验收。失败意图、有用量任务、恢复中再次接管/清理失败、父域坏记录隔离、Formal 自动发现终态缺回执、无意图产品待处理状态及跨 aggregate 写入原子性仍待继续。R05 不关闭。安全自检：原 TS owner 内融合，无新结果/预算状态机，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：缺失回执的终态不得空结果交付（2026-09-07）

两个独立夹具完成 attempt 并转 completed/failed，然后释放 lease，但故意不写结果回执，模拟结算前缀中断。原 prepare 将 childResult?.summary 缺失兜底为空字符串并进入 onTerminal，两回归均得到 Success。原 prepare 现对 completed/failed 缺回执返回类型化 SettlementIncompleteError，说明应先协调结算且没有重放操作；cancelled 保持原无需结果回执的合同。修复后 usage/operation/terminal 三类回调均不执行，父/子 snapshot 原样保留，不伪造摘要、不重跑副作用。

ChildExecutor 完整 33 pass / 205 expect / 0 fail（5.28 秒），Runner 完整 117 pass / 557 expect（60.11 秒）。Core typecheck、两文件格式通过；两文件 lint 15 warnings / 0 errors，未清零，各批退出 0。本批未重跑 Formal，不沿用上一批作当前验收。

实码限制：DurableRun.recoverChildren 可从已持久化 settlement intent 恢复结果，但终态先于 intent 的窗口没有可信摘要可直接重建；本轮只修复空结果误交付，不代表自动恢复完成。下一步须将已有意图的精确恢复与无意图的待处理状态接入产品，并继续处理父 intent/子回执竞争及真实重启；不能调用整个父域扫描掩盖单个任务缺口或自行重放 Provider。R05 未关闭。安全自检：仅原 TS 执行器、隔离测试、证据更新，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：终态后回执入口的失权拒绝（2026-09-07）

隔离层包装原 transition，在 completed 实际提交后释放旧 lease、领取 replacement，再返回原调用。原 execute 继续成功提交回执，回归明确失败。recordChildResult 现接收可选 execution；原处理/重试循环在幂等结果补账、新 intent 和回执分支之前校验无 activeAttempt、attempt 计数、lease ID/owner 与有效期。ChildExecutor 成功和失败的原结果写入都传同一身份，不另建结果或预算 owner。修复后返回 InvalidRunLeaseCapabilityError，replacement child 和父任务的完整 snapshot 均不变，不发布本次结算意图。

Core 三文件 86 pass / 435 expect / 0 fail（7.47 秒）；Runner 完整 117 pass / 557 expect（61.60 秒）；Formal 原筛选 14 pass / 235 expect / 78 filtered / 0 fail（111.69 秒）。Core/Arforge typecheck、三文件格式通过；三文件 lint 36 warnings / 0 errors，未清零，各批退出 0。

关键边界：只证明进入回执处理前已失权的拒绝，不证明校验之后接管时父意图/子回执/父预算的跨 aggregate 原子性。当前 intent 先写父 aggregate，随后子回执用 child sequence；两份状态的竞争仍需在既有事件事务/结算 owner 内解决，不能靠一次额外预检查宣称完成。已成终态但没有结果的接管恢复、失败回执专项、内部中断取消和真实 kill/restart 仍待验证。R05 不关闭。安全自检：原 TS owner、隔离测试和证据更新，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：attempt 提交后状态转移的接管屏障（2026-09-07）

测试层包装原 finishAttempt：实际提交后、返回前释放旧 lease 并领取 replacement，再让原 execute 继续。success/failure 两场景原代码均失败：成功调用仍返回 Success，失败调用仅返回原 operation error，并未识别接管。测试 hook 仅位于隔离层，兜底清除，不增加产品注入入口。

原 DurableRun.transition 增加可选 execution，原 CAS 重试循环校验 SessionRun、最后 attempt 计数与调用身份、lease ID/owner 和有效期；已有 activeAttempt 禁止转移规则保留。ChildExecutor 的 verifying/completed/failed 转移传同一 execution。修复后两场景返回 InvalidRunLeaseCapabilityError，replacement 完整 snapshot 不变。不带 execution 的显式用户控制及 ControlRun 原有 capability 语义保持，没有新状态机。

Core 三文件 85 pass / 430 expect / 0 fail（7.28 秒），修正测试层额外错误类型后专项 2 pass / 8 expect（1.35 秒），重叠不累计。Runner 完整 117 pass / 557 expect / 0 fail（61.78 秒）；Core typecheck、三文件格式通过；三文件 lint 36 warnings / 0 errors，未清零。本批未重跑 Formal，不复用上一批产品结果作为本批验收。

边界：仅覆盖 attempt 提交后、下一状态写入前的受控接管；verifying→completed 之间的独立故障夹具、终态后 recordChildResult/父预算、内部中断取消、准备阶段转移、CAS 强制交错及真实重启仍需验证或完善。租约时间检查位于原写入流程，不冒称数据库提交时刻的原子到期判断；R05 继续未完成。安全自检：TS owner/隔离测试/证据增量，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续验：恢复补账失权与正式入口回归（2026-09-07）

新增独立恢复夹具：先 prepare 建立 attempt 1，释放旧 lease 模拟遗留任务；第二次 prepare 在恢复用量读取中替换本次 lease，再返回高于原基线的用量。原身份绑定 finishAttempt 拒绝，错误为 InvalidRunLeaseCapabilityError，reads=1，完整 replacement snapshot 不变，activeAttempt 仍为 1，已结算 costMicros/tokens 均为 0。已有 prepare 清理不会释放 replacement lease。本轮仅补测试，无新增产品路径。

ChildExecutor 完整 28 pass / 182 expect / 0 fail（5.02 秒），Core typecheck、测试格式通过；测试文件 lint 8 warnings / 0 errors，未清零。Formal 同前批筛选 14 pass / 235 expect / 78 filtered / 0 fail（108.75 秒），验证正常恢复、续接、通知和父/子取消未被上一轮 attempt 身份屏障误拦截，各批退出 0。不同批次不累加为完成率。

边界：受控同进程 API 接管，不是强制 CAS 冲突、跨进程 kill/restart 或真实远端计费验证。下一步继续检查 finishAttempt 后的 transition / recordChildResult / 父预算多步结算窗口；R05 不关闭。安全自检：隔离测试与证据更新，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：用量读取期间接管的 attempt 结算屏障（2026-09-07）

新增真实 DurableRun 交错夹具：operation 返回后进入结算 readUsage，释放原 lease、领取 replacement lease，再返回用量。原 execute 返回 Success，回归明确失败；说明入口 validateExecution 不足以保护随后发生的写入。

原 finishAttempt 增加可选 execution 身份（复用现有 attempt/leaseID/ownerID 合同），finishAttemptInternal 在每次事件序号 CAS 重试中检查 SessionRun、attempt 绑定、lease ID/owner 及有效期，不匹配返回 InvalidRunLeaseCapabilityError。ChildExecutor 的正常结算和恢复旧 attempt 补账均传入当前所持 lease 身份；不带 execution 的现有控制/显式取消调用语义未改。没有另建锁、队列或状态 owner。修复后 operation 已执行一次，但旧结算失败，replacement 完整 snapshot 原样保留。

Core 三文件（ChildExecutor、durable-child-run、durable-run）82 pass / 414 expect / 0 fail（7.14 秒）；修正测试类型后专项复测 1 pass / 4 expect（1.34 秒），重叠不累计。Runner 完整 117 pass / 557 expect / 0 fail（62.25 秒）。最终 Core typecheck、三文件格式通过；三文件 lint 37 warnings / 0 errors，未清零。本批未跑新的 Formal 筛选，下方上一批产品数字不用于本批验收。

限制：未强制注入 CAS 冲突或数据库提交临界到期，未验证恢复补账读取期间接管的独立故障夹具；finishAttempt 之后的状态转移/结果回执/父预算仍为后续多步操作，不称整个结算已原子化。真实跨进程恢复、未知提交结果、远端副作用和剩余入口融合继续未完成，R05 不关闭。安全自检：只改原 TS owner/隔离测试/证据，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：领取前验证 child 类型及会话身份（2026-09-07）

正式产品入口最终复测：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`，在 packages/arforge 执行，14 pass / 235 expect / 78 filtered / 0 fail，109.20 秒，退出 0。覆盖 denied agent、普通 task/followup、四初态 scanner 恢复、运行中 followup 完成/取消、空闲/忙碌/失败后台通知、父/子取消和 integrated drain；不等于全产品或跨进程重启验收。下方“尚未重跑”是上一轮记录，本段补齐该批新鲜证据。

下一处实码风险：settle 在 validateExecution 后才读 readUsage，随后 finishAttempt 未传入 lease 身份；DurableRun.finishAttemptInternal 的 SessionRun 分支只核对 running/attempt 和事件序号，不能从调用者身份识别“读取期间已接管”的旧调用。需增加受控交错测试复现，再在原 DurableRun 写入/CAS 重试边界融合身份校验；仅在上层追加一次预检查不能声称解决竞争。此处尚未修复，不算完成。

实码发现 loadChild 仅作类型断言，prepare 未使用传入 sessionID 验证不可变绑定；直接执行无 Provider 路径也可绕过该检查。六个回归覆盖 prepare/execute × root run、其他 sessionID、已取消 child 的其他 sessionID。修复前六项均失败：错误会话可成功准备/执行或读取终态；root 在准备过程中才因访问不存在的 child.deadlineAt 抛 TypeError。

原 loadChild 现验证 SessionRun child 结构，两个入口首次读取传入 sessionID，检查发生在状态转移、租约获取、usage 读取及终态回调之前。失败返回原 InvalidInputError；后续内部读取沿用同一辅助函数，不新增状态 owner 或权限实现。修复后六场景 reads/operations/terminal callbacks 均为 0，目标完整 snapshot 不变。身份校验不是父授权替代，原 Gateway/permission 检查保留。

ChildExecutor + Durable child 两文件 41 pass / 241 expect / 0 fail（5.42 秒）；修正测试联合类型后最终 ChildExecutor 单文件 26 pass / 170 expect（4.98 秒），重叠不累计。Runner 完整 117 pass / 557 expect / 0 fail（62.75 秒）。最终 Core typecheck、两文件格式通过，两文件 lint 15 warnings / 0 errors，未清零。本批尚未重跑 Formal 产品筛选，不以旧批次作为本批验收。

边界：仅关闭该输入身份漏洞；租约提交临界竞争、结算未知结果、真实跨进程恢复及剩余产品入口融合仍未验收，R05 不关闭。安全自检：仅 TS 执行器、隔离测试和证据更新，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续验：seed 中断后的恢复、显式取消与预算释放（2026-09-07）

将前批 checkpoint 已提交但返回被阻塞的夹具扩为 resume/cancel 两条路径。中断并确认原 checkpoint 保留、lease 清理后，撤去测试 hook；恢复复用原 execute，结束旧 attempt 后以第二 attempt 执行一次并写入 completed 结果。显式取消调用原 parent-scoped cancelChild，保持 attemptsUsed=1、operation=0、cancelled 终态。两路径无 activeAttempt/lease，costMicrosUsed/tokensUsed=0，父任务四项 childBudgetReserved 全部归零；终态再次 execute 的操作计数和完整 child snapshot 均不变。

新增检查曾错误要求 cancelChild 生成 cancelled childResult，实际测试失败。源码确认 cancelOne 的现有合同为结束 attempt、转 cancelled 并 settleChildBudget，取消并不生成结果回执；已修正测试为检查取消状态且不伪造结果，不为满足错误断言修改产品。本批仅扩充测试，没有新增产品路径或独立状态 owner。

最终两文件回归：`bun test test/runtime/subagent-child-executor.test.ts test/durable-child-run.test.ts --rerun-every`，35 pass / 205 expect / 0 fail（5.21 秒），退出 0。Core typecheck、测试文件格式检查通过；该测试文件 oxlint 8 warnings / 0 errors，未清零。前一单文件批 20 pass / 134 expect（4.69 秒）与合并批重叠，不累计。本批没有重跑 Runner/Formal，前批结果仅作历史证据。

范围：同进程、隔离数据库、受控 checkpoint 返回中断后调用真实恢复/取消 API；没有证明真实用户 CLI/桌面取消旅程、跨进程 kill/restart、未知提交结果、结算故障或远端用量准确性。R05 继续未完成，下一步仍须处理这些恢复/结算边界与剩余正式入口融合。安全自检：无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作，保留其余工作区改动。

# 最新续修：Provider seed 已提交、尚未返回时的取消（2026-09-07）

新增隔离测试层包装原 DurableRun.checkpoint，仅在目标 child 的 execution-bound checkpoint 实际提交完成后，用 Deferred 阻塞返回；其余方法及写入仍使用原 DurableRun。确认 seed 已持久化再中断 execute，原代码因初始化位于不可中断区而在 1 秒等待结束时失败。测试兜底释放 gate、等待 fiber 退出，并清除测试 hook，不遗留后台操作。

seed checkpoint 调用现使用 execute 的 restore，已有初始化 onExit 清理已在之前注册。修复后中断完成、operation=0、lease 清空、已提交 checkpoint 与 ID/摘要完全保留，activeAttempt 仍为 1 待后续恢复，不伪造任务完成。只改原初始化调用的中断边界，没有新增产品注入接口或状态 owner。

ChildExecutor 完整 19 pass / 107 expect / 0 fail（4.50 秒）；测试层类型修正后专项再跑 1 pass / 5 expect / 0 fail（1.20 秒），重叠不累计。Runner 完整 117 pass / 557 expect / 0 fail（62.37 秒）。Core typecheck、两文件格式通过，oxlint 15 warnings / 0 errors，未清零；Formal 同前批筛选最终 14 pass / 235 expect / 78 filtered / 0 fail（110.87 秒），各批退出 0。

边界：只证明真实 checkpoint 提交后、返回前的受控中断；不证明数据库事务中途取消、未知提交结果、跨进程 kill/restart。未结算 attempt 的完整恢复、用户取消的持久化终态、清理失败及远端用量仍未验收，R05 不关闭。安全自检：仅 TS owner/隔离测试/证据增量，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：Provider checkpoint 初始化失败的租约清理（2026-09-07）

夹具在前置 checkpoint 校验之后、readUsage 期间写入损坏的 nested sessionLoop，使 prepare 成功创建 attempt 1，再在 Provider seed checkpoint 合并时拒绝。旧代码保留 30 秒活租约，回归在 lease 应为空的断言失败。修复在原 execute 中，prepare 返回后立即注册身份绑定的初始化失败清理；以本次 lease ID/owner 调用原 releaseLease，忽略明确 LeaseMismatchError，不释放其他 owner 的租约。

初稿将清理覆盖整个执行阶段，导致自然到期测试原 snapshot 被额外 release 改写；已限定为 handedOff 之前的初始化阶段。handedOff 仅为本次调用的清理范围标记，不是新的 durable owner/队列；交给原 Provider operation 后仍由原 settle 负责。最终初始化故障保持 operation=0、lease 清空、activeAttempt=1、run running、损坏 checkpoint 原样保留，不伪造成功，也不自动覆盖坏数据。

ChildExecutor 完整 18 pass / 102 expect / 0 fail（4.43 秒）；Core Runner 完整 117 pass / 557 expect / 0 fail（64.05 秒）。Core typecheck、两文件格式通过，oxlint 15 warnings / 0 errors，未清零。Formal 同前批筛选最终 14 pass / 235 expect / 78 filtered / 0 fail（111.52 秒），各批退出 0。

边界：仅验证 Provider seed 初始化中遇到晚到损坏的失败清理，不表示损坏记录已自动修复或未结算 attempt 已完成处置。初始化中取消、持久化结果不确定、已交接后的结算故障、清理失败、真实跨进程恢复与远端用量仍未验收。R05 不关闭。安全自检：原 TS owner 内修改和隔离故障注入，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：准备阶段外部读取的可中断边界（2026-09-07）

新增两个 ChildExecutor 实际 execute 夹具，分别用 Deferred 阻塞 readUsage 和 readPermissionDigest；确认已进入读取后请求 Fiber.interrupt。原实现的外层 uninterruptibleMask 吞掉读取期间的取消，两个场景分别在 1 秒等待中止的断言失败。fixture 的兜底 finalizer 会释放读取 gate，再等待旧 fiber 退出，避免失败测试遗留永不结束的操作。

修复仅用 execute 外层 restore 包裹这两个外部读取：传给 prepare 的 readUsage 恢复可中断性，使中断进入已有身份绑定清理；权限读取发生在拿 lease 之前，同样恢复可中断性。没有把整个 prepare 放开中断，以保留成功准备到调用方持有执行身份的交接保护。测试确认中止成功、operation=0、无 lease/activeAttempt、attemptsUsed=0。

ChildExecutor 完整 17 pass / 95 expect / 0 fail（4.48 秒）；Core Runner 完整 117 pass / 557 expect / 0 fail（63.22 秒）。Core typecheck、两文件格式通过，oxlint 15 warnings / 0 errors，未清零。Formal 同前批筛选最终 14 pass / 235 expect / 78 filtered / 0 fail（111.12 秒），各批退出 0。

范围：验证的是 executor fiber 中断能结束准备读取和清理资源，不是“用户取消”持久化协议全部验收。未开始 attempt 的 run 没有在此新增 cancelled 转移；父/子显式取消仍依赖原 durable 控制路径。Provider seed 初始化失败、准备完成后的取消、数据库永久等待、清理失败、真实进程崩溃与远端计费继续未验收。R05 不关闭。安全自检：原 TS owner 小范围修改和隔离 fixture，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作。

# 最新续修：prepare 失败的身份绑定租约清理（2026-09-07）

故障注入 readUsage 的普通 failure 与 defect，原 prepare 在取得 lease 后失败，留下 30 秒活租约，两个回归均在 lease 应为空的断言失败。修复在原 prepare 内将获取租约与清理注册置于 uninterruptibleMask，后续准备操作通过 restore 执行；失败时使用本次取得的 lease ID + ownerID 调用原 releaseLease。成功保留租约交给原执行链。只忽略明确 LeaseMismatchError（已释放或被替换）；其他清理错误不静默丢弃，不伪造 attempt 成功/终态。

修复后两个故障均保留原始错误，lease 清理、attemptsUsed=0、无 activeAttempt，立即重试可开始 attempt 1。第三场景在 readUsage 内替换租约后失败：旧清理不释放 replacement，完整 snapshot 保持，原错误保留。测试在预期失败边界之外断言。直接 prepare 的取消、execute 外层不可中断准备与 Provider seed 失败等仍需独立验证。

ChildExecutor 完整 15 pass / 85 expect / 0 fail（4.41 秒）；补测试类型收窄后三个 preparation 专项复测 3 pass / 18 expect / 0 fail（1.42 秒），与完整批重叠不累计。Runner 完整 117 pass / 557 expect / 0 fail（63.11 秒）。Core typecheck、两文件格式通过，oxlint 15 warnings / 0 errors，未清零；Formal 同前批筛选最终 14 pass / 235 expect / 78 filtered / 0 fail（110.53 秒），各批均退出 0。

范围不含 acquire 发布成功但返回失败的不确定结果、beginAttempt 后故障的完整补账、Provider 初始化失败、清理阶段数据库不可用、跨进程 kill/restart。R05 不关闭。安全自检：仅原 TS owner/测试/证据增量和隔离 fixture，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作，保留其余工作区改动。

# 最新续修：显式 owner 的新租约要求（2026-09-07）

同进程重复 prepare 夹具增加显式相同 ownerID，原代码仍返回 Success，复现了默认 UUID 未覆盖的重用窗口。DurableRun.acquireLease 新增可选 reuseExisting；原调用者默认幂等语义保持，ChildExecutor 固定传 false，要求获得新租约。活 lease 即使 owner 字符串相同，也返回原 LeaseHeldError；检查在原 load/CAS 重试循环内，竞争失败后重读也执行，未引入进程锁或另一份状态。expired lease 的重新认领仍沿原逻辑。

新增验证：同 owner 普通 acquire 仍返回原 snapshot；require-new 拒绝且 snapshot 不变；两次并发 require-new 只有一次成功、另一项 LeaseHeldError、generation=0。ChildExecutor 默认/显式重复调用均拒绝；到期恢复与差额结算保留。并发测试使用原数据库/API 并发执行，没有强制插入指定 CAS 交错，不冒称跨进程故障原子性已验收。

Core durable-run + child-executor 完整两文件 52 pass / 236 expect / 0 fail（6.73 秒）；Runner 完整文件 117 pass / 557 expect / 0 fail（65.25 秒）。Core typecheck、四文件格式通过，oxlint 42 warnings / 0 errors，未清零。正式产品入口同前批筛选最终 14 pass / 235 expect / 78 filtered / 0 fail（108.97 秒），各批均退出 0。R05 不关闭：prepare 中途失败清理、持久化临界失权、读取故障、远端迟到用量与真实跨进程恢复仍未验收。

安全自检：原 TS owner 内增量修改及隔离 fixture，无真实用户数据、外部 Provider、全局 CLI/PATH 或全平台 sandbox 操作，保留其余工作区改动。

# 最新续修：同进程默认 owner 隔离与到期后用量恢复（2026-09-07）

实码发现默认 owner 由 process.pid + runID 组成，而 DurableRun.acquireLease 对相同 owner 幂等返回现有 lease；同进程第二次 prepare 因此会把仍在运行的 activeAttempt 当成遗留任务，结算为 interrupted 并开启下一 attempt。新增测试先保留活 lease，再调用第二次 prepare；旧代码返回 Success，预期 Failure 的断言失败。

默认 owner 现加入每次调用的 randomUUID，复用原 DurableRun 的 LeaseHeldError 拒绝重复认领。第二次调用不改变原完整 snapshot，不另建状态锁；已失效 lease 的恢复仍可用。显式 ownerID 覆盖接口保持原合同，本批没有证明调用者故意复用同一显式 owner 的安全性，仍需继续收敛该边界。

自然到期夹具增加真实原 ChildExecutor/Provider 的第二 attempt：原累计用量基线为 7 costMicros / 11 tokens，恢复时观察到 17 / 31，第二次 operation 后为 22 / 38；最终合计 15 / 27，attemptsUsed=2，run completed，activeAttempt/lease 清理。terminal 再调用返回原结果，operation 只运行一次，完整 snapshot 不变。该验证只证明本地已观测累计用量的基线差额，不证明远端未上报用量或跨进程崩溃补账。

最终 ChildExecutor 完整文件 11 pass / 63 expect / 0 fail（4.93 秒）；Core Runner 完整文件 117 pass / 557 expect / 0 fail（82.34 秒）；Core typecheck、两文件格式通过，oxlint 14 warnings / 0 errors，未清零。产品 Formal 同前批筛选回归 14 pass / 235 expect / 78 filtered / 0 fail（131.55 秒），均退出 0。恢复拒绝只针对默认调用者身份，不把此切片等同完整并发安全或整个 R05 完成。

剩余：显式 owner 重用、准备中途失败/lease 清理、读用量与结算之间的竞争、远端中止/迟到用量、失效父 Action、真实跨进程恢复等仍未验收。安全自检：仅源码/测试/证据增量，隔离 fixture，无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作，保留其余工作区改动。

# 最新续验：静默 child 的自然租约到期（2026-09-07）

原 ChildExecutor 静默夹具扩展 replaced/expired 两种失权来源。expired 使用 500ms lease、60 秒任务预算，通过 Deferred 确认原 Provider 操作已启动；不 release/acquire、不换 owner、不续租。退出必须为 LeaseMismatchError 而非 3 秒外层 TimeoutError，操作 finalizer 执行，原完整 durable snapshot 不变；另核对原 lease ID 仍相同且当前时间已达到 expiresAt。自然到期分支约 1.1 秒完成。

反向验证临时只撤去 ownership race，expired 分支明确失败，原因是仅靠外层 3 秒 timeout 中止。恢复源码后完整 `bun test test/runtime/subagent-child-executor.test.ts --rerun-every` 为 10 pass / 51 expect / 0 fail，4.77 秒，退出 0。Core typecheck、测试及 ChildExecutor 格式通过，测试文件 oxlint 7 warnings / 0 errors，未清零。本批最终仅改测试及证据，不新增产品路径；未重跑 Runner/Formal，不引用旧批作为新测试。

这证明租约自然到期后会在运行中复核时停下，不证明到期同一毫秒立即停止，也不证明提交临界到期的原子性。每秒复核仍有检测延迟、读取成本和失败语义待验证；失权后原 attempt 保留，后续重新认领、用量结算与真实副作用协调仍须继续，R05 不关闭。安全自检：隔离本地 fixture，无真实用户数据/外部 Provider/全局 CLI/PATH/全平台 sandbox 操作；反向源码已恢复，保留其余工作区改动。

# 最新续验：Core Runner 部分输出后的静默流失权（2026-09-07）

本批将原 child Runner 参数化夹具增加 replaced-during-silent-stream：通过受控 LLMClient 流先发 stepStart/textStart/textDelta，之后替换 durable lease 并保存 replacement checkpoint，再保持 Stream.never。原 ChildExecutor 的运行中校验必须主动中止 Runner；外层验证 LeaseMismatchError、流 finalizer 已执行、请求只有一次、部分文本仍保留且 assistant.finish=error、replacement checkpoint 与 lease 保持。此场景由外层 executor 竞速中断，不能要求内层 staleResult 赋值一定执行；关键断言在外层，不被预期失败吞掉。

反向验证临时只撤去 providerOperation 的 ownership race；结果是 4 秒外层 TimeoutError，明确失败，不是失权中止。已恢复产品源码后复测：专项 1 pass / 17 expect；最终 `bun test test/session-runner.test.ts --rerun-every` 为 117 pass / 557 expect / 0 fail，79.16 秒，退出 0。Core typecheck、测试及 ChildExecutor 格式通过；测试文件 oxlint 40 warnings / 0 errors，未清零。本批最终只新增测试及证据，产品源码与上一批一致，未将上一批 Formal 测试当作本批新结果。

范围：实际 Core Runner + 原 ChildExecutor + 受控模型事件流；没有真实 HTTP 服务或远端模型调用，不能证明远端 abort、停止计费或已执行副作用撤回。精确租约到期、读取失败、复核负载、用量/副作用协调、root 与真实跨进程恢复仍未验收，R05 不关闭。安全自检：无真实用户数据、外部 Provider、CLI/PATH 或全平台 sandbox 操作；反向验证源码已恢复，保留其余工作区改动。

# 最新续修：静默 Provider 操作的运行中失权中止（2026-09-07）

实码确认 root Runner 有 heartbeat race，而 ChildExecutor 只在开始及结算校验 durable 身份；静默操作失去 lease 后不会主动退出。新夹具通过原 in-process Provider 执行 Effect.never，以 Deferred 确认操作已经开始，再替换 lease 并保存 replacement checkpoint。初稿 child 预算超过父预算，被正常拒绝；调整父子夹具均为 60 秒后，原代码直到外层 3 秒 timeout 才退出，预期 LeaseMismatchError 的断言失败，构成有效故障复现。

修复融合在原 ChildExecutor：providerOperation 与每秒调用原 validateExecution 的只读复核 Effect 做 raceFirst，保持既有总任务 timeout。失权分支失败会中断原操作，并等待其 finalizer；不续租、不重新 acquire、不建立第二套运行状态。结算仍先校验原身份，不能借用新 lease 结算旧操作。正常结束会取消复核分支。

新夹具约 1.2 秒结束，收到 LeaseMismatchError，operation finalizer 已执行，replacement 完整 DurableRun snapshot 不变。ChildExecutor 完整文件 9 pass / 45 expect / 0 fail（3.31 秒）；Core Runner 完整文件 116 pass / 540 expect / 0 fail（77.51 秒）。Core typecheck、两文件格式通过，oxlint 14 warnings / 0 errors，未清零。正式产品入口同前批筛选回归 14 pass / 235 expect / 78 filtered / 0 fail（128.09 秒），包括四初态恢复、followup、后台通知与父/子取消；均退出 0。

边界：这是单进程、原 Provider 包装下的受控静默操作，不是真实远端 HTTP abort、网络计费终止或强制杀死非协作操作的证明。每秒检查有检测窗口和数据库读取成本；精确租约到期、数据库故障、多任务负载、真实模型流与本地工具副作用、未结算 usage 协调、root 身份及跨进程恢复仍待验证。R05 不关闭。安全自检：仅源码/测试/证据增量及隔离夹具，没有真实用户数据、外部 Provider、全局 CLI/PATH 或全平台 sandbox 操作。

# 最新续验：fallback 与 transport retry 的失权边界（2026-09-07）

本批扩展原 child Runner 夹具，不新增产品路径。replaced-on-fallback 在第一模型流中替换 lease 后返回可切换的 transport failure，明确关闭同模型重试；审计必须证明已决定 fallback，实际请求仍只有 fake-model，不得调用 replacement。replaced-on-retry 允许一次 transport retry，要求审计出现 llm.retry，但实际 fake-model 请求仍只有一次。两者均在 executor 之外验证旧 Runner 失败包含 LeaseMismatchError、replacement checkpoint 完全不变、lease 归新 owner、只有一条 child run。

两个反向验证分别临时去掉 fallback 递归的 checkpointExecution 和 Gateway 重试 execute 内的 validateExecution；前者失败并观察到额外 replacement 请求，后者失败并观察到第二个 fake-model 请求。每次立即恢复原源码，再运行完整文件；不是仅凭旧 executor 最终失败判断防护有效。最终产品源码与上一批一致，仅测试和证据增量。

最终 `bun test test/session-runner.test.ts --rerun-every`：116 pass / 540 expect / 0 fail，75.56 秒，退出 0；包含正常重试和正常 fallback。专项三项 3 pass / 41 expect 与完整批重叠，不累计。Core typecheck、测试及 llm.ts 格式通过；测试文件 oxlint 40 warnings / 0 errors，未清零。本批未重跑产品 Formal 入口，不将上一批 14 项冒充本批新结果。

剩余：请求开始后才失去执行权的流中止/副作用与用量协调、root 身份绑定、提交临界到期、真实跨进程重启及失效父 Action 等仍未验收，R05 不关闭。审计中的 retry/fallback 表示决策，不表示 Provider 已实际调用；本批用 LLM 请求记录区分。安全自检：仅隔离本地夹具，无真实用户数据、外部 Provider、全局 CLI/PATH 或全平台 sandbox 操作；反向验证已恢复，不重置工作区。

# 最新续修：失去执行权后不得启动 overflow 恢复（2026-09-07）

新增 child 场景在模型流中替换 lease，随后返回 context-overflow。初稿只有一个短输入，未具备压缩前提，得到一请求并不能证明没有恢复风险；改用原 setupOverflowRecovery 构建可压缩历史后，旧代码实际发出三次请求（原调用、压缩、续跑），期望一请求的断言失败。fixture 中预先完成的 root run 与待测 child 分开计数，不把历史 root 当作额外 child。

修复在 runTurnAttempt 入口、每次实际 Provider stream 和 overflow 压缩开始前，复用原 SubagentChildExecutor.validateExecution 校验 child run/session/attempt/lease。Effect 每次执行重新读取，不缓存有效身份。失效 lease 在恢复动作前失败，未创建 compaction 消息，replacement checkpoint 和 lease 保持原样。另修复 fallback 递归调用遗漏 scheduledTaskRuntime 与 checkpointExecution 参数，保持同一工具路由和执行身份。

专项 `bun test test/session-runner.test.ts --test-name-pattern 'existing child attempt|overflow|fallback' --rerun-every` 为 11 pass / 106 expect / 103 filtered / 0 fail，8.12 秒；该筛选未匹配标题“falls back”，故不将它算作 fallback 专项。Core typecheck 最终通过（测试筛 child 时补上 control/session 类型收窄），两文件格式通过，oxlint 58 warnings / 0 errors 未清零。

最终收尾复测：Core `bun test test/session-runner.test.ts --rerun-every` 为 114 pass / 506 expect / 0 fail，72.74 秒，包含普通模型 fallback 回归；此前完整批最终输出未保留，故重新运行后才记录，不累计两批。Arforge 正式入口筛选（Formal scanner resumes、Formal model task、Formal background completion、Formal scheduled cancellation、integrated Formal drain）为 14 pass / 235 expect / 78 filtered / 0 fail，123.33 秒。两者均退出 0，仍为本地隔离夹具，不是真实外部 Provider 或跨进程恢复验收。

边界：本批证明的是进入恢复前已经失去 lease；压缩/模型请求开始后才失去执行权的取消、提交临界到期、fallback 身份变更专项、root 身份绑定、真实跨进程重启等仍未验收。checkpoint 拒绝不能代替已经发出请求的成本和副作用协调。R05 保持未完成。

安全自检：仅 llm.ts、session-runner.test.ts 与证据增量，隔离本地 fixture；无真实用户数据、外部 Provider、全局 CLI/PATH 或全平台 sandbox 操作。回退仅本批增量，不重置工作区。

# 最新续验：待结算工具 continuation 的抢占边界（2026-09-07）

本批仅补测试，不新增产品分支。现有 child Runner 夹具新增 replaced-before-tool-settlement：模型输出 echo toolCall，观察原 Session 投影中该调用 running 后，更换 durable lease，由 replacement owner 保存 checkpoint，再结束模型流。旧 child 必须因 InvalidRunLeaseCapabilityError 停止，replacement checkpoint（含 ID/序号/摘要）不变，lease 仍归新 owner，不发第二个模型请求，退出后 activeToolExecutions=0。

就绪边界取“工具调用已入 running、尚未结算”，不冒称工具 execute 函数已经开始。初稿等待 executor 的 Deferred 停住，手动中止该隔离测试进程；改为 live fixture + 两秒有界持久化状态检查后正常执行。没有绕过权限。首次 attempt count/owner 等旧断言继续保留在外层，避免被 executor 的预期失败掩盖。

反向验证临时只移除 runTurn 的 continuation checkpoint execution 字段（普通 runLoop 的校验仍保留）：测试明确失败，replacement checkpoint eventSequence 从 10 被旧 worker 写成 11，新增 sessionLoop nextStep=2，ID/摘要改变。随后恢复原源码，正式测试通过。这证明命中了待工具 continuation 写入点，而不只是后续普通 checkpoint 拒绝。使用真实原 DurableRun/Runner，仍是单进程受控交错，不是真实进程抢占验收。

Core `bun test test/session-runner.test.ts --rerun-every`：113 pass / 489 expect / 0 fail，68.80 秒，退出 0。Core typecheck、测试与原 llm.ts 格式检查通过；测试文件 oxlint 40 warnings / 0 errors，未清零。本批最终产品源码与上一批相同，未重复报告旧产品测试为本批新跑。

剩余：overflow/内部转步中失去 lease 的独立回归、root 身份绑定、同字段竞争、CAS 提交临界到期、真实重启、失效父 Action 等继续未完成，R05 不关闭。安全自检：仅隔离本地 fixture、测试和证据增量；没有真实用户数据、外部 Provider、全局 CLI/PATH 或全平台 sandbox 操作。回退只撤销本批 session-runner.test.ts 和证据增量，不重置工作区。

# 最新续修：child Loop checkpoint 执行身份贯穿（2026-09-07）

原 childAttempt.execution 现传到 runTurn/runTurnAttempt、内部转步及 overflow 后续跑，再进入“等待本地工具前保存 continuation”的 checkpoint；runLoop 正常结束保存也使用同一身份。没有重新读取新 owner 的 lease 冒充原执行者，不新增 Runner。普通 root 路径仍没有新增 execution 参数，本批范围是 child Loop。

回归复用正式 Core child 夹具，覆盖原 owner 正常完成、模型流开始后换 lease 并正常完成、换 lease 后流 defect 三种情形。替换 owner 保存独立 checkpoint，测试在外层确认旧 runner 失败、checkpoint 未变、replacement lease 保留。正常结束场景必须包含 DurableRun.InvalidRunLeaseCapabilityError；流 defect 是不覆盖的对照，不证明等待工具前保存 continuation 的分支已覆盖。

测试纠偏记录：参数化后先修共享 requests 计数；随后发现内层断言异常会被外层“预期失败”掩盖。将结果与 checkpoint 带到最外层断言后，再临时移除正常 checkpoint 的 execution 参数作反向验证，实际得到旧 runner Success（预期 Failure），测试失败；立即恢复校验。早期被掩盖的通过不作为证据。流 defect 不包含 checkpoint 身份错误，因此不强行声称该分支命中新校验。

Core `bun test test/session-runner.test.ts --rerun-every`：112 pass / 470 expect / 0 fail，71.86 秒；Arforge `bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`：14 pass / 235 expect / 78 filtered / 0 fail，123.29 秒。Core typecheck、两文件格式通过，oxlint 57 warnings / 0 errors 未清零。composition 仍 1751 sources / 3 roots / 5 bindings / 4 Runner uses，依赖台账已重新生成。

未完成：等待本地工具的 continuation、overflow/内部转步中抢占的独立负面回归，root checkpoint 身份绑定、CAS 提交竞争/临界到期、同字段进度竞争、真实进程重启及失效父 Action 等。参数传递已落地不等于每个故障路径已验收，R05 不关闭。

安全自检：仅两个 TS 文件、隔离夹具和证据增量；未操作真实用户数据、外部 Provider、全局 CLI/PATH 或三平台 sandbox。回退仅本节增量，不重置工作区。

# 最新续修：checkpoint 执行身份 fencing（2026-09-07）

原 checkpoint 接口只有 control lease capability 保护，没有 session 执行者的 attempt/lease 参数。本批增加可选 execution（leaseID、ownerID、attempt），每次 CAS 重试读取最新聚合后检查 running、activeAttempt、lease 身份及检查时刻未到期，在 updater 执行前拒绝不匹配。继续使用原事件序号 CAS；若 lease/attempt 事件抢先追加，旧写入发生序号冲突并重新校验。不创建新锁或签发授权凭据；此绑定是内部执行身份约束，不是对外授权接口。

Provider seed/progress/settlement 三处和正式 child admission 已传入原 ChildExecution。通知与初始化没有 active attempt，仍使用原不带 execution 的路径；不强行为其捏造租约。Loop 尚未携带 execution 参数，下一步须贯穿正常、中断与内部重试/overflow 路径，不能说所有 session checkpoint 都已 fencing。

新增 Core 回归验证：有效身份写入成功；错误 attempt、错误 owner、恰好到期的 lease 均 Failure、updater 计数为 0、durable snapshot 不变；lease 替换后旧身份拒绝，replacement owner 成功。接口新增前红测实际得到 Success（新增参数被忽略）；测试初稿又误把 acquireLease 的 Snapshot 当 Lease，修正为 snapshot.lease 后完整重跑通过，不把夹具错误算产品缺陷。

本批验证：Core 两文件（durable-run + child executor）47 pass / 200 expect / 0 fail，4.22 秒；追加替换 lease 断言后 durable-run 完整文件 39 pass / 162 expect / 0 fail，3.47 秒，重叠不累计。Core/Arforge typecheck 最终通过，四文件格式通过，oxlint 45 warnings / 0 errors 未清零。产品正式批次结果另记。

产品正式命令（packages/arforge）：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`：14 pass / 235 expect / 78 filtered / 0 fail，125.11 秒，退出 0。

仍未验收：Loop 全路径接线、并发 CAS 冲突中 lease 恰好被替换的受控注入、检查与提交间跨过到期时刻的边界、同字段进度竞争、真实进程抢占/重启、失效父 Action 协调。R05 不关闭。composition 仍 1751 sources / 3 roots / 5 bindings / 4 Runner uses。

安全自检：仅隔离测试、本地 HTTP fixture、源码和证据增量；未操作真实用户数据库/凭据/全局 CLI 或外部 Provider，三平台 full sandbox 仍后置。回退仅本批 durable-run.ts、durable-run.test.ts、subagent-child-executor.ts、prompt.ts 和文档增量，不重置脏工作区。

# 最新续修：共享 checkpoint 写入方迁移（2026-09-07）

本批把 Provider 初始化、进度、结算，Core Loop 正常/中断两处 intoContainer，正式 child admission，以及 Task 首次冻结记录接入原 checkpoint 最新状态 updater。Provider 初始化保留最新容器的其他字段并再次校验最新 sessionLoop；progress/settlement 在回调内重新执行原 advanceContinuationCheckpointState 校验。admission 在回调内检查已存在的输入摘要一致；首次冻结发现已有不同 intent/digest 时拒绝，不覆盖已有记录。没有另建 checkpoint store 或扩大 Runner 白名单。

受控交错回归复用现有 child 恢复夹具：在恢复检查点校验后、prepare 的 readUsage 阶段向同一 durable checkpoint 写入新通知和 concurrentMarker；旧 Provider seed 随后覆盖该状态，使 operation 内断言失败、execute 返回 Failure。修复后 operation 看到新通知、marker、原 sessionLoop 和新 epoch。foreign sessionLoop 仍在 prepare 前拒绝。首次全文件测试检出无旧 checkpoint 的初始化分支缺 undefined 判断，补齐后重跑通过。此测试验证这一明确交错窗口，不是实际多进程竞争。

本批验证：

- Core：`bun test test/runtime/subagent-child-executor.test.ts test/session-runner.test.ts --rerun-every`，118 pass / 481 expect / 0 fail，76.39 秒。
- Arforge：正式 14 场景 + Task 31 项合并批次在最后首次冻结写法调整前启动，为 45 pass / 412 expect / 78 filtered / 0 fail，140.43 秒。最后改动后单独重跑 `bun test test/tool/task.test.ts test/session/prompt.test.ts --test-name-pattern 'tool.task|orphaned draft child' --rerun-every`：32 pass / 202 expect / 91 filtered / 0 fail，32.44 秒；重叠不累计。
- Core/Arforge typecheck 最终通过，五文件格式通过，oxlint 63 warnings / 0 errors，未清零。composition 保持 1751 sources / 3 roots / 5 bindings / 4 Runner uses，依赖台账重新生成。

剩余：同字段竞争/过期 epoch 和 lease 的原子 fencing，Provider progress/settlement 与 Loop/admission 两方向受控竞争的独立故障回归，首次冻结并发身份冲突的正式旅程，以及真实进程退出重启、失效父 Action 等仍须继续。字段不互相抹除不等于所有执行权/原子性条件成立，R05 不关闭。

安全自检：源码、隔离测试与证据增量；未触碰真实用户数据库、外部 Provider、凭据或全局 CLI/PATH。三平台 full sandbox 仍后置。回退仅按本节五文件及文档增量，不重置脏工作区。

# 最新续修：checkpoint 最新状态更新与通知接入（2026-09-07）

实码确认：DurableRun 原本已用 aggregate expectedSequence 重试，但每次重试都复制调用方预先生成的 input.state。事件不会冲突覆盖，不等于调用方陈旧 state 内的其他字段不会丢失。

本批沿原 checkpoint/checkpointControl 接口增加纯 state updater 形式：在每次 loadMutationSnapshot 后、publishCheckpoint 的 CAS 之前，使用最新 checkpoint state 重新计算；冲突后重新执行 updater，再计算摘要、resume token 和序号。保留原整份 state 写入语义与 control lease 校验，不新增存储或绕过授权。回调必须纯函数，可被多次调用，不能含副作用。

通知写入与 notificationTailRunID 已改为此形式：保存最新 taskRecovery 中的其他字段，严格验证通知身份和已有 payload 一致；陈旧登记不会将已完成 delivered 改回 false，也不会抹掉冻结 payload。此处是原通知 owner 的写法调整，不另建通知事务队列。

Core 新合同测试并发提交三个 updater，验证 count=3、provider/sessionLoop/admission 字段与既有 taskRecovery 全部保留，并复核 stateDigest。旧接口下测试失败（函数被当 state 展开成空对象），这是新增接口合同的 red test，不冒称已经注入真实 Provider 丢写故障。实现后专项通过，完整 durable-run.test.ts 为 38 pass / 154 expect / 0 fail，3.86 秒。Core/Arforge typecheck 与三文件格式检查通过；三文件 oxlint 48 warnings / 0 errors 未清零。产品正式+Task 批次结果另记。

产品最终验证（packages/arforge）：`bun test test/session/prompt.test.ts test/tool/task.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain|tool.task' --rerun-every`：45 pass / 412 expect / 78 filtered / 0 fail，138.65 秒，退出 0（14 Formal + 31 Task）。composition 保持 1751 sources / 3 roots / 5 bindings / 4 Runner uses，依赖台账已重新生成。

本批不关闭并发覆盖问题：Provider seed/progress/settlement、Loop 两处 intoContainer 和正式 admission 的读取后整份写回仍需迁移到相同原接口，并用受控交错验证两方向写入；不能因为底层新增 updater 就认定全部调用方已安全。还需 lease/epoch fencing、失效父 Action、真实进程重启等。R05 仍未完成。

安全自检：只运行隔离测试与本地 fixture，未操作真实用户数据库、外部 Provider、CLI/PATH 或三平台 sandbox；回退仅本批 durable-run.ts、durable-run.test.ts、task.ts 和证据增量，不重置工作区。

# 最新续修：持久化通知的丢失唤醒补偿（2026-09-07）

确认 coordinator.wake 只登记内存执行，旧 scanner 对 delivered=true 直接跳过；若入队和标记已保存而父执行尚未启动，通知可永久 pending。正式 draft 恢复夹具新增一条从未消费的隔离通知输入，保存对应 payload/messageID/delivered=true，不调用 wake，模拟该持久化状态。修复前等待父响应超时，0 pass / 1 fail，27.34 秒。夹具使用独立输入 ID 构造这一窗口，不是实际杀进程或重放生产 ID 生成过程。

修复融入原 TaskTool 与 Formal scanner：对已经 delivered 的通知，读取原 SessionInput，验证精确父 session、steer 类型及冻结 payload/agent 等价；只有 promotedSeq 缺失时请求原 coordinator 唤醒。已消费直接返回，输入缺失或不匹配拒绝，不重建消息、不运行 child、不新增 outbox。最新父 durable run 若 paused/cancelled/awaiting_authorization，明确不补唤醒，恢复扫描不是用户 resume 或授权决定。坏记录仍受上一批逐项错误边界隔离。

验证：正常父会话自动消费该输入，仅新增一次父模型请求，child attempts 仍为 1；已消费 helper 返回 undefined，promotedSeq 存在；内容不匹配返回失败。三种父状态以同一 helper 的 DurableRun.list 受控替身验证不唤醒，这是状态保护单元级断言，不冒充三种真实用户取消/暂停旅程。

- packages/arforge 正式筛选命令 `bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`：14 pass / 232 expect / 78 filtered / 0 fail，126.37 秒。此批在最后三个状态断言加入前启动，不将其描述为包含那些断言。
- 最终专项 `bun test test/session/prompt.test.ts --test-name-pattern 'orphaned draft child' --rerun-every`：1 pass / 25 expect / 91 filtered / 0 fail，19.01 秒，包含三个状态保护和消费/内容校验，不与上项累计。
- 最终 Arforge typecheck 退出 0。检查曾发现新增 list 的 typed error 边界，以及测试 Snapshot 未收窄 session run；分别沿原 orDie 边界与显式 child 绑定判断修正后通过。
- 最终三文件 Prettier check 通过，包含最后测试绑定判断；三文件 oxlint 49 warnings / 0 errors，未清零（在最后绑定判断加入前检查）。composition 仍 1751 sources / 3 roots / 5 bindings / 4 Runner uses，没有增加 Runner owner。

尚未证明：真实进程死亡/重启、父暂停/取消的端到端并发窗口、已 promoted 后的父执行故障、checkpoint 写入 fencing/原子合并、底层历史损坏逐条隔离与规模成本、失效父 Action 协调、完整嵌套授权。R05 保持未完成，不宣称 exactly-once 或整阶段验收。

安全自检：仅隔离 fixture/local HTTP 和源码、测试、证据增量；未触碰真实用户数据库、凭据、全局 CLI 或外部 Provider，三平台 full sandbox 继续后置。回退只撤销本批 task.ts、execution-formal.ts、prompt.test.ts 及文档增量，不重置工作区。

# 最新续修：损坏通知不得拖停恢复扫描（2026-09-07）

复现：正式 scanner 在批量 filter 中严格解码通知，一条 terminal child 的损坏 notification 即抛错，使本轮 orphaned child 和健康通知均无法处理。回归在同一隔离子会话中加入 cancelled child，保存 delivered 为字符串的坏记录；原代码等待正常任务恢复与通知超时，0 pass / 1 fail（28.68 秒）。

修复沿用原 Formal 扫描器：批量阶段只筛 terminal child，通知解码移动到现有逐项 Effect/catchCause 边界。不吞掉损坏内容、不标记 delivered、不启动坏 child，保留 runID 错误日志并继续处理其他任务。没有新队列、重试 owner 或宽松解码。

修复后专项 draft 场景 1 pass / 17 expect / 0 fail（15.20 秒）；四初态恢复夹具均加入坏记录，后续验证自动补发、父上下文不变、模型请求仍为两次，并断言坏记录完整 snapshot 不变。最终 `bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`（packages/arforge）为 14 pass / 227 expect / 78 filtered / 0 fail，121.05 秒，退出 0；不与专项累计。Arforge typecheck 退出 0，两文件格式通过，oxlint 25 warnings / 0 errors 未清零。composition 仍 1751 sources / 3 roots / 5 bindings / 4 Runner uses；composition/依赖台账均已重新生成。

范围：本修复隔离 taskRecovery.notification 解码错误，不证明 DurableRun.list/orphaned 的底层历史损坏已逐条隔离；整库扫描成本也未解决。进一步检查确认 coordinator.wake 只登记内存执行，因此“delivered 已写入、父执行尚未持久化时进程退出”仍是下一项实际缺口。checkpoint 并发写入、失效父 Action、真实重启和其他 R05 退出条件继续未完成。

安全自检：仅源码/隔离测试和证据增量，未操作真实用户数据库、凭据、全局 CLI 或外部 Provider；未执行三平台 full sandbox。回退限本节 execution-formal.ts、prompt.test.ts 与文档增量，保留其他改动。R05 不关闭。

# 最新续修：后台通知持久化补发与去重（2026-09-07）

## 本批实现与使用影响

继续 R05，不新增独立通知队列或执行器。TaskRuntime 在原 taskRecovery checkpoint 登记通知，以 child run 派生固定 message ID；发送前冻结 payload，排队续接启动时记录通知对应的 tail run，避免延迟通知取到后来独立任务的结果。正常后台完成、失败以及恢复后的通知均复用这一路径。

Formal 扫描器除未完成 child 外，还发现 terminal child 的未送达通知；recoverTask 对 terminal 记录只补通知，不重新运行子任务。正式 notify 直接调用原 SessionInput.admit 和 equivalent 校验，再请求原 coordinator 唤醒父会话；不再为该通知另建旧消息投影。取消的目标任务清理通知标记，不发送成功通知。用户无需新命令或切换引擎。

## 验证方法与边界

四种遗留状态 draft/preflight/queued/running 的正式恢复夹具中，先等待 child 完成和父会话消费，再将原通知 delivered 改回 false，模拟输入已经提交但最后标记丢失。等待真正的 Formal 扫描器自动恢复标记；随后重复调用恢复入口，断言父 Core 上下文不变、HTTP 模型请求仍为两次，且不得重启 child 的哨兵未触发。忙碌父会话的断言观察原 SessionInput 的 pending steer，不依赖旧消息影子。此为隔离状态故障注入，不是真实进程 kill/restart 验收。

最终命令（在 packages/arforge 执行）：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`，14 pass / 223 expect / 78 filtered / 0 fail，119.89 秒，退出 0，包含最终四种状态的自动扫描补发断言。本批 Task 完整文件 `bun test test/tool/task.test.ts --rerun-every` 为 31 pass / 177 expect / 0 fail；最终 Arforge typecheck 退出 0，四文件 Prettier check 通过。最新四文件 oxlint 为 55 warnings / 0 errors，未清零。不将重叠批次累计为完成比例。

composition 重新生成仍为 1751 sources / 3 roots / 5 bindings / 4 Runner uses，摘要 605015b02fd23c756b3c7f71e80110761e4c41493707af4fa6cb4013af06ee14；依赖台账重新生成，摘要 59263cbdafd02f0ff0b594ba2e82541f0daf857bbf8c5624d69bb13652af6685。台账生成不代替行为验收。

## 尚未达标的恢复窗口

- delivered 当前表示入队及唤醒请求返回，不表示父会话已消费；标记完成后、异步父执行真正启动前的退出窗口仍须补测和修复。
- checkpoint 当前为读取后写回完整 state，并非原子字段合并；与 Provider/其他通知并发写入的覆盖风险尚未验证。
- 损坏 notification 的解码发生在批量 filter 中，可能中断本轮扫描；需要逐条隔离故障。每轮全量读取的规模成本亦未验收。
- 原父 Action executing 且 lease 失效、真实跨进程队列顺序/认领、嵌套授权、其他旧执行路径退出仍未闭合。

R05 保持未完成，不宣称 exactly-once、跨进程可靠交付或整体交付达标。未调用真实外部 Provider、修改用户数据库/凭据/全局 CLI 或执行全平台 sandbox；回退只撤销本批 task.ts、prompt.ts、execution-formal.ts、prompt.test.ts 及证据增量，不重置工作区。

# R05 恢复时保留 child 语义检查点（2026-09-07）

## 缺陷与范围

ChildExecutor 在准备新的恢复 attempt 后，初始化新的 subagent-provider checkpoint。旧实现仅写入新的 provider/executionID/epoch/cursor，丢掉同一检查点容器内的 sessionLoop。即使 durable run 被找到，Core Loop 的 nextStep 和请求绑定也会丢失。

回归先准备 attempt 1，持久化 nextStep=4 的语义检查点，显式释放 fixture lease，然后通过真实 in-process Provider 的 ChildExecutor 开始 attempt 2。修复前 operation 读取 sessionLoop 得到 undefined（预期原检查点），测试失败。测试初稿曾因 fixture digest 格式和遗漏 summarizeFailure 失败，修正夹具后才得到上述真实缺陷证据；未把夹具错误算作产品缺陷。

## 实现

使用既有 SessionCheckpoint.fromContainer，在 prepare 取得新 attempt 前读取并校验旧语义状态；将校验后的 sessionLoop 放入新 epoch 的原有 Provider checkpoint。Provider cursor/lease 仍由已有机制生成，不复用过期 lease 或旧 epoch；不创建平行 checkpoint store。

负面场景：nested checkpoint 的 sessionID 属于其他会话时，execute 失败、operation=0、attemptsUsed 仍为 1、未获取新 lease，原错误检查点保留以供诊断，不静默覆盖。

本测试显式为 ChildExecutor 节点提供 SubagentProvider 依赖，确保不是跳过可选 provider 分支。未据此宣称产品全部组合路径均已完成 Provider 注入审计。

## 本批验证

- Core：`bun test test/runtime/subagent-child-executor.test.ts test/session-runner.test.ts --rerun-every`：118 pass / 475 expect，退出 0，53.92 秒。
- 修正测试中的不安全可选链断言后，重跑 child executor 完整文件：8 pass / 39 expect，退出 0；与上项重叠，不累计。
- Arforge：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain executes' --rerun-every`：10 pass / 127 expect / 78 filtered，退出 0，69.25 秒。
- Core/Arforge typecheck 均退出 0，两个改动文件 Prettier check 退出 0。
- 两文件 oxlint 最初 14 warnings，去掉新增不安全断言后为 12 warnings / 0 errors，退出 0；其余历史告警未关闭。
- composition 生成仍为 1751 sources / 3 roots / 5 bindings / 4 Runner uses，没有放宽白名单。

| 文件 | SHA-256 |
|---|---|
| packages/core/src/runtime/subagent-child-executor.ts | ad2a6f09f54382547c6b8f5e224d4f867ece1dec14e3d3b61fe1b9b957003552 |
| packages/core/test/runtime/subagent-child-executor.test.ts | 9fc309f1c2c4364bd0a637acb0071edd81d719e688ed2236781bb743015f4d56 |

## 继续执行的冷恢复缺口

本测试是同一隔离运行时释放 lease 后的重新认领，不是真实新进程/桌面重启测试。当前 Formal recovery scan 调用 DurableRun.orphaned，后者仅选 running/recovering 且无有效 lease；draft 排队续接不在扫描范围内。BackgroundJob pending/tail/done 又是进程内状态，硬退出后不会保留。后续必须用原有 parent/child/tool action 证据重建待执行意图，验证认领、权限/模型冻结、先后顺序及最终父通知；不能通过另起普通 root run 冒充 child recovery。

本批也未完成外部 Provider cursor 重放、旧 provider 绑定完整验证、并发检查点写入 fencing、准备阶段所有失败清理、嵌套授权与完整用户旅程。R05 保持未完成，全平台 sandbox 后置。

安全自检：只使用隔离 fixture，无真实 Provider/用户数据；没有提交、修改 CLI 全局配置或重启用户服务。回退只撤销两个源码/测试文件的本批增量，不重置工作区。

## 同日续修：普通 wake 不得接管未完成 child

SessionSnapshot 包含 child；draft 又不在 recoverable 查找范围内。新增回归在已有 draft child、已入队输入时调用不带 childAttempt 的 runner.run：修复前实际 Success（预期 Failure），测试退出 1。

现于普通 Runner 取得/创建 root run 前检查 Session 所有未完成 child，发现后要求 ChildExecutor attempt。列表读取失败同样 fail-closed。正确 childAttempt 分支不受影响。修复后断言：普通调用失败、Provider=0、原 child snapshot 不变、Session 仍仅一条 run；随后原 ChildExecutor 路径成功。

新鲜验证：Core `bun test test/session-runner.test.ts --rerun-every` 为 **110 pass / 440 expect，退出 0，57.10 秒**；Arforge 正式十场景筛选为 **10 pass / 127 expect / 78 filtered，退出 0，71.27 秒**。Core/Arforge typecheck 与两文件 Prettier check 通过；类型检查初次检出新 list 的 CorruptHistoryError，按既有 orDie 边界归一后通过，未吞掉读取错误。两文件 oxlint **57 warnings / 0 errors**，退出 0，未清零。

| 本续修文件 | SHA-256 |
|---|---|
| packages/core/src/session/runner/llm.ts | c9c2f1e4b52428b60933858f894d5e3eccd81a8d69ced8c499b9640353bde94f |
| packages/core/test/session-runner.test.ts | bc8af7612270b1dd5313bb00c5a00f41538a6426f218ff203c0502c1c69ffed3 |

限制：本次只是阻止错误接管，当前 Formal scanner 对孤立 child 的普通 wake 将被拒绝，不是恢复成功。下一步沿原 parent/tool call/child run 绑定分派 ChildExecutor，并处理 draft 意图、冻结模型/权限、顺序及父通知。检查到 root acquire 间的并发竞争尚未做事务证明；每次读取 Session run 历史的长历史性能亦待核验。未重启或修改用户真实服务/数据库，R05 仍未完成。

## 同日续接：持久化冻结的任务恢复参数

实码确认 draft child 只含目标/预算等 child 合同，真正 dispatch 所选 agent/model/variant 仍在 TaskRuntime 内存中。现由原 TaskRuntime 在新 child 入队前写入原 checkpoint 的 taskRecovery：版本、child/parent run、parentActionID、父子 Session、父 message/call、父子 agent、选定模型/variant、目录、权限摘要、sandbox profile 和经原 Parameters schema 校验的参数。

readRecoveryIntent 校验 schema/内容摘要及 childRunID、parentRunID、childSessionID、callID、delegatedObjective 的不可变绑定。摘要是完整性校验，不是签名或执行授权；未来恢复仍必须核对 parentAction、权限、目录和当前所有权。已有无记录 child 不伪造补写。Provider epoch 更新保留同一容器内 taskRecovery，不创建新 store。

正式排队场景在首个 child 运行且 followup 未开始时，分别读回两条记录，确认模型/父子绑定/任务参数；篡改摘要时拒绝。明确注入 Provider 的 Core fixture 验证更新到 attempt 2 后 frozen metadata 仍在。测试没有模拟新的操作系统进程，自动消费此记录的 scanner 尚未接入。

本批验证：产品 Task 完整文件 + 正式十场景的既有筛选命令为 **38 pass / 284 expect / 78 filtered，退出 0，76.78 秒**；Core child executor 全文件 **8 pass / 40 expect，退出 0**。补入 parentActionID 后重新运行正式运行中 followup 两场景 **2 pass / 54 expect，退出 0，17.28 秒**，及 Arforge typecheck 通过；Core typecheck、四文件格式检查也通过。四文件 lint **44 warnings / 0 errors**，退出 0，未清零。前后重叠测试不累计为独立总数。

| 当前续接文件 | SHA-256 |
|---|---|
| packages/arforge/src/tool/task.ts | b461a952ebebf2c0e0149308789759e677920030fd64a56ea27c530eb31300bf |
| packages/arforge/test/session/prompt.test.ts | 5aaf8c0415daf0e34ee9346a69e8fdca6b9fa5f2e8f3ec172629a6d8866b8bfc |
| packages/core/src/runtime/subagent-child-executor.ts | a5b713b2ace0a89f2ae1217c6382d4ebcd8613cc9d0a3e8f4f89717dcc18891b |
| packages/core/test/runtime/subagent-child-executor.test.ts | 6aa94cee6dd7ac5e6a211f9afb16321ce8b4ea72fe78c9e5efc55a3970f789e8 |

下一步直接接恢复记录的消费者：在正式 owner 内按原 parentAction/child 合同校验后调用既有 TaskRuntime/ChildExecutor，区分尚未入队的 prompt 与已存在 semantic cursor，避免重复 admit；还需 draft 扫描、有效 lease 避让、排序/通知及真实双进程中断回归。冻结记录本身不算自动恢复完成。全部使用隔离数据；未修改真实用户配置、未重启服务、未执行全平台 sandbox。
# 续修：未启动 child 扫描与顺序保护（2026-09-07）

原 DurableRun.orphaned 增加显式 includePendingChildren 选项，仅 Formal 扫描器启用。该模式读取完整创建事件列表（不受展示 limit 限制），按既有 durable 创建事件顺序选每个子会话最早的未完成 child；draft/preflight/queued/running/recovering 且无有效 lease 才返回。已暂停、等待授权、验证中或有 lease 的队头阻挡其后任务；terminal 前项跳过。不另存队列索引，也不按哈希 child ID/毫秒时间猜测先后。未启用选项的调用保留原语义。

recoverTask 在父 Action 未 settled 时直接返回，防止活父工具处于“已写 draft、尚未 BackgroundJob.start”窗口被扫描器抢占；settled 后仍通过 Gateway 验证成功观察、完整身份与授权，再走现有子权限/预算执行链。未解决失效父 Action 本身如何恢复，不能用该拒绝冒充自动恢复成功。

回归：draft 正式场景修复前超时（无恢复通知）；顺序单测修正过量 fixture 预算后，修复前返回空列表、修复后返回首项。新增 Core 单测验证有效 lease 队头阻塞、暂停且 lease 过期仍阻塞、取消前项后轮到第二项。四个正式初态均自动完成并通知父：前三类一次 attempt，running 两次；父工具执行中的显式恢复调用 snapshot 不变、HTTP=0。

新鲜命令：

- packages/core：`bun test test/durable-run.test.ts --rerun-every`，37 pass / 152 expect / 0 fail，2.59 秒。
- packages/arforge：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`，14 pass / 211 expect / 78 filtered / 0 fail，99.92 秒。
- Core/Arforge `bun run typecheck` 通过；五文件格式通过；oxlint 56 warnings / 0 errors，未清零。
- composition 保持 1751 sources / 3 roots / 5 bindings / 4 Runner uses。

边界：同会话排序在恢复快照中验证，不等于跨进程原子 session lease；实际进程重启/杀点、父失效 Action 协调、通知去重及丢失窗口、损坏历史隔离和大量历史扫描性能仍待继续。现有正式测试仍是隔离状态模拟，R05 不关闭。未操作真实用户数据/全局 CLI 或远端 Provider；回退只撤销本节增量。

# 续修：Formal 扫描器接回原 ChildExecutor（2026-09-07）

原 SessionExecutionFormal orphaned 扫描器现在区分 root/child：root 仍 coordinator.wake；child 通过 SessionPrompt.recoverTask 读取冻结参数，复核父 Gateway 授权与当前 task 权限、策略/目录、child 状态/lease，再复用 TaskRuntime + BackgroundJob + ChildExecutor。已有运行中的 job/有效 child lease 跳过。内部 restoreBackground 不进入模型参数 schema，用既有后台通知机制处理失去前台调用者的任务。普通任务 feature flag 行为不变。子 Runner 回调提取后仍唯一归 Formal 所有，无新增 Runner 调用点或 composition 白名单。

扫描逐项捕获拒绝，不因单个 child 校验失败跳过其余项。错误仍保留日志，不把拒绝标成已恢复。当前 orphaned 数据源仍只发现 running/recovering 的过期/无 lease 项，draft 尚未自动发现。

新增正式集成夹具：通过真实 Gateway/TaskRuntime 生成冻结 draft、模拟无 BackgroundJob 的遗留 attempt；扫描器自动接续并回传父通知。最终原 child completed、attempts=2、无 lease/activeAttempt、仅一个子会话/一个 Core assistant、零旧 assistant、两次本地模型 HTTP（child 与父通知）。初始化直接 TaskRuntime 的测试缺少 ChildExecutor 服务时失败，补充真实 fixture node 后通过；品牌 ID 类型错误修复后 typecheck 通过。此为隔离持久化状态模拟，不是实际杀进程或跨进程验收。

本批命令（packages/arforge）：

- `bun test test/session/prompt.test.ts test/tool/task.test.ts --test-name-pattern 'Formal scanner resumes|Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain|tool.task' --rerun-every`：42 pass / 347 expect / 78 filtered / 0 fail，85.85 秒，退出 0（11 个 Formal + 31 个 Task）。
- `bun run typecheck` 最终退出 0；四文件 Prettier check 通过，oxlint 40 warnings / 0 errors 未清零。
- composition：1751 sources / 3 roots / 5 bindings / 4 Runner uses，与此前调用数量一致。

下一落点：扩展原 durable 扫描覆盖 draft/preflight/queued child，按同子会话顺序重建并去重；验证父 lease 已失效时的协调、真实进程重启、通知去重/丢失窗口和权限/队列故障。当前 helper 能处理 draft 不等于 scanner 已发现 draft；不得关闭 R05。未触碰真实用户数据/全局 CLI/外部 Provider；回退仅按本节代码和文档增量，不重置工作区。

# 续修：正式 child admission 的父 Action 授权复核（2026-09-07）

原 ActionGateway 新增只读 validateDelegationParent，正式 admitChildPrompt 在写入摘要/输入之前调用。绑定父 action/run/session/agent/assistantMessage/toolCall/toolName；只接受持有当前 lease + activeAttempt 的 executing 父 Action，或 observation succeeded 的 settled 父 Action。自动授权复用当前 policy 检查且不能夹带 grant；scoped_grant/human 复用现有 validateParentGrantContract，检查原 protected binding、授权有效期及策略版本。此方法不签发 capability、不重新执行父工具、不代替子权限/lease 检查。

新增 Core 回归覆盖有效执行中/已结算自动父 Action、错误 run/name/call/message、失败父结果、无 lease 的 orphaned executing，以及有效 L2 授权在过期后被拒绝。验证过程前后 durable snapshot 不变。产品三个初测中 scheduled 通过，直接 admission 重入的两个测试因未提供 location-scoped Gateway 失败；改为从现有 LocationServiceMap 提供同一服务后通过，没有增加全局 Gateway 或放宽校验。

本批新鲜验证：

- packages/core：`bun test test/action-gateway.test.ts --rerun-every`，97 pass / 532 expect / 0 fail，7.03 秒。
- packages/arforge：`bun test test/session/prompt.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts --test-name-pattern 'Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain|code_mode' --rerun-every`，10 pass / 159 expect / 133 filtered，68.53 秒。过滤串未选中 code mode 用例，故单独完整重跑下项，不宣称本批包含它们。
- packages/arforge：`bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts --rerun-every`，55 pass / 159 expect / 0 fail，2.77 秒。本地 fixture MCP，不使用真实外部服务。
- Core/Arforge `bun run typecheck` 均最终通过。Arforge 首次发现两个完整 Gateway mock 缺新方法，补明确 die 哨兵（不用于模拟授权成功）后复查通过。
- 六个改动 TS 文件格式通过；oxlint 152 warnings / 0 errors，未清零。composition 仍 1751 sources / 3 roots / 5 bindings / 4 Runner uses。

未完成：scanner 尚未按 child 恢复；父 Action executing 且 lease 已失效时本校验明确拒绝，需要先协调原父执行权，不绕过授权。后续还需跨进程 draft 队列、通知、lease 抢占/输入原子性故障验证；现有辅助入口/旧路径亦未全部退出。R05 保持未完成，三平台 full sandbox 继续后置。未操作真实用户数据或全局 CLI/PATH，回退仅撤销本批增量。

# 续修：正式 child admission 输入去重（2026-09-07）

新 Task 在原冻结记录中保存 childMessageID，原 promptEffect 每次 attempt 使用这个 ID。正式 promptChild 复用内部 admitChildPrompt：先验证 run/session/当前 lease + attempt 和冻结 message ID，将输入摘要存入原 taskRecovery envelope，再调用既有 admission。若 SessionInput 已存在则读取原消息投影并验证其与 durable prompt 等价，不重复 createUserMessage/admit；输入变化、错误 ID、stale owner 或已有输入缺失摘要均 fail-closed。Provider epoch 更新继续整体保留 taskRecovery，没有第二个 inbox/队列/执行器。

正式运行中 followup 的 complete/cancel 场景额外调用同一 admission seam：已入队输入直接返回原 ID，注入的“不得再次 admit”哨兵未触发；改变文本、message ID、owner 均失败，旧消息集合完全不变、模型请求保持 5 次。这里借用活 attempt 验证重入，不宣称重启恢复。新旧 childMessageID 字段兼容解码；旧记录缺少冻结 ID 时正式 child admission 明确拒绝，不猜测历史随机消息身份。

本批验证（packages/arforge）：

- `bun test test/session/prompt.test.ts --test-name-pattern 'Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain' --rerun-every`：10 pass / 159 expect / 78 filtered / 0 fail，68.97 秒，退出 0。
- `bun test test/tool/task.test.ts --rerun-every`：31 pass / 177 expect / 0 fail，12.08 秒，退出 0。
- `bun run typecheck`：提取内部 seam 后首次发现 Database 服务未绑定，补用现有捕获的 Database 后最终重跑退出 0。
- 三个改动 TS 文件 Prettier check 通过；oxlint 36 warnings / 0 errors，退出 0，未清零告警。
- composition 保持 1751 sources / 3 roots / 5 bindings / 4 Runner uses，无白名单扩张。

未关闭：原父 DurableAction 授权复核、scanner 的 child 分派、draft 排队重建、跨进程父通知；输入摘要写入与 legacy message/SessionInput 入队尚非单事务，实际 kill 点和并发租约抢占仍需故障验证。摘要不替代权限或加密签名，本文不证明所有恢复边界达标。未操作真实用户数据/外部 Provider/CLI PATH；回退仅限本批增量。R05 仍未完成。

# 续修：冻结记录接入共享 TaskRuntime 重入路径（2026-09-07）

本轮在原 TaskRuntime 消费已有 taskRecovery，而非新增恢复队列/执行器。相同 parent run + call 的重入，校验冻结参数、父 session/message/action/agent 后从原 childSessionID 加载；损坏记录（包括 null）拒绝。检查当前子会话权限、重新计算的权限、目录、sandbox 与冻结值一致后才继续，不覆盖已经改变的策略。模型和 variant 使用冻结值。已有 terminal child 由原 ChildExecutor 返回结果，不再次 prompt。

先复现：原始参数不含 task_id 的同一 durable 调用再次进入，原实现先创建新 Session，随后报 child Session 绑定错误。新增回归修复后验证原会话复用、无额外 child、原 terminal snapshot 不变；篡改 prompt、父 Action/message 或改变权限/sandbox 被拒绝，不覆盖目标状态。

另测 admission 在 checkpoint 保存后、队列启动前失败，留下 draft；重新构造 TaskRuntime 并给不同当前 model/variant，复用原会话及冻结路由，最终 completed、一次 attempt、无 lease。此测试同进程共享服务，不是跨进程 scanner 验收。

本批命令（packages/arforge）：

- `bun test test/tool/task.test.ts --rerun-every`：31 pass / 177 expect / 0 fail，11.25 秒。随后修 reasoningLevel 的冻结显示和测试品牌类型，两个相关场景重跑 2 pass / 52 expect / 29 filtered，4.78 秒；不累加。
- `bun test test/session/prompt.test.ts --test-name-pattern 'Formal model task' --rerun-every`：4 pass / 77 expect / 84 filtered，26.75 秒，旧 processor 哨兵仍启用。
- `bun run typecheck`：首次新增测试的品牌类型断言错误，修复后重跑退出 0。
- 两文件 Prettier check：最终通过（修正新增断言换行）；oxlint：24 warnings / 0 errors，告警未清零。

边界：当前仅校验调用上下文的 parentActionID 与冻结值，不代表已从 DurableAction 重新验证授权。无冻结记录的历史路径保留兼容行为，不用于自动恢复证明。scanner 尚未接入；已运行 child 仍需 semantic admission 去重、队列重建和父通知，不能将 draft 成功等同于冷恢复完成，R05 不关闭。未修改 CLI/PATH、真实用户数据或远程 Provider；仅按本节文件增量可回退，不重置脏工作区。
