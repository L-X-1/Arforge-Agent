# Controlled Evolution Engine foundation

Status: implemented bounded strategy-evolution foundation
Change authority: `openspec/changes/controlled-evolution-engine/`

## 1. Purpose

Controlled Evolution turns existing Arforge evidence into a reversible runtime
improvement loop:

```text
failure / verified learning
        -> inert candidate
        -> isolated evaluation
        -> explicit human approval
        -> deterministic canary
        -> real outcome monitoring
        -> promote or rollback
```

It is intentionally not unrestricted source-level self-modification. The
foundation can activate only bounded strategy advice. It never writes project
or Arforge source, changes permissions, grants tools, or edits its own release
gate. This makes the feature useful now without making the runtime its own
unreviewed administrator.

## 2. Existing subsystem convergence

| Existing subsystem           | Retained role in the closed loop                                          |
| ---------------------------- | ------------------------------------------------------------------------- |
| `core/self_correct.py`       | Classifies failures and supplies evidence fingerprints                    |
| learning tables/engine       | Supplies reviewed, repeated strategy opportunities                        |
| Memory OS                    | Retains governed long-term facts and candidate provenance                 |
| `core/dogfood.py`            | Supplies privacy-bounded real-run failure groups                          |
| Cognitive Runtime/run replay | Supplies inspectable run evidence and recovery references                 |
| `core/capability_eval.py`    | Runs existing deterministic self-correction regression contracts          |
| `core/run_transaction.py`    | Continues to own source/workspace edit rollback                           |
| `core/evolution_runtime.py`  | Owns strategy candidate identity, gates, overlay, monitoring and rollback |

There is no second learning database, evaluator framework, task journal or file
rollback implementation. Evolution Runtime stores only lifecycle evidence that
those existing systems do not own.

## 3. Constitution Kernel

The v2.0 kernel is code-owned, versioned policy. Its allowlist, permanent
protection list and human-actor classes are frozen runtime values; status APIs
return copies rather than references to those values. Durable proposal writes
bind the target and Constitution version to the candidate manifest, and reads
fail closed if a stored manifest crosses the boundary.

Ordinary candidates cannot target or amend:

- identity or ownership;
- permission, policy, approval or authority behavior;
- privacy, secret, credential or retention policy;
- audit or event integrity;
- evolution gates or the Constitution Kernel itself;
- source-write or repository authority;
- release or signing behavior;
- rollback behavior;
- hard budget limits.

Sandbox, security, network and egress controls remain protected as part of the
permission/policy boundary.

Deployable targets in this foundation are:

- `learning.failure`, `learning.fix`, `learning.preference`;
- `routing.advice`;
- `tool.advice`.

Only `strategy_rule` candidates exist. Creation and evaluation may be
automatic, but approval, canary start and promotion require an actor in the
`user:` or `admin:` authority class. A `runtime:` actor cannot approve itself.
Automatic rollback is allowed because it only removes capability.

### Evolution capability levels

Evolution capability levels are a separate contract from ActionGateway risk
tiers. Every canonical proposal and candidate manifest declares its Evolution
level, and lifecycle projections derive the effective level from durable
status:

| Level | Allowed boundary                                                      |
| ----- | --------------------------------------------------------------------- |
| L0    | Inert suggestions and reports only                                    |
| L1    | Reversible, explicitly non-security-critical runtime parameters only  |
| L2    | Prompt, workflow, or skill candidates and isolated offline evaluation |
| L3    | Isolated sandbox or bounded, reversible canary                        |
| L4    | Human/policy-approved controlled promotion with immediate rollback    |
| L5    | Autonomous core source modification or publishing; always forbidden   |

The level matrix is frozen and returned by the status API as a copy. Candidate
creation cannot declare `code`, L2 evaluation must be isolated, L3 cannot skip
the approved candidate state, and L4 cannot skip canary or controlled human
governance. Rollback reduces the effective candidate level back to L2 while
retaining immutable evidence.

## 4. Candidate integrity and state

Candidate content is canonical JSON containing its title, target, instruction,
rationale, evidence references, creator, timestamp and Constitution version.
Its SHA-256 digest derives the `ev-…` identifier. The manifest is immutable.

