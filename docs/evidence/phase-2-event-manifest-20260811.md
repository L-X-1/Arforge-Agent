# 阶段 2.3：Durable Event Manifest 与版本规则

> 登记时间：2026-08-11；计划来源：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`。
> 本阶段只收敛事件合同和 replay 证据，不执行数据库迁移或修改现有历史数据。

## 1. Manifest 事实

统一定义位于 `packages/schema/src/agent-runtime.ts`，注册位于 `packages/schema/src/durable-event-manifest.ts`，持久化与 replay 位于 `packages/core/src/event.ts`、`packages/core/src/runtime/durable-run.ts` 和 `packages/core/src/runtime/durable-action.ts`。

| Aggregate family | Manifest | Version | Aggregate field | 首事件 | 允许事件 |
|---|---|---:|---|---|---|
| Session durable | `DurableEventManifest.SessionDurable` | 由 `SessionEvent.DurableDefinitions` 显式声明 | Session event definition 指定 | 由 Session projector/history 合同约束 | 由 Session durable definitions 约束 |
| Agent session Run | `AgentRunDurable` | 1 | `runID` | `agent.run.created.1` | created、state-changed、checkpoint-created、attempt-started/finished、lease-acquired、heartbeat-recorded、lease-released |
| Agent control Run | `AgentRunDurable` | 2 | `runID` | `agent.control-run.created.2` | control created、state-changed、checkpoint-created、attempt-started/finished、lease-acquired、heartbeat-recorded、lease-released |
| Agent Action | `AgentActionDurable` | 1 | `actionID` | `agent.action.proposed.1` | proposed、policy-evaluated、authorization-granted、state-changed、attempt-started/finished、observed、lease-acquired、heartbeat-recorded、lease-released |

当前内存 manifest 精确包含：Run 16 个定义（session @1 8 个 + control @2 8 个），Action 10 个定义；每个定义的 `durable.version` 与 `durable.aggregate` 均显式存在，版本化 key 使用 `type.version`。

## 2. Replay 与 fail-closed 规则

当前实现已经执行以下顺序：

1. 读取 `EventSequenceTable` 的 latest sequence 与 `EventTable` 的 raw rows；
2. 要求 row 数量等于 latest sequence + 1，并要求每一行 sequence 从 0 连续递增；
3. 通过对应 family manifest 查找 definition；unknown type、错误 family 或不存在的 definition 直接转为 corrupt history；
4. 使用 strict schema decode，`onExcessProperty: "error"`，因此 excess field 不能静默进入 reducer；
5. 校验首事件、aggregate identity、subject/session identity、状态转换、attempt、lease、checkpoint digest 和终态约束；
6. 不允许把 session @1 事件放入 control @2 aggregate，也不允许把 control @2 事件放入 session Run；
7. 非 terminal legacy action 只有在重新 preflight、重新绑定当前 intent/authorization 后才能继续；settled/read-only 结果保留兼容读取路径，缺少安全 fingerprint 的 legacy action fail-closed。

版本规则：`Event.durable` 以 `type.version` 建立不可重复的 manifest key，`Event.latest` 选择最高版本定义。新增版本必须新增显式 definition，并提供 additive schema 或显式 decoder migration；当前没有把旧 payload 隐式当作新版本解码的路径。

## 3. Fresh evidence

2026-08-11 在当前 checkpoint 分支执行：

- `bun test --cwd packages/core test/event.test.ts test/durable-run.test.ts test/durable-action.test.ts`
  - **97/97 passed**，**263 assertions**；覆盖 durable publish/sequence、raw aggregate replay、unknown tail、middle gap、excess field、cross-family、首事件、非法转换、lease/checkpoint/attempt 和 control @2 identity。
- `bun test --cwd packages/core test/durable-event-manifest.test.ts`
  - **3/3 passed**，**12 assertions**；固定 Run/Action 首事件、family 前缀、显式 versioned key 和 combined manifest 无重复。
- `bun test --cwd packages/core test/action-gateway.test.ts -t "never resumes a nonterminal legacy-v1 intent"`
  - **1/1 passed**，证明 nonterminal legacy-v1 不会绕过新 preflight 继续副作用执行。
- `packages/schema` typecheck：通过；`packages/core` typecheck：通过。

## 4. 阶段结论

- Step 2.3 的首事件、允许事件、版本、aggregate、strict replay 和 legacy compatibility contract 已有明确事实与 fresh evidence。
- 当前不需要新建第二套 event registry；后续事件扩展必须只进入现有 `DurableEventManifest` 和对应 reducer。
- Step 2.3 已完成；Step 2.4 从 Action effect semantics catalog 开始。
- PostgreSQL migration/RLS、backup/restore、crash injection、Windows packaged E2E 仍未执行，按 V2 顺序后置。
