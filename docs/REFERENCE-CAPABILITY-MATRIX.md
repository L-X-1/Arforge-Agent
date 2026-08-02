# Reference Capability Matrix

This document is the evidence-backed inventory used to integrate capabilities
from the reference repository into Arforge. It compares behavior, not names or
file layout. Existing Arforge functions remain authoritative and are extended
rather than replaced.

Status meanings:

- **Integrated**: equivalent or broader behavior exists and has focused tests.
- **Partial**: useful foundations exist, but one user-visible contract remains.
- **Gap**: no equivalent production contract exists yet.
- **Reference stub**: the inspected reference exports an empty/disabled
  placeholder; no false parity work is required.
- **Provider-specific**: the reference depends on a private hosted endpoint;
  Arforge requires a provider-neutral replacement.

## Source Document Coverage

This table maps the twenty functional sections in the supplied architecture
report to Arforge's production contracts. Equivalent behavior is required;
copying the reference repository's product-specific names, private endpoints,
or UI implementation details is not.

| Report area | Arforge production mapping | Status |
|---|---|---:|
| Entry and startup paths | Fast `--version`/`--help`, command router, interactive/headless/desktop/server/daemon entry points | Integrated |
| Async query loop and recovery | Streaming tool loop, max-step budgets, cancellation, retries, self-correction, resume and run reports | Integrated |
| Multi-provider API abstraction | Provider-neutral adapter factory, streaming normalization, encrypted credentials, model configuration and fallback | Integrated |
| Tool contract and registry | Typed schemas, risk/category metadata, deferred discovery, aliases, validation, permission checks and result limits | Integrated |
| Concurrent and serial tool execution | Read-only/concurrency-safe batching with write serialization, cancellation and operation deadlines | Integrated |
| Shell and background commands | No-shell subprocess execution, PowerShell support, sandbox policy, output truncation, background output/stop lifecycle | Integrated |
| Subagents and coordination | Regular/forked workers, role allowlists, teams, mailboxes, coordinator routing and asynchronous task state | Integrated |
| State management | Durable state store, session-scoped runtime state, Bridge event model and React hooks | Integrated |
| Terminal and desktop UI | Prompt-toolkit CLI plus React/Tauri desktop, virtualized histories, approval/question/task/diff/settings surfaces | Equivalent |
| MCP transports and lifecycle | stdio, streamable HTTP, SSE bootstrap and generic WS/WSS; auth, resources, reconnect and dynamic tool refresh | Integrated |
| Permission modes and classifier | Request approval, auto approval, full access and plan/read-only mappings; remembered rules, sandbox and risk classifier | Integrated |
| Bridge and remote control | Authenticated local machine Bridge, sessions, events, approvals, tasks, attachments and durable resume | Integrated |
| Computer and browser control | Permission-gated browser/computer tool families with platform dispatch and attachment evidence | Integrated |
| Voice input | Desktop speech-input hook, composer integration, cancellation and unsupported-platform fallback | Integrated |
| Feature flags | Local defaults, environment overrides and signed remote refresh with audited rollout state | Integrated |
| Build and code quality | Python/Node/Rust checks, desktop build, bundle budget and CI quality gates | Integrated; publishing excluded |
| Daemon and background sessions | Cooperative daemon lifecycle, bounded waits, scheduled prompts, background commands and graceful stop | Integrated |
| Context compression | Tool-result budgeting, micro-compaction, automatic/reactive compaction, summaries and cross-session memory | Integrated |
| Skills and customization | Bundled/project/user skill discovery, validation, disablement, workflow execution, commands and profiles | Integrated |
| Monitoring, login, memory and tests | Tracing/metrics/stats/replay, provider auth, proactive assistant behavior, learning/dreaming and full regression suites | Integrated |

The decorative companion/pet presentation described by the report is not
copied into the enterprise product. Its useful behavior is represented by the
provider-neutral proactive message, schedule, memory and notification
contracts. Private provider beta headers and private platform proxy transports
are similarly represented by neutral capability contracts instead of copied
identifiers or endpoints.

## Agent Tool Surface

