# R13 用户侧 MCP catalog snapshot 融合（2026-09-15）

## 结论

CLI `mcp capabilities` 与 HTTP `v2.mcp.capabilities`/`v2.mcp.resource.catalog` 现在都消费 MCP service 的单一 `catalog()` 快照，不再在各自入口中分别调用 `prompts()`、`resources()`、`resourceTemplates()` 后自行拼装。`MCP.catalog` 在同一 service owner 内并行刷新三类协议目录，再读取 generation-scoped capability projection，避免入口把不同刷新时刻的结果混成一份目录；supervisor、`McpCatalog` 的分页/聚合预算、generation registry 和 semaphore 仍是唯一发现与传输 owner。

这是用户侧目录读取的融合切片，不宣称 R13 的 control Action/Gateway 已全部闭合：`catalog()` 内部仍复用 MCP service 的受控 supervisor 读取，HTTP/CLI 还需要独立的 control-action 身份、授权和回执设计，不能把本次快照统一误报为完整外发授权验收。

## 实现

- `packages/arforge/src/mcp/index.ts`
  - 新增 `CatalogSnapshot` 和 `MCP.Interface.catalog()`。
  - `MCP.catalog` 统一刷新 prompts/resources/resourceTemplates 后一次性返回三类条目及 capability snapshot。
- `packages/arforge/src/server/routes/instance/httpapi/handlers/mcp-v2.ts`
  - 两个用户侧目录 endpoint 改为消费同一 `mcp.catalog()`。
- `packages/arforge/src/cli/cmd/mcp.ts`
  - `mcp capabilities` 改为消费同一 `mcp.catalog()`。
- `packages/arforge/test/mcp/lifecycle.test.ts`
  - 增加完整三类目录 + tools 的 coherent projection 回归。

## 验收证据

| 范围               | 命令/结果                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| service projection | `D:\\bun\\bin\\bun.exe test --timeout 60000 test/mcp/lifecycle.test.ts -t "coherent projection" --rerun-every`：**1 pass / 0 fail / 7 assertions，exit 0**                  |
| 目录边界回归       | 同文件 catalog/分页/取消/聚合筛选（含 coherent snapshot）：**8 pass / 0 fail / 32 assertions，exit 0**                                                                      |
| 完整生命周期背景   | 同文件全量 **38 pass / 2 fail / 120 assertions**；两项失败仍是计划中记录的 Windows/Bun 本地 stdio 启动目录/子进程 fixture 边界，不归因于本次快照改动，也不宣称 MCP 全量通过 |
| 静态检查           | `packages/arforge` typecheck 仍只报既有 `packages/tui` JSX/BaseRenderable 诊断；本切片无新增 MCP 类型诊断；Prettier 通过                                                    |
| freshness          | 生成依赖账本、TS composition 和 source snapshot 后 `audit:migration-freshness valid=true`（source inputs 7666，TS source files 1792）                                       |

## 未关闭项

1. HTTP/CLI 目录读取接入明确的 control Action/Gateway 身份、授权、请求期限、持久回执与恢复语义；读目录不应绕过启动/外发授权。
2. prompt 命令模板、原生 service read/prompt API、rich Artifact、断连/重连/代际冷恢复、默认 MCP 全量失败矩阵和真实外部服务仍开放。
3. full Linux/macOS/Windows sandbox 仍按 R30 后执行。
