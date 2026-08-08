# Controlled Evolution Engine verification — 2026-08-03

## Scope

Change: `openspec/changes/controlled-evolution-engine/`

Implemented and verified:

- immutable, digest-addressed strategy candidates;
- optimistic lifecycle state and hash-chained audit;
- non-evolvable Constitution Kernel and human-only deployment authority;
- bounded learning-pattern and dogfood opportunity mining;
- temporary-workspace, digest-bound evaluation using existing self-correction contracts;
- deterministic canary/control selection and real STOP outcome monitoring;
- evidence-gated promotion and immediate/manual or automatic rollback;
- learning-hook, Context OS, ProductService and bridge convergence.

Source-level self-modification is explicitly not in this foundation.

## TDD evidence

Initial collection failed as expected because
`arforge.core.evolution_runtime` did not exist. After the candidate/state core
was implemented, `tests/test_evolution_runtime.py` passed 16 cases. Integration
then failed specifically on the missing learning-hook adapter and incorrect
Context OS trust elevation; both boundaries were implemented before the suite
passed. Additional review added control-cohort safety attribution and subsystem
fault-isolation tests.

Final focused evolution/integration total: 25 tests across:

- `tests/test_evolution_runtime.py` (17);
- `tests/test_evolution_integration.py` (6);
- `tests/test_evolution_product_bridge.py` (2).

## Scenario mapping

| Required behavior | Implementation | Verification |
|---|---|---|
| Tamper-evident immutable candidate | manifest canonical digest and derived `ev-` ID | manifest tamper rejection test |
| Constitution cannot evolve | `ConstitutionKernel.ALLOWED_TARGETS` and protected prefixes | seven protected-target cases |
| No self-approval | human actor gate for approval/deployment | runtime actor approval rejection |
| Stale client cannot mutate | expected lifecycle revision | stale approval conflict test |
| Report cannot move across artifacts | candidate/report digest binding | report tamper rejection test |
| Exact artifact evaluated away from profile | temporary materialization and cleanup | isolated workspace lifecycle test |
| Existing regression contracts reused | `self_correct_eval_tasks()` through capability evaluator | default bridge evaluation test |
| Existing learning remains source of truth | read-only proposal by `LearningPattern.id` | unchanged-pattern integration test |
| Dogfood failure mining is privacy-bounded | category/stop/count/run reference only | no task text leakage test |
| Canary is stable | SHA-256 cohort bucket | repeated 100-key cohort test |
| Promotion needs operational evidence | candidate/control sample and outcome gates | insufficient then passing promotion test |
| Candidate safety incident removes overlay | automatic monitor rollback | safety rollback test |
| Control incident is not misattributed | separate control safety metric | control safety attribution test |
| Rollback stops future injection | active-status filter | post-rollback empty context tests |
| Learning/evolution failures are isolated | separate hook error boundaries | learning storage failure integration test |
| Learned advice is not authority | Context OS prefix classification | trust/layer/mandatory assertions |
| Product operation is usable | version 1.2 read/mutation methods | bridge lifecycle tests |
| Full loop works | self-correct evidence through rollback | end-to-end integration test |

## Commands and results

Baseline before implementation:

```text
pytest -q <self-correct/learning/capability/product/memory selection>
107 passed in 50.76s
```

Final focused and adjacent regression:

```text
pytest -q <evolution/learning/context/product/capability selection>
96 passed in 13.95s

pytest -q <expanded affected selection>
221 passed in 66.75s
```

Static and contract validation:

```text
ruff check <changed Python and tests>
All checks passed!

python -m compileall -q <changed Python>
passed

openspec validate controlled-evolution-engine --strict
Change 'controlled-evolution-engine' is valid
```

Final repository regression (repository root must be importable, so the stable
entry is `python -m pytest` rather than the environment's standalone
`pytest.exe` launcher):

```text
python -m pytest -q
3156 passed, 6 skipped in 384.87s
```

Delivery checks:

- tracked relevant `git diff --check`: no whitespace errors (line-ending
  conversion warnings only);
- new-file trailing-whitespace scan: zero issues after correction;
- evolution policy scan: no subprocess, shell, file-edit tool, permission-set,
  security-set or audit-disable execution imports/calls;
- relevant staged-file query: empty;
- no commit, push, staging or branch mutation performed.

## Residual boundary

The audit hash chain detects tampering but does not authenticate actor identity.
The desktop profile already enforces a one-writer Sidecar contract; a future
distributed deployment needs signed approvals and a transactional shared store.
Source/skill package evolution additionally needs disposable worktrees,
supply-chain checks, signed artifacts and binary/process rollback before it can
be authorized.
