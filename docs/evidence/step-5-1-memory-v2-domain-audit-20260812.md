# Step 5.1 — MemoryV2 领域审计

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.1
结论：保留现有能力；治理内核存在明确缺口，进入 Step 5.2 前不得宣称 Memory Kernel V1 已完成。

## 审计范围

本次审计覆盖：

- Core 实现：`packages/core/src/memory.ts`、`packages/core/src/memory/sql.ts`；
- Schema：`packages/schema/src/memory.ts`；
- SQLite migration：`20260726101405_memory_learning.ts`、`20260802044607_identity_and_tenant_ownership.ts`、`20260803055810_memory_corrections.ts`、`20260803064956_memory_conflicts.ts`；
- PostgreSQL ownership/RLS migration：`20260802050000_identity_and_tenant_rls/migration.sql`、`20260803060000_memory_corrections/migration.sql`、`20260803070000_memory_conflicts/migration.sql`；
- HTTP API：`packages/server/src/handlers/memory.ts` 及其 generated client；
- UI 基线：Control Center Memory/Conflict 工作台及相关模型测试；
- Core regression：`packages/core/test/memory.test.ts`。

审计逐方法核对计划要求的 identity、scope、actor、transaction、expected version、audit、RLS、delete semantics、event/evidence refs。

## 能力保留结论

| 计划要求保留的能力 | 当前实现 | 结论 |
|---|---|---|
| scoped CRUD | `visibility()` 按当前 project/workspace 映射 workspace/global；create/list/get/update/delete/deleteMany 均有对应入口 | 保留；update/delete 的 CAS、actor、审计和 destructive contract 待补 |
| correction/undo | correction 创建 successor、原记录 quarantine；`undoCorrection` 使用事务和 successor timestamp | 保留；缺 durable revision、actor、reason/evidence 绑定 |
| conflict lifecycle | deterministic scan、pending/resolved/dismissed/undone，决策使用双方更新时间校验 | 保留；缺 actor、policy/evidence/revision 审计 |
| hybrid recall | BM25/terms + local hashing/API embedding，quarantine 不进入 semantic recall | 保留；recall telemetry 当前含 query 与截断 content，需按 Step 5.8 收敛 |
| governance preview/apply | preview 给出原因和样本；apply 可逆地进入 `quarantined:auto/model` | 保留；apply 非事务、无 CAS/actor/revision/evidence |
| quarantine | source 前缀和检索过滤共同实现；update 可恢复 source | 保留；应在 V1 变为明确 lifecycle，而不是复用 source 字段 |
| UI/API 基线 | server handler、generated client、Control Center Memory/Conflict 工作台均存在 | 保留；未来写操作必须接入统一 actor/policy/action 边界 |

## 逐方法审计

状态含义：`通过` 表示当前边界已满足；`部分` 表示有局部实现但不足以作为 V1 合同；`缺失` 表示需要后续步骤实现。

| 方法 | identity / scope | actor | transaction | expected version | audit | RLS | delete semantics | event/evidence refs |
|---|---|---|---|---|---|---|---|---|
| `create` | ID 由 schema 生成；scope 由当前 Location/project/workspace 校验 | 缺失，source 不是 principal | 缺失，单 insert | N/A | 缺失 | PostgreSQL 表级 RLS；SQLite 仅静态 local owner 默认值 | N/A | 缺失 |
| `list` / `get` | 当前 workspace/global visibility 通过 | 缺失 | 只读查询 | N/A | 缺失 | PostgreSQL 有；SQLite 无数据库级 RLS | N/A | 缺失 |
| `update` | 先 `get` 做 visibility；更新实际仅按 ID | 缺失 | 缺失 | 缺失；无 `expectedUpdatedAt`/CAS | 缺失 | PostgreSQL 有；应用 update 未把 owner/scope 放入 where | N/A | 缺失 |
| `correct` | 读取与事务内原记录均做 visibility；successor 继承 scope | 缺失 | 通过；successor、quarantine、correction 同事务 | 部分；`expectedUpdatedAt` CAS | 缺失 durable audit | PostgreSQL 有 | 通过 lineage quarantine；非 destructive | 仅 correction 表 ID，缺 evidence/run refs |
| `correctionHistory` | 先验证 memory visibility；历史查询未显式带 visibility | 缺失 | 只读查询 | N/A | 缺失 | 依赖 PostgreSQL RLS | N/A | correction lineage 有；无 evidence refs |
| `undoCorrection` | correction/memory 查询未显式带 visibility | 缺失 | 通过；恢复、退休、状态变更同事务 | 部分；successor timestamp CAS | 缺失 | 依赖 PostgreSQL RLS | 通过；可恢复 | correction lineage 有；无 evidence refs |
| `conflictScan` | candidates 来自 visible active rows | 缺失 | 部分；逐 candidate insert，scan 与持久化非同一事务 | N/A | 缺失 | PostgreSQL conflict 表有 | N/A | conflict row/fingerprint 有；无 evidence refs |
| `conflictList` | conflict 关联 memory 最终按 visibility 过滤 | 缺失 | 只读查询 | N/A | 缺失 | 依赖 PostgreSQL RLS | N/A | conflict lineage 有；无 policy/evidence refs |
| `resolveConflict` / `dismissConflict` | decision loader 校验双方 visibility | 缺失 | 通过；memory 与 conflict 更新同事务 | 通过；双方 `expectedLeft/RightUpdatedAt` | 缺失 | PostgreSQL 有 | resolve 为可逆 quarantine；dismiss 不改 memory | conflict reason 有；无 actor/evidence/policy |
| `undoConflict` | decision loader 校验双方 visibility | 缺失 | 通过；恢复与状态变更同事务 | 通过；双方 timestamp + fingerprint | 缺失 | PostgreSQL 有 | 通过；可恢复 | conflict lineage 有；无 evidence refs |
| `delete` / `deleteMany` | visible 查询/删除限制 workspace/global | 缺失 | `delete` 单语句；`deleteMany` 非显式事务 | 缺失 | 缺失；无 redaction evidence | PostgreSQL 有 | 物理删除；FK cascade 会删除 correction/conflict 历史，未定义 V1 redaction/retention 合同 | 缺失；server 可直接调用，未接 ActionGateway |
| `semantic` | visible active rows；quarantine 排除 | 缺失 | 只读查询 | N/A | 仅 RuntimeInsight bounded projection | PostgreSQL 有 | N/A | 缺失；当前 telemetry 记录 query 和截断 content |
| `governancePreview` / `governanceApply` | visible rows | 缺失 | preview 只读；apply 逐行 update，非事务 | 缺失；apply update 无 CAS | 缺失 | PostgreSQL 有 | quarantine 可逆，但非 revisionized | reason/tag 有；无 actor/evidence refs |
| `extract` | 使用当前 workspace scope | 缺失；auto 仅 source 标识 | 每个 candidate 独立 create | N/A | 缺失 | PostgreSQL 有 | N/A | 缺失；直接写 active memory，违反后续 candidate policy |

