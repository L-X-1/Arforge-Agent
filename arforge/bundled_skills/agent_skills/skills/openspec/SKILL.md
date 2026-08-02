---
id: openspec
name: OpenSpec
description: Uses the OpenSpec CLI to turn material behavior changes into proposal, specification, design, task, apply, verify, and archive artifacts.
version: 1.6.0-arforge.1
license: LicenseRef-Proprietary
tags: [specification, planning, change-management, verification]
---

# OpenSpec for Arforge

OpenSpec is the authoritative specification layer for material feature,
architecture, API, data-model, migration, or cross-component changes. Skip it
for explanations, tiny local edits, and straightforward bug fixes whose
expected behavior is already established.

The installed runtime is `@fission-ai/openspec` 1.6.0. Use the real `openspec`
CLI rather than inventing artifact paths.

## Lifecycle

1. If requirements still contain a high-impact user-owned decision, complete
   grill-me first.
2. If the workspace has no OpenSpec root and the material change is authorized,
   initialize without installing duplicate agent skills:
   `openspec init --tools none --profile core`.
3. Explore existing changes with `openspec list --json` and project context.
4. Create a proposal with a kebab-case change name, then use
   `openspec status --change <name> --json` and
   `openspec instructions <artifact> --change <name> --json` as the
   authoritative artifact graph and templates.
5. Produce every transitive artifact required for apply, re-reading dependency
   files from disk before each artifact.
6. Apply tasks in order, keeping task checkboxes synchronized with verified
   implementation evidence.
7. Validate and verify completeness, requirement/scenario coverage, design
   coherence, tests, lint, and type checks before archive.
8. Archive only after the active change and delta-spec sync state are explicit.

An explicit request to implement is sufficient authorization to proceed once
blocking decisions are resolved; do not add a redundant approval gate. Trellis
may track long execution, while Superpowers supplies TDD/debug/review tactics.
Arforge safety and permission rules remain authoritative.

The detailed workflow resources are bundled under `upstream/skills/`.
