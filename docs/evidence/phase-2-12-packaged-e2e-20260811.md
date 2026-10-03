# Phase 2.12 Windows/Electron packaged E2E evidence

- Date: 2026-08-12
- Plan: `Arforge-最终详细实施计划-V2-2026-08-11.md`, Step 2.12
- Branch: `codex/phase-0-checkpoint`
- Package: freshly rebuilt and packaged Windows development candidate
- PostgreSQL: executed after explicit authorization for Step 2.12 packaged E2E

## Required local gates

All required local gates exited successfully:

```powershell
bun run --cwd packages/desktop typecheck
bun run --cwd packages/desktop test
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e
bun run --cwd packages/desktop build
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
bun run --cwd packages/desktop package:win
```

The desktop test gate reported `86 pass`, `0 fail`, and `224 expect()` calls.
Build output contained existing Vite warnings only; packaging exited `0`.

The focused Core Action Gateway regression gate reported `85 pass`, `0 fail`,
and `444 expect()` calls. Core and Server typechecks also exited successfully.

## Existing packaged crash acceptance

The existing crash acceptance was run three consecutive times with three fresh
isolated profiles against the final packaged candidate. All three runs exited
`0`. This covers the renderer-continuation crash path and verifies same-Run
recovery, attempt accounting, lease release, durable write evidence, and
durable result replay.

## Supplemental crash-boundary acceptance

The packaged boundary matrix is implemented in
`packages/app/e2e/desktop-crash-boundaries.acceptance.ts` and its sanitized
SQLite report is written to:

```text
%ARFORGE_REPO%\artifacts\desktop-step-2-12-crash-boundaries-audit.json
```

The PostgreSQL report is written to:

```text
%ARFORGE_REPO%\artifacts\desktop-step-2-12-crash-boundaries-postgres-audit.json
```

The final packaged candidate passed all four scenarios in three consecutive
fresh-profile PostgreSQL runs and three consecutive fresh-profile SQLite
runs:

| Scenario | Durable result |
|---|---|
| pending approval kill | restarted request was listed through HTTP, replied once, and the same Action settled; no side effect |
| authorized-before-spawn kill | restarted action settled successfully; artifact created once |
| effect-before-observation kill | restarted action became `blocked`; guarded artifact content and mtime remained unchanged |
| junction/reparse | outside target was not created; durable action was rejected/blocked |

The acceptance runner binds snapshot assertions to the current durable Run and
selects the backend explicitly. During PostgreSQL validation, the durable
EventV2 writer was corrected to use the transaction handle supplied by the
PostgreSQL transaction callback for both `event_sequence` and `event` writes;
this preserves the sequence/event atomicity required by the recovery reader.

The pending-approval case now proves the complete recovery path: the durable
Action survives restart, the recovered worker re-presents the approval through
the HTTP session route, a one-time reply reaches the waiting worker, and the
same Action settles without a duplicate side effect. The Permission pending
registry is shared across request-scoped location service instances for the
exact location, while durable Action state remains authoritative across a
process restart.

## Scope status

Step 2.12 is complete: the required local gates, packaged SQLite acceptance,
packaged PostgreSQL acceptance, four supplemental crash boundaries, and the
three-profile anti-flake requirement all passed. The PostgreSQL acceptance used
the existing local main database with unique temporary workspaces; it performed
normal test writes only, made no schema/migration changes, and performed no
cleanup or deletion of database data.

Step 2.13 remains pending and has not been claimed complete.
