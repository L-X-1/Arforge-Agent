# Context OS foundation verification — 2026-08-03

## Outcome

Context OS is the verified final provider-input boundary for `ArforgeAgent`.
It converges existing compaction, token accounting, memory injection and session
checkpoint behavior without replacing their authoritative source records.

## Scenario evidence matrix

| OpenSpec scenario | Implementation | Executable evidence |
|---|---|---|
| Package round-trips | `ContextPackage.to_dict/from_dict/verify`, canonical JSON digest | `test_context_package_round_trip_and_tamper_detection` |
| Package is tampered | digest covers messages, manifest, budget, omissions and coverage | `test_context_package_round_trip_and_tamper_detection` |
| Compilation keeps sources unchanged and records provenance | deep-copy units, immutable JSON payloads and per-unit source digest | `test_context_compilation_does_not_mutate_sources`; memory/cognitive/checkpoint adapter tests |
| Optional context exceeds budget | stable layer/priority/recency/source-order selection and omission records | `test_budget_allocation_is_deterministic_and_records_omissions` |
| Mandatory context exceeds budget | `ContextBudgetError` before any truncation | `test_mandatory_overflow_fails_closed` |
| Budget intersects a tool round | adapter groups assistant call plus following tool results into one unit | `test_tool_round_is_atomic_at_budget_boundary`; message-adapter test |
| Protected facts are compiled | normalized final-message coverage independent of summary claims | `test_final_package_measures_protected_fact_coverage` |
| Untrusted source is included | derived summary/import/tool/memory trust labels and escaped data wrappers | message-adapter, memory-adapter and live-memory-boundary tests |
| Sensitive provenance is supplied | identifier-only provenance whitelist rejects raw content/path fields | `test_sensitive_or_unbounded_provenance_is_rejected`; adapter provenance assertions |
| Normal agent prepares provider messages | `ArforgeAgent.prepare_context_messages` always verifies a Context Package | `test_agent_prepare_context_routes_through_verified_package`; product bridge inspection test |
| Session resumes from checkpoint | checkpoint/message binding verification followed by fresh compile | `test_verified_checkpoint_is_recompiled_on_first_provider_prepare`; existing durable transcript/session resume suites |
| Active model window changes | fresh resolved budget/package/digest, unchanged source | `test_model_window_change_recompiles_without_mutating_source` |
| Recovery package is corrupt/stale | stale binding clears package telemetry, marks pending, then reports rebuilt | `test_session_restore_rejects_stale_package_binding_and_marks_rebuild`; `test_stale_checkpoint_binding_is_reported_as_rebuilt_after_compile` |

## Source and product convergence evidence

- `unit_from_memory_recall` uses measured retrieval identity and the established
  escaped untrusted-memory renderer; raw memory is absent from provenance.
- `unit_from_cognitive_state` validates Agent IR and binds it to task/journal
  position without copying raw tool output into provenance.
- `units_from_structured_checkpoint` verifies the checkpoint then binds units
  to checkpoint digest/event sequence/task.
- Legacy context modules explicitly identify themselves as compatibility/source
  helpers; no competing provider authority was added.
- Protocol 1.2 advertises `session.context.package`, which returns a live
  package only after integrity verification and otherwise returns bounded
  persisted telemetry.
- Inactive-session tests prove package telemetry remains available without
  falsely claiming that a live package exists.

## Fresh commands and results

| Command | Result |
|---|---|
| Pre-change context/checkpoint/session baseline (18 files) | `147 passed in 17.98s` |
| Final affected inventory (24 files) | `219 passed in 24.47s` |
| Full Python inventory | `3130 passed, 6 skipped in 383.52s` |
| Final Context OS/status/stream branch verification | `43 passed in 2.20s` |
| `python -m ruff check arforge tests` | passed |
| `openspec validate context-os-foundation --strict` | valid |
| Policy-term scan of 2,067 relevant source/spec/test files | `0 hits` |
| `git diff --check` | passed; only existing Windows LF/CRLF notices |

The final stale-recovery reporting branch was added after the full inventory;
it changes only the recovery-state label and passed the final focused
AgentCore/context/stream verification. No other production path changed after
the full run.

## Worktree boundary

The repository contained extensive pre-existing changes. Review and tests were
scoped to the cumulative Cognitive Runtime, Memory OS and Context OS work. No
files were staged, committed, reset, restored or archived, and the pre-existing
`arforge/core/signing_audit.py` edit was not modified.
