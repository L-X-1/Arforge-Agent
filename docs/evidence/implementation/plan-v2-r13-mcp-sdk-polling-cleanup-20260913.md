# R13：原 SDK 轮询清理与超时后强杀恢复（2026-09-13）

## 结论

已将 MCP 轮询的可取消等待融合到项目已有的 SDK 1.29.0 补丁，客户端 requestStream 与服务端等待更新共用同一私有 helper。Gateway 现在取消后等待原 iterator 清理完成，不再把它留在已拒绝的 deadline race 后面。

新增真实 SDK 超时 → 原 ActionGateway 提交未知结果 → 父进程强杀 → 新进程只读恢复及拒绝重放用例。仅此落盘后的窗口通过，不代表所有崩溃点已覆盖。

完整默认 MCP 回归仍为 **195 pass / 17 fail / 932 断言，212 项，135.24 秒，exit 1**。原 Windows/Bun 本地启动、只读与跨目录相关的 17 个失败保留；R13、R07、R17 和整计划均不关闭。真实三平台 full sandbox 仍在 R30 后执行，不含发布。

## 归属与实现

| 原归属 | 本批融合 |
|---|---|
| patches/@modelcontextprotocol%2Fsdk@1.29.0.patch | 在原 ESM/CJS Protocol 中增加共享 _waitForTaskPoll；不升级 SDK、不创建另一个任务循环 |
| 原 requestStream | 轮询间隔等待改为同一个可取消 helper；收到取消后清掉实际 timer，并退出原 generator |
| 原 _waitForTaskUpdate | 复用同一 helper；正常计时完成也移除 abort listener，防止重复等待不断累计监听器 |
| 同 helper | 调用前已取消不建 timer；拒绝负数、非整数、非有限值和超宿主上限的间隔；保留 0 的既有语义，不让溢出误变高速轮询 |
| packages/arforge/src/mcp/gateway-adapter.ts | 清理时先关闭原 budget，再 await 原 iterator.return；保持上批 unknown 分类、任务引用与同 invocation 防重放 |
| 原 mcp-reconciliation-worker / cold-reconciliation.test | 增加真实 SDK 超时后的父进程强杀和新进程尝试重放；继续使用原数据库、Gateway 与 ReconciliationRegistry |

未改公共配置/API schema，无需重复生成产品 SDK。原 native tool、CodeMode 与 CLI 都继续走现有接线，没有并行的 Python 或 TS 执行 owner。

## 真实失败与测试边界

### 轮询 timer / listener

SDK Client、Server 和 InMemoryTransport 都是真实实现。测试观察原 setTimeout / clearTimeout，仍执行真实宿主时钟，不替换为 fake timer。先观察实际 1500 毫秒轮询 timer 已注册，再取消信号：旧 ESM/CJS 两项均剩 1 个 timer，**0 pass / 2 fail / 8 断言**（96d52b）；最终两项取消后 timer=0、iterator 结束、无后续轮询/取结果，原 client 仍可 listTools。

正常等待各重复 20 次，每次结束后取消监听器数量为 0；非法间隔与预先取消都不创建 timer。测试的服务端等待检查通过明确的私有方法投影隔离计时器合同，不冒称完整服务端 task store 的产品旅程。

ESM 与 CJS 的模块解析已核对：分别实际指向 dist/esm/client/index.js 与 dist/cjs/client/index.js（d64de1），不是给同一个导入起两个名字。验证平台是 Windows/Bun，不是 Linux/macOS/Node 全矩阵。

### 超时落盘后的强杀恢复

种子进程使用真实 SDK tools/call，request=100，服务 handler 进入后等待 5000 毫秒。原 Gateway 超时提交 blocked / 无 Observation / 无 activeAttempt；写入隔离测试 marker 后发 IPC 就绪事件并停留在 Effect.never。

父进程收到此事件才请求 SIGKILL（Windows 强制终止路径），检查 killRequested=true、child.killed=true、非零退出；不是按任意睡眠猜测落盘，也不是优雅关闭。新进程读取同一隔离数据库，恢复为 unknown/manual_review；实际再次调用原 Gateway 的相同 invocation 被 BlockedError 拒绝，transportCalls=0。

初版测试曾假定 Windows Bun 的 signalCode 会等于 SIGKILL，实测为 null；已改成父进程实际发起并确认强杀，不把跨平台信号字段差异当成产品故障。测试 worker 另有 20 秒看门狗，超时也只终止该测试自己创建的进程。

