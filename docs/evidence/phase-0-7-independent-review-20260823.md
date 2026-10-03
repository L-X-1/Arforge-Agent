# 阶段 0–7 独立总审查记录（2026-08-23）

- 复核日期：2026-08-23
- 计划基线：`%USERPROFILE%\Desktop\Arforge-最终详细实施计划-V2-2026-08-11.md`
- 审查起点：`62c32131 feat(skill): close guided evaluation and canary gate`
- 当前分支：`codex/phase-0-checkpoint`
- 远程状态：未执行 push
- 范围：阶段 0–7 的本地代码质量、合同一致性、后端回归和用户可达能力
- 明确排除：真实 provider 调用、桌面打包、签名、staging、发布与部署

## 当前结论

阶段 1–7 的当前本地实现通过了全仓类型检查、主要 TypeScript 包全量测试、Python 行为基线、App 浏览器环境测试和融合门禁。本轮从真实全量失败出发修复了测试环境污染、36 位时间戳回绕、CLI profile 路径漂移、子代理权限合同漂移、已退役发布脚本的测试误报，以及 Memory Candidate UI 能力漏登记共六类问题。

这份结论只证明当前代码和本地行为门禁，不证明阶段 0 已形式退出，也不构成发布证据。Step 0.6 仍保持开放：工作树含有大量用户既有未提交改动和未跟踪目录，尚不能声明“每个变化均已归属”。

## 新鲜验证矩阵

| 范围 | 结果 | 备注 |
| --- | ---: | --- |
| 全仓强制非缓存 typecheck | 22/22 tasks successful | 0 cached |
| `packages/server` | 10 pass、0 fail | 44 assertions |
| `packages/desktop` | 97 pass、0 fail | 276 assertions |
| `packages/llm` | 302 pass、30 conditional skip、0 fail | 708 assertions；未调用真实 provider |
| `packages/sdk-next` | 18 pass、0 fail | 129 assertions |
| `packages/app` | 1032 pass、0 fail | 3575 assertions |
| `packages/app` browser tests | 32 pass、0 fail | 75 assertions |
| `packages/client` | 17 pass、0 fail | 80 assertions |
| `packages/core` 四分片 | 1767 pass、9 skip、0 fail | 8132 assertions |
| `packages/arforge` 四分片 | 3418 pass、64 skip、1 todo、0 fail | 3483 tests、10581 assertions |
| Python pytest | 3115 pass、8 skip、0 fail | 319.82s |
| Python Ruff | pass | `arforge/`、`tests/` 无 finding |
| Fusion verification | pass | 0 fusion findings；22/22 typecheck |

`bun run fusion:verify` 的最终能力报告为：

- generated methods：239；
- mapped methods：239；
- duplicate/missing/extra mappings：0/0/0；
- UI eligible/closed：225/225；
- confirmed UI gaps：0；
- unreviewed/stale review candidates：0/0。

品牌检查报告 8 个已知 baseline hits、分布于 6 个文件，门禁未发现相对当前 baseline 的新增违规。由于品牌 baseline 和若干文档属于既有脏工作树内容，本轮不擅自改写或归属这些文件。

## 本轮发现与修复

### 1. HTTP API 测试在导入期污染全局环境

`packages/arforge/test/server/httpapi-frontend-ownership.test.ts` 在模块顶层导入测试运行环境，导致即使测试被过滤，仍会修改 `XDG_*`、`ARFORGE_DB` 和进程 Flag。污染最终表现为 ShareNext 全量分片意外访问 `https://control.example.com/api/config`。

修复后该测试直接从纯 API 定义生成 OpenAPI，不再引入有副作用的运行时。Arforge shard 1 从 `815 pass / 3 fail` 收敛为 `818 pass / 0 fail`。

### 2. Tool identifier 的 36 位毫秒时间戳发生真实回绕

Identifier 只保留 36 位毫秒时间，约每 795 天回绕一次。2026-08-23 位于一次回绕后的早期窗口，旧的数值比较会把 10 天前的文件判断为比 7 天 cutoff 更新。

`packages/arforge/src/tool/truncate.ts` 现在使用环形年龄计算，并以文件 mtime 作为超长存续文件的保守兜底；畸形 ID 保持跳过。新增确定性回绕测试覆盖“过去跨回绕”和“未来跨回绕”。Arforge shard 2 从 `1171 pass / 1 fail` 收敛为 `1173 pass / 0 fail`。

### 3. CLI 测试与 `ARFORGE_HOME` profile 合同漂移

