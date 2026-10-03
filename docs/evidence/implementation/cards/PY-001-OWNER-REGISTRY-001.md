# Task Card: PY-001-OWNER-REGISTRY-001

## 1. Identity

- Work package: PY-M0 / TS Owner Registry
- Capability leaf: 为 Session、Action、Tool、Memory、Workflow、MCP、CLI、Subagent、Sandbox、Context、Invariant 登记唯一 TS schema/service/store/writer/executor owner
- Plan action: CONVERGE
- Legacy disposition: N/A（本卡只建立治理登记，不运行或迁移 Python）
- Execution risk: E1
- Implementer: codex-gpt-5 / xhigh / current-context
- Reviewer: deterministic-owner-registry-validator / fresh command evidence; independent review remains required before CLOSED
- Gate owner: Plan Owner（bootstrap whitelist 期间人工串行派工）
- Master plan revision/digest: v1.3 / external desktop plan digest recorded in state.json
- Protocol bootstrap manifest/digest: `docs/evidence/implementation/protocol-bootstrap.v1.json` / current digest recorded in state.json
- Source revision: 92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8
- Card size: LUNA-M-equivalent
- Max product files: 0
- Max test files: 1
- Max non-generated diff lines: 900

## 2. Objective

建立一个可机器校验的 TS Owner Registry，使每个能力域只有一个 schema、service、store、writer 和 executor 权威；登记现有 Arforge owner、公开入口、融合处置和禁止的平行真相，为 PY-002/PY-005/PY-007 及后续 AF-DH 卡提供唯一 owner 输入。

## 3. Existing owner / retained interface / reinforcement / bypass closure

- Existing owners: `SessionExecution.Service`、`EventV2`、Session projector、Core `SessionRunner`、`ActionGateway`、`DurableAction`、`Tool.make`、`Tools.Service`、`Registry`、`Memory.Service`、Workflow Graph、现有 MCP client/gateway adapter、`DurableRun`/`TaskTool`/`Team`、`Permission`/`ActionGateway`/`Egress`。
- Retained interfaces: current Core/Arforge services, generated protocol routes and CLI/Desktop callers remain the only public surfaces; this card does not rename or replace them。
- Reinforcement: canonical registry schema, exact owner paths/symbols, source revision, manifest binding and negative parallel-owner rules。
- Bypass closure: no second Loop、Tool Registry、MCP client、checkpoint ledger、provider-owned identity/budget/store or Python fallback is registered or created。

## 4. Non-goals

- 不修改 `packages/*` 产品运行时代码、数据库 schema、CLI 行为或 Python 源码。
- 不实现 Agent Loop、Tool pipeline、MCP supervisor、sandbox provider 或 subagent provider；本卡只登记 owner。
- 不删除、移动、重命名既有文件，不执行 commit、push、PR、联网、发布或外部副作用。
- 不把 Python 文件级标签当成能力叶节点结论；PY-002/PY-005/PY-007 负责后续叶级台账。

## 5. Scope

| Allowed path | Operation | Allowed symbols | Owner | Purpose |
|---|---|---|---|---|
| docs/evidence/implementation/owner-registry.v1.json | create | N/A | TS Owner Registry | 唯一 owner 登记 |
| docs/evidence/implementation/cards/PY-001-OWNER-REGISTRY-001.md | create | N/A | Dispatcher | 冻结本卡 |
| docs/evidence/implementation/claims/PY-001-OWNER-REGISTRY-001.json | create | N/A | Claim Writer | CAS claim |
| docs/evidence/implementation/attestations/owner-registry.v1.sha256 | create | N/A | Gate Owner | detached registry digest |
| docs/evidence/implementation/state.json | update | ledger events/evidence only | Ledger Writer | claim handoff与证据 |
| script/arforge-owner-registry.ts | create | exported validator and CLI | TS Owner Registry | 只读 registry validator |
| script/arforge-owner-registry.test.ts | create | validator tests | TS Owner Registry | 负向/正向门禁 |
| script/bunfig.toml | read | test root | Development governance | 定向 Bun 测试配置 |

## 6. Authorization and tool boundary

- Upstream authorization: 当前用户明确要求按桌面完善计划和 Luna 执行协议继续开发。
- Network: DENY。External process/service: DENY。Git write/commit/push/PR: DENY。
- Destructive action: DENY。Release/distribution: DENY。
- Reads may inspect existing TS source paths to prove owner existence; only the listed governance artifacts may be written。

## 7. Prerequisites / baseline

- Protocol Bootstrap machine validation: `valid=true`, `status=REVIEW_PENDING`, `findings=[]`。
- Bootstrap claim handoff: bootstrap card remains review-pending; this card is in the explicit pre-review whitelist and is the sole active implementer claim after dispatcher handoff。
- Existing dirty worktree: 101 pre-existing entries and their digests remain owned by the user; no product path overlaps this card allowlist。
- Manifest digest, card digest, claim version and workspace identity are recorded in state.json before the first write。

## 8. Validation

| ID | Phase | CWD | Exact command | Expected | Scope | Cache mode | Side-effecting | Max runs |
|---|---|---|---|---|---|---|---|---:|
| O001 | targeted | E:/Arforge-Agent | `bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-owner-registry.test.ts` | all pass | focused | fresh | false | 3 |
| O002 | targeted | E:/Arforge-Agent | `bun run script/arforge-owner-registry.ts validate-owner-registry --root .` | exit 0 and no findings | focused | fresh | false | 2 |
| O003 | static | E:/Arforge-Agent | `bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-owner-registry.ts script/arforge-owner-registry.test.ts` | exit 0 | focused | fresh | false | 1 |
| O004 | review | E:/Arforge-Agent | `git status --porcelain=v2 --untracked-files=all -- docs/evidence/implementation/owner-registry.v1.json docs/evidence/implementation/cards/PY-001-OWNER-REGISTRY-001.md docs/evidence/implementation/claims/PY-001-OWNER-REGISTRY-001.json docs/evidence/implementation/attestations/owner-registry.v1.sha256 script/arforge-owner-registry.ts script/arforge-owner-registry.test.ts` | only listed card-owned paths | focused | fresh | false | 1 |

World-state checks:

- Every owner role resolves to one existing TypeScript file inside the repository。
- Registry manifest digest matches the bootstrap manifest and detached attestation。
- Required domains are present exactly once; statuses are `REGISTERED`。
- Registry contains no Python runtime path, fallback, sidecar, second registry, second Loop, second MCP client or provider-owned authority。
- Baseline pre-existing file digests remain unchanged。

## 9. Stop conditions

- STOP-OWNER：发现已有不同权威 registry 或无法证明现有 owner。
- STOP-SCOPE：需要修改 `packages/*`、数据库或未列出的治理路径。
- STOP-DIRTY：允许路径出现无法归属的旧改动。
- STOP-CONTRACT：Registry 与总计划、协议或源码 owner 事实冲突。
- STOP-REPEATED-FAILURE：同一验证错误无实质变化重复两次。
- STOP-RELEASE：出现发布、部署、签名、外部渠道或 Git 写入动作。

## 10. Deliverables / closure

- `owner-registry.v1.json` with one entry per required domain and role-level evidence。
- Read-only validator and negative tests。
- Detached registry digest and state evidence。
- Final state is `REVIEW_PENDING`; only an independent reviewer and dispatcher may move the card to `CLOSED` or release the next claim。
