# R05：既有 child attempt 的复核与陈旧结算阻断

日期：2026-09-06。承接正式父子链记录，开始补 Core Runner 复用 child execution 所需的边界。本批已改生产 child executor，但未把子任务切换到 Core Loop。

## 实际修改

在现有 `SubagentChildExecutor` 增加 `validateExecution`，复用 DurableRun.validateLease 检查 run/lease/owner/有效期，再检查 child 身份、session、running 状态和 active attempt。该操作只读，不新建 run、不获取第二把租约、不启动 attempt；不会把单独 runID 当成有效执行上下文。

既有 execute 在调用 product operation 前执行复核，并延迟构造 operation；settle 在写 provider checkpoint、finishAttempt、状态和结果前再次复核。测试中旧 worker 主动释放租约，replacement-worker 获取新租约，旧操作随后返回：旧 worker 的 settlement 被拒绝，新 worker 的租约、running 状态和 active attempt 保留，tokensUsed 保持 0。

这不是原子事务式 fencing 的最终证明：复核后到后续多条写入之间仍存在并发窗口；需与 R17 的既有事务/结算机制继续融合，不能称全生命周期竞态已消除。

## 新鲜验证

- Core 子代理 executor/provider/control 三文件：**32 passed / 191 expect() calls**。
- 产品 Task 工具完整文件：**26 passed / 129 expect() calls**，包含 child 取消、后台执行和中断恢复等既有场景。
- 正式 scheduled task 专项：**1 passed / 17 expect() calls**；仍记录 childCoreAssistants=0、childLegacyAssistants=1，生产 Loop 尚未迁移。没有将 Task 层 mock 验收冒充正式 Core child 验收。
- 本批合计 **59 passed / 337 expect() calls**。Core 与 Arforge 包 typecheck 通过，受改两文件 Prettier check 通过。
- 两受改文件 oxlint --deny-warnings **11 warnings / 0 errors，退出码 1**，未宣称 lint 通过。此前 prompt 测试 13 warnings、R08 57 warnings 也没有由本批关闭。

新测试覆盖有效上下文复核不改变 durable snapshot/数量，错误 session/attempt/owner 被拒，以及替换租约后的陈旧结算。未单独覆盖自然过期、新进程、任意并发时序。测试先发现 fixture 的 releaseLease 缺 reason 与类型窄化错误，修正后重新通过；不把这些 fixture 失败当成生产缺陷复现。

| 文件 | SHA-256 |
|---|---|
| packages/core/src/runtime/subagent-child-executor.ts | 5e6a4caca23a531521ec335ddc37a92407553168a7b88e8e1c2b6d6cfa150e71 |
| packages/core/test/runtime/subagent-child-executor.test.ts | 25b41c5c99d05f143fdb15d395f11367c7e3823397d85f1728d799eeb3723ed1 |

## 下一接线与未完成项

Core Runner 普通 run 仍独立负责 acquireLease/beginAttempt/settlement，不能在现有 child execute 内无条件调用。需在同一 Runner 接受经验证的现有执行上下文，明确由 ChildExecutor 继续负责生命周期结算；semantic checkpoint 与 provider continuation 必须保留在同一 DurableRun 状态中，不能相互覆盖。之后再接 admission、Core 结果到兼容显示投影、drain/wait/cancel，以及旧 processor 哨兵和完整正常/异常/恢复旅程。

R05 未完成；没有删除旧 Loop，也没有创建独立 child runtime。未触碰用户配置/数据库/凭据，不执行后置 full sandbox。

## 同日后续：Core Runner 复用路径已实现，产品接线待完成

本节更新上文“下一接线”的 Core 部分，不追溯修改上一批测试结果。

- 在既有 SessionRunner.run 增加内部 childAttempt 输入，使用 validateExecution 复核既有 child run/lease/owner/attempt，并在每个 continuation turn 前再次复核。该分支复用同一个 runLoop、deferred tool 与 primary delivery 范围，不获取租约、不 beginAttempt、不创建/结算另一个 run。生命周期仍由 ChildExecutor 拥有；要求 Runner 自行调用结算观察器的输入会明确拒绝，不静默吞掉结算职责。
- Core SessionCheckpoint 支持在既有 provider checkpoint 内保存 sessionLoop 字段，保留顶层 subagentContinuation/lease/permission/epoch。正常与中断检查点写入均复用该组合；已有损坏或外部 session 的嵌套语义游标拒绝覆盖。该 helper 只解释 Core 游标，不负责认证 Provider 绑定；绑定仍由既有 Provider/ChildExecutor 验证。
- 新集成测试使用实际 Core Runner + DurableRun + ChildExecutor + in-process Provider，只有 LLM 返回为确定性 fixture。验证错误 attempt 不调用 LLM、不改变 durable snapshot；正确执行结束时同一 lease/activeAttempt 保留，Core assistant 完成且 Provider 游标可读，最后 ChildExecutor 结算为 completed，只有一个 child run/一次 attempt、无遗留 lease。本 fixture 的 usage reader 固定为 0，不能将本批宣称为真实 usage 计费验收；上一批正式产品测试的 7 tokens 记录仍单独有效。
- 测试中必须显式把 SubagentProvider 注入 ChildExecutor 的节点依赖；仅把 Provider 放在根分组，不能证明 Effect 可选服务实际进入该 owner。此处是测试组装，不声称生产可选 Provider 接线已核验。首次缺少注入时 phase=idle 的失败促使修正 fixture，随后复测通过。

最新三文件全量：**123 passed / 483 expect() calls**（session-runner、session/checkpoint、subagent-child-executor），耗时约 65 秒。Core/Arforge typecheck 与五文件格式检查通过。全文件 lint 尚未通过：Runner 两文件 57 warnings，checkpoint/index/checkpoint-test 三文件 2 warnings，均 0 errors；不把专项类型检查当 lint 全绿。

| 最新受测文件 | SHA-256 |
|---|---|
| packages/core/src/session/checkpoint.ts | fdc8404a74a95dbde03a3889681866ab92e77876f639deef5356eda977a06958 |
| packages/core/src/session/runner/index.ts | db17567ffecfaf7df357fb788e68dfacd3fd276c994abdf4a8d4bfd7c69ed728 |
| packages/core/src/session/runner/llm.ts | 4037f2791711de5bc467a6bda393bc3bc8d611fc07e2d72b7a39f10432749c65 |
| packages/core/test/session/checkpoint.test.ts | 92d8ff74226167caa998b5c4e169386b6a9023b683898a66a0b6d9cf67a55541 |
| packages/core/test/session-runner.test.ts | 200a33f08f91a7a2d8ad0f1e0e91c5ec3594f2349d7a77f31b28769ca29ad660 |

产品 TaskPromptOps 尚未传递 childAttempt，旧 child Loop 仍可达。下一步应接正式 scheduled task/前景/后台/followup 的 admission、Core 结果投影、cancel/drain，再以旧 processor 抛错哨兵证明旧 Loop 可退出。当前仍未验证借用上下文的任意并发重入、跨进程恢复、完整计费/结算事务，以及 Provider 初始化对已有 semantic cursor 的冷恢复处理；这些限制不因三文件回归通过而关闭。
