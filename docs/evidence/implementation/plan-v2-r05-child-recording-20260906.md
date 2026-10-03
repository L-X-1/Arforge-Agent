# R05：正式 scheduled task 的父子执行记录

日期：2026-09-06。本批是计划 R05 第 1 项的实际链路记录，不是旧 Loop 已退出的验收。

## 动态证据

扩充既有 `packages/arforge/test/session/prompt.test.ts` 中的 `integrated Formal drain executes an admitted automatic subtask once before the parent request`，没有另造模拟产品入口。测试经 prompt.admitCommand → SessionInput → 正式 SessionExecutionFormal → Core scheduled task → TaskRuntime，并使用本地录制 HTTP Provider 返回 child/parent 两个答案。

本次输出（只含计数，不含会话正文、路径或凭据）：

```json
{"parentCoreAssistants":2,"parentLegacyAssistants":0,"childCoreAssistants":0,"childLegacyAssistants":1,"providerCalls":2,"childRunCount":1,"childAttempts":1,"childTokens":7}
```

父任务已使用 Core；子任务仍只产生旧 assistant 记录。原测试只验证父任务没有旧影子消息，11 个断言通过不能证明子任务也已使用 Core。扩充后继续断言 child 只有一个 durable run、completed、一次 attempt、7 tokens 结算、没有活动 attempt 和遗留 lease，共 **1 passed / 17 expect() calls**。同文件其他 78 项被明确过滤，未宣称全文件通过。

这些计数不证明任意工具文件写入只有一次：该场景只有子任务文本请求，未执行真实写入工具。旧存储计数仅输出为诊断，没有把“必须继续使用旧 Loop”写成兼容断言。

## 实码责任边界

- `session/prompt.ts` 的 scheduledTaskTool 调用 ops()，ops.prompt 调用私有 prompt()；后者 admit 后仍调用 loop()。这是仍在用的子路径，不是无消费者残留。
- `tool/task.ts` 在有 parent run 时创建/复用 durable child，并由既有 SubagentChildExecutor.execute 持有 lease、beginAttempt、记录 usage baseline、结算与释放 lease；随后调用 ops.prompt，传递 child runID。
- Core `session/runner/llm.ts` 的普通 run() 自行查 recoverable、acquireLease、beginAttempt、最终结算。其公开输入目前没有接管现有 child attempt 的合同。直接把 ops.prompt 替换成普通 runner.run 不足以满足 R05，会碰撞既有租约/attempt 责任；不能以绕过 lease 检查解决。
- SubagentChildExecutor 的 ChildExecution 已含 attempt、ownerID、leaseID、usage baseline、timeout；后续须沿既有 DurableRun 校验和执行上下文融合，不能把任意 runID 当授权，也不能另建 child loop。

## 验证与限制

```powershell
# packages/arforge
bun test test/session/prompt.test.ts --test-name-pattern 'integrated Formal drain executes an admitted automatic subtask once before the parent request' --rerun-every
bun run typecheck
```

上述专项测试通过；包 typecheck 通过，Prettier check 通过。该测试文件全文件 oxlint --deny-warnings **13 warnings / 0 errors，退出码 1**；本次新增的不必要非空断言已修复，其余告警仍存在，未压制或宣称 lint 通过。

最终测试文件 SHA-256：cf93703274582d9f50a07bfe2cbac2dbb6b67840a2756e848a4b9b790098cb6a。

本批没有改变生产执行链，没有完成 R05。下一步是既有 child lease/attempt 与 Core Runner 的单一执行接线，并增加旧 processor 抛错哨兵、前景/后台/followup、取消隔离和故障恢复回归；这些通过前不得删除旧 Loop，也不能把记录测试当唯一 owner 验收。其他工作包和用户后置的 full sandbox 保持原范围。
