# R13：MCP 真实结果与后置通知分离（2026-09-13）

## 结论与验收边界

已复现并修复 MCP 子调用适配路径中后置 hook 改写真实结果、hook 出错或取消导致已成功动作被记录为失败的问题。使用原 ActionGateway 的成功 Observation/settlement 后通知阶段，不添加第二执行器、结果表或恢复循环。

默认 Windows/Bun MCP 全目录仍为 **201 pass / 17 fail / 993 断言，218 项，150.12 秒，exit 1**。17 个本地启动/生命周期旧失败保留，不换运行时、不放宽权限或改为 partial 后端。R13、R08、R07、R17、R30 均不关闭，三平台 full sandbox 仍仅在 R30 后执行，无发布。

## 本轮复现

原 mcpRequestViaGateway 的 execute 把插件 tool.execute.after 放在 input.decode 和 Gateway 观察提交之前：

- 真实 SDK Client/Server/InMemoryTransport 返回正常结果，插件修改后落库变成 forged plugin result。
- 插件 Effect defect 或同步抛错，把已返回结果的动作写成 blocked/failed。
- hook 中 fiber 取消会污染成功记录；单独 AbortSignal 取消不能结束挂起 hook。

新增 5 项先得到 **0 pass / 5 fail / 8 断言**（2b0d88）。前三项使用真实 SDK；两个取消用例使用原 Gateway/数据库与计数传输夹具，不冒称真实远端取消。旧版对于同一 invocation 原本也会拒绝 blocked 重放；本轮证明的是修复真实结果丢失和错误分类，并保持防重放，不虚称旧版已经实测发生二次远端写入。

## 融合实现

| 既有 owner | 本轮变化 |
|---|---|
| Core ActionGateway.Operation | 增加可选 afterSuccess 通知；只在原成功 Observation 和 settled 提交后运行，传入 structuredClone 副本；不持有已撤销的原执行 capability |
| 原 Gateway 成功分支 | 通知保持可取消，typed failure/defect/同步抛错转成具名 PostProcessingError；pure interruption 保留；不改写成功 Observation、不重新结算费用、不进入执行失败分类 |
| 原 RuntimeInsight | 记录内容无关的 action.postprocessing.failed；不把 hook 原始错误、结果、参数或秘密写进该诊断 |
| 原 Gateway 恢复分支 | 不改动恢复器；settled 回放只读原输出，不再次运行 executor/afterSuccess |
| MCP mcpRequestViaGateway | 先 decode 实际结果，后置通知融合到上述阶段；参数也给副本；连接原 AbortSignal，明确 join hook fiber 清理 |
| Core ToolRegistry/Runner、原 WorktreeControlWorker | 传播或展示具名后处理错误，不隐去“实际动作已完成”的语义；没有另建用户错误状态库 |
| CodeMode 两个原测试夹具 | 补原 Gateway 的 afterSuccess 顺序合同；它们不验证数据库耐久，耐久由真实 Gateway 专项承担 |

第一次实现仅 race hook 与 AbortSignal，fiber 取消测试又发现清理尚未 join（68a96a）；已改为显式等待原 hook fiber 中断清理，最终 **5 pass / 54 断言**（7deda0）。没有通过增加睡眠或删除清理断言让测试变绿。

此通知是 **至多一次，而非恰好一次**。崩溃可发生在成功提交后、通知开始前或通知内部；恢复不会盲目补发通知。必须保证执行的领域写操作仍应归入既有、明确授权且可恢复的领域 owner，不能依赖通知冒充耐久操作。

## 真实强杀与用户结果

沿原 mcp-reconciliation-worker/cold-reconciliation.test 新增 seed-hook-kill/read-hook：

1. 种子进程通过真实 SDK 工具调用返回 committed remote result。
2. 后置 hook 读取原动作，确认 settled/succeeded、无 activeAttempt，并把真实 observation 输出与原 sequence 保存到隔离测试 marker。
3. hook 通过 IPC 发布已进入通知的就绪信号，然后停留在 Effect.never；父进程收到信号才 SIGKILL，校验 killRequested、child.killed 和非零退出。
4. 新进程读取同一隔离 SQLite，并实际调用原 mcpCallViaGateway 的同 invocation；结果与原输出一致，事件 sequence 不变，transportCalls=0、hookCalls=0。

独立运行 **1 pass / 7 断言 / 6.68 秒**（11d9c0）；也包含在下方扩大回归和默认全目录中，不重复计进度。此为 Windows 强制终止，不是优雅关闭或单进程重新实例化；仅验证成功提交后的 hook 窗口，未覆盖绑定和 Observation 写入前/中的所有故障点。

普通用户遇到 PostProcessingError 时，错误文本明确表示动作已完成且成功已记录，应查看原结果，不另建重复付款/发布/写入操作。USER_GUIDE 已同步。尚未证明所有 CLI/Desktop 完整交互旅程。

