# Capability Fusion Matrix

This document tracks clean-room behavioral integration from the two local
reference implementations. It intentionally records product behavior and
verification evidence, not upstream source identifiers or copied code.

Status meanings:

- **Preserved**: existing Arforge behavior remains the implementation.
- **Integrated**: behavior was added through Arforge-owned modules.
- **Partial**: a usable path exists, but a reference interaction is still absent.
- **Pending**: not yet implemented.

## Executable boundary audit (2026-07-27)

The legacy Python Bridge advertises **191 unique methods** in protocol 1.2:

| Bridge family | Methods | Unified product ownership | Current conclusion |
|---|---:|---|---|
| Protocol + read-only capability engine | 46 | Python implementation behind `AgentPython.Service` | All 46 are now admitted by the shared Core read-only allowlist |
| Session / chat / schedule / team / trigger / wait | 55 | TypeScript session services and PostgreSQL | Native verticals exist; exact method-by-method behavioral parity remains an acceptance task |
| Goal lifecycle | 10 | TypeScript goal service and PostgreSQL | Native lifecycle exists across HTTP and Desktop |
| Approval / diff / file-write / tool action | 18 | TypeScript permission, filesystem, command and revert services | Native ownership is intentional; Python mutations are not dual-written |
| Task lifecycle | 4 | TypeScript task graph and background task services | Native lifecycle exists; retry/cancel parity remains part of regression evidence |
| Product settings / memory / learning / extensions | 54 | Split across TypeScript services | Most product verticals exist; this is the largest remaining parity-audit family |
| Git checkout / worktree | 4 | TypeScript Git and worktree services | Native ownership is intentional; destructive operations remain confirmation-gated |

This distinction matters: a capability appearing in a list is not evidence that
CLI, HTTP and Desktop can execute it. The current read-only boundary is now
exactly aligned with the Python implementation, but only curated capabilities
receive public typed routes and product UI after their response, security and
error contracts are reviewed.

The complete Core-admitted read-only surface is:

```text
protocol.describe
agents.list, capabilities.list, config.get, cost.optimization
customizations.list, customizations.render, features.list, file_state.list
git.diff, git.status, health, learning.status
memory.facets, memory.governance.preview, memory.recall_quality
memory.search, memory.semantic_search, memory.status
multimodal.diagnose, permissions.mode.get, permissions.rules
plan.preview, quality.assess, release.gates, release.remediation_plan
repo.scale, run.list, run.report, run.trace.export
runtime.metrics, runtime.stats, sandbox.status, self_correct.eval
skills.list, skills.read, skills.route, status.get, subagents.roles
tools.list, workflow.graph.events, workflow.graph.get, workflow.graph.list
workflows.list, workflows.preview, workspace.get
```

### Curated end-to-end read-only slices

| Capability | Core | CLI | HTTP / SDK | Desktop | Verification |
|---|---|---|---|---|---|
| Engine health and capability catalog | `health`, `capabilities.list` | `arforge capabilities` | Typed health/list routes in both generated clients | Engine metrics and capability badges | Real Python client + HTTP integration tests |
| Delivery quality assessment | `quality.assess` | `arforge quality [files..]` with JSON and patch support | Typed `POST /api/agent-capabilities/quality` | File/diff input, score, checked-file, issue and diff display | Python confinement test, Core parity test, HTTP test and CLI smoke |
| Repository scale and bounded search | `repo.scale` | `arforge repo-scale [query]` with path, budget, result-limit and JSON support | Typed `POST /api/agent-capabilities/repository-scale` in both generated clients | Workspace-relative path/search controls, scan metrics, suffix distribution, matches and recommendations | Python confinement tests, HTTP escape rejection, 9/9 read-only CLI smoke, generated Desktop-client request test and a real 3,842-file scan |
| Multimodal local diagnosis | Native typed Core service backed by preserved behavior | Existing command/tool paths | Typed diagnostics route | Screenshot/document diagnostics panel | Existing Core, HTTP and Desktop tests |

The quality and repository-scale slices are the reference design for the
remaining analytics:

1. keep the Python implementation read-only and workspace-confined;
2. decode its result at the Core/Server boundary instead of passing unknown
   JSON through the product;
3. generate both promise clients from the same HTTP contract;
4. expose the same operation in CLI and Desktop;
5. prove it with a real Python process, HTTP integration and CLI smoke test.

`run.list`/`run.report` is now a completed curated slice: the Python transaction
journal is the single report owner, while CLI, typed HTTP/SDK and Desktop read
the same bounded result. The next read-only candidate is `plan.preview`. A generic arbitrary-method HTTP
proxy is deliberately rejected for now: “read-only” does not by itself prove
that every method is safe to expose to a remote authenticated client.

