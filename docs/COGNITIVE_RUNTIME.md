# Cognitive Runtime Foundation

This guide covers the usable V3 foundation added beneath the existing Arforge execution stack. It is the operational companion to [ARCHITECTURE_V3.md](ARCHITECTURE_V3.md).

## What it provides

- Agent IR V2: strict, model-independent semantic state;
- one governed lifecycle with a legacy compatibility mode;
- an append-only JSONL event journal with sequence and checksum verification;
- deterministic replay without an LLM or tools;
- versioned, atomic structured checkpoints tied to a verified journal position;
- explicit legacy message-checkpoint migration;
- adapters for the existing Task Ledger and `RunResult.verifications`;
- workspace-scoped persistence in `CoordinatorAgent` single-agent and worker paths.

It does not enable autonomous source modification, automatic evolution promotion, broad long-term personality memory, or raw chain-of-thought persistence.

## Agent IR usage

```python
from arforge.core.cognitive_ir import AgentTaskIR, Evidence, Hypothesis

task = AgentTaskIR.create(
    "Repair cache invalidation",
    task_id="task-cache-01",
)
task = task.with_record(
    Evidence(
        record_id="evidence-test-01",
        summary="The target test fails on Windows-style paths",
        source="pytest:tests/test_cache.py::test_windows_path",
        evidence_type="test_result",
        authority=1.0,
    )
)
task = task.with_record(
    Hypothesis(
        record_id="hypothesis-normalize-01",
        statement="The cache key skips path normalization",
        confidence=0.72,
        evidence_ids=("evidence-test-01",),
    )
)

payload = task.to_dict()
digest = task.digest()
```

Every mutator returns a new revision. Validation rejects missing references, duplicate identifiers, non-finite/out-of-range scores, invalid task identifiers, and unknown governed risk/state values before data can be journaled.

## Governed AgentRun

Direct legacy callers keep compatibility behavior by default. Opt into the stricter lifecycle and durable persistence together:

```python
from pathlib import Path

from arforge.core.agent_run import AgentRun

run = AgentRun(
    governed_lifecycle=True,
    cognitive_persistence_root=Path("/safe/profile/cognitive-runs/workspaces/abc123"),
)
run.agent = configured_agent
run.user_input = "Repair cache invalidation"
result = run.execute()

print(result.state.value)
print(result.cognitive_state)
print(result.structured_checkpoint)
```

Governed execution uses:

```text
created -> understanding -> planning -> executing -> verifying
         -> learning -> completed
```

It cannot jump from executing directly to completed. Incomplete work, blocking, approval, failure, interruption, rollback in progress, successful rollback, and rollback failure remain distinct states.

`CoordinatorAgent` enables the governed lifecycle for its single-agent and worker `AgentRun` instances. Unless a persistence root is explicitly supplied, it derives a stable 24-hex workspace identity from the normalized resolved workspace path and stores data beneath the active Arforge profile. The plaintext workspace path is not embedded in the storage directory name.

## Persistence layout

```text
<ARFORGE_HOME>/cognitive-runs/workspaces/<workspace-id>/<run-id>/
  events.jsonl
  events.jsonl.lock              # exists only while a writer appends
  checkpoints/
    <time-ns>-<checkpoint-id>.json
```

An event envelope contains schema version, event/run identifiers, sequence, timestamp, actor, type, payload, previous checksum, and checksum. Unknown envelope fields are rejected because otherwise they would sit outside the signed/checksummed contract. Unknown namespaced non-critical event types remain in the verified journal and older projectors ignore them deterministically. Unknown `task.*`, `state.*`, `record.*`, or `checkpoint.*` event types fail replay.

The default payload limit is 64 KiB. Journal structured summaries, digests, sensitivity labels, and artifact references. Do not journal credentials or unrestricted stdout/stderr just because they are available in a tool result.

## Recovery

Restore the authoritative projection from the event journal:

```python
from arforge.core.agent_run import AgentRun

restored = AgentRun(
    run_id="existing-run-id",
    governed_lifecycle=True,
    cognitive_persistence_root=workspace_cognitive_root,
)
task = restored.restore_cognitive_runtime()
```

For explicit checkpoint recovery:

```python
from arforge.core.run_event_journal import RunEventJournal
from arforge.core.structured_checkpoint import StructuredCheckpointStore

journal = RunEventJournal(
    workspace_root / run_id / "events.jsonl",
    run_id=run_id,
)
store = StructuredCheckpointStore(workspace_root, run_id=run_id)
load = store.load_latest(journal)

checkpoint = load.checkpoint
warnings = load.warnings
```

Recovery behavior:

1. verify complete JSONL lines, event shape, run identity, sequence, checksum links, and record checksums;
2. examine checkpoint versions newest first;
3. verify each checkpoint schema and digest;
4. require the checkpoint sequence/checksum to exist in the verified journal;
5. fall back to a prior valid version if the newest checkpoint is corrupt;
6. replay events after the checkpoint position (or replay from event zero when no snapshot is used);
7. validate the final Agent IR projection.

A structured checkpoint may omit messages and still provide semantic recovery. Messages are context input, not the source of task truth.

## Legacy checkpoints

Existing `arforge.core.checkpoint.Checkpoint` documents remain supported. Use `migrate_legacy_checkpoint()` to obtain an explicit compatibility view:

```python
from arforge.core.structured_checkpoint import migrate_legacy_checkpoint

view = migrate_legacy_checkpoint(existing_checkpoint)
assert view.semantic_state_available is False
```

The adapter preserves objective, messages, status, steps, and token use. It deliberately does not infer beliefs, hypotheses, decisions, evidence, or verification state from conversation prose.

## Task Ledger and verification convergence

`arforge.core.cognitive_adapters` is the only compatibility boundary required for the existing views:

- `import_task_ledger()` converts current TodoWrite-style steps to typed `plan_step` actions;
- `sync_task_ledger()` renders those plan actions back through the existing `TaskLedger`;
- `import_run_verifications()` converts current verification dictionaries into evidence-linked typed verification records.

This preserves the established planning UI and test runner. Agent IR is the semantic projection underneath them, not another planner or verifier.

## Failure handling

- Invalid lifecycle edges append no state event.
- A callback failure cannot erase an already accepted durable transition.
- A stale expected sequence fails before an append.
- An exclusive lock prevents two processes from writing the same run concurrently.
- A successful recovery changes the final run state to `rolled_back`.
- A rollback failure returns the run to `failed` and retains an explicit failure record.
- Legacy execution can disable the cognitive adapter without changing tool-loop, message-checkpoint, or run-transaction formats.

## Security limits

SHA-256 chaining detects corruption or post-hoc modification; it does not prove the identity or authority of the writer. Future Governance Plane work can sign verified event digests using the existing signing/audit facilities.

Agent IR and replay also do not grant tools. Capability tokens, permission policy, sandboxing, approvals, and credential mediation remain independent runtime controls. Replayed memory or event content must be rendered as untrusted data when compiled into a model prompt.

## Implemented boundary: Memory OS

The run journal is an immutable episodic execution ledger, not a general user memory database. Memory OS now projects selected verified events through a governed candidate gate into mutable active knowledge:

```text
verified run events
    -> candidate extraction
    -> sensitivity and scope checks
    -> provenance / contradiction / deduplication checks
    -> governed memory write
    -> hybrid retrieval and utility feedback
```

Raw events remain authoritative. Derived semantic/procedural memory can be corrected, superseded, reweighted, or rebuilt without rewriting history.

The concrete schema, lifecycle, recall telemetry, product methods and recovery
procedure are documented in `MEMORY_OS.md`.
