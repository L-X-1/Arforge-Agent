# R05 普通模型 task 与 followup 正式接线（2026-09-07）

## 复现与实现

新增正式入口回归，使用普通 admit 而非 slash/subtask，LLM fixture 返回 task 调用。修复前实际 child 数量为 0（预期 1），测试退出 1。根因：正式适配器只在存在 scheduled route 时创建工具，Runner 又只在 executeScheduledTask 中 materialize 它；普通模型工具定义没有该路径。

本次复用同一 TaskRuntime、Core Tool、childAttempt 回调与 CoreMessageCompat：

- Formal 每次 drain 构建原有工具，通过 modelTaskCalls 显式允许模型调用；不创建第二个 executor，也不做 Location 全局注册，避免不同父会话互相覆盖回调。
- Runner 在普通工具 materialization 中传入同一 tool；达到最后一步不继续暴露工具。
- Registry 的 modelTaskTool 是单次 materialization 内的 transient registration，应用现有 disabled 过滤和 Gateway。它不携带 scheduled-task 的兼容标记，因此沿正常 run-bound Action 身份，不复用旧 scheduled 身份规则。
- 原 scheduled route 保持不变；模型调用从调用对应的 Core assistant 获取 model/provider，找不到则拒绝。普通调用不设置 bypassAgentCheck，继续执行既有 task 权限要求。
- followup 使用已有 task_id，仍受上一批 direct-child 归属校验；不重新启用旧 processor。

## 新鲜测试

均使用隔离数据库、测试 profile 和本地 HTTP fixture，无真实 Provider/用户数据。

1. Arforge：`bun test test/session/prompt.test.ts --test-name-pattern 'Formal model task|Formal background completion|Formal scheduled cancellation|integrated Formal drain executes' --rerun-every`：8 pass / 93 expect / 78 filtered，退出 0，56.49 秒。
   - 普通模型初次 task + task_id followup：同一 child 会话、两条完成的 child run、各一次 attempt、无 activeAttempt/lease，六次 Provider 请求；child Core assistant 两条，父子旧 assistant 均零。
   - task/general deny：无 child、工具错误结果可见；拒绝发生后父会话可继续。
   - 原六个 scheduled/background/cancel 场景仍通过。
2. Core：`bun test test/session-runner.test.ts test/session-runner-tool-registry.test.ts --rerun-every`：144 pass / 717 expect，退出 0，58.84 秒。此时尚未增加下一条 registry identity 回归。
3. 随后增加模型 task definition 隔离和 run-bound Action ID 检查；初次误将字符串输出期望写成 json，实际标准输出为 text，纠正测试后重跑 `bun test test/session-runner-tool-registry.test.ts --rerun-every`：35 pass / 286 expect，退出 0。前后有重叠，不累计成独立总数。
4. Core/Arforge typecheck 均退出 0；八文件 Prettier check 退出 0。
5. 八文件 oxlint：68 warnings / 0 errors，退出 0，未宣称零告警。
6. composition 生成成功：1751 sources / 3 roots / 5 bindings / 4 Runner uses；没有扩大白名单。

## 源码边界

| 文件 | SHA-256 |
|---|---|
| packages/arforge/src/session/execution-formal.ts | d635fc7023e14835010eee1d8662a770d2e2993ee81466026d03e4efd2a00357 |
| packages/arforge/src/session/prompt.ts | a2da1280671253199b9514daa4ff4fafcffb433508976b4eb17d30539bf2f400 |
| packages/arforge/src/tool/core-bridge.ts | 126f115273b56175239f3af16ac3e236b129276865bfcf53adfc12608dec388f |
| packages/arforge/test/session/prompt.test.ts | bcd1b5d28521464763a6647196bf6353337dab57e3cda38dac81954c38a8efbd |
| packages/core/src/session/runner/index.ts | 94c532a2b837f15429a0365b2ae8b14487177f1423e24e16d9b622b6b807537c |
| packages/core/src/session/runner/llm.ts | e1a6894f889400632850fb26cf7551a2bc035aa59c831d947760e893020c9087 |
| packages/core/src/tool/registry.ts | ea0549059cecc240bd74c2e0ff0bebf0140fa8abe2c404cd2e0e3d3df1570375 |
| packages/core/test/session-runner-tool-registry.test.ts | f3722fbaf3ffdb62d93d8da0bb7857cd59296de434233ada8d20438549681841 |

## 下一步与限制

本次闭合普通父会话前景委派与完成后 followup 的正式成功路径，不等于 R05 全来源交付。子代理允许嵌套 task 时的递归接线、模型切换/variant、运行中 followup、cold resume、准备失败与读取失败区分、并发重入、权限变化、原子结算及完整用户取消协议仍待核验。真实桌面体验与全平台 sandbox 未执行；后者继续最后进行。

旧/manual prompt fallback 仍有消费者，不删除旧 Loop。没有改动全局入口、用户配置、真实数据或 Git 提交；回退须仅撤销本批八文件增量，不重置脏工作区。

## 同日续验：运行中 followup

新增正式模型入口场景：首次 child 用 Deferred 保持运行，提升为后台后父会话返回；父会话再调用带 task_id 的 task，复用该 child 并排队。释放首个 child 前，已存在两条 durable child run，但只有一个 activeAttempt、共五个 HTTP 请求。释放后 followup 执行，随后才通知父会话，总计七次请求；followup 请求包含首轮 child 结果，最终父请求包含 followup 结果。两条 run 均 completed、各一次 attempt、activeAttempt/lease 清理，父子旧 assistant 均零。

单独场景 1 pass / 19 expect；随后使用上文同一正式筛选命令重跑：**9 pass / 112 expect / 78 filtered，退出 0，62.30 秒**。Arforge typecheck 和测试文件 Prettier check 均退出 0。本续验仅改测试，没有修改产品代码或重跑八文件 lint，前批告警仍未关闭。

最新 prompt.test.ts SHA-256 为 `9d32fa22c7987928a0afd037faf0dbaada91501e1c9feb772be3d1a4878459ef`，前文 hash 保留为初批边界。

范围限制：Core BackgroundJob 明确是 process-local registry，pending/tail/done 等队列状态不跨进程持久化。因此本次证明同一进程内成功串行续接，不证明进程死亡后的队列恢复。下一步优先验证已创建但未开始的 child run 在取消/重启后的归属和终态，再处理冷恢复；不能仅凭 durable run 存在就宣称队列可恢复。未触碰真实用户数据。