本次覆盖的是“未知结果已提交后”的强杀。没有覆盖远端刚执行、taskCreated 刚返回、任务引用绑定中、后置 hook 或 Observation/结算写入中的全部窗口；不能从这一个成功案例宣称任意崩溃都安全。

## 补丁保存与环境记录

按 [Bun 官方补丁流程](https://bun.sh/docs/pm/cli/patch)先准备了不与全局缓存硬链接的工作副本，再使用 apply_patch 编辑。准备阶段同步了现有脏工作树的 bun.lock；没有用 HEAD 覆盖该用户锁文件，也未修改全局 Bun/PATH 或系统沙箱。

Windows Bun 1.3.14 的 patch --commit 两次以 EPERM 失败，并移除了原 patch 文件。该文件操作前在 Git 中无本地改动，已通过 apply_patch 从已核实版本恢复，SHA-256 与操作前完全相同：390a383d690ca85d8b567fd5a4548368d50eaf9489741c9151f100f7f21e8429。随后只将新差异融入原补丁；逐段比对确认 **原有 32/32 hunks 保留**。

改用原补丁文件加 `bun install --frozen-lockfile --ignore-scripts` 完成实际安装，exit 0（de5236）。冻结安装前后 package.json、bun.lock 摘要未再变化：

- package.json：1da6975dc85e0fced4c7cf20a514994983f84dc5ff82812b717aced5c5d4174d。
- 当前 bun.lock：73e327d67a1bf155be60ebae0f050fc1e95a15f77900e4c3dadeb1636eb8f235；不是继续引用上批锁文件摘要。
- 最终 SDK patch：268c3a0de44a3668bd67c5af0116da351283555bd60c6b3be10a831fddf0c4d3。

补丁保存命令不是 Git commit；本批未作 Git 提交、推送或发布。原补丁没有丢失。

## 最终验证

| 命令 / 范围 | 结果 |
|---|---|
| arforge：bun test --timeout 60000 test/mcp/sdk-task-cancellation.test.ts test/mcp/catalog.test.ts test/mcp/gateway-adapter.test.ts test/mcp/reconciliation.test.ts test/mcp/cold-reconciliation.test.ts test/mcp/session-recovery.test.ts test/mcp/oauth-provider.test.ts | **71 pass / 0 fail / 342 断言，19.98 秒，exit 0**（1f5bc6） |
| arforge：bun test --timeout 60000 test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts | **55 pass / 0 fail / 159 断言，3.39 秒，exit 0**（5580f8） |
| arforge：bun test --timeout 60000 test/mcp | **195 pass / 17 fail / 932 断言，212 项，135.24 秒，exit 1**（a9d617） |
| 根目录：bun turbo typecheck --concurrency=2 --force | **22/22，0 cached，49.433 秒，exit 0**（648feb） |
| 四个 TS 源/测试文件格式检查；受影响文件、补丁、锁文件 diff-check | **exit 0**（b1622b / ce90de） |
| 四个 TS 源/测试文件 Oxlint | **15 warnings / 0 errors，exit 0**（1db9f6）；未称整仓 lint 达标 |

各批重叠，不累计成完成率。新增 fixture 的 timer 类型、Bun IPC 参数泛型和一次插入位置错误均在开发中暴露并修正；以上类型与回归为修正后的结果，不把中间工具/测试错误算作旧产品缺陷。

## 后续

1. 优先补真实返回结果之后的后置 hook、任务绑定及 Observation/结算窗口故障验证，沿原 Gateway 修复，不能把远端已执行写成普通失败后允许重放。
2. 继续跨服务器累计保留量、排队与聚合总期限、通知队列、SDK 解码前上限、SDK 元数据缓存与目录发布一致性，以及所有目录入口原控制授权。
3. 17 个 Windows/Bun 本地加载与生命周期失败、OAuth token exchange/关闭、其他配置/交互入口继续开放；再回到原 PersonalJob 的预算、授权、部分计费和自身强杀恢复。
4. 外部 Provider、数据迁移、Python 退役、完整用户旅程与 v2 其他退出条件保留。R31 只在 R30 后开展。

安全自检：只编辑本任务涉及的源码、测试、原依赖补丁及文档；测试仅强杀自身创建的 worker，未改用户凭据/业务数据库、全局 CLI 或 OS 权限，未另建 owner 或调用子代理。
