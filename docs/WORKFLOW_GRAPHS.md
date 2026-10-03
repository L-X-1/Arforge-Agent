# Durable workflow graphs

Arforge uses a hybrid execution model:

- Graph orchestration selects eligible nodes, enforces dependencies and
  conditions, records state, and coordinates approval or recovery.
- The existing Agent Loop executes each `agent` node. Graph execution does not
  replace model configuration, reasoning effort, tools, or permission policy.

Definitions are data-only JSON files under `.arforge/workflows/`. Schema
version 1 remains compatible. Schema version 2 adds:

- `kind`: `agent`, `approval`, or `checkpoint`
- `access`: `read`, `write`, or `none`
- `max_attempts`: automatic retry limit from 1 to 5
- `when`: a safe terminal-status condition over a declared dependency

## Concurrency safety

Every graph run operates on one workspace. Arforge therefore applies a
reader/writer policy:

- independent `read` nodes may run in parallel up to `max_parallel`;
- read nodes are forced through Plan mode, regardless of the run's write
  permission;
- `write` nodes use an exclusive workspace lane and never run concurrently;
- approval and checkpoint nodes do not call the model.

This enables useful parallel inspection without introducing concurrent file
write races or reducing model reasoning settings.

## Lifecycle

Run, node and event state use the selected deployment database:

- PostgreSQL is the canonical product store when `ARFORGE_DB_URL` selects it.
  The tables are `workflow_graph_runs`, `workflow_graph_nodes`, and
  `workflow_graph_events`.
- Profile SQLite (`$ARFORGE_HOME/workflows/graph-runs.sqlite3`) is retained
  only for explicit local mode, isolated tests, and verified import of legacy
  state.
- A configured PostgreSQL failure never falls back to SQLite.

Each active run has a renewable owner lease. Desktop, CLI and Server processes
may observe or request control of the same run, but only the current lease
owner may schedule and settle nodes. Expired leases become resumable
`interrupted` runs; starting a still-leased run returns `RUN_BUSY`.

A run supports:

- pause and resume;
- cooperative cancellation after active node calls settle;
- explicit approval or rejection;
- automatic retry;
- retry from one failed node with optional downstream reset;
- restart recovery from an interrupted node;
- ordered, bounded audit events.

CLI examples:

```text
arforge workflows list
arforge workflows validate .arforge/workflows/engineering_delivery.json
arforge workflows run .arforge/workflows/engineering_delivery.json --report .arforge/reports/preview.json
arforge workflows run .arforge/workflows/engineering_delivery.json --execute --report .arforge/reports/run.json
arforge workflows runs
arforge workflows status <run-id>
arforge workflows approve <run-id> approval "Reviewed"
arforge workflows retry <run-id> verify
arforge workflows pause <run-id>
arforge workflows resume <run-id>
arforge workflows cancel <run-id>
```

`workflows run` is an argv-compatible spelling of the typed `workflow run`
owner. Without `--execute` it writes a deterministic preview report; with
`--execute` it starts the durable graph through the same HTTP/SDK operation and
waits for completion, pause, or approval. A relative `--report` path must stay
inside the selected workspace; if omitted, the report is stored under the
profile data directory. The command never invokes the retired Python workflow
executor or creates a second graph journal.

The desktop `工作流图` panel exposes the same Bridge methods, graph state,
approval controls, node retry, progress, dependencies, and audit events.

## PostgreSQL activation and legacy import

Schema changes are owned by TypeScript Core and require an administrative
connection. The `arforge_app` runtime role intentionally has no schema-create
permission.

The additive Workflow Graph migration currently carries a `.pending-admin`
marker because this private deployment has no `ARFORGE_DB_ADMIN_URL`. It is
excluded from the active runtime migration manifest so unrelated Desktop and
CLI functions remain usable. Workflow Graph itself fails closed in PostgreSQL
mode until an administrator activates the migration.

After providing `ARFORGE_DB_ADMIN_URL` in the private process environment:

1. Remove the reviewed `.pending-admin` marker.
2. Regenerate the embedded migration manifest:
   `bun --cwd packages/core run db:generate:postgres-schema`.
3. Apply it:
   `bun --cwd packages/core run db:migrate:postgres`.
4. Back up PostgreSQL and keep the legacy SQLite file unchanged.
5. Preflight the import:
   `.venv\Scripts\python.exe scripts\import_workflow_graph_sqlite.py`.
6. If active legacy runs are reported, stop their owner or explicitly add
   `--force-interrupt`; this converts them to resumable interrupted runs in the
   target without editing the source.
7. Apply:
   `.venv\Scripts\python.exe scripts\import_workflow_graph_sqlite.py --apply`.

The importer is one-way and transactional. It opens SQLite read-only, refuses a
different target record with the same run ID, is idempotent for identical
records, and re-reads every imported run to verify a SHA-256 fingerprint before
commit. It never deletes the source database.
