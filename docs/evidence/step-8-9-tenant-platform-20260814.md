# Step 8.9 — 多租户平台实施证据

日期：2026-08-23

分支：`codex/phase-0-checkpoint`

范围：只验收本地功能开发与可交付性；不包含 Step 8.10/8.11 的发布、签名、canary 或部署。

## 当前结论

Step 8.9 的本地功能门禁已关闭：租户身份由认证上下文和数据库 membership 派生，业务输入不能
选择其他 tenant；PostgreSQL 使用事务内 principal、非 bypass 应用角色和 FORCE RLS；SQLite 保持
本地单用户兼容。租户策略、配额、限流、密钥、Provider 凭据、数据请求、备份清单和审计导出均有
持久化、授权、幂等/冲突和用户可见路径。

本轮质量审查额外关闭了以下真实缺陷：

- Provider credential 原先可落明文且同租户用户可互见；现使用租户 key ring 的 AES-256-GCM
  scoped envelope，并以 tenant、user、credential ID、purpose、key version 作为认证边界。
- tenant secret fingerprint 原先可由明文推导；现为密文指纹，缺失或已撤销 key 必须 fail closed。
- key version 原先可回退；现只能保持或单调递增。
- backup digest 原先可用不同 region/schema 伪装成幂等重放；现绑定策略区域、schema revision 和
  artifact digest，元数据分歧直接冲突。
- 本地 PostgreSQL advisory xact lock 原先不在事务中；现所有写操作先进入事务再加锁。
- “导出审计”原先只产生回执，用户拿不到文件；现返回并可下载 canonical JSON，回执摘要是文件
  精确字节的 SHA-256。导出排除 secret plaintext/ciphertext 和 data-request 原始理由。
- 数据请求拒绝原先不记录决策人；现批准和拒绝均持久记录 Owner/Admin 决策人。
- Electron 主进程的治理概览原先直接读取 `Bun.version`，导致桌面后端崩溃并使 E2E 无限等待；
  现兼容 Bun 与 Node/Electron，CDP 请求也有 60 秒硬超时。

## 计划项映射

| Step 8.9 计划项 | 已实现与验收 |
| --- | --- |
| tenant/user/project RLS | PostgreSQL FORCE RLS；tenant membership、project membership、session helper；credential 普通用户仅见本人，Owner/Admin 仅审计租户 metadata |
| per-tenant keys/secrets | tenant DEK 由现有 `SecretProvider` 包裹；secret/credential 使用 scoped AES-256-GCM envelope；数据库和 UI 不暴露明文或密文 |
| quota/budget/rate limit | 仅消费 settled runtime usage；settlement 幂等；quota 拒绝；tenant/bucket 限流；SQLite 写事务与 PostgreSQL tenant xact lock 防并发超卖 |
| region/data retention | region、retention_days、quota/rate/key version 进入 revisioned policy；region 实际约束 backup manifest；retention 范围 1–3650 天并在 UI 明示物理清理由授权维护执行 |
| admin vs app role | member 可创建数据权利请求；Owner/Admin 才能改策略、批准/拒绝、建/验备份、导出审计、写入/撤销 secret；服务端再次强制 |
| backup/restore | digest-bound manifest、验证状态机、AES 加密本地 PostgreSQL 备份脚本、隔离恢复数据库、逐表行数核对 |
| audit export | Owner/Admin 可生成 tenant-scoped canonical JSON、下载文件、校验 SHA-256，并持久保存 receipt；安全投影不含秘密值和原始请求理由 |
| deletion request | tenant-delete durable request、digest 幂等、Owner/Admin approve/reject、决策人审计；物理删除按 RFC 保持可恢复并留给授权维护运行 |
| noisy-neighbor tests | 并发 policy revision、quota、rate window、重复 request/backup、冲突审批，以及 PostgreSQL 跨租户/RLS 实网检查 |
| billing boundary | ledger 只接受 `settled-runtime-usage`，不调模型、不创建第二套 execution truth |

## 主要交付文件

