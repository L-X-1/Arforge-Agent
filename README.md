# Arforge Agent

[中文说明](README.cn.md)

Arforge Agent is a local-first AI development agent for development workspaces.
The current public source snapshot tracks test build `1.0.0-test.1`, displayed as
`Arforge 测试 1.00.00 版`. This repository provides source code and development
documentation; no official store release or public update service is offered yet.

Current status: `1.0.0-test.1`. The test build is ready for controlled local project work; it is not yet published to public PyPI.

License status: `UNLICENSED`. Public source visibility does not grant permission to copy,
redistribute, or create derivative works unless the repository owner provides a license.

## Project documentation

- [User guide](docs/USER_GUIDE.md)
- [Repository structure](docs/REPOSITORY_STRUCTURE.md)
- [Developer onboarding](docs/DEVELOPER_ONBOARDING.md)

## Unified architecture

- `packages/core`: shared contracts, database, Session Runner and the native
  TypeScript capability surface.
- `packages/arforge`: unified CLI, provider, server, tools and session runtime.
- `packages/app`: shared Solid application for Desktop and Web.
- `packages/desktop`: current Electron desktop shell.
- `arforge/`: Python compatibility and migration support plus test helpers. The
  TypeScript packages own the product CLI, session runtime and business state.

CLI, Server, App and Desktop use one provider, session, permission and
PostgreSQL contract. Python capabilities no longer own a second desktop session
state; the JSONL capability bridge and its sidecar were retired.

## Verified state — 2026-07-27

- Real CLI → Core → DeepSeek request completed with `finish=stop`.
- A second real request after switching to least-privilege PostgreSQL returned
  `Arforge私有链路正常`.
- Python full suite: `2967 passed, 7 skipped, 0 failed`.
- Mature TypeScript runtime:
  `3182 passed, 65 skipped, 1 todo, 0 failed`.
- Shared Desktop/Web App: `678 passed, 0 failed`.
- Root TypeScript type checking: `23/23` packages.
- Strict brand audit: `0 hits in 0 finding files`; `6,392` files visited and
  `5,786` text files scanned.
- External source dependencies, junctions and running processes: 0.
- PostgreSQL application-role write round-trip and backup/restore comparison
  passed.

Skipped cases are optional runtimes or platform capabilities absent from this
Windows host. Missing Go/Ruby/PHP plus a stopped Docker engine is reported
honestly and is never treated as a successful toolchain.

## Setup

```powershell
cd Arforge-Agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,postgres]"
bun install
```

Private environment:

```text
%USERPROFILE%\.arforge\.env
```

```dotenv
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ARFORGE_DB_URL=postgresql://arforge_app:replace-with-generated-secret@127.0.0.1:5432/arforge
```

The unified runtime's selected model is stored in:

```text
%USERPROFILE%\.config\arforge\arforge.json
```

```json
{
  "model": "deepseek-v4-flash/deepseek-v4-flash"
}
```

To provision and persist a least-privilege application role while the current
process temporarily holds an administrative `ARFORGE_DB_URL`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure_private_postgres.ps1
```

The script generates a random `arforge_app` password, audits the allowed and
denied privileges, and persists only the application connection in the private
user `.env`.

## Run

CLI:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --help
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 doctor --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 tools --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 agents --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 chat
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 ask "检查当前工作区"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 print --final-message-only "总结当前工作区"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --print -p "检查当前工作区"
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 config
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 logs-prune 30
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 secrets-scan
```

Python 包的旧启动方式也已并入同一 TypeScript CLI：

```powershell
python -m arforge --help
arforge --help
```

它们只转发到 `packages/arforge/src/index.ts`；迁移期模块入口
`python -m arforge.cli`、仓库根 `main.py` 和 Windows `arforge.cmd` 也使用同一
bridge。找不到 Bun 或 TS 入口时会明确失败，不会回落到旧 Python 命令解析器。
直接导入 `arforge.cli` 仍仅用于迁移期兼容 API；外部 Python IDE、测试和服务宿主
请使用 `arforge.cli_compat`。该 facade 只转发 `cli_bridge`，其 `invoke(...)`
返回结构化 stdout/stderr/退出码，始终禁用 shell；缺少 Bun/TS 时明确失败，不会
回落到旧 Python parser。

开发者可运行 `bun run script/arforge-cli-compat-inventory.ts --json --check` 查看旧 CLI
的函数级冻结清单；兼容命令 `python scripts/cli_compat_inventory.py --json --check`
只无状态转发到同一 TS 实现。两条入口都只读源码并校验 digest，不执行旧 parser 或写入状态。

