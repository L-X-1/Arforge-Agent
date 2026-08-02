# Python 特色基线 → 统一 Arforge 功能迁移矩阵

更新时间：2026-07-27  
Python 特色能力基线：本仓库 `arforge/`、`tests/` 与冻结旧入口  
成熟框架一次性参考：外部只读参考工程  
统一产品主线：`E:\Arforge-Agent`

## 判定口径

- **原生迁移**：特色行为已成为新 TypeScript 主线的正式模块，并有对应测试/API/UI 证据。
- **成熟替代**：没有复制旧实现，但新主线提供相同或更强的用户行为。
- **部分覆盖**：核心能力存在，但旧 CLI 命令、数据生命周期或统一入口还没有一对一覆盖。
- **待用户决策**：继续做会改变正式产品界面或删除语义；遵守“先询问再修改”。
- **明确不迁移**：旧技术壳会制造双运行时或双事实源，保留只会降低稳定性。

文件同名、路线图描述和未接线代码都不算完成证据。下表将“行为迁移”和“旧命令名兼容”分开判断。

## 主矩阵

| # | Python 特色契约/行为 | 统一 Arforge 归属 | 迁移判定 | 行为覆盖 | 旧入口覆盖 | 核心证据 | 下一动作 |
| ---: | --- | --- | --- | ---: | ---: | --- | --- |
| 1 | Python CLI / REPL | 原生二进制 CLI + TUI | 成熟替代 | 100% | 不是逐命令兼容 | `packages/arforge/src/cli/cmd/run.ts`、`packages/arforge/src/cli/cmd/tui.ts` | 保留新 CLI，不恢复 Python 运行时 |
| 2 | npm 包逐参数委托 Python | 单一 Arforge 可执行文件 | 明确不迁移 | 100% | 0% | `packages/arforge/script/build.ts` | 删除双运行时风险，不复制 `.venv` 安装链 |
| 3 | JSONL stdio Machine Bridge | 类型化 HTTP API、Promise/Effect SDK、受限 Python 能力适配 | 原生迁移 | 100% | 兼容只读能力入口 | `packages/protocol`、`packages/client`、`packages/agent-python` | 产品会话与写权限归 TypeScript Core，Python Bridge 只承载类型化特色能力 |
| 4 | Desktop GUI（旧契约注明未实现） | Electron Desktop | 成熟替代 | >100% | 不适用 | `packages/desktop`、`packages/app` | 继续以新桌面端为唯一 GUI |
| 5 | Web / IDE（旧契约注明未实现） | Web UI、ACP、IDE 协议 | 成熟替代 | >100% | 不适用 | `packages/app`、`packages/arforge/src/acp`、`packages/arforge/src/ide` | 无 |
| 6 | Plan 预览与审批边界 | Plan agent、Question、Permission、Session admission | 成熟替代 | 100% | 语义覆盖 | `packages/core/src/question.ts`、`packages/core/src/permission.ts` | 保持现有权限模型 |
| 7 | Diff 预览、应用、回滚、run revert | Snapshot + Session revert | 成熟替代 | 100% | 语义覆盖 | `packages/core/src/snapshot.ts`、`packages/core/src/session/revert.ts` | 无 |
| 8 | 后台操作、取消、重试、状态 | BackgroundJob、Session coordinator、interrupt/retry | 成熟替代 | 100% | 语义覆盖 | `packages/core/src/background-job.ts`、`packages/core/src/session` | 无 |
| 9 | Durable autonomous objective | revisioned Goal queue | 原生迁移 | 100% | 工具/API 覆盖 | `packages/core/src/goal.ts`、`packages/core/test/goal.test.ts` | 无 |
| 10 | Persistent task dependency graph | revisioned DAG + claim/policy | 原生迁移 | 100% | 工具/API/UI 覆盖 | `packages/core/src/task-graph.ts`、`packages/core/test/task-graph.test.ts` | 无 |
| 11 | `ask_user` 结构化交互 | Question 服务与桌面/Web UI | 原生迁移 | 100% | 工具/API/UI 覆盖 | `packages/core/src/question.ts`、Question 测试集 | 无 |
| 12 | Language service | LSP 客户端、诊断、固定服务发现 | 成熟替代 | 100% | 工具/API 覆盖 | `packages/arforge/src/lsp`、`packages/arforge/test/lsp` | 无 |
| 13 | nbformat Notebook 读写 | SHA-256 并发保护的 Notebook 工具 | 原生迁移 | 100% | 工具覆盖 | `packages/core/src/notebook.ts`、`packages/core/test/tool-notebook.test.ts` | 无 |
| 14 | Session-owned managed worktree | 原生 Worktree 生命周期 | 成熟替代 | 100% | 工具/API 覆盖 | `packages/arforge/src/worktree`、worktree 测试集 | 无 |
| 15 | Scheduled prompt | bounded local cron + durable admission | 原生迁移 | 100% | API/SDK/UI 覆盖 | `packages/core/src/scheduled-prompt.ts`、scheduled-prompt 测试集 | 无 |
| 16 | Session tags/search | PostgreSQL durable tags + filtered search | 原生迁移 | 100% | API/SDK/UI 覆盖 | `packages/core/src/session`、session-organization 测试集 | 无 |
| 17 | Checkpoint + conversation rewind | checkpoint/preview/apply/archive | 原生迁移 | 100% | API/SDK/UI 覆盖 | session-organization 测试集、桌面 Operations UI | 无 |
| 18 | Deferred tool loading | run-scoped tool discovery/activation | 原生迁移 | 100% | 工具覆盖 | `packages/core/src/tool/deferred.ts`、deferred-tools 测试集 | 无 |
| 19 | Team + isolated mailbox | session-owned Team、mailbox、shutdown gate | 原生迁移 | 100% | 工具/API/SDK/UI 覆盖 | `packages/core/src/team.ts`、team 测试集 | 无 |
| 20 | Production MCP client | stdio/HTTP/SSE、OAuth、resources/prompts/tools | 成熟替代 | 100% | CLI/API 覆盖 | `packages/arforge/src/mcp`、MCP 测试集 | 无 |
| 21 | Primary answer + local attachments | `deliver_user_message`、哈希、local-only cards | 原生迁移 | 100% | 工具/UI 覆盖 | `packages/core/src/primary-delivery.ts`、primary-delivery 测试集 | 无 |
| 22 | Provider-neutral triggers | local/HTTP trigger profiles | 原生迁移 | 100% | 工具/API/SDK/UI 覆盖 | `packages/core/src/trigger.ts`、trigger 测试集 | 无 |
| 23 | Cooperative wait/wake/check-in | bounded run-local wait | 原生迁移 | 100% | 工具/API/SDK/UI 覆盖 | `packages/core/src/cooperative-wait.ts`、cooperative-wait 测试集 | 无 |
| 24 | Memory governance + hybrid recall | workspace/global scope、BM25 + hashing vector | 原生迁移 | 100% | API/SDK/UI 覆盖 | `packages/core/src/memory.ts`、memory 测试集 | 继续用真实样本监测召回质量 |
| 25 | Local learning + undo/dogfood | outcome/pattern/impact cohort | 原生迁移 | 100% | API/SDK/UI 覆盖 | `packages/core/src/learning.ts`、learning 测试集 | 明确保持“相关性而非因果性”标注 |
| 26 | Local feedback governance | 评分、分类、脱敏、删除反向学习 | 原生迁移 | 100% | API/SDK/UI 覆盖 | `packages/core/src/feedback.ts`、feedback 测试集 | 无 |
| 27 | Multimodal diagnostics | 本地 OCR/PDF/text 信号与代码匹配 | 原生迁移 | 100% | 工具/API/SDK/UI 覆盖 | `packages/core/src/multimodal-diagnosis.ts`、diagnosis 测试集 | 无 |
| 28 | Commands/hooks/themes/IDE/shortcuts | 新插件、主题、ACP/IDE、桌面快捷键 | 成熟替代 | 100% | 配置语法不同 | `packages/plugin`、`packages/ui`、`packages/arforge/src/command` | 不复制旧配置解析器 |
| 29 | Profile 隔离与本地状态 | Arforge 用户目录 + PostgreSQL workspace/session scope | 成熟替代 | 100% | 路径语义不同 | `packages/core/src/global.ts`、`packages/core/src/database` | 两个稳定版后再决定是否删除旧 profile |
| 30 | PostgreSQL memory/learning/Workflow Graph | 主库 + 独立 `arforge_ma` | 原生迁移 | 100% | 100% | `packages/core/src/database`、`arforge_schema_migration`、`arforge/workflow_graph_import.py` | 三张 Graph 表已迁移；旧 SQLite dry-run/apply 指纹复核通过；应用角色保持最小权限 |
| 31 | `export` | 新 CLI export | 成熟替代 | 100% | 100% | `packages/arforge/src/cli/cmd/export.ts` | 用实际数据做一次导入回放验收 |
| 32 | `clear-data`（盘点/加密备份/保留凭据） | 两阶段 PostgreSQL 清理协议 | 原生迁移 | 100% | 100% | `packages/arforge/src/cli/cmd/clear-data.ts`、`clear-data-operations.ts`、`clear-data-operations.test.ts` | workspace 使用应用角色精确删除；all 强制独立管理角色；计划 15 分钟有效且不可重放 |
| 33 | `logs-prune` | 统一日志目录和显式应用的保留策略 | 原生迁移 | 100% | 100% | `packages/arforge/src/cli/cmd/private-maintenance.ts`、`private-operations.test.ts` | 默认只预览，只有 `--apply` 才删除 |
| 34 | `secrets-scan` | 有界本地凭据扫描，结果只含路径和类别计数 | 原生迁移 | 100% | 100% | `packages/arforge/src/cli/cmd/private-operations.ts`、`private-operations.test.ts` | 保持不输出凭据值，并把达到扫描上限视为非完整结果 |
| 35 | `doctor` / `status` / `capabilities` | 统一运行时健康检查和类型化能力目录 | 原生迁移 | 100% | 100% | `packages/arforge/src/cli/cmd/doctor.ts`、`capabilities.ts` | `doctor/status` 已真实通过 PostgreSQL、目录、工作区、运行时和 Agent 引擎 5/5 检查 |
| 36 | `tools` / `agents` 顶层枚举 | 当前代理权限下的运行时工具目录和代理目录 | 原生迁移 | 100% | 100% | `packages/arforge/src/cli/cmd/tools.ts`、`agent.ts` | 真实 CLI 返回 12 个可见工具和 7 个代理角色 |
| 37 | DB backup + migration | 双库自动备份、隔离恢复、逐表对账 | 原生迁移 | 100% | Python 运维入口 | `scripts/postgres_private_backup.py`、`scripts/postgres_restore_drill.py`、`artifacts/postgres-backups` | 主库 48 表和 `arforge_ma` 3 表均恢复演练通过，逐表差异 0；后续每月演练 |
| 38 | 私有身份与远程访问 | Arforge 登录页、签名 Session Cookie、Caddy HTTPS | 新增强化 | 代码 100% | 部署激活待域名 | `packages/app/src/components/private-login.tsx`、`packages/server/src/session-auth.ts`、`deploy/private-https` | 提供最终域名后上线证书 |
| 39 | 非发布源码门禁 | 品牌、来源、绝对路径与运行依赖扫描 | 成熟替代 | 100% | 脚本入口 | `script/brand-audit.ts`、`specs/fusion-worklist.md` | 发布制品、签名和公告不在本阶段范围 |

