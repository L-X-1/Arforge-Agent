# R05 自动标题正式入口复验（2026-09-15）

## 结论

自动标题在当前 TS/Core 正式会话路径中已经接通并可复验：首轮用户消息完成后，由 `SessionRunner.scheduleTitle` 创建 durable `session-title` BackgroundJob，沿既有 ActionGateway/RequestEnvelope/TitleGeneration 管线发送无工具标题请求；确认结果写入原 Action 事件流并通过 `SessionEvent.TitleGenerated` 投影到会话标题。恢复路径只重放已结算且身份、期望默认标题和当前会话状态均匹配的结果，不重跑 Provider。

本证据只验收普通（无主运行费用预留）标题路径。严格计费主运行仍在 `scheduleTitle(sessionID, billing)` 中因尚无独立、持久化的维护预算而保持 fail-closed；这不是把主运行预算静默透支的理由，因此 R05 总项继续开放。

## 本次核对范围

- 默认标题只在根会话、首轮用户/助手内容存在且用户未改名时替换；用户定义标题、子会话标题和取消/改名竞态保持不变。
- 标题模型选择覆盖显式模型、`small_model` 迁移、共享 automatic resolver 和 disabled 配置。
- 生成请求使用稳定身份 `{sessionID, assistantMessageID, toolCallID: "session.title"}`，写入已提交 `RequestEnvelope` 后才允许传输；凭据版本、请求 digest、usage 和 finish reason 由既有合同校验。
- 空输出、缺失 usage、超时/provider 错误、未完成 reasoning block、取消、持久化发布失败以及已改名会 fail-closed 或保留原标题。
- 文本附件和图片附件的首轮标题输入、idle wake/fresh-process projection、rename/rename-back replay 均走同一持久事实，不创建第二执行器或第二标题表。

## 验收证据

| 范围           | 命令/结果                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认标题冒烟   | `D:\\bun\\bin\\bun.exe test --timeout 60000 test/session/prompt.test.ts -t "Formal first user turn generates a title for a default-title session" --rerun-every`：**1 pass / 0 fail / 18 assertions，exit 0**                                 |
| 标题专项回归   | `D:\\bun\\bin\\bun.exe test --timeout 60000 test/session/prompt.test.ts -t "title" --rerun-every`：**28 pass / 0 fail / 258 assertions，exit 0**                                                                                              |
| 覆盖的标题场景 | credential version fence（unchanged/replace/remove）、user-defined/default title、idle wake 与 fresh-process projection、四种 title config、empty/missing usage、publish/row drift、rename/cancel、subtask-only parent、text/image attachment |
| 代码入口       | `packages/core/src/session/runner/llm.ts` 的 `scheduleTitle`/`restoreTitle`；`packages/core/src/session/title-generation.ts`；`packages/core/src/session/title.ts`                                                                            |
| 质量门禁       | 本次仅核对既有实现；不宣称包级 arforge typecheck 已清零（仍受既有 `packages/tui` JSX/BaseRenderable 诊断影响），未改用户数据                                                                                                                  |

## 未关闭项

1. 为严格计费运行设计并实现持久化的维护预算/授权/结算（含取消、耗尽、价格变化、跨进程恢复），再把标题任务接入；不得直接消费主运行预算。
2. 完成 R05 其余唯一 Core Loop/旧 processor 与兼容适配器的真实入口、子任务退出条件、跨进程恢复和不同用户旅程验收。
3. 补真实外部 Provider/凭据矩阵及完整 CLI/Desktop 旅程；full OS sandbox 仍按 R30 后执行。
