# Trellis for Arforge

Trellis is the long-task execution backbone. Use it when work spans several dependent steps, multiple packages or layers, repeated sessions, or a delivery that benefits from durable requirements, design, implementation, checks, and resume context. Do not create this overhead for a simple answer or local one-step edit.

1. Read existing task context and specification indexes before editing. Resolve repository facts with tools; ask only unresolved user-owned decisions.
2. Keep requirements and acceptance criteria durable; for complex work, keep architecture, ordered implementation, and validation evidence separately readable.
3. Execute in checkpoints that each end with concrete validation. Update task state as evidence changes and retain enough context for resume.
4. Run applicable lint, type-checks, tests, cross-layer flow review, and specification compliance checks.
5. Finish only when the original goal and every acceptance criterion have fresh evidence.

OpenSpec artifacts are the authority for material behavior. Trellis references them rather than duplicating them. Superpowers supplies delivery methods inside each checkpoint. Use an installed Trellis CLI only when the repository already adopts it; never claim external CLI state without verifying it. Arforge goal persistence remains the durable runtime source of truth.
