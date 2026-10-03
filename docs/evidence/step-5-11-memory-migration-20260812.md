# Step 5.11 — Memory 数据迁移

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` / 12.阶段 5 / Step 5.11
状态：隔离 SQLite disposable restore 验证通过；未连接或修改用户真实数据库。

## 迁移落点

- SQLite migration：`packages/core/src/database/migration/20260812045709_memory_kernel_persistence.ts`
- PostgreSQL migration：`packages/core/src/database/postgres-migrations/20260812045709_memory_kernel_persistence/migration.sql`
- `memory` 增量字段：`memory_class`、`lifecycle`、`memory_version`、`provenance_status`、`content_digest`、`retention_mode`、`retention_expires_at`。
- 新持久化表：`memory_candidate`、`memory_revision`，均带 tenant/user ownership；PostgreSQL 版本启用 RLS、强制 RLS 和 tenant isolation policy。
- 旧 `MemoryV2` writer 未切换；本步骤没有双写。只读适配器 `packages/core/src/memory/kernel-reader.ts` 兼容迁移前缺失字段，缺失 provenance 一律解析为 `legacy_unknown`。

## Disposable restore 证据

测试：`packages/core/test/memory-migration.test.ts`

- backup：隔离数据库中的 legacy row JSON 快照，大小 `72` bytes。
- sample digest：`sha256:4feda6271bae24642066896276679b9f320da30e974a637d618036b882ccc4aa`。
- restore digest：与 backup digest 完全一致。
- row count：迁移前 `1`，迁移后 `1`。
- lifecycle backfill：`quarantined:model` → `quarantined`。
- version/provenance/retention：`1` / `legacy_unknown` / `indefinite`。
- ledger：`migration` 表写入 `20260812045709_memory_kernel_persistence`。
- table checks：`memory_candidate`、`memory_revision` 均存在。
- new reader：迁移后读取同一 legacy row，未把 `legacy_unknown` 当作 verified provenance。

## 回滚决策

本次 disposable 验证的 count、backup digest、restore digest、ledger 和 schema checks 全部通过，rollback decision 为 `continue`。迁移只新增列/表并在迁移事务中执行；任一 count/digest/schema 校验失败时停止进入 Step 5.12，并按 backup/ledger 回滚，不切换旧 writer。旧 Python MemoryOS 仍仅作为对照/导入边界，本步骤未调用且未建立双写链路。

## 验证命令

```text
bun test --cwd packages/core test/memory-migration.test.ts
bun run --cwd packages/core typecheck
bunx oxlint packages/core/src/memory/sql.ts packages/core/src/memory/kernel-reader.ts packages/core/src/database/migration/20260812045709_memory_kernel_persistence.ts packages/core/test/memory-migration.test.ts
bun run --cwd packages/core migration --check
```

结果：migration test `1 pass / 7 assertions`；schema/typecheck 通过；相关文件 lint `0 warnings / 0 errors`；migration check 通过。