## 量化结论

按上面 39 个可观察能力域的迁移实现统计：

- 完成或被更强实现替代：38 项（97.4%）
- 部分覆盖：0 项（0%）
- 需要外部部署坐标：1 项（2.6%）
- 已知特色核心行为缺失：0 项；Workflow Graph PostgreSQL 建表、旧 SQLite
  dry-run/apply 和 SHA-256 指纹复核已经完成
- 旧 CLI 运维命令一对一兼容缺口：0 组

这两个百分比不能混为一谈：**特色行为已经融合，不等于每个旧命令名都应该复制**。复制 Python/npm/Bridge 技术壳会重新制造双运行时，因此明确不迁移；`doctor`、清理、日志保留等私人运维入口已经在统一 TypeScript CLI 中补齐。

## 已采用的清理方案

所有者于 2026-07-27 批准方案 C。当前实现同时提供：

- `--scope workspace`：只清目标工作区的 Session 级联数据、Memory、
  Learning、Feedback 和工作区索引，不触碰其他工作区、账号或凭据；
- `--scope all`：只清明确白名单内的业务表，强制要求与应用角色不同、但指向
  同一数据库且具备 TRUNCATE 权限的 `ARFORGE_DB_ADMIN_URL`；
- 两种范围都先盘点、生成 AES-256-CBC + HMAC-SHA256 加密备份并验证恢复目录，
  再发放 15 分钟有效的一次性短语；执行前重新校验数据库指纹和备份 SHA-256，
  计划一经执行即不可重放。

