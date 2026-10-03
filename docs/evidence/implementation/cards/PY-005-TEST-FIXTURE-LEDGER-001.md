# Task Card: PY-005-TEST-FIXTURE-LEDGER-001

## 1. Identity

- Work package: PY-M0 / Test/Fixture Ledger
- Capability leaf: 逐一盘点 Python `test*.py`/`*_test.py`、`legacy_script` 与 acceptance 资产，分类为 TS unit/property/crash/race/golden、语言无关 fixture 或 RETIRE
- Plan action: CONVERGE
- Legacy disposition: FIXTURE/PORT/RETIRE provisional per test leaf; no Python oracle execution
- Execution risk: E1
- Implementer: codex-gpt-5 / xhigh / current-context
- Reviewer: deterministic-test-fixture-ledger-validator / fresh command evidence; independent review remains required before CLOSED
- Gate owner: Plan Owner（bootstrap whitelist 期间人工串行派工）
- Master plan revision/digest: v1.3 / external desktop plan digest recorded in state.json
- Protocol bootstrap manifest/digest: `docs/evidence/implementation/protocol-bootstrap.v1.json` / current digest recorded in state.json
- Owner registry/digest: `docs/evidence/implementation/owner-registry.v1.json` / `2a9a475cae2c50d90d8136e61213762d992db1de7eb6d3dee4af543697a2cf32`
- Source revision: 92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8
- Card size: LUNA-L-equivalent (generated evidence excluded from non-generated diff budget)
- Max product files: 0
- Max test files: 1
- Max non-generated diff lines: 1000

## 2. Objective

生成 `legacy-python-tests.json`，为每个 Python 测试文件和每个测试定义叶节点记录 source digest、测试类型、fixture/运行时依赖、TS 目标策略、处置、关联 owner、工作包与证据；文件投影由叶节点派生，全部初始为 OPEN。

## 3. Existing owner / retained interface / reinforcement / bypass closure

- Existing owner: `packages/core`、`packages/arforge`、`packages/app`、`packages/server` 的现有 TS test owners；Owner Registry 是唯一业务 owner 输入。
- Retained interface: Python tests remain read-only behavior evidence; fixtures move only in later PY-705 cards。
- Reinforcement: deterministic test classification, stable leaf IDs, digest-bound source/fixture metadata, explicit Python runtime dependency flags, target TS strategy and negative validator。
- Bypass closure: no Python test is run as an oracle by this card; no second evaluation writer or fixture registry is created。

## 4. Scope

| Allowed path | Operation | Allowed symbols | Owner | Purpose |
|---|---|---|---|---|
| tests/**/*.py | read-only | N/A | PY-005 scanner | test/fixture evidence input |
| arforge/**/*.py matching test/acceptance patterns | read-only | N/A | PY-005 scanner | legacy acceptance evidence |
| legacy_script/** matching test patterns | read-only | N/A | PY-005 scanner | legacy test evidence |
| docs/evidence/implementation/legacy-python-tests.json | generate | N/A | PY-005 ledger | test leaf artifact |
| docs/evidence/implementation/attestations/python-tests.v1.sha256 | create/update | N/A | Gate Owner | detached test-ledger digest |
| docs/evidence/implementation/cards/PY-005-TEST-FIXTURE-LEDGER-001.md | create | N/A | Dispatcher | frozen task card |
| docs/evidence/implementation/claims/PY-005-TEST-FIXTURE-LEDGER-001.json | create/update | N/A | Claim Writer | CAS claim |
| docs/evidence/implementation/state.json | update | ledger events/evidence only | Ledger Writer | claim/evidence handoff |
| script/arforge-python-tests-ledger.ts | create | scanner/validator/CLI | PY-005 ledger | deterministic read-only scanner |
| script/arforge-python-tests-ledger.test.ts | create | validator tests | PY-005 ledger | negative/positive tests |
| script/bunfig.toml | read | test root | Development governance | 定向 Bun 测试配置 |

## 5. Non-goals / boundaries

- 不运行 Python、pytest、legacy oracle、Bridge、Provider、DB writer、MCP 或 subprocess。
- 不修改 `tests/**/*.py`、`arforge/**/*.py`、`packages/*` 或任何产品运行时代码。
- 不执行 commit、push、PR、联网、发布、删除、移动或重命名。
- 不把测试名称或数量当成行为等价；所有叶节点初始 OPEN，后续 PY-701—704 负责冻结行为与转换证据。

## 6. Validation

| ID | Phase | CWD | Exact command | Expected | Scope | Cache mode | Side-effecting | Max runs |
|---|---|---|---|---|---|---|---|---:|
| T001 | targeted | E:/Arforge-Agent | `bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-tests-ledger.test.ts` | all pass | focused | fresh | false | 3 |
| T002 | generation | E:/Arforge-Agent | `bun run script/arforge-python-tests-ledger.ts generate-python-tests-ledger --root . --write` | all in-scope Python tests indexed; no `.codex-tmp` snapshot | scoped Python reads + listed artifact | fresh | false | 1 |
| T003 | targeted | E:/Arforge-Agent | `bun run script/arforge-python-tests-ledger.ts validate-python-tests-ledger --root .` | exit 0 and no findings | focused | fresh | false | 2 |
| T004 | static | E:/Arforge-Agent | `bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-python-tests-ledger.ts script/arforge-python-tests-ledger.test.ts` | exit 0 | focused | fresh | false | 1 |
| T005 | review | E:/Arforge-Agent | `git status --porcelain=v2 --untracked-files=all -- docs/evidence/implementation/legacy-python-tests.json docs/evidence/implementation/attestations/python-tests.v1.sha256 docs/evidence/implementation/cards/PY-005-TEST-FIXTURE-LEDGER-001.md docs/evidence/implementation/claims/PY-005-TEST-FIXTURE-LEDGER-001.json script/arforge-python-tests-ledger.ts script/arforge-python-tests-ledger.test.ts` | only listed card-owned paths | focused | fresh | false | 1 |

World-state checks:

- The scan is limited to tracked/workspace source roots and excludes `.codex-tmp` snapshots, `node_modules`, `dist`, `out`, `.venv` and bytecode caches。
- Test file and leaf counts match the current source scan; every source digest is current。
- Every leaf has a deterministic test type and TS strategy; every file status is derived from leaf status。
- No artifact claims Python oracle parity or CLOSED behavior。
- Detached attestation matches normalized artifact; pre-existing dirty digests remain unchanged。

## 7. Stop conditions

- STOP-OWNER：existing TS test/fixture owner cannot be identified without adding a second registry。
- STOP-SCOPE：scanner must write outside listed evidence paths or touch source/tests。
- STOP-RUNTIME：any Python test/fixture is executed。
- STOP-DIRTY：pre-existing test file digest changes during scan。
- STOP-CONTRACT：a test cannot be represented as a TS strategy or neutral fixture without semantic judgment。
- STOP-REPEATED-FAILURE：same validation failure repeats twice without substantive change。

## 8. Deliverables / closure

- Deterministic test/fixture ledger, detached digest, scanner/validator and negative tests。
- Final state is `REVIEW_PENDING`; independent reviewer and dispatcher control closure/release。
