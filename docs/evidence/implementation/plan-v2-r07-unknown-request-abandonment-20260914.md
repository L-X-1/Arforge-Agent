# R07 未知请求显式处置与新输入继续（2026-09-14）

## 结论

本批完成了 R07 的一个真实缺口：模型请求已经进入发送阶段、但进程在收到回复前被取消时，系统不再把它当成“肯定未执行”，也不再自动重发。用户可以从现有 `DurableRun` / `SessionCheckpoint` / `EventV2` 事实中核验原请求，在明确承认远端结果和费用未知后，把原运行记录标记为“已放弃等待”；该操作不删除原输入、历史、检查点、预算或账单，也不创建第二个恢复状态源。放弃后可以提交明确的新问题；无新输入的恢复继续仍 fail-closed，保证旧请求不会被重放。

这只关闭“未知发送结果的安全用户处置”切片，不能关闭整个 R07、R08 或整计划。真实外部 Provider、所有工具/压缩故障点、跨 OS sandbox、旧 Python 全域迁移及不同用户完整旅程仍按计划开放。

## 实现与唯一 owner

- `packages/core/src/runtime/durable-run.ts`
  - 新增 `SessionRecoveryItem.request`：`eventID`、SHA-256 `digest`、`outcome: "unknown"` 和 `abandonmentBlocker`。
  - 新增 `DurableRun.abandonSessionRequest`，只接受刚检查的 `sessionID/runID/revision/requestEventID/requestDigest` 与显式 `acknowledgeUnknownOutcome=true`。
  - 在提交事务前后复用同一校验：会话归属、revision、暂停状态、lease、子运行/持久任务/未结算 Action、检查点 dispatch、请求 envelope、run/turn/attempt/schema/digest 身份均须一致；任何漂移均拒绝。
  - 成功路径只调用既有 `publishState`，将原 run 置为 `cancelled` 并记录固定原因 `REQUEST_ABANDONED_REASON`；不执行 Provider、工具、退费或结果猜测。
  - `dispatching` 检查收紧为事件 attempt 与 checkpoint dispatch attempt 精确相等，避免把同一 run 的较早尝试误认作当前未知请求。
- `packages/core/src/session/runner/llm.ts`
  - 原 run 已明确放弃且没有新 queue/steer 输入时，显式 resume 直接以 `RecoveryRequiredError` 失败；有新输入时沿现有 `SessionExecution` 创建新 run，绝不重发旧请求。
- `packages/arforge/src/cli/cmd/session.ts`
  - `session recovery` 继续只读，并在未知请求可处置时打印从检查结果生成的完整命令。
  - 新增 `session abandon-request <sessionID> <runID>`；缺少确认、run/event/digest/revision 错误、过期 revision、lease/子任务/持久任务等均给出可操作中文原因。
  - JSON 输出明确 `outcome: "unknown"`、`requestReplayed: false`、`inputPreserved/historyPreserved/budgetPreserved: true`。
- 测试只扩展既有正式入口和既有进程 fixture；没有新数据库、恢复调度器、第二执行器或 Python fallback。

## 用户可用路径

```text
arforge session recovery <sessionID> --json
arforge session abandon-request <sessionID> <runID> \
  --revision <revision> \
  --request-event <eventID> \
  --request-digest <sha256> \
  --acknowledge-unknown-outcome
```

第一条命令必须先看到 `request.outcome=unknown` 且 `request.abandonmentBlocker=null`。第二条命令只是记录“放弃等待且不重发”，不代表远端已经失败、成功或退款；执行后可直接提交新的明确问题。若 recovery 仍显示有效 lease、child、PersonalJob、未结算 Action 或非 paused，系统会拒绝放弃，用户应先处理原拥有者。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
|---|---|---|
| Core DurableRun 错误边界 | 13 pass / 0 fail / 78 assertions，exit 0 | [core](./plan-v2-r07-unknown-request-abandonment-core-20260914.txt) |
| Formal 同进程完整旅程 | 1 pass / 0 fail / 25 assertions，exit 0 | [formal](./plan-v2-r07-unknown-request-abandonment-formal-20260914.txt) |
| TS CLI + 新进程 | 1 pass / 0 fail / 28 assertions，exit 0；真实隔离 SQLite、HTTP stub、两次进程边界 | [cli](./plan-v2-r07-unknown-request-abandonment-cli-20260914.txt) |
| 受影响 Formal 会话扩大回归 | 195 pass / 6 skip / 0 fail / 2319 assertions，201 tests，exit 0 | [prompt full](./plan-v2-r07-unknown-request-abandonment-prompt-full-20260914.txt) |
| Core typecheck | `tsgo --noEmit` exit 0 | [types](./plan-v2-r07-unknown-request-abandonment-types-20260914.txt) |
| 格式/静态检查 | Prettier exit 0；Oxlint 113 warnings / 0 errors | [lint/format](./plan-v2-r07-unknown-request-abandonment-lint-format-20260914.txt) |
| 拓扑/新鲜度门禁 | SessionExecution owner valid、ToolPipeline fully_canonical、migration freshness valid，均 exit 0 | [audits](./plan-v2-r07-unknown-request-abandonment-audits-20260914.txt)、[freshness](./plan-v2-r07-unknown-request-abandonment-freshness-20260914.txt) |

扩大回归的 6 个 skip 是原有环境条件（v2 projector disabled、配置 shell 与 shell 忽略 TERM 等），不作为通过条件隐藏；arforge 包级 typecheck 仍被 `packages/tui` 的既有 JSX/BaseRenderable 类型错误阻断，新增 Core/CLI/fixture 文件已无诊断。

## 尚未关闭的边界

1. 该批验证了真实 TS CLI/server fixture 的本地 HTTP/SQLite 新进程旅程；没有声称真实外部 Provider、远程非幂等副作用或账单服务能知道未知请求的最终结果。
2. 处于 lease/child/PersonalJob/未结算 Action 的未知请求会被保守阻止；这些 owner 的独立恢复/取消协议仍由 R05/R07/R17/R18 完成。
3. `session recovery` 的未知请求投影目前是 CLI 可见；Desktop/TUI 的同等交互投影与不同用户可理解性属于 R27/R28。
4. R07 其余 admission、工具 dispatch、观察/结算、terminal 前后故障点及所有冷恢复矩阵仍开放；R08/R09/R13/R17 不能因本批通过而关闭。
5. 全平台 Linux/macOS/Windows full sandbox 严格按用户要求留到 R30 后的 R31，当前不执行。

## 计划归属

对应计划 R07 第 2、3、4 项以及 R06 的“发送后未知结果不自动重发”边界。下一批应按第九节最新记录继续 R08/R09/R13 的实际恢复故障窗口，同时保留本批的显式未知结果处置，不恢复自动 replay。
