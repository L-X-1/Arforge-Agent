# Changelog

All notable changes to Arforge Agent are documented here. The project follows semantic versioning once it reaches a public release channel.

## Unreleased

### Added

- GitHub Actions quality matrix for Windows and Linux on Python 3.10–3.12.
- Isolated wheel build, install, content and CLI smoke checks.
- PostgreSQL backup and offline verification commands.
- Local privacy inventory, log retention cleanup and confirmed data deletion.
- `python -m arforge` module entry point.
- Python dependency consistency and vulnerability audit CI gate.
- Versioned Alembic migrations for the main and multi-agent PostgreSQL databases, including compatibility stamping and rollback commands.
- Reproducible 100-turn offline dogfood and cold-start performance budgets in CI.
- Product README, user guide, developer onboarding guide and safe environment template.
- Hashed universal Python release/development locks plus CycloneDX SBOM, checksums and a machine-readable release manifest.
- Versioned read-only JSONL machine bridge for desktop/backend health, status, tools, agents, capabilities and redacted configuration.
- Backward-compatible Machine Bridge 1.1 sessions with ordered streaming events, cooperative cancellation/timeouts, concurrency limits and blocking transport backpressure.
- Session-isolated, expiring one-time approvals for registered tools and backend-generated diffs, including schema validation, path confinement, optimistic hash checks, atomic writes and separately approved rollback.
- Background Bridge tool tasks with ACK-before-event ordering, session-scoped query/cancel/retry, fresh approvals for retries, and privacy-minimized restart metadata.
- Privacy-minimized Bridge session/action journals with startup invalidation, recovered-state discovery, and explicit non-resumable payload semantics.
- Bounded, newest-first Bridge log pagination with defense-in-depth redaction, plus revisioned allowlisted settings shared by CLI and Bridge behavior.
- Tauri 2 + React Desktop Alpha foundation with a persistent local Bridge sidecar host, startup diagnostics, revisioned settings, redacted log viewer, responsive accessible shell, and Windows CI quality gates.
- Desktop Bridge 1.1 chat sessions with ordered streaming events, acknowledgement-race buffering, sequence-gap reconciliation, cooperative cancellation, and state continuity across page navigation.
- Fail-closed Desktop approval center with exact action summaries, expiry/status history, critical-risk blocking, recovered-payload protection, one-time approval, and full action rejection without implicit execution.
- Backend-owned Desktop diff workbench with explicit workspace authority, full-content preview, hash/stat review, separate approve/apply and rollback approval/action steps, and fail-closed recovery/conflict states.
- Read-only `workspace.get` Bridge method and `ARFORGE_WORKSPACE` Tauri sidecar working-directory authority.
- Desktop asynchronous task center with explicit approved-tool launch, durable status history, event/poll reconciliation, cooperative cancellation, side-effect warnings and fresh-approval retry flow.
- Bounded durable Bridge task history that prunes terminal metadata from both memory and SQLite.
- Reproducible Windows Bridge sidecar freezing with hashed PyInstaller build dependencies and multi-surface protocol smoke tests.
- Manual-gated unsigned Desktop candidate workflow for NSIS/MSI build, MSI install, bundled-sidecar launch, uninstall and SHA-256 evidence retention.
- Protected, manual-only Authenticode Desktop candidate workflow with fail-closed certificate validation, RFC 3161 timestamps, per-file signature verification and signing-material cleanup.
- Locked Rust dependency graph and signed Desktop upgrade compatibility workflow covering upgrade, downgrade rejection, profile preservation and uninstall cleanup.
- Production Windows icon assets plus native NSIS/MSI bundling and current-user NSIS install/start/uninstall/profile-preservation verification.
- Unified Desktop/Python/npm product version `0.7.0`, fixed MSI upgrade identity and downgrade blocking.

### Security

- First-run API-key entry no longer echoes the credential, local environment values reject multiline injection, and Desktop continues to reject sensitive settings over IPC.
- Central enforcement for medium/high-risk tool confirmation.
- Fail-closed non-interactive workspace trust and tool approval.
- Recursive redaction for credentials and authorization data in structured logs.
- MCP JSON-RPC size, depth, method and response-envelope validation.
- High-confidence prompt injection is blocked before memory, learning and model access.
- Removed plaintext PostgreSQL credentials from development scripts.
- npm launch and install wrappers no longer execute commands through a shell.
- Package import no longer connects to or mutates the configured database.
- Model provider rate limiting now wraps chat, streaming, planning and multi-agent calls centrally.
- Release Desktop builds ignore command-path overrides and resolve only the bundled Bridge sidecar; Windows starts it without a visible console window.

### Fixed

- Unified the product test model baseline as `deepseek-v4-flash` while preserving private `DEEPSEEK_MODEL` overrides, and added an auto-selecting Windows Desktop launcher.
- Declared Tauri bundle icons explicitly so WiX MSI packaging no longer fails after native compilation.
- Quoted MSI paths containing spaces, aligned release verifiers with the installed `arforge-agent-desktop.exe` name, and retained verbose Windows Installer logs.
- Code reference indexing now includes import statements and matches imported module paths, eliminating artifact-dependent module-reference results.
- Windows shell-builtin command compatibility without enabling a shell.
- Tool failures no longer report false success.
- Tests cannot read developer API keys or connect to the configured production database.
- Package discovery excludes recovery artifacts and corrupt backup directories.
- npm lockfile exposes the single canonical `arforge` command.
- Agent initialization avoids eager SQLAlchemy/memory imports, reducing measured P50 from 614.5 ms to 85.1 ms.
- `ARFORGE_HOME` now consistently isolates config loading, onboarding, diagnostics and default backups.
- Source distributions use an explicit root-file whitelist and exclude an invalid historical recovery script.
- Runtime logs, tasks, trust, language and backups now share one `ARFORGE_HOME` authority; package import no longer creates profile directories.
- Product logs are append-only JSON Lines with UTC timestamps, event IDs and recursively redacted context.
- npm help, version, arguments and exit codes now delegate to the canonical Python CLI; postinstall creates a package-private virtual environment and fails closed.
- Complex CLI requests now enter the real MasterAgent pipeline, while prompt injection is blocked before orchestration touches a model.
- CLI argument validation, top-level redacted error handling, credential-free database display and verified local-data handling.
- Matched tool failures are surfaced as failures and can no longer silently fall through to a model-generated answer.
- Streaming chat now blocks high-confidence prompt injection before memory/model access and reports model failures as structured failures instead of successful answer text.

### Validation

- 749 Python tests passing after the secure model configuration, reproducible sidecar builder, and Desktop launcher batch.
- 744 Python tests passing.
- Ruff and compileall passing.
- Wheel build contains the task, state, log and settings runtimes (473 entries in the current artifact).
- npm audit and pip-audit report no known vulnerabilities after installer upgrade.

## 0.7.0-alpha — 2026-06-12

Initial internal Alpha baseline under the Arforge Agent name:

- CLI agent runtime, tool registry and permission model.
- Planning, reasoning, code intelligence and capability layers.
- Multi-agent orchestration and local learning/memory systems.
- PostgreSQL persistence and a single `arforge` implementation namespace.
- Initial packaging through Python wheel and npm command wrapper.

This version was an internal development baseline and was not approved for public production use.