| Capability | Arforge mapping | Status | Remaining work |
|---|---|---:|---|
| Subagent execution and role restriction | `spawn_subagent`, `spawn_write_subagent`, worker roles, fork subagent | Integrated | Preserve role/tool allowlists in all new team paths |
| Structured user questions | `ask_user`, Bridge question lifecycle, Desktop question card | Integrated | None |
| Shell and PowerShell execution | `run_cmd`, no-shell pipelines, runtime sandbox, permission matrix | Integrated | None |
| Background command/output/stop | background command runtime, four task tools, and cooperative wait/wake events | Integrated | None |
| File read/write/edit | authorized roots, state hashes, backup, atomic edit/write | Integrated | None |
| Glob/grep/code search | file listing, code index, TF-IDF, multi-language symbol index | Integrated | None |
| Plan enter/update/exit/verify | Plan Mode, structured plan, quality and verification tools | Integrated | None |
| Managed worktree enter/exit | session-owned managed worktree runtime | Integrated | None |
| Language service | stdio LSP plus index fallback | Integrated | Validate more installed language servers in external environments |
| Notebook editing | structured notebook read/edit with stale hash | Integrated | None |
| Task create/get/list/update/stop | persistent task graph plus Bridge task runtime | Integrated | None |
| Skills discovery/read/run | bundled/project/user skills and workflow runtime | Integrated | None |
| Web search/fetch/browser | web, browser, and computer tool families | Integrated | None |
| Scheduled prompts | one-shot/recurring, session/durable, missed confirmation, Desktop lifecycle controls | Integrated | None |
| Tool schema search and deferred activation | run-scoped `tool_search`, ranked/exact selection, next-step schema refresh | Integrated | None |
| Team create/delete and mailbox messaging | session-owned durable team metadata, bounded role members, scoped mailboxes, graceful shutdown handshake | Integrated | None |
| Sleep/wake/check-in | bounded cooperative wait, external wake, periodic Bridge check-ins, cancellation and operation deadline | Integrated | None |
| Primary visible message with attachments | normal/proactive primary delivery, authorized local attachments, Bridge events, durable resume/fork, Desktop cards and host open actions | Integrated | None |
| MCP resource listing/reading | bounded stdio and HTTP/SSE clients plus deferred resource list/read tools | Integrated | None |
| MCP authentication pseudo-tool | host-controlled environment bearer and OAuth client-credentials providers; secrets remain unavailable to the model | Integrated | None |
| Remote trigger management | provider-neutral local/HTTPS profiles, host-owned bearer or OAuth auth, list/get/create/update/run, Bridge and deferred tools | Integrated | None |
| REPL virtual primitive tool | inspected export is disabled; Arforge CLI directly exposes real tools | Reference stub | None |
| Artifact review tool | inspected export is empty | Reference stub | None |
| Background change-request suggestion | inspected export is disabled | Reference stub | None |
| Terminal capture tool | inspected export is empty | Reference stub | None |
| Monitor tool | inspected export is empty | Reference stub | None |
| User-file send tool | inspected export is empty; Arforge provides a real provider-neutral local attachment delivery tool | Integrated | None |

## Runtime And Product Surface

| Capability group | Arforge status | Evidence / gap |
|---|---:|---|
| Context compaction and summaries | Integrated | compaction hook, context budget, explicit compact tool |
| Session resume/fork/rename/export | Integrated | Bridge state store and Desktop session UI |
| Session tags/filtering | Integrated | normalized tags and filtered `session.list` |
| Session checkpoint/rewind | Integrated | preview token, stale rejection, visible-context rebuild |
| Output styles | Integrated | user/project output style runtime and CLI |
| Hooks and custom commands | Integrated | controlled hook manifests and customization runtime |
| Plugins | Integrated | discovery, enable/disable, explicit load |
| Keybindings | Integrated | revisioned runtime and Desktop settings |
| Permissions and sandbox modes | Integrated | remembered rules, runtime sandbox, network policy |
| Multi-provider model configuration | Integrated | encrypted local credentials and provider adapters |
| Memory and learning | Integrated | scoped memory, semantic recall, learning hooks and undo |
| Cost, stats, tracing and replay | Integrated | runtime metrics, run reports, replay and revert |
| Voice input | Integrated | Desktop voice input hook |
| SSH workspace operations | Integrated | strict host verification and no-shell execution |
| Local server/daemon | Integrated | HTTP/SSE MCP service and controlled daemon |
| Remote feature/update checks | Integrated | signed explicit refresh and check-only updates |
| Modal keyboard interaction | Integrated | Default-off `desktop_modal_keyboard` flag; insert/navigation state machine scoped to the Desktop chat composer |
| Proactive assistant mode | Integrated | scheduling/daemon plus explicit proactive delivery classification, durable metadata and Desktop status |
| Desktop schedule/tag/rewind UI | Integrated | Session tag filter/editor, schedule lifecycle, checkpoint list/create, rewind preview/apply |

