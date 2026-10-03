# R08：计划任务唯一原生 owner 与回执故障修复（2026-09-13）

## 本批结论与证据边界

正式计划任务只保留 `SessionExecutionFormal → SessionPrompt.scheduledTaskTool → TaskRuntime → Core ToolRegistry/ActionGateway → SessionEvent`。已退役没有产品消费者的兼容 scheduledTaskCarrier 及额外 Mature 展示回调，不新增任务管理器、执行器、恢复表或第二份业务状态。

本批还修复回执存储错误泄漏与取消信号被二次写入失败覆盖。原始成功、展示回执、会话展示仍归原 owner。**R08 仅本批专项通过，完整 R07/R08/R09/R13/R30 未关闭。** 全会话测试存在已定位失败，不能用专项通过覆盖；R31 只在 R30 后执行，不含发布。

## 为什么退役兼容分支，而不是继续融合它

上一批曾为 makeScheduledTaskCarrier 保留 projection.complete/fail/interrupt 回调，发现 complete 早于 Gateway 最终回执的问题。本批继续检查产品调用链后确认：

- Formal 实际只调用 prompt.scheduledTaskTool；scheduledTaskCarrier 仅有定义、返回属性、兼容构造器与测试。
- 删除 prompt 的 scheduledTaskCarrier/prepareScheduledSubtaskProjection，bridge 的 ScheduledTaskProjection/makeScheduledTaskCarrier/临时回调 Map，Core 的 ScheduledTask opaque 类型与 Runner legacy 联合分支。
- ToolRegistry 和 Runner 都拒绝旧未类型化 scheduledTask 参数，返回明确 retired-use-scheduledTaskTool 错误。负例覆盖有／无原生工具两种输入，原 executor、Provider 和 DurableRun 创建均为零。
- 原生路径复用 TaskRuntime.description、execute、before/after hooks、精确权限、metadata 进度及父子身份；原调用 ID 不因切除兼容分支改变。正式 Session 投影仅在 Gateway 成功返回后创建最终成功展示。
- 仓库 TS/TSX 搜索只剩原 topology 检查与负例字符串。AFD-004 已要求原生路径且拒绝旧兼容分支回流；没有把字符串扫描当成运行行为验收。

删除的是闲置 TS 兼容代码与仅服务该分支的测试，不是用户历史数据，也不是 Python 全框架物理退役完成。旧会话工具与用户显式附件适配仍属于其他原有保留范围，本批未扩大删除。

## 回执／展示的真实缺陷与修复

### 1. 存储错误不应被显示成任务执行失败

已复现：原 Action settled/succeeded 后，completed 回执投影器失败，Runner 展示了测试存储层原文 PRIVATE_POST_RECEIPT_WRITE_FAILURE。原工具其实已经执行成功，不能把它描述成可重试的执行失败。

在原 Gateway 的 recordProcessing 边界转换为安全、阶段明确的 PostProcessingError：动作已完成，但回执未确认；检查原结果，不要重复执行。保留原始 Observation，不伪造 completed 回执，不补跑后处理。已知安全错误和纯 interruption 保持语义。

### 2. 取消不能被二次回执失败吞掉

RED 记录中，afterSuccess 取消后 interrupted 回执写入缺陷把纯 interruption 变成普通错误。现 Gateway 在该二次失败处记录不含原始存储正文的 receipt.unconfirmed 审计，保留原取消 cause；父 Loop 不会把它当普通工具错误继续执行。

最终矩阵覆盖 started/completed/failed/interrupted × 存储 defect/interrupt，共 8 项：原结果始终 succeeded；回执最多停在原 started（started 本身写失败则没有回执）；再次调用 executor/hook 不增加、Action snapshot 不变。取消时检查审计未泄漏测试错误正文。

初版矩阵把 typed Error 从只允许 never 错误的 EventV2 projector 返回，类型检查准确拒绝。已改为符合正式 projector 合同的 defect/interrupt，未使用类型强转或放宽产品合同。初版 defect 分支独立复现的取消问题有效；不把该 fixture 类型错误冒充产品缺陷。

### 3. 原 Session 展示失败按原记录修复

原生 Runner 增补两个边界：

- Gateway completed 回执已保存、SessionEvent.Tool.Success 写失败：再次运行按同一原 Action 修复确认展示，executor/hook 各 1，不重做任务。
- 原始成功已保存、最终回执未保存：展示明确未确认，而不是伪造成功展示或重跑；同一 Action 保持不变。

Formal 批准／拒绝预排任务测试同时验证：批准时回执先于 Session 成功事件写入；拒绝时两者均不产生成功。测试用 SQLite rowid 作跨 aggregate 插入顺序见证，不作为产品持久身份。

这些是原产品服务和真实 SQLite 的进程内故障注入，不冒充回执／Session 中间点的 SIGKILL 验收。

## 测试与静态验证

默认 Windows / Bun 1.3.14 (0d9b296a)，隔离 profile/数据库/本地模型服务，不使用用户真实数据或真实付费 Provider。重跑和重叠范围不累计为功能百分比。