真实工作区计划冒烟已盘点 3 条目标记录并生成 710,800 字节加密备份；没有执行
删除阶段。安全回归为 `8 passed, 0 failed, 61 assertions`，覆盖备份失败、
错误短语、计划重放、备份破坏、数据库漂移、SQLite 拒绝和管理员权限边界。

## 删除旧产品入口的闸门

本仓库就是统一主线，不能删除。根目录旧 Python CLI、旧 Desktop 产品壳和会
形成第二事实源的兼容层已在 2026-07-28 退役。执行前满足了：

1. 对应行为在 TypeScript CLI/Electron 中有逐项等价证据；
2. PostgreSQL 隔离恢复演练通过；
3. 39 项矩阵和相关自动化回归通过；
4. 旧 profile 与导出包完成一次可逆归档；
5. 删除清单由所有者按具体路径再次确认。

Tier 2 方案 B 的 14 个精确目标已生成逐文件 SHA-256 清单并移入 Windows
回收站；当前 Electron、统一 CLI、受限 Python 能力服务与双 PostgreSQL
数据库均保留。

### 旧 Bridge 方法归属门禁

`packages/agent-python/src/legacy-ownership.ts` 是逐方法归属的权威清单，
`bun run fusion:capabilities` 会从当前 Python Bridge 常量重新提取完整方法集，
而不是读取一份可能过期的快照。当前结果：

- 完整旧 Bridge：191 个方法；
- 受限 Python 特色能力：61 个，均在 `protocol.ts` 明确允许；
- TypeScript 原生纵向能力：130 个；
- 原生纵向能力中一对一 API：72 个；
- 由成熟框架语义替代：58 个。

该门禁证明每个旧方法都有唯一运行时所有者，并验证所有证据路径仍存在。58 个
语义替代均纳入 Desktop/App 源级可达性门禁；Workflow Graph PostgreSQL
迁移、双库恢复和旧 SQLite 指纹复核也已完成。
