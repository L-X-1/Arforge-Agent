# Step 6.4 Worktree tool sealing evidence

- Date: 2026-08-12
- Plan: `Arforge-最终详细实施计划-V2-2026-08-11.md`, Step 6.4
- Branch: `codex/phase-0-checkpoint`
- Scope: local-only durable Worktree control, claim ownership, recovery, and packaged Windows acceptance

## Completed control-plane gates

The worktree create/remove/reset routes use a sealed snapshot and the
server-derived local principal. They claim through `ControlClaimIndex`, start
only an app-scoped detached scheduler, and return durable status identifiers.
The worker receives only the sealed snapshot, run lease, and gateway grant.
The legacy `WorktreeAdapter` is permanently blocked for create/remove/configure;
it cannot bypass the Action Gateway.

The existing PostgreSQL/RLS and packaged crash evidence remains authoritative:

- `docs/evidence/phase-2-10-postgres-claimindex-rls-20260811.md`
- `docs/evidence/phase-2-11-crash-injection-matrix-20260811.md`
- `docs/evidence/phase-2-12-packaged-e2e-20260811.md`

The packaged Windows acceptance is now wired into the Windows internal-alpha
workflow and uploads the sanitized acceptance reports with the unsigned
candidate artifacts.

## Verification

```powershell
bun test --cwd packages/arforge test/control-operation/effect-catalog.test.ts test/control-operation/service.test.ts test/control-operation/worktree-executor.test.ts test/control-operation/worktree-scheduler.test.ts test/control-operation/worktree-snapshot.test.ts test/control-operation/worktree-worker.test.ts test/server/httpapi-v2-location.test.ts
bun test --cwd packages/core test/plugin/models-dev.test.ts
bun run --cwd packages/core typecheck
bun run --cwd packages/arforge typecheck
git diff --check
```

Results: Worktree/control/location gate `41 pass`, `0 fail`, `225 expect()`;
ModelsDev strict-schema regression gate `2 pass`, `0 fail`, `6 expect()`;
both package typechecks and whitespace validation passed.

The ModelsDev regression was found by the location route gate: strict schema
materialization rejected optional catalog fields written as explicit
`undefined`. The fix omits absent API URLs, family, input limits, and cost
tiers while preserving provider-level URL projection.
