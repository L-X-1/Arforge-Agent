# Memory OS foundation verification — 2026-08-03

## Outcome

The governed Memory OS foundation is implemented over the existing memory
projection and exposed through the product JSON bridge. No OpenSpec scenario is
accepted solely by inspection; every scenario below has executable coverage.

## Scenario evidence matrix

| OpenSpec scenario | Implementation | Executable evidence |
|---|---|---|
| Legacy create remains compatible | `memory.py:save_memory_v2`, `MemoryOS.create` | `test_legacy_save_and_update_use_the_same_governed_revision_chain` |
| Invalid governed values are refused | `memory_os.py:_validate_projection`, transactional create | `test_invalid_governed_create_is_atomic` |
| Legacy update creates governed history | compatibility update functions route to `MemoryOS.update` | `test_legacy_save_and_update_use_the_same_governed_revision_chain` |
| Failed write leaves projection/version unchanged | projection and revision share one session transaction | `test_revision_failure_rolls_back_current_projection` |
| Inactive memory is not recalled | active lifecycle filter precedes ranking | `test_recall_ranks_only_active_authorized_memories_with_score_provenance`, `test_unscoped_legacy_semantic_index_also_excludes_candidates` |
| Global user memory remains compatible | scoped query permits only active global `user`, `user-corrected`, or `imported` sources | `test_scoped_recall_preserves_active_global_user_memory_policy` |
| Revision chain verifies or identifies first corruption | canonical snapshot and SHA-256 previous-digest chain | `test_update_appends_verifiable_hash_chained_revision`, `test_history_verifier_reports_first_tampered_revision` |
| Concurrent stale update is rejected | optimistic `expected_version` check before mutation | `test_stale_expected_version_cannot_overwrite_or_append`, `test_bridge_candidate_decisions_require_expected_version` |
| User correction preserves both histories | `MemoryOS.correct` atomically creates successor, supersedes original and relates them | `test_correction_atomically_supersedes_original_and_recalls_successor` |
| Failed correction has no partial successor | one correction transaction | `test_correction_failure_leaves_original_active` |
| Contradiction remains reviewable | explicit relation creation without projection mutation | `test_contradiction_relation_never_changes_memory_state` |
| Forget and restore are reversible/revisioned | lifecycle transitions through `_change_lifecycle` | `test_forget_and_restore_are_reversible_revisioned_operations` |
| Explicit delete is complete | projection/history/relations removed; retrieval references redacted | `test_explicit_delete_removes_history_relations_and_retrieval_references`, `test_compatibility_delete_uses_complete_memory_os_cleanup` |
| Relevant active memories rank deterministically | existing local ranker over prefiltered scoped projection with score details | `test_recall_ranks_only_active_authorized_memories_with_score_provenance` |
| Empty query is bounded and private | bounded empty result plus fingerprint-only telemetry | `test_empty_recall_is_bounded_and_measured_without_raw_query` |
| Retrieval telemetry omits sensitive payloads | hashed scope/query fingerprint and bounded identifiers/scores only | `test_retrieval_telemetry_never_contains_raw_query_content_or_workspace_path` |
| Useful-result feedback affects actual metrics only | retrieval-bound feedback and actual-recall aggregator | `test_actual_recall_feedback_and_quality_are_not_synthetic_self_recall`, product bridge test |
| No feedback does not imply utility | zero coverage and useful rate remain zero | `test_empty_recall_is_bounded_and_measured_without_raw_query` |
| Verified completed run yields candidate | verified journal replay plus evidence/verification/signal gate | `test_verified_terminal_journal_produces_candidate_with_bounded_provenance` |
| Invalid promotion creates nothing | integrity, terminal and evidence gates precede a single write transaction | `test_nonterminal_or_unverified_journal_creates_no_candidate`, `test_corrupt_journal_creates_no_candidate`, `test_multiple_promotion_candidates_commit_atomically` |
| Candidate activation enables recall | explicit versioned candidate-to-active transition | `test_candidate_requires_explicit_activation_or_rejection` |
| Candidate rejection stays auditable and cannot learn | explicit rejected revision; learning bridge active-only filter | `test_candidate_requires_explicit_activation_or_rejection` |
| Old numeric thresholds cannot bypass lifecycle | active/reviewed gate plus UID/version provenance | `test_learning_bridge_skips_candidate_and_records_active_source_provenance` |

## Migration and interface evidence

- Fresh main schema, upgrade from `0004_cache_evidence`, governed backfill,
  learning-pattern provenance and multi-agent isolation:
  `tests/test_memory_os_schema.py`.
- Product protocol discovery, correction, history, relation, lifecycle, feedback,
  actual quality and stale-write rejection:
  `tests/test_memory_os_product_bridge.py`.
- Legacy semantic response compatibility and governed telemetry routing:
  `test_scoped_semantic_compatibility_api_routes_through_measured_recall`.
- Memory prompt injection continues to render recalled content as untrusted data:
  the existing `tests/test_memory_hook.py` inventory, included in affected and
  full-suite runs.

## Fresh commands and results

| Command | Result |
|---|---|
| Focused memory/cognitive/database/product inventory | `175 passed in 14.35s` |
| Atomic promotion and migration focused verification | `11 passed in 2.02s` |
| Final promotion/recall scenario verification | `14 passed in 1.78s` |
| Full Python inventory before the final two scenario-only tests | `3111 passed, 6 skipped in 396.98s` |
| `python -m ruff check arforge tests` | passed |
| `openspec validate memory-os-foundation --strict` | valid |
| Policy-term audit of 2,062 relevant source/spec/test files | `0 hits` |
| `git diff --check` | passed; only existing Windows LF/CRLF notices |

The two tests added after the full run exercise already-implemented global-user
scope and rejected-candidate behavior; they passed in the final focused run.
No production code changed after the full inventory.

## Worktree boundary

The repository had extensive pre-existing modified/deleted/untracked files.
Verification and review were scoped to the cognitive-runtime and Memory OS
change sets. No files were staged, committed, archived, reset or restored.
The pre-existing edit to `arforge/core/signing_audit.py` was not modified by
this change.
