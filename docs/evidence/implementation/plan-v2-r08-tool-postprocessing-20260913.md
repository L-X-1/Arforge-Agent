# R08 / R13：普通外部工具后处理融入原 Core 管线（2026-09-13）

## 状态与边界

这是 v2 计划的继续开发记录，不是 R08、R13 或全计划的完成声明。外部 Tool.Def 经 adaptExternalTool 进入 Core 的插件、MCP、CodeMode 路径，现已分开保存真实执行结果与插件展示结果；仍由同一 ToolRegistry / ToolPipeline / ActionGateway / Action 事件流负责，没有第二执行器、结果表、权限服务或恢复循环。

旧会话内置工具、计划任务后处理以及大结果持久化衔接尚未完成。默认 Windows/Bun MCP 全目录本轮实跑仍为 **201 pass / 17 fail / 993 断言，218 项，143.46 秒，exit 1**（终态回执 47c159）。17 项仍在 lifecycle 与 local-approval，不能用专项全绿替代默认路径。保留原 Bun 1.3.14，不切换 Node、不自动扩大目录权限、不改为 partial；R31 仍仅在 R30 后执行，不涉及发布。

## 需求与真实变化

| 需求 / 原问题 | 唯一实现位置 | 本批结果 |
| --- | --- | --- |
| R08：普通 executeMature 内的 after hook 能覆盖原始成功输出，hook 抛错把动作写成 blocked | packages/arforge/src/tool/core-bridge.ts：adaptExternalTool / postprocessMature | 先保存原始输出；标题、正文、metadata 的合法变换进入同一管线 post 阶段 |
| R07/R17：重启后不能把已执行动作再做一遍，也不能用原始结果冒充已完成展示 | packages/core/src/action-gateway.ts：afterSuccessMode / execute | projection 在原 Action 内先写 started，再写 completed / failed / interrupted；只回放已确认的最终值 |
| R28：记录需要绑定同一动作与 Observation，并防止篡改或非法顺序 | packages/core/src/runtime/durable-action.ts：load | 检查 subject、原成功 Observation ID、冻结资源标记、start/terminal 顺序、时间、JSON 摘要和字节数；不复活已终止的执行租约 |
| R08：统一管线不能在恢复时再次执行 hook | packages/core/src/tool/pipeline.ts；tool.ts；registry.ts | Core opaque tool 可声明 postprocess；Gateway 内进入原 post continuation；单次、作用域有效期及原 invariant 共同约束；normalize/finalize/settle 仍由原 owner 负责 |
| R26：当前共享事件、SDK、OpenAPI 一致 | packages/schema/src/agent-runtime.ts；原 manifests；原 SDK 生成脚本 | 一个规范 ActionPostProcessingRecorded 定义，原 Action 聚合版本化事件，不新增数据库表；共享可选字段采用 optional，生成产物已更新 |

后处理上下文只提供 session/message/call/agent 身份，不授予执行 capability。原结果和参数给副本；标题/正文/metadata 可改变，原内联附件与省略诊断保持，不能从被过滤的附件恢复远程 URL。后处理非业务写入授权接口，额外副作用仍须经其既有授权操作。

默认 notification 模式保留上一批独立 MCP 子调用语义：通知至多一次，恢复不补发。projection 模式只对外部工具桥接启用，不向用户暴露另一套运行时选择。其资源标记参加原 canonical intent，移除 mode 后用旧调用重放不能绕过原 intent 检查。旧未绑定该标记的历史不能自动重解释成新的展示合同。

## 复现与调试记录

