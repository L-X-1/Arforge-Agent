# Arforge Agent 功能契约

本文件早期章节曾定义 Python/Tauri 纵切。当前权威产品契约是统一 TypeScript
Core/Server/CLI/App/Desktop；Python 能力通过 capability bridge 接入，不再是唯一
命令源。下文保留的 Machine Bridge 细节用于兼容迁移审计。

## 当前可交付界面

| 界面                | 状态     | 契约                                                                                         |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| 统一 TypeScript CLI | 已实现   | 正式命令行入口，与 Server/Session 共用契约                                                   |
| Electron Desktop    | 已实现   | 使用共享 App、Server、Provider、Session 和 Permission                                        |
| Web / ACP / MCP     | 已实现   | 使用同一服务契约，不维护第二份会话状态                                                       |
| Python CLI / Tauri  | 兼容转发 | `arforge` 控制台脚本、`python -m arforge` 与 `python -m arforge.cli` 只转发到 TS CLI；`arforge.cli` 仅保留显式兼容 API |

桌面端通过本地 HTTP/Effect API 与统一 Core 通信，禁止通过抓取 ANSI 终端文本接入。

`workspace --contract-audit` 与 `settlement-status` 共享同一份只读执行边界契约：
JSON 的 `execution_boundary` 固定声明 `mode=read-only`、`writes=false`、不创建
profile/结算状态、不自动修复 recovery，且 `provider_execution_allowed=false`；
人类可读输出同步展示这些限制，证据完整不等于获得写入或 Provider 执行授权。
该契约由 `@arforge-ai/core/runtime/execution-boundary` 单一维护；CLI、Server、
Desktop 或 SDK 不应复制 boundary 常量或自行放宽断言。

Python 包的命令行入口已经并入 TypeScript 主线：`pyproject.toml` 的
`arforge` console script、`python -m arforge`、迁移期 `python -m arforge.cli`、
仓库根 `main.py` 和 Windows `arforge.cmd` 都经过
`arforge.cli_bridge`，以参数向量启动 `packages/arforge/src/index.ts`，共享同一
Bun、Provider、Session、Permission、退出码和错误边界。找不到 TS 入口或 Bun 时
会明确 fail-closed，不会静默回落到旧 Python CLI。`arforge.cli_compat` 现在是外部
Python IDE、测试和服务宿主的稳定嵌入 facade：它只重导出 `cli_bridge`，并通过
`invoke(...)` 返回 argv、命令、stdout、stderr、退出码和超时标记；调用始终使用
无 shell 的 TS 子进程，未找到 Bun/TS 时返回明确非零结果。`arforge.cli` 仍可被旧
嵌入和迁移测试显式导入，但它不是产品入口、不会写入新的 TS 状态，也不能作为第二
命令注册表继续扩展；新集成迁移到 `cli_compat` 后，旧 API 才能进入退役窗口。

旧模块退役边界由只读 `script/arforge-cli-compat-inventory.ts --json --check` 固定；
兼容命令 `scripts/cli_compat_inventory.py --json --check` 只无状态转发到该 TS 实现。
TS 实现枚举 `arforge/cli.py` 的每个顶层函数/类/常量并绑定源码 SHA-256，校验
`cli_compat` 只重导出 bridge。digest 或定义集合变化必须经过迁移审查；两条入口都不
导入、不执行旧 parser，也不写入任何状态。

## Machine bridge (desktop backend contract)

The current product entry is the TypeScript `arforge bridge` command. It is the
single JSONL-over-stdio adapter over the existing Core/Server session, event and
VCS owners; the former Python `python -m arforge.bridge` process is retired.
Clients must call `protocol.describe`, require `runtime: "typescript"`, and use
only the methods advertised by the live runtime; VS Code and JetBrains fail
closed when the handshake identifies a retired Python or unknown runtime, and
reject an unadvertised method locally with a capability error. The
migration slice currently exposes protocol/health/workspace,
session create/get/resume, chat start/cancel and bounded `git.diff`; the historical
1.1/1.2 capability inventory below remains a roadmap until each method is wired
through the same TypeScript owner and advertised. Permission mode is compatibility
metadata, while Core agent permission rules remain authoritative; full OS sandbox
validation is deferred.

Plan Mode uses the read-only `plan.preview` Bridge method as the shared structured contract for non-terminal clients. It accepts a task plus plan text and returns `schema_version`, `mode=plan`, `approval_required`, `execution_mode_after_approval=acceptEdits`, affected files, pending steps, risk notes, rollback notes and the raw plan. This method is a preview/normalization surface only: it does not approve execution, change permission mode, write files or mutate workspace state. Desktop may render the returned object as a plan card before any user-approved edit flow.

Desktop clients must consume this bridge and must not parse CLI or ANSI output. Bridge 1.1 exposes backend-owned one-time tool approvals, hash-guarded diff preview/apply/reject/rollback state machines, background tool tasks with query/cancel/safe-retry methods, bounded redacted log pagination and revisioned non-sensitive settings. It also exposes release readiness facts such as `release.gates` and `release.remediation_plan` as read-only product state for Desktop and other machine clients; Desktop Overview renders both the current fail-closed gate verdict and the ordered remediation items from this Bridge data flow. Agentic run observability is exposed through read-only `run.list` and `run.report`, which load persisted run artifacts rather than terminal text; `run.revert` is a guarded workspace-mutating method that restores a persisted run transaction and must only be invoked after explicit user action. Stage 4 memory governance is exposed through read-only `memory.status`, `memory.search`, `memory.facets`, `memory.semantic_search` and `memory.recall_quality` plus explicit `memory.update`, `memory.delete` and `memory.bulk_delete`; Desktop Overview can list local memories, counts, type/source/tags/project/workspace, filter by text/type/tag/source/project/workspace/importance, navigate project/workspace/type/source facets, run scoped local hybrid/vector semantic recall, show a scoped BM25 self-recall quality baseline, edit one stale or incorrect memory, delete one bad memory, and bulk delete only explicitly selected visible memory IDs after user action. The recall quality report is deterministic local operational telemetry over saved memory rows, not a causal production-quality proof. The default semantic recall path uses local deterministic hashing embeddings plus BM25/hybrid retrieval, so it does not require an external provider; external vector infrastructure remains an optional future backend choice. Memory writes persist `project_id` and `workspace_path`; existing unscoped rows remain searchable without fabricating project ownership, while new rows default to a deterministic current-workspace project key unless callers pass explicit scope. Stage 4 learning activation is exposed through read-only `learning.status`, which reports recent learnings, discovered patterns, confidence, dogfood totals, injection participation and observed injected-vs-baseline success impact. The impact metric is operational telemetry over recorded outcomes, not a randomized experiment, and stays `insufficient_data` until both cohorts meet the minimum sample threshold. Learning governance uses explicit `learning.undo` calls to remove one bad learning outcome from the local learning database after user confirmation; it returns `linked_patterns` for any conservatively deleted or decremented auto-generated failure patterns whose source can be proven from the deleted outcome. `learning.dogfood_sync` is an explicit stateful local-product action that idempotently imports append-only dogfood outcomes into structured learning records; it is not a workspace-file mutation. These governance actions are stateful and mutating, but they are not workspace-file mutations. Explicit product feedback is exposed through local-only `feedback.summary`, `feedback.list`, `feedback.submit` and `feedback.delete` methods. Submission redacts sensitive values before SQLite persistence, may associate the current session, and best-effort records non-neutral ratings through the formal learning engine without allowing learning failures to break feedback storage. The Desktop settings surface renders the same contract and never uploads feedback. Stage 4 multimodal diagnostics are exposed through read-only `multimodal.diagnose`, which accepts only workspace-relative files plus optional extracted text and returns structured text extraction, error signals, code matches and repair suggestions; Desktop Diagnostics renders that Bridge response without editing files. Only `tool.execute`, `tool.execute_async`, `diff.apply`, `diff.rollback` and `run.revert` may mutate the workspace; `settings.update`, `permissions.mode.set`, `memory.update`, `memory.delete`, `memory.bulk_delete`, `learning.undo`, `learning.dogfood_sync`, `feedback.submit` and `feedback.delete` mutate only isolated profile or local product state. Project, session and redacted conversation text persist in the isolated local profile so an interrupted conversation can be reopened and resumed; history is bounded to 500 messages per session and is included by `arforge export` and removed by `arforge clear-data`. Tool arguments/results and diff content remain intentionally unavailable after restart. Active tasks recover as `interrupted`; approvals and unfinished actions recover as `invalidated`; applied diffs recover as `applied_unrecoverable`.

