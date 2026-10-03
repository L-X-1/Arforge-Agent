# Phase 0 / R2 新鲜证据（2026-08-11）

> 本记录只描述当前共享工作树的可复现切片，不代表整仓发布或阶段封板。

## 实施依据

- 唯一实施依据：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`。
- `Arforge-当前进度与后续实施计划-2026-08-11.md` 是 V1 暂停基线和战略摘要，已被 V2 取代。
- V1 的 Convergence / Trust Kernel V1 目标作为 V2 阶段 0→1 的当前接续范围执行。

## 工作树基线

采集时间：2026-08-11（Asia/Shanghai；当前登记文件已追加到工作树）

```text
baseline HEAD: 90811a85d843836b17a9d446733f0fbd5a118d54
branch: codex/phase-0-checkpoint
status: local checkpoint chain is clean before each authorized batch commit; the preceding baseline contained 342 entries (255 tracked, 87 untracked)
phase-0 checkpoint chain: 10708d40 → 25eb75c6 → 6f668b2a → 6a5e3dc9 → a470525f → ca2bc88a → 1a23eef4 → 5099e718
Bun:    1.3.14
```

本工作树包含用户已有的跨 App/Core/Arforge/Client/SDK/数据库/资源改动；已在本地 checkpoint 分支按功能域分成 7 个提交。未执行 push、远程传送、数据库迁移或桌面打包。逐文件登记见 [phase-0-attribution-register-20260811.md](./phase-0-attribution-register-20260811.md)，证据矩阵与冲突裁决见 [phase-0-evidence-matrix-20260811.md](./phase-0-evidence-matrix-20260811.md)。

checkpoint 提交顺序：`10708d40`（证据/规则/文档）、`25eb75c6`（Core/Schema/Protocol/Server）、`6f668b2a`（Arforge runtime/control）、`6a5e3dc9`（App/Desktop/UI）、`a470525f`（Client/SDK 手写合同）、`ca2bc88a`（generated contract）、`1a23eef4`（资产/锁文件）、`5099e718`（阶段 0 退出证据）。随后追加 Stage 1 生成收敛与门禁证据提交。未执行 push、远程传送、数据库迁移或桌面打包。

本轮以 1.5 秒间隔进行两次只读状态采样：两次均为 342 项，状态 SHA-256 指纹均为 `C447CDC709E583ED0617C26E8C853CE006C222781CACEAEC1FA9EB713EC803C2`，采样期间未观察到并行写入。

## 阶段 0.6 退出门禁当前评估

| 门禁 | 当前状态 | 证据/缺口 |
|---|---|---|
| 每个变化有归属 | 已满足 checkpoint 级别 | 340 项逐文件登记已按 V2 功能域纳入 7 个提交；15 个跨域候选保留为后续人工审查清单 |
| 无活跃并行写入 | 已满足 | checkpoint 前后状态清洁，且此前两次只读采样指纹一致 |
| 可从 Git/归档恢复 | 已满足 | 本地 `codex/phase-0-checkpoint` 分支，7 个可独立审查提交 |
| generated roots 与手写源区分 | 已满足 checkpoint 级别 | generated contract 独立提交；内存式 7/7 exact 审计完成，实际 generator 尚未运行 |
| PostgreSQL 与迁移账本已记录 | 已满足当前只读证据 | fresh topology preflight 通过，`schemaOrDataChanged=false` |
| P0 执行顺序获确认 | 已满足 | V2 阶段 0→1→2 顺序已锁定，且已获得本地 checkpoint 授权 |

阶段 0.6 的 checkpoint 退出条件已满足；下一步进入阶段 1 前置生成收敛与 R2 封板，但不跳过其逐项门禁。

## 数据库只读事实

`bun run db:topology:preflight`：本轮复跑通过，且报告 `readOnlyInspection=true`、`schemaOrDataChanged=false`、`secretsPrinted=false`。

- PostgreSQL 17.10 可访问。
- main 数据库 58 张 public 表；multiagent 数据库 3 张 public 表，现有 tasks=23、conversations=48。
- main migration ledger 到 `20260804090000_runtime_insight`。
- `20260810100000_control_run_claim_index` 尚未应用。
- Workflow Graph 三张表实际存在，预检报告 `pendingAdminMarker=false`、`ready=true`；这裁决了文档仍描述 `.pending-admin` 的冲突。
- 本轮复跑仍为 PostgreSQL 17.10、main 58 张 public 表、multiagent 3 张 public 表；multiagent 仍有 tasks=23、conversations=48，ledger 仍未出现 `20260810100000_control_run_claim_index`。
- 本记录没有应用 migration、备份、恢复或 RLS 变更。

## R2 新鲜门禁

在 `packages/arforge` 按共享 snapshot 状态敏感的文件分段串行执行（不使用会并行调度这些文件的单一组合命令）：

```powershell
bun test --timeout 30000 test/session/revert-snapshot.test.ts
bun test --timeout 15000 test/session/revert-compact.test.ts
bun test --timeout 30000 test/session/revert-readonly-inspector.test.ts test/session/revert-readonly-local.test.ts test/share/session-snapshot.test.ts test/share/share-next.test.ts test/cli/run/share.test.ts
bun test --timeout 30000 test/server/httpapi-session.test.ts
```

结果：`revert-snapshot` **6/6、50 assertions**；`revert-compact` **8/8、39 assertions**；其余五个安全套件 **31/31、381 assertions**；HTTP session **22/22、133 assertions**；合计 **67 pass / 0 fail / 603 expect assertions**。

补充说明：将这些文件一次性组合执行时，Bun 的文件级并行会让 `revert-compact` 偶发看到空 snapshot，并曾超过较短的外层工具时限；分段串行复跑后该用例稳定 8/8，通过结果作为本轮 R2 fresh gate。

补充门禁：

```powershell
# packages/core
bun test test/session-revert-fail-closed.test.ts
bun run typecheck

