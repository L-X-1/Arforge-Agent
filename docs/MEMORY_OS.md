# Memory OS foundation

Status: implemented governed-memory foundation  
Change authority: `openspec/changes/memory-os-foundation/`  
Database revision: `0005_memory_os`

## 1. Purpose and invariants

Memory OS is Arforge's single transactional boundary for durable cross-session
knowledge. It does not promise that every historical token is present in every
prompt. It guarantees that retained knowledge is identifiable, scoped,
versioned, auditable, correctable, recoverable, and measurable.

The invariants are:

- `memories` is the one authoritative current projection;
- every governed memory has a stable UID, class, lifecycle, confidence,
  version, content digest and bounded provenance;
- every mutation appends an immutable hash-chained revision in the same
  database transaction;
- normal recall sees only active, authorized records;
- correction creates a successor and preserves the superseded source;
- model/runtime-derived knowledge remains a candidate until an authorized
  decision activates or rejects it;
- retrieval telemetry never stores raw query text, memory content, or a
  plaintext workspace path;
- recalled content is untrusted data, never a policy instruction.

## 2. Ownership and convergence

| Boundary | Authoritative responsibility |
|---|---|
| `arforge/memory_os.py` | Domain validation, transactions, revisions, relations, lifecycle, recall telemetry, promotion |
| `arforge/memory.py` | Backward-compatible CRUD/governance projection over Memory OS |
| `arforge/semantic_memory.py` | Existing local deterministic ranker and compatibility response format |
| `arforge/core/memory_hook.py` | Prompt injection adapter; preserves the untrusted-data boundary |
| `arforge/core/learning_memory_bridge.py` | Active reviewed memory to learning-pattern projection with source UID/version |
| Cognitive Runtime journal | Immutable run evidence from which bounded candidates may be proposed |
| `arforge/product/service.py` / `arforge/bridge.py` | Validated JSON protocol surface for user decisions and telemetry |

`packages/core/src/memory.ts` remains the desktop Effect service/client
boundary. It must call the product bridge and must not become a second source
of cognitive history or revision truth.

## 3. Data model

Memory classes are `episodic`, `semantic`, `procedural`, `project`, `user`, and
`trajectory`. Lifecycle states are `candidate`, `active`, `superseded`,
`quarantined`, `forgotten`, and `rejected`.

Revision rows contain a canonical projection snapshot, operation, actor,
reason, prior-revision digest and revision digest. The chain can therefore
detect mutation, omission and reorder. It detects integrity failure; it does
not authenticate the writer. Authorization remains a Governance Plane duty.

Relations are typed as `supports`, `contradicts`, `supersedes`, or
`derived_from`, with status, confidence, bounded evidence, actor and reason.
Relations describe provenance and conflict without silently rewriting either
fact.

## 4. Mutation semantics

Use `MemoryOS.update(..., expected_version=N)` for metadata or same-fact edits.
An optimistic version mismatch rejects the whole transaction.

Use `MemoryOS.correct(...)` when a fact is wrong. Correction atomically:

1. creates an active successor with its own identity and first revision;
2. marks the old memory `superseded` and appends its revision;
3. creates a confirmed `supersedes` relation.

Use `forget` and `restore` for reversible user intent. Both append revisions,
and recall immediately excludes or re-includes the record. Use `delete` only
for explicit destructive removal: it deletes the projection, retained
revisions and relations, and redacts its identifiers from retrieval events.

Quarantine and decay from the legacy API now change governed lifecycle or
strength through the same domain boundary. Automatic decay never weakens an
explicit user memory.

## 5. Recall and measurement

`MemoryOS.recall` filters by lifecycle and project/workspace authorization
before deterministic local ranking. It returns algorithm, matched-term and
score-component provenance while preserving the existing
`memory.semantic_search` response shape.

Each real retrieval stores only a random retrieval UID, a hashed scope ID,
query fingerprint, algorithm version, counts, latency and bounded result
IDs/scores. `record_recall_feedback` accepts useful and irrelevant IDs only if
they were actually returned by that retrieval.

`recall_quality` reports actual empty-recall rate, mean result count, feedback
coverage, useful-recall rate, stale/inactive result rate and conflicting-result
rate. This report is explicitly separate from the existing synthetic
BM25 self-recall benchmark exposed as `memory.recall_quality`.

## 6. Cognitive promotion

`promote_from_journal` verifies the journal checksum chain and deterministically
replays Agent IR before writing anything. A run must be terminal and contain a
passed verification linked to bounded, non-confidential evidence and a durable
learning signal. All eligible signals are deduplicated and inserted in one
transaction as `candidate` memories.

Promotion provenance stores run ID, terminal journal position/checksum, task
ID, signal ID, verification IDs and evidence IDs. It does not copy raw tool
output. Candidates enter normal recall and the learning bridge only after
`activate_candidate`; rejection remains auditable and excluded.

## 7. Product protocol

Read-only protocol 1.2 methods:

- `memory.history {memory_id}`
- `memory.relations {memory_id}`
- `memory.actual_recall_quality {project_id?, workspace_path?}`
- existing `memory.search`, `memory.semantic_search`, facets and governance
  views remain compatible.

Explicit mutating methods require validated fields and use the product user's
fixed actor identity:

- `memory.correct {memory_id, expected_version, content, reason}`
- `memory.forget|restore {memory_id, expected_version, reason}`
- `memory.candidate.activate|reject {memory_id, expected_version, reason}`
- `memory.recall.feedback {retrieval_uid, useful_memory_ids?, irrelevant_memory_ids?}`

Callers cannot supply an actor through the bridge and therefore cannot
impersonate a runtime or policy authority.

## 8. Migration and recovery

Revision `0005_memory_os` adds governed columns to `memories`, backfills stable
identity/class/digest/defaults, creates revision/relation/retrieval tables, and
adds learning-pattern provenance. The multi-agent database advances its
revision marker without creating main-database memory tables.

For operational recovery:

1. stop writers and preserve the database plus Cognitive Runtime journal;
2. run the normal migration command to revision `0005_memory_os`;
3. call `verify_history(memory_id)` for affected records;
4. if a projection is suspect, use its verified revision snapshots and source
   journal provenance to diagnose it; do not edit revision rows in place;
5. correct, quarantine, forget, or explicitly delete through Memory OS;
6. re-run scoped recall and inspect actual-recall quality.

Downgrade removes Memory OS tables/columns and therefore loses revision and
telemetry data. Treat it as a maintenance rollback requiring a backup, not as
a routine runtime toggle.

## 9. Security and limits

Content and provenance pass storage sanitization and bounded validation.
Project/workspace filters are applied before ranking. Telemetry uses a scope
hash rather than a path and keeps query/content out of the event. Candidate
promotion refuses confidential or restricted evidence.

The foundation does not claim semantic truth, perfect recall, distributed
consensus, cryptographic author identity, or autonomous production evolution.
Those require later Governance, Context OS and Evolution Engine gates.
