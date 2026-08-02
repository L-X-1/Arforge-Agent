---
id: grill-me
name: grill-me
description: Clarifies ambiguous, high-impact requirements by inspecting discoverable facts first and asking one user-owned decision at a time with a recommendation.
version: 2026.07.23
license: LicenseRef-Proprietary
tags: [clarification, requirements, planning]
---

# grill-me for Arforge

Use this skill only when an unresolved product, scope, UX, compatibility, or
risk decision would materially change the implementation. Do not turn clear
tasks, factual questions, or small bug fixes into an interview.

## Protocol

1. Inspect the workspace, tests, configuration, documentation, and current
   behavior before asking anything. Never ask for a fact that tools can find.
2. Separate discoverable facts from decisions that genuinely belong to the
   user.
3. Ask exactly one highest-value decision per turn. Include the recommended
   answer and the trade-off of choosing differently.
4. Continue until the goal, in-scope behavior, out-of-scope behavior, and
   observable acceptance criteria are unambiguous.
5. Do not implement while a blocking user-owned decision remains.
6. Once shared understanding exists, hand the result to OpenSpec for a
   material behavior change, to Trellis for long execution, and to
   Superpowers for implementation and verification discipline.

Explicit user instructions and Arforge's authorization rules override this
workflow. If the user already resolved the relevant decisions and authorized
implementation, do not ask for a redundant approval.

The detailed interview procedures are bundled under `upstream/` as private
Arforge resources.