## 已确认的主要缺口

1. **身份与权限**：当前 `MemoryV2.Interface` 没有 actor/principal 参数或服务上下文；`source` 不能替代授权主体。server memory handlers 直接调用 MemoryV2，delete 也未走 ActionGateway/maintenance authority。
2. **版本与不可变历史**：只有 correction/conflict 的局部关系表，没有统一 MemoryRecord revision、prior/successor digest、policy version、reason 和 CAS contract。普通 update、governanceApply、delete 缺少 expected version。
3. **证据与事件**：memory/correction/conflict 表没有 Run/Event/Observation/Evidence 引用；不能证明“模型说过”之外的来源，也不能满足长期写入 provenance gate。
4. **类型与候选分层**：schema 的 `type` 是任意短字符串，仍把 `auto/model` 直接存进 memory projection；`extract` 会直接创建 active row。Working/Episodic/Semantic/User/Project 与 Experience/Skill 边界尚未冻结。
5. **删除合同**：当前 delete 是物理删除并触发 correction/conflict cascade，没有 revision/relations/redaction evidence 的明确处理；没有 tenant/user request 的 maintenance authority 门禁。
6. **召回隐私**：`RuntimeInsight.recordMemoryRecall` 当前从 `semantic` 接收 query 及每个 hit 的截断 content；Step 5.8 要求只能保存 scope hash、query fingerprint、algorithm revision、IDs/scores/latency。
7. **数据库边界**：PostgreSQL migration 已为 memory/correction/conflict 建 tenant/owner、FK、FORCE RLS 和 tenant policy；SQLite 依靠进程内 Location/静态 local owner，不能把它当作 PostgreSQL 等价的数据库级 RLS。

## 证据与验证

- Memory implementation/schema/migrations/server/UI 已完成静态逐项核对，文件路径见“审计范围”。
- `packages/core/test/memory.test.ts` 覆盖 scoped CRUD、near-duplicate、hybrid recall、CJK、untrusted rendering、extract、RuntimeInsight、quarantine、correction/undo、conflict scan/decision/undo/bounds；这些是当前能力证据，不是 Memory V1 退出证据。
- 外部 SciFact recall baseline 已在 `docs/evidence/step-4-12-context-v3-exit-gates-20260812.md` 和 `artifacts/external-query-sets/beir-scifact/baseline-recall-at-10.json` 记录；Memory-specific evaluation 仍待 Step 5.10。

## 审计裁决与下一步

Step 5.1 结论为：**既有 MemoryV2 能力可保留，但不满足 Memory Kernel V1 治理退出条件**。不在本审计步骤提前引入 candidate/revision 类型；下一步严格进入：

1. Step 5.2 冻结 Working/Episodic/Semantic/User/Project 类型边界；
2. Step 5.3 建立 Memory Candidate，与 active projection 分离；
3. Step 5.4–5.5 逐步补齐写入政策、provenance、revision、actor、CAS、policy/evidence refs；
4. Step 5.6–5.11 再处理 conflict truth boundary、retention/delete、recall privacy、Run promotion、Memory evaluation 和 additive migration。

本文件不改变现有运行时代码；当前 generated `packages/sdk/js/tsconfig.tsbuildinfo` 用户修改保持不动。
