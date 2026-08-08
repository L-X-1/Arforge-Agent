# Context OS foundation

Status: implemented foundation  
Change authority: `openspec/changes/context-os-foundation/`

## 1. Purpose

Context OS is the final, model-aware provider-input boundary. It turns retained
sources into an immutable Context Package with a verified digest, explicit
budget, source manifest, trust labels, omissions and protected-fact coverage.

A package is derived state. It never replaces:

- the durable user-visible session transcript;
- the Cognitive Runtime event journal or Agent IR projection;
- structured checkpoints;
- governed Memory OS records.

This distinction is the practical meaning of “do not lose context”: finite
provider windows use a bounded projection, while authoritative sources remain
recoverable and can be recompiled.

## 2. Authoritative boundary and convergence

| Component | Responsibility |
|---|---|
| `arforge/core/context_os.py` | Typed units, package integrity, deterministic allocation, source adapters |
| `arforge/core/context.py` | Model-window resolution, token estimates and package-aware meter |
| `arforge/core/compaction.py` | Optional bounded summary and protected-fact extraction before final compilation |
| `ArforgeAgent.prepare_context_messages` | One live provider-call integration boundary |
| `product/session_runtime.py` | Durable transcript, bounded checkpoint, package telemetry and recovery binding |
| `session.context.package` | Read-only inspection of the current live verified package |

The older `context_builder*`, `context_v2`, `coding_context`, `context_ranker`
and `context_enhancer` modules are compatibility/source-fragment helpers. They
do not authorize or finalize provider input. New provider paths must go through
Context OS rather than adding another builder.

## 3. Context Unit

Each unit contains:

- stable unit ID and source order;
- one or more atomic provider messages;
- layer and trust class;
- bounded identifier-only provenance;
- mandatory flag, priority and recency;
- token estimate and canonical source digest;
- normalized protected facts, when applicable.

Supported layers, in allocation order, are `authority`, `current_request`,
`protected_checkpoint`, `cognitive_state`, `recent_history`,
`recalled_memory`, `derived_summary`, and `optional_context`.

Trust classes distinguish runtime/user/policy authority from untrusted memory,
tools, imports and model-derived content. A legacy system message containing an
embedded memory block is conservatively marked derived; the live Agent path
extracts measured Memory OS recall into a separate `untrusted_memory` unit.

Assistant tool calls and their following tool results form one unit. A budget
boundary therefore includes or omits the whole round and can never emit an
orphan tool result.

## 4. Context Package and deterministic allocation

The package includes version, model, usable/used input tokens, final messages,
manifest, omissions, protected-fact counts/coverage and a canonical SHA-256
digest. Serialization round-trips without a model call. Any message, manifest,
budget, omission or metric change invalidates the digest.

Compilation proceeds as follows:

1. validate and deep-copy all units;
2. reserve the complete cost of mandatory units;
3. fail closed if mandatory authority/current request cannot fit;
4. rank optional units by layer, explicit priority, recency and stable order;
5. include whole units while budget remains;
6. record every omitted unit as `budget_exceeded`;
7. restore selected units to source order;
8. evaluate normalized protected facts against final provider content;
9. create and verify the package digest.

Compilation never mutates a transcript, checkpoint, Agent IR object or recall
report. Given identical units/model/budget it produces an identical package.

## 5. Source adapters and trust

- Provider-style messages become ordered units; system authority and current
  request are mandatory, first objective/protected checkpoint facts survive,
  historical summaries are derived, imports and tools remain untrusted.
- Learning System and Governed Evolution system-positioned blocks are optional
  `untrusted_derived` units. Provider role does not turn learned or canary
  advice into authority.
- Memory OS recall is rendered through the existing escaped `<memory_data>`
  boundary. Provenance contains only retrieval identity, never memory content
  or a plaintext workspace path.
- Agent IR is validated first and rendered as a bounded derived-data JSON block;
  provenance references task and verified journal position without raw tool
  output.
- Structured checkpoints validate their digest, then produce units bound to
  checkpoint digest, event sequence and task ID.

Untrusted content can inform reasoning but cannot grant permissions, relax
policy, become evidence by assertion, or override higher-authority units.

## 6. Session recovery and model switching

The desktop session store retains the complete visible transcript separately
from the compacted live checkpoint. Context status persists bounded package
telemetry plus a canonical digest of the checkpoint messages.

On resume:

1. hash the retained checkpoint;
2. compare it with the package-message binding;
3. mark matching telemetry `verified_checkpoint`;
4. discard mismatched package fields and mark `rebuild_pending_stale`;
5. mark missing legacy telemetry `rebuild_pending_missing`;
6. compile a fresh package before the next provider call and report
   `recompiled_checkpoint`.

An active model/window change always runs compilation again. The new package
records its own model, usable budget and digest and reports
`recompiled_model_switch`; source messages remain unchanged.

Inactive sessions preserve the last bounded package telemetry until resume.
They do not claim that a live package is available.

## 7. Product inspection

Protocol 1.2 exposes:

```text
session.context.package {session_id}
```

For an active compiled agent it returns the complete verified package and
telemetry. For inactive/uncompiled sessions it returns `available: false` with
bounded persisted telemetry. The method is read-only.

## 8. Operational recovery and rollback

When package integrity fails, preserve transcript/journal/memory sources,
discard the package, and recompile. Never repair a digest or manifest by hand.
When mandatory context exceeds the model budget, choose a larger model window
or reduce authoritative input explicitly; Context OS will not silently truncate
it.

Rollback can disable the `prepare_context_messages` compiler integration while
leaving transcripts, checkpoints, Memory OS and Cognitive Runtime intact.
Context Package introduces no database migration; its persisted state is
bounded telemetry in the existing session context-status JSON.

## 9. Current limits

Token counts use the existing conservative estimator until provider-specific
tokenizers are introduced. Digest chaining proves integrity, not author
identity. The foundation does not yet optimize cross-provider prompt-cache
layout or learn allocation policy autonomously; those belong to Capability
Amplifier and governed Evolution Engine work.
