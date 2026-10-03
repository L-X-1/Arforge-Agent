# R13 MCP 生命周期环境校准与 prompt scope 回归（2026-09-15）

## 结论

本轮在同一 MCP 生命周期文件上分别记录默认 Windows native backend 与显式禁用 Windows native backend 的真实结果，避免把环境阻断误写成产品通过，也避免把禁用 native 的 fixture 结果冒充三平台 sandbox 验收。与此同时，native prompt 无 lease 兼容入口已与 resource 一样强制解析 `declaredScope`。

## 实际结果

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| Windows native 默认 | `D:\\bun\\bin\\bun.exe test test/mcp/lifecycle.test.ts --timeout 30000` | **41 pass / 2 fail / 155 assertions / exit 1 / 29.14s** |
| Windows native 默认失败 | `local mcp cwd resolves relative paths...` | `MCP.LocalStartupError current_directory`：本地 MCP 读取启动目录时退出 |
| Windows native 默认失败 | `local stdio timeout terminates the real server process` | `stdio fixture did not publish its pid` |
| native disabled fixture | `$env:ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE='1'; ... lifecycle.test.ts --timeout 30000` | **43 pass / 0 fail / 156 assertions / exit 0 / 24.05s** |
| ToolRegistry 全文件 | `D:\\bun\\bin\\bun.exe test test/tool/registry.test.ts --timeout 30000` | **17 pass / 0 fail / 34 assertions / exit 0 / 7.84s** |
| prompt scope 定向 | `... lifecycle.test.ts --grep "catalog reads fail closed|native MCP prompt reads|uses per-server timeouts"` | **3 pass / 0 fail / 21 assertions / exit 0** |
| catalog scope 定向 | `... lifecycle.test.ts --grep "catalog reads fail closed|follows cursors|catalog\\(\\) returns|rejects a resource lease|native MCP prompt reads|disconnect removes"` | **6 pass / 0 fail / 46 assertions / exit 0** |

默认失败均保持原样单列，未换 Bun、未扩权、未降级 native sandbox；禁用变量只用于隔离服务层回归，不代表 full Linux/macOS/Windows sandbox。两项失败将在 R13 本地生命周期/最终 R30 后置验证中重新处理。

## 代码边界

- `MCP.getPrompt` 即使没有 generation/lease 也必须先解析当前声明 scope；配置消失、endpoint 无法规范化或本地 frozen intent 无法重建时，不进入 SDK transport。
- `MCP.capabilities`/`MCP.catalog().capabilities` 只投影 connected、当前 generation 且 scope 可解析的 registry 条目，`MCP.instructions` 也有同一 scope fence，避免配置漂移后 API/CLI/模型上下文暴露 stale 元数据。
- generation lease、prompt server/kind/id/name 校验保持；ToolRegistry、slash command 和 resource/template projection 仍使用原有统一 lease/registry owner。
- 本轮没有新增执行器、权限数据库、transport 或恢复 owner。

## 静态与账本

- 修改文件 Prettier 通过，限定 `git diff --check` exit 0。
- scoped Oxlint 覆盖本轮 4 个相关文件：**0 errors / 36 warnings**；告警为仓库既有规则命中。
- arforge 包级 typecheck 仍只被既有 `packages/tui` JSX/BaseRenderable 诊断阻断；本轮没有 `src/mcp`、`src/tool/registry` 新诊断。
- 迁移账本按 Python 依赖 → TS composition → source snapshot 顺序重生成，`audit:migration-freshness`：`valid=true`；Python capabilities **480/5080**、tests **365/3394**、dependencies **5094/6709/6**、TS composition **1796/3/5/3**、source inputs **7697**，TS boot 有效。

测试仅使用临时 HTTP/stdio fixture 和临时 profile，不使用真实凭据，不修改用户数据。

## 未关闭

R13 的 HTTP/CLI catalog/read/template/prompt 正式 control Action/Gateway 身份、外发授权、期限、持久 receipt/恢复，完整本地四类生命周期/冷恢复、默认全量矩阵及真实外部服务仍开放；三平台 full sandbox 仍按 R30 后执行。
