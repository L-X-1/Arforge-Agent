# R08 / R09 / R13：大结果接回原 Artifact 与确定性回放（2026-09-13）

## 结论与范围

本批接续普通外部工具后处理，已消除原始结果、展示结果分别受 1 MiB 内联记录限制而不可恢复的问题；没有另建工具执行器、结果库、归属服务或截断管线。复用 AgentRuntime.ActionOutput、原 Action 事件流、DurableAction、ActionGateway 和 ToolOutputStore。

这不是 R08/R09/R13 或全计划完成声明。默认 Windows/Bun MCP 最新完整运行仍为 **201 pass / 17 fail / 993 断言，218 项、20 文件、158.89 秒，exit 1**；失败仍集中在 lifecycle（2）与 local-approval（15）。没有切换系统运行时、扩大目录授权或降级默认沙箱。R31 必须在 R30 后执行，不包含发布。

## 已实现与验证的行为

1. **精确结果存储**：ActionOutput 为一个共享 json/artifact 合同。按完整序列化 UTF-8 JSON 字节计量，≤1 MiB 保留原内联结构；较大结果通过原 ToolOutputStore.bindBytes 保存，沿用既有 50 MiB 单件上限。此上限不是正文字符数；工具结构可能把正文投影到多个字段。摘要、字节数、kind、mime、owner 和回执绑定到原 Action。未改数据库表或创建第二套事件定义。
2. **恢复校验**：DurableAction 校验事件中 opaque receipt 的身份、内容摘要和字节数；Gateway 通过原 read 校验索引、内容与归属后解析精确结果。缺失、篡改时返回内容无关的 RecoveryRequiredError，不暴露内部存储路径、不重新执行动作或 hook，也不把真实原始成功改成失败。
3. **控制面归属**：普通工具沿用 session owner；无 session 的控制面动作以冻结的完整 subject 摘要形成内部 profile owner。真实 L3 授权→大结果保存→同调用恢复已测，外来 owner 被拒绝，不另建授权事实源。
4. **展示仍统一限额**：原 ToolRegistry.normalize 继续调用唯一 ToolOutputStore.bound。精确持久化上限不代替 tool_output 的模型展示限制。真实原生桥接、新进程恢复在 max_bytes=512 的配置下保留同一完整展示结果和同一附件回执。
5. **同一调用的回执复用**：在原 bound 内，以 owner/session/call/内容摘要形成存储私有的确定性 handle，使用既有 Flock 和 catalog 串行检查。有效回执直接校验后复用，不追加注册、不延长保留期限。其他调用或 owner 不共享回执；普通 bindBytes 导入仍为独立不可变收据。
6. **旧 catalog 兼容**：修复原 catalog 按内容 artifactID 键控导致相同内容不同收据冲突的问题；新 schemaVersion=2 使用原 opaque handle 为内部键。v1 文件只读不会自动重写；下一次真实追加保留原条目和审计前缀后升级。公共内容 artifactID 与既有审计哈希结构不变。
7. **损坏与清理**：同一 bound 回放时，文件被改写、索引消失或过期均拒绝，不悄悄生成替代附件。相同内容的过期收据清理不删除另一份有效收据，重复清理不重复写 removed 审计。四个真实 OS 进程并发处理同一调用只注册一次；不同调用各自注册。

## 真实新进程验收

父进程等待原生 Core ToolRegistry fixture 写好原 Action 和 IPC 就绪信号，才强杀该测试子进程；随后第二个新进程使用同一临时 SQLite 和 profile 恢复同一调用。测试不依赖固定休眠猜测写入完成。

覆盖 started/completed 两阶段 × small/original/display/both 四组结果大小，共 8 个案例。大正文含多字节中文，400000 字符，确保超过 1 MiB UTF-8，而不是仅覆盖 ASCII 字符长度。

