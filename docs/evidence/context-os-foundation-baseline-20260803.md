# Context OS foundation baseline — 2026-08-03

## Existing capability

- `core/context.py` resolves model windows, estimates tokens, normalizes provider
  usage and produces the desktop context meter.
- `core/compaction.py` preserves system/first objective/recent tool rounds,
  extracts deterministic facts and produces a replaceable LLM summary.
- `product/session_runtime.py` keeps the visible transcript durable while
  persisting a compacted live-context checkpoint for resume.
- `core/structured_checkpoint.py` stores verified Cognitive Runtime state and
  bounded messages independently of the legacy session checkpoint.
- Memory OS provides active-only scoped recall and untrusted memory rendering.

## Convergence gaps

1. There is no typed context package or manifest describing why each source was
   included/dropped, its trust class, token cost, or provenance.
2. Token allocation is implicit in compaction boundaries; system, objective,
   evidence, memory, checkpoint and recent-history layers have no common budget
   contract.
3. Several old context-builder modules overlap but are not authoritative;
   `ArforgeAgent.prepare_context_messages` is the practical model-call boundary.
4. A compacted checkpoint is persisted, but there is no digest-verified package
   that can be deterministically recompiled for a different model window.
5. Protected-fact quality is measured only during compaction, not for the final
   provider-bound message package.
6. Prompt trust labels are rendered in text but are not represented in a
   machine-auditable manifest.

## Baseline verification

Command: all context/compaction/checkpoint tests plus bridge-session, manual
compaction, archive/import, export, rewind and memory-hook suites.

Result: `147 passed in 17.98s` across 18 test files.

The implementation must retain these behaviors and converge through the live
model-call/session boundaries rather than create a disconnected builder.