## Remaining Integration Backlog

| # | Priority | Deliverable | Acceptance |
|---|---:|---|---|
| T60 | P1 | Deferred tool discovery and schema activation (completed 2026-07-16) | Core tools stay immediately available; deferred local/MCP tools are searchable by exact selection and ranked keywords; selected schemas become callable on the next loop step; feature can be disabled without changing the legacy full-tool path |
| T61 | P1 | Session-owned team lifecycle and mailbox (completed 2026-07-16) | Create one team per lead session, add/remove bounded members, direct/broadcast messages, graceful shutdown request/response, durable metadata, no cross-team access, no orphan cleanup |
| T62 | P1 | Production MCP client transport/resource/auth layer (completed 2026-07-16) | Bounded stdio and HTTP/SSE clients, list/read resources, reconnect, credential-safe OAuth or token flow, dynamic tool refresh, timeouts and cancellation |
| T63 | P1 | Proactive user message and attachment delivery (completed 2026-07-16) | Normal/proactive message classification, authorized attachments, Bridge event, Desktop rendering, no hidden upload, size/type limits |
| T64 | P2 | Provider-neutral trigger API (completed 2026-07-16) | Local/remote trigger profiles over explicit authenticated endpoints, list/get/create/update/run, network approval, no token in shell/logs |
| T65 | P2 | Cooperative sleep/wake and monitor (completed 2026-07-16) | Interruptible bounded wait, periodic check-in event, no shell process, cancellation and timeout tests |
| T66 | P1 | Desktop controls for schedule, tags and rewind (completed 2026-07-16) | Session tag editor/filter, schedule list/create/cancel/missed confirmation, checkpoint create/list, rewind preview warning and explicit apply |
| T67 | P3 | Optional modal keyboard interaction (completed 2026-07-16) | Default-off feature flag; insert/navigation state machine; cursor, line, word, find, operator, register and paste commands; clickable mode exit; IME/modifier passthrough; no handling on other text inputs |

## Modal Keyboard Contract

- The capability is disabled by default and is activated only through the
  audited `desktop_modal_keyboard` feature flag.
- The state machine belongs to the existing chat composer. It does not replace
  session state, keybindings, voice input, submission, or any backend runtime.
- Insert mode preserves normal textarea and IME behavior. `Escape` enters
  navigation mode and moves the cursor according to modal editor semantics.
- Navigation mode supports counted line/word movement, vertical movement,
  find/repeat, insert transitions, line/range operators, register paste,
  replace, case toggle, join, and open-line editing.
- Modifier shortcuts, composition events, tabs, and non-chat inputs are not
  intercepted. A visible mode button provides a mouse and assistive-technology
  path back to insert mode.
- Voice input is unavailable only while navigation mode is active, preventing
  hidden text insertion into a read-only editing state.
- Desktop verification covers standard mode, enabled mode, cursor transitions,
  title-input isolation, 1440px and 720px layouts, production build, and bundle
  budget.

## Completion Rule

The integration is not considered complete while any P1 row above remains a
Gap or Partial. Provider-specific behavior is complete only after a neutral
Arforge contract exists; copying a private endpoint or brand-specific
authentication flow does not satisfy this project.

## Final Regression Evidence

- Backend unified isolated-environment baseline:
  `2398 passed, 1 skipped` with no test warnings.
- Desktop: 9 test files and 58 tests passed; TypeScript checking and Vite
  production build passed.
- Desktop JavaScript gzip size: `148.64 KiB / 200 KiB`.
- Rust desktop host: `cargo check` passed.
- Python maintained source and tests: Ruff passed.
- Python dependency integrity and vulnerability audit passed in the project
  virtual environment; root and desktop production npm audits report zero
  known vulnerabilities.
- Compatibility closure covers legacy subagent extensions, team-scoped tool
  allowlists, eval runner interfaces, runtime metrics, session artifact export,
  custom profile trust, CLI JSON routing, workspace errors, and role-cache
  invalidation.
- CLI evaluation now fails closed before execution when the workspace is not
  trusted, and Windows evaluation subprocesses decode output explicitly as
  UTF-8.
- Maintained source, tests, scripts, and documentation contain no prohibited
  reference-product name.
