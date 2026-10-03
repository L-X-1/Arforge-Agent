# Task Card: PY-002-CAPABILITY-LEDGER-001

## 1. Identity

- Work package: PY-M0 / Repo-wide Capability Ledger
- Capability leaf: 扫描 `arforge/` 的 487 个 Python 文件，以 symbol/callable/module 叶节点登记读写、副作用、消费者、处置、TS 目标 owner 与证据
- Plan action: CONVERGE
- Legacy disposition: FIXTURE/PORT/MERGE provisional per leaf; no Python runtime execution
- Execution risk: E1
- Implementer: codex-gpt-5 / xhigh / current-context
- Reviewer: deterministic-python-ledger-validator / fresh command evidence; independent review remains required before CLOSED
- Gate owner: Plan Owner（bootstrap whitelist 期间人工串行派工）
- Master plan revision/digest: v1.3 / external desktop plan digest recorded in state.json
- Protocol bootstrap manifest/digest: `docs/evidence/implementation/protocol-bootstrap.v1.json` / current digest recorded in state.json
- Owner registry/digest: `docs/evidence/implementation/owner-registry.v1.json` / `2a9a475cae2c50d90d8136e61213762d992db1de7eb6d3dee4af543697a2cf32`
- Source revision: 92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8
- Card size: LUNA-L-equivalent (generated evidence excluded from non-generated diff budget)
- Max product files: 0
- Max test files: 1
- Max non-generated diff lines: 1200

## 2. Objective

生成可重复的 `legacy-python-capabilities.json` 与 `legacy-python-files.json`：每个 Python 文件和每个定义叶节点都有 source digest、相对路径、行号、调用/导入线索、读写副作用、目标 TS owner、provisional disposition、关联工作包、验收证据和 OPEN/PARTIAL/CLOSED 状态。文件状态必须由叶节点派生，不能以文件级标签掩盖单体文件中的多种处置。

## 3. Existing owner / retained interface / reinforcement / bypass closure

- Existing owner: `owner-registry.v1.json` 中登记的 TS schema/service/store/writer/executor；本卡只引用，不建立第二 owner。
- Retained interface: Python source remains read-only evidence input; no Python import, subprocess, provider, DB writer or bridge is started。
- Reinforcement: deterministic scanner、stable leaf IDs、source digest、owner mapping、副作用 markers、generated artifact counts and validator。
- Bypass closure: generator has no execution branch; artifacts cannot be marked CLOSED by the scanner and no disposition is silently inferred from file name alone。

## 4. Scope

| Allowed path | Operation | Allowed symbols | Owner | Purpose |
|---|---|---|---|---|
| arforge/**/*.py | read-only | N/A | PY-002 scanner | Python source evidence input |
| docs/evidence/implementation/legacy-python-capabilities.json | generate | N/A | PY-002 ledger | capability leaf artifact |
| docs/evidence/implementation/legacy-python-files.json | generate | N/A | PY-002 ledger | file projection artifact |
| docs/evidence/implementation/attestations/python-ledger.v1.sha256 | create/update | N/A | Gate Owner | combined artifact digest |
| docs/evidence/implementation/cards/PY-002-CAPABILITY-LEDGER-001.md | create | N/A | Dispatcher | frozen task card |
| docs/evidence/implementation/claims/PY-002-CAPABILITY-LEDGER-001.json | create/update | N/A | Claim Writer | CAS claim |
| docs/evidence/implementation/state.json | update | ledger events/evidence only | Ledger Writer | claim/evidence handoff |
| script/arforge-python-ledger.ts | create | scanner/validator/CLI | PY-002 ledger | deterministic read-only scanner |
| script/arforge-python-ledger.test.ts | create | scanner/validator tests | PY-002 ledger | fixture and negative tests |
| script/bunfig.toml | read | test root | Development governance |定向 Bun 测试配置 |

## 5. Non-goals / boundaries

- 不运行 Python，不 import `arforge`，不启动 `.venv`、Bridge、Provider、MCP、DB writer 或 shell subprocess。
- 不修改 Python 源码或 `packages/*`，不删除、移动、重命名，不执行 commit、push、PR、联网、发布或外部副作用。
- 不把 scanner 的 provisional disposition 当成迁移完成；所有叶节点初始为 OPEN，后续卡必须给出行为证据后才能 PARTIAL/CLOSED。

## 6. Validation

| ID | Phase | CWD | Exact command | Expected | Scope | Cache mode | Side-effecting | Max runs |
|---|---|---|---|---|---|---|---|---:|
| P001 | targeted | E:/Arforge-Agent | `bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-ledger.test.ts` | all pass | focused | fresh | false | 3 |
| P002 | generation | E:/Arforge-Agent | `bun run script/arforge-python-ledger.ts generate-python-ledger --root . --write` | 487 Python files indexed; deterministic artifacts written | arforge read + listed generated paths | fresh | false | 1 |
| P003 | targeted | E:/Arforge-Agent | `bun run script/arforge-python-ledger.ts validate-python-ledger --root .` | exit 0 and no findings | focused | fresh | false | 2 |
| P004 | static | E:/Arforge-Agent | `bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-python-ledger.ts script/arforge-python-ledger.test.ts` | exit 0 | focused | fresh | false | 1 |
| P005 | review | E:/Arforge-Agent | `git status --porcelain=v2 --untracked-files=all -- docs/evidence/implementation/legacy-python-capabilities.json docs/evidence/implementation/legacy-python-files.json docs/evidence/implementation/attestations/python-ledger.v1.sha256 docs/evidence/implementation/cards/PY-002-CAPABILITY-LEDGER-001.md docs/evidence/implementation/claims/PY-002-CAPABILITY-LEDGER-001.json script/arforge-python-ledger.ts script/arforge-python-ledger.test.ts` | only listed card-owned paths | focused | fresh | false | 1 |

World-state checks:

- `python_file_count` equals the current sorted `.py` file scan and every file has a current SHA-256 digest。
- `capability_leaf_count` is stable for unchanged source; leaf IDs are unique and sorted。
- File status is the deterministic aggregation of its leaves; no file-level status hides a leaf。
- All target owners resolve to the existing TS Owner Registry; no Python path is a target owner。
- Combined artifact attestation matches normalized artifact bytes; pre-existing dirty digests remain unchanged。

## 7. Stop conditions

- STOP-OWNER：owner registry digest/path changes or a domain has no unique TS owner。
- STOP-SCOPE：scanner needs to write outside the listed generated/evidence paths or modify product code。
- STOP-DIRTY：existing user dirty Python path changes during scan。
- STOP-RUNTIME：any Python import/spawn/provider/DB/MCP side effect is attempted。
- STOP-CONTRACT：leaf requirements cannot be represented without inventing a second ledger。
- STOP-REPEATED-FAILURE：same failure repeats twice without substantive change。

## 8. Deliverables / closure

- Deterministic capability and file ledgers, combined detached digest, scanner/validator and negative tests。
- Final state is `REVIEW_PENDING`; only an independent reviewer and dispatcher may close this leaf or release the next claim。
