---
title: Brand Identity Consolidation
category: concept
summary: Completed consolidation of every active product surface under the Arforge Agent identity.
tags: [arforge, brand, naming, maintenance]
sources: 1
updated: 2026-07-19
---

# Brand Identity Consolidation

## Canonical identity

- Product name: Arforge Agent.
- Python package and import namespace: `arforge`.
- CLI and npm executable: `arforge`.
- Local user and project data directory: `.arforge`.
- Python distribution: `arforge-agent`.

## Consolidation rule

All active source code, configuration, documentation, tests, package metadata,
generated launchers, user-facing copy, and filenames use the canonical identity.
No compatibility command or duplicate Python namespace is shipped.

Existing local data discovered during the final consolidation was preserved in
an archive below the active `.arforge` directory before obsolete paths were
removed. Runtime code never reads the archive implicitly; users can inspect or
restore it deliberately when needed.

## Verification requirements

1. A case-insensitive repository text scan finds no superseded identity.
2. A case-insensitive filename scan finds no superseded identity.
3. Wheel, source archive, npm package, desktop sidecar, and native desktop build
   contain only the canonical command and namespace.
4. Backend, CLI, bridge, desktop, privacy, diagnostics, and packaging regression
   suites pass after compatibility code is removed.

## Status

- **2026-07-19**: consolidation completed in source, metadata, commands, data
  paths, tests, and documentation; verification was expanded to include built
  artifacts and native desktop behavior.

## Used in

- [[entities/arforge-agent]]
