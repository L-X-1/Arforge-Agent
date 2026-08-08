# Cognitive Runtime Foundation Verification — 2026-08-03

## Verdict

The `cognitive-runtime-foundation` change satisfies every declared OpenSpec
requirement and scenario. The implementation is additive, keeps the existing
Task Ledger and verification pipeline authoritative, and persists enough
semantic state to replay a governed single-agent run after restart.

This verdict covers the cognitive runtime foundation only. It does not claim
that the later Memory OS, Context OS, capability-learning, or controlled
evolution milestones are complete.

## Evidence summary

| Check | Fresh result |
|---|---|
| Pre-change compatibility baseline | `137 passed in 3.28s` |
| Final affected runtime and regression suite | `186 passed in 4.72s` |
| Ruff, affected paths | Passed |
| Ruff, `arforge/core` and `tests` | Passed |
| OpenSpec strict validation | `Change cognitive-runtime-foundation is valid` |
| Brand audit | `0 hits in 0 files`; 13,561 visited, 11,740 scanned |
| Complete Python test-file inventory | 280 of 280 files executed; `3073 passed, 6 skipped` |
| Diff whitespace validation | Passed |

The monolithic `python -m pytest tests -q` invocation exceeded the command
runner's 184-second bound before producing a final result. To preserve complete
coverage rather than silently narrowing it, the sorted 280-file inventory was
executed in six disjoint batches:

| Sorted test-file range | Result |
|---|---|
| 0–69 | `720 passed in 111.52s` |
| 70–139 | `911 passed in 62.91s` |
| 140–174 | `384 passed, 6 skipped in 61.47s` |
| 175–209 | `320 passed in 104.05s` |
| 210–244 | `409 passed in 57.20s` |
| 245–279 | `329 passed in 61.17s` |

The ranges are contiguous and non-overlapping, so every test file under
`tests/` is represented exactly once.

## Requirement and scenario traceability

### Agent IR V2

| Requirement/scenario | Implementation | Verification |
|---|---|---|
| Versioned typed task document | `arforge/core/cognitive_ir.py` | `test_create_task_has_stable_v2_envelope`; `test_all_typed_records_round_trip_without_semantic_loss` |
| Epistemic provenance | Evidence references and explicit hypothesis verification state | `test_missing_evidence_reference_reports_record_path`; `test_hypothesis_without_evidence_remains_explicitly_unverified` |
| Deterministic validation | Canonical JSON/digest, global record IDs, numeric and enum constraints | canonical digest, confidence-bound, duplicate-ID, governed-risk tests |
| Forward-compatible extensions | Namespaced `extensions` retained; governed fields remain closed | unknown-extension round trip and unknown-risk rejection tests |
| Existing planning/verification convergence | `arforge/core/cognitive_adapters.py` | four adapter tests cover import, export, provenance, and collision-free repeated import |

### Governed cognitive run lifecycle

| Requirement/scenario | Implementation | Verification |
|---|---|---|
| One lifecycle vocabulary | `arforge/core/cognitive_lifecycle.py`; extended `RunState` | governed-path, enum-parity, and compatibility-path tests |
| Understanding, blocked/replanning, learning | Governed transition graph and `AgentRun` integration | `test_governed_lifecycle_covers_understanding_learning_and_completion`; block/replanning test |
| Durable transitions | Journal append occurs before observer callback | `test_callback_failure_does_not_erase_durable_transition` |
| Verification-gated completion | Completion requires verification state; an explicit failed, non-waived result synthesizes an incomplete outcome if the loop omitted one | invalid-completion, explicit-failed-verification, and stubbed end-to-end tests |
| Rollback has a distinct outcome | `ROLLED_BACK` is not conflated with `FAILED`; rollback outcome is a validated journal audit event | direct lifecycle, execute-path success/failure, and rollback replay tests |
| Production coordinator integration | Workspace-scoped persistence root passed to `AgentRun` | coordinator persistence test |

### Append-only event journal

| Requirement/scenario | Implementation | Verification |
|---|---|---|
| Monotonic optimistic append | sequence check plus expected-sequence conflict | monotonic append and stale writer tests |
| Single-writer exclusion | thread lock plus adjacent exclusive lock file | second-writer exclusion test |
| Integrity-verifiable replay | canonical hash chain, strict signed envelope, identity checks | modified payload, truncation, identity mismatch, and unsigned-field tests |
| Bounded/minimized payloads | 64 KiB ceiling and bounded adapter metadata | payload-limit and adapter tests |
| Deterministic projection | `arforge/core/cognitive_runtime.py` | repeat replay, state-source mismatch, illegal-transition, record-status, and checkpoint-marker tests |
| Safe event evolution | non-critical namespaced events are ignorable; unknown critical events fail closed | deterministic replay fixture and unknown-critical-event test |

### Structured task checkpoints

| Requirement/scenario | Implementation | Verification |
|---|---|---|
| Semantic restart state | `arforge/core/structured_checkpoint.py` stores task, unresolved work, next actions, files, budgets, rollback and messages | semantic round-trip and stubbed restart replay tests |
| Atomic, retained versions | temp file, flush/fsync, replace, bounded retention | retention test |
| Integrity and fallback | schema and digest verification; newest valid fallback | corrupt-latest and unknown-schema tests |
| Journal consistency | checkpoint cannot claim an unverified future journal position | beyond-journal test |
| Honest legacy migration | legacy message checkpoint is marked semantically unavailable instead of inventing task state | legacy migration test |

## Compatibility and worktree review

- Existing public `AgentRun`, `RunResult`, Task Ledger, trace, transaction, and
  rollback APIs remain available; cognitive fields and persistence are additive.
- The existing Task Ledger remains the execution plan source. Agent IR adapters
  mirror it rather than introducing a competing planner.
- Existing run verification output remains the verification source. It is
  imported as typed evidence rather than reimplemented.
- Cognitive persistence is workspace/profile scoped by a stable hash and does
  not expose the plaintext workspace path in its directory name.
- Pre-existing unrelated dirty worktree changes were not staged, committed,
  reverted, or overwritten.
- Trellis-generated editor/runtime templates that were unrelated to the product
  change were removed; only the task evidence under `.trellis/tasks/` remains.

## Residual boundaries

- Multi-agent synthesis has not yet been projected into one shared Agent IR;
  the governed persistence path currently covers single runs and coordinator
  worker runs.
- The journal is an execution source of truth, not a long-term semantic memory
  store. Memory promotion, contradiction handling, forgetting policies, and
  retrieval metrics belong to the next Memory OS milestone.
- Context compilation may consume checkpoints and memory later, but it must not
  rewrite or replace the journal.
- Self-improvement remains disabled by design until isolated candidate
  generation, replay evaluation, gates, rollout, and rollback are implemented.
