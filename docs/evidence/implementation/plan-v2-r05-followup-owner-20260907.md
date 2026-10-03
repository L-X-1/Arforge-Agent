# R05 followup 会话归属保护（2026-09-07）

## 已复现的缺陷

TaskRuntime 接收 task_id 后，读取已有 Session 即改写其 permission 和 sandbox profile，没有检查 parentID。模型提供的续接句柄不应授予接管其他会话的权限。

新增两个负面回归：task_id 指向父会话自身、指向另一个父会话的 child。修复前命令 `bun test test/tool/task.test.ts --test-name-pattern 'rejects followup' --rerun-every` 得到 0 pass / 2 fail；二者都被实际 execute 接受（预期 failure，实际 success）。全部使用隔离 fixture，不涉及真实会话。

## 原位修复

在既有 TaskRuntime 中检查已加载目标的 parentID 必须等于当前 ctx.sessionID。失败发生在目标权限、sandbox、child run 创建和 prompt 之前。没有增加第二套权限 owner 或接续实现。检查后的资源身份仍使用既有 Session ID。

修复后负面测试断言：execute 失败，prompt 次数为 0，目标 Session 完整信息不变，当前父会话没有新建 child。原有合法 child 接续仍通过，权限继续按现有 bounded contract 收窄。

## 本批新鲜验证

工作目录 packages/arforge：

- `bun test test/tool/task.test.ts --rerun-every`：28 pass / 137 expect，退出 0，完整文件。
- `bun test test/session/prompt.test.ts --test-name-pattern 'Formal background completion|Formal scheduled cancellation|integrated Formal drain executes' --rerun-every`：6 pass / 70 expect / 78 filtered，退出 0，45.38 秒。
- `bun run typecheck`：退出 0。
- 两个改动文件 Prettier check：退出 0。
- 两文件 oxlint：21 warnings / 0 errors，退出 0；没有清零历史告警。
- composition 重新生成：1751 sources / 3 roots / 5 bindings / 4 Runner uses，未扩大白名单。

| 文件 | SHA-256 |
|---|---|
| packages/arforge/src/tool/task.ts | ece7c6d4219aa0a7006ff2fd623cc9caefe78a0bef29b6093e13decd0531959d |
| packages/arforge/test/tool/task.test.ts | 0d6d92dac947af0e51f5179ffc207867600a790495a506688d7014614cba4d6d |

## 未闭合 / 下一落点

本批证明共享 TaskRuntime 的目标归属边界，不是所有正式模型 followup 的端到端证明。当前 SessionExecutionFormal 按 admitted scheduled task ID 建 route，Core Runner 的 executeScheduledTask 单独 materialize 该 tool；scheduledTaskInput 只传 prompt/description/agent/command，没有 task_id。因此不能拿已有 scheduled 子任务测试替代普通模型 task 调用和 task_id 后续任务验证。下一步检查普通工具 materialization/路由，把它融合到同一 TaskRuntime，而非复制另一执行器。

另有：目标读取当前 catchCause 将所有失败当作不存在；找不到 task_id 时仍按原合同新建 child。这不是本次增加的行为，但读取失败区分、冷恢复、并发权限变化与事务边界仍待修复验证。不得宣布 R05 完成。

安全自检：未操作真实用户数据、未使用外部 Provider、未提交或变更全局入口；仅修改上述两文件增量和证据。需回退时仅撤销本次增量，不重置整个脏工作区。

## 续修：已有 task_id 读取失败不得误建任务

2026-09-07：共享 TaskRuntime 将会话查询的 `catchCause` 收窄为 `catchTag("NotFoundError")`。仅明确不存在保留原有新建合同；存储 defect 和中断原样传播，不发布任务 metadata、不调用 prompt、不创建替代 child。正式模型和 scheduled task 仍复用同一实现，没有新增恢复 owner。

回归先运行两个新增用例：修复前均失败（读取 defect / interrupt 后 execute 反而成功）；修复后完整文件通过。中间一次测试误用 JSON.stringify(Error) 检查消息导致断言失败，改为 Cause.pretty 后重新完整运行，并非隐藏产品失败。

本批原始命令与结果（packages/arforge）：

- `bun test test/tool/task.test.ts --rerun-every`：30 pass、0 fail、147 expect，10.76 秒，退出 0。
- `bun test test/session/prompt.test.ts --test-name-pattern 'Formal model task' --rerun-every`：4 pass、0 fail、77 expect、84 filtered，26.87 秒，退出 0。覆盖拒绝授权、完成后续接、运行中排队完成和排队取消；仍有旧 processor 抛错哨兵。
- `bun run typecheck`：最终测试修改后重跑，退出 0。
- 根目录两改动 TS 文件 `bunx prettier --check`：通过；`bunx oxlint`：24 warnings / 0 errors，退出 0，告警未清零。

未闭合：本批只证明读取失败不会变成新任务，并未接通新进程恢复消费者。冻结记录的 parent Action / 当前策略复核、draft 队列重建、重复 admission 防护、恢复后的父通知以及其余 R05 退出条件仍待完成。不据此关闭 R05，也不累加历史批次形成完成率。未访问真实用户数据库或远端 Provider，未调整 CLI/PATH；仅可按本节增量回退，不重置工作区。
