# Step 7.3 — Experience Graph 验证证据

日期：2026-08-12

## 实现范围

- 新增 `experience_graph_relation` Drizzle 关系表，使用 tenant/user ownership columns，不引入图数据库。
- 固定关系类型：`applies_to`、`contradicts`、`supersedes`、`derived_from`、`failed_under`、`supports_skill`。
- 关系记录保存 source/target kind、ID、immutable digest、evidence IDs、policy version、relation digest 和创建时间。
- source/target/relation 三元组建立唯一索引；同一 digest 重复写入返回原记录，digest 漂移返回冲突，不覆盖既有边。
- `supports_skill` 强制目标节点为 skill；所有关系至少携带 `evd_` evidence ID 和 64 位 immutable digest。
- SQLite migration 由 Drizzle 生成；PostgreSQL migration 使用项目现有的 RLS/ownership/grant 迁移规范，并只包含本关系表及索引/策略。

## 验证结果

```text
bun run --cwd packages/core migration --check
passed

bun run --cwd packages/core db:generate:postgres-schema
Generated 15 PostgreSQL migrations with 287 statements

bun run --cwd packages/core typecheck
passed

bun run --cwd packages/schema typecheck
passed

bun test --cwd packages/core test/experience-graph.test.ts
3 pass, 0 fail

bunx oxlint packages/core/src/experience-graph.ts packages/core/src/experience-graph/sql.ts packages/core/test/experience-graph.test.ts
0 warnings, 0 errors
```

数据库测试覆盖：六种关系写入/查询、重复写幂等、digest 漂移冲突、非法证据、非法 digest 和错误的 `supports_skill` 端点。