## 顶层命令与后端能力

| 用户命令                     | 后端实现                                                                                                                                                                                                          | 成功条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 失败语义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` / `ask`               | TS `TuiThreadCommand` / `RunCommand`（`ask` 共享 `run` handler）                                                                                                                                                  | 返回真实模型/工具/多 Agent 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 后端异常返回非零；工具失败不可伪装为模型成功                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `doctor`                     | `product.doctor.run_checks`                                                                                                                                                                                       | 必需检查无失败                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 有失败项返回 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `privacy`                    | `privacy_audit`                                                                                                                                                                                                   | 显示当前隔离 profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 不输出凭据值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `export`                     | `export_data`                                                                                                                                                                                                     | 文件成功落盘                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 写入/查询失败返回 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `clear-data`                 | `clear_local_data`                                                                                                                                                                                                | dry-run 或确认删除完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 拒绝/失败返回非零，凭据默认保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `logs-prune`                 | `prune_logs`                                                                                                                                                                                                      | 保留期参数有效且清理完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 参数错误返回 2，I/O 失败非零                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `secrets-scan`               | `scan_sensitive_files`                                                                                                                                                                                            | 无命中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 有敏感样式命中返回 1且不显示原值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `status`                     | `status.get_status`                                                                                                                                                                                               | 后端状态读取完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 未处理异常由顶层边界脱敏并返回 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `privacy`                    | Core `privacyAudit` + TS `PrivacyCommand`                                                                                                                                                                         | 只读显示本地存储、网络使用、文件/日志/备份元数据与同意状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 目录不可读或扫描失败返回非零；绝不输出文件内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tools`                      | Tool Registry                                                                                                                                                                                                     | schema 和风险可读取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 注册/加载失败非零                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `agents`                     | SubAgent Pool                                                                                                                                                                                                     | 角色元数据可读取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 不得用空列表冒充“已启用”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `capabilities`               | TypeScript/Core capability catalog + deterministic route preview + read-only execution-contract audit + typed system overview                                                                                   | 状态目录、`capabilities test <input>` 路由预览、`capabilities evaluate` 合同审计与 `capabilities overview` 系统概览；不执行未具备 typed owner 的 Python handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 缺少输入、目录参数冲突或越界返回非零；`evaluate`/`overview` 只读；`--execute` 在全量 Core 执行合同完成前 fail-closed                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory`                     | Core/Server `MemoryV2` + generated HTTP/SDK；`analysis/memory-metrics`（含 write-stats）、`analysis/memory-recovery`、`analysis/memory-feedback`、`analysis/memory-digest` 与 `analysis/memory-conflict` 只读组合 | `memory status/list/search/get/create/update/facets/recall-quality/metrics/write-stats/recovery/digest/conflict` 已由 TS CLI 统一 owner 提供；`memory feedback --contract-audit` 通过同一 Core 合同输出只读缺口审计；其它反馈写入仍 fail-closed；`metrics` 组合 typed 状态/召回/冲突/来源计数，旧 golden eval/history 明确为 `not_comparable`/`not_read`；`write-stats` 只投影 Core 数据库的范围/来源/类型计数，旧 `memory_writes.jsonl` 决策日志为 `not_read`；`recovery` 只读聚合 profile-local `recovery_outcomes.jsonl` 并报告损坏行/近 7 天趋势，旧 producer 与清理仍未接管；digest 支持类别过滤、JSON 报告、有界读取和显式 Markdown 输出；conflict 运行共享确定性基准并读取 `conflictList` 已持久化候选，明确不调用写入型 `conflictScan`；历史 `memory feedback` 输入语法可校验但未满足合同 | 数据库失败脱敏并返回 1；`metrics`/`write-stats`/`recovery`/`memory feedback`/`contract-audit` 不写 benchmark、决策、恢复或 recall 历史，且不伪造 provenance/eligible 覆盖率；`write-stats --clear` 与 `recovery --clear` 在 typed producer/权限合同完成前返回 2；`memory feedback` 必须先具备 durable retrieval event、returned-set 校验、工作区/身份绑定、授权、事务更新、保留/清理和跨进程证据；`digest` 的 `truncated` 标记读取上限；`conflict` 的 `relation_coverage.status` 固定为 `not_comparable`，不得把候选数冒充关系覆盖率；未完成合同的历史叶返回 2，不得伪造成功 |
| `learning`                   | Core/Server `LearningV2` + generated HTTP/SDK；`analysis/learning-recall` 与 `analysis/learning-dream` 只读组合                                                                                                  | `learning status/recall/record/undo/sync-dogfood/dream` 已由 TS CLI 统一 owner；`recall` 组合 Memory.recallQuality 与 Learning.status；`dream` 通过 `/api/learning/dream` 返回基于同一 scoped status 的确定性洞察/建议，并显式标记 consolidation 未执行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 数据库/权限失败脱敏并返回 1；recall/dream 只读组合不写状态、不调用模型；dream 不恢复旧 consolidation writer，未来写入必须另行通过 typed ActionGateway 合同                                                                                                                                                                                                                                                                                                                                                                                                 |
| `feedback`                   | Core/Server `FeedbackV2` + generated HTTP/SDK                                                                                                                                                                     | `feedback summary/list/submit/delete` 已由 TS CLI 统一 owner 提供；旧 Python 位置参数归一到同一 owner，历史 Python UUID 数据不迁回                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 脱敏后本地持久化；工作区/会话越界和参数错误返回 1；删除幂等；不得回退 Python                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `skill` / `skills`           | Core/Server `ManagedSkillRegistry` + generated HTTP/SDK                                                                                                                                                           | `skill` 与历史复数 `skills` 共享 `list/enable/disable/refresh/route`；route 使用确定性技能路由合同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | manifest/state 与工作区路径校验失败脱敏并返回 1；缺参/多余位置参数返回 1；不得恢复 Python 第二 owner                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workflow` / `workflows`     | TypeScript/Core durable workflow operations + generated HTTP/SDK                                                                                                                                                  | canonical `workflow` 与历史 `workflows list/validate/run/runs/status/events/pause/resume/cancel/retry/approve/reject` 共享 typed graph owner（`status`→`get`，`validate`→只读 preview 投影，`run`→typed preview/start + report，`events` 有界读取）；`run` 的 `--execute` 等待同一持久化运行达到终态或明确暂停/审批状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 工作区、运行 ID、节点、游标和权限错误返回非零并脱敏；`--report` 相对路径必须位于工作区，默认报告写入 profile data；不静默启动旧 Python loop 或创建第二 graph journal；写控制继续沿用现有 API/权限/恢复证据                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `quality`                    | Core `AnalysisQuality`                                                                                                                                                                                            | canonical `quality [files..] --patch-file <file>` 与 Python 旧 `quality <patch-file>`（`.diff`/`.patch` 或 unified-diff 内容）在同一 handler 融合；普通源码位置参数仍检查文件本身                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 补丁读取/大小错误返回非零；历史 `.diff`/`.patch` 缺失返回 2；不得静默切回 Python quality gate                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `repo-scale`                 | Core `RepoScale` + bounded scanner                                                                                                                                                                                | canonical `repo-scale [query] --path <dir>` 与 Python 旧 `repo-scale <path> [--query <text>]` 在同一 handler 融合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 路径/查询冲突返回 1；扫描受文件数、结果数和工作区边界约束；不得静默切回 Python scanner                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `plugin-manager` / `plugins` | Core `PluginInstallRuntime` + Server `PluginControl` + generated HTTP/SDK                                                                                                                                         | `plugin-manager` 与历史 `plugins` 共享 `list/inspect/install/update/remove/restore/enable/disable`；旧 install/update 名称位置参数归一到同一 typed 请求，默认动作是 list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 写操作必须经过 L3 人工控制审批、持久租约和可恢复事务；旧 root 仅允许 `<workspace>/.arforge/plugins`，任意其它 root 在 API 前返回 2；不得新增 Python plugin owner                                                                                                                                                                                                                                                                                                                                                                                            |
| `agent-metrics`              | TypeScript/Core `AgentMetrics` profile-local telemetry reader                                                                                                                                                     | 聚合 dogfood、恢复、验证、回归等 8 个质量指标，报告正式/纵向门禁，并提供有界 `history`/`record`/`--clear` 历史操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 源文件缺失/坏行返回 `n/a` 与 `insufficient_evidence`，不影响主会话；仅显式历史操作写入或删除 `agent_metrics.jsonl`，不得恢复 Python 第二 owner                                                                                                                                                                                                                                                                                                                                                                                                              |
| `features`                   | TypeScript/Core `agentCapability.deepInsights` 的 `features` section                                                                                                                                              | `features`/`features list`/`--json` 读取 Desktop 共用的 TS-native 功能策略；旧 Python `features` 入口只转发到同一命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 只读路径不读取或创建 `feature_flags.json`；`set`/`clear`/`refresh` 参数校验后退出 2，直到具备事务、权限和证据合同的 TS 写入 owner                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `permissions`                | TypeScript/Core `permission.saved.list`                                                                                                                                                                           | `permissions`/`permissions list`/`--json` 读取 Desktop 共用的当前工作区已保存权限规则；旧 Python `permissions` 入口只转发到同一命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 只读路径不读取或创建 Python `permission_rules.json`；`add`/`revoke` 参数校验后退出 2，直到具备事务、授权、审计和回滚合同的 TS 写入 owner                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `file-state`                 | Core `FileStateAnalysis.audit`（通过 `agentCapability.deepInsights` 的 `file-state` section 暴露）                                                                                                               | 深度诊断可查看跨进程文件观察合同的结构化审计；历史 `file-state` CLI 在完整 owner 建立前保持退出 2 fail-closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 只读审计不读取/创建旧进程内 tracker；明确列出 observation journal、run/session 绑定、持久化、恢复、授权、取消、结算、证据和清理策略缺口；不得把 `FileMutation.fingerprint` 或 `AnalysisRuns` 冒充观察账本                                                                                                                                                                                                                                                                                                                                                                                     |
| `cost-optimization`          | Core `CostOptimizationAnalysis.audit`（通过 `agentCapability.systemOverview` 的 `cost-optimization` section 暴露）                                                                                              | 系统概览可查看跨进程成本账本合同的结构化审计；历史 `cost-optimization` CLI 在完整 owner 建立前保持退出 2 fail-closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 只读审计不读取/创建旧进程 tracker；明确列出 durable cost attribution、provider 定价版本、token 对账、跨进程聚合、恢复、授权/证据和清理策略缺口；不得把 Session stats、AgentMetrics 或文件指纹冒充成本账本                                                                                                                                                                                                                                                                                                                                                                        |
| `print` / `--print`          | TS `RunCommand` + `PrintModeRenderer`                                                                                                                                                                             | 文本/JSONL、stream-json 多消息、final-only、工具记录、统一会话与退出码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 输入结构错误返回 1；永久失败返回 1；可识别的 provider/rate/timeout 临时失败返回 75                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `config`                     | canonical config loader（顶层与 `debug config` 共用）                                                                                                                                                             | 仅显示掩码/非敏感配置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 永不输出完整密钥或数据库凭据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `db` / `db-current`          | TypeScript/Core migration ledger for `db current`; remaining `db-*` leaves stay compatibility-guarded                                                                                                             | `db current [main]` read-only revision projection; historical `db-current [main]` shares the same argv/result; no implicit migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | local SQLite read errors return 1; invalid target or unowned `multiagent` returns 2; mutating migration/backup/rollback aliases remain fail-closed                                                                                                                                                                                                                                                                                                                                                                                                          |
| `run-history` / `replay`     | Core `AnalysisRuns` bounded run transaction/trace reader                                                                                                                                                          | `run-history [run-id]` and historical `replay [run-id]` share the same read-only report owner; no model/tool replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | missing runs are reported as data; persisted artifacts are bounded and redacted; the alias must not execute a provider or side effect                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 一致性规则