- `docs/rfc/TENANT_PLATFORM_V1.md`：目标、非目标、加密/授权、失败与回滚边界。
- `packages/schema/src/tenant-platform.ts`：policy、usage、request、backup、可下载 audit artifact/receipt schema。
- `packages/core/src/tenant-platform.ts`：授权、事务锁、配额/限流、envelope、请求状态机、备份和安全审计导出。
- `packages/core/src/credential.ts`、`packages/core/src/credential/sql.ts`：Provider credential 加密、用户作用域和旧行惰性迁移。
- `packages/core/script/migrate-credential-envelopes.ts`：只输出数量、不输出凭据的本地迁移工具。
- `packages/core/src/database/migration/20260823015029_credential_tenant_envelope.ts`：SQLite credential envelope 列。
- `packages/core/src/database/postgres-migrations/20260823100000_credential_tenant_envelope/migration.sql`：PostgreSQL 列和 credential owner RLS。
- `packages/protocol/src/groups/tenant-platform.ts`、`packages/server/src/handlers/tenant-platform.ts`：9 个 tenant-platform HTTP 操作。
- `packages/app/src/components/control-center/governance-workbench.tsx`：策略、数据请求、备份、审计 JSON 下载和 secret metadata 的用户界面。
- `packages/app/e2e/desktop-evolution-visibility.acceptance.ts`：真实 Electron 用户路径与失联超时保护。
- `script/postgres-backup.ps1`、`script/postgres-recovery-drill.ps1`：加密备份、认证、restore-list 与隔离恢复演练。

## 可复现验证

```text
bun run --cwd packages/schema typecheck                       passed
bun run --cwd packages/core typecheck                         passed
bun run --cwd packages/protocol typecheck                     passed
bun run --cwd packages/server typecheck                       passed
bun run --cwd packages/client typecheck                       passed
bun run --cwd packages/sdk/js typecheck                       passed
bun run --cwd packages/desktop typecheck                      passed
bun run --cwd packages/app typecheck                          passed
bun run --cwd packages/app typecheck:e2e                      passed

ARFORGE_DB=:memory: bun test --cwd packages/core
  test/tenant-platform.test.ts test/tenant-audit-export.test.ts
  test/tenant-ownership.test.ts test/credential.test.ts
  test/integration.test.ts test/catalog.test.ts
                                                               33 pass, 0 fail, 296 assertions
bun test --cwd packages/server src/tenant-platform-openapi.test.ts
                                                               1 pass, 0 fail
bun run --cwd packages/core migration --check                  passed
bun run --cwd packages/app test:unit                           1036 pass, 0 fail, 3608 assertions
bun run --cwd packages/app test:browser                        32 pass, 0 fail, 75 assertions
bun run --cwd packages/app test:e2e:desktop:repeat             3/3 passed; no ignored flaky failure
```

最终桌面三轮耗时为 57,401 ms、57,289 ms、55,598 ms；每轮使用独立 profile。验收覆盖：

- member 创建数据请求，Owner/Admin 边界说明与批准/拒绝入口；
- backup region 自动继承策略、manifest 安全字段和 digest 校验；
- audit receipt、非零记录数、`.json` 文件名和明确的“下载 JSON”操作；
- 回执不显示 `tenant_id`、`created_at`、`export_digest` 等后端字段名；
- 工作流、记忆/学习、受控进化、插件/技能、Personal Workspace 和审批恢复的既有完整路径。

## PostgreSQL 实网证据

本机 PostgreSQL 17.10 数据库 `arforge` 使用 `arforge_app` 应用角色；未输出连接凭据：

```text
schema migration                                            through 20260823100000
PostgreSQL schema generator                                25 migrations / 406 statements
role audit                                                  passed; no superuser/create-role/create-db/bypass-RLS
smoke                                                       projects=2, sessions=320, memories=972,
                                                            outcomes=25, patterns=14
tenant platform live test                                   33/33 passed, cleanup residue=0
credential envelope migration                               present=0, migrated=0; no plaintext printed
```

33 项实网检查包含：应用角色 tenant transaction lock、跨租户 policy/secret/project/session/feedback/
usage/request/backup/audit 隔离、Provider credential 本人可见、Owner metadata 审计、伪造 owner 拒绝、
admin 审批和全部 fixture 清理。

## 备份与恢复证据

迁移前后均创建了加密备份，未覆盖原文件：

```text
pre-migration:  %USERPROFILE%\AppData\Local\Arforge\backups\postgresql\arforge-20260823-015255.dump.enc
post-migration: %USERPROFILE%\AppData\Local\Arforge\backups\postgresql\arforge-20260823-015416.dump.enc
encryption:     AES-256-CBC + HMAC-SHA256
verification:   checksum/authentication/pg_restore list passed
```

恢复演练报告：`artifacts/recovery-drills/postgres-recovery-20260823-015532.json`。

```text
passed=true
tableCount=98
productionRows=129
restoredRows=129
mismatchCount=0
```

## 明确不包含的边界

1. 用户已排除 Step 8.10/8.11 的发布部署，因此本证据不声明 signed artifact、SBOM、canary、SLO、
   staging 或 release-owner 人工签署完成。
2. RFC v1 不由普通 HTTP 请求执行不可逆的物理 tenant 删除；删除请求在批准后仍可恢复，实际清理必须
   由另一次明确授权、先验证备份的维护运行执行。
3. 不假设 hosted KMS、对象存储或付费签名服务；当前备份和审计文件是可测试的本地交付能力。
