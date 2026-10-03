# Phase 2.7 — Gateway bypass 审计证据

- 日期：2026-08-11
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`
- 范围：TypeScript 主运行时、Server/HTTP、Desktop/native、MCP、Python 兼容 CLI，以及数据库维护入口
- 结论：已启用的产品副作用均归属到唯一的 Gateway、内部 authority、Desktop/native authority 或明确的 maintenance/admin authority；发现的两个业务入口 bypass 已修复；未绑定 ActionGateway identity 的 workflow command 节点已 fail-closed hard-block。

## 分类规则

| 分类 | 判定 |
| --- | --- |
| pure read | 只读取文件、数据库、配置或已发布状态，不产生产品副作用 |
| internal implementation only | 只由已归属的服务/运行时调用，不能作为业务入口直接执行 |
| Gateway managed | 进入 `ActionGateway.execute` 后才允许执行副作用 |
| hard-blocked | 入口保留用于兼容或显示，但在未满足 authority 绑定时明确拒绝 |
| migration/admin operation | 仅用于 schema、备份、恢复、清理或运行时维护的管理员路径 |

## 入口审计结果

| 副作用入口 | 真实 authority | 分类 | 证据/处理 |
| --- | --- | --- | --- |
| Core canonical tools（bash、write、edit、apply-patch 等） | `packages/core/src/tool/registry.ts` 的 `settleWith` → `ActionGateway.Service` | Gateway managed | 工具 body 只在 Gateway capability 注入后 settlement；leaf permission 仍保留 |
| Arforge Session tools（含 plugin tools） | `packages/arforge/src/session/tools.ts` 的 `guardTools` → `ActionGateway` | Gateway managed | 先做 canonical input digest、effect/preflight，再执行 tool body |
| MCP tool call | `packages/arforge/src/mcp/gateway-adapter.ts` 的 `mcpCallViaGateway` | Gateway managed | 每次 MCP call 绑定 child durable action；连接/OAuth 状态由 MCP service 自有 authority 管理 |
| ControlPlane worktree create/remove/reset | scheduler → sealed worker → `ActionGateway` | Gateway managed | worker 只使用 immutable snapshot、durable run lease 和 Gateway grant |
| Core `AppProcess`、`ChildProcessSpawner`、`Git`、ripgrep | Core process/Git service | internal implementation only | 没有业务 handler 直接暴露 raw mutator；产品工具/worker 通过上表的 Gateway 进入 |
| Workflow `kind=command` child process | 原实现是 `WorkflowGraphRuntime.runCommandNode` 的 raw `spawnSync` | hard-blocked | 已移除 raw spawn；未携带 canonical ActionGateway identity 前返回 `GATEWAY_REQUIRED`，回归测试确认不会启动进程 |
| Managed plugin inspect/apply/remove/restore/enable | `PluginInstallRuntime` | migration/admin operation | Server handler 只调用 runtime；`pluginSetEnabled` 已从直接 `Plugins.setPluginEnabled` 改为 `runtime.setEnabled` |
| Private operation overview | Server private-operation handler | pure read | 已移除无条件 `fs.mkdir`；现在只对既有目录执行 `fs.access`，日志 prune 使用默认 `apply=false` |
| Skill/evolution/workflow persistence | 对应 Core service/runtime | internal implementation only / migration-admin | handler 只调用服务 API；workflow schema bootstrap 收敛在 `WorkflowGraphRuntime.ensureSchema`，不向 handler 暴露 raw SQL mutator |
| HTTP POST/PUT/PATCH/DELETE | Server domain services、MCP/Trigger service、或已声明的 control operation | Gateway managed / internal implementation only | UI/client 只发请求；legacy session share/unshare handler 明确返回 disabled，不会调用旧发布路径 |
| Provider publish/revoke | MCP connection state machine；mDNS server lifecycle | internal implementation only | OAuth/connect/disconnect 的 generation、tombstone、publish gate 在 MCP service 内；mDNS 只由 server lifecycle publish/unpublish |
| Desktop/native bridge | `packages/desktop/src/main/ipc.ts` 的 main-process IPC handlers | internal implementation only | renderer 只通过 preload `window.api`；store mutation 有 `StoreMutationCoordinator`；open-path/open-link 属于 native UI authority |
| Python legacy file/tool mutation | `arforge/product/action_runtime.py` → `execute_tool_by_name` | internal implementation only（legacy authority） | Python direct bridge 的 `tool.execute`、diff/file apply 统一进入 `ActionRuntime`；裸 leaf 不是 HTTP/desktop business handler |
| Python legacy Git worktree | `arforge/product/direct_dispatch.py` → `ProductService` | migration/admin operation（legacy authority） | 只接受白名单 Git methods，并由 ProductService 做 managed-root、clean-state、primary-worktree 校验 |
| PostgreSQL migration / clear-data / backup-restore | Core migration scripts、`clear-data` CLI、backup/recovery drill | migration/admin operation | admin URL、preflight、backup/restore drill、确认短语和权限检查位于维护入口；业务 app role 不持有 destructive grant |

## 已修复项

1. `packages/server/src/handlers/private-operation.ts`
   - 删除 overview 检查中的 `fs.mkdir(..., { recursive: true })`。
   - 只读诊断不再因“检查目录可写”而创建目录。

2. `packages/core/src/analysis/plugins.ts` 与 `packages/server/src/handlers/agent-capability.ts`
   - 新增 `PluginInstallRuntime.setEnabled`，统一校验 managed plugin 后再持久化 enablement override。
   - Server handler 不再直接调用底层 `Plugins.setPluginEnabled`。

3. `packages/core/src/analysis/workflow-graph.ts`
   - 移除 workflow command node 的 raw `spawnSync`。
   - 在 workflow command authority 尚未绑定 ActionGateway identity 前明确 hard-block；避免工作流 API 绕过统一进程授权。

## 验证

- `packages/core`: `bun test test/plugins.test.ts test/workflow-graph.test.ts` — 17 passed，46 assertions。
- `packages/core`: `bun run typecheck` — passed。
- `packages/server`: `bun run typecheck` — passed。
- `git diff --check` — passed。
- 未执行远程 push；仅保留本地 checkpoint 分支。

## 后续边界

Workflow command node 的 hard-block 是本步骤的 fail-closed 结果，不代表 command workflow 已恢复可用。恢复它必须先定义并持久绑定 workflow 的 subject、action、intent digest、run lease 和 policy，再接入 `ActionGateway`；不得恢复 raw spawn。
