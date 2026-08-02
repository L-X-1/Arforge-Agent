---
title: Arforge Development Discipline
category: concept
summary: Project rules and next-step discipline for keeping Arforge focused on stability, real use, installability, learning data, and CLI release readiness.
tags: [arforge, development-process, dogfooding, release-readiness]
sources: 2
updated: 2026-06-14
---

# Arforge Development Discipline

## Definition
The Arforge development discipline is the set of project constraints that prevent the agent from drifting into feature sprawl: integrate existing modules deeply, fix real crashes, validate through real CLI conversations, and keep the desktop status document synchronized.

## Key claims
- Do not keep adding modules before proving the existing chain works end to end.
- Real dogfooding and crash data are more valuable than paper completion percentages.
- CLI installability and stable startup should beat desktop development in priority.
- Learning systems must receive real conversations and real corrections, or they remain mostly potential energy.
- The desktop status file should be appended every three steps and should not be casually rewritten.

## Next priority pattern
- P0: friendly crash containment, first-run configuration, dogfooding capture.
- P1: one-line install regression, user docs, richer Plan Mode interaction.
- P2: OCR/document activation, desktop prototype only after CLI stabilizes, future update mechanism.

## Used in
- [[synthesis/arforge-agent-architecture-2026-06-14]]

