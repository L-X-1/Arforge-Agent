# Phase 2.10 PostgreSQL preflight evidence

- Date: 2026-08-11
- Plan: `Arforge-最终详细实施计划-V2-2026-08-11.md`, Step 2.10
- Scope: credential-redacted, read-only topology inspection only
- Commit branch: `codex/phase-0-checkpoint`

## Command

```powershell
bun run db:topology:preflight
```

## Sanitized result

- Private environment source: user profile; four variables loaded; no values recorded.
- Topology selection: derived multiagent target; main and multiagent are separate databases.
- Main target: `postgresql://localhost:5432/arforge`
  - PostgreSQL `17.10`
  - runtime role `arforge_app`
  - public tables: `58`
  - Workflow Graph tables: `3/3`
  - multiagent tables visible and writable: `2/2`
  - multiagent rows observed through the main connection: `tasks=0`, `conversations=0`
  - migration ledger currently ends at `20260804090000_runtime_insight`
  - ClaimIndex migration `20260810100000_control_run_claim_index` is not applied
- Multiagent target: `postgresql://localhost:5432/arforge_ma`
  - PostgreSQL `17.10`
  - runtime role `arforge_app`
  - public tables: `3`
  - multiagent tables visible and writable: `2/2`
  - existing rows: `tasks=23`, `conversations=48`
- Admin connection: configured and targets both databases through the local PostgreSQL administrator role.
- Required topology repairs: none reported by the preflight.
- Client: `C:\Program Files\PostgreSQL\17\bin\psql.exe`

## Safety result

The command reported `readOnlyInspection=true`, `schemaOrDataChanged=false`, and `secretsPrinted=false`. No backup, restore, migration, role audit, smoke test, or RLS test was executed in this step.

## Gate before continuing

The next planned operations are administrator backups of both databases, disposable restore drills with row counts, and then the forward-only ClaimIndex migration. Those operations require explicit authorization because they create backup artifacts, create/delete disposable database state, and change the main database schema.
