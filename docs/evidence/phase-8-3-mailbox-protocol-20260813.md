# Step 8.3 Mailbox / collaboration protocol evidence

Original implementation date: 2026-08-13

Independent hardening review: 2026-08-23

Status: core protocol complete; product-level multi-agent wiring remains out of scope for this step

## Requirement mapping

| Plan requirement                       | Current implementation                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| team/run/task/sender/recipient binding | `MailboxV2` validates one team, session durable run, task and two active team members before delivery.             |
| bounded schema                         | Summary, body, reason, reference arrays, inbox page size, kind and status are strict schemas with explicit bounds. |
| sequence/idempotency                   | Team-scoped monotonic sequence allocation and deterministic message identity reject divergent replay.              |
| artifact/evidence refs                 | Payloads carry typed artifact and evidence identifiers; no opaque capability field exists.                         |
| no raw secret                          | Summary/body/reason are redacted before persistence; secret-like idempotency keys are rejected.                    |
| durable acknowledgement                | Accepted, rejected and cancelled receipts are stored separately and can be recovered through `inspect`.            |
| cancellation/shutdown gate             | Closed runs/tasks and inactive members fail closed; sender or lead may cancel a queued message.                    |
| chat is not capability                 | Strict decoding rejects added `capabilities`, tool or authorization fields.                                        |

## 2026-08-23 hardening findings and fixes

The original protocol had two material completion gaps:

1. Run/task/member checks occurred before the message transaction. A concurrent cancellation or shutdown could pass the earlier check and race a later write.
2. Receipts were durable in storage but had no recovery read surface. The sender could miss the live event after a restart and had no supported way to inspect the final receipt.

The hardening pass now:

- locks and rechecks the durable run sequence, task row and participating member rows inside send/acknowledgement transactions;
- reconstructs the complete durable run through `DurableRun` while the aggregate sequence is locked, so unknown tails and corrupt history fail closed;
- returns an already-persisted send or acknowledgement on idempotent replay even after the run closes, without creating a second side effect;
- adds an authorized `Mailbox.Delivery` snapshot containing the message and optional durable receipt;
- permits sender, recipient or team lead to inspect delivery state after run/task closure;
- denies an unrelated active team member access to another pair's delivery state;
- preserves cancellation after task/run closure so queued work can still be shut down safely.

## Storage and event facts

- SQLite migration: `20260813125806_mailbox_protocol`.
- PostgreSQL migration: `20260813160000_mailbox_protocol`.
- PostgreSQL tables enable forced RLS, tenant/user isolation, revoke public access and grant the application role only select/insert/update.
- Live notifications remain `mailbox.message.sent`, `mailbox.message.acknowledged` and `mailbox.message.cancelled`.
- Durable recovery does not depend on receiving those live notifications; `inspect` reads the stored message and receipt.

## Fresh verification — 2026-08-23

- `bun test test/mailbox.test.ts` in `packages/core`: 7 passed, 0 failed, 35 assertions.
- Core regression across Mailbox, DurableRun, EventV2, TaskGraph and Team: 99 passed, 0 failed, 307 assertions.
- Schema package regression: 39 passed, 0 failed, 124 assertions.
- Product event-manifest regression: 2 passed, 0 failed, 13 assertions.
- `bun run typecheck` in `packages/schema`: passed.
- `bun run typecheck` in `packages/core`: passed.
- Targeted Oxlint: 0 warnings and 0 errors.
- Tests cover strict binding, recipient isolation, redaction, typed refs, deterministic replay, divergent idempotency conflict, concurrent sequence allocation, acknowledgement replay/conflict, durable sender recovery, post-closure inspection, unrelated-member denial, task cancellation, member shutdown, run cancellation and capability-field rejection.

The earlier 2026-08-13 migration/RLS checks remain historical evidence. This review does not claim a fresh PostgreSQL service run because no PostgreSQL test service was started in this work package.

## User-visible behavior and honest limits

This step delivers the internal collaboration protocol, not a user-facing inbox. The production scheduler currently has no `MailboxV2` caller and Step 8.2 intentionally remains single-agent without approved benefit evidence. Therefore:

- users should not yet see or manage agent-to-agent messages in the desktop app;
- the UI must not imply that multiple agents are actively collaborating;
- a future scheduler/A2A integration may consume this protocol only with delegated Child Run capabilities;
- Personal Workspace work must expose safe summaries and delivery states rather than raw event rows or message secrets.

Step 8.4 write-conflict control, Step 8.5 external A2A transport and Step 8.7 end-user workspace presentation remain separate work packages. No external network call, release, deployment or git push was made.
