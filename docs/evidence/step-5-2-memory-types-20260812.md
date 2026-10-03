# Step 5.2 — Memory 类型冻结

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.2
状态：完成类型边界冻结；不在本步骤执行数据库 backfill。

## 冻结合同

`packages/schema/src/memory-class.ts` 定义唯一的 Memory Kernel V1 class union：

| class | 是否进入长期 Memory 表 | 允许的语义边界 | provenance 方向 |
|---|---:|---|---|
| `working` | 否 | 当前 Run 的短期状态；只在 Run/Context 生命周期内存在 | Run/Event/Observation |
| `episodic` | 是 | Run/Event/Observation 历史引用；不复制原始事件正文 | Run/Event/Observation |
| `semantic` | 是 | 经注册 Evidence 支持的项目/领域事实 | Evidence |
| `user` | 是 | 用户显式偏好、身份、约束 | User authority |
| `project` | 是 | 架构决定、项目约定、稳定配置 | Project authority |

`experience` 和 `skill` 使用独立生命周期，明确不属于 Memory class union，也不能通过把 legacy `type` 写成同名字符串绕过边界。

## 兼容策略

当前 `Memory.type`（例如 `fact`、`workflow`、`constraint`、`preference`）继续作为 legacy/product category，避免在类型冻结步骤破坏现有 UI/API。它不再被隐式视为 V1 class：`fact` 和 `workflow` 等字符串必须在后续 Candidate/迁移流程中通过显式策略映射，并在无法确定时进入 review。

本步骤只冻结 schema 和语义定义，不给现有长期记录伪造 class，也不提前写入 `memory_class` 列。Step 5.3–5.5 将把 class 放入 candidate、写入政策和 provenance/revision；Step 5.11 再做 additive backfill。

## 代码与测试证据

- 合同：`packages/schema/src/memory-class.ts`；通过 `packages/schema/src/index.ts` 暴露为 `MemoryClass` namespace。
- Core contract test：`packages/core/test/memory-class.test.ts`。
- 现有兼容回归：`packages/core/test/memory.test.ts` 仍覆盖旧 `type` 类别、CRUD、recall、quarantine、correction/conflict，未改变其 API 语义。

## 下一步

进入 Step 5.3：为长期写入建立 Memory Candidate，要求 candidateID、proposed class/content、source evidence IDs、scope、sensitivity、confidence、novelty/dedup、retention proposal、proposer、policy decision 和 status/reason；禁止自动抽取直接创建 active user/project memory。