1. `COMMANDS_HELP` 与 `_COMMAND_MAP` 必须一一对应。
2. `--verbose`、`--no-stream` 在命令前后含义一致。
3. `python -m arforge`、`python -m arforge.cli`、Python console script 和 npm wrapper 都进入同一 TypeScript CLI 并保留相同退出码；`chat`/`ask`/`print`/`config`/`skills`/`plugins`/`replay` 的旧命令名只作为同一 TS handler 的别名，`--print` 及其输入输出旗标在 argv 边界归一到同一 `RunCommand`，外部 Python 嵌入应通过 `arforge.cli_compat` 的 `main`/`run`/`invoke` 调用统一 bridge，`arforge.cli` 直接导入仅是迁移兼容 API；Python 运行时与 dogfood runner 不得绕过 bridge 启动旧模块 parser 作为第二套产品循环。静态门禁还必须保证产品源（测试、证据与显式兼容模块除外）不存在 `arforge.cli` import 或旧模块子进程调用。
   `learning` 已公开的六个 TS 叶遵循同一合同；`recall` 与 `dream` 只读组合既有 Core 来源，`dream` 明确标记 consolidation 未执行，不由 bridge 恢复旧 Python writer；`memory` 已公开的 TS 叶（含只读 `metrics`/`write-stats`/`recovery`）和 `feedback` 已公开的四个 TS 叶遵循同一合同，`metrics` 明确标记未等价的 golden/history 部分，`write-stats` 明确标记未读取的决策日志，`recovery` 明确标记旧 producer/clear 未接管，未完成的历史叶仍只有明确迁移失败；任何新叶必须先完成参数、权限、取消、错误和负例合同。
4. npm postinstall 创建包内私有 `.venv`；缺少 Python 3.10+ 或后端安装失败时，npm 安装必须失败。
5. 复杂请求由确定性预路由进入 `MasterAgent`；高置信提示注入必须在 MasterAgent/模型前阻断。
6. `ARFORGE_HOME` 是所有运行状态的唯一 profile 根目录。
7. 用户可见数据库描述必须隐藏用户名和密码。
8. 未知参数、重复危险参数和多余位置参数返回用法错误，不得静默忽略。

## 自动验收证据

- `tests/test_cli_contract.py`：帮助、处理器、选项、退出码、错误脱敏和多 Agent 路由。
- `tests/test_m6_packaging.py`：Node/Python 输出一致、npm 安装器隔离及 shell 安全。
- `tests/test_cli_ts_bridge.py`：Python 入口指向 TS owner、参数向量原样转发、无 shell
  执行，以及缺少 Bun/TS 入口时的 fail-closed 行为。
