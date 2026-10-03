# v2.0 R13 实码证据：MCP 目录工具统一进入 Core ActionGateway

日期：2026-09-14
范围：`packages/arforge/src/mcp/resource-projection.ts`、`packages/arforge/test/mcp/resource-projection.test.ts`

## 本批完成

`list_mcp_prompts`、`list_mcp_resources`、`list_mcp_resource_templates` 原来在工具权限询问后直接读取 MCP service。本批保留原 `MCP` supervisor 的分页、聚合、字节和 deadline 预算，将每个实际连接服务器的目录遍历改为 `McpGatewayAdapter.mcpRequestViaGateway` 的 durable child Action：

- 在进入权限询问前解析每个目标服务器的 `declaredScope`；缺少受保护 transport scope 时 fail-closed，不能用交互提示替代审计证据。
- 目录读取仍由原 `MCP.prompts/resources/resourceTemplates`、`McpCatalog` 和 generation registry 执行，没有新增 client、executor、权限数据库或恢复 owner。
- child Action 绑定父 Action/session/message/call、服务器、操作、参数摘要和 transport scope；执行前再次核对 scope，重连或配置漂移不会把旧 scope 直接用于新读取。
- 持久回执只保存 name/client/description/uri/uriTemplate 的 JSON-safe 投影，不保存 SDK `Client` 实例；重放不会复活传输对象。
- `prompts()` 不接收服务器参数的兼容形态也在适配层按实际 `client` 过滤，避免按单服务器请求时把其他服务器目录归属错误地改写。

## 实际验收

命令（工作目录 `packages/arforge`）：

```text
D:\bun\bin\bun.exe test test/mcp/resource-projection.test.ts --timeout 30000
```

结果：**11 pass / 0 fail / 48 expect() calls**。新增场景验证目录读取经过共享 child gateway，来源结果可 JSON-safe 重放且不泄漏 `Client` 对象；原 prompt/resource/template、URI reader、MIME/信任边界与 RFC 6570 用例全部保持通过；另验证 supervisor generation 在 transport 前变化时 fail-closed 且不调用目录来源。

静态检查：

```text
D:\bun\bin\bun.exe x prettier --write src/mcp/resource-projection.ts test/mcp/resource-projection.test.ts
D:\bun\bin\bun.exe x oxlint --disable-nested-config src/mcp/resource-projection.ts test/mcp/resource-projection.test.ts --quiet
git diff --check -- packages/arforge/src/mcp/resource-projection.ts packages/arforge/test/mcp/resource-projection.test.ts
```

Prettier、`git diff --check` 通过；Oxlint **0 errors**，仅保留该文件原有的规则告警。Arforge 包级 `bun run typecheck` 仍被既有 `packages/tui` JSX/BaseRenderable 诊断阻断，本批文件未产生新的类型诊断。

## 未关闭范围

这是 R13 的目录工具入口切片，不代表 R13 完成。HTTP/CLI 直接 catalog 读取、MCP 原生 service 的所有 read/prompt API、rich Artifact 的全量交付、四类本地 stdio/HTTP 生命周期、断连/重连/代际冷恢复、默认 MCP 全量回归和外部真实服务矩阵仍开放。当前默认生命周期的两个 Windows/Bun 1.3.14 本地 stdio 失败仍保留为已复现运行时边界；没有更换项目 Bun、扩大授权根目录或降低 sandbox。三平台 full sandbox 继续按计划在 R30 后执行。