### 2026-07-27 operations unification

| Vertical | Single state owner | CLI | Desktop | Verification |
|---|---|---|---|---|
| Run history and reports | Python run transaction journal | `arforge run-history [run-id]` | Persistent run list and bounded report | Schema decode, HTTP, CLI help and real-bridge tests |
| Goal lifecycle | TypeScript Goal service + shared database | `arforge goal …` | Create, queue, run, pause, resume, block, replace, reorder and terminal actions | 12 public HTTP lifecycle scenarios, including durable run admission |
| Task graph | TypeScript Task Graph service + shared database | `arforge task …` | Dependencies, claim/release and terminal actions | 10 public HTTP lifecycle scenarios with revision checks |
| Prompt Queue | Canonical durable `SessionInput` FIFO | `arforge prompt-queue …` | Authoritative server queue with edit/remove/drain and legacy migration | 27 Core tests, mature-loop drain test and 3 public HTTP FIFO scenarios |
| Workflow graphs | Validated Python graph journal above the canonical Agent Loop | `arforge workflow …` | Preview, start, progress, approval, retry and controls | Bridge graph tests plus typed API integration |
| Managed skills | Python manifest/state store; mature runtime registry remains visible | `arforge skill …` | Managed enable/disable/rescan plus effective runtime skills | Real Bridge mutation boundary and typed API integration |
| Managed plugins | Python transactional local plugin store; npm runtime installer remains compatible | `arforge plugin-manager …` and existing `arforge plugin` | Discovery, enable/disable, inspect/apply, recoverable remove/restore | Two-phase install/remove/restore API integration |

The Python management boundary is intentionally separate from the read-only
capability boundary. Exactly 15 reviewed methods are admitted: three Skill
operations, six Plugin operations (including read-only discovery), and six
Workflow controls. Session creation, file writes, arbitrary tool actions and
all other Bridge mutations remain rejected by the TypeScript client.

The boundary is now enforced in both processes. `packages/agent-python` sets
`ARFORGE_BRIDGE_MODE=capability`; Python publishes only the admitted methods,
returns `METHOD_NOT_ALLOWED` for legacy product operations, and does not
construct the old Session, Goal, Task, Prompt Queue, Feedback, or Sidecar-lock
stores. The independent Python compatibility entry keeps the full Bridge until
its remaining parity evidence is complete.

Profile-scoped Skill and Plugin preferences use cross-process writer locks,
fresh disk reads, fsync, and same-directory atomic replacement. This matters
because different Core locations may own separate capability processes while
sharing one private `ARFORGE_HOME`.

### Database convergence correction

PostgreSQL is the canonical owner for shared Session, Goal, Task, Prompt Queue,
identity, and primary product state. The Python Workflow Graph scheduler now
selects PostgreSQL in server/product mode and uses renewable cross-process
leases; profile SQLite remains only for explicit local/test mode and legacy
import. Core owns the additive three-table migration, and the importer is
source-read-only, transactional, collision-rejecting and fingerprint-verified.

The private database has not yet received that migration because no
`ARFORGE_DB_ADMIN_URL` is configured. The migration is marked
`.pending-admin`, so Workflow Graph fails closed instead of falling back or
dual-writing. Full PostgreSQL convergence remains incomplete until the real
tables are created and the import report's SHA-256 verification passes.

## Conversation and execution

| Capability | Core / Bridge | CLI | Desktop | Status |
|---|---|---|---|---|
| Streaming answer and reasoning channels | Session runtime events | Streaming renderer | Structured live workstream | Preserved |
| Tool activity and generated-file cards | Persisted structured channels | Tool progress | Expandable activity and artifact actions | Preserved |
| Queue prompts while a turn is running | Durable prompt queue | Prompt queue command path | Interactive composer and removable queue | Integrated |
| Immediately steer a running turn | Run-scoped interrupt context | `/steer` path | Ctrl+S and visible steer action | Integrated |
| Cancel a running turn | Cooperative cancellation | Esc / Ctrl+C | Esc and stop action | Integrated |
| Read-only side question | Isolated snapshot operation | `/btw` | Independent floating panel | Integrated |
| External draft editor | N/A | Ctrl+G | Ctrl+G and visible composer action | Integrated |
| Structured user questions | Question runtime | Interactive prompt | Question card | Preserved |
| Per-response copy | N/A | Terminal selection | Native clipboard action | Integrated |
| Fork from a response boundary | Persisted message boundary | Session fork | Per-response fork action | Integrated |
| Accept new CLI input during token streaming | Durable FIFO queue and run-scoped steer state | Prompt remains active; ordinary input queues, `/steer` guides, `/cancel` stops | Fully interactive | Integrated |

## Context, memory, and sessions

