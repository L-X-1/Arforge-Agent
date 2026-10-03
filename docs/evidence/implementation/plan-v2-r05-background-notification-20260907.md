# R05：正式后台完成通知融合（2026-09-07）

## 范围和验收

问题：正式 scheduled child 已走 Core，但 TaskRuntime 的后台结果注入仍调用普通 prompt，可能启动旧 Loop。

本次在既有 TaskPromptOps 增加内部 notify 操作，由正式适配器提供 SessionRunCoordinator.wake 回调。通知沿既有 admit/SessionInput 入队，再唤醒同一正式父会话；不等待父 Loop，不添加第二个执行器、队列或持久化 owner。Runner 调用仍只在 canonical composition 内。

兼容限制：旧/manual adapter 未提供 notify 时仍使用原 prompt fallback，不能据此删除旧 Loop。notify 与子任务 prompt 分开，避免把无 childAttempt 的子任务误当作无需等待的通知。

## 正式场景

测试使用现有正式 integration fixture，旧 SessionProcessor.create 被替换为抛错哨兵。通过真实本地 LLM HTTP 夹具和 Deferred：

1. 正式命令启动 child，等待 Provider 请求到达。
2. 经既有 BackgroundJob.promote 提升为后台，父任务完成首轮。
3. 释放 child，后台结果进入父请求，父任务由 Core 完成第二轮。
4. 父子旧 assistant 均为 0；child 只有一个 durable run、一次 attempt，完成后 lease 清理。

测试不依赖固定 sleep；不调用真实远程 Provider、不使用用户数据库或密钥。未变更全局 CLI、未提交、未启动 full sandbox。

## 本轮验证

- packages/arforge：`bun test test/session/prompt.test.ts test/tool/task.test.ts --test-name-pattern 'Formal background completion|Formal scheduled cancellation|integrated Formal drain executes|Task' --rerun-every`：5 pass / 69 expect / 103 filtered。含四个正式场景及一条 Task durable 测试，不是两文件全量。
- packages/arforge：`bun test test/tool/task.test.ts --rerun-every`：26 pass / 129 expect，完整文件通过。与前项有重叠，不合并成独立测试总数。
- `bun run typecheck`：初次发现 callback/coordinator 循环推导错误；为 wakeSession 标注 Effect<void> 返回值后退出 0。
- 四个改动文件 Prettier check：退出 0。
- 四文件 oxlint：36 warnings / 0 errors，退出 0；没有采用零告警验收，也没有关闭历史告警。
- composition ledger 生成：1751 sources / 3 roots / 5 bindings / 4 Runner uses；未扩大白名单。

## 当前源码

| 文件 | SHA-256 |
|---|---|
| packages/arforge/src/tool/task.ts | f149893684ebb4f5f3d488db17c3c8a1b51fbbd46f93436a6ac4e19ee7d54e84 |
| packages/arforge/src/session/prompt.ts | a20e9dea1a75b5b9d15b9b55bceb6fe491e2a6ff28d17026a9fb937299cfa1e0 |
| packages/arforge/src/session/execution-formal.ts | 3645273cd508b10c6f354437e6c36705522d3201bae581b201d97034fa45c1ec |
| packages/arforge/test/session/prompt.test.ts | 47e57cd615056685bfb5268ef4217a3a3745bb894b1346a0fd28af364d3e56af |

## 下一步 / 不宣称完成

初批只证明提升为后台后成功完成的通知；后续补充见下节。仍须补 followup、冷恢复及取消协议正式入口，继续准备阶段失败清理、并发重入、原子结算和 workspace/权限验收。不证明所有后台生命周期或真实桌面用户旅程，R05 仍未关闭。

本轮未触碰真实数据；如需回退，仅撤销本证据对应的四文件增量，不能重置包含其他未提交工作的工作区。

## 同日续验：忙碌父会话与失败通知

沿用同一正式 fixture，增加两条行为证据，没有新增产品执行路径：

- 父会话仍忙：用独立 Deferred 保持父请求未结束；释放 child 后，观察后台结果已持久化为 synthetic 输入，此时 HTTP 请求仍只有两次。释放父请求后，同一正式链继续处理结果。旧 assistant 仍为零，child 仍一次 run/attempt。
- child 流式错误：本地 HTTP fixture 注入 streamError，父会话收到 `Background task failed:`，child durable 状态为 failed，lease 清理；没有错误标为 completed。此条不等于所有超时、准备失败或崩溃情况。

当前命令：packages/arforge 内 `bun test test/session/prompt.test.ts --test-name-pattern 'Formal background completion|Formal scheduled cancellation|integrated Formal drain executes' --rerun-every`，退出 0：**6 pass / 70 expect / 78 filtered**，46.28 秒。包含三条后台场景、两条取消及一条正常前景；不是 prompt 文件全量。Arforge typecheck 和该测试文件 Prettier check 均退出 0。本续验仅改测试，没有重跑或关闭前批 lint 告警。

续验测试 SHA-256：`b528d86dbfdade828b94eed8f9bcc7843f2db0520cda284a5491e734e3b9dbfb`；前文 hash 保留为初批边界，产品三文件未在此次修改。测试全部继续使用隔离夹具；下一落点为 followup 与恢复，不用测试数量推算完成百分比。
