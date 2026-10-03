# 阶段 0.3–0.4：证据矩阵与事实冲突裁决

> 登记时间：2026-08-11；所有“当前”结论都以本次只读采集为准。历史数字保留为“历史证据”，不等同于当前通过。
> 计划来源：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`

## 证据矩阵

| 切片 | 源文件/垂直路径 | Targeted test | Typecheck | 历史证据 | 当前 fresh | DB/Windows/Electron/provider 覆盖 | Reviewer 结论 / 开放 P0/P1 |
|---|---|---|---|---|---|---|---|
| R2 session/share/revert | `packages/arforge/src/session/*`、`packages/arforge/src/share/*`、Core session | Arforge R2 组合门禁 | Arforge/Core 通过 | 旧会话数字已保留在主证据 | 是：67/67，603 assertions | PostgreSQL 只读预检；真实 provider、Windows packaged 未覆盖 | fail-closed 证据可用；生产 share/revert/unrevert 仍 disabled/503 |
| HTTP contract coverage/auth | `packages/arforge/test/server/httpapi-exercise/*`、HTTP handlers | coverage/auth/effect 完整门禁均 351/351 | Server/Arforge 通过 | 旧覆盖数字仅作历史对照 | 是：coverage/auth/effect 均缺失 0、额外 0 | DB bootstrap 只读；provider/packaged 未覆盖 | Stage 1 HTTP gate 已闭合；provider/packaged 仍留待后续阶段 |
| Durable event manifest | `packages/core/src/event.ts`、`packages/schema/*` | event 46/46、session history 6/6、durable action/run 51/51 | Core/Schema 通过 | 无可替代历史通过数字 | 是 | PostgreSQL schema 未变更；Windows/Electron/provider 未覆盖 | strict raw aggregate 已 fail-closed；仍需后续跨包合同审查 |
| Effect semantics | `packages/core/src/tool/*`、`packages/core/src/action-gateway.ts` | tool/registry 32/32；gateway 75/75 | Core 通过 | 无可替代历史通过数字 | 是 | DB/packaged/provider 未覆盖 | canonical semantics 已统一；完整 ToolManifest/HTTP catalog 仍是开放项 |
| ClaimIndex/control principal | `packages/core/src/runtime/*`、Arforge control-plane/control-operation | ClaimIndex 8/8；service 6/6 | Core/Arforge/Protocol 通过 | 无可替代历史通过数字 | 是 | PostgreSQL migration/RLS 未应用；Windows packaged 未覆盖 | local/detached fail-closed 回归通过；opaque subject 统一合同仍开放 |
| Schema/Protocol/Server/Client/SDK | `packages/schema`、`protocol`、`server`、`client`、`sdk` | Client 17/17；SDK/JS 2/2 | 各包 typecheck 通过 | generated roots 的 HEAD 差异为历史工作树事实 | 是（手写合同与内存生成结果） | PostgreSQL/Windows/provider 未覆盖 | generated 需 checkpoint 后执行实际生成器；不能以脏树 diff 判 clean |
| Generated contract | `packages/client/src/generated*`、`packages/sdk/*/gen`、OpenAPI | 内存式 32 groups/198 operations；Client 17/17；SDK 2/2 | Schema/Protocol/Client/SDK/JS 通过 | 当前 roots 相对基线的漂移已由 Stage 1 提交保存 | 生成器后 7/7 文件与 manifest exact | Windows/packaged/provider 未覆盖 | SDK generator 与 HTTP effect 全量门禁均已闭合 |
| PostgreSQL baseline | migration ledger、schema/table topology | `db:topology:preflight` | Core migration scripts 可静态检查 | ledger 到 `20260804090000_runtime_insight` | 是：readOnlyInspection=true、schemaOrDataChanged=false | PostgreSQL 17.10；未迁移、未备份恢复 | ClaimIndex migration `20260810100000_control_run_claim_index` 仍 pending |
| Windows/Electron packaged | `packages/desktop/*`、app E2E | 未运行 packaged crash matrix | Desktop typecheck/静态检查不等同 packaged | 不采纳旧会话结论 | 否 | Windows packaged 未覆盖 | 保持开放，必须在阶段 2 后续门禁执行 |
| UI/branding/non-stage changes | `packages/app/*`、`packages/ui/*`、assets、docs | 部分测试存在，未形成本阶段统一门禁 | 未作为阶段 0 退出依据 | 历史变化保留 | 未统一 fresh | provider/packaged 未覆盖 | 按 V2 分类为非阶段 0 主路径，归属仍需确认 |

## 文档与数据库事实冲突裁决

裁决顺序采用 V2 规定：数据库实际状态 > 当前源码与 migration manifest > 新鲜测试 > 文档声明 > 历史会话陈述。

| 冲突 | 事实证据 | 裁决 | 后续动作 |
|---|---|---|---|
| V1 与 V2 都像实施计划 | V2 明确声明替代 V1，且含阶段 0–8 退出门禁 | V2 是唯一实施依据；V1 仅作历史/战略上下文 | 所有阶段状态按 V2 重排 |
| `docs/WORKFLOW_GRAPHS.md` 仍描述 pending-admin | 当前 DB 预检为 `pendingAdminMarker=false`、`ready=true`，三张表实际存在 | 采用 DB 实际状态；文档描述标为 stale | 后续文档修订需单独审查，不在阶段 0 擅自改产品逻辑 |
| migration matrix 的“原生迁移/100%”与 DB ledger 被误读为同一层 | `specs/arforge-agent-migration-matrix.md` 描述的是行为迁移覆盖；ledger 尚未出现 `20260810100000_control_run_claim_index` | 两者分层：行为迁移矩阵不等于 PostgreSQL migration 已应用；DB ledger 仍是数据库事实 | 阶段 2 PostgreSQL/RLS 门禁时再迁移，须保留只读前置证据 |
| `ARFORGE.md` 尾部旧 Python `218/218` 与当前 TS gates | 当前文件未检出 literal `218/218`；当前主力运行时为 `packages/*` TypeScript，TS typecheck 与 targeted tests 有新鲜结果 | 未发现可直接裁决的当前冲突；若历史文档仍有该数字，只能作为历史证据 | Python 全量另行纳入对应阶段，不替代 TS 门禁 |
| generated roots 相对 HEAD 漂移，但内存式生成结果 exact | 7/7 当前生成文件与内存式输出一致；实际 generator 会写盘并清理 | 两者不矛盾：contract 可对齐，工作树归属/生成物快照仍未封板 | checkpoint 后才运行 generator/check:generated |
| 阶段 2.3/2.4/2.5 已有代码与 V2 要求先阶段 0 | 代码和测试可作为预验证，但阶段 0.6 尚未通过 | 这些是 prevalidation evidence，不构成正式阶段前进 | 不新增 Stage 2 能力，先完成阶段 0 |

## 阶段 0.3–0.4 结论

- 证据矩阵已建立，历史证据与当前 fresh 结果分栏，未把历史数字冒充当前通过。
- 上述文档/数据库冲突已按 V2 裁决顺序记录；未用文档声明覆盖数据库实际状态。
- 340 项文件已按 V2 功能域进入本地 checkpoint；15 个跨域候选保留为阶段 1 人工审查项。
- 阶段 0.5 已完成本地分支与分批提交；本文件不代表已经运行生成器、数据库迁移或桌面打包。

## 阶段 1 当前状态

- 生成收敛已完成：Client `check:generated` 通过；SDK/JS generator、build、typecheck 与测试通过；生成物收敛和构建元数据分别记录在 `be5ef78c`、`475f1bdc`。
- HTTP coverage/auth 均为 **351/351**，`fail=0`、`skip=0`、`missing=0`、`extra=0`。
- HTTP effect 已按共享状态敏感场景拆成八个串行 chunk 复跑：`50+50+50+50+50+50+50+1 = 351/351`，全部 `fail=0`、`skip=0`、`missing=0`、`extra=0`。其中曾出现的单次 `v2.fs.find` 500 已通过隔离复跑与整 chunk 复跑确认不是持续失败。
- 为使分段门禁对应当前真实合同，已校正 durable worktree 状态、protected auth envelope/path、rewind 可执行会话 fixture、legacy session 数据库隔离，并将无人值守的 shell 场景改为 schema fail-closed 检查；真实 L3 shell 审批仍未自动绕过。
- 从 `packages/arforge` 执行的完整 `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip --progress` 通过：**351/351**，`fail=0`、`skip=0`、`missing=0`、`extra=0`，耗时约 **1780 秒（29.7 分钟）**。Stage 1 的生成收敛、R2 与 HTTP 退出条件已满足；结论仍仅限于旧 share/revert 安全关闭和未来 worker evidence 合同可用，不代表恢复 share/revert/unrevert。
