# Task Card: BOOTSTRAP-PROTOCOL-001

## 1. Identity

- Work package: PY-M0 / Protocol Bootstrap Gate
- Capability leaf: 建立开发治理 manifest、唯一状态发现路径和 CAS claim 校验
- Plan action: CONVERGE
- Legacy disposition: N/A
- Execution risk: E1
- Implementer: codex-gpt-5 / xhigh / current-context
- Reviewer: deterministic-governance-validator / fresh command evidence; independent human review remains required before CLOSED
- Gate owner: Plan Owner（bootstrap 期间人工串行派工）
- Master plan revision/digest: v1.3 / external desktop plan digest recorded in state.json
- Protocol revision/digest: v1.1 / external desktop protocol digest recorded in state.json
- Source revision: 92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8
- Card size: LUNA-S-equivalent
- Max product files: 0
- Max test files: 1
- Max non-generated diff lines: 700

## 2. Objective

建立一个可发现、可验证、无第二状态库的开发治理 Bootstrap Gate，使后续 capability leaf 能够使用固定 schema、唯一 ledger writer、CAS claim 语义和新鲜 evidence 入口。

## 3. Non-goals

- 不修改 packages/*、arforge/、CLI、桌面端或产品运行时。
- 不实现 Agent Loop、Tool、Store、Writer、Executor 或业务协议。
- 不扫描或归属本卡之外的用户既有 dirty diff。
- 不执行 commit、push、PR、联网、发布、部署、签名、staging 或真实外部副作用。

## 4. Authoritative owner

- Package: development governance evidence
- Service/module: script/arforge-governance.ts
- Writer/lease authority: bootstrap manual dispatcher；机器校验只读，claim 采用 manifest 声明的 CAS 版本字段
- Schema/event owner: docs/evidence/implementation/protocol-bootstrap.v1.json
- State owner: docs/evidence/implementation/state.json

## 5. Current evidence

- 总计划：桌面 v1.3，明确 Bootstrap Gate、唯一 writer、claim/CAS/lease 与 LP-001—004。
- 执行协议：v1.1，固定发现入口、E1 风险、Preflight、Evidence 和状态机。
- 当前 HEAD：92b769b95f3ebecc5b3e2d5689cf3c6cbce98fd8。
- 工作区：101 条预存修改/未跟踪记录；本卡目标路径在开工前为空，基线见 bootstrap/baseline-dirty-manifest.v1.json。
- Known gap：项目尚无可验证的治理 manifest、统一 claim 记录和 Bootstrap validator。

## 6. Preserve

- 现有 101 条用户既有 dirty/untracked 记录及其 content digest。
- ARFORGE.md、AGENTS.md、桌面总计划和执行协议的原始内容。
- 现有 docs/evidence 文件的 owner 与内容。

## 7. Implement

- 新增固定 Bootstrap manifest、state、claim、detached attestation 和基线 dirty manifest。
- 新增由 `git status --porcelain=v2 --untracked-files=all` 生成的状态快照与摘要，验证基线重哈希、卡片 delta allowlist 和未知路径为空。
- 新增可由第三方复核的 fresh evidence bundle：每条记录含 phase、card_id、started_at、finished_at、scope、attempt、output_artifact_ref 和 output_digest。
- 新增只读 TypeScript validator：验证 schema、路径、唯一 writer、CAS 字段、validator 列表、claim owner 和状态一致性。
- 新增最小负向测试：缺字段、路径逃逸、schema 不一致、claim 版本不匹配和过期 claim 必须失败。

## 8. Remove or close

- Old bypass: 无。
- Removal in this card or future gate: 无。
- Proof required before removal: N/A。

## 9. Scope

| Allowed path | Operation | Allowed symbols | Owner | Purpose |
|---|---|---|---|---|
| docs/evidence/implementation/bootstrap/baseline-dirty-manifest.v1.json | create | N/A | Dispatcher | 冻结工作区基线 |
| docs/evidence/implementation/bootstrap/status-porcelain-v2.v1.json | create | N/A | Dispatcher | 机器可重建的工作区 delta |
| docs/evidence/implementation/bootstrap/fresh-validation-bundle.v1.json | create | N/A | Dispatcher | 新鲜命令输出及摘要 |
| docs/evidence/implementation/protocol-bootstrap.v1.json | create | N/A | Bootstrap Gate | 固定治理发现入口 |
| docs/evidence/implementation/state.json | create | N/A | Ledger Writer | 固定状态 schema 与状态 |
| docs/evidence/implementation/claims/BOOTSTRAP-PROTOCOL-001.json | create | N/A | Claim Writer | 固定唯一 claim |
| docs/evidence/implementation/attestations/protocol-bootstrap.v1.sha256 | create | N/A | Gate Owner | detached manifest digest |
| docs/evidence/implementation/attestations/status-porcelain-v2.v1.sha256 | create | N/A | Gate Owner | status snapshot digest |
| docs/evidence/implementation/attestations/fresh-validation-bundle.v1.sha256 | create | N/A | Gate Owner | fresh evidence bundle digest |
| script/arforge-governance.ts | create | exported validator functions and CLI | Development governance | 只读 Bootstrap validator |
| script/arforge-governance.test.ts | create | validator tests | Development governance | 负向/正向门禁 |
| script/bunfig.toml | create | test root configuration | Development governance | 解除仓库根目录的 intentional test guard，仅用于本卡定向测试 |

## 10. Authorization and tool boundary

- Upstream user authorization ref: 当前用户明确要求“按照计划和执行标准进行详细开发”。
- Tool allowlist: read/search/apply_patch/shell for local validation only。
- Network: DENY。
- External process/service: DENY。
- Destructive action: DENY；不删除或覆盖既有路径。
- Git write/commit/push/PR: DENY。
- Release/distribution: DENY。

## 11. Prerequisites and baseline

- Required cards/gates: ARFORGE/AGENTS 已读取；桌面总计划与执行协议已读取；目标路径 preflight clean。
- Bootstrap manifest: 本卡创建后生成并校验。
- Baseline worktree identity: E:/Arforge-Agent + Git common-dir identity。
- git status --porcelain=v2 ArtifactRef: 本卡执行记录中的命令输出。
- Baseline dirty manifest: docs/evidence/implementation/bootstrap/baseline-dirty-manifest.v1.json。
- Pre-existing dirty path ownership: 全部归类为 preexisting-user-dirty，本卡不触碰。

## 12. Validation

| ID | Phase | CWD | Exact command | Expected | Scope | Cache mode | Side-effecting | Max runs |
|---|---|---|---|---|---|---|---|---:|
| B001 | baseline | E:/Arforge-Agent | git status --porcelain=v2 | 101 baseline entries recorded | focused | fresh | false | 1 |
| B002 | targeted | E:/Arforge-Agent | bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-governance.test.ts | all pass | focused | fresh | false | 3 |
| B003 | targeted | E:/Arforge-Agent | bun run script/arforge-governance.ts validate-bootstrap --root . | exit 0 and no findings | focused | fresh | false | 2 |
| B004 | review | E:/Arforge-Agent | git status --porcelain=v2 --untracked-files=all -- docs/evidence/implementation script/arforge-governance.ts script/arforge-governance.test.ts script/bunfig.toml | only listed card-owned paths, no unknown path | focused | fresh | false | 1 |
| B005 | static | E:/Arforge-Agent | bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-governance.ts script/arforge-governance.test.ts | exit 0 | focused | fresh | false | 1 |

World-state checks:

- Bootstrap manifest path exists and resolves inside repository.
- Manifest detached digest matches current normalized manifest bytes.
- State canonical paths equal manifest canonical paths.
- Claim owner/version equals state claim record; no second active claim exists.
- Baseline dirty path digests remain unchanged.

## 13. Execution budget

- Max patch cycles: 3
- Max identical-failure retries: 2
- Max test runs per command: 3
- Max total tool calls: 80
- Max elapsed minutes: 90
- Max model/token budget: N/A
- Max side-effecting validation runs: 0

## 14. Stop conditions

- STOP-OWNER：发现已有治理 owner 或状态库而无法证明本卡应融合。
- STOP-SCOPE：需要修改本卡 allowlist 外路径。
- STOP-DIRTY：目标路径出现无法归属的用户改动。
- STOP-CONTRACT：桌面计划/协议与实际项目规则冲突。
- STOP-BUDGET：超过任一预算。
- STOP-REPEATED-FAILURE：同一验证错误无实质变化重复两次。
- STOP-RELEASE：出现任何发布/部署/签名/外部渠道动作。

## 15. Rollback

- TS-only rollback: 不适用；治理资产删除需要另卡授权。
- Data rollback/compensation: 不适用。
- Files/artifacts restored: 不覆盖既有文件；失败时保留 BLOCKED evidence。

## 16. Deliverables

- Code/tests: script/arforge-governance.ts、script/arforge-governance.test.ts。
- Evidence: Bootstrap manifest、state、claim、baseline、detached digest。
- Ledger updates: state.json 进入 REVIEW_PENDING，不得自标 CLOSED。
- Handoff: 记录 validator 命令、digest、remaining independent review。
