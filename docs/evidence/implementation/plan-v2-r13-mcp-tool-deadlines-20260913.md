# R13：MCP 工具总时限与未知结果不可重放（2026-09-13）

## 本批实现与验收边界

继续桌面 v2 计划的 R13，同时覆盖原 R08/R17 的工具动作错误分类边界。原 `McpCatalog` 的期限实现已供目录、旧兼容工具投影和 `McpGatewayAdapter` 共用；没有新建执行器、任务状态库、超时配置或第二套 supervisor。正式 native tool 与 CodeMode 仍消费同一个 Gateway adapter。

本批不关闭整个 R13，也不改变 R31 必须在 R30 后执行的顺序；不涉及发布。

### 可核验行为

1. 原 request 配置是整次工具协议操作的硬期限，缺省仍为 Core ConfigMCP.DefaultTimeout（30000 毫秒）。进度通知保留，但不能把执行无限延期；未新增隐式倍率或另一份长任务配置。
2. 普通 callTool 与 SDK experimental task stream 都消费同一 deadline、AbortSignal 和 maxTotalTimeout。任务创建、所有状态轮询、轮询间隔、最终结果等待共用一段时间。
3. 期限开始于原 Gateway 授权和前置 hook 后的协议执行阶段；不是整段用户交互或整个 Agent run 的墙钟总预算。外层调度等待、后置 hook、持久写入和收尾不被本批冒充覆盖。
4. Deadline 的 Promise/Effect 消费者复用同一个原生资源。退出移除自有 timer/listener，Effect 请求中断转给 SDK，迟到响应不能通过下一次读取进入原持久任务绑定或成功结算。
5. SDK 把请求错误包装成 stream 的 error 消息，不能据此判定远端副作用失败。未确认的协议错误、超时以及已分派后的运行器中断映射到原 TransportOutcomeUnknownError，由原 ActionGateway 记录 blocked、无 Observation、无活动 attempt，要求恢复检查；同一 invocation 不能再发调用。
6. 合法 taskCreated 仍使用原 context.bindExternalOperation 持久绑定任务引用，不保存任务 payload。已匹配该引用的明确 failed/cancelled taskStatus 和合法 isError 工具结果仍保留明确失败语义；正常成功照常结算并从原结果重放，不重复请求。
7. 保留正数/整数/宿主 timer 上限校验，非法期限和调用前已取消信号不启动 Catalog 兼容工具请求。

## 原 owner / 入口映射

| 文件与符号 | 本批作用 |
|---|---|
| packages/arforge/src/mcp/catalog.ts：openDeadline / withDeadline | 从已有目录期限实现提取可按 scope 关闭的预算；run 统一检查过期、调用方取消和迟到成功 |
| 同文件：convertTool / paginate | 两个既有消费者共用同一预算，没有新增直接执行入口 |
| packages/arforge/src/mcp/gateway-adapter.ts：mcpCallViaGateway | 原动作内按需拉取 SDK iterator，保留持久绑定；总期限、取消转发和 unknown 分类融合到这里 |
| 同文件：mcpRequestViaGateway | 继续原父子身份、规范参数摘要、权限、hook 与 durableResult；outcomeUnknownOnFailure 消费原类型，未新增持久化实现 |
| packages/arforge/src/mcp/tool-projection.ts / src/tool/code-mode.ts | 实码复核仍传原 entry.timeout / abort 到同一 adapter；本批未另建产品接线 |

执行体仍可被中断。只在该体退出后的分类阶段使用原 Effect uninterruptibleMask，防止已经分派的中断被 Gateway 写成普通失败 Observation；没有将整个远端执行改成不可取消。

## 失败复现与验证方法

