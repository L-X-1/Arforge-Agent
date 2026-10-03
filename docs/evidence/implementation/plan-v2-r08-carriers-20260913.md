# R08：旧会话／计划任务后处理融合与历史升级恢复（2026-09-13）

## 本批结论

旧会话内置工具、兼容计划任务与 TS 原生计划任务的 after hook 已进入原 Core Tool.postprocess → ToolPipeline → ActionGateway 阶段。没有新增工具执行器、通用截断器、权限服务或持久化状态表。原始成功 Observation 先落盘，展示转换不再作为执行体的一部分；后处理报错或取消不改写已发生的成功。

这是 R08 的实现与专项验收，不关闭整个 R08/R09/R13 或 R30。三平台 full sandbox 仍只在 R30 后执行，无发布工作。

## 具体融合与兼容规则

1. 原 executeMature 保留唯一 Mature 叶执行适配，继续保留 before hook、精确权限、Shell/Egress、进度 metadata、附件过滤和父子 Action 身份；去除执行体内 after hook 分支。外部工具、旧会话工具和计划任务统一消费原 postprocessMature。
2. 原生 makeScheduledTaskTool 同样移出 after hook，保留 TaskRuntime 和原 Core 子任务调度；不把原生任务改回兼容状态机。
3. 兼容 Task 使用本次 materialization 内的回调引用，把原 projection.complete/fail/interrupt 接到后处理结果，不重新调用 projection 创建器。成功展示交给原 complete；插件失败调用原 fail 并使用不含插件原文的提示；取消调用原 interrupt。执行失败仍沿原失败路径，不伪造子任务成功。该临时 Map 不是恢复记录或新的任务 owner；恢复不创建或调用这些回调。
4. 用户显式附件读取原本不触发插件 hooks，继续保持该边界，未把它无意纳入新 hook。
5. 修复升级后旧结果被新增 postprocessing:projection 标记拒绝的问题：仅在原 Action 已 settled、Observation succeeded 且有精确输出时，允许对无新标记／无 post 记录的历史进行只读复用。比较时只剔除新增的协议标记，原 subject、调用身份、资源、语义、输入和授权摘要仍必须一致。不重写旧事件，不补跑新 hook，不把旧输出伪造为新阶段已确认结果。
6. 原 Run 的同一调用若由 Provider 重放到新的 assistant message，沿原 Gateway 的 identity alias 机制找到原 Action。未结算的旧动作也会被识别并拒绝自动执行，不因为升级后的标记不同而另建 Action。旧 v1 subjectless 的精确已完成结果仍可读；变化输入／资源／语义／agent／授权被拒绝；新动作移除处理器或标记仍被拒绝。

## 验证覆盖与边界

- 三种新增接线各覆盖正常转换、插件失败、取消；兼容任务另测 completion 回调失败。检查原始成功、展示状态、再次调用计数和 Action sequence；保留现有 before/权限、Shell、附件及父子身份测试。
- 真实 Windows 子进程测试共 17 项：外部工具 started/completed × 四种大小共 8 项；三种新接线在原始和展示都大于 1 MiB 时各测 started/completed，共 6 项；三种接线各测无 post 标记的历史升级恢复，共 3 项。父进程等待 IPC 就绪后 SIGKILL，新进程经实际 ToolRegistry 恢复，executor/hook 与兼容 projection 回调均为 0；完整 settlement、Artifact 收据、Action/catalog sequence 保持一致。
- 旧历史由测试专用的无 post Tool 合同经真实 Registry/Gateway 保存，读取使用当前实际适配器；没有通过篡改事件来制造这一批历史，也没有运行旧发行版二进制。Core 单测另保留原 v1 历史 fixture。不能把这些测试外推为任意历史版本均已兼容。
- 正式会话集成覆盖自动预排子任务、允许／拒绝授权及原 assistant/call/action 身份恢复。原生正式旅程记录父 Core assistant=2、旧 assistant=0，子 Core assistant=1、旧 assistant=0，Provider calls=2、child run=1、attempt=1、child tokens=7。使用测试模型服务，不冒充真实外部 Provider 验收。

## 最终测试结果

默认 Bun 1.3.14 (0d9b296a)。Core 明确使用 --rerun-every；不累计重跑或重叠测试为功能完成率。