# packages/protocol
bun run typecheck

# packages/server
bun run typecheck

# packages/arforge
bun run typecheck
```

结果：Core fail-closed **1/1**；Core、Protocol、Server、Arforge typecheck 均通过。

## HTTP API 覆盖与效果门禁

为补齐 V2 Agent capability、Evolution、Memory correction/conflict、private operations、runtime insight 和 control
路由，本次在 `packages/arforge/test/server/httpapi-exercise/index.ts` 增加了 32 个真实 HTTP 场景；没有直接绕过
HTTP router、middleware、location binding 或 persistence path。

- Coverage mode：**351 pass / 0 fail / 0 skip**，`missing=0`、`extra=0`；对照的 effect route 数为 331。
- Auth mode：**351 pass / 0 fail / 0 skip**，`missing=0`、`extra=0`。
- Segmented effect：按共享状态敏感场景拆成八个串行 chunk，`50+50+50+50+50+50+50+1 = 351/351`，全部
  `fail=0`、`skip=0`、`missing=0`、`extra=0`。曾出现的单次 `v2.fs.find` 500 已经隔离复跑并以整 chunk 复跑确认不再持续。
- 为使门禁对应当前真实合同，已校正 durable worktree 状态、protected auth envelope/path、rewind 可执行会话
  fixture、legacy session 数据库隔离；无人值守 shell 场景验证 schema fail-closed，未自动绕过真实 L3 审批。
- `packages/core` 与 `packages/arforge` 类型检查再次通过；针对本批两处改动的 oxlint 为 **0 errors / 14 existing
  warnings**，`git diff --check` 通过。
- 从 `packages/arforge` 执行的完整 `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip --progress` 通过：
  **351/351**，`fail=0`、`skip=0`、`missing=0`、`extra=0`，耗时约 **1780 秒（29.7 分钟）**。此前完整运行的阻塞点
  已定位为未完成 control approval 的 worktree fixture；fixture 现通过公开 approval/reply/status 合同完成 durable
  operation，再清理已创建 worktree。
- 当前可复现的真实证据是：R2 组合门禁 **67/67**；HTTP coverage **351/351**；HTTP auth **351/351**；HTTP effect
  全量 **351/351**；均为 `fail=0`、`skip=0`、`missing=0`、`extra=0`。Stage 1 退出条件已满足，可以进入 Stage 2；
  但 Stage 2 的 PostgreSQL migration/RLS、provider live probe 和 Windows/Electron packaged 门禁仍未执行。

## Generated contract 审计

本次审计时工作树基线有 340 项 porcelain 状态变化（包含 tracked 与 untracked）；331 是 HTTP effect route 数，不是工作树变更数。
分支为 `codex/phase-0-checkpoint`；基线变化已由 checkpoint 与阶段 1 生成提交保存。

按路径的盘点摘要如下；这只是文件范围索引，不把路径自动当作历史 owner，真正归属仍需 checkpoint 前逐项确认：

| 范围 | 条目数 |
|---|---:|
| `packages/core` | 103 |
| `packages/arforge` | 89 |
| `packages/app` | 68 |
| `packages/ui` | 33 |
| `packages/schema` | 11 |
| `packages/desktop` | 6 |
| `packages/sdk` | 6 |
| `packages/client` | 5 |
| `packages/server` | 4 |
| `packages/protocol` | 3 |
| `packages/docs` | 2 |
| 其他根目录/文档/资源 | 10 |
本轮已在 checkpoint 后运行并审阅会清理/重建 generated roots 的生成器：

- `packages/client` 的 `check:generated` 在 checkpoint 后退出码 0，`src/generated` 与 `src/generated-effect` 无漂移。
- public SDK 生成链已运行成功，重建 `packages/sdk/js/src/v2/gen` 并执行 numeric-query、SSE workaround；canonicalization
  差异已单独提交为 `be5ef78c`，构建元数据提交为 `475f1bdc`。
- 当前手写合同与生成物的 fresh 验证：Schema、Protocol、Client、SDK/JS typecheck 均通过；Client **17/17**、SDK/JS
  **2/2** 测试通过。
- 追加完成内存式 generated 一致性审计：以当前 `ClientApi`、`groupNames`、`endpointNames`、`omitEndpoints` 编译出
  **32 groups / 198 operations**，分别生成 Promise 4 文件与 Effect 3 文件；按生成器相同的 Prettier 参数格式化后，
  与 `packages/client/src/generated`、`packages/client/src/generated-effect` 逐文件逐字比较，**7/7 文件与 manifest
  差异均为 0**；实际生成器也已在 checkpoint 后运行。
- Client/SDK 生成收敛与 HTTP effect 全量门禁均已完成；阶段 1 退出条件已满足。

## Stage 2.3 Durable event manifest 增量

在不改变数据库表结构的前提下，为 `EventV2.readAggregate` 增加严格 raw-aggregate 读取路径（`strict: true`）：先读取
完整 aggregate，再分页；逐行验证 sequence 连续、事件类型属于指定 manifest，并以 `onExcessProperty: "error"` 严格解码。
未知尾事件、中间 gap、跨 family 事件和 excess field 均 fail-closed。默认投影读取路径保持原有兼容过滤语义，以支持 Session
历史中的 legacy V1 与非公开投影事件。

- `packages/core/test/event.test.ts`：**46/46**，新增 strict history 的未知尾、gap、excess field 场景。
- `packages/core/test/session-history.test.ts`：**6/6**，确认 legacy/filtered public history 兼容性未回归。
- `packages/core/test/durable-action.test.ts` + `durable-run.test.ts`：**51/51**，**184 assertions**，确认既有
  Run/Action raw aggregate、state transition、lease/capability 和 recovery fail-closed 门禁未回归。
- `packages/core` typecheck：通过。

## Stage 2.5 Principal / ClaimIndex 当前基线

本轮只做了现有实现的安全回归，没有扩张 `ControlPlaneSubject` schema：Core ClaimIndex 的 alias/query 已按动态
tenant/user principal 隔离，Arforge worktree HTTP 链路在 claim 前显式注入 server-derived principal，并对 non-local
detached worker fail-closed。

- `packages/core/test/control-claim-index.test.ts`：**8/8**，**22 assertions**。
- `packages/arforge/test/control-operation/service.test.ts`：**6/6**，**34 assertions**。
- 尚未宣称 Stage 2.5 完成：Core 尚缺可独立验证的“subject opaque ID 必须由 principal 生成”统一合同；该跨 Schema/Protocol/adapter
  的变更需先形成正式工作包，不能用当前 local-only 门禁替代。

## Stage 2.4 Effect semantics 增量

已增加 `canonicalEffectSemantics`，由 Tool 语义解析和 ActionGateway 共同使用，在 intent/recovery 边界统一去重、排序、
空字符串清理和 compensation trimming；该改动不改变 risk tier 或 authority。当前完整的跨 ToolManifest、HTTP control
operation catalog/audit 仍未完成。

- `packages/core` typecheck：通过。
- `tool-effect-semantics.test.ts` + `session-runner-tool-registry.test.ts`：**32/32**，**238 assertions**。
- `action-gateway.test.ts`：**75/75**，**406 assertions**。

## 本次修复

失败用例为 HTTP durable prompt 在“会话尚未选择模型”时无法 wake 后 materialize。修复位于：

- `packages/arforge/src/session/prompt.ts`

durable materialization 现在：

1. 优先使用 prompt route 或已持久化的 session model；
2. 没有真实模型时使用仅用于可见投影的 `unselected/unselected` 哨兵；
3. 不把哨兵写回 session model 配置；
4. 让成熟运行时后续在没有真实模型时继续 fail-closed，而不是在 durable projection 阶段阻塞。

该修复的原失败用例单独通过，随后完整 HTTP session 通过 **22/22**；最后组合 R2 门禁通过 **67/67**。

## 尚未通过 / 尚未完成

- `git diff --check`：已通过；已移除 `packages/core/test/tool-webfetch.test.ts` 的多余 EOF 空行，仍有若干已有 CRLF/LF 警告但不构成 diff-check error。
- `packages/client check:generated`：checkpoint 后实际运行通过；SDK build、Client/SDK typecheck 与测试也均通过。
- Step 0.5 checkpoint：已获得明确授权并完成本地分支与 7 个分批提交；未 push、未远程传送。
- ClaimIndex PostgreSQL migration/RLS：代码与静态脚本存在，但尚未在目标数据库应用和验收。
- Windows/Electron packaged crash matrix：尚未运行。
- 逐文件归属登记和可恢复 checkpoint 已建立；跨域候选仍需在阶段 1 逐项复核，不阻断 checkpoint 退出。
- share/revert/unrevert 显式生产功能继续保持 disabled / 503。

## 下一步

1. 进入 Stage 2：先做 Trust/Durable、Worktree、MCP 的只读合同盘点与 targeted gate 规划。
2. PostgreSQL migration/RLS、provider live probe 和 Windows/Electron packaged 门禁在获得对应授权后执行。
