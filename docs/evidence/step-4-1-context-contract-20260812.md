# Step 4.1 Context 合同证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.1

状态：已完成

## 唯一 authority

`packages/core/src/context-contract.ts` 建立了 Context Engine V3 的 canonical 合同：

- Event/Run：`event-run`，执行历史的事实源；
- Memory OS：`governed-memory`，受治理的跨会话知识；
- summary/compaction：`derived`，可替换的派生 prompt 材料，不是事实源；
- Context Package：`context-package`，编译结果，不是 source authority；
- instruction/request/tool：`runtime-input`，运行时输入，不冒充持久事实源。

每个编译单元现在携带 `unitID`、`origin`、canonical `contextLayer`、`authority`、`trust`、`mandatory` 和 `priority`。

## 兼容迁移

`packages/core/src/runtime/compiler.ts` 继续接受既有 L0–L7 `LayerInput`，但在编译边界完成 canonical 化：

| 旧层 | canonical layer |
| --- | --- |
| L0/L1/L3 | `authority` |
| L2 | `protected_checkpoint` |
| L4 | `cognitive_state` |
| L5 | `recalled_memory` |
| L6 | `recent_history` |
| L7 | `optional_context` |

`RuntimeInsight.ContextLayerReport` 只记录这套归一化后的 metadata；没有新增数据库 migration，也没有建立第二条 Context 写入路径。

## 验证

- `bun run --cwd packages/core typecheck`：通过；
- `bun test --cwd packages/core test/runtime/compiler.test.ts test/runtime/insight.test.ts`：18 pass、0 fail；
- 测试覆盖 legacy layer mapping、Memory/summary trust boundary、Event/Run 与 Memory 的 source-of-truth 标记，以及 Context Package derived-only 约束。

## 后续边界

Step 4.1 只统一 authority 与编译输入合同；Source Registry、Evidence Unit、Source Adapter、检索与 Context Package 完整 digest/预算编译分别在 Step 4.2–4.7 实施。