## 测试记录

| 实际命令/范围 | 结果 |
|---|---|
| core: bun test --rerun-every --timeout 15000 --test-name-pattern 'post-success notification' test/action-gateway.test.ts | **6 pass / 64 断言，exit 0**（716a71）；正常/typed failure/defect/同步 throw/interrupt，另含拒绝及执行失败不通知 |
| core: bun test --rerun-every --timeout 60000 test/action-gateway.test.ts test/tool-pipeline.test.ts | **124 pass / 0 fail / 679 断言，7.98 秒，exit 0**（e5f00b） |
| core: bun test --rerun-every --timeout 60000 test/session-runner.test.ts test/session-runner-tool-registry.test.ts | **238 pass / 0 fail / 1650 断言，159.94 秒，exit 0**（d41ba9） |
| arforge: bun test --timeout 60000 test/mcp/sdk-task-cancellation.test.ts test/mcp/catalog.test.ts test/mcp/gateway-adapter.test.ts test/mcp/reconciliation.test.ts test/mcp/cold-reconciliation.test.ts test/mcp/session-recovery.test.ts test/mcp/oauth-provider.test.ts test/mcp/tool-projection.test.ts test/mcp/resource-projection.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/core-bridge.test.ts | **152 pass / 0 fail / 663 断言，24.45 秒，exit 0**（2d69cd） |
| arforge: bun test --timeout 60000 test/control-operation/worktree-worker.test.ts | **15 pass / 0 fail / 84 断言，2.88 秒，exit 0**（87c14e） |
| arforge: bun test --timeout 60000 test/mcp | **201 pass / 17 fail / 993 断言，218 项，150.12 秒，exit 1**（abf719） |
| root: bun turbo typecheck --concurrency=2 --force | **22/22，0 cached，55.09 秒，exit 0**（1d6d98） |
| 本轮 11 个 TS 文件 Oxlint | **177 warnings / 0 errors，exit 0**（519a40）；没有宣称告警清零，也未把所有告警一概归为历史 |
| 11 个 TS 文件 Prettier；受影响文件 git diff --check | **exit 0**（eda8c7）；格式化记录 9049ae |

所有上述测试进程均已真实退出。上述各组有重叠，不累计为验收完成数或百分比。

## 来源绑定

运行环境为本机 Windows、项目默认 Bun 1.3.14（0d9b296a），未改变 SDK 1.29.0 原固定补丁。生成器沿原工具更新，没有新建证据 owner：

- TS composition：1757 source files / 3 roots / 5 bindings / 3 runner uses；8f67db56ad74de5713419bf12b472bcdf1c1618d7260bab29b464ab191a0ead2（a7a067）。
- Runner negative：25663ffe58cf2dad37081145adbb472fb25a231197a90b19c2fd49172a31dc09（85e2ca）。
- 依赖台账：7291 files / 7492 leaves / 6 assets；65cb8a70e450da44e92d38e094a3a504fc2e94e8ebc8275c71a1e39bd619be10（67193f）。指南最终修改后重新生成，避免沿用旧指南摘要。

首次 freshness 校验正确发现本轮 USER_GUIDE 修改晚于依赖台账，返回 PY007-006（cb15f7）；已在指南定稿后重生成原依赖台账，再按最终文档生成源输入快照并校验。静态新鲜度不是完整功能验收，R01 的 4 条行为关联仍缺完整 receipt，不因此关闭。package.json、bun.lock、原 SDK 补丁摘要与上批一致（c63184），本轮没有更改依赖或安装环境。

## 继续项

1. 原生 MCP Tool.Def 设置 emitHooks=false，其普通工具桥接外层 tool.execute.after 仍在 executeMature 内；现已确认原始 MCP child 结果不会被它改写，但父工具后处理的成功/错误记录仍须沿唯一 ToolPipeline/Core owner 融合。保留普通插件结果变换需求，不直接以通知副本替代所有合法的展示变换合同。
2. taskCreated 引用绑定中、结果返回后但 Observation/settlement 提交前后的其余故障窗口；成功但无法保留的大结果恢复；不把缺记录当失败允许重发。
3. 跨服务器累计目录保留量、排队/聚合期限、通知上限、解码前大小、元数据缓存/目录发布一致性、控制授权和 OAuth/第三方关闭仍开放。
4. 默认 Windows/Bun 17 失败保留；随后回到活跃 PersonalJob 的原预算、当前授权、部分计费与自身强杀恢复。
5. 外部子代理 Provider、数据迁移、旧 Python 退役、完整用户旅程、运行时 invariant 和 v2 其他退出条件不缩减。R31 仅在 R30 后开展。

安全自检：测试只强杀自建隔离 worker，未修改真实用户数据/凭据、全局 CLI/PATH、系统权限或沙箱策略；未调用子代理，未提交或发布。
