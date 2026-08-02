# Context compression and memory tiers

Arforge separates context management into three layers so reducing a prompt does
not silently turn temporary execution state into permanent behavior.

## 1. Recent verbatim context

- All system messages and the first user objective remain verbatim.
- The newest six or more messages remain verbatim.
- An assistant tool call and its following tool responses are an indivisible
  round and are never split at a compaction boundary.
- The desktop session store retains the clean user/assistant transcript for
  recovery. The live agent retains the compacted checkpoint for subsequent
  turns in the current process.

## 2. Short-term structured facts

The compacted middle becomes `【关键事实】` plus `【历史摘要】`. Structured facts
are deterministic and are copied forward before every later compaction:

- hard user constraints;
- architecture/technical decisions;
- user preferences and workspace identities;
- ports, timeouts, versions and other explicit configuration;
- pending work;
- changed files;
- terminal test/check results;
- stable error fingerprints.

Pending work, changed files, test results and errors stay short-term because
persisting them across unrelated future sessions would create stale state. When
the checkpoint is bounded, safety constraints and durable project facts take
priority over routine TODOs. If the protected checkpoint plus summary cannot
reduce a large prompt, Arforge retains the original history.

## 3. Workspace-scoped long-term memory

Only facts expected to remain useful after the current run are stored in the
long-term database:

- explicit architecture/project decisions (`convention`);
- stable user/workspace preferences (`preference`);
- workspace identity/contact facts (`identity`);
- explicit runtime/project configuration (`convention`);
- constraints containing durable signals such as “from now on”, “always”,
  “以后” or “始终” (`constraint`).

These rows use source `compaction`, are deduplicated, sanitized before storage,
and carry a stable workspace id plus canonical workspace path. Scoped recall
rebuilds its local search index from the active workspace on each query, so a
new process can recall persisted facts without leaking automatic memories from
another project. Recalled data is serialized as bounded JSONL inside an
untrusted-data wrapper and is never treated as executable instructions.

## Trigger and failure behavior

Automatic compaction starts when estimated prompt usage exceeds:

`(model context window - reserved output tokens) * ARFORGE_COMPACT_THRESHOLD`

The default threshold is `0.85`. Automatic compactions are separated by at
least ten agent steps to preserve provider prompt-cache prefixes. A forced
compaction bypasses the interval. A missing adapter, summarizer exception,
empty/failure summary, broken protected-fact checkpoint, or non-reducing large
result causes a no-op: the original messages remain authoritative.

The last compaction telemetry reports before/after tokens, summarized messages,
protected-fact coverage, dropped low-priority facts, short-term fact count,
long-term candidates and long-term memories stored. The desktop context tooltip
shows the short/long allocation after a completed compaction.
