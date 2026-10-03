# R05：正式 scheduled child 接入 Core，取消回归修复

日期：2026-09-06。承接 child lease/Core borrowed attempt 切片。本批完成一个正式产品子路径的迁入，不等于 R05 全部完成。

## 生产接线

TaskRuntime 在已有 durable child execution 时，通过 TaskPromptOps 的第二个内部参数传递 childRunID 和 execution。没有把 lease/owner 参数加入公开 PromptInput JSON schema，也不接受单独 runID 作为执行授权。

SessionPrompt 的内部 promptChild 先核验 run 与执行上下文，再使用既有 admit → SessionInput。正式 SessionExecutionFormal 向 scheduledTaskTool 提供 runChild 回调，由该执行适配器在 child 的 directory/workspace 对应 Location 下调用同一 Core Runner；prompt 不直接调用 Runner。结果从 Core SessionStore 读取，使用已有 CoreMessageCompat.projectAssistant 返回给父任务，不另写旧 assistant 或发明新显示转换器；SessionStatus 的 busy/idle 仅作为兼容通知。

没有执行上下文的旧/manual 调用仍走原路径，尚不能删除 prompt.loop/runLoop。后台完成通知到父任务的旧 prompt 路径、普通工具来源与 followup/恢复需要继续收尾。

## 正式入口的变化

既有 `integrated Formal drain executes an admitted automatic subtask once before the parent request` 使用本地 HTTP fixture，经过正式 SessionExecutionFormal、TaskRuntime 和真实 Core Runner。旧 SessionProcessor.create 被替换成抛错哨兵；测试仍成功，且父任务请求包含 child 输出。

```json
{"parentCoreAssistants":2,"parentLegacyAssistants":0,"childCoreAssistants":1,"childLegacyAssistants":0,"providerCalls":2,"childRunCount":1,"childAttempts":1,"childTokens":7}
```

相比上一批 childCore=0、childLegacy=1，现在正式 scheduled child 已变为 Core=1、legacy=0。固定 fixture 的 3 input + 4 output tokens 仅结算一次；父子仍只有两次 Provider 请求。

## 取消缺陷与修复

新正式取消测试先失败：父任务停止后 child 仍有 activeAttempt/lease。根因是 child executor 在可中断 Effect.exit 之后执行结算，中断能跳过后续代码。

现通过 uninterruptibleMask 保证准备/结算边界，Provider operation 通过 restore 保持可中断。中断后按既有 ChildExecutor 结算/cancelChild/releaseLease。TaskRuntime 的 AbortSignal 还会停止已有 BackgroundJob 所拥有的 child fiber，不能只调用旧 SessionRunState.cancel。

Task 单测原本让收到 cancel 的假 prompt 返回成功文本“cancelled”，现在改为真正挂起的 operation；abort 必须终止 job，不能误报成功。该变化先出现预期不一致，修正的是测试的取消合同，不以“成功取消”伪装正常完成。

两个正式取消场景均安装旧 processor 哨兵：

- 通过 SessionExecution.interrupt 停止 parent：child cancelled，无 activeAttempt/lease，Provider 只收到 child 的一次请求。
- 通过已有 BackgroundJob.cancel 停止 child：child 同样清理，parent 随后继续请求并得到最终 Core assistant。证明 fiber/runner 层的取消隔离；尚未据此宣称所有 HTTP/桌面取消入口都已接通。

## 验证

- Core child executor/provider/control 三文件：32 passed / 191 expect() calls。
- 产品 Task 工具完整文件：26 passed / 129 expect() calls。
- 正式 scheduled task 正常/parent cancel/child cancel：3 passed / 36 expect() calls；prompt 文件其余 78 项明确过滤。
- 本批合计 **61 passed / 356 expect() calls**。Core/Arforge typecheck 与五文件 Prettier 检查通过。五文件全量 lint **46 warnings / 0 errors，退出码 1**，没有标全绿；其他历史告警也未关闭。

全部使用测试 profile/内存 DB/本地录制 HTTP，不访问真实 Provider 或用户数据库。没有提交、修改全局入口或执行 full sandbox。

| 文件 | SHA-256 |
|---|---|
| packages/arforge/src/tool/task.ts | fc073b74b9feba10bcd176f40fa455f1e2b93d8d5d6acb3358771f22d2b385bb |
| packages/arforge/src/session/prompt.ts | 8e3e87aabdebd8c7e6425289d31a32bcc235838e9f55f9240e01bc54f051e8f8 |
| packages/arforge/src/session/execution-formal.ts | c4a40f0d04000673644b0332b1cb16c0f6c776a1152e56e7990dbc92575426bc |
| packages/arforge/test/session/prompt.test.ts | c8a2e65815f0ac2a91d457e51e1d3ddd21d5854b55f434ab19ec7dd6cc679036 |
| packages/arforge/test/tool/task.test.ts | df476dbacea2480ba2507b199f0b9339a87be71f04edf0e0e99cc26ed1916a58 |
| packages/core/src/runtime/subagent-child-executor.ts | d1aed75372a033d8caf0866777c11e917e2330b44f128b7075974ab430e0ecb1 |

## 仍未关闭

9 月 7 日校准：最初 prompt 直接调用 Runner 被 composition 的 PY101-006 拒绝；已将实际调用移回既有正式适配器，没有扩展检查器白名单。调整后重新运行三个正式入口场景，3 passed / 36 expect() calls，Arforge typecheck 通过；上文 61 项是前一轮各范围结果，未冒充本次全部重跑。旧进程句柄已不可用，因此重新运行测试，没有以丢失句柄推断成功。六文件当前静态检查结果须与之前五文件的 46 条警告区分。

全来源前景/后台/followup、冷恢复、已有 provider cursor 的重新初始化、准备/初始化阶段失败后的资源清理、并发重入、事务式结算 fencing、workspace 定位变更与权限回归、完整产品取消协议及 UI 使用均待补。此次不删除仍有消费者的旧 Loop，不将三条正式测试外推为整个 R05 验收。