- 真实 SDK Client + Server + InMemoryTransport，不替换 SDK 的 progress 或 task polling 实现。连续 15 次进度（每次间隔 20 毫秒）、request=100：修前 Catalog、Gateway call、Gateway stream 三项均错误成功，RED 为 0 pass / 3 fail / 3 断言（任务记录 44f50f）；修后三项均要求超时及调用次数=1，Gateway 无伪造失败结果且同 invocation 重放被拒绝。
- 实际 SDK 任务覆盖持续 working、1500 毫秒轮询间隔、最终结果等待 600 毫秒、状态请求协议错误、明确 failed、明确 cancelled、正常 success。任务引用在失败后仍在原数据库；未知结果同 invocation 不再次创建、轮询或取结果。
- 1500 毫秒休眠场景要求调用方在 1000 毫秒以内结束（含本地动作结算，协议预算为 100），再让 SDK 休眠真正经过后检查调用/轮询/结果请求次数均不增加。此为取消边界测试，不是用睡眠猜测异步启动。
- 用户取消先等待真实服务 handler 已接到 tools/call，再分别 AbortController.abort 与 Fiber.interrupt。后者修复前回报 recovery.state=blocked、非 outcome_unknown（a22198：1 pass / 1 fail）；修复后两种都保留 unknown、没有 Observation、服务器收到取消且不重放（d6a4e2：2 pass / 8 断言）。
- 中间实现曾因 Effect v4 的 try 参数写法错误而失败，已按对象 try/catch 修正；明确 failed/cancelled 的两个场景也曾被过度归类 unknown，已恢复有合法任务终态证明时的明确失败语义。这些中间失败不计作旧实现缺陷。

## 最终验证

环境：Windows，项目 Bun 1.3.14（0d9b296a）、既有 MCP SDK 1.29.0、Effect 4.0.0-beta.83。未更换运行时或修改依赖版本。本批未改 schema，未重复生成 SDK。

| 运行位置 / 命令 | 结果 |
|---|---|
| arforge：bun test --timeout 60000 test/mcp/catalog.test.ts test/mcp/gateway-adapter.test.ts test/mcp/reconciliation.test.ts test/mcp/cold-reconciliation.test.ts | 54 pass / 0 fail / 251 断言，14.15 秒，exit 0（514929） |
| arforge：bun test --timeout 60000 test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts | 55 pass / 0 fail / 159 断言，3.46 秒，exit 0（39f2f5） |
| 根目录：bun turbo typecheck --concurrency=2 --force | 22/22，0 cached，56.221 秒，exit 0（718d7e） |
| 根目录：四个源/测试文件 Prettier check / git diff --check | exit 0（f060f8 / 9a42f7） |
| 根目录：同四文件 Oxlint | 32 warnings / 0 errors，exit 0（c7303c）；未宣称整仓 lint 达标 |
| arforge：bun test --timeout 60000 test/mcp | 190 pass / 17 fail / 854 断言，207 项，125.17 秒，exit 1（7d85fe）；仍是原本地加载及相关生命周期 17 项，不跳过、不降级 |

各批有重叠，不累计成计划百分比。Cold reconciliation 两项是原有模拟断连/任务绑定记录在真实新进程的只读重建回归；本批没有新增“实际 progress 超时后立刻 SIGKILL 再新进程恢复”的组合用例。CodeMode 集成使用真实服务端与原测试客户端，Gateway 为隔离替身，不能把它当作正式整条用户权限旅程；Gateway 新专项另用了真实动作服务和数据库，权限决策为测试批准。

## 已知限制和接续顺序

1. SDK requestStream 的轮询 sleep 本身不可被 signal 提前清除。适配器现已按时停止等待、调用 iterator.return 并观察其 rejection，signal 阻止睡醒后的新协议请求，但不能回收 SDK 私有定时器；休眠中的 SDK closure 可能暂留。下一步仍须在原任务适配 seam 解决资源生命周期，不能称已做到所有 SDK 资源即时释放。
2. 远端任务取消是协作式的：停止等待/发送通知不证明远端 CPU 或副作用已终止，不得默认再次执行。后置 hook、绑定/结算写入窗口以及真实进程强杀的完整组合还需故障验证。
3. 原 Windows/Bun 本地加载、只读/跨目录/非系统卷依赖的失败继续修复，不自动换 Node、放宽沙箱或跳过用例。
4. 跨服务器/目录种类的累计保留量、排队与聚合总期限、通知队列上限、SDK 解码前大小限制、SDK 元数据缓存与公布目录的一致性、所有目录入口原控制授权继续开放。
5. OAuth token exchange/第三方关闭、其他配置 writer/交互入口以及活跃 PersonalJob 的原预算、当前授权、部分计费和自身 SIGKILL 冷恢复继续；外部 Provider、旧数据迁移、Python 退役和完整用户验收等原计划要求不缩减。

安全自检：未修改用户 profile/凭据/业务数据库、全局 CLI/PATH、Bun 版本或系统沙箱策略；未创建第二套 owner、子代理、提交或推送，保留既有工作树。