| 范围 | 最终结果 | 原始输出 |
| --- | --- | --- |
| Core Gateway/Store/DurableAction/manifest/Pipeline 五完整文件 | 229 pass，0 fail，1235 断言，17.56 秒 | [Core](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-carriers-core-20260913.txt) |
| Native/冷恢复/MCP adapter/CodeMode 五完整文件 | 126 pass，0 fail，892 断言，107.06 秒 | [Native](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-carriers-native-20260913.txt) |
| Runner/Registry 两完整文件 | 238 pass，0 fail，1650 断言，203.80 秒 | [Runner](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-carriers-runner-20260913.txt) |
| 正式预排子任务旅程筛选 | 4 pass，0 fail，63 断言，196 filtered，36.88 秒 | [Formal](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-carriers-formal-20260913.txt) |
| 强制 workspace typecheck | 22/22 successful，0 cached，73.338 秒 | [Types](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-carriers-types-20260913.txt) |
| 六文件格式／scoped diff-check／lint | 格式和 diff-check 通过；155 warnings，0 errors | 本批 format/lint 工具记录；未声称告警清零 |

复验命令：

```powershell
# packages/core
bun test --rerun-every --timeout 60000 test/action-gateway.test.ts test/tool-output-store.test.ts test/durable-action.test.ts test/durable-event-manifest.test.ts test/tool-pipeline.test.ts
bun test --rerun-every --timeout 60000 test/session-runner.test.ts test/session-runner-tool-registry.test.ts
# packages/arforge
bun test --timeout 60000 test/tool/core-bridge.test.ts test/tool/core-bridge-cold-postprocessing.test.ts test/mcp/gateway-adapter.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts
bun test --timeout 60000 test/session/prompt.test.ts -t 'Formal scheduled subtask|integrated Formal drain executes an admitted automatic subtask'
# 根目录
bun run typecheck --force
```

升级回归先出现 5 pass / 1 fail（368b2c）：完全相同旧结果被 ActionIntentMismatch 拒绝；修复后精确匹配与拒绝变化用例通过。早期 TaskRuntime fixture 的参数、元数据与 reasoningLevel 类型不完整，以及历史 fixture 把声明类别误作语义、修改 readonly options，均属于本批测试构造错误；修正后重新跑完整类型与相关测试，不冒充新的产品缺陷。当前作用域没有修改公开 schema 或 HTTP 合同，未重跑 SDK 生成；不把上一批 SDK/HTTP 验证伪称本批新结果。

## 仍未验收：下一步必须保留

1. **兼容任务展示与回执的跨阶段失败窗口**：projection.complete 在 post callback 内发生，早于 Gateway 的最终编码／completed 事件提交。提交失败或进程在中间被杀，仍需在原 Task/Action owner 中验证并处理一致性；本批完成计数和 17 个指定强杀点不能代替此证明。原始结果落盘失败而未进入 post 时的兼容展示关闭及临时回调生命周期也需专项覆盖。
2. 大结果 bytes→index→catalog→Observation/post 的各个中途故障、孤儿回收、历史退役与总占用控制仍未闭合。精确 Action payload 目前 durable 不自动过期；展示附件仍保留原期限，恢复不续期。
3. 旧已结算结果的升级只读兼容已补首批；旧未结算动作的用户恢复旅程、缺失／损坏旧结果、配置改变后展示语义及其他历史版本仍需补齐。
4. 默认 MCP 最近完整结果仍为上一批 **201 pass / 17 fail / 993 断言**，本批仅重跑 adapter，不声称默认本地启动／生命周期已修好。继续任务绑定、累计目录／授权、聚合时限、OAuth 和关闭；不能通过扩大权限或切换运行时隐藏失败，也不将其统称为后置 R31。
5. 活跃 PersonalJob 原预算／当前授权／部分计费及自身冷恢复，外部 Provider，Python 能力／数据／测试语义融合和物理退役，不同用户体验及 R28/R30 全部退出条件保持原范围。R04/R06/R07/R08/R09/R13/R17/R23/R30 不关闭。

本批测试使用既有隔离 profile；复核真实用户 catalog SHA256 仍为 77dc943d082372e7573f97bf3f688baa8d399db34afd4dab185e84ee50d62ac0。未修改实际用户会话／凭据、CLI/PATH、全局运行时或目录授权；未暂存、提交或回退用户工作树。用户指南首次写入失败，确认非只读且内容未变后用同一 apply_patch 重试成功，没有修改权限或绕过写入约束。沿原 composition / runner-negative / dependency / source snapshot 工具同步证据；freshness 是绑定校验，不是功能验收。

首次最终 freshness 校验（3b138a）准确检出用户指南更新后的 dependency 摘要过期；需要在最终文档写入后重建原依赖台账，再生成 source snapshot 并复验，不修改验证器或降低缺失证据要求。capability-links 仍只有 4 条记录、4 条缺证，不能由 freshness 通过推断能力融合清单已完成。
