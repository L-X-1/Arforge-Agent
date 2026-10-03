# R05 排队 followup 取消清理（2026-09-07）

## 复现

正式模型入口：首个 child 保持运行并提升为后台，第二次 task_id followup 已创建 durable child run 并排队。调用现有 BackgroundJob.cancel 后，新增回归要求两条 run 都 cancelled。修复前实际排队 run 仍是 draft，测试退出 1；证明此前只有运行中的 ChildExecutor 得到清理。

## 修复

在同一个 Core BackgroundJob.extend 增加可选 onDiscard 清理回调；队列 scope 关闭且执行尚未开始时调用。TaskRuntime 使用既有 DurableRun.cancelChild，并携带不可变 parentRunID/childRunID，递归取消未开始的 followup。没有新增队列、run owner 或取消权限数据库。

清理登记发生在排队 fork 之前；开始执行后由原 ChildExecutor 负责终态，本回调不覆盖正常结果。缺失 job 的 extend 返回 false，不接收该工作，因此也不调用 discard。此机制是活进程的 scope 生命周期清理，不能对硬进程死亡执行内存 finalizer。

## 验证

- 修复后两个正式运行中 followup 场景（complete/cancel）：2 pass / 34 expect；取消时两条 run 均 cancelled，attemptsUsed 排序为 [0,1]，无 activeAttempt/lease，Provider 请求仍为五次，排队 child 没有开始。
- packages/core：`bun test test/background-job.test.ts --rerun-every`：6 pass / 416 expect，退出 0。包括取消时 discard 一次、正常执行不 discard、重复取消不重复清理、未接收工作不清理，及原即时结算/队列发布检查。
- packages/arforge：`bun test test/session/prompt.test.ts test/tool/task.test.ts --test-name-pattern 'Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain executes|tool.task' --rerun-every`：38 pass / 264 expect / 78 filtered，退出 0，74.42 秒；含正式十场景和 Task 完整 28 项，不是 prompt 全文件。
- Core/Arforge `bun run typecheck` 均退出 0，四文件 Prettier check 通过。
- 四文件 oxlint：29 warnings / 0 errors，退出 0，未清零告警。
- composition 生成：1751 sources / 3 roots / 5 bindings / 4 Runner uses，未扩大白名单。

| 文件 | SHA-256 |
|---|---|
| packages/core/src/background-job.ts | bbc6cd2683e3d2e6a4e147f71439aebbf5dc5d8850c313ceef2e04050b5dd9c9 |
| packages/core/test/background-job.test.ts | e91dcefee64052857d4a62afa5a9ed39fd0b93854a04a4af94e6c0759956d9b1 |
| packages/arforge/src/tool/task.ts | eeabdc2e8d7256325dccf1f0f318c5dd717c8042e79831e6b95c5d43d23fada2 |
| packages/arforge/test/session/prompt.test.ts | 130901c7463a914cf3f11844281e4096e7190108c330a5e81ca715021e11189a |

## 尚未完成

下一步：硬进程退出后 pending child 的恢复依据、所有者重新认领和最终通知；另须核验队列首项异常、取消与开始执行的竞争、prepare 失败、并发权限变化。当前没有据此宣布跨进程恢复、事务式结算或全 R05 完成。嵌套授权、model/variant 和最终真实用户旅程继续保留。

安全自检：全部测试使用隔离 fixture，无真实 Provider 或用户数据；没有提交、修改全局 CLI 或执行全平台 sandbox。回退仅撤销本次四文件增量，不能重置整个工作区。
