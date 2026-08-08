# Arforge Agent

[中文说明](README.cn.md)

Arforge Agent is a local-first AI development agent for development workspaces.
The current public source snapshot tracks test build `1.0.0-test.1`, displayed as
`Arforge 测试 1.00.00 版`. This repository provides source code and development
documentation; no official store release or public update service is offered yet.

Current status: `1.0.0-test.1`. The test build is intended for local project work and is not
yet published to public PyPI.

License status: `UNLICENSED`. Public source visibility does not grant permission to copy,
redistribute, or create derivative works unless the repository owner provides a license.

## Unified architecture

- `packages/core`: shared contracts, database, Session Runner and the native
  TypeScript capability surface.
- `packages/arforge`: unified CLI, provider, server, tools and session runtime.
- `packages/app`: shared Solid application for Desktop and Web.
- `packages/desktop`: current Electron desktop shell.
- `arforge/`: preserved Arforge Agent capabilities, including memory,
  multi-agent, evaluation, automation and office tools.

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
- External `E:\Arforge` source dependencies, Junctions and running processes: 0.
- PostgreSQL application-role write round-trip and backup/restore comparison
  passed.

Skipped cases are optional runtimes or platform capabilities absent from this
Windows host. Missing Go/Ruby/PHP plus a stopped Docker engine is reported
honestly and is never treated as a successful toolchain.

## Setup

```powershell
cd E:\Arforge-Agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,postgres]"
.\.tools\bun-1.3.14\bun.exe install
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
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 logs-prune 30
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 secrets-scan
```

`logs-prune` is preview-only unless `--apply` is supplied. `secrets-scan`
reports only file paths and credential-category counts, never credential
values.

Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1
```

Both launchers use this repository's pinned Bun runtime, load the same private
user environment and reject a different owning workspace.

## Preserved Python capability CLI index

These compatibility commands remain available while their implementation is
progressively moved behind typed Core, HTTP and Desktop contracts:

```text
arforge
arforge ask
arforge print
arforge doctor
arforge privacy
arforge export
arforge clear-data
arforge logs-prune
arforge secrets-scan
arforge db-migrate
arforge db-current
arforge db-stamp
arforge db-sql
arforge db-downgrade
arforge status
arforge tools
arforge agents
arforge capabilities
arforge memory
arforge learning
arforge auth
arforge ssh
arforge features
arforge update
arforge config
arforge db-backup
arforge db-verify
arforge db-restore
arforge profile-backup
arforge profile-verify
arforge profile-restore
arforge sandbox-status
arforge code
arforge goals
arforge acp
arforge eval
arforge eval-ablation
arforge capability-eval
arforge stack-acceptance
arforge project-acceptance
arforge quality
arforge permissions
arforge skills
arforge plugins
arforge custom
arforge output-style
arforge keybindings
arforge feedback
arforge server
arforge web
arforge daemon
arforge workflows
arforge workspace
arforge custom-agents
arforge stats
arforge agent-metrics
arforge evolution-metrics
arforge cost-optimization
arforge repo-scale
arforge file-state
arforge replay
arforge multimodal-diagnose
arforge patch-batch
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

Model-backed evaluation is fail-closed on token spend. The default limit is
`300000` tokens per task and can be overridden explicitly:

```powershell
arforge eval --suite formal --token-budget 300000
arforge eval --suite formal-multistack --token-budget 300000
```

The manual GitHub Actions workflow `Formal model evaluation` runs both complete
50-task suites against PostgreSQL and retains their JSON/formal evidence. Its
optional staging job additionally performs a real isolated workspace E2E, 100
paced provider calls over at least 15 minutes, and long-run evidence ingestion.
The staging job refuses to start unless the protected `staging` environment
declares explicit test-credential and production-isolation provenance.

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
