# Phase 2.9 — Secret、egress 与 Context Firewall 证据

- 日期：2026-08-11
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`
- 范围：V2/Core 与保留 V1 Arforge 的 SecretProvider、HTTP egress、redirect、输出脱敏和指令信任边界
- 结论：第 2.9 步的实现边界已落地。运行时 secret 不再由默认 WebSearch 配置层持有；HTTP 工具在实际发送每一跳请求前重验 origin、method 和 credential scope；web/MCP/memory/document/remote instruction 内容不能声明为 instruction；只有本地 trusted project rules 能声明 `instruction_allowed=true`。

## 已实现的边界

1. `packages/core/src/secret-provider.ts`
   - SecretProvider 增加最小 `resolve(name)` 面。
   - Core WebSearch 默认配置不再从 `process.env` 复制 Exa/Parallel 密钥；实际 executor 在通过 Gateway/leaf permission 后才解析环境 secret。
   - secret scope 只传递环境变量标识符，不传递原值。

2. `packages/core/src/egress.ts` 与 `packages/core/src/tool/authorization-plan.ts`
   - 新增只读 `Egress.Authorizer`，通过同一个 opaque Gateway authorization capability 派生。
   - target 只允许 `http://` / `https://` 且 origin 必须落在声明和父 grant 覆盖范围内。
   - webfetch 只允许 GET，websearch/MCP 只允许 POST；credential scope 必须同时被 semantics 和父 grant 覆盖。
   - FetchHttpClient 默认 `redirect: "manual"`；Core、Arforge V1 webfetch/websearch 和远程 instruction 逐跳解析 Location，并在下一跳发送前重新执行 egress assertion，最多 3 跳。
   - egress 错误中的 URL query 和 redirect source 会脱敏，不能把 Exa query secret 带入 ToolFailure/UI/audit。

3. `packages/core/src/context-firewall.ts`
   - 统一渲染 `<context_fragment ... instruction_allowed="...">`。
   - `web`、`mcp`、`memory`、`document`、`remote_instruction` 默认 `instruction_allowed=false`。
   - 只有 `trusted` 的 `system_rules` / `project_rules` 可声明 `instruction_allowed=true`；API 对其他组合直接抛错。
   - Core project rules、Core ambient instructions、Arforge V1 remote/local instruction、webfetch/websearch 输出均接入该边界。

4. 输出与审计脱敏
   - `ToolOutputStore` 在返回 UI/model 或写 managed artifact 前，对文本和 structured output 执行现有 metadata/credential redaction。
   - `RuntimeInsight.auditRecord` 对 resource、reason、metadata 统一走脱敏路径。
   - provider 返回内容会在离开最内层 executor 前移除实际已解析的 secret 值。

## 验证

- `packages/core`: `bun run typecheck` — passed。
- `packages/arforge`: `bun run typecheck` — passed。
- `packages/server`: `bun run typecheck` — passed。
- `packages/core`: `bun test test/context-firewall-egress.test.ts test/tool-output-store.test.ts` — 15 passed，36 assertions。
- `packages/core`: `bun test test/tool-websearch.test.ts` — 12 passed，24 assertions。
- `packages/core`: `bun test test/instruction-context.test.ts test/system-context/builtins.test.ts` — 12 passed，17 assertions。
- `packages/core`: `bun test test/action-gateway.test.ts test/durable-action.test.ts test/plugin.test.ts test/plugins.test.ts` — 102 passed，489 assertions。
- `packages/core`: webfetch ordinary host、manual redirect、HTML/text conversion 三个专项用例 — 3 passed，9 assertions。
- `packages/arforge`: `bun test test/session/instruction.test.ts test/tool/webfetch.test.ts test/tool/websearch.test.ts` — 23 passed，54 assertions；1 个项目原有 remote-instruction test 保持 todo。
- `packages/arforge`: `bun test test/control-operation/worktree-worker.test.ts test/mcp/gateway-adapter.test.ts` — 26 passed，142 assertions。
- `git diff --check` — passed。
- 未执行远程 push；工作仅保留在本地 checkpoint 分支。

## 未完成的验证项

`packages/core/test/tool-webfetch.test.ts` 的既有 `TestClock + Effect.never` stalled-request 用例在当前 Bun 运行环境持续不退出，无法产生可判定的 pass/fail；其余 webfetch 改动相关专项用例已单独通过。该测试未被记录为通过，后续应在测试时钟/interruptibility 专项中单独处理，不影响本证据中已列出的成功结果。
