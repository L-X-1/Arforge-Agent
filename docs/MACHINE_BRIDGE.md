# Arforge Machine Bridge 1.1

`arforge-bridge` is the supported backend process for desktop and other non-terminal clients. It reads one UTF-8 JSON request per line from stdin and writes exactly one compact JSON response per line to stdout. Human-readable CLI output and ANSI sequences are never part of this interface.

## Request

```json
{"protocol":"arforge.bridge","version":"1.1","id":"request-1","method":"health","params":{}}
```

- Version 1.0 remains supported for read-only clients. Omitting `version` selects 1.0 for backward compatibility; new clients must send `1.1` explicitly.
- `id` is echoed unchanged so clients can correlate responses.
- `method` is required.
- Read-only methods use an empty `params` object. Session methods validate an explicit field allowlist.
- A request is limited to 1 MiB.

## Response

Success:

```json
{"protocol":"arforge.bridge","version":"1.1","id":"request-1","ok":true,"data":{"status":"ok"}}
```

Failure:

```json
{"protocol":"arforge.bridge","version":"1.1","id":"request-1","ok":false,"error":{"code":"METHOD_NOT_FOUND","message":"unknown method: example"}}
```

Stable client-actionable error codes include `PARSE_ERROR`, `REQUEST_TOO_LARGE`, `INVALID_REQUEST`, `INVALID_PARAMS`, `UNSUPPORTED_PROTOCOL`, `UNSUPPORTED_VERSION`, `METHOD_NOT_FOUND`, `METHOD_NOT_AVAILABLE`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`, `SESSION_BUSY`, `SESSION_LIMIT`, `OPERATION_NOT_FOUND`, `OPERATION_LIMIT`, `TASK_NOT_FOUND`, `TASK_LIMIT`, `INPUT_TOO_LARGE`, `APPROVAL_REQUIRED`, `INVALID_CURSOR`, `CURSOR_EXPIRED`, `SETTING_NOT_ALLOWED`, `SENSITIVE_SETTING`, `INVALID_SETTING_VALUE`, `REVISION_CONFLICT`, `SETTINGS_BUSY`, `SETTINGS_CORRUPT`, `INVALID_FEEDBACK_CATEGORY`, `INVALID_FEEDBACK_RATING`, `INVALID_FEEDBACK_MESSAGE`, `RETRY_UNSAFE`, `RETRY_PAYLOAD_UNAVAILABLE`, `MODEL_ERROR`, and `BACKEND_ERROR`. A malformed request does not stop the bridge; it continues reading the next line.

## Read-only methods

| Method | Structured result |
| --- | --- |
| `protocol.describe` | Protocol version, transport and advertised methods |
| `health` | Canonical product version and Python runtime support |
| `status.get` | Memory, token and implementation status from the backend |
| `tools.list` | Registered tool schemas and risk levels |
| `agents.list` | Registered multi-agent roles and capabilities |
| `capabilities.list` | Capability registry entries and enabled state |
| `config.get` | Active profile and non-secret configuration state |
| `workspace.get` | Canonical process workspace used for path-confined actions |
| `release.gates` | Current ordered Stage 5 release gates and fail-closed verdict |
| `release.remediation_plan` | Current ordered Stage 5 release remediation checklist; read-only and does not write evidence |
| `multimodal.diagnose` | Local screenshot/document diagnostic chain; extracts text, error signals, code matches and repair suggestions inside the workspace |

Desktop hosts should set `ARFORGE_WORKSPACE` before starting the Bridge and use that directory as the child process working directory. `workspace.get` lets the client display the exact canonical root before it submits any relative diff path. If the configured path does not exist or is not a directory, the host must fail before accepting requests.

`multimodal.diagnose` accepts `filename`, optional `extracted_text` and optional `limit`. `filename` must be a relative path inside the Bridge workspace; absolute paths and traversal outside the workspace are rejected. The method is read-only: it may inspect the source file, extract text, search code and return structured suggestions, but it never edits files or writes release evidence.

## Session methods (1.1)

| Method | Parameters | Result |
| --- | --- | --- |
| `project.list` | none | Lists locally known workspaces with retained conversation counts |
| `session.create` | none | Creates an isolated in-process Agent session |
| `session.get` | `session_id` | Returns current session state |
| `session.list` | optional `limit`, `project_id`, `tags`, `status`, `query`, `archive` | Lists retained sessions; `archive` is `exclude` (default), `only`, or `all` |
| `session.messages` | `session_id`, optional `limit` | Returns the bounded, redacted local conversation transcript |
| `session.export` | `session_id`, optional `format` | Exports user-visible messages as Markdown or versioned JSON without internal reasoning/tool channels |
| `session.import` | `content` | Imports one complete versioned JSON export under a new session identity in the active project |
| `session.context.import` | `session_id` plus exactly one of `content` or `source_session_id`; optional `source` label | Appends a bounded, redacted file or visible prior-session transcript to the active conversation as untrusted reference context without invoking the model |
| `session.compact` | `session_id`, optional `focus` | Immediately compacts an idle live context through the canonical layered compressor while preserving the durable visible transcript |
| `session.archive` | `session_ids`, `archived` | Atomically archives or restores 1–100 idle sessions |
| `session.resume` | `session_id` | Rebuilds an interrupted Agent conversation from retained messages |
| `session.close` | `session_id` | Closes an idle session; busy sessions fail closed |
| `history.search` | `query`, optional `limit` | Searches project names, session titles and retained messages |
| `chat.start` | `session_id`, `input`, optional `timeout_ms` | Accepts a background operation before any event is emitted |
| `chat.cancel` | `operation_id` | Requests cooperative cancellation and is idempotent after completion |
| `operation.get` | `operation_id` | Returns accepted/running/terminal operation state |

Only one chat operation may run per session. The initial default timeout is 120 seconds and may be changed through the non-sensitive `chat_timeout_ms` setting; accepted values are 1–300 seconds. Input is limited to 100,000 characters. The process defaults to 32 active sessions and 8 concurrent operations, and prunes terminal history instead of retaining it without bound.

Session JSON import remains subject to the 1 MiB Bridge request limit, 500 visible
messages and the normal per-message/content bounds. The desktop picker caps files
at 400 KiB so JSON escaping and envelope fields cannot cross that wire limit.
Truncated exports, unknown schema versions, extra fields and malformed roles are
rejected before storage. Imported sessions use a new identifier, retain only
visible user/assistant text and tags, start as `interrupted`, and omit artifacts,
delivery metadata, internal reasoning and raw tool events. Archived sessions
remain durable but cannot be resumed until restored; an active operation makes
the entire bulk archive request fail closed.

Context import is separate from portable session import. It targets an idle,
active session and creates one durable, visible user message that participates
in the normal model-specific context accounting and compaction flow. File
content is limited to 90,000 characters; the native desktop reader accepts only
bounded UTF-8 text/configuration/source files. Prior-session import excludes
reasoning, tool events, artifacts and delivery metadata. Both paths redact
credential-shaped values, include a content digest, and explicitly frame the
material as untrusted reference data rather than instructions.

## Workflow graph methods (1.2)

| Method | Parameters | Purpose |
| --- | --- | --- |
| `workflows.list` | none | Discover and validate project graph definitions |
| `workflows.preview` | `path` | Return a non-executing node/edge preview |
| `workflow.graph.list` | optional `session_id`, `limit` | List durable graph runs |
| `workflow.graph.get` | `run_id` | Read graph progress and node state |
| `workflow.graph.events` | `run_id`, optional `after`, `limit` | Page ordered audit events |
| `workflow.graph.start` | `path`, optional `session_id`, `permission_mode`, `max_parallel` | Start a persisted background graph |
| `workflow.graph.pause` / `resume` / `cancel` | `run_id` | Control graph lifecycle |
| `workflow.graph.approve` | `run_id`, `node_id`, `approved`, optional `comment` | Decide an approval node |
| `workflow.graph.retry` | `run_id`, `node_id`, optional `include_descendants` | Retry from a failed node |

Graph definitions are bounded, data-only JSON. Conditions compare allowlisted
terminal statuses and never evaluate expressions. Independent read nodes may
run in parallel and are forced through Plan mode. Workspace-writing nodes use
an exclusive lane. The original Agent Loop executes each agent node with the
configured model and unchanged reasoning controls.

Run, node, and bounded event state is journaled under
`ARFORGE_HOME/workflows/graph-runs.sqlite3`. In-flight nodes return to `pending`
after a process restart and the run becomes `interrupted` until explicit
resume. Approval, retry, pause, resume, cancellation, and restart transitions
are recorded as audit events.

## Event contract (1.1)

After a successful `chat.start` response, the bridge may emit unsolicited event lines:

```json
{"protocol":"arforge.bridge","version":"1.1","event":true,"session_id":"...","operation_id":"...","sequence":1,"timestamp":"2026-06-21T00:00:00Z","type":"operation.started","data":{"kind":"chat"}}
```

`sequence` starts at 1 for every operation and increases without gaps. Terminal event types are `operation.completed`, `operation.failed`, `operation.cancelled`, and `operation.timed_out`. Answer chunks use `answer.delta`; routing uses `chat.route`. The acknowledgement is always written before the first event.

Cancellation and timeout are cooperative: they are observed between backend stream events. Provider-level HTTP timeouts remain the final guard for a provider call that never yields. Output uses blocking writes rather than an unbounded event queue, so a slow client applies transport backpressure instead of causing unbounded memory growth.

## Approval, tool and diff methods (1.1)

All action records belong to one live session. A record cannot be read, approved or executed from another session. The backend creates approvals; clients cannot submit a self-declared authorization token.

| Method | Purpose |
| --- | --- |
| `tool.prepare` | Validate a registered tool and its argument schema, then create a one-time approval |
| `tool.get` / `tool.reject` | Inspect or reject a prepared tool without executing it |
| `tool.execute` | Consume the matching approval and execute exactly the prepared tool arguments |
| `tool.execute_async` | Consume the matching approval in a background task after returning `accepted` |
| `diff.preview` | Generate a backend-owned diff and content hashes without writing |
| `diff.get` / `diff.reject` | Inspect or reject a preview without writing |
| `diff.apply` | Consume the matching approval, recheck the source hash, validate Python syntax and atomically write |
| `diff.rollback` | Consume a separate rollback approval and restore/delete only if the applied content hash still matches |
| `approval.get` / `approval.respond` | Inspect, approve or reject a pending one-time approval |
| `action.list` | List live and recovered diff/tool metadata for one session |

Only relative paths inside the Bridge working directory are accepted. Absolute paths, traversal outside the workspace, `.git`, `.venv`, binary files and files/content over 1 MiB are rejected. Preview approvals expire after five minutes by default and never authorize a different action, record or session. Critical-risk tools cannot be approved through this protocol.

`diff.apply`, `diff.rollback`, `tool.execute` and `tool.execute_async` are the explicit workspace-mutating methods advertised by `protocol.describe`. A session with unresolved previews, prepared tools, pending approvals or active tasks cannot close. Action responses are written before their generated audit events.

## Background task methods (1.1)

| Method | Purpose |
| --- | --- |
| `task.get` | Inspect one task owned by the session |
| `task.list` | List up to 1–200 recent tasks for the session |
| `task.cancel` | Request cancellation; idempotently returns terminal tasks |
| `task.retry` | For a failed/cancelled in-process task, prepare the same tool arguments behind a fresh approval |

`tool.execute_async` acknowledges an `accepted` task before `task.started` can be emitted. Task events carry `task_id` and a per-task sequence. Before execution begins, cancellation prevents the tool from running. Once a tool has started, cancellation is cooperative because arbitrary Python tools do not expose a universal kill primitive; the terminal task reports `side_effects_possible: true` and the client must not claim the operation was rolled back.

Task metadata is journaled under `ARFORGE_HOME/state/bridge_tasks.db`. Tool arguments, tool output and diff content are deliberately not copied into this journal. On startup, previously accepted/running tasks become `interrupted`; tasks that may have started report possible side effects. Their payload cannot be retried after restart—clients must prepare the tool again and obtain a new approval. In-process retry also creates a new action and one-time approval; a consumed approval is never reused.

Task history is bounded. Before accepting new work, the runtime removes the oldest terminal records over its configured history limit from both memory and SQLite; active records are never pruned. Clients should treat `task.list.total` as the currently retained session history, not as a lifetime execution counter.

## Restart recovery contract (1.1)

Project, session, redacted conversation, approval and action state is journaled under `ARFORGE_HOME/state/bridge_state.db`. Conversation text is bounded to the newest 500 messages per session and is included in user export/deletion workflows. Tool arguments/results, diff text, original file content and replacement content are never copied into the restart journal.

At process startup:

- active sessions become `interrupted`; sessions with retained messages report `context_available: true` and may be explicitly resumed;
- pending or approved approvals become `invalidated` and cannot be answered or consumed;
- previewed/prepared/running actions become `invalidated`;
- applied diffs become `applied_unrecoverable`, because the original content needed for a safe automatic rollback was deliberately not copied into the journal;
- closed sessions and terminal action metadata remain discoverable.

`project.list`, `session.list`, `session.messages`, `history.search` and `action.list` let clients render retained history honestly. `session.resume` reconstructs the model conversation from complete retained user/assistant messages before accepting new input. Recovered approvals and actions still return `payload_available: false`; clients must disable approve, execute, apply and rollback controls for those records.

## Logs and settings (1.1)

| Method | Purpose |
| --- | --- |
| `logs.query` | Return newest-first, redacted JSON log records with an opaque backward cursor |
| `settings.get` | Return non-sensitive values, revision and UI-renderable field schema |
| `settings.update` | Atomically apply allowlisted changes when `expected_revision` still matches |
| `feedback.summary` | Return local feedback count, average rating and category totals |
| `feedback.list` | Return a bounded newest-first local feedback page |
| `feedback.submit` | Redact and persist explicit feedback in the isolated local profile |
| `feedback.delete` | Explicitly remove one local feedback record by identifier |

`logs.query` accepts `limit` (1–200), optional `cursor`, and optional `levels` selected from DEBUG/INFO/WARNING/ERROR/CRITICAL. It always reads the fixed `ARFORGE_HOME/logs/arforge.log`; requests cannot supply a path. A query scans at most 4 MiB, skips malformed/oversized records, re-applies credential redaction, truncates messages/contexts, and keeps the serialized page below the Bridge request-size budget. A cursor that is malformed or points beyond a truncated/rotated file fails explicitly.

`settings.update` only accepts `language` (`zh`/`en`), `theme` (`system`/`light`/`dark`), `log_retention_days` (0–365), and `chat_timeout_ms` (1,000–300,000). API keys, tokens, database/base URLs, credentials and auto-approval cannot be written through the Bridge. Updates use an optimistic revision, a cross-process lock and same-directory atomic replacement. Corrupt settings fail closed and are not silently overwritten. Language is shared with the CLI, log retention controls the default `logs-prune` policy, and chat timeout controls Bridge calls that omit `timeout_ms`.

`feedback.submit` accepts an allowlisted category (`bug`, `feature`, `experience`, or `other`), an integer rating from 1 to 5, a non-empty message up to 2,000 characters, and an optional session identifier. The message is sanitized before storage. Records are written only to `ARFORGE_HOME/state/feedback.db`; the Bridge does not upload them. Ratings 1–2 and 4–5 are best-effort inputs to the formal local learning engine, while neutral rating 3 is retained without creating a positive or negative learning outcome. Learning failure never rolls back a successfully persisted feedback record.

## Plugin package lifecycle (1.2)

| Method | Purpose |
| --- | --- |
| `plugins.list` | Discover validated profile and project manifests without importing code |
| `plugins.install.inspect` | Stage and inspect a directory, ZIP, HTTPS ZIP or HTTPS Git source |
| `plugins.install.apply` | Atomically install or update one inspected candidate in a disabled state |
| `plugins.set_enabled` | Explicitly allow or prevent a validated plugin from loading in a future service |
| `plugins.remove` | Disable and move a profile-managed plugin to recoverable storage |
| `plugins.restore` | Restore a recovery entry in a disabled state |

Inspection returns an expiring random token, candidate name/version/SHA-256 data,
and a selection requirement for multi-plugin packages. Apply accepts that token,
the selected name, and an explicit `replace` boolean. Package inspection and
installation never import the entrypoint. Remote and archive bounds, traversal
checks, transaction locking and recovery details are documented in
[Plugin Management](PLUGIN_MANAGEMENT.md).

The Tauri host owns workspace switching. It validates and canonicalizes a selected project root, stops the old child Bridge, and starts a new Bridge with that directory as its working directory before the UI resumes the selected conversation.

## Run reports and portable traces (1.2)

| Method | Purpose |
| --- | --- |
| `run.list` | List bounded summaries of persisted run artifacts |
| `run.report` | Read one structured report including its bounded, redacted trace timeline |
| `run.trace.export` | Export a trace as versioned `arforge.run.trace` JSON |
| `run.trace.import` | Strictly validate and persist a portable trace under a new isolated identity |
| `run.revert` | Revert a local run transaction when that run owns a transaction snapshot |

Portable import never executes commands, restores messages, creates a
transaction, or makes an imported run revertible. The core portable limit is
5 MiB and 5,000 events; the desktop native reader uses a smaller 400 KiB bound
to stay below the Bridge's 1 MiB request/response framing limit. Report
timelines are separately capped so opening diagnostics cannot allocate an
unbounded browser or desktop view.

## Security requirements

- Never pass credentials in bridge requests.
- Never log or display a raw database URL or API key.
- Treat `BACKEND_ERROR.message` as user-readable diagnostic text, not executable content.
- Use `protocol.describe` during startup and disable UI features whose methods are not advertised.
- Do not fall back to parsing CLI text when a method is absent.
- Keep stdin open while operations run. Closing stdin requests runtime shutdown and cooperative cancellation.
- Render approval arguments and diffs as untrusted content. Never interpret them as UI markup or commands.
- Render log messages and context as untrusted text even though the backend has redacted and bounded them.
- Fetch `settings.get` immediately before an update and handle `REVISION_CONFLICT` by reloading rather than overwriting.
## Structured questions

Protocol 1.2 exposes `question.get`, `question.respond`, and `question.reject` for
questions raised by the agent during an active chat operation. A
`question.requested` event carries `question_id`, `session_id`, `operation_id`, one
to four validated questions, and optional redacted metadata. Each question contains
two to four options, supports single or multiple selection, and clients must provide
a custom-answer choice without adding it to the request payload.

The chat operation remains active while its execution thread waits. A response is
accepted only for the matching session and pending question, is validated before the
waiting tool resumes, and cannot be submitted twice. `question.answered` or
`question.rejected` settles the client UI; cancellation and operation timeout also
release the waiter. Question state is intentionally ephemeral and is invalidated with
the operation on process restart. Responding or rejecting mutates local operation
state only and is never a workspace mutation.

## Trigger profiles and lifecycle (1.2)

| Method | Purpose |
| --- | --- |
| `trigger.profiles` | List safe metadata for host-configured local or HTTP trigger profiles |
| `trigger.list` | List triggers through the selected profile |
| `trigger.get` | Read one trigger by its bounded identifier |
| `trigger.create` | Create a local schedule or submit a body to the configured remote endpoint |
| `trigger.update` | Partially update one local or remote trigger |
| `trigger.run` | Run a remote trigger or start the local trigger prompt as a normal chat operation |

Every method requires a valid `session_id`; `profile` defaults to the reserved
`local` profile. HTTP profiles are configured outside the Bridge and expose no
credential values. Remote routes are fixed by the backend, require host-managed
Bearer or OAuth authentication, reject redirects and unsafe URLs, and bound
request/response JSON and timeout. Bridge parameters cannot supply a URL, token,
authorization header, environment-variable name, or profile definition.

`trigger.run` on the local profile fails with `SESSION_BUSY` when another
operation owns the session. On success it returns the accepted operation and
the prompt continues through normal routing, permissions, sandboxing, tool
events, cancellation, persistence, and user-message delivery.

## Cooperative wait lifecycle (1.2)

| Method | Purpose |
| --- | --- |
| `wait.active` | Return the current bounded wait for a session, or `active=false` |
| `wait.wake` | Request wake-up for the current wait, optionally matching its backend-issued `wait_id` |

Agent waits emit `wait.started`, periodic `wait.check_in`, and one of
`wait.completed`, `wait.woken`, `wait.cancelled`, or `wait.timed_out` on the
same operation event stream and sequence. The wait never starts a shell
process. `chat.cancel` interrupts it through the operation cancellation event,
and the operation deadline remains authoritative even when the requested wait
duration is longer.

Only the session that owns the operation can inspect or wake its wait. A stale
or mismatched `wait_id` is rejected, and a session can have at most one active
wait. `wait.wake` mutates ephemeral operation state but does not modify the
workspace or persist a false active wait across restart.
