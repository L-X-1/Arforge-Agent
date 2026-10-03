# R13 MCP catalog generation fence / bounded retry（2026-09-15）

## 结论

`MCP.catalog()` 现在把一次用户侧目录读取视为单一、有限的 generation-fenced 操作。读取三类目录前记录每个 connected server 的 client identity、observed/desired generation 与 supervisor phase；三类读取和最终 capability projection 之间发生 client/generation/phase 变化时，丢弃本次结果并在最多 3 次内重试。每次重试最多等待 25 ms 让替换 transport 完成调度；反复抖动达到上限时 fail-closed，不返回混合的旧/新目录。

此切片只强化已经存在的 `MCP.catalog()` 用户侧快照，不把 HTTP/CLI 入口误报为完整 control Action/Gateway。MCP supervisor、`McpCatalog` 的分页/聚合预算、generation registry、semaphore 和 transport owner 未新增第二套实现。

## 实现

- `packages/arforge/src/mcp/index.ts`
  - 增加 bounded fence 常量（最多 3 次、25 ms retry window）。
  - 记录并比较 connected client、observed generation、desired generation 与 phase。
  - 用 `Effect.exit` 处理重连导致的旧 transport 失败；只有 fence 稳定且 supervisor 不在 connecting/draining 时才构造 immutable snapshot。
  - fence 反复变化时只产生受控失败，不发布可能混合的目录。
- `packages/arforge/test/mcp/lifecycle.test.ts`
  - 增加真实本地 HTTP MCP server 替换 transport 的重连竞态测试，确认第一次读取被丢弃、后续 generation 的三类目录完整返回。

## 验收证据

| 范围 | 命令/结果 |
| --- | --- |
| generation fence 回归 | `D:\\bun\\bin\\bun.exe test --timeout 60000 test/mcp/lifecycle.test.ts -t "catalog() retries when a reconnect changes its generation fence" --rerun-every`：**1 pass / 0 fail / 6 assertions，exit 0** |
| catalog 相关回归 | 同文件 `-t "catalog|capabilit" --rerun-every`：**9 pass / 0 fail / 38 assertions，exit 0** |
| 完整 MCP lifecycle 背景 | **39 pass / 2 fail / 129 assertions，exit 1**；失败仍为已记录的 Windows/Bun 本地 stdio 启动目录与 fixture PID 边界，不归因于本切片 |
| arforge typecheck | exit 1，但新增 MCP/CLI/HTTP 诊断为 0；剩余均为既有 `packages/tui` JSX/BaseRenderable 诊断 |
| 格式/差异 | Prettier 对两个改动文件通过；限定 `git diff --check` 通过 |
| migration freshness | 按既定顺序重生成 Python dependency ledger、TS composition ledger、source snapshot 后，`audit:migration-freshness valid=true`；指标为 Python 扫描文件 `5091`、依赖叶 `6708`、TS source `1795`、source inputs `7675` |

## 未关闭项

1. HTTP/CLI catalog 仍需独立的 control Action/Gateway 身份、授权、期限、持久回执和恢复语义；本切片没有绕过该要求。
2. prompt/template 命令入口、原生 service read/prompt、rich Artifact、四类本地生命周期、代际冷恢复、默认 MCP 全量矩阵和真实外部服务仍开放。
3. full Linux/macOS/Windows sandbox 仍按 R30 后执行。
