# Phase 2.11 crash injection matrix evidence

- Date: 2026-08-11
- Plan: `Arforge-最终详细实施计划-V2-2026-08-11.md`, Step 2.11
- Branch: `codex/phase-0-checkpoint`
- Scope: Core durable action recovery plus packaged Windows desktop acceptance.
- PostgreSQL was not modified in this step; Step 2.10 remains separately evidenced.

## Implementation change

The matrix exposed a real recovery defect at the `side effect 中` boundary. A
persisted `ActionAttemptStarted` event remained active after restart, and the
gateway attempted to start attempt 2 without first closing attempt 1. The
durable reducer correctly rejected that history as corrupt.

`packages/core/src/action-gateway.ts` now closes an active recovered attempt
with a durable `ActionAttemptFinished` event whose outcome is `interrupted`,
records a recovery audit reason, reloads the current snapshot, and only then
applies retry-budget and next-attempt rules. This preserves uncertainty and
allows retry only when the action's idempotency/retryability contract permits
it.

The test matrix also validates the exact `ActionAttemptFinished` clock delta
and uses a deterministic idempotency ledger for side-effect assertions.

## Core matrix

The new `V2 Step 2.11 crash injection matrix` cases are in
`packages/core/test/action-gateway.test.ts`. Each case reconstructs the durable
event history visible after a process restart and verifies the same Run/Action,
no duplicate observable side effect, explicit terminal state, and recovery
audit semantics.

| Point | Injected boundary | Result |
|---:|---|---|
| 1 | before intent persist | fresh retry creates one canonical action and one effect |
| 2 | after intent persist, before approval | same action re-enters approval and executes once |
| 3 | after approval, before lease | existing verified grant is reused; no new action identity |
| 4 | after lease, before attempt | expired lease is taken over by one recovery worker |
| 5 | before side effect | attempt starts once and the effect settles once |
| 6 | during side effect | prior active attempt is closed as interrupted; committed idempotent effect is not repeated |
| 7 | after side effect, before observation | idempotency key prevents a second observable effect |
| 8 | after observation, before verification | durable observation is replayed without executing the operation |
| 9 | after verification, before settlement | verifying action settles and replays without executing the operation |
| 10 | after response success, before client continuation | covered by packaged desktop acceptance below |

## Validation

```powershell
bun run --cwd packages/core typecheck
bun --cwd packages/core test test/action-gateway.test.ts test/durable-run.test.ts
bun run --cwd packages/desktop build
bun packages/app/e2e/desktop-crash-recovery.acceptance.ts
```

Results:

- Core typecheck passed.
- DurableRun + ActionGateway: `120 pass`, `0 fail`, `583 expect()` calls.
- Desktop build completed successfully. Vite emitted existing chunking warnings
  and an existing duplicate source-map warning, but the command exited `0`.
- Packaged desktop crash acceptance exited `0` after rebuilding from the
  current source.

## Packaged point-10 evidence

The sanitized report is written by the acceptance to:

```text
%ARFORGE_REPO%\artifacts\desktop-real-crash-recovery-audit.json
```

Verified report facts:

- `packagedDesktop=true`
- `sameRunRecovered=true`
- `attemptsUsed=2`
- `providerRequestCount=4`
- `durableWriteArtifactVerified=true`
- `durableResultReplayVerified=true`
- `recoveredLeaseReleased=true`
- `desktopEvidenceVisible=true`
- `independentDurableVerificationVisible=true`
- renderer errors: `0`
- failed requests: `0`

The acceptance uses an isolated temporary profile, home, workspace, and local
provider fixture; its cleanup path removes them after the run.

## Conclusion

All ten Step 2.11 injection points have a passing verification path. The
Crash injection matrix is complete. The next planned step is V2 Step 2.12,
Windows/Electron packaged E2E gate expansion.
