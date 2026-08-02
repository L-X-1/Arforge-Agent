---
id: trellis
name: Trellis
description: Manages long, multi-step development through durable task artifacts, relevant project specifications, checkpoints, implementation context, quality checks, and session memory.
version: 0.6.8-arforge.1
license: LicenseRef-Proprietary
tags: [long-task, task-management, context, verification, memory]
---

# Trellis for Arforge

Trellis is the long-task execution backbone. Use it when work spans several
dependent steps, multiple packages or layers, repeated sessions, or a delivery
that benefits from durable PRD/design/implementation/check artifacts. Do not
create Trellis overhead for a simple answer or local one-step edit.

The installed runtime is `@mindfoldhq/trellis` 0.6.8. Trellis is AGPL, so
Arforge calls the external CLI and does not redistribute its source.

## Workflow

1. If `.trellis/` is absent and long-task repository writes are already in
   scope, initialize without overwriting existing files:
   `trellis init --user arforge --yes --skip-existing`.
2. Read `.trellis` context and relevant specification indexes before editing.
   Resolve repository facts with tools; ask only unresolved user-owned
   decisions.
3. Keep requirements and acceptance criteria in `prd.md`; for complex work,
   keep architecture in `design.md` and ordered implementation plus validation
   in `implement.md`.
4. Execute in checkpoints that each end with concrete validation. Update task
   state as evidence changes and retain enough context for resume.
5. Run the applicable lint, type-check, tests, cross-layer flow review, and spec
   compliance check. Feed reusable project discoveries back into Trellis specs.
6. Finish only when Arforge's original goal and every acceptance criterion have
   fresh evidence.

OpenSpec artifacts are the authority for a material change's behavior. Trellis
references those artifacts instead of duplicating them. Superpowers provides
TDD, debugging, review, and verification methods inside each Trellis step.

Arforge goal persistence replaces any external instruction that would stop and
wait merely because a task is long. Do not commit or archive automatically
unless the user or active workflow authorized it. Arforge permission and safety
rules always take precedence.