`workspace --contract-audit` and `settlement-status` expose the same read-only
`execution_boundary` in JSON and human output: no writes, profile/settlement state
creation, recovery repair, or Provider execution. Complete evidence does not grant
mutation authority.

`logs-prune` is preview-only unless `--apply` is supplied. `secrets-scan`
reports only file paths and credential-category counts, never credential
values.

Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1
```

Both launchers use this repository's pinned Bun runtime, load the same private
user environment and reject a different owning workspace.

## Unified TypeScript CLI index

These commands are served by the unified TypeScript Core, HTTP and Desktop
contracts. `chat` is the interactive TUI alias, `ask` and `print` are one-shot
`run` aliases (print also owns the historical `--print`/JSONL flags), `auth`
is the provider-management alias, and `config` is the same read-only loader
exposed by `debug config`. The executable output of
`arforge --help` is the source of truth; this list is intentionally limited to
commands that have a registered TypeScript owner. The historical Python
implementation is retained only as migration reference and an evaluation
oracle; it is not a desktop runtime or packaged sidecar:

```text
arforge
arforge chat
arforge run
arforge ask
arforge print
arforge config
arforge doctor
arforge status
arforge privacy
arforge export
arforge import
arforge session
arforge clear-data
arforge logs-prune
arforge secrets-scan
arforge upgrade
arforge uninstall
arforge serve
arforge web
arforge models
arforge capabilities
arforge tools
arforge providers
arforge auth
arforge agent
arforge agents
arforge mcp
arforge acp
arforge quality
arforge repo-scale
arforge run-history
arforge goal
arforge task
arforge subagent-control
arforge prompt-queue
arforge workflow
arforge memory
arforge learning
arforge feedback
arforge agent-metrics
arforge multimodal-diagnose
arforge features
arforge permissions
arforge skill
arforge skills
arforge plugin-manager
arforge plugins # historical alias; same TypeScript/Core owner
arforge stats
arforge bridge
arforge plugin
arforge db
arforge attach
arforge debug
arforge generate
```

The `memory` entry now has a TypeScript owner for `status`, `list`, `search`,
`get`, `create`, `update`, `facets`, `recall-quality`, `digest`, and the
read-only `metrics`, `write-stats`, `recovery` and `conflict` reports; it uses the same Core/Server HTTP
contract as Desktop. `memory conflict` reports the pure Core benchmark plus
already persisted candidates through `conflictList`, but deliberately does not
invoke the mutating `conflictScan`. `memory metrics` composes typed status,
recall-quality, persisted-conflict and bounded source counts without writing;
the historical golden-eval fixture/history portion is explicitly
`not_comparable` until an equivalent producer contract exists. Historical
`write-stats` now exposes only the Core database projection (scope/source/type
counts); its legacy `memory_writes.jsonl` decision log is `not_read`, and
`memory write-stats --clear` remains fail-closed. `memory recovery` now
provides a read-only aggregate of the profile-local recovery log (including
`corrupt_rows`); its `--clear` and `memory feedback` remain fail-closed with an
explicit migration message until their write/clear contracts are implemented. `memory
feedback` also validates the legacy retrieval UID/useful/irrelevant syntax before
returning exit code 2; without a durable retrieval event, returned-set validation,
workspace/identity binding and transactional update it never writes recall feedback.
Use `memory feedback --contract-audit --json` to inspect the same TS/Core
fail-closed contract as a structured read-only report; it does not require a
retrieval UID or write any state.
Desktop `agentCapability.deepInsights` exposes the same `memory-feedback`
section, so member, owner, and admin users see one consistent contract boundary.
Other
Python-era names such as `ssh`,
`daemon`, `workspace`, `workflows validate/run`, and the release/evaluation audit family
remain explicit migration backlog until a tested TypeScript owner is registered.
The `learning` entry now has a TypeScript/Core owner for `status`, `recall`,
`record`, `undo`, `sync-dogfood`, and `dream`; `recall` composes the existing
read-only `Memory.recallQuality` and `Learning.status` contracts without
writing state. It uses the same workspace-scoped LearningV2 HTTP/SDK contract
as Desktop. `dream` is a deterministic read-only projection of `Learning.status`
and explicitly reports that consolidation was not run; it does not call a model
or write patterns. Any future consolidation must be a separate typed
ActionGateway operation.
The `feedback` entry now has a TypeScript/Core owner for `summary`, `list`,
`submit`, and `delete`; it uses the same workspace-scoped FeedbackV2
HTTP/SDK contract as Desktop, redacts credentials before local persistence,
and links non-neutral ratings to formal learning. The old positional Python
syntax remains accepted by the same TS owner; historical UUID records from
the retired Python feedback database are not reopened.
The `skill` command and the historical plural `skills` entry now share one
TypeScript/Core `ManagedSkillRegistry` owner. Both spellings support
`list`, `enable`, `disable`, `refresh`, and deterministic `route` inspection;
`skills route <request>` is an argv alias, not a second Python manifest/state
writer or registry.
The `repo-scale` command also accepts the historical
`repo-scale <path> [--query <text>]` spelling; path, query, scan budgets and
human/JSON rendering all use the same bounded TypeScript/Core scanner owner.
The `quality` command likewise accepts the historical `quality <patch-file>`
spelling. A single `.diff`/`.patch` positional input (or recognizable unified
diff content) is assessed by the same TypeScript/Core quality gate; ordinary
source-file positionals retain file-quality semantics, while automation can be
explicit with `--patch-file`.
The `plugin-manager` command now owns the historical Python `plugins` spelling
as a direct alias. `plugins` defaults to `list`, and the historical
`list/inspect/install/update/remove/restore/enable/disable` actions share the
same typed API, control approval and Core plugin state. Legacy positional
install names are normalized to `--name`; a positional plugin root is accepted
only when it is exactly `<workspace>/.arforge/plugins`, otherwise the request
fails before any state change.
The Python bridge does not silently emulate those commands; it either runs the
canonical TypeScript command above or fails with an actionable error.

The `agent-metrics` command now owns the historical quality telemetry report in
TypeScript/Core. It aggregates the profile-local dogfood, recovery,
verification and regression sources, exposes formal and longitudinal gate
status, and supports bounded `history`, `record`, and `--clear` operations.
Missing or malformed telemetry is reported as `n/a`/`insufficient_evidence`
without affecting the main session runtime; it is a read-only report except
for the explicit local history actions.

`run-history [run-id]` reads the same bounded, redacted run transaction/trace
artifacts that Core uses for recovery and desktop history. It is read-only; a
missing run is reported as data rather than triggering a replay or another
model call. The historical `arforge replay [run-id]` spelling is an alias for
this same TypeScript/Core report owner, so it never starts a model or
re-executes a tool.

`multimodal-diagnose <file>` is now the TypeScript/Core owner for the historical
Python diagnostic command. It accepts a workspace-relative file, optional
`--workspace`, extracted `--text`, `--mode error|frontend|javascript`, bounded
`--limit 1..50`, and `--json`. The command calls the same typed diagnostics
route used by Desktop, performs only local bounded extraction and analysis,
reports `localOnly=true` and `modelCalls=0`, and never writes files or calls a
network service. The Python module entry forwards to this exact command and
does not retain a second parser or diagnostic implementation.

`features` now owns the read-only historical feature-rollout view in
TypeScript/Core. `features list` (or `features --json`) reads the typed
`agentCapability.deepInsights` policy used by Desktop and reports only the
six TS-native flags. The old Python `feature_flags.json` is never read. The
historical `set`, `clear`, and `refresh` actions validate their arguments and
then exit 2 with an explicit `fail-closed` message until a transactional,
permissioned TS feature-policy writer is implemented; they cannot create a
second state owner.

`features --contract-audit --json` exposes the same typed migration contract
without reading or writing `feature_flags.json`: it reports the missing durable
state, workspace/identity binding, authorization, transaction, rollback,
cross-process, audit, and retention requirements. The Desktop deep-insights
payload carries this report as `feature-policy-contract` so the CLI and UI do
not grow separate policy semantics.

The Desktop deep-diagnostics response also exposes a typed `file-state`
contract audit. It explains why the process-local tracker cannot yet be treated
as a durable cross-process observation ledger and lists the missing journal,
run/session and workspace/identity binding, persistence/recovery,
authorization, cancellation, settlement, evidence, and retention requirements.
The historical `file-state` CLI remains an explicit exit-2 fail-closed boundary;
it never reads or creates tracker state, and it does not mislabel
`FileMutation.fingerprint` or `AnalysisRuns` as the missing ledger.

The system-overview response also exposes a read-only `cost-optimization`
contract audit. It lists the missing durable attribution, provider-pricing
version, token reconciliation, cross-process aggregation, restart recovery,
evidence, and retention requirements. The historical `cost-optimization` CLI
remains an explicit exit-2 fail-closed boundary; it never reads or creates the
legacy tracker and does not mislabel Session stats, AgentMetrics, or file
fingerprints as a reconciled cost ledger.

`permissions` now also routes the historical Python entry to TypeScript/Core.
`permissions list` (or `permissions --json`) reads the current workspace's
saved rules through the typed `permission.saved.list` owner shared with
Desktop. Historical `add` and `revoke` keep strict argument validation but
return exit 2 with an explicit `fail-closed` message until transactional,
authorized, audited and rollback-safe writes are complete; the old Python
permission profile is never read or created.

`permissions --contract-audit --json` provides the corresponding read-only
permission-policy contract audit. It lists the missing typed rule, workspace,
authorization, transaction, optimistic-revision, audit, rollback, and
cross-process requirements; its `permission-policy-contract` deep-insights
section is shared with Desktop. Neither audit reads `permission_rules.json`.

`workflow` is the canonical typed workflow owner. The historical `arforge workflows`
alias supports `list`, `validate`, `run`, `runs`, `status`, `events`, `pause`,
`resume`, `cancel`, `retry`, `approve`, and `reject` spellings through the same
HTTP/SDK operations (`status` maps to `get`). `workflows run` now uses the same
typed preview/start owner: without `--execute` it writes a deterministic dry-run
report, while `--execute` waits for the durable run to settle (or reports a
paused/approval state). `--report` is explicit and constrained to the selected
workspace; omitted reports go to the profile data directory. No second graph
journal or Python execution loop is created.

`capabilities test <input>` is the safe compatibility form of the historical
Python capability probe. It ranks keyword matches through the TypeScript/Core
catalog and reports a `route-preview` with zero side effects; it does not call
model-backed handlers, execute commands, or modify files. The future
`--execute` form remains closed until every capability has a typed Core
execution, permission, and evidence contract.

`capabilities evaluate` is the corresponding read-only contract audit. It
checks every catalog entry for typed input/output, ActionGateway authorization,
cancellation, evidence, settlement, and an owner declaration. The report does
not load or invoke handlers; entries missing any requirement remain
`fail-closed`, so a catalog listing is never mistaken for executable access.

`capabilities overview` reads the same typed `agentCapability.systemOverview`
used by the control center and exposes runtime, tools, subagent roles, and the
cost-optimization contract sections. Use `--json` for structured automation or
`--all` to expand the read-only section data; it never starts a handler, model,
shell command, or write path.

`memory digest` 现在也由 TypeScript/Core 唯一 owner 提供：它通过同一
MemoryV2 HTTP/SDK 读取当前工作区可见记忆，按类别稳定排序并支持
`--category`、`--json`、`--path` 和 `--digest-limit`。JSON 报告包含
`truncated`，达到 500 条读取上限时不会把有界结果伪装成完整档案；Markdown
写入只有在显式 `--path`（或无路径的人类模式同步到 profile 默认档案）时发生。
旧 Python `memory digest` 入口仅转发到这条 TS 管线。

`memory conflict` 也由同一个 TypeScript/Core owner 提供。它是安全的只读
诊断：运行共享的确定性冲突基准，并读取当前工作区已持久化候选；不会自动
执行 `conflictScan`、写入冲突历史或推测人工关系覆盖率。旧 Python `memory
conflict` 入口仅转发到该报告。`memory metrics` 同样只读地组合 Core
状态/召回/冲突指标；旧 Python golden eval 与历史文件在 typed producer
完成前显示 `not_comparable`/`not_read`，不会隐式写入。`memory write-stats`
只显示 Core 数据库的只读投影，旧 `memory_writes.jsonl` 决策日志显示
`not_read`，`--clear` 保持退出码 2。`memory recovery` 只读聚合
profile-local `recovery_outcomes.jsonl`，损坏行计入 `corrupt_rows`；其
`--clear` 同样保持退出码 2。`memory feedback` 仍明确返回迁移提示。

The canonical command list deliberately does not claim the following legacy
names merely because the Python module is still importable:

```text
arforge eval
arforge eval-ablation
arforge capability-eval
arforge stack-acceptance
arforge project-acceptance
arforge daemon
arforge workspace
arforge plugins
arforge custom
arforge output-style
arforge keybindings
arforge server
arforge custom-agents
arforge cost-optimization
arforge file-state
arforge patch-batch
arforge ssh
arforge update
arforge code
arforge goals
arforge db-migrate
arforge db-stamp
arforge db-sql
arforge db-downgrade
arforge db-backup
arforge db-verify
arforge db-restore
arforge profile-backup
arforge profile-verify
arforge profile-restore
arforge sandbox-status
arforge accessibility-audit
arforge governance-audit
arforge installer-audit
arforge signing-audit
arforge staging-audit
arforge upgrade-audit
arforge ship-audit
arforge release-audit-bundle
arforge release-remediation-plan
arforge evidence-template
arforge ship-gate
arforge self-correct-dogfood
```

These names are tracked in the Python compatibility ledger and will only be
enabled after their input/output, permission, cancellation, and negative-path
contracts are implemented and tested in TypeScript. This keeps migration
progress visible instead of masking missing parity behind the bridge.

Model-backed evaluation remains an internal plan/evidence surface for now. Its
historical Python `eval` names are tracked in the compatibility ledger and are
not advertised as executable TypeScript commands until the same input/output,
budget, permission, and failure contracts have a tested TS owner.

`arforge db current [main]` is the read-only TypeScript/Core migration-ledger
view. The historical `arforge db-current [main]` spelling is normalized to the same
command and returns the same JSON/text revision without applying migrations.
`multiagent` and the remaining mutating `db-*` compatibility leaves stay
explicitly fail-closed until they have their own typed owner and evidence.

## Database boundary

- Private durable mode: PostgreSQL database `arforge`, runtime role
  `arforge_app`; multi-agent state defaults to the isolated `arforge_ma`
  database with the same runtime role unless `ARFORGE_MULTIAGENT_DB_URL` is
  explicitly configured.
- Administrative role: migrations, grants and restore administration only.
- SQLite/in-memory: explicit isolated tests and not-yet-migrated compatibility
  capabilities only.
- PostgreSQL backups:
  `%LOCALAPPDATA%\Arforge\backups\postgresql`.

`arforge clear-data` is deliberately two-stage. Without `--execute`, it only
inventories the selected `workspace|all` scope, creates a verified encrypted
PostgreSQL backup and prints a 15-minute one-time phrase. Execution rechecks
the database fingerprint and backup hash. `all` additionally requires a
separate `ARFORGE_DB_ADMIN_URL`; accounts, credentials and migration ledgers
remain preserved.

Inside the CLI TUI, enter `/models` to open the model picker. The keyboard
equivalent is `Ctrl+X`, release, then `M`; `F2` cycles recent models. A model
can also be selected at startup with `--model provider/model`.

## Project boundaries

- The repository provides a manually triggered unsigned Windows internal Alpha
  and a protected signed-Beta candidate workflow. The Beta workflow remains
  blocked until a validated cloud-HSM code-signing identity and protected GitHub
  environment are configured. See the
  [internal Alpha guide](docs/INTERNAL_ALPHA_RELEASE.md) and
  [signed Beta setup guide](docs/SIGNED_BETA_SETUP.md). Stores, websites,
  automatic updates and public hosting remain disabled.
- The frozen Tauri/Python product entry points were retired to the Windows
  Recycle Bin after owner approval and database convergence on 2026-07-28.
- Generic repository parsing and third-party LSP/ripgrep downloads remain
  functional dependencies. They are not Arforge public hosting; removing those
  capabilities requires an explicit owner decision.
- `node_modules` and `.bun` are rebuildable dependency trees/caches, not product
  source. Removing them requires reinstalling dependencies before the next run.

See the [Capability Fusion Matrix](docs/CAPABILITY_FUSION_MATRIX.md), the
[Local Project Readiness Audit](docs/LOCAL_PROJECT_READINESS.md), and the
[User Guide](docs/USER_GUIDE.md). Private operations are documented in the
[Database Migration Runbook](docs/DATABASE_MIGRATION_RUNBOOK.md), the
[Database Deployment Guide](docs/DATABASE_DEPLOYMENT.md), the
[Private HTTPS Deployment Guide](docs/PRIVATE_HTTPS_DEPLOYMENT.md), the
[User Authentication and Tenant Isolation Guide](docs/USER_AUTH_AND_TENANCY.md), and the
[Dependency Attribution Policy](docs/DEPENDENCY_ATTRIBUTION_POLICY.md).
Generated and legacy deletion decisions are recorded in the
[owner-approval deletion list](docs/DELETE_CANDIDATES_2026-07-27.md).