- `tests/test_profile_isolation.py`：跨模块 profile 隔离。
- `tests/test_multiagent_integration.py`：真实 MasterAgent 委托与注入前阻断。
- `tests/test_privacy_lifecycle.py`：数据生命周期、凭据保留和脱敏。
- `tests/test_task_runtime.py`：异步工具 ACK 顺序、取消副作用语义、新审批重试、会话隔离和重启恢复。
- `tests/test_bridge_state_recovery.py`：session/action 元数据持久化、启动失效、敏感 payload 禁入和恢复态协议。
- `tests/test_bridge_logs_settings.py`：日志分页/脱敏/资源上限、设置白名单/原子更新/revision 冲突及 CLI/Bridge 一致性。
- `tests/test_feedback_runtime.py`：本地反馈脱敏、输入边界、统计/删除、正式学习联动及 CLI/Bridge 一致性。
- `desktop/src/features/settings/FeedbackPanel.test.tsx`：桌面反馈提交、会话关联和统计刷新。

当前融合状态和仍需人工验收的边界记录在
[`specs/arforge-fusion-verification.md`](../specs/arforge-fusion-verification.md)。
安装包、签名和公共发布不属于当前功能契约。

## Persistent task graph contract

The agent-facing local task tools preserve the existing `tasks.json` list format and the
legacy `create_task`, `list_tasks`, `complete_task`, `delete_task`, and `search_tasks`
interfaces. Stored rows are normalized in place only during a successful mutation, so
older profiles remain readable.

Task mutations use an in-process lock, a stale-aware cross-process lock, atomic replace,
and a monotonic high-water ID. Tasks may carry descriptions, active-form labels, owners,
metadata, `blocks`, and `blocked_by` relations. Relations are symmetric, self-dependencies
and cycles are rejected, and deleting or clearing a task removes dangling references.
`claim_task` rejects completed tasks, unresolved blockers, conflicting owners, and an
owner already working on another task.

Task creation and completion fire the gating hook events `task_created` and
`task_completed`. A hook decision of `block` or `ask` prevents persistence. Metadata and
task text are bounded and passed through the existing local-storage redaction boundary.
The focused acceptance evidence is `tests/test_task_graph_tools.py`.

## Structured user interaction contract

TypeScript/Core `question` is the canonical product owner for session-bound
prompts, permission checks, lifecycle events, and Desktop/Bridge settlement.
The Python `arforge.tools.question_tools.ask_user` module remains only as an
explicit compatibility wrapper and is excluded from the default Python
registry. Its legacy `multi_select` and text-answer shape is not a second
product contract; new callers must use TS/Core `multiple` and array answers.

The canonical `question` tool may pause an active agentic turn for one to four
structured questions. Questions have bounded headers and text, two to four
unique options, optional markdown previews for single-select choices, and an
optional multi-select mode. The terminal uses the same validated tool through interactive input; a
non-interactive process fails explicitly instead of waiting indefinitely.

Machine clients receive `question.requested` and answer through
`question.respond` or `question.reject`. The question is bound to its session and
operation, duplicate or cross-session responses are rejected, and the same tool loop
continues with the validated answer. Desktop renders radio buttons, checkboxes,
previews, a client-provided custom-answer field, and an explicit decline action.
Answers alter only the current local operation state and do not mutate workspace
files. Acceptance evidence is in `tests/test_question_runtime.py` and
`desktop/src/features/chat/ChatView.test.tsx`.

## Language service contract

The TypeScript `lsp` tool is the canonical product contract. It exposes one
operation-dispatched, read-only pipeline for definition, references, hover,
document/workspace symbols, implementation, call hierarchy, and diagnostics, plus
an authorization-safe `status` operation. Position-based operations require
1-based `line` and `character`; document, workspace, diagnostics, and status
operations accept only the fields they need. Missing operation-specific fields,
missing files, unsupported extensions, and unreadable targets fail closed with an
actionable error; a missing server for a supported source extension uses the
bounded TS fallback described below.
Permission metadata is stable and contains no command arguments or process secrets.

The tool currently remains opt-in behind `ARFORGE_EXPERIMENTAL_LSP_TOOL` while the
remaining supervisor parity is completed. Once enabled, it uses the existing
TypeScript LSP supervisor and fixed local server definitions over bounded stdio
JSON-RPC; it never launches a user-supplied command. Server lifecycle and
source-file access remain constrained by the workspace authorization boundary,
request/message/file limits, and cooperative shutdown rules. For supported
Python/JavaScript/TypeScript/Go/Rust extensions, no-client requests now use the
same TypeScript owner’s bounded index/lexical fallback (maximum file size, scanned
files, and result count); outside-workspace, unreadable, and oversized targets fail
closed. The fallback provides deterministic symbols/references/hover and delimiter
diagnostics. Python files additionally use a deterministic, no-process syntax
diagnostic subset compatible with the legacy compile contract (unclosed/mismatched
delimiters, unterminated strings, block-colon and indentation errors); the first
diagnostic keeps the `python-compile` source and stable zero-based range. This is
syntax parity only, not Python type checking or semantic analysis.

The supervisor observes the child-process exit promise during initialization. A
cold process that exits before the handshake is marked as a safe per-workspace
failure, is reported by `status` as `error` without command arguments, and is not
retried in the same instance; supported files continue through the bounded TS
fallback. The failure state is in-memory and is never treated as a live server.

The Python `language_service` and `language_service_status` wrappers are retained
only for explicit compatibility imports and migration fixtures. They are excluded
from both the Python built-in registry and deferred auto-discovery, so they cannot
become a second default owner. Their stdio supervisor remains temporary
compatibility code while the TypeScript fallback and supervisor negative/cold
process evidence are completed; only then may the Python runtime be removed.

Acceptance evidence includes `packages/arforge/test/tool/lsp.test.ts`,
`packages/arforge/test/tool/parameters.test.ts`,
`packages/arforge/test/lsp/fallback.test.ts`, the cold-process/error cases in
`packages/arforge/test/lsp/index.test.ts`, the existing TypeScript LSP
client/lifecycle/index suites, and the explicit-compatibility cases in
`tests/test_lsp_runtime.py`.

The same single-owner rule applies to symbol lookup. The old Python
`arforge.tools.symbol_tools` module is now an import-only compatibility seam;
it re-exports the `code_symbols` implementation from `arforge.tools.code_tools`
and is excluded from the default Python registry. This prevents import order
from replacing the canonical schema/output while preserving explicit legacy
imports during the TypeScript migration. New product code should use the
unified TypeScript LSP symbol operations (`documentSymbol`/`workspaceSymbol`)
instead of importing either Python module.

## Structured notebook contract

TypeScript/Core `NotebookTools` is the canonical product owner for both
notebook operations, including workspace resolution, permission metadata,
SHA-256 stale protection, and durable tool events. The Python
`arforge.tools.notebook_tools` module is retained only as an explicit
compatibility wrapper for legacy callers and fixtures; it is excluded from the
default Python registry and must not form a second notebook execution path.

The `notebook_read` tool parses nbformat 4 `.ipynb` files as JSON and returns
bounded cell summaries plus the exact file SHA-256. Cells are addressed by their
native ID when present and by a stable `cell-N` locator for legacy notebooks.
Notebook and cell metadata are preserved, outputs are omitted by default, and
authorized-workspace, UTF-8, file-size, cell-count, source-size, output-count,
cell-shape, and duplicate-ID checks fail closed.

The `notebook_edit` tool supports replace, insert, and delete operations for code,
Markdown, and raw cells. It requires the SHA-256 returned by a prior read, takes a
stale-aware cross-process lock, and writes through the existing backup and atomic
replace layer. Replacing code clears its execution count and outputs; type conversion
adds or removes code-only fields so the resulting cell remains valid. Inserts after
nbformat 4.5 create collision-resistant cell IDs without rewriting IDs into legacy
notebooks. Dry-run returns the same bounded preview without writing.

