# V2 Phase 2.6 — Durable approval aggregate evidence

Date: 2026-08-11

## Decision

The durable source of truth remains the existing `ControlRun` and `Action`
event aggregates. No second approval table or in-memory approval aggregate was
introduced. `Authorizer` keeps only the live waiter needed to resume an
Effect; it is not sufficient to make an approval visible or to authorize an
effect.

## Implemented boundary

- `ActionGateway` passes the trusted `actionID`, `intentDigest`, and current
  `policyVersion` binding into every production control-plane authorization.
- Before `Authorizer.get`, `Authorizer.list`, or `Authorizer.reply` accepts a
  production control request, it reloads the durable Action and checks:
  - `awaiting_approval` state;
  - exact control subject, action name, canonical resources, and intent digest;
  - human authority and an `ask` policy decision at the bound policy version.
- Control actions with a `runID` additionally reload the durable ControlRun
  and require `awaiting_authorization`, the same subject, the same action ID,
  and the same operation policy version.
- A stale request after cancellation/supersession is removed from the
  presentation projection and its waiter is failed closed. A late reply is
  rejected and cannot authorize a terminal action or reach session
  permissions.
- Existing startup recovery remains the recovery source: the scheduler scans
  durable `awaiting_authorization` runs after startup/lease expiry and the
  worker re-presents the same durable action. Terminal/paused runs are not
  scheduled by the recovery scanner.
- HTTP approval list and operation status continue to expose safe DTOs only;
  raw authorization metadata is not returned.

## Verification

- `packages/core`: typecheck passed.
- Core Authorizer + ActionGateway: 86 tests passed, 456 assertions.
- `packages/arforge`: typecheck passed.
- Worktree scheduler + worker: 19 tests passed, 96 assertions.
- Experimental HTTP API: 11 tests passed, 108 assertions, including same
  durable identity re-presentation and safe approval/status behavior.
- `git diff --check` passed.

## Explicit non-scope

This step does not add PostgreSQL migrations, RLS changes, backup/restore
automation, or remote transfer. Those remain later plan items requiring their
own authorization boundary.
