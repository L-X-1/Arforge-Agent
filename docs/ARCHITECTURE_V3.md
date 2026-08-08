# Arforge Architecture V3

Status: frozen foundation boundary for the governed self-evolving runtime  
Change authority: `openspec/changes/cognitive-runtime-foundation/`  
Scope: cognitive runtime and Memory OS foundations; later Context OS, capability routing, and evolution build on these contracts

## 1. Product invariant

Arforge is a model-independent, evidence-driven, recoverable Agent Runtime. A model proposes interpretations and actions; the governed runtime owns validation, permission, execution, evidence, state, persistence, verification, and rollback.

```text
user / CLI / desktop / IDE
             |
             v
      Cognitive Kernel
  Agent IR + lifecycle + projector
             |
       +-----+------+----------------+
       |            |                |
       v            v                v
 Capability      Context OS     Governance Plane
 Amplifier      (foundation)    policy/approval/audit
       |            |                |
       +------------+----------------+
                    |
                    v
              Execution Plane
        tools / sandbox / Git / tests / MCP
                    |
                    v
          evidence + observations + outcomes
                    |
             +------+------+
             |             |
             v             v
          Memory OS   Evolution Engine
         (foundation)     (later)
```

The closed loop is:

```text
perceive -> model -> plan -> act -> verify -> remember -> learn -> propose evolution
```

Only the first six arrows needed for a dependable task runtime are enabled by the foundation. “Propose evolution” creates an inert, evaluable candidate; it never grants permission to alter production.

## 2. Layer ownership

| Layer | Owns | Must not own |
|---|---|---|
| Application | User intent, presentation, approval interaction | Runtime truth, tool credentials |
| Cognitive Kernel | Agent IR, lifecycle, state projection, goals, hypotheses, decisions, verification state | Direct filesystem/network effects |
| Capability Amplifier | Model profiles, routing, reasoning strategies, tool compensation | Final approval or self-certification |
| Context OS | Token-budgeted prompt compilation and task handoff | Destructive compression of original events |
| Memory OS | Durable event ledger, governed active knowledge, utility feedback | Treating inference as observation |
| Execution Plane | Sandboxed tools and effect results | Policy decisions or hidden credential expansion |
| Evolution Engine | Failure mining, candidate generation, replay/evaluation, canary proposal | Direct production self-modification |
| Governance Plane | Constitution, capability tokens, budgets, approval, audit, promotion/rollback gates | Model-generated relaxation of its own constraints |

## 3. Foundation modules

The foundation introduces four contracts.

### 3.1 Agent IR V2

Agent IR is the semantic boundary between probabilistic model output and deterministic runtime state. It contains:

- task identity, objective, schema version, revision, lifecycle state;
- goals and success criteria;
- beliefs and hypotheses with confidence and evidence references;
- evidence and observations with provenance and sensitivity metadata;
- proposed/accepted actions with risk, cost, target, and status;
- decisions with rationale and reversibility;
- verification results bound to criteria and evidence;
- learning signals derived from outcomes;
- inert evolution proposals with evaluation requirements.

Observed evidence, inference, hypothesis, preference, and policy remain different record kinds. A model cannot turn an unsupported hypothesis into historical fact by changing prose.

### 3.2 Governed lifecycle

The lifecycle is a superset of the existing `AgentRun` graph:

```text
created -> understanding -> planning -> executing <-> verifying
                  |              |           |
                  |              |           +-> learning -> completed
                  |              +-> waiting_approval -> executing
                  |              +-> blocked -> planning/executing
                  +-> failed/interrupted

failed/interrupted -> rolling_back -> rolled_back
rolling_back failure -> failed
```

Compatibility callers may continue using established paths such as `created -> planning -> executing -> completed`. The adapter records which richer phases were not exercised. Execution ending is not sufficient proof of completion: unresolved criteria produce `incomplete`, `blocked`, or `failed`.

### 3.3 Run event journal

State-changing facts are append-only events. Every event carries:

```text
schema_version, event_id, run_id, sequence, timestamp, actor,
event_type, payload, previous_checksum, checksum
```

The checksum is SHA-256 over canonical JSON excluding only `checksum`. Hash chaining detects mutation, missing records, reorder, and accidental corruption. It does not authenticate the author; Governance Plane signing is a separate later control.

The journal is the source of change. Deterministic replay rebuilds Agent IR without a model or tool call. Unknown namespaced, non-critical events remain auditable and may be ignored by older projectors. Unknown safety-critical enum values are rejected.

### 3.4 Structured checkpoint

A checkpoint stores a validated Agent IR snapshot plus the exact journal sequence/checksum. It also exposes recovery-focused fields:

```text
objective, completed, hypotheses, decisions, unresolved, next_actions,
files_touched, verification, budget, rollback_point, optional messages
```

Snapshots accelerate recovery but never override verified events. Writes are atomic and versioned; corrupt-latest recovery can select a prior valid snapshot. Existing message checkpoints remain readable through an explicit legacy adapter that reports semantic state as unavailable instead of inventing it from chat text.

## 4. Existing module convergence