| Capability | Core / Bridge | CLI | Desktop | Status |
|---|---|---|---|---|
| Model-specific context capacity | Provider catalog and overrides | Model configuration | Live capacity gauge and tooltip | Integrated |
| Automatic compaction | Layered summary and memory preservation | Context status | Context status and compaction evidence | Preserved |
| Manual compaction with preservation focus | Same layered compressor and protected-fact checkpoint | `/compact [focus]` | Session control action with optional preservation focus and before/after evidence | Integrated |
| Durable session history | PostgreSQL single writer | Resume and history | Sidebar history and search | Integrated |
| Rename, tag, close, export | Session runtime | Commands | Header, control center, sidebar, export | Preserved |
| Checkpoints and context rewind | Session runtime | Bridge clients | Preview and explicit confirmation | Preserved |
| Session split view | Independent sessions | Multiple terminals | Two live desktop panes | Integrated |
| Session archive / bulk management | Durable archive state and bulk mutation | Bridge/CLI-compatible contract | Current/archived views with multi-select archive and restore | Integrated |
| Portable session archive import | Versioned, bounded JSON contract | Bridge/CLI-compatible contract | Native JSON picker, validation and imported-session feedback | Integrated |
| Import file or prior conversation as current reference context | Durable visible message with redaction, size bounds and untrusted-data framing | Bridge-compatible contract | Native UTF-8 file picker and prior-session selector | Integrated |

## Planning, autonomy, and collaboration

| Capability | Core / Bridge | CLI | Desktop | Status |
|---|---|---|---|---|
| Durable autonomous goals | Goal runtime | Full goal lifecycle | Goal queue and execution | Integrated |
| Plan mode and plan updates | Agent plan tools | Mode and tool output | Composer mode and plan dock | Preserved |
| Durable Graph orchestration above Agent Loop | Core-managed PostgreSQL target with leases; explicit local/test SQLite, safe conditions, parallel read lane, exclusive writes, retry and restart recovery | Full graph lifecycle commands | Progress graph, approval, retry, pause/resume/cancel and audit events | Partial until private PostgreSQL migration/import |
| Built-in subagents | Subagent pool | Role inspection | Role inspection and task surface | Preserved |
| Data-only project agents | Validated trusted profiles | Status/list/validate | Discovery, validation, activation state | Integrated |
| Team mailbox and membership | Durable team runtime | Tool/Bridge use | Member lifecycle, mailbox and shutdown requests | Integrated |
| Cooperative waits and wake | Wait runtime | Tool/Bridge use | Live status and manual wake control | Integrated |
| Scheduled prompts | Schedule runtime | Tool/Bridge use | Full session control center | Preserved |
| Local and authenticated triggers | Trigger runtime | Tool/Bridge use | Profile selection, create/update, run and local-run adoption | Integrated |

## Extensions and customization

| Capability | Core / Bridge | CLI | Desktop | Status |
|---|---|---|---|---|
| Skills discovery, enablement, routing | Shared skill runtime | Full management and route inspection | List, preview, toggle, rescan | Integrated |
| Project commands and hooks | Data-only customization runtime | List/render | List and safe preview | Integrated |
| Local plugins | Manifest discovery and enable overrides | List/enable/disable | Discovery, validation and toggle | Integrated |
| Plugin package install/update/remove/trust | Transactional staging, validation and recoverable removal | Directory/ZIP/HTTPS/Git management | Inspect, select, install/update, remove/undo and explicit enable | Integrated |
| Output styles | Shared Markdown style runtime | List/show/set/clear | Select and preview | Integrated |
| Local JSON themes | Strict token allowlist | Filesystem configuration | Select, rescan and live application | Integrated |
| MCP clients and service | Authenticated MCP runtime | Server/daemon/plugins | Configuration and protocol visibility | Preserved |

## Development surfaces

| Capability | Core / Bridge | CLI | Desktop | Status |
|---|---|---|---|---|
| File read/write and safe shell | Approval and sandbox runtime | Coding loop | File cards, terminal, approval center | Preserved |
| Direct shell input mode | Permission-aware no-shell command/pipeline executor | Ctrl+X Agent/safe-shell toggle | Integrated terminal surface | Integrated |
| Browser preview | Browser runtime | Tools | Sandboxed preview dock and logs | Preserved |
| Git diff/review | Git and diff runtimes | Commands | Full review dock and file summary | Preserved |
| Worktrees and pull-request preparation | Git runtime | Commands | Settings and Code workspace | Preserved |
| Background tasks | Task runtime | Commands | Task center and side task dock | Preserved |
| Standard IDE agent protocol | ACP adapter | `acp` command | IDE status and shared backend | Integrated |
| IDE extensions | Protocol adapters | N/A | VS Code and JetBrains integration packages | Integrated |
| Noninteractive final-only output | Agent service | One-shot ask | N/A | Preserved |
| JSONL streaming print protocol | Normal session runtime with bounded redacted tool records | `print` / `--print`, text or JSONL stdin, text/final-only/JSONL stdout, retry-aware exit codes | Shared backend contract | Integrated |
| Web control center | Authenticated same-runtime Bridge gateway and bounded SSE replay | `web` launcher with loopback-safe token defaults | Desktop remains the richer native control center | Integrated |
| Trace visualizer and portable trace import | Bounded redacted reports plus versioned import/export | Stats/replay | Expandable timeline, native JSON import/export and transaction-aware rollback | Integrated |

