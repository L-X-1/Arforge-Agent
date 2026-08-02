# Arforge Agent 功能契约

本文件早期章节曾定义 Python/Tauri 纵切。当前权威产品契约是统一 TypeScript
Core/Server/CLI/App/Desktop；Python 能力通过 capability bridge 接入，不再是唯一
命令源。下文保留的 Machine Bridge 细节用于兼容迁移审计。

## 当前可交付界面

| 界面 | 状态 | 契约 |
| --- | --- | --- |
| 统一 TypeScript CLI | 已实现 | 正式命令行入口，与 Server/Session 共用契约 |
| Electron Desktop | 已实现 | 使用共享 App、Server、Provider、Session 和 Permission |
| Web / ACP / MCP | 已实现 | 使用同一服务契约，不维护第二份会话状态 |
| Python CLI / Tauri | 兼容基线 | 仅验证尚未迁移能力，不是默认入口 |

桌面端通过本地 HTTP/Effect API 与统一 Core 通信，禁止通过抓取 ANSI 终端文本接入。

## Machine bridge (desktop backend contract)

`arforge-bridge` is the canonical JSONL-over-stdio backend for non-terminal clients. Protocol 1.0 remains a read-only compatibility surface. Protocol 1.1 adds isolated in-process sessions, accepted background chat operations, ordered events, cooperative cancellation and timeout, concurrency limits and blocking transport backpressure. Every response carries the request ID, protocol version, explicit `ok`, and either structured `data` or a stable error object. Configuration output exposes booleans and credential-free targets only.

Plan Mode uses the read-only `plan.preview` Bridge method as the shared structured contract for non-terminal clients. It accepts a task plus plan text and returns `schema_version`, `mode=plan`, `approval_required`, `execution_mode_after_approval=acceptEdits`, affected files, pending steps, risk notes, rollback notes and the raw plan. This method is a preview/normalization surface only: it does not approve execution, change permission mode, write files or mutate workspace state. Desktop may render the returned object as a plan card before any user-approved edit flow.

Desktop clients must consume this bridge and must not parse CLI or ANSI output. Bridge 1.1 exposes backend-owned one-time tool approvals, hash-guarded diff preview/apply/reject/rollback state machines, background tool tasks with query/cancel/safe-retry methods, bounded redacted log pagination and revisioned non-sensitive settings. It also exposes release readiness facts such as `release.gates` and `release.remediation_plan` as read-only product state for Desktop and other machine clients; Desktop Overview renders both the current fail-closed gate verdict and the ordered remediation items from this Bridge data flow. Agentic run observability is exposed through read-only `run.list` and `run.report`, which load persisted run artifacts rather than terminal text; `run.revert` is a guarded workspace-mutating method that restores a persisted run transaction and must only be invoked after explicit user action. Stage 4 memory governance is exposed through read-only `memory.status`, `memory.search`, `memory.facets`, `memory.semantic_search` and `memory.recall_quality` plus explicit `memory.update`, `memory.delete` and `memory.bulk_delete`; Desktop Overview can list local memories, counts, type/source/tags/project/workspace, filter by text/type/tag/source/project/workspace/importance, navigate project/workspace/type/source facets, run scoped local hybrid/vector semantic recall, show a scoped BM25 self-recall quality baseline, edit one stale or incorrect memory, delete one bad memory, and bulk delete only explicitly selected visible memory IDs after user action. The recall quality report is deterministic local operational telemetry over saved memory rows, not a causal production-quality proof. The default semantic recall path uses local deterministic hashing embeddings plus BM25/hybrid retrieval, so it does not require an external provider; external vector infrastructure remains an optional future backend choice. Memory writes persist `project_id` and `workspace_path`; existing unscoped rows remain searchable without fabricating project ownership, while new rows default to a deterministic current-workspace project key unless callers pass explicit scope. Stage 4 learning activation is exposed through read-only `learning.status`, which reports recent learnings, discovered patterns, confidence, dogfood totals, injection participation and observed injected-vs-baseline success impact. The impact metric is operational telemetry over recorded outcomes, not a randomized experiment, and stays `insufficient_data` until both cohorts meet the minimum sample threshold. Learning governance uses explicit `learning.undo` calls to remove one bad learning outcome from the local learning database after user confirmation; it returns `linked_patterns` for any conservatively deleted or decremented auto-generated failure patterns whose source can be proven from the deleted outcome. `learning.dogfood_sync` is an explicit stateful local-product action that idempotently imports append-only dogfood outcomes into structured learning records; it is not a workspace-file mutation. These governance actions are stateful and mutating, but they are not workspace-file mutations. Explicit product feedback is exposed through local-only `feedback.summary`, `feedback.list`, `feedback.submit` and `feedback.delete` methods. Submission redacts sensitive values before SQLite persistence, may associate the current session, and best-effort records non-neutral ratings through the formal learning engine without allowing learning failures to break feedback storage. The Desktop settings surface renders the same contract and never uploads feedback. Stage 4 multimodal diagnostics are exposed through read-only `multimodal.diagnose`, which accepts only workspace-relative files plus optional extracted text and returns structured text extraction, error signals, code matches and repair suggestions; Desktop Diagnostics renders that Bridge response without editing files. Only `tool.execute`, `tool.execute_async`, `diff.apply`, `diff.rollback` and `run.revert` may mutate the workspace; `settings.update`, `permissions.mode.set`, `memory.update`, `memory.delete`, `memory.bulk_delete`, `learning.undo`, `learning.dogfood_sync`, `feedback.submit` and `feedback.delete` mutate only isolated profile or local product state. Project, session and redacted conversation text persist in the isolated local profile so an interrupted conversation can be reopened and resumed; history is bounded to 500 messages per session and is included by `arforge export` and removed by `arforge clear-data`. Tool arguments/results and diff content remain intentionally unavailable after restart. Active tasks recover as `interrupted`; approvals and unfinished actions recover as `invalidated`; applied diffs recover as `applied_unrecoverable`.