Dynamic permission classification recognizes `notebook_path` as a write target.
All workspace-write tools now classify an out-of-workspace target as `dangerous`,
while the existing full-access policy remains the only mode that can allow it
without a separate approval. Acceptance evidence is
`tests/test_notebook_runtime.py`, `tests/test_pm_permission.py`, and
`tests/test_pm_decider_loop.py`.

## Managed worktree contract

The TypeScript/Core `Worktree.Service` and durable `ControlOperation` endpoints
(`worktree.create`, `worktree.remove`, and `worktree.reset`) add session-owned Git
worktree lifecycle management without replacing the existing Git branch, checkout,
or one-shot worktree creation interfaces. A clean repository is required before
entering. Names use bounded slash-separated safe segments; the derived branch has
an Arforge-owned prefix and the directory is constrained to the repository sibling
`.arforge-worktrees` root. The historical Python `worktree_enter`,
`worktree_status`, and `worktree_exit` names remain only as an explicit
compatibility import and are not default registry owners.

Bridge operations run inside a session context instead of changing the process-wide
current directory. Existing file, command, Git, code search, language service,
notebook, regression, test runner, workflow, and Core diagnostic tools resolve
their root dynamically. Concurrent sessions can therefore use separate
managed worktrees while sessions without one retain their existing workspace
semantics.

Worktree state is revisioned, atomically replaced, guarded by thread and stale-aware
cross-process locks, and restored by session ID after a process restart. A session
cannot exit another session's worktree or close while its worktree is active.
`keep` returns the session to its original root while preserving the worktree and
branch. `remove` counts uncommitted files and commits since the base revision,
fails closed when state is unknown, and requires explicit `discard_changes` before
destroying work. Directory and branch ownership are revalidated from persisted
state before every activation or cleanup, so a modified state file cannot redirect
the runtime to a manual worktree or primary branch. Removal is dynamically classified
as dangerous while keep remains a normal workspace command. The canonical
acceptance evidence is the TypeScript/Core worktree control-operation suite plus
the Python compatibility regression `tests/test_worktree_runtime.py`.

## Scheduled prompt contract

`schedule_create`, `schedule_list`, `schedule_delete`, and
`schedule_run_missed` add session-owned future prompt execution without
replacing the internal MCP maintenance scheduler or the existing task graph.
Schedules use the standard five-field local-time cron subset with wildcard,
step, range, and list syntax. Jobs may be one-shot or recurring and either
session-only or durable across process restarts.

Prompts, job count, state size, and recurrence lifetime are bounded. Durable
state uses atomic replace plus stale-aware cross-process coordination, and one
process owns durable dispatch at a time. Recurring jobs use deterministic
jitter and expire after seven days. A one-shot job missed while the process
was unavailable is marked `missed` and is never silently executed; it requires
explicit user approval through `schedule_run_missed`. Due prompts re-enter the
normal session chat path, so existing routing, permissions, sandboxing,
worktree scope, tool audit, and cancellation behavior remain authoritative.
Busy or inactive sessions defer dispatch instead of starting a competing
operation. Bridge 1.2 exposes the same lifecycle through `schedule.create`,
`schedule.list`, `schedule.delete`, and `schedule.run_missed`. Acceptance
evidence is `tests/test_scheduled_prompt_runtime.py`.

## Session organization contract

Bridge sessions support up to sixteen bounded, display-safe tags. Tags are
stored in a normalized SQLite relation, compared case-insensitively, returned
by `session.get` and `session.list`, copied when a session is forked, and
restored after restart. `session.tags.update` replaces the complete tag set
only while the session is idle. `session.list` can filter by project, status,
all requested tags, and a title/tag query without changing the legacy
unfiltered behavior.

## Session checkpoint and rewind contract

`session.checkpoint.create` records the latest visible message sequence and a
bounded label. `session.checkpoint.list` returns durable checkpoint metadata.
`session.rewind.preview` reports the exact number of visible messages that
would leave the active context plus an `expected_last_sequence` concurrency
token. `session.rewind.apply` requires that token, rejects a stale preview or
active operation, marks later messages as rewound, and rebuilds the live
agent context from the remaining complete messages.

Rewound messages are retained as bounded local archive rows rather than
treated as current conversation. They are excluded from resume, export,
history search, message counts, and subsequent model context. Conversation
rewind never modifies files, command effects, Git history, or external state;
the response states this explicitly, and workspace rollback continues to use
the existing diff rollback or `run.revert` contract. Acceptance evidence is
`tests/test_session_organization_rewind.py`.

## Deferred tool discovery contract

The `deferred_tool_loading` feature flag preserves the legacy full-schema
export when disabled. When enabled, core file, command, test, plan, question,
task, and subagent tools remain immediately visible while heavier browser,
web, notebook, language-service, worktree, workflow, scheduling, asset, and
dynamic MCP schemas are omitted until selected. Worktree execution itself is
owned by the TypeScript/Core control-operation pipeline; the Python worktree
module is explicit migration compatibility only. The TypeScript/Core notebook
tools are the default owner; the Python notebook module is explicit migration
compatibility only. The TypeScript/Core `question` tool is likewise the default
interactive-question owner; the Python `ask_user` module is explicit migration
compatibility only.

`tool_search` is always visible and accepts ranked keywords, `+required`
terms, an exact tool name, or `select:name_a,name_b`. Search is limited to the
active role allowlist and returns complete function schemas. Matching tools
are activated only inside the current agent run through a `ContextVar`; nested
runs and worker threads start with independent selections. The agent loop
rebuilds its schema list immediately before every model request, so a selected
tool is callable on the next step without restarting the turn.

The discovery tool is medium risk to keep selection mutation on the owning
execution thread. Existing permission, sandbox, confirmation, timeout, and
execution behavior remains authoritative after activation. `ToolLoopResult`
continues to provide typed attributes and now also offers read-only `get()` /
`to_dict()` compatibility for older consumers. Acceptance evidence is
`tests/test_deferred_tool_loading.py`, `tests/test_p0_2_agentic_loop.py`,
`tests/test_v1_g6_resume.py`, and `tests/test_p1_8_observability.py`.

## Session-owned team and mailbox contract

Each lead session may own at most one durable team. A team has an implicit
`lead` identity and up to eight collaborators, each mapped one-to-one to an
existing Arforge subagent role. Member names and roles are unique within the
team. Team state, messages, shutdown requests, monotonic message sequences,
and member lifecycle states use a revisioned JSON store with thread and
stale-aware cross-process locks, bounded size, `fsync`, and atomic replace.

Direct messages must target a member in the same team. Broadcast records the
exact active recipients and excludes the sender and stopped members. Inbox
reads expose only messages addressed to the current lead or subagent member;
there is no team ID or session ID parameter available to a member tool, so it
cannot redirect a message into another team. The safe communication tools
`team_message_send`, `team_message_list`, and `team_shutdown_respond` are added
to subagent role tool sets; lifecycle creation, member mutation, shutdown
requests, and deletion remain lead-only.

Removing a member requires a pending shutdown request followed by that same
member's explicit approval. Rejection returns the member to active state and
requires a reason. A team cannot be deleted while any collaborator remains
active or waiting to answer shutdown. Deletion removes the complete team row,
mailbox, and shutdown metadata atomically. Bridge sessions cannot close while
they still own a team, preventing orphaned team state. Existing short-lived
`AgentChannel` communication remains unchanged for one-dispatch collaboration.
Acceptance evidence is `tests/test_team_runtime.py` and the existing
multiagent/Bridge regression suites.

## Production MCP client contract

