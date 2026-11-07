# Repository structure

This document defines the durable project layout and the boundary between source,
curated evidence, local state, and rebuildable output.

## Durable source

| Path | Purpose |
| --- | --- |
| `packages/` | TypeScript product runtime, interfaces, adapters, user interfaces, and repository tooling |
| `arforge/` | Python compatibility/migration surface and test helpers; not the product CLI or session-state owner |
| `bin/` | Command entry points |
| `ide/` | Source for supported IDE integrations |
| `script/` | Bun/TypeScript repository tooling and release operations inherited from the application stack |
| `scripts/` | Arforge operational entry points, Python tooling, and PowerShell runbooks |
| `tests/` | Python and cross-stack test suites |
| `specs/` | Machine-readable contracts and acceptance specifications |
| `openspec/` | Behavior proposals and specifications |
| `docs/` | Architecture, operations, release, and user documentation |
| `deploy/` | Deployment definitions owned by this repository |
| `.github/` | CI and repository automation |

The two script directories are intentional: `script/` is part of the Bun
application toolchain, while `scripts/` contains Arforge operations and
cross-stack entry points. Do not merge them without updating every package and CI
reference.

### TypeScript package map

| Package group | Ownership |
| --- | --- |
| `packages/core/` | Shared typed contracts, session/runtime owners, persistence, and capability execution |
| `packages/arforge/` | Bun/TypeScript CLI, providers, tools, and application runtime |
| `packages/server/` | HTTP service and API routes over shared Core owners |
| `packages/app/`, `packages/desktop/` | Shared Solid app and Electron host |
| `packages/schema/`, `packages/protocol/` | Shared data shapes and wire contracts |
| `packages/client/`, `packages/sdk/`, `packages/sdk-next/` | Programmatic client and SDK surfaces |
| `packages/session-ui/`, `packages/ui/`, `packages/tui/` | Session UI, shared components, and terminal UI |
| `packages/identity/` | Brand assets |
| Provider, plugin, and integration packages | Optional model, plugin, and external-service adapters |

The root `arforge/` tree remains for Python compatibility, migration-retained
capabilities, and test support. Product CLI, session execution, and business
state writes belong to the TypeScript packages.

Desktop hosts the shared App renderer and manages its local backend lifecycle.
The App and generated clients use the typed HTTP API. Core owns session
execution, persistence, and capability authorization. Use the CLI entry point
in `packages/arforge/src/index.ts` for terminal or scripted use.

## Evidence

`artifacts/` contains only small, curated evidence that is useful for review or
an explicit release gate. Raw browser profiles, unpacked ASAR trees, temporary
bundles, and repeatable UI build output do not belong there and are ignored.

Keep raw acceptance runs local. This includes screenshots, recordings,
automation traces, staged profiles, fixture workspaces, and build directories,
including run output created beneath `docs/ui-redesign/`. Share a curated
report only after removing account identifiers, provider endpoints, machine
paths, and other personal data. Keep the source for reusable fixtures beside
the tests that use them.

Before publishing a fixture derived from a local run, replace account data,
machine paths, request context, and provider error text with synthetic values.
Preserve the relationships and record shapes that the test asserts. Keep
local Trellis task records and journals with the original acceptance outputs.

## Local persistent state

The following paths can contain owner data or credentials and must never be
removed by routine cleanup:

- `.env` and `.env.*`
- `.arforge/`
- `data/`
- `workspace/`
- database files, exports, and backups

## Local-only scratch and analysis data

`tmp/` can contain runtime logs, database snapshots, and test output.
`.codex-analysis/` can contain generated frames or other material derived from
local media. Both paths are ignored by Git and must be reviewed before any
manual force-add; preserve their contents unless the owner explicitly asks to
remove them.

## Rebuildable local state

The following paths are caches or outputs and may be removed when the associated
process is stopped:

- `node_modules/`, package-local `node_modules/`, `.bun/`, and `.venv/`
- `build/`, `dist/`, `out/`, `.turbo/`, `.pytest_cache/`, and `__pycache__/`
- `packages/app/e2e/.playwright-temp/`, `packages/app/test-results/`, Playwright
  reports, and test results
- `ide/jetbrains/.gradle/` and `ide/jetbrains/.intellijPlatform/`
- `.codex-runtime/` and `.codex-tmp/`

Dependency trees are intentionally kept during ordinary cleanup so the project
remains runnable. Remove them only when reclaiming disk space or repairing an
installation, then reinstall from the lockfile.

## Placement rules

1. Put product code in the owning package, not at the repository root.
2. Put reusable cross-stack contracts in `specs/` and tests in the nearest test
   tree.
3. Put human-facing operational guidance in `docs/`; keep executable procedures
   in `script/` or `scripts/` according to the boundary above.
4. Keep runtime state out of Git. If a tool creates a new cache or scratch tree,
   add a narrowly scoped ignore rule with the tool change.
5. Commit generated evidence only when a named acceptance or release gate consumes
   it and a reviewer can understand its provenance.