## 顶层命令与后端能力

| 用户命令 | 后端实现 | 成功条件 | 失败语义 |
| --- | --- | --- | --- |
| `chat` / `ask` | `ArforgeAgent` | 返回真实模型/工具/多 Agent 结果 | 后端异常返回非零；工具失败不可伪装为模型成功 |
| `doctor` | `product.doctor.run_checks` | 必需检查无失败 | 有失败项返回 1 |
| `privacy` | `privacy_audit` | 显示当前隔离 profile | 不输出凭据值 |
| `export` | `export_data` | 文件成功落盘 | 写入/查询失败返回 1 |
| `clear-data` | `clear_local_data` | dry-run 或确认删除完成 | 拒绝/失败返回非零，凭据默认保留 |
| `logs-prune` | `prune_logs` | 保留期参数有效且清理完成 | 参数错误返回 2，I/O 失败非零 |
| `secrets-scan` | `scan_sensitive_files` | 无命中 | 有敏感样式命中返回 1且不显示原值 |
| `status` | `status.get_status` | 后端状态读取完成 | 未处理异常由顶层边界脱敏并返回 1 |
| `tools` | Tool Registry | schema 和风险可读取 | 注册/加载失败非零 |
| `agents` | SubAgent Pool | 角色元数据可读取 | 不得用空列表冒充“已启用” |
| `capabilities` | Capability Engine | 状态/测试真实执行 | 测试缺参数返回非零 |
| `memory` / `learning` | PostgreSQL 持久层 | 统计与列表读取完成 | 数据库失败脱敏并返回 1 |
| `config` | canonical config loader | 仅显示掩码/非敏感配置 | 永不输出完整密钥或数据库凭据 |
| `db-*` | backup + Alembic | 操作完成且确认要求满足 | 参数错误 2；拒绝/运行失败 1 |

## 一致性规则