Arforge supports external MCP servers through bounded stdio, streamable HTTP,
and SSE-bootstrap clients. The existing MCP server, plugin, resource, prompt,
sampling, and external bridge APIs remain in place; the public
`MCPConnection` import now delegates to the production stdio implementation so
existing callers gain real timeouts and cancellation without an API migration.

Stdio servers are launched without a shell, with a minimal inherited
environment, hidden windows on Windows, bounded stdout/stderr, one in-flight
request per connection, and independent reader queues for every process
generation. HTTP is permitted without TLS only on loopback addresses. Remote
URLs require HTTPS and reject embedded credentials or fragments. Both
transports bound response size, normalize protocol failures, support
reconnection, and expose resource list/read operations.

Bearer tokens are resolved from a named environment variable at request time.
OAuth client credentials resolve the secret through a host callback, cache only
the short-lived access token in memory, and redact credentials and URL query
data from public state and representations. The TypeScript/Core MCP service and
its native ToolRegistry projections own connected-server inspection,
generation-bound capability catalogs, resource/prompt listing and reads, and
dynamic schema refresh. The old Python `mcp_client_tools` module is an explicit
compatibility import only and is not loaded by the default Python registry; it
cannot become a second MCP client or tool owner. Neither path lets the model
create connections or request credential material.

External schemas are validated before replacement and registered as deferred
Arforge tools under a server namespace. Refresh reports added, removed, and
changed tools. Name normalization collisions receive deterministic suffixes;
conflicts are rejected before any old registration is removed. Dynamic
arguments pass through unchanged while server and remote-tool ownership remain
closed over by the host and cannot be redirected through model arguments.
Disconnect removes all registrations owned by that connection. Acceptance
evidence is `tests/test_mcp_client_runtime.py` plus the existing MCP and tool
registry suites.

The canonical `multimodal.diagnose` path now also performs local, read-only
OOXML extraction for DOCX, XLSX, and PPTX, and treats CSV/TSV as bounded UTF-8
document sources. The Office reader is dependency-free and fail-closed: it
limits archive size, entry count, per-entry and expanded bytes; rejects ZIP64,
encrypted entries, unsafe paths, malformed central/local headers, CRC-32
integrity mismatches and unsupported compression; and reads only text-bearing
parts with namespace-prefix agnostic matching. This extends the existing
diagnosis contract without launching Office, making network calls, or writing
artifacts. The first write slices are now fused into the canonical `write`
tool: `.xlsx` content is accepted as a bounded JSON array of rows (array rows
or first-seen-key object rows), `.docx` content is accepted as bounded
Markdown-like text, `.pptx` content is accepted as a bounded JSON array of
slides, and `.pdf` content is accepted as bounded Markdown-like text. All
four are encoded deterministically (OOXML for Office formats and a portable
A4 PDF with CJK/ASCII text, wrapping, pagination and page numbers) and sent
through the existing LocationMutation, permission, ActionGateway and
FileMutation path. Malformed JSON, unsupported cell values, XML/PDF control
characters, row/column/text/output limits, and excessive DOCX/PDF lines fail
before mutation. This does not yet fully replace the Python
`read_office_document`/`write_docx`/`write_pptx`/`write_pdf` compatibility
behavior; remaining format parity and Artifact/Sandbox integration must stay
under the same Core owner and is not registered a second time in Core.

The same `multimodal.diagnose` contract accepts `mode=frontend` and
`mode=javascript`. These modes read only workspace-local UTF-8 HTML/HTM/JS/JSX/
MJS/CJS/Vue files (or an explicit extracted-text override), apply bounded
deterministic delimiter scanning that ignores strings/comments, and return a
versioned frontend report with HTML closing-tag checks, script and blocking
counts, Vue mount-target/router/icon checks, undeclared-app warnings, and
external-asset references. Reachability is intentionally reported as
"not checked"; the tool never fetches URLs, disables TLS verification, runs
JavaScript, or writes files. The legacy Python `validate_frontend` and
`validate_js` modules remain explicit compatibility imports only and are not
default registry owners. Legacy `download_asset`/`download_all_cdn` are also
explicit-only until a staged TypeScript composition can bind webfetch egress,
write CAS, and rollback in one durable operation; no unsafe direct CDN writer
is promoted as a second Core tool.

The historical `multimodal-diagnose` Python CLI entry now forwards to the same
TypeScript command owner. `arforge multimodal-diagnose <file>` accepts a
workspace root, optional extracted text, one of the three modes, a 1–50 result
limit and JSON output; it calls the generated typed diagnostics route rather
than importing Python code. Cross-process tests compare the Python bridge and
direct Bun invocation, and assert the local-only/model-call-zero/no-write
boundary.

The historical Python `features` CLI now forwards to a single read-only
TypeScript/Core projection: `features list` calls the typed
`agentCapability.deepInsights` endpoint and selects its `features` section,
which is also consumed by Desktop. The projection is limited to
TS-native flags and never opens the legacy `feature_flags.json`. `set`,
`clear`, and `refresh` retain strict argument validation but return exit 2
with a `fail-closed` migration message until a permissioned transactional
feature-policy writer, audit evidence, and rollback contract are available.

`features --contract-audit --json` is the explicit migration diagnostic for this
boundary. It is a pure TS/Core report with `not_ready`, `ready=false`, and
`writes=0`; the Desktop `feature-policy-contract` deep-insights section uses the
same report. It does not inspect `feature_flags.json` and cannot enable a
second feature-policy state owner.

The historical Python `permissions` CLI now forwards to a single
TypeScript/Core read-only projection. `permissions list` calls the typed
`permission.saved.list` endpoint scoped to the current workspace and emits
the same rule records that Desktop consumes; `--json` uses a stable
`schema_version`/`count`/`items` envelope. The command never opens the legacy
Python `permission_rules.json`. `add` and `revoke` retain strict legacy
argument validation but return exit 2 with a `fail-closed` migration message
until a transaction, authorization, audit and rollback-safe TS writer is
proven, so there is no second permission state owner.

`permissions --contract-audit --json` exposes the same permission-policy gap as
a structured read-only report (`not_ready`, `ready=false`, `writes=0`). The
Desktop `permission-policy-contract` section and this CLI command share the
Core analysis, including the optimistic-revision and cross-process gates; the
legacy `permission_rules.json` remains unopened.

External asset URL values in the structured report, issue details, formatted
diagnostics, and the optional localization preview preserve host/path and
query keys but replace every query value with `[REDACTED]`; exact request
digests remain internal discovery evidence. This keeps the advanced raw
evidence panel useful without allowing credential-like query values to cross
the diagnostics API or UI.

The Desktop Control Center uses one Diagnostics workbench for all three modes.
It presents a plain-language mode selector and mode-specific hint, reports
success/findings, source, local-only/model-call facts, bounded issue summaries,
and next-step suggestions before exposing the raw JSON evidence in an explicit
advanced disclosure. The active HTTP request carries an AbortSignal and can be
cancelled by the user; cancellation is shown as a no-change outcome and never
creates a mutation or a retry. This is a presentation and transport control
only: the canonical Core diagnosis contract, permission boundary, and local
read-only guarantees remain unchanged.

The future CDN localization path now has a pure TypeScript planning seam at
`@arforge-ai/core/runtime/asset-localization`. It extracts only external
`script[src]` and stylesheet `link[href]` references, caps HTML/reference/asset
sizes, rejects credentials and unsupported MIME types, records redirect
destinations, deduplicates bytes by SHA-256, and produces content-addressed
workspace-relative staging targets plus an atomic HTML rewrite. Its
`discover()` phase snapshots the normalized HTML resource, reference order,
network scope, and a stable request digest before any fetch is authorized;
`plan()` recomputes that digest against fresh HTML and rejects a changed
document. The planner does not fetch, write, or execute anything. Its
`inputDigest`, discovery digest, network scope, filesystem scope, and expected
writes are the exact metadata that a future ActionGateway adapter must bind to
one approval, mutation-intent journal, CAS/rollback artifact set, and
crash/restart reconciliation. Missing fetches, conflicting results, nested
external stylesheet imports, unsafe resources, and size limits fail before a
plan containing writes is returned; the legacy Python CDN writers therefore
remain explicit compatibility only.

