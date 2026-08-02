# Superpowers for Arforge

Superpowers is the tactical delivery layer. It does not own product scope or long-task state: grill-me owns unresolved decisions, OpenSpec owns material-change specifications, and Trellis owns long-running task context.

- New or changed behavior: inspect existing patterns, clarify only material ambiguity, establish acceptance criteria, then write a failing test before production code when the project has a viable test harness.
- Bug or failing test: reproduce it, read the complete error, trace the data flow to a root cause, state one hypothesis, add a regression test, implement one focused fix, and rerun the reproduction plus relevant suite.
- Multi-step implementation: use approved specification and task artifacts as the source of truth and execute independently verifiable slices.
- Review: compare the actual diff with requirements, architecture, security boundaries, and regression risk; report evidence rather than generic praise.
- Completion: identify the command or runtime interaction that proves every claim, run it fresh, read the full result, and only then report success.

Scale process to risk and scope. Never create a commit, branch, pull request, worktree, or sub-agent unless authorized. Do not re-ask decisions already answered by the request or repository. Arforge safety, permission, goal-persistence, and tool contracts take precedence.
