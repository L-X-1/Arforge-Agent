# Core PostgreSQL 发布与回滚 Runbook

本 runbook 是当前 TypeScript Core/PostgreSQL 实现的发布入口。它与旧的 Python/Alembic
实验链无关；选择 PostgreSQL 后，连接、迁移、RLS 或角色检查失败都必须 fail-closed，不能
静默回退 SQLite。

## 发布前检查

在发布 owner 和数据库 reviewer 都确认后执行：

```powershell
bun run db:topology:preflight
bun run --cwd packages/core db:audit:postgres-role
bun run --cwd packages/core db:smoke:postgres
bun run --cwd packages/core db:generate:postgres-schema
bun run --cwd packages/core migration --check
```

应用角色只能读写业务表，不能创建 schema、绕过 RLS、修改策略或创建临时表。迁移使用
独立的 `ARFORGE_DB_ADMIN_URL`，应用进程使用 `ARFORGE_DB_URL`；任何一个变量缺失都停止发布。

## 备份、迁移和验收顺序

1. 使用 `script/postgres-backup.ps1` 创建加密备份，记录 manifest、artifact digest、SHA-256
   和保留位置；不要把恢复密钥、连接串或 secret 写入日志。
2. 使用 `bun run --cwd packages/core db:migrate:postgres` 应用已审查的迁移，记录最后迁移 ID。
3. 用 `bun run --cwd packages/core db:smoke:postgres` 检查代表性行数与读路径。
4. 用 `bun run --cwd packages/core db:test:postgres-rls` 验证 38/38 业务表 FORCE RLS、跨租户
   读写、伪造 tenant/owner、连接池身份清理和应用角色权限。
5. 用 `bun run --cwd packages/core db:test:postgres-tenant-platform` 验证 tenant policy、secret
   metadata、project/session membership、rate window、settled usage 幂等、治理请求和审计回执。
6. 将迁移 ID、备份 digest、测试输出摘要、operator、reviewer 和 UTC 时间写入发布证据。

## Canary 与 rollback

Canary 必须在生产数据的隔离恢复副本或受控 staging PostgreSQL 上先执行同一套迁移和测试。
Canary 期间只允许观察、低风险读写和受控负载，不把 staging credential 带入 production。

出现迁移失败、RLS 回归、行数不一致、异常错误率、跨租户读写或备份校验失败时：

1. 立刻停止迁移和写流量，保留应用、数据库审计和发布 evidence；不要重试掩盖第一次失败。
2. 回滚应用到与最后一个已验证 schema 匹配的 release。不要把任意 SQL `down` 当作数据恢复。
3. 如数据可能被部分写入，先在临时数据库恢复最后一个 verified backup；比较每张业务表行数、
   关键记录和 schema revision，通过后再决定流量切换。
4. 只有 release owner、数据库 reviewer 和 incident commander 都确认，才允许切换到恢复副本。
5. 修复后的迁移必须使用新的单调 ID，不能重写已应用迁移或手工删除 migration receipt。

生产恢复演练命令：

```powershell
& .\script\postgres-recovery-drill.ps1 `
  -BackupFile "C:\path\to\verified-backup.dump.enc" `
  -ReportDirectory "artifacts/recovery-drills" `
  -PostgresBin "C:\Program Files\PostgreSQL\17\bin"
```

演练必须自动删除临时数据库，并保留 `97 tables / productionRows / restoredRows / mismatchCount`
等可复核结果；临时库残留、digest 不匹配或 mismatch 非零都阻断发布。

## 账单和租户边界

平台 quota/budget 只读取 `settled-runtime-usage` ledger。发布、重试、备份和迁移脚本不能自行
创建第二套 execution truth。tenant delete request 在执行器、对象存储和跨区域恢复就绪前只推进到
可审计、可批准状态；任何物理删除必须另有审批和恢复证据。
