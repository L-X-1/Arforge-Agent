# Step 7.11 — Promotion Gate evidence (2026-08-13)

## Conclusion

Evolution promotion is fail-closed and DB-only. L4 promotion is accepted only by the durable Promotion Gate after it reconstructs and verifies all current facts. The retired filesystem runtime cannot promote, including in test-only legacy write mode.

## Gate conditions

The shared gate requires all thirteen conditions at the same candidate revision:

1. Candidate artifact binding and immutable digest are valid.
2. Source Experience records are reusable, successful, and bound to completed durable Runs.
3. Source Evidence records are verified, non-instructional, and bound to those Runs.
4. Canonical source EvaluationResult rows exist, passed, and exactly match the signed provenance artifact.
5. Baseline and candidate evaluation digests are present and immutable.
6. Safety checks pass.
7. Permission checks pass without capability expansion.
8. Secret checks pass.
9. Egress checks pass.
10. Budget checks pass.
11. A different human principal explicitly approves the exact revision.
12. Canary cohorts and current observations meet policy with no unacceptable regression.
13. A verified rollback artifact/plan and the current policy version are bound into the receipt.

The resulting receipt binds the candidate, revision, artifact digest, source Experience/Evidence/Evaluation IDs, source provenance digest, evaluation envelope, canary report, rollback artifact, approver, policy snapshot, and transition digest.

## Provenance and tenant boundary

- `source-provenance.ts` builds a deterministic immutable artifact from typed Experience, Evidence, and EvaluationResult records.
- Every Experience must have one passed same-Run EvaluationResult, and its Evidence references must be covered by both records.
- Promotion reloads every source Run from durable storage and requires `completed` status.
- Promotion reloads every canonical EvaluationResult under the current tenant/owner and requires byte-equivalent encoded content.
- Runtime Evaluation writes and reads now explicitly use the current principal's tenant and owner, preventing cross-tenant fallback to the local identity.

## Replay and idempotency

- Evaluation creation is idempotent only for an exact same-ID replay; any result, report, database row, candidate state, or digest drift is rejected.
- Promotion recomputes mutable gate facts on first execution.
- An exact historical promotion replay verifies the stored receipt and transition integrity before returning the original result, so later canary observations cannot corrupt a valid replay.
- Forged receipt, transition digest, source artifact, source evaluation, evaluation envelope, policy, or observation data fails closed.

## Verification

The Step 7.11 focused suite passes 42 tests with 381 assertions across promotion-gate, source-provenance, durable/governed/exposure/runtime/candidate evolution, facade behavior, and tenant-scoped runtime evaluation. Core, schema, protocol, and server type checks are required again after formatting and generated-client refresh before checkpointing this step.

## Mutation coverage

Tests reject unverified Evidence, cross-Run provenance, failed or missing EvaluationResult, artifact-content tampering, non-completed source Runs, canonical EvaluationResult drift, failed gate facts, same-ID evaluation drift, forged receipts, stale policy data, unacceptable canary regression, and all legacy filesystem promotion attempts.
