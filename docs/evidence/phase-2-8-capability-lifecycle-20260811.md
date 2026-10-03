# Phase 2.8 — Capability 生命周期统一证据

- 日期：2026-08-11
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`
- 范围：V2 `DurableRun` control lease、`DurableAction` lease、`ActionGateway` execution handoff、Core V2 plugin event boundary
- 结论：V2 control/action execution path 已完成私有 opaque capability 生命周期收紧；heartbeat 会轮换 capability，旧 token、clone、wrong action/run、expired/takeover 和 cross-layer token 在事件发布前 fail-closed。raw `EventV2` publisher 仍只在 TCB 内，插件只获得只读 observer。

## 生命周期与边界

| 能力 | 发放层 | 绑定 | 轮换/吊销 | 外部可见性 |
| --- | --- | --- | --- | --- |
| `DurableRun.RunLeaseCapability` | `packages/core/src/runtime/durable-run.ts` | exact run、lease、owner、generation、heartbeat/expires；每次 mutation 重新核验 durable revision/CAS | control heartbeat 发放新 token并吊销旧 token；control release/body finalizer 后吊销 | sealed control worker / Gateway 内部；不进入插件或普通工具参数 |
| `DurableAction.ActionLeaseCapability` | `packages/core/src/runtime/durable-action.ts` | exact action、lease、owner、generation、heartbeat/expires | heartbeat 发放新 token并吊销旧 token；release `ensuring` 后吊销 | 仅 `ActionGateway` execution scope；不再接受可拼装的 lease identity 字段 |
| `ActionGateway.AuthorizationGrantCapability` | `packages/core/src/action-gateway.ts` | exact action、authority/grant、authorization requests | body completion、scope finalizer 后吊销 | 仅 Gateway → sealed operation/tool handoff |
| Plugin event observation | `packages/core/src/plugin/events.ts` | 只暴露 `subscribe` | 无 publisher/mutator 方法 | Core V2 plugin context 只获得 `PluginEvents.Service` |

## 关键实现

1. `DurableAction` 改为在每个 Effect Layer 内使用 `WeakMap<object, ActionLeaseCapabilityBinding>`。
   `acquireLease` 返回 `{ snapshot, capability }`；`heartbeat` 返回新 capability 并使旧 capability 失效；`assertLease`、`heartbeat`、`releaseLease` 均拒绝未由当前 layer 发放或已被吊销的 token。

2. `ActionGateway` 不再保存或传递 action lease 的 `leaseID/ownerID/generation` 输入字段。Gateway heartbeat 使用当前 opaque capability 接收轮换结果，所有 ownership assertion 和 release 都读取当前 layer-local capability。

3. `packages/core/src/plugin/internal.ts` 仍由 TCB 持有 `EventV2.Service`，但注入插件的服务改为 `PluginEvents.Service`，其接口只有只读 `subscribe`。插件不能通过 context 获得 `publish/replay/remove/claim`。

4. Arforge 内置文件工具使用 `EventV2Bridge.Service` 发布 UI/file watcher 通知。该 bridge 是工作区路由后的内部适配层，不是 Core raw `EventV2.Service`；它不作为外部插件 context 注入。产品副作用仍由 Gateway/内部 authority 负责。

## Fail-closed 场景

- shallow clone：新的对象不在当前 layer `WeakMap` 中，拒绝且不产生事件；
- cross-layer：另一份 Effect Layer 无法解析原 layer 的 token，拒绝且不产生事件；
- wrong action/run：binding identity 不一致，拒绝且不产生事件；
- heartbeat rotation：旧 token 失效，新 token 绑定新的 heartbeat/expires revision；
- expired/takeover：durable lease 已过期或 generation 被接管，旧 token 无法通过当前 lease 校验；
- release/body completion：release 成功或失败离开时均通过 finalizer 吊销当前 action capability。

## 验证

- `packages/core`: `bun test test/durable-action.test.ts` — 16 passed，51 assertions。
- `packages/core`: `bun test test/durable-action.test.ts test/action-gateway.test.ts` — 91 passed，459 assertions。
- `packages/core`: `bun test test/plugin/models-dev.test.ts test/plugin/provider-arforge-console.test.ts test/durable-action.test.ts test/action-gateway.test.ts` — 104 passed，496 assertions。
- `packages/arforge`: `bun test test/control-operation/worktree-worker.test.ts test/mcp/gateway-adapter.test.ts` — 26 passed，142 assertions。
- `packages/core`: `bun run typecheck` — passed。
- `packages/arforge`: `bun run typecheck` — passed。
- `packages/server`: `bun run typecheck` — passed。
- `git grep` 审计：Core plugin 代码中仅 `packages/core/src/plugin/internal.ts` 的 TCB 装配点读取 raw `EventV2.Service`；插件实现只读取 `PluginEvents.Service`。
- `git diff --check` — passed。
- 未执行远程 push；仅保留本地 checkpoint 分支。

## 兼容边界

现有 session runner 的旧 `DurableRun` session lease API 仍由 session coordinator/runner 内部使用；它不进入插件或工具 context，也不属于本次 V2 control-plane sealed worker handoff。后续若将 legacy session executor 纳入同一 capability contract，应单独迁移其 run mutation API 和恢复测试，不得把旧 plain lease identity 重新暴露到插件或业务 handler。
