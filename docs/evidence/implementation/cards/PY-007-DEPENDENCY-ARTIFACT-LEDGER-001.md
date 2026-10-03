# Task Card: PY-007-DEPENDENCY-ARTIFACT-LEDGER-001

## 1. Identity

- Work package: PY-M0 / Dependency and Artifact Ledger
- Capability leaf: 清点 pyproject、Python entrypoints、package scripts、CI/PowerShell、packages/agent-python、desktop generated artifacts、`.venv` 与 import/spawn/launch 字符串
- Plan action: CONVERGE
- Legacy disposition: REPLACE/RETIRE/FIXTURE provisional per leaf; no runtime cutover or deletion
- Execution risk: E1
- Implementer: codex-gpt-5 / xhigh / current-context
- Reviewer: deterministic-dependency-ledger-validator / fresh command evidence; independent review remains required before CLOSED
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

生成 `legacy-python-dependencies.json`：逐文件记录 Python 依赖、入口、脚本、CI/PowerShell、import/spawn/launch 引用、generated artifact/`.venv` footprint、source digest、目标 TS owner、provisional disposition、关联工作包、验收证据与 OPEN 状态。此卡只建立事实账本，不删除或切换任何入口。

## 3. Existing owner / retained interface / reinforcement / bypass closure

- Existing owner: TS `package.json` scripts、`packages/cli`/`packages/arforge` command layer、`packages/server`/`packages/desktop` startup owners 和 Owner Registry。
- Retained interface: existing files are read-only evidence; Python launch strings remain visible until PY-006/PY-801/PY-901 cards prove replacement。
- Reinforcement: deterministic dependency marker extraction, exact source digests, artifact footprint records, launch-reference locations and no-runtime-growth findings。
- Bypass closure: no dependency installer, process launcher, Python bridge, fallback or deletion is introduced。

## 4. Scope

| Allowed path | Operation | Allowed symbols | Owner | Purpose |
|---|---|---|---|---|
| repository dependency/config/script files | read-only | N/A | PY-007 scanner | dependency/launch evidence |
| packages/agent-python/** | read-only | N/A | PY-007 scanner | legacy package footprint |
| packages/desktop generated artifact paths | read-only metadata/digest | N/A | PY-007 scanner | generated residue evidence |
| .venv/** if present | read-only metadata/digest | N/A | PY-007 scanner | environment footprint evidence |
| docs/evidence/implementation/legacy-python-dependencies.json | generate | N/A | PY-007 ledger | dependency artifact |
| docs/evidence/implementation/attestations/python-dependencies.v1.sha256 | create/update | N/A | Gate Owner | detached dependency digest |
| docs/evidence/implementation/cards/PY-007-DEPENDENCY-ARTIFACT-LEDGER-001.md | create | N/A | Dispatcher | frozen task card |
| docs/evidence/implementation/claims/PY-007-DEPENDENCY-ARTIFACT-LEDGER-001.json | create/update | N/A | Claim Writer | CAS claim |
| docs/evidence/implementation/state.json | update | ledger events/evidence only | Ledger Writer | claim/evidence handoff |
| script/arforge-python-dependencies-ledger.ts | create | scanner/validator/CLI | PY-007 ledger | deterministic read-only scanner |
| script/arforge-python-dependencies-ledger.test.ts | create | validator tests | PY-007 ledger | negative/positive tests |
| script/bunfig.toml | read | test root | Development governance | 定向 Bun 测试配置 |

## 5. Non-goals / boundaries

- 不安装依赖、不启动进程、不执行 Python/Bridge/Provider/MCP/DB，不修改 package scripts、CI、PowerShell、desktop artifact 或 `.venv`。
- 不删除、移动、重命名、commit、push、PR、联网、发布或部署。
- 不把发现到的引用自动判定为可删除；所有 leaves 初始 OPEN，PY-006/PY-801/PY-901 负责冻结、替换与删除门禁。

## 6. Validation

| ID | Phase | CWD | Exact command | Expected | Scope | Cache mode | Side-effecting | Max runs |
|---|---|---|---|---|---|---|---|---:|
| D001 | targeted | E:/Arforge-Agent | `bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-dependencies-ledger.test.ts` | all pass | focused | fresh | false | 3 |
| D002 | generation | E:/Arforge-Agent | `bun run script/arforge-python-dependencies-ledger.ts generate-python-dependencies-ledger --root . --write` | dependency/launch/artifact ledger generated without starting a process | scoped read + listed artifact | fresh | false | 1 |
| D003 | targeted | E:/Arforge-Agent | `bun run script/arforge-python-dependencies-ledger.ts validate-python-dependencies-ledger --root .` | exit 0 and no findings | focused | fresh | false | 2 |
| D004 | static | E:/Arforge-Agent | `bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-python-dependencies-ledger.ts script/arforge-python-dependencies-ledger.test.ts` | exit 0 | focused | fresh | false | 1 |
| D005 | review | E:/Arforge-Agent | `git status --porcelain=v2 --untracked-files=all -- docs/evidence/implementation/legacy-python-dependencies.json docs/evidence/implementation/attestations/python-dependencies.v1.sha256 docs/evidence/implementation/cards/PY-007-DEPENDENCY-ARTIFACT-LEDGER-001.md docs/evidence/implementation/claims/PY-007-DEPENDENCY-ARTIFACT-LEDGER-001.json script/arforge-python-dependencies-ledger.ts script/arforge-python-dependencies-ledger.test.ts` | only listed card-owned paths | focused | fresh | false | 1 |

World-state checks:

- All targeted dependency/config/script files are hashed; launch references include exact path and line.
- `.venv`, `packages/agent-python`, desktop generated artifact footprints and excluded snapshots are explicitly represented or explicitly absent.
- No scan path executes a command or imports Python; no new Python runtime reference is created.
- Ledger status remains OPEN and detached attestation matches normalized bytes。
- Pre-existing dirty file digests remain unchanged。

## 7. Stop conditions

- STOP-OWNER：dependency/entrypoint owner is not uniquely represented in Owner Registry。
- STOP-SCOPE：scan requires writing source, installing packages, starting processes or touching an unlisted artifact。
- STOP-RUNTIME：any Python/Bridge/Provider/DB/MCP execution occurs。
- STOP-DIRTY：pre-existing dependency or artifact digest changes during scan。
- STOP-CONTRACT：a launch reference cannot be represented without inventing a second ledger。
- STOP-REPEATED-FAILURE：same validation failure repeats twice without substantive change。

## 8. Deliverables / closure

- Deterministic dependency/launch/artifact ledger, detached digest, scanner/validator and negative tests。
- Final state is `REVIEW_PENDING`; independent reviewer and dispatcher control closure/release。
