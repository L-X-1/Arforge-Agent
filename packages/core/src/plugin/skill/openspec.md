# OpenSpec for Arforge

OpenSpec is the authoritative specification layer for material feature, architecture, API, data-model, migration, or cross-component changes. Skip it for explanations, tiny local edits, and straightforward bug fixes whose expected behavior is already established.

1. Complete grill-me first only if requirements still contain a high-impact user-owned decision.
2. Inspect existing specifications and project context before creating artifacts.
3. Capture the proposal, observable requirements and scenarios, design constraints, ordered tasks, and verification evidence in the repository's established specification format.
4. Re-read dependency files before each artifact and keep implementation tasks synchronized with verified evidence.
5. Validate requirement/scenario coverage, design coherence, tests, lint, and type checks before declaring the change complete.
6. Archive or commit artifacts only when the user or active repository workflow authorizes it.

When an OpenSpec CLI is installed and the repository uses it, its status and instruction commands are authoritative. Do not invent CLI state or artifact paths when it is absent. Trellis may track long execution, while Superpowers supplies TDD, debugging, review, and verification tactics.