| 范围 | 结果 | 原始输出 |
| --- | --- | --- |
| Core Gateway/Store/DurableAction/manifest/Pipeline 五完整文件 | 237 pass，0 fail，1337 断言，21.21 秒 | [Core](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-core-20260913.txt) |
| Runner/Registry 两完整文件 | 241 pass，0 fail，1679 断言，220.97 秒 | [Runner](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-runner-20260913.txt) |
| Native/冷恢复/MCP adapter/CodeMode 五完整文件 | 121 pass，0 fail，773 断言，75.53 秒 | [Native](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-native-20260913.txt) |
| Formal 预排任务、权限、失败、恢复、父／子取消筛选 | 9 pass，0 fail，191 filtered，137 断言，67.99 秒 | [Formal](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-formal-20260913.txt) |
| 回执／会话展示专项（包含在上方完整文件中） | 10 pass，0 fail，125 断言，4.55 秒 | [Receipt](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-receipt-20260913.txt) |
| workspace 强制 typecheck | 22/22 successful，0 cached，59.056 秒 | [Types](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-types-20260913.txt) |
| 原 topology 负例 | 5 pass，0 fail，17 断言 | [Topology tests](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-topology-tests-20260913.txt) |
| 原 session-owner / canonical tool-pipeline 审计 | exit 0，findings 为空，Formal AFD-001—005 ready | [Owner](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-topology-20260913.txt)、[Pipeline](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-pipeline-20260913.txt) |
| 16 文件 scoped lint | 327 warnings，0 errors；未清零 | [Lint 摘要](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-lint-20260913.txt) |

原生冷恢复从 17 项变为 14 项，是退役未调用兼容路径的 3 项：现保留 external 8、legacy 3、native-task 3。活动原生任务的权限／进度／身份／失败测试已迁到真实 TaskRuntime；旧会话与原生任务各新增超大展示错误覆盖。强杀恢复仍比较原 executor/hook 不再调用、完整结果、Artifact 回执及 Action/catalog sequence；不以删除无消费者分支冒充新增恢复能力。

回执矩阵失败复现保留在 [RED](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-receipt-red-20260913.txt)。此前旧代码测试夹具错误的 force 参数、scheduled Action ID、TaskRuntime 类型修正不列作产品新缺陷。最后格式调整仅改测试排版，16 文件最终格式与 scoped diff-check 均通过；未改公开 Schema/HTTP 合同，本批未重新生成 SDK 或重跑 HTTP 全量。

## 必须公开的失败：取消后同会话新请求未可用

完整 prompt.test.ts 是 **193 pass / 6 skip / 1 fail / 2273 断言，800.21 秒，exit 1**。它在本批切除兼容分支后、最终 Gateway 回执修复前启动；不能冒充最终快照的全文件验证。原始结果：[完整会话失败](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-prompt-full-failure-20260913.txt)。

单独运行仍失败；测试现在竞争等待真实 Provider 请求和原 fiber 终态，提前返回时直接显示原错误，不再只等 10 秒打印超时。未删除用例、降低断言或扩大超时。定位结果为：

1. 第一轮 HTTP 已发出但响应无任何内容，取消保留 paused run 与 dispatching checkpoint。
2. 第二轮明确的新用户输入仍选择该 recoverable run。
3. runLoop 按原 dispatching guard 返回 RecoveryRequired：旧请求可能已发出，结果未知，禁止自动重放。
4. 没有假 assistant，也没有第二次 HTTP；安全拦截有效，但用户取消后继续任务的旅程未完成。

[单项诊断原始输出](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-cancel-diagnosis-20260913.txt)，0 pass / 1 fail / 9 断言。最终回执修复及格式整理后再次单独复验仍为 **0 pass / 1 fail / 9 断言，6.79 秒**，同一 RecoveryRequired 原因，见[最终源码失败记录](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-native-task-owner-cancel-final-failure-20260913.txt)。该问题属于 R07/R27 的实际产品可用性缺口，不是 R31 后置沙箱，也不能修改测试接受永久阻断后声称完成。下一步在原 Run/Session owner 中完善显式取消、未知请求处置和新输入继续，保留原请求/用量/账单/身份，不自动重放未知请求、不创建平行未完成 run、不丢弃待处理输入。用户指南已明确当前限制。

## 仍未完成与后续顺序

1. 优先闭合上述“请求已发出但无响应→取消→明确继续新任务”的正式产品旅程，并验证授权、原预算、待处理输入及跨进程恢复；保留未知结果保护。
2. R08/R09 的原成功落盘前后、bytes/index/catalog/Observation/post 中途失败与真实强杀、孤儿及历史退役回收、总占用控制继续留在原 ToolOutputStore/Artifact。
3. R13 默认 MCP 最近全目录仍 **201 pass / 17 fail**；本批只跑 adapter。目录/授权、聚合时限、OAuth/关闭、本地启动兼容不得靠扩大权限、换运行时或降级隐藏。
4. 活跃 PersonalJob 原预算/当前授权/部分计费及自身强杀恢复、外部 Provider 与 cold resume、Python 能力/数据/测试语义融合与物理退役、不同用户体验及 R28/R30 均保留。
5. 历史已结算结果精确只读兼容仍有效；不等于所有旧发行版、未完成动作及旧配置都已可迁移。

用户数据安全复核：真实 catalog SHA256 仍为 77dc943d082372e7573f97bf3f688baa8d399db34afd4dab185e84ee50d62ac0。没有删除历史数据、改用户凭据/CLI/PATH/系统 Bun/目录授权，未暂存或提交。沿用原 composition、runner-negative、dependency 和 source snapshot 生成器同步，不新增治理系统；freshness 通过只证明绑定未漂移，不是能力完成率。