The first execution adapter now exists at
`@arforge-ai/core/runtime/asset-localization-action`. It reads the source,
builds the discovery-bound `asset-localization` ActionGateway request (with a
bounded `file-prefix:` asset-root resource), derives egress from the verified
gateway capability, and requires the canonical Core `FileMutation` owner plus
the profile-owned rollback-artifact store. It fetches through the existing
`WebFetchTool.fetchRawAsset` transport seam, rechecks every redirect, replans
against fresh HTML, stages inverse bytes before the durable `prepared`
checkpoint, commits each target with CAS/create semantics, and records
`prepared → committed → settled` or `rollback_required → rolled_back` in the
existing mutation-intent stream. A settlement-write failure is surfaced as
`outcome_unknown` and is never retried automatically. This is an internal
adapter contract and SQLite-testable transaction path only; no new model tool,
endpoint, registry owner, or real cross-platform sandbox claim is made until
the Browser/Desktop product route and restart UI are closed.

The isolated SQLite acceptance slice now runs the same adapter against a real
`Database.layerFromPath()`/`DurableAction` aggregate: allow/approval persists
one settled mutation manifest, denial and download failure stop before any
manifest or workspace change, pending approval can be cancelled into a durable
`cancelled` action, and a simulated settlement-record loss leaves committed
files explicitly `outcome_unknown` without an automatic retry. An asset-specific
SIGKILL probe also uses real Core `FileMutation` and profile rollback artifacts:
the child persists the `committed` intent and files, is terminated, and a fresh
process reopens the same SQLite/workspace, obtains a fresh postimage fingerprint,
and settles only through explicit `reviewMutationIntent(settle_postimage)`;
replay remains blocked and the side-effect counter stays at zero. These tests
close the Core crash/restart boundary, but are not permission to expose a
product route; Browser/Desktop multi-role journeys are still required before
enabling it.

The Desktop acceptance seed now also executes the real adapter in the same
isolated SQLite/workspace used by Electron. `desktop-runtime-insight-review`
asserts that the persisted `asset-localization` action is visible as a settled
durable-action card, that `src/index.html` contains the content-addressed
`vendor/js/<sha256>.js` reference, and that exactly one staged asset file is
present. The callback uses deterministic bytes and still receives the
ActionGateway-derived egress capability, so this is a local projection test,
not a claim of live CDN access. The same acceptance now creates a real Session
against an isolated deterministic OpenAI-compatible test provider, receives a
real `bash` tool proposal, opens the originating Session route through the
desktop memory router, and cancels the `awaiting_approval` action from Runtime
Insight. It verifies the backend `DurableAction` becomes `cancelled` before
execution, the UI button disappears after the authoritative refresh, and no
side effect is produced. The build and packaged Electron modes both pass this
generic pending-action journey; the asset-specific product route, live CDN
approval flow, and restart-specific asset controls remain closed until they
are wired without introducing another owner.

Durable operation progress is now an observational checkpoint on that same
ActionGateway/EventV2 aggregate. `OperationExecutionContext.reportProgress`
accepts only bounded phases, counters, and control-character-free detail;
`DurableAction` assigns the monotonic sequence/timestamp, treats exact
duplicates as idempotent, and rejects identity mismatches, over-total counts,
clock regressions, and updates after terminal state. The asset adapter reports
discovery, authorization wait, fetch, planning, preparation, commit, and
settlement metadata without URLs, paths, response bytes, or credentials. The
Runtime Insight card renders this progress in all supported UI locales with an
`aria-live` region and an explicit read-only notice. Cancellation remains a
requesting-session operation before execution handoff; Formal/Core
`SessionExecution.interrupt` first asks the same location-scoped
`ActionGateway` to CAS-cancel its registered pending session actions, then
interrupts the runner. The gateway keeps the exact canonical input/plan and
uses a proposal-ready latch so a late proposal cannot escape cancellation;
authorized/executing races are recorded as handoff/review rather than a false
cancel. Runtime Insight never turns a progress card into execution authority.
The Browser acceptance fixture asserts the localized progress card and a real
pending-approval cancellation with no side effect. Electron acceptance now
asserts the real persisted settled projection plus the generic pending-action
originating-session cancellation in both unpacked-build and packaged modes;
the deterministic test provider is an acceptance seam, not a live provider or
asset CDN claim. The asset product route, asset-specific in-flight
cancellation control, and asset-specific restart UI remain closed pending the
same owner/authorization evidence.

The Browser role matrix also renders a second pending asset action owned by a
different Session: members can inspect it but receive no cancel control because
the originating-session identity does not match. A separate administrator
journey exposes the existing guarded rollback control after fresh inspection;
member recovery remains read-only. These are deterministic fixture checks of
the shared capability contract, not a claim that the fixture replaces
production identity or multi-tenant authorization.

Runtime Insight now includes a request-scoped, metadata-only `access`
projection on both the snapshot and recovery response. It reports the
authenticated role and four bounded capabilities without user, tenant, or
profile identifiers: evidence-only mutation review is available to every
authenticated role, while guarded rollback, inverse-artifact maintenance, and
MCP evidence recording require owner/admin. The rollback handler enforces the
same boundary server-side and returns a forbidden result before reading or
writing workspace bytes. Browser/Desktop renders the capability notice and
keeps member recovery read-only; the asset-localization adapter remains
internal until its product route supplies the same approval/cancel/restart
journey.

The Runtime Insight workbench treats the resolved directory/workspace pair as
one scope key. When that key changes, it refreshes from the new scope, clears
old recovery inspection, MCP reconciliation, verification, maintenance and
confirmation state, and drops a late response from the previous scope. If a
refresh is already in flight, exactly one follow-up refresh is queued for the
latest scope. This is a UI consistency boundary only; authorization and durable
state remain owned by the location-scoped server routes and ActionGateway.

The same boundary is used by the System Overview control-center surface: its
parallel health, Agent, capability and runtime-overview reads capture one
location scope and discard a late result after a workspace change. The
read-only `custom-agents list/validate` presentation additionally exposes a
bounded admission-evidence card (decision, four invariant checks and a short
descriptor digest) while keeping the historical JSON profile contract free of
diagnostic fields.

