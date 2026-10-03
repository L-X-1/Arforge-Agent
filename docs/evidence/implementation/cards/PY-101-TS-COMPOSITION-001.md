# Task Card: PY-101-TS-COMPOSITION-001

## 1. Identity

- Work package: PY-M1A / TS topology freeze
- Capability leaf: deterministic composition topology contract for `SessionExecution.Service`
- Plan action: CONVERGE
- Legacy disposition: N/A
- Execution risk: E1 (read-only source topology plus negative validation; no runtime route change)
- Implementer: gpt-5.6-luna / xhigh / current-context
- Reviewer: independent reviewer / fresh context required; Gate Owner remains required for later E2/E3 route work
- Gate owner: Plan Owner
- Master plan revision/digest: v1.3 / `a379cea65ff24270f96889e45e3db6d3a963fdb89cce16d9d2b028504b95b2e3`
- Protocol bootstrap manifest/digest: `docs/evidence/implementation/protocol-bootstrap.v1.json` / `9298a91d4b1845c7fc7cc3ef8fa1e55cdf7a351084581b09f32d20c5ff03d1a6`
- Source revision: `92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8`
- Workspace identity: `E:/Arforge-Agent` + `E:/Arforge-Agent/.git`
- Card size: custom-approved / LUNA-M (generated topology evidence excluded from non-generated diff budget)

### Authorization and tool boundary

- Upstream user authorization ref: current user instruction `接着继续` after explicit resume authorization `你帮我完成，然后恢复目标继续任务`
- Tool allowlist: read/search/apply_patch/shell/bun test/bun typecheck
- Network: DENY
- External process/service: `bun` and `bunx tsc` only for the exact validation commands in §11; no Python, provider, MCP, database, desktop or server startup
- Destructive action: DENY
- Git write/commit/push/PR: DENY
- Release/distribution: DENY

### Change and execution budget

- Max product files: 0
- Max test files: 1
- Max non-generated diff lines: 1200
- Max patch cycles: 4
- Max identical-failure retries: 2
- Max test runs per command: 3
- Max total tool calls: 24
- Max elapsed minutes: 45
- Max side-effecting validation runs: 0

## 2. Objective

生成并验证一份可重复的 `ts-session-composition.v1.json`，冻结当前 TS `SessionExecution.Service` 组合拓扑：所有已发现的 composition binding 必须通过 `SessionExecution.node` 绑定一个明确的实现，调用方不得直接调用 `SessionRunner.Service`。现有 Core executor 与成熟适配器中的直接 runner 使用只记录为后续 PY-102 的迁移输入，不在本卡切换或删除。

## 3. Non-goals

- 不修改 `packages/*` 产品源码，不改变 `AppNodeBuilder`、provider、runner、tool、action、database 或 desktop 路由。
- 不关闭 `drainScoped`，不执行 AF-DH-107、PY-708 readiness、cutover、rollback 或 Python 入口删除。
- 不把成熟适配器的暂存 runner 使用伪装为已完成的单 executor；该差异必须进入证据和 PY-102 handoff。
- 不发布、联网、启动外部服务、运行 Python 或写入数据库。

## 4. Authoritative owner

- Package: `packages/core`
- Service/module: `packages/core/src/session/execution.ts` / `SessionExecution.Service`
- Writer/lease authority: `EventV2.Service` and existing session execution coordinator; this card writes no runtime state
- Schema/event owner: `packages/core/src/session/schema.ts` + `packages/core/src/event.ts`
- Existing tool ID/API: `SessionExecution.node`, `SessionExecution.Service`

## 5. Current evidence

- TS implementation: Core `SessionExecution.Service` and local implementation; Arforge `SessionExecutionMature` adapter; server composition roots bind `SessionExecution.node` to `SessionExecutionMature.node` or `SessionExecutionLocal.node`.
- Python behavior source: PY-002/PY-005 ledgers only; no Python execution is permitted by this leaf.
- Direct callers: `packages/arforge/src/server/routes/instance/httpapi/server.ts`, `packages/server/src/routes.ts`, Core session execution implementations, and the mature adapter.
- Direct tests: Core runner tests and Arforge HTTP/session tests; this leaf adds a source-level topology fixture and negative bypass tests.
- Known gap: topology was documented in the owner registry but not machine-checked; a future PY-102 card must remove the mature adapter's credential/billing-to-Core `drainScoped` path after behavior parity evidence.

## 6. Preserve

- Public interfaces: `SessionExecution.Service`, `SessionExecution.node`, `SessionRunner.Service` internal implementation interface, and existing composition provider names.
- Durable behavior: no session/event/action/database behavior changes.
- Security/permission invariants: no new authority, writer, provider, tool registry, sandbox or sidecar.
- Error/cancel/recovery semantics: unchanged; no runtime calls are made by the scanner.

## 7. Implement

