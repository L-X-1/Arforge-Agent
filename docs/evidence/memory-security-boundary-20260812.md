# Memory candidate and maintenance boundary evidence

- Date: 2026-08-12
- Plan context: V2 Stage 5 memory governance hardening, completed before Step 6.6
- Branch: `codex/phase-0-checkpoint`
- Authorization: fail-closed; `auto`/`model` may create candidates only, and deletion requires an explicit maintenance authorization interface

## Enforced boundaries

`MemoryV2.create` continues to route automatic and model-originated writes into
the candidate/review lifecycle. `MemoryKernel.createActive` accepts only the
explicit user/imported source set. `MemoryKernel.promote` now requires both a
user actor and an explicit user/imported source, so a caller cannot reactivate a
candidate as `source: "auto"` or `source: "model"`.

The generic Core deletion methods were replaced with
`maintenanceDelete`/`maintenanceDeleteMany`. The old HTTP routes and endpoint
names were retired in favor of `/api/memory/maintenance/...` and
`memory.maintenanceDelete*`. The Server handler derives the maintenance
authority only from an authenticated owner/admin `IdentityContext`; anonymous,
member, or client-supplied authority flags do not authorize deletion. The
maintenance contract still requires expected-version matching, action ID,
redaction evidence ID, and a reason. In private server mode, the shared Server
authorization layer injects a fixed server-owned owner principal into the
request context after server authorization; that principal is not derived from
request headers or payload fields.

## Verification

```powershell
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client typecheck
bun run --cwd packages/core typecheck
bun test --cwd packages/core test/memory-policy.test.ts test/memory-retention.test.ts --max-concurrency=1 --parallel=1
bun run --cwd packages/arforge script/httpapi-exercise.ts --mode effect --include maintenanceDelete --fail-on-missing --fail-on-skip
git diff --check
```

Results: all four package typechecks passed; the policy and retention group
passed with `11 pass`, `0 fail`, and `32 expect()` calls. The two real HTTP
maintenance scenarios passed (`2 pass`, `0 fail`); whitespace validation also
passed. The larger `memory-kernel`, `memory`, and generated-client contract
test entry points remain blocked before assertions by the repository's existing
Bun loader cycle at `packages/core/src/config.ts:226` (`Cannot access 'node'
before initialization`); they did not produce assertion failures.
