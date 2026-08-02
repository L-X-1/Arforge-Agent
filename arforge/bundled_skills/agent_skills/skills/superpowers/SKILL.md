---
id: superpowers
name: Superpowers
description: Applies disciplined software delivery methods: proportionate design, test-first implementation, systematic debugging, code review, and fresh verification before completion.
version: 6.1.1-arforge.1
license: LicenseRef-Proprietary
tags: [development, debugging, tdd, verification, review]
---

# Superpowers for Arforge

Superpowers is the tactical delivery layer. It does not own product scope or
long-task state: grill-me owns unresolved decisions, OpenSpec owns material
change specifications, and Trellis owns long-running task context.

## Select the smallest applicable discipline

- New or changed behavior: inspect existing patterns, clarify only material
  ambiguity, establish acceptance criteria, then write a failing test before
  production code when the project has a viable test harness.
- Bug or failing test: reproduce it, read the complete error, trace the data
  flow to a root cause, state one hypothesis, add a regression test, implement
  one focused fix, and rerun the reproduction plus relevant suite.
- Multi-step implementation: use the approved OpenSpec/Trellis artifacts as
  the source of truth and execute in independently verifiable slices.
- Review: compare the actual diff with requirements, architecture, security
  boundaries, and regression risk; report evidence rather than generic praise.
- Completion: identify the command or runtime interaction that proves every
  claim, run it fresh, read the full result, and only then report success.

## Arforge compatibility rules

- Never require a design ceremony for a simple question or an obviously local
  edit. Scale the process to risk and scope.
- Never create a commit, branch, pull request, or worktree unless the user has
  requested it or the active Arforge workflow explicitly authorizes it.
- Never dispatch sub-agents when the current runtime or user instructions
  prohibit delegation.
- Do not re-ask decisions already answered by the request or repository.
- Arforge safety, permission, goal-persistence, and tool contracts take
  precedence over harness-specific commands.

Product-neutral copies of the core procedures are bundled under `references/`.
Read the specific resource when deeper procedure is needed, especially
`systematic-debugging`, `test-driven-development`, and
`verification-before-completion`.