All Runtime Insight asynchronous operations share the same UI request-generation
guard: snapshot refresh, audit verification, artifact audit/sweep, recovery
inspection/review/rollback/cancel, and MCP inspection/evidence recording capture
the current scope before dispatch and may update state only while that scope and
generation are still current. A stale response is dropped (and cannot clear a
new operation's busy marker); changing scope clears the old operation markers
before the replacement snapshot is shown. This guard is a presentation
consistency aid, not a replacement for server-side authorization, CAS, or
durable settlement.

The mature Arforge `write` entry delegates to these same Core encoders. It
uses the same CAS journal and durable mutation-intent path, stages inverse
bytes when a rollback artifact service is present, and skips text-only
formatter/BOM/LSP post-processing for binary Office/PDF outputs. Permission
approval and event/watcher settlement remain shared, so the mature entry does
not create a second Office registry or a second write owner. The documented
limits and partial-parity boundary above apply equally to both entry points.
The legacy Python `office_tools` module is no longer part of the default
Python tool bootstrap (and the legacy DOCX registration is no longer emitted
by `file_tools`); old callers must explicitly import that compatibility seam.
This keeps the TypeScript/Core `write` path as the only default product owner
without deleting the migration-time Python API.

The durable task graph follows the same ownership rule. TypeScript/Core
`TaskGraphV2` and its `task-graph` tools own session-scoped persistence,
optimistic revisions, dependency validation, policy gates, and authorization.
The legacy Python `task_tools` module is no longer loaded by the default
Python bootstrap; `load_compatibility_tools()` (or an explicit module import)
is required for old embeddings. The compatibility store is not a second
product task graph and new product code must use the Core service.

## Primary message and local attachment delivery contract

`deliver_user_message` publishes the primary answer for the current agent run.
The TypeScript/Core tool and `PrimaryDelivery` service are the sole product
owner: they enforce the bounded Markdown message, honest `normal` or
`proactive` classification, Goal completion gate, authorization, attachment
type/size/path checks, and durable event projection. Up to eight existing local
files may be attached and are never uploaded. Once a delivery occurs, later
model prose is not streamed as a duplicate answer and the last delivery becomes
the durable assistant message. The old Python
`arforge.tools.user_message_tools` module is explicit compatibility only and is
excluded from the default Python registry, preventing a second schema or
delivery journal.

Attachments resolve relative to the active execution workspace and must remain
inside the primary or separately trusted workspace roots. They must be regular,
non-symlink files with an allowlisted document, text, code, image, diff, log, or
archive suffix. Per-file and aggregate sizes are bounded. The runtime records
MIME type, byte size, display name, SHA-256, and stable artifact ID while
detecting files that change during inspection. Attachments remain local:
delivery metadata explicitly reports `local_only=true` and `uploaded=false`;
the model cannot request a private upload or obtain a credential.

The Bridge emits `message.delivered`, merges attachment artifacts without
duplicates, and stores a separate `delivery_json` channel alongside content,
reasoning, tool events, and artifacts. Resume, export, checkpoint history, and
session forks preserve the delivery classification and attachment metadata.
Legacy databases add the new column idempotently.

Arforge Desktop replaces any provisional streamed body with the delivered
primary message, labels proactive updates, restores delivery metadata from
history, and renders attachment name, type, size, path, and local open actions.
The Tauri host canonicalizes and validates paths before invoking the operating
system directly; no shell command interpreter is used. Acceptance evidence is
`tests/test_user_message_delivery.py`, `tests/test_message_model.py`, the
Bridge session suites, the Desktop component suite, the production frontend
build, and `cargo check`.

## Session plan and todo contract

TypeScript/Core `todowrite` is the sole product owner for the session-scoped
structured todo list: its schema, permission check, atomic replacement,
persistence projection, and Desktop/Bridge event consumers are one contract.
The old Python `arforge.tools.plan_tools.update_plan` module is retained only
as an explicit migration compatibility wrapper and is excluded from the
default Python registry. Its in-memory `TaskLedger` behavior must not be
treated as a second product planning state machine or written in parallel with
the TypeScript/Core session todo projection.

## Provider-neutral trigger contract

Arforge exposes the same `list`, `get`, `create`, `update`, and `run` lifecycle
for two kinds of host-owned trigger profile. The reserved `local` profile maps
to the existing session-owned scheduled prompt manager. HTTP profiles target an
explicit base endpoint configured by the host through
`ARFORGE_TRIGGER_PROFILES` or the Python API. The model can list profile
metadata and use configured profiles, but cannot create a profile, choose an
arbitrary URL, submit authentication material, or inspect credential values.

Local triggers add bounded names and an enabled flag while preserving the
existing cron parser, durable ownership, missed-run confirmation, single
dispatcher, jitter, expiry, and normal agent permission pipeline. They can be
queried, partially updated, enabled or disabled, and explicitly run without
silently deleting or rescheduling the underlying job. A Bridge-triggered local
run starts a normal session operation and is rejected while that session is
already busy.

Remote base URLs reject embedded credentials, fragments, queries, and
non-loopback cleartext HTTP. Routes are fixed by the runtime:
`GET <base>`, `GET <base>/<id>`, `POST <base>`,
`POST <base>/<id>`, and `POST <base>/<id>/run`. IDs, request nesting, request
bytes, response bytes, timeouts, headers, and JSON types are bounded.
Redirects are not followed, so an authorization header cannot be forwarded to
an unconfigured origin.

Bearer values are resolved from a named environment variable at request time.
OAuth client credentials reuse the bounded in-memory provider used by the MCP
client. Tokens never enter shell arguments, tool parameters, public profile
state, object representations, or safe network errors. The deferred
`trigger_manage` tool is classified as a confirmed network action; the
read-only `trigger_profiles` tool exposes only safe configuration metadata.
Bridge 1.2 exposes `trigger.profiles`, `trigger.list`, `trigger.get`,
`trigger.create`, `trigger.update`, and `trigger.run`. Acceptance evidence is
`tests/test_trigger_runtime.py` and the scheduled prompt, Bridge, tool schema,
deferred loading, and permission regression suites.

## Cooperative wait, wake, and check-in contract

`cooperative_wait` is a low-risk deferred tool for bounded pauses that do not
start or occupy a shell process. The TypeScript/Core tool is the product owner
and is the only default registered definition. The old Python
`arforge.tools.wait_tools` module remains an explicit compatibility import for
legacy loops and fixtures, but is excluded from the default Python registry so
it cannot compete on schema, permission metadata, or output ownership. A wait
lasts from 0.05 to 300 seconds, has a bounded periodic check-in interval, and
permits at most 120 check-ins. One session may own only one active wait, so
concurrent model calls cannot hide multiple independent sleepers behind the
same conversation.

The runtime emits `wait.started`, periodic `wait.check_in`, and exactly one
terminal event: `wait.completed`, `wait.woken`, `wait.cancelled`, or
`wait.timed_out`. Host observers are isolated from the waiting thread; an
observer failure cannot abort or extend the wait. Bridge clients can inspect
the current wait and request wake-up using the backend-issued `wait_id`.
Cross-session and stale identifiers fail closed.

The operation cancellation event and monotonic operation deadline are bound to
the wait through a run-local context. Tool registry worker threads receive a
copy of that context, so low-risk parallel tool execution retains the correct
session, cancellation, deadline, and event sink. Desktop records start and
terminal wait states without appending every check-in to the visible transcript.
Acceptance evidence is `tests/test_wait_runtime.py`, the Bridge session suites,
the deferred tool/schema suites, Desktop tests, and the production frontend
build.

## Desktop session operations contract

Arforge Desktop exposes the existing session organization and scheduling
contracts through a dedicated operational view. It does not duplicate state:
all edits use Bridge 1.2 methods and refresh from backend-owned records.

The sidebar tag filter submits normalized comma-separated tags to
`session.list`; clearing it restores the unfiltered list. The current session
view edits tags through `session.tags.update` and remains compatible with
legacy session payloads that omit the optional `tags` field.

Scheduled prompts can be listed, created, and deleted. The form exposes the
cron expression, prompt, recurring flag, and durable flag. A missed one-shot
can run only after explicit confirmation. Its accepted operation is adopted by
the normal chat controller, including buffered Bridge events, so the result is
not hidden in an unrelated background surface.

Checkpoints can be created and listed while the session is idle. Rewind always
starts with `session.rewind.preview`, displays the number of affected messages,
and states that file, command, Git, and external side effects remain unchanged.
Applying the preview requires a second explicit confirmation and sends the
backend-issued `expected_last_sequence`; a stale preview therefore remains
fail-closed. After success, Desktop reloads the session transcript from the
Bridge.

Focused component tests cover tags, schedule creation, missed-run adoption,
preview, confirmation, and apply. The complete Desktop suite, TypeScript
production build, and browser viewport checks cover integration, responsive
layout, and zero horizontal overflow.
