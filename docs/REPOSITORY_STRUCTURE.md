# Repository structure

This document defines the durable project layout and the boundary between source,
curated evidence, local state, and rebuildable output.

## Durable source

| Path | Purpose |
| --- | --- |
| `packages/` | TypeScript application, CLI, desktop shell, SDKs, and shared packages |
| `arforge/` | Preserved Python capability and harness implementation |
| `bin/` | Command entry points |
| `ide/` | Source for supported IDE integrations |
| `script/` | Bun/TypeScript repository tooling and release operations inherited from the application stack |
| `scripts/` | Arforge operational entry points, Python tooling, and PowerShell runbooks |
| `tests/` | Python and cross-stack test suites |
| `specs/` | Machine-readable contracts and acceptance specifications |
| `docs/` | Architecture, operations, release, and user documentation |
| `deploy/` | Deployment definitions owned by this repository |
| `.github/` | CI and repository automation |

The two script directories are intentional: `script/` is part of the Bun
application toolchain, while `scripts/` contains Arforge operations and
cross-stack entry points. Do not merge them without updating every package and CI
reference.

## Evidence

`artifacts/` contains only small, curated evidence that is useful for review or
an explicit release gate. Raw browser profiles, unpacked ASAR trees, temporary
bundles, and repeatable UI build output do not belong there and are ignored.

An evidence producer should write to a dedicated subdirectory, redact secrets,
and document whether its output is intended to be committed. Generated output is
not source merely because it was produced by an acceptance run.

## Local persistent state

The following paths can contain owner data or credentials and must never be
removed by routine cleanup:

- `.env` and `.env.*`
- `.arforge/`
- `data/`
- `workspace/`
- database files, exports, and backups

## Rebuildable local state

The following paths are caches or outputs and may be removed when the associated
process is stopped:

- `node_modules/`, package-local `node_modules/`, `.bun/`, and `.venv/`
- `build/`, `dist/`, `out/`, `.turbo/`, `.pytest_cache/`, and `__pycache__/`
- `packages/app/e2e/.playwright-temp/`, Playwright reports, and test results
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