1. `COMMANDS_HELP` 与 `_COMMAND_MAP` 必须一一对应。
2. `--verbose`、`--no-stream` 在命令前后含义一致。
3. `main.py`、`python -m arforge`、Python console script 和 npm wrapper 保留相同退出码。
4. npm postinstall 创建包内私有 `.venv`；缺少 Python 3.10+ 或后端安装失败时，npm 安装必须失败。
5. 复杂请求由确定性预路由进入 `MasterAgent`；高置信提示注入必须在 MasterAgent/模型前阻断。
6. `ARFORGE_HOME` 是所有运行状态的唯一 profile 根目录。
7. 用户可见数据库描述必须隐藏用户名和密码。
8. 未知参数、重复危险参数和多余位置参数返回用法错误，不得静默忽略。

## 自动验收证据

- `tests/test_cli_contract.py`：帮助、处理器、选项、退出码、错误脱敏和多 Agent 路由。
- `tests/test_m6_packaging.py`：Node/Python 输出一致、npm 安装器隔离及 shell 安全。
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

The `ask_user` tool may pause an active agentic turn for one to four structured
questions. Questions have bounded headers and text, two to four unique options,
optional markdown previews for single-select choices, and an optional multi-select
mode. The terminal uses the same validated tool through interactive input; a
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

The read-only `language_service` tool supports definition, references, hover,
document/workspace symbols, implementation, call hierarchy, and diagnostics with
1-based line and character inputs. It resolves the target through the existing
workspace authorization boundary, rejects missing, oversized, out-of-workspace, and
invalid-position targets, and never launches a user-supplied command.

For Python, JavaScript/TypeScript, Go, and Rust, the runtime discovers fixed local
language-server commands and communicates over bounded stdio JSON-RPC without a
shell. Server processes receive a credential-minimized environment, requests have a
timeout, messages and source files are limited to 10 MB, documents use
`didOpen`/`didChange`, and shutdown is cooperative with a forced-process fallback.
When no compatible server is installed or a request fails, the result explicitly
uses `backend=index-fallback` and reuses the existing symbol/reference index. Broken
source files retain lexical definition navigation and Python compile diagnostics.
`language_service_status` reports availability without exposing command arguments.
Acceptance evidence is `tests/test_lsp_runtime.py`.

## Structured notebook contract

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

`worktree_enter`, `worktree_status`, and `worktree_exit` add session-owned Git
worktree lifecycle management without replacing the existing Git branch, checkout,
or one-shot worktree creation interfaces. A clean repository is required before
entering. Names use bounded slash-separated safe segments; the derived branch has
an Arforge-owned prefix and the directory is constrained to the repository sibling
`.arforge-worktrees` root.

Bridge operations run inside a session context instead of changing the process-wide
current directory. Existing file, command, Git, code search, language service,
notebook, regression, test runner, workflow, frontend, JavaScript, and asset tools
resolve their root dynamically. Concurrent sessions can therefore use separate
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
as dangerous while keep remains a normal workspace command. Acceptance evidence is
`tests/test_worktree_runtime.py`.

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
dynamic MCP schemas are omitted until selected.

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
data from public state and representations. Agent tools can inspect connected
servers, list/read resources, and refresh schemas, but cannot create
connections or request credential material.

External schemas are validated before replacement and registered as deferred
Arforge tools under a server namespace. Refresh reports added, removed, and
changed tools. Name normalization collisions receive deterministic suffixes;
conflicts are rejected before any old registration is removed. Dynamic
arguments pass through unchanged while server and remote-tool ownership remain
closed over by the host and cannot be redirected through model arguments.
Disconnect removes all registrations owned by that connection. Acceptance
evidence is `tests/test_mcp_client_runtime.py` plus the existing MCP and tool
registry suites.

## Primary message and local attachment delivery contract

`deliver_user_message` publishes the primary answer for the current agent run.
It accepts a bounded Markdown message, an honest `normal` or `proactive`
classification, and up to eight existing local files. Once a delivery occurs,
later model prose is not streamed as a duplicate answer and the last delivery
becomes the durable assistant message.

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
start or occupy a shell process. A wait lasts from 0.05 to 300 seconds, has a
bounded periodic check-in interval, and permits at most 120 check-ins. One
session may own only one active wait, so concurrent model calls cannot hide
multiple independent sleepers behind the same conversation.

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