Mutable lifecycle state is kept separately with an optimistic revision:

```text
proposed -> evaluated -> approved -> canary -> promoted -> rolled_back
                  \-> rejected
```

Every client mutation supplies `expected_revision`. A stale operation changes
nothing. Evaluation reports bind candidate digest, materialized artifact,
cases, isolation mode and their own digest. Approval binds both report and
candidate digests, so evidence cannot be reused for another artifact.

The append-only audit uses a sequence and previous-record SHA-256 link. A
corrupt chain makes later audit appends and governed lifecycle operations fail
closed. Hashes detect mutation and reorder; identity authentication remains a
Governance Plane responsibility.

## 5. Evaluation

The default evaluator materializes the exact manifest in a fresh temporary
directory and then checks:

1. materialized candidate integrity;
2. Constitution Kernel target policy;
3. bounded, untrusted Context OS rendering;
4. conflict with any active candidate on the same target;
5. all existing deterministic self-correction capability contracts.

The temporary directory is removed before the report is returned. A custom
internal evaluator may add task/replay cases through `EvaluationCase`, but the
product bridge never accepts claimed pass/fail results from a caller. Candidate
impact is proven by the subsequent real canary rather than by self-reported
offline metrics.

## 6. Canary and operational evidence

Canary membership is `SHA-256(candidate_id + cohort_key) mod 100`, so a session
or task stays in the same cohort. The learning hook renders candidate-cohort
strategies as JSON inside `<untrusted_evolution_context>` and records both
candidate and control STOP outcomes. Context OS classifies this entire block as
optional `untrusted_derived` data, even though provider placement uses a system
message.

The default promotion gate requires:

- at least five candidate and five control observations;
- candidate success rate of at least 70%;
- candidate-control delta no worse than -5 percentage points;
- zero candidate-cohort safety incidents.

These defaults are explicit `EvolutionPolicy` fields. A control safety incident
is retained but is not attributed to a candidate that was not exposed.
Candidate-cohort safety incidents roll back immediately. Sustained candidate
health below the automatic rollback threshold also removes the overlay. A
rollback never deletes candidate, report, approval, observations or audit
evidence.

## 7. Persistence and recovery

```text
<arforge-data>/evolution/
  audit.jsonl
  candidates/<candidate-id>/
    manifest.json
    state.json
    observations.jsonl
    evaluations/<evaluation-id>.json
```

JSON documents use same-directory temporary writes and atomic replacement.
Loading verifies candidate, state and report bindings. Observation hashes are
checked before metrics or promotion. Corrupt evidence is never silently
skipped.

Disabling the learning hook stops strategy injection and monitoring without
changing stored evidence. Rolling back a candidate removes it from the next
provider context immediately. Removing the whole feature from a build leaves
learning, memory, dogfood, run replay and transaction rollback records intact.

## 8. Product bridge workflow

Read methods:

```text
evolution.status
evolution.candidates
evolution.candidate.get
evolution.opportunities
evolution.audit.verify
evolution.canary.report
evolution.context.preview
```

Lifecycle methods:

```text
evolution.candidate.create
evolution.candidate.from_pattern
evolution.evaluate
evolution.approve / evolution.reject
evolution.canary.start
evolution.promote / evolution.rollback
```

Example order:

1. inspect `evolution.opportunities`;
2. create a candidate or propose an existing learning-pattern ID;
3. call `evolution.evaluate` with revision 1;
4. inspect the digest-bound report;
5. approve revision 2 with a concrete reason;
6. start a bounded canary at revision 3;
7. wait for real STOP observations and inspect `evolution.canary.report`;
8. promote revision 4 only if all checks pass, or roll back.

No public method accepts fabricated observations or bypasses the human gate.

## 9. Later source-level evolution

Source or skill-package candidates should be a separate, stricter tier. Before
adding it, Arforge needs authenticated approvals, disposable worktrees or
sandboxes, historical project replay, supply-chain scanning, signed artifacts,
canary binaries, process-health supervision and tested release rollback. It
must reuse this candidate/report/audit model, but it must not widen the current
strategy overlay into arbitrary file writes.
