# R13 用户附加 MCP Resource → Core ToolRegistry/ActionGateway 证据

日期：2026-09-14

## 目的

关闭 R13 中“用户附加的 MCP resource 仍可在 SessionPrompt 里直接调用 `MCP.readResource`”这一真实入口缺口。此次切片只把该入口接到现有 Core `ToolRegistry.materialize().settle()` 和 `McpGatewayAdapter`；没有增加执行器、权限数据库、MCP client 或恢复 owner。

## 实现

- `SessionPrompt.createUserMessage` 对 `source.type === "resource"` 先读取当前 generation-scoped `MCP.capabilities()`。
- 只有 server 与 URI 和当前 capability 精确匹配时才构造 `McpResourceProjection.makeResource`；缺少能力或 capability registry 时 fail-closed，并且不会调用 `MCP.readResource`。
- 通过既有 `ToolCoreBridge.adaptExternalTool` 创建短生命周期的 `mcp_attachment_read` Core tool，再经同一 `ToolRegistry.materialize().settle()` 执行。
- MCP resource 的实际协议读取继续由 `McpResourceProjection` → `McpGatewayAdapter.mcpRequestViaGateway` 完成，因此仍经过 generation、declared scope、PermissionV2、ActionGateway、结果投影与原有上下文防火墙。
- `ToolRegistry.materialize` 保持 `includeRegistered` 的 step-limit 语义；用户资源读取不再以 `includeRegistered:false` 丢掉显式 external snapshot。

## 验证

命令（工作目录 `packages/arforge`）：

```text
bun test test/session/prompt.test.ts --test-name-pattern "user-attached MCP resources" --timeout 30000
```

结果：2 pass / 0 fail / 13 assertions。覆盖：

1. 当前 capability 存在时，外层 transient Core tool 与嵌套 MCP child action 均通过现有 PermissionV2/ActionGateway；测试批准两个精确请求后实际 `readResource` 调用恰好 1 次，文本经 `ContextFirewall` 投影并写入 durable `SessionInput`。
2. capability 不存在时，用户仍得到有界错误文本，实际 `readResource` 调用为 0。

附加检查：

- `bun x oxlint --disable-nested-config src/session/prompt.ts test/session/prompt.test.ts --quiet`：0 errors；6 warnings 均为既有 `prompt.ts`/测试辅助代码告警。
- `git diff --check -- packages/arforge/src/session/prompt.ts packages/arforge/test/session/prompt.test.ts`：通过。
- `packages/arforge` `bun run typecheck`：仍被既有 `packages/tui` JSX/BaseRenderable 诊断阻断；本切片未引入 `prompt.ts` 新类型错误。
- 账本重算：TS composition 1763 source files / 3 roots / 5 bindings；Python capability 480 files / 5080 leaves、tests 365 / 3394、dependencies 7309 / 7500 / 6；source snapshot 7599 inputs；`audit:migration-freshness` `valid=true`。

## 未关闭范围

这不是 R13 全部验收。MCP CLI/API 目录读取是否都需要控制动作、prompt 命令模板的延迟读取、rich Artifact、四类本地 HTTP/stdio 生命周期、断连/重连/代际冷恢复及默认 MCP 全量回归仍开放。真实 Linux/macOS/Windows full sandbox 仍按计划在 R30 后执行。