- started：原始成功保持，显示后处理尚未确认，恢复 executor/hook 都为 0。
- completed：逐项比较精确原值、展示值和完整 settlement；包含附件回执与兼容路径，而不是只比较截断正文。恢复 executor/hook 都为 0，Action sequence 和 catalog sequence 不变。
- 这些是 Windows 上真实工具入口的指定强杀点，不是任意时点故障证明，也不是三平台 full sandbox 认证。

## 复现与修复轨迹

- 上批新增大结果初次回归 0/3、相同内容收据 0/2 的失败促成精确持久化和 catalog 融合；中间 Effect.try 调用形式、变量作用域错误属于实现调试，不虚构为更多产品缺陷。
- 本批原生大展示恢复真正复现 catalog sequence 从 2 增到 3（b9bf00）；进一步的 4 个 bound 用例全部失败（ac69c5），定位为重复生成附件，以及损坏后以新附件掩盖问题。修复后 4/4（bf1f27），原生真实恢复通过（2f9999、配置验证 8b3d1d）。最初 fixture 缺少导出测试用 Store 服务（5a0030）不是产品缺陷。
- 大结果故障用例最初把 Effect Exit 的字符串误当错误 reason；修正测试为读取实际 RecoveryRequiredError，而非放宽产品检查。最终原始/展示两组文件和事件损坏 + 控制面 + 合同共 12 项通过（b78b7c）。
- 完整类型检查发现新增测试对数组尾元素缺少 undefined 收窄；修正测试断言后重新强制全包检查，不沿用失败之前的结果。
- SDK 首次完整生成因 Windows 写 tsconfig.tsbuildinfo 返回 UNKNOWN 而失败（27c054）。确认原进程已退出且文件不是只读、无运行中的编译器后，重新运行同一完整生成脚本通过（8adcec），未更换运行时或忽略退出码。生成器 API 弃用提示仍保留。
- 一次格式命令在包目录误用仓库相对路径而失败（54524d），之后在根目录正确执行并独立检查通过（c1ffa7）；不以后续测试 exit 0 冒充格式检查成功。

## 最终验证与原始输出

默认 Bun 1.3.14 (0d9b296a)，Core 明确使用 --rerun-every；下列是所列完整文件，不把重跑和重叠覆盖累计成能力百分比。

| 范围 | 结果 | 原始输出 |
| --- | --- | --- |
| Core Gateway/Store/DurableAction/manifest/Pipeline 五文件 | 219 pass，0 fail，1187 断言，19.85 秒 | [Core](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-large-results-core-20260913.txt) |
| 原生桥接/真实强杀/MCP adapter/CodeMode 五文件 | 107 pass，0 fail，584 断言，58.58 秒 | [Native](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-large-results-native-20260913.txt) |
| 主运行器/注册器两完整文件 | 238 pass，0 fail，1650 断言，177.27 秒 | [Runner](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-large-results-runner-20260913.txt) |
| HTTP Artifact 四文件 | 8 pass，0 fail，66 断言，10.55 秒 | [Server](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-large-results-server-20260913.txt) |
| 强制 workspace 类型 | 22/22，0 cached，61.425 秒 | [Types](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-large-results-types-20260913.txt) |
| SDK 三合同文件 | 3 pass，0 fail，6 断言，exit 0 | 回执 10eaaf |
| 默认 MCP 全目录 | 201 pass，17 fail，993 断言，exit 1 | 本批进程 58975，失败未跳过 |
| 10 个改动 TS 文件格式 / lint | 格式通过；115 warnings，0 errors | c1ffa7 / 823461；告警未清零 |

主要复验命令：