| Current module | Retained responsibility | V3 convergence |
|---|---|---|
| `core/agent_run.py` | Public governed execution facade | Uses the superset lifecycle and emits cognitive events |
| `core/agent_loop_v2.py` / `core/agentic.py` | Provider/tool execution loop | Remains behind AgentRun; does not define semantic truth |
| `core/task_ledger.py` | Current plan UI/model tool | Imports/exports goal/action status through an adapter |
| `core/agent_trace.py` and loop trace | Operational progress | Produces referenced observations, not hidden reasoning history |
| `core/checkpoint.py` | Existing message resume | Becomes the legacy checkpoint adapter |
| `core/run_transaction.py` | File recovery and run rollback | Supplies rollback references and outcomes |
| `RunResult.verifications` | Existing verification evidence | Converts into typed verification records |
| `core/compaction.py` | Current prompt compression | Future Context OS input; cannot overwrite the event source |
| `memory.py` / memory tables | Compatibility CRUD and current projection | Governed by Memory OS; not replaced by the journal |

No second planner, verifier, rollback manager, or user-facing checkpoint list is introduced. New contracts sit underneath current entry points and allow gradual migration.

## 5. Core invariants

1. Runtime state changes only after deterministic validation.
2. Invalid transitions append no transition event.
3. Journal sequence and checksum links are continuous per run.
4. A checkpoint is valid only if its digest is valid and its journal position exists, except for explicitly labeled legacy checkpoints.
5. Raw events are not overwritten by summaries or checkpoints.
6. Evidence and observations are never silently promoted to beliefs or policies; conversions are explicit events with source references.
7. Completion is a verified state, not a model claim or loop stop reason.
8. Execution, verification, and approval authorities remain separable.
9. Evolution proposals are inert until replay, regression, safety, budget, approval, canary, and rollback gates succeed.
10. Constitution, user control, permissions, privacy, audit, and self-modification limits cannot be modified by the ordinary evolution path.

## 6. Persistence layout

The additive default shape is:

```text
<arforge-data>/cognitive-runs/<run-id>/
  events.jsonl
  writer.lock                 # transient, exclusive writer metadata
  checkpoints/
    <revision>-<timestamp>.json
```

Events prefer summaries, hashes, sensitivity labels, and artifact references over raw tool output. Credential material and unrestricted command output are never required for replay. Retention and maximum payload size are enforced by configuration.

## 7. Recovery algorithm

1. Resolve the run directory from a validated run identifier.
2. Read and verify the complete event stream: JSON shape, run identity, sequence, previous checksum, record checksum.
3. Load the newest digest-valid checkpoint whose journal position matches the verified stream; fall back through retained versions if necessary.
4. Project remaining events after the checkpoint position.
5. Validate the final Agent IR document and expose a recovery report.
6. Compile model context later through Context OS; do not inject raw journal records as trusted prompt instructions.

If no structured checkpoint exists, replay from event zero. If only a legacy message checkpoint exists, preserve existing resume behavior and mark semantic recovery unavailable.

## 8. Security boundary

- Model output is untrusted input to Agent IR validation.
- Recalled memory and journal summaries are untrusted data, not instructions.
- Checksums provide integrity detection, not identity or authorization.
- Capability tokens and policy gates authorize effects; task state does not grant tools.
- Actor identifiers, reasons, evidence references, and rollback points remain auditable.
- Cross-project data paths use validated run/workspace identifiers and never derive file paths directly from model text.

## 9. Staged delivery

### Foundation

Agent IR, lifecycle, journal, projector, structured checkpoints, existing-module adapters, recovery tests.

### Memory OS

Foundation implemented: mutable governed knowledge over the existing projection,
immutable revision chains, lifecycle and contradiction handling, scoped hybrid
retrieval, actual-recall metrics, and verified Agent IR candidate promotion.
See `MEMORY_OS.md`.

### Context OS

Foundation implemented: verified Context Packages, deterministic layered token
allocation, checkpoint/message provenance, protected-fact evaluation, live
provider-boundary integration, session recovery and model-switch recompilation.
See `CONTEXT_OS.md`.

### Controlled Evolution Engine

Foundation implemented for bounded strategy artifacts: immutable candidates,
the non-evolvable Constitution Kernel, learning/dogfood opportunity mining,
isolated digest-bound evaluation, explicit human approval, deterministic
canary cohorts, real STOP-outcome monitoring, promotion gates and immediate
rollback. Active advice remains optional untrusted-derived Context OS input;
the engine has no source-write or permission-expansion authority. See
`CONTROLLED_EVOLUTION.md`.

### Capability and evidence runtime

Model capability profiles, phase routing, reasoning strategies, ExecGate, scoped dynamic analysis, proof-carrying patches.

### Governed evolution

The bounded strategy tier is implemented. Later tiers add richer historical
project replay and authenticated, signed artifact release. Source-level
self-modification remains the last and most restricted tier and must use
disposable worktrees/sandboxes rather than widening the strategy overlay.

## 10. Rollout and rollback

Rollout is additive:

1. Land contracts and tests with persistence disabled by default for legacy callers.
2. Enable in-memory AgentRun projection.
3. Enable durable persistence in coordinator/CLI paths with integration evidence.
4. Migrate desktop recovery after structured checkpoint APIs are stable.
5. Retire legacy write paths only after an explicit later compatibility change.

Rollback disables the cognitive persistence adapter. Existing AgentRun, tool loop, message checkpoints, run transactions, and memory records remain intact. New event/checkpoint files are retained for audit and are not destructively migrated.