隔离 subprocess 已使用 `ARFORGE_HOME=<profile root>`，真实配置位于 `<ARFORGE_HOME>/config/arforge.json`，旧测试仍读取 `<home>/.config/arforge/arforge.json`。测试现按 profile root 合同读取配置；两个真实 subprocess 用例均通过。Arforge shard 3 从 `617 pass / 2 fail` 收敛为 `619 pass / 0 fail`。

### 4. 子代理权限断言与 fail-closed capability 合同漂移

旧测试要求 child 继承 parent 的 `external_directory allow`，与 Step 8.1“子代理只接受显式下放的最小 capability”冲突。当前生产实现会在显式/default child capabilities 下生成独立 allow-list，并拒绝继承父会话外部目录授权。

测试现验证：工作区 read 可用、父 external allow 不继承、外部目录 deny、递归 task deny。专门权限组 6/6 通过，Arforge shard 4 从 `807 pass / 1 fail` 收敛为 `808 pass / 0 fail`。

### 5. 已退役 signed-candidate writer 被本地功能基线误判为缺失

`scripts/write_desktop_signed_candidate_evidence.ps1` 已在用户授权的 Tier-2 清理中退役，且发布/部署明确不在当前开发范围。Python 测试不再要求恢复或伪造该发布脚本；当 writer 不存在时，以带原因的 release-only skip 记录。其余纯 signing audit 合同继续执行并通过。

### 6. Memory Candidate 已有 UI，但未登记间接能力路径

融合门禁发现 `candidateReview/Approve/Reject/Activate` 四个方法未进入手工语义审查表。代码核对确认 Personal Workspace 已通过类型化 `memoryCandidates` adapter 提供：

- 候选查看与敏感内容遮蔽；
- policy、dedup、retention、evidence 和 block reason；
- 必填决策理由与 optimistic concurrency；
- approve、两步 reject、activate；
- 用户反馈、状态刷新和审计历史。

因此将四个方法登记为 `semantic-ui`，并增加回归断言。定向测试 7/7、App typecheck 和 UI capability audit 均通过；能力门禁由 4 个 unreviewed candidates 收敛为 0。

## 严格计划位置

- Step 1.12 至 Step 7.12：本地实现与本轮新鲜质量门禁通过；仍以各阶段既有证据中的真实限制为准。
- Step 0.5：本地 checkpoint 分支和分批提交持续有效，未 push。
- Step 0.6：仍未形式关闭，唯一原因不是测试失败，而是既有脏工作树尚未完成逐项归属；本轮不清理、不 stash、不覆盖用户改动。
- Step 8.1–8.9：已有实现和专项证据，下一批只做非发布功能验收与用户体验完善。
- Step 8.10 以及 Step 8.11 中的 signed release / staging / rollback：按用户要求继续排除，不作为本地功能交付条件。

## 安全与范围说明

- 未调用 DeepSeek 或任何真实 provider，未消耗外部模型预算。
- 未运行数据库迁移、发布、部署、签名、桌面打包或 staging 操作。
- 未读取或输出 API key、GitHub secret 或其他凭据值。
- 未修改 Git 配置，未强推，未 push。

## Checkpoint 归属拆分

本轮独立 checkpoint 只纳入不依赖其他脏工作树内容的修复：HTTP API 测试导入隔离、Tool identifier 回绕清理、CLI profile 隔离与路径合同、退役 release writer 的测试范围修正，以及本证据文件。

以下两项已在当前工作树修复并通过验证，但不进入本 checkpoint：

- 子代理权限断言必须与尚未 checkpoint 的 Step 8.1 capability materialization 生产改动一起归属；
- Memory Candidate UI 能力登记必须与尚未 checkpoint 的 generated client/API 同步一起归属。

这种拆分避免产生“只提交测试、遗漏生产前置”或“只提交能力登记、遗漏 generated contract”的不可复现 commit。上述文件保持在工作树，下一批按对应功能包审查、验证和 checkpoint；其余用户既有改动同样保持原状。

提交前另从当前 Git index 创建了临时 detached worktree，尝试验证 staged-only 冷启动。`bun install --frozen-lockfile --ignore-scripts` 在进入测试前即报告 lockfile 会发生变化并 fail-closed；随后不写 lockfile 的安装超过三分钟仍未完成，已主动终止。该尝试不计入通过矩阵，也不被描述为代码失败。临时 worktree 已从 Git 登记移除，`bun install` 残留目录已可恢复地移入 Windows 回收站。冷启动 frozen-install 漂移归入下一批 Step 0.6 工作树/依赖账本治理。