- Add a deterministic AST-backed source scanner and artifact validator.
- Record composition roots, exact `SessionExecution.node` bindings, provider implementation, direct runner service uses, public entrypoint references, source digests, and a PY-102 transitional handoff list.
- Fail validation when a non-canonical source calls `SessionRunner.Service`, when a composition binding has no provider, when a binding is outside an `AppNodeBuilder(.build)` call, or when the generated artifact/attestation is stale.
- Extend the governance evidence command list with the focused topology test and validator so the canonical evidence bundle binds command outputs to this card.

## 8. Remove or close

- Old bypass: no removal in this card; only non-canonical direct `SessionRunner.Service` calls are blocked by the validator.
- Removal in this card or future gate: the mature adapter's `drainScoped` branch is explicitly deferred to PY-102 and AF-DH-105/107 gates.
- Proof required before removal: parity corpus, credential/billing context propagation, negative tests, crash/restart/composition evidence, and Gate Owner approval; no claim of completion is made here.

## 9. Scope

| Allowed path | Operation | Allowed symbols | Owner | Purpose |
|---|---|---|---|---|
| `docs/evidence/implementation/protocol-bootstrap.v1.json` | modify | whitelist only | Dispatcher | authorize this single leaf |
| `docs/evidence/implementation/cards/PY-101-TS-COMPOSITION-001.md` | create/modify | N/A | Dispatcher | frozen task card |
| `docs/evidence/implementation/claims/PY-101-TS-COMPOSITION-001.json` | create/modify | N/A | Claim Writer | CAS claim |
| `docs/evidence/implementation/claims/BOOTSTRAP-PROTOCOL-001.json` | modify | manifest digest only | Ledger Writer | synchronize bootstrap claim |
| `docs/evidence/implementation/claims/PY-001-OWNER-REGISTRY-001.json` | modify | manifest/owner digest only | Ledger Writer | synchronize owner claim |
| `docs/evidence/implementation/claims/PY-002-CAPABILITY-LEDGER-001.json` | modify | manifest/owner/artifact digest only | Ledger Writer | synchronize capability claim |
| `docs/evidence/implementation/claims/PY-005-TEST-FIXTURE-LEDGER-001.json` | modify | manifest/owner/artifact digest only | Ledger Writer | synchronize test claim |
| `docs/evidence/implementation/claims/PY-007-DEPENDENCY-ARTIFACT-LEDGER-001.json` | modify | manifest/owner/artifact digest only | Ledger Writer | synchronize dependency claim |
| `docs/evidence/implementation/owner-registry.v1.json` | modify | manifest digest only | Owner Registry | rebind registry to the authorized manifest |
| `docs/evidence/implementation/legacy-python-capabilities.json` | generate | N/A | PY-002 ledger | rebind generated ledger to the current owner registry |
| `docs/evidence/implementation/legacy-python-files.json` | generate | N/A | PY-002 ledger | rebind generated projection |
| `docs/evidence/implementation/legacy-python-tests.json` | generate | N/A | PY-005 ledger | rebind generated test ledger |
| `docs/evidence/implementation/legacy-python-dependencies.json` | generate | N/A | PY-007 ledger | rebind generated dependency ledger |
| `docs/evidence/implementation/bootstrap/baseline-dirty-manifest.v1.json` | modify | dispatcher artifact digests only | Dispatcher | record new card and generated artifact digests |
| `docs/evidence/implementation/state.json` | CAS update | claim/event/evidence references only | Ledger Writer | claim, handoff and evidence state |
| `docs/evidence/implementation/bootstrap/status-porcelain-v2.v1.json` | generate | N/A | Governance | current card-owned status projection |
| `docs/evidence/implementation/bootstrap/fresh-validation-bundle.v1.json` | generate | N/A | Governance | command output evidence |
| `docs/evidence/implementation/ts-session-composition.v1.json` | generate | N/A | PY-101 scanner | deterministic topology artifact |
| `docs/evidence/implementation/attestations/protocol-bootstrap.v1.sha256` | generate | N/A | Governance | manifest detached digest |
| `docs/evidence/implementation/attestations/owner-registry.v1.sha256` | generate | N/A | Governance | owner registry detached digest |
| `docs/evidence/implementation/attestations/python-ledger.v1.sha256` | generate | N/A | Governance | PY-002 detached digest |
| `docs/evidence/implementation/attestations/python-tests.v1.sha256` | generate | N/A | Governance | PY-005 detached digest |
| `docs/evidence/implementation/attestations/python-dependencies.v1.sha256` | generate | N/A | Governance | PY-007 detached digest |
| `docs/evidence/implementation/attestations/status-porcelain-v2.v1.sha256` | generate | N/A | Governance | status detached digest |
| `docs/evidence/implementation/attestations/fresh-validation-bundle.v1.sha256` | generate | N/A | Governance | evidence detached digest |
| `docs/evidence/implementation/attestations/ts-session-composition.v1.sha256` | generate | N/A | PY-101 scanner | topology detached digest |
| `script/arforge-ts-composition-ledger.ts` | create | scanner/validator/CLI | PY-101 owner | topology scanner |
| `script/arforge-ts-composition-ledger.test.ts` | create | scanner/validator tests | PY-101 owner | targeted and negative tests |
| `script/arforge-governance.ts` | modify | fresh evidence specs only | Governance | bind PY-101 commands to canonical evidence |