1. 前置普通桥接回归在暴露正确 DurableAction 测试服务后真实复现两项失败（d6a7e4）：原 Observation 已被插件展示覆盖；hook 抛错导致 action blocked。最初 a3aa50 是测试缺服务，不作为产品缺陷证据。
2. 初版尝试用原已结算租约追加后处理，正确地被原 capability 校验拒绝（9d45f6）。没有放宽租约规则；现以同一 Observation、当前事件 sequence 和六次有界 CAS 追加原 Action 元数据，不重新获得执行权限。
3. 本批 Gateway 新测试复现两个真实审计错误（076841）：恢复的展示值正确，但 audit outputDigest / byteLength 指向原始输出。现指向实际重放结果。该批另外两项是测试误用不存在的 actions.find，已改为检查原 load 的 NotFoundError，不计产品修复。
4. 单次管线 continuation 测试（dc61fc）发现晚到回调直到修改 trace 后才由 invariant 拒绝，现只允许在 execute 的有效作用域内调用，作用域关闭后立即拒绝；重复调用也不能再次运行 post。
5. 时间倒退夹具起初把时间改为 TestClock 原值 0，不是真实倒退（b79707）；已改为原 recordedAt 减 1。终态记录摘要、Observation、状态/输出配对、时间倒退均真实拒绝。
6. 扩大类型检查发现新增附件断言数组把 text 字面量扩成 string（5226d1，21/22）；修正测试类型，不降低类型门禁。最终结果以本文件后面的新鲜回执为准。

## 已执行场景与不重复计数

- Gateway：普通字符串与 null 的展示重放；原始结果不变；正确审计身份；typed failure、defect、同步 throw、interrupt；非法及 UTF-8 超大展示；缺 codec/processor 时零 proposal/执行；并发重放不重跑；取消等待 hook 清理；记录损坏拒绝；撤掉处理模式不能绕过冻结意图。
- Pipeline：fresh、replay、duplicate、late；原阶段顺序及 runtime invariant 回归保持。
- Native bridge：合法标题/正文/metadata 变换与后处理失败；四组正文空/非空转换，保留内联图片和非内联附件省略说明；原请求重放结果不变。
- 原生真实进程：父进程等待 fixture 在真实 Core ToolRegistry 调用中写好 Observation/后处理状态并发 IPC 信号后，才 SIGKILL 指定子进程；第二个新进程读取同一临时 SQLite，再 materialize/settle 相同调用。
  - started：返回“has no confirmed result”，原成功保留，执行和 hook 都为 0，不伪造 completed。
  - completed：返回和首次相同的展示结果，原成功仍是原始文本；执行和 hook 都为 0；action ID、事件 sequence 保持。
  - 两项独立首次结果为 2 pass / 25 断言（0e9060），后被纳入五文件回归，不叠加计数。它们验证 Windows 下真实新进程的原生外部工具路径，不代表 MCP 远端 exactly-once 或所有 OS sandbox 认证。

## 测试命令与回执

以下命令均从对应包目录运行，使用默认 Bun 1.3.14；Core 显式 --rerun-every，未只跑失败缓存。命令涵盖整个所列文件，而非只筛选新增用例。

```powershell
# packages/core
bun test --rerun-every --timeout 60000 test/action-gateway.test.ts test/tool-pipeline.test.ts test/durable-action.test.ts test/durable-event-manifest.test.ts
bun test --rerun-every --timeout 60000 test/session-runner.test.ts test/session-runner-tool-registry.test.ts

# packages/arforge
bun test --timeout 60000 test/tool/core-bridge.test.ts test/tool/core-bridge-cold-postprocessing.test.ts test/mcp/gateway-adapter.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts
bun test --timeout 60000 test/mcp

# packages/sdk/js
bun test --timeout 60000 test/generate-script-contract.test.ts test/mcp-read-paths-contract.test.ts test/mcp-oauth-contract.test.ts

# 仓库根
bun run script/generate.ts
bun run typecheck --force
```