## Verification gates

- Python unit and Bridge integration tests cover the new session, queue, side
  question, steering, goal, ACP, extension, theme, model-context and print-mode
  contracts.
- Desktop component tests cover the real user actions and request payloads.
- Native shell commands are compiled and covered by Rust tests for target
  validation, Bridge framing, diagnostic redaction, and failure boundaries.
- The production desktop build must remain below the configured JavaScript gzip
  budget.
- A repository scan must remain free of reference product identifiers.
- Release, publishing, signing, and distribution actions are explicitly outside
  this integration task.

## 2026-07-27 unified-runtime evidence

- The default CLI and Electron Desktop are launched from this workspace's
  pinned Bun runtime; neither launcher resolves or imports an external project.
- A real CLI → unified Core → DeepSeek request returned the exact expected
  response `Arforge模型链路正常`.
- The selected model is an explicit `provider/model` value in the private user
  configuration, eliminating the previous ambiguous/stale UI model fallback.
- PostgreSQL role isolation, schema migration, backup and restore comparison
  have completed successfully for the private database path.
- Root TypeScript type checking completed all 23 typecheck tasks across the 27
  packages in scope.
- Python full suite: `2967 passed, 7 skipped, 0 failed`.
- Mature TypeScript runtime full suite, split four ways with the package's
  official 30-second budget: `3182 passed, 65 skipped, 1 todo, 0 failed`.
- Shared Desktop/Web App: `678 passed, 0 failed` in the unit suite and
  `30 passed, 0 failed` in the browser suite.
- Native HTTPS listener, signed Session Cookie, logout revocation and
  authenticated document access passed a real self-signed TLS smoke test.
- PostgreSQL scheduled backup ran with exit code 0; an isolated restore rebuilt
  45 tables with zero exact row-count differences and removed the temporary
  database.
- The owner-approved Tier 1 cleanup removed all 16 generated-output targets and
  first-party bytecode caches, reclaiming about 11.3 GiB without touching the
  current Electron, App, Server, CLI, final private wheel or scheduled backups.
- Vue and Clojure TUI parsers now load from integrity-pinned local WASM/query
  assets. A bundled-output smoke test produced 18 and 70 highlight ranges with
  zero network requests and no former-publisher runtime URL.
- A real `repo-scale AgentPython` call indexed 3,842 code files without hitting
  its 5,000-file budget, returned five of eight ranked matches, and the second
  call classified all 3,842 files as unchanged.
- Focused unified-operations regressions completed with zero failures:
  4 Agent Python client tests, 27 Session execution/queue tests, 4 CLI/API/help
  tests, and 9 Desktop submission tests.
- The strict first-party brand audit reports `0 hits in 0 finding files`;
  `6,392` files were visited and `5,786` text files were scanned.
- The HTTP exerciser now describes all **289 unique public Effect routes** with
  **309 executable scenarios** (the additional scenarios exercise request and
  lifecycle variants on shared route keys). Coverage, authentication and real
  Effect modes each pass `309 passed, 0 failed, 0 skipped, missing=0, extra=0`
  with both strict flags enabled. The full real-router run completed in 895.4
  seconds.
- Stateful public scenarios now cover Goal, Task Graph, Prompt Queue, Session
  tags/checkpoint/rewind, Memory, Team, Scheduled Prompt, Trigger, Feedback,
  Learning, MCP, Cooperative Wait and Multimodal diagnostics through the actual
  router, middleware, location binding and persistence path.
- The route audit exposed and fixed four integration defects instead of
  normalizing them into expected failures: mature-execution instance routing,
  invalid Scheduled Prompt `run-missed` mutation, Windows PTY command selection,
  Windows temporary-path drive ambiguity for Git worktrees, and Python workflow
  domain errors being mislabeled as infrastructure outages.
- Desktop development no longer injects component-level Solid Refresh into the
  long-lived Electron renderer tree. JavaScript changes use deterministic full
  reload while CSS HMR remains enabled; App and Desktop type checks and the full
  2,232-module production renderer build pass.
