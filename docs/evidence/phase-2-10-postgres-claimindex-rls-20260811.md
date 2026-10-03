# Phase 2.10 PostgreSQL ClaimIndex and RLS evidence

- Date: 2026-08-11
- Plan: `Arforge-最终详细实施计划-V2-2026-08-11.md`, Step 2.10
- Authorization: user authorized the complete Step 2.10 database operation sequence.
- Branch: `codex/phase-0-checkpoint`
- Scope: local PostgreSQL `arforge` and derived `arforge_ma`; no Git push.

## 1. Preflight before migration

`bun run db:topology:preflight` passed with credential-redacted output:

- Main database: `arforge`, PostgreSQL `17.10`, runtime role `arforge_app`.
- Multiagent database: `arforge_ma`, separate database, PostgreSQL `17.10`.
- Main public tables: `58`; Workflow Graph tables: `3/3`.
- Multiagent tables: `2/2` visible and writable to the application role.
- Main migration ledger ended at `20260804090000_runtime_insight`.
- Admin connection was configured and targeted both databases.
- `readOnlyInspection=true`, `schemaOrDataChanged=false`, `secretsPrinted=false`.

The initial preflight is also recorded in [phase-2-10-postgres-preflight-20260811.md](phase-2-10-postgres-preflight-20260811.md).

## 2. Administrator backups and restore drill

Custom-format dumps were created outside the repository at:

```text
%USERPROFILE%\AppData\Local\Temp\arforge-postgres-step-2-10-20260811
```

| Dump | Size | `pg_restore --list` entries | SHA-256 |
|---|---:|---:|---|
| `main.dump` | 95,996,332 bytes | 535 | `2DECB088E17893127509D07D6CD3AC929D47FC9B4FE29AB6A84D07B1380FBC3F` |
| `multiagent.dump` | 24,611 bytes | 24 | `9DE4FB70FB7CB4B2A3EC0B9A6AE2DF04EAEBAA890682BB63ED26124370029E29` |

Disposable databases `arforge_r210_20260811_main` and `arforge_r210_20260811_ma` were created, restored with `pg_restore --exit-on-error`, and then removed. Source and restored row counts matched for every table:

- Main: `58/58` tables; source and restored totals both `57,136`; mismatches `0`.
- Multiagent: `3/3` tables; source and restored totals both `72`; mismatches `0`.

The sanitized row-count manifest remains next to the dumps:

```text
%USERPROFILE%\AppData\Local\Temp\arforge-postgres-step-2-10-20260811\row-count-manifest.json
```

Its SHA-256 is `16D9999EAC6BFACFD1F65FF7C5A74AB6D08E8AE78CAA4A10E8E01F171D9425D2`.

## 3. Migration and runtime gates

The correct command was run after a harmless Bun argument-order correction:

```powershell
bun run --cwd packages/core db:migrate:postgres
```

Result: `Applied 1 PostgreSQL migration(s); schema is now 20260810100000_control_run_claim_index.`

The following gates passed:

```powershell
bun run --cwd packages/core db:audit:postgres-role
bun run --cwd packages/core db:smoke:postgres
```

- Role audit: `leastPrivilege=true`, `writeRoundTrip=true`; the application role had no superuser, createdb, createrole, replication, bypassrls, schema-create, or temporary-table capability.
- PostgreSQL smoke: `projects=2`, `sessions=132`, `memories=956`, `learningOutcomes=1204`, `learningPatterns=115`.

## 4. RLS acceptance

The first RLS run exposed two test-harness defects, both fixed in commit `c46c065b` without changing production migration SQL:

1. `constraint` was used as a PostgreSQL reserved-word table alias; it was renamed to `constraint_row`.
2. PostgreSQL returned the `text[]` metadata as a string through the driver; the query now emits explicit JSON arrays for the JavaScript assertion.

Core typecheck passed after the fix. The final command passed:

```powershell
bun run --cwd packages/core db:test:postgres-rls
```

Result: `28/28` checks passed and `cleanupVerified=true`, including:

- all `38/38` business tables force the tenant policy;
- same-tenant insert/read/update and cross-tenant read/update/delete isolation;
- forged tenant and owner rejection;
- ClaimIndex and alias ownership propagation;
- same-tenant owner and cross-tenant ClaimIndex isolation;
- composite alias foreign key `(tenant_id, owner_user_id, binding_digest)`;
- immutable alias request binding and unique claim generation;
- concurrent claim allocation admits exactly one generation;
- application role has only `SELECT` and `INSERT` on both claim tables;
- pooled connection does not retain tenant or user settings;
- application role cannot disable or alter RLS;
- temporary fixture cleanup leaves zero rows.

## 5. Final preflight and direct structural acceptance

The final `bun run db:topology:preflight` passed:

- Main public tables: `60` (the two ClaimIndex tables are now present).
- Migration ledger includes `20260810100000_control_run_claim_index`.
- Multiagent database remains separate with `23` tasks and `48` conversations.
- `multiagentPrivilegeRepairRequired=false`, `workflowMigrationRequired=false`, `adminConnectionRequired=false`.
- `readOnlyInspection=true`, `schemaOrDataChanged=false`, `secretsPrinted=false` for the final inspection.

A direct administrator read-only structural query returned `true` for every required predicate:

```text
ledgerHasClaimIndex
claimTableExists
aliasTableExists
claimForceRls
aliasForceRls
aliasCompositeFk
uniqueClaimGeneration
uniqueClaimOperation
uniqueClaimRun
appRoleNoSchemaCreate
appRoleNoBypassRls
appRoleNoAdmin
disposableMainAbsent
disposableMultiagentAbsent
```

## Conclusion

Step 2.10 is complete and its database acceptance criteria are satisfied. The verified backups remain outside the repository for the forward-only rollback policy. Step 2.11 Crash injection matrix has not yet started.
