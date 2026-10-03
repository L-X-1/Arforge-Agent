# R13 MCP 目录聚合预算与进程边界（2026-09-14）

## 结论

本批完成 R13 的目录控制一项：在保留单服务器分页上限、重复 cursor、单次响应字节上限和请求 deadline 的基础上，给一次 capability-kind 目录读取增加共享的聚合预算。并发服务器读取以事务式 reservation 计数；服务器目录在完整成功前不会提交占用，恶意或损坏服务器失败后会释放已占用额度，不会永久挤占健康服务器。目录请求显式关闭 progress 延期，并同时受 SDK request timeout 与聚合总 deadline 约束。

这不是 R13 整项完成。catalog/list/read/prompt 进入 Action/Gateway 的全部入口、rich Artifact 结果、本地 stdio/HTTP 全生命周期和跨平台 sandbox 仍开放。Windows Bun 1.3.14 + BaseContainer 的两个本地 stdio 用例仍是已复现的运行时边界失败，不通过降级沙箱掩盖。

## 实现与唯一 owner

- `packages/arforge/src/mcp/catalog.ts`
  - 保留 `Limits.pages=1000`、`Limits.items=10000`、`Limits.bytes=10MiB`；新增 `AggregateLimits`（按最多 4 个并发读取器给出有限的聚合 pages/items/bytes 和 30 秒总 deadline）。
  - 新增 `CatalogBudget` 与 lease：每个服务器分页先 reservation，完整 traversal 成功才 commit，失败 release；跨并发读取不会超出 aggregate limits。
  - `paginate` 接受可选聚合 budget，合并调用方/聚合 abort signal，发送 `resetTimeoutOnProgress=false` 和 `maxTotalTimeout`，不会被持续 progress 延期。
  - `prompts/resources/resourceTemplates/defs/fetch` 保持原 API 兼容并传递同一预算对象。
- `packages/arforge/src/mcp/index.ts`
  - `collectFromConnected` 为每次同类目录读取建立一个共享 `CatalogBudget`，所有连接服务器复用；完成或中断时统一关闭 deadline。
  - 仍使用既有 `catalogReads` semaphore、generation registry 和 stale-client 检查，没有新增 manager、client 或权限事实源。

## 验收证据

| 范围                                        | 命令/结果                                                                                      | 原始输出                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 聚合 budget、总 deadline、progress 固定行为 | 18 pass / 0 fail / 47 assertions，exit 0                                                       | [catalog tests](./plan-v2-r13-catalog-aggregate-budget-20260914.txt)    |
| MCP 生命周期回归                            | 37 pass / 2 fail / 116 assertions，exit 1；两个失败均为已知 Windows BaseContainer cwd/pid 边界 | [lifecycle boundary](./plan-v2-r13-mcp-lifecycle-boundary-20260914.txt) |

## 已知边界

1. 聚合预算只约束同一次 `prompts/resources/resourceTemplates`（以及通过相同 helper 的目录读取）调用；它不是跨用户、跨进程的持久 quota。MCP 连接本身仍由既有 supervisor/approval/sandbox owner 管理。
2. `fetch` 延续“单服务器失败不隐藏其他服务器”的既有语义；超限服务器不会发布 partial catalog，健康服务器仍可成功返回。
3. `McpCatalog` 仍是目录控制层，不等于已把每个 list/read/prompt 业务动作都变成 Action/Gateway；工具实际执行仍沿 `McpGatewayAdapter`，该差距留给 R13 后续切片。
4. 本机默认 Bun 1.3.14 的 Windows native BaseContainer 无法在授权 cwd 读取当前目录；不得切到 partial/legacy 后宣称 full。真实 Linux/macOS/Windows full sandbox 按用户顺序留到 R31。

## 计划归属

对应 R13 第 2 项“整体条目/字节/跨服务器并发、总时限和 progress 最大延期”，并为 R08 的统一资源/取消边界提供可复验基础。下一批继续 R09 压缩故障窗口、R13 read/prompt Gateway 接线和 R17 active PersonalJob 恢复，不重写现有 supervisor。