- Core 四完整文件：176 pass / 0 fail / 954 断言（72c452）；最终留存回执见下方。
- Core 主运行器/注册器两完整文件：238 pass / 0 fail / 1650 断言，184.11 秒，exit 0（71c6aa）。与前一组存在概念覆盖，不当作能力完成率分母。
- Native 五完整文件：101 pass / 0 fail / 487 断言（5d1664）；最终留存回执见下方。
- 默认 MCP：201 pass / 17 fail，143.46 秒，exit 1（47c159），失败未移除、未跳过。
- SDK 三合同文件：3 pass / 0 fail / 6 断言，exit 0（027447）。原完整生成脚本 exit 0（1a8e97），有既有生成器 API 弃用提示，不伪称零警告；新事件同时出现在版本化和当前事件合同。
- 13 个改动 TS 文件 oxlint：178 warnings / 0 errors，exit 0（717dd3）；含新旧类型断言等告警，不称告警全部历史或已清零。
- scoped prettier 已执行（c9bb82）。最终强制类型、格式与 diff、源码新鲜度结果在完成实际检查后追加；不沿用先前失败后的旧成功声明。

## 最终新鲜回执

最后一次完整输出已从实际测试进程逐段保留，进程全部真实退出，未用旧报告覆盖新结果：

- [Core 四文件原始输出](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-postprocessing-core-20260913.txt)：176 pass / 0 fail / 954 断言，14.45 秒，exit 0。
- [原生桥接、真实强杀恢复与 MCP/CodeMode 五文件原始输出](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-postprocessing-native-20260913.txt)：101 pass / 0 fail / 487 断言，23.07 秒，exit 0。
- [强制 workspace 类型原始输出](E:/Arforge-Agent/docs/evidence/implementation/plan-v2-r08-postprocessing-types-20260913.txt)：22/22，0 cached，48.712 秒，exit 0。已覆盖 SDK 重新生成与附件断言类型修正，不沿用失败前的类型记录。
- 第一次最终格式检查指出新增断言的缩进差异，已单文件格式化后重新独立执行 13 文件检查；不能以同一 shell 后面的 git diff 返回 0 冒充前面的 prettier 成功。git diff --check 无 whitespace error，但既有多文件换行转换警告保留。

以上没有把重复运行累计为更多能力通过，未执行真实模型付费调用或整个工程全部测试。

## 未完成的必需后续（不缩小原计划）

1. 将 makeLegacySessionTools 与计划任务执行/投影的 after hook 融入同一 Core post 阶段，同时保留 Task projection.complete / failed 的正式语义，不能把两条路径永久并列。
2. 当前原始结果与展示结果都要满足既有 1 MiB JSON 持久化上限。原始结果无法持久化时保留实际动作成功，但拒绝运行后处理；超限展示记录 failed。必须接原 ToolOutputStore / Artifact 以恢复大输出能力，不能把“返回一个可读错误”当作原大结果功能已交付。
3. 补原成功落盘到 started 之间、完成回执写入失败、晚到异步回调及其余真实崩溃窗口；不把两处 SIGKILL 扩展为任意时点均安全。未知结果不得擅自补跑 hook 或工具。
4. 本地默认 MCP 启动 17 个失败、跨服务器保留量/排队总时限/解码前限制、目录授权、OAuth 和关闭；原任务预算/当前授权/部分计费与 PersonalJob 自身冷恢复，继续依 v2 原依赖顺序。
5. 外部 Provider、Python 能力/数据/测试语义融合、Python 产品代码物理退役、用户实际体验、R28/R30 完整验收均保留，R31 最后。

## 数据与安全

没有修改用户真实数据库/profile、模型凭据、CLI/PATH、系统 Bun 或 OS 权限。强杀仅针对带就绪信号的测试子进程，临时数据由原 fixture 清理；SDK 构建仅重建已确认在 packages/sdk/js 内的生成目录与 dist，可由原生成脚本再生成。未提交、暂存、回退工作树或删除用户源代码。

源码和配置绑定继续使用原 composition / runner-negative / dependency ledger 与 source snapshot，不新增产品台账服务。最后应先生成前三类证据，再生成 source snapshot 并运行 migration-freshness；其 valid 只证明绑定新鲜度，不是全计划验收。