- Forbidden paths: all product source/tests under `packages/*`, all Python source/runtime paths, `.venv`, generated desktop/server outputs, external services, Git objects, release paths.
- Forbidden architectural changes: second session loop, runner/provider selection in callers, second event/store/writer/tool registry, Python fallback, route switch, or deletion.

## 10. Prerequisites

- Required cards/gates: PY-001/PY-002/PY-005/PY-007 machine validators and independent review v3 ACCEPT; PY-101 is before PY-102/PY-105 and AF-DH-101—105.
- Fresh evidence: `docs/evidence/implementation/bootstrap/fresh-validation-bundle.v1.json` / `bb74421d8a5c4411d1b2e08ea41524ac0007b255274471e259a1879951d272e5` before this card's commands are appended.
- PY-708 readiness manifest/digest: N/A; this card cannot change an executor route.
- Baseline worktree identity/source revision: baseline manifest `docs/evidence/implementation/bootstrap/baseline-dirty-manifest.v1.json`, source `92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8`.
- `git status --porcelain=v2` ArtifactRef: `docs/evidence/implementation/bootstrap/status-porcelain-v2.v1.json`.
- Baseline dirty manifest digest: recorded in the current state/dispatcher baseline; pre-existing dirty files remain untouched.
- Pre-existing dirty path ownership: all existing dirty product paths remain baseline-owned; only paths in this card's allowlist may be card-owned.
- Initial card-owned delta: none before claim activation.

## 11. Validation

| ID | Phase | CWD | Exact command | Expected | Scope | Cache mode | Side-effecting | Max runs |
|---|---|---|---|---|---|---|---|---:|
| C001 | targeted | `E:/Arforge-Agent` | `bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-ts-composition-ledger.test.ts` | all tests pass | focused | fresh | false | 3 |
| C002 | generation | `E:/Arforge-Agent` | `bun run script/arforge-ts-composition-ledger.ts generate-ts-composition-ledger --root . --write` | deterministic artifact and attestation written | listed TS source roots | fresh | false | 1 |
| C003 | validator | `E:/Arforge-Agent` | `bun run script/arforge-ts-composition-ledger.ts validate-ts-composition-ledger --root .` | `valid=true`, no findings, no runner bypass | focused | fresh | false | 2 |
| C004 | static | `E:/Arforge-Agent` | `bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-ts-composition-ledger.ts script/arforge-ts-composition-ledger.test.ts` | no diagnostics | focused | fresh | false | 1 |
| C005 | governance | `E:/Arforge-Agent` | `bun run script/arforge-governance.ts validate-bootstrap --root .` | bootstrap gate remains `valid=true`, status `REVIEW_PENDING` | full governance | fresh | false | 2 |

| World-state ID | Observer | Before evidence | Expected transition | After evidence required |
|---|---|---|---|---|
| W001 | `git status --porcelain=v2` artifact | current status digest in state | only allowlisted card-owned paths are added; pre-existing digests unchanged | refreshed status artifact + attestation |
| W002 | topology artifact/attestation | absent | exact source digests, binding list and zero bypass list | `ts-session-composition.v1.json` + detached digest |
| W003 | state CAS | state version 5 / evidence bundle ref | claim transitions ACTIVE → REVIEW_PENDING with no runtime status change | state digest and fresh evidence bundle |

- Required property/crash/race/security/composition dimensions: deterministic regeneration, negative direct-runner bypass, unresolved binding, stale artifact/attestation, and exact source digest binding. Runtime crash/race/composition gates are explicitly deferred to E2/E3 cards.
- Expected outputs/invariants: `composition_root_count > 0`; every binding uses `SessionExecution.node` with one provider; `external_runner_service_uses=[]`; `status=OPEN`; no product file modified.

## 12. Stop conditions

- STOP-SCOPE: scanner needs product code, a second runtime owner, or a path not listed here.
- STOP-TOPOLOGY: any external direct runner service use, unresolved provider binding, or composition root selects a runner.
- STOP-DIRTY: any pre-existing baseline file digest changes.
- STOP-CONTRACT: existing composition cannot be represented without a parallel registry or state machine.
- STOP-REPEATED-FAILURE: the same validation failure repeats twice without a substantive change.

## 13. Rollback

- TS-only rollback: remove only this card's scanner/evidence paths and revert the manifest/claim/state digest synchronization through a fresh CAS transition; no product runtime rollback is needed.
- Data rollback/compensation: none; no database or event writes.
- Files/artifacts restored: previous manifest/claim/owner/ledger/evidence digests from the pre-card checkpoint; retain historical evidence rather than overwrite it.

## 14. Deliverables

- Code/tests: deterministic topology scanner, validator and negative fixtures.
- Evidence bundle: C001–C005 output records bound to the canonical fresh validation bundle.
- Ledger updates: topology artifact, claim digest, state CAS event, manifest/owner/ledger digest rebinding.
- Handoff: `REVIEW_PENDING`; PY-102 must consume the transitional runner-use list before any route change.