```powershell
# packages/core
bun test --rerun-every --timeout 60000 test/action-gateway.test.ts test/tool-output-store.test.ts test/durable-action.test.ts test/durable-event-manifest.test.ts test/tool-pipeline.test.ts
bun test --rerun-every --timeout 60000 test/session-runner.test.ts test/session-runner-tool-registry.test.ts
# packages/arforge
bun test --timeout 60000 test/tool/core-bridge.test.ts test/tool/core-bridge-cold-postprocessing.test.ts test/mcp/gateway-adapter.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts
bun test --timeout 60000 test/mcp
# packages/server（整个测试进程使用独立临时 ARFORGE_HOME）
bun test --timeout 90000 src/artifact-route.test.ts src/artifact-owner-context.test.ts src/artifact-auth-route.test.ts src/artifact-openapi.test.ts
# 仓库根；生成时也使用独立临时 ARFORGE_HOME
bun run script/generate.ts
bun run typecheck --force
```

## 测试隔离事件：已恢复，不隐去

上一个未收尾的大结果实现批次中，Core 旧 preload 只隔离数据库，新增 Artifact 写入落到了默认用户资料目录。已停止该批测试、核对并备份，移出且保留本轮产生的 3 份测试 Artifact 及对应 3 个索引；没有删除历史记录或覆盖真实会话数据。catalog 原有 2 条历史条目、前 4 条审计及其状态已恢复；恢复后哈希多次复核不变：

`77dc943d082372e7573f97bf3f688baa8d399db34afd4dab185e84ee50d62ac0`

备份位于 `C:/Users/14181/.local/share/arforge/tool-output/recovery-large-result-test-20260913`，包含恢复前 state.before-recovery.json 和上述 6 个文件，可恢复，未删除。不能声称这段工作从未触及用户 profile。

Core preload 现将整个 profile、测试 home、配置和托管配置隔离到原临时目录 fixture；子进程继承隔离，原生强杀 fixture 另外明确每例独立 profile。修复后的本批测试、SDK 生成和 HTTP 验证没有再次改写用户真实 catalog，最终复核一致。不修改 CLI/PATH、系统 Bun、凭据或 OS 权限；未暂存、提交、回退用户工作树。

## 仍需按原计划继续

1. 旧会话内置工具与计划任务 after hook 继续融入同一 Core post 阶段，保留原 Task projection.complete/failed；不得保留永久双管线。
2. 大结果原字节写入→索引→catalog→Observation/后处理事件之间的中途故障、最终回执提交失败与孤儿产物回收仍需专项验证。当前精确 Action payload 显式 durable、无自动过期；历史删除/退役时的回收和总体占用控制尚未闭合。展示附件仍沿用原保留策略，恢复不续期；不能把本批当作事务式 Artifact 生命周期已全部验收。
3. 旧已保存历史没有新 post 标记或确定性 bound 收据的兼容路径、任意时刻崩溃、配置变更后的完整展示语义，不能由这 8 个案例外推。
4. MCP 17 个默认失败、目录累计保留量/聚合时限/解码前限制、授权与 OAuth/关闭；PersonalJob 原预算、当前授权、部分计费及自身真实冷恢复继续保留。
5. 外部 Provider、Python 能力/数据/测试语义融合、Python 产品代码物理退役、用户体验与 R28/R30 验收均未缩减。R04/R06/R07/R08/R09/R13/R17/R23/R30 不关闭；R31 最后。

文档与源码绑定依旧使用原 composition / runner-negative / dependency ledger 和 source snapshot。freshness 仅证明证据绑定新鲜度，不是功能验收，也不能替代仍缺的 capability 回执。

本批原生成器已重建 composition（acc0dbca3763886631d1155408f3efdb2663ef2d2d9e6642d678b9eb2f8ac6e8）、runner-negative（c9bf46571a048f2aedcc5a3b50fd09749b37c8a6d986e46e691635a13b9c2f36）和 dependency（97fe65f6b4a6082626530465dde9713af7e64830cf4d8a1163287945e026d93a）。文档最后写入后再生成 source snapshot 并实际运行 audit:migration-freshness；最终结果以该命令退出状态及其原报告为准，不把 snapshot 摘要写入它自己的输入形成循环。
