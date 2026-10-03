# R13 原生 MCP resource lease 精确 URI 绑定（2026-09-15）

## 结论

原生 `MCP.readResource` 现在把 resource lease 绑定到当前请求的精确 URI。仅证明 server、kind、generation 和 registry ID 仍不够；旧实现允许“另一个当前资源”的 lease 通过 generation 检查后把请求重定向到目标 URI。现实现对 `kind=resource` 重新计算 `safeCapabilityKey(server, resourceUri)`，ID 不一致时在 `withClient`/SDK transport 之前直接返回不可用；ToolRegistry 对资源/模板投影也重新使用该 canonical capability ID，避免公共 URI key（尤其含 query/fragment 的 URI）与 lease 身份分叉。resource-template lease 还携带脱敏的展开 URI reference，并在 transport 前进行同一 URI 校验，避免一个模板 lease 被重定向到另一个展开实例。

## 实现

- `packages/arforge/src/mcp/index.ts`
  - `readResource` 在构造 expected capability 前校验 resource lease ID 与精确 URI 的稳定键一致。
  - `resource_template` lease 若带有展开 reference，必须与当前请求 URI 的脱敏规范化值一致；不匹配时不触达 SDK。
  - 即使历史兼容调用不携带 lease，也必须解析出当前配置的 `declaredScope`；scope 缺失时不允许进入 transport。
- `packages/arforge/src/tool/registry.ts`
  - 资源与资源模板的 native Tool projection 不再把公共 catalog key 当作 registry ID，而是通过 `safeCapabilityKey(server, reference)` 重建 generation lease 身份。
- `packages/arforge/test/mcp/lifecycle.test.ts`
  - resource fixture 同时发布 `docs://readme` 与 `docs://other`。
  - 使用 `other` 的当前 lease 读取 `readme` 必须 fail-closed，服务器请求计数保持不变；原有有效 lease 与断开重连后的旧 lease 回归继续通过。
  - 使用同一模板 lease 读取不同展开 URI 必须在 SDK transport 前拒绝；有效展开 URI仍可读取。

## 验收证据

| 范围 | 命令/结果 |
| --- | --- |
| 资源代际/URI 回归 | `D:\\bun\\bin\\bun.exe test test/mcp/lifecycle.test.ts --grep "rejects a resource lease|native MCP prompt reads" --timeout 30000`：**2 pass / 0 fail / 17 assertions，exit 0** |
| 资源/Prompt 投影回归 | 本轮前已通过 `test/mcp/resource-projection.test.ts`：**11 pass / 0 fail / 48 assertions** |
| Arforge 类型 | 包级 typecheck 仍被既有 `packages/tui` JSX/BaseRenderable 诊断阻断；没有本次 MCP/CLI 新诊断 |
| 格式/差异 | Prettier 通过；限定 `git diff --check` exit 0 |

测试使用临时 HTTP MCP fixture，不访问或修改用户数据，不使用真实凭据；本项不涉及 full sandbox。

## 未关闭项

HTTP/CLI catalog control Action/Gateway、原生 prompt/resource 的正式外部授权入口、模板 pattern/RFC 6570 语义的更细授权（当前 reference 是脱敏字符串而非不可伪造 proof）、MCP 生命周期/冷恢复及真实外部矩阵仍属于 R13 后续范围；full sandbox 仍按 R30 后执行。
