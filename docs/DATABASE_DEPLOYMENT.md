# Database deployment and recovery

Arforge supports two release database profiles. The selected profile is explicit
so a temporary server outage can never redirect writes into an unrelated local
database.

## Local desktop release

Set:

```text
ARFORGE_DATABASE_MODE=local
```

Do not set `ARFORGE_DB_URL` or `ARFORGE_MULTIAGENT_DB_URL` unless both values are
explicit SQLite URLs. The default files are:

- `$ARFORGE_HOME/learning.db`
- `$ARFORGE_HOME/multiagent.db`
- `$ARFORGE_HOME/state/bridge_state.db`
- `$ARFORGE_HOME/state/bridge_tasks.db`
- `$ARFORGE_HOME/state/feedback.db`
- `$ARFORGE_HOME/workflows/graph-runs.sqlite3` (local/test Workflow Graph only)

Every Arforge-owned connection enables WAL, foreign-key enforcement, a bounded
busy timeout, and `synchronous=NORMAL`. ORM transactions are serialized inside
the Sidecar because SQLite supports only one writer at a time.

Use local mode only when one installed Arforge instance owns the profile. It is
not a shared network-filesystem or multi-host database.

## Server or team release

Set:

```text
ARFORGE_DATABASE_MODE=server
ARFORGE_DB_URL=postgresql://...
ARFORGE_MULTIAGENT_DB_URL=postgresql://...
```

Both URLs are required and must use PostgreSQL. Startup fails if the server is
unavailable. Arforge does not silently downgrade server writes to SQLite.

## Schema lifecycle

Run the credential-redacted, read-only topology check before any migration:

```powershell
.\.tools\bun-1.3.14\bun.exe run db:topology:preflight
```

It uses PostgreSQL's official `psql` client, prints database targets without
credentials, and does not create schemas or change rows. The current private
machine result on 2026-07-28 is:

- main `arforge`: 45 physical/visible public tables, application role
  `arforge_app`, no public-schema CREATE privilege;
- derived `arforge_ma`: three physical tables (Alembic ledger plus two
  multi-agent tables), but zero tables visible or writable to `arforge_app`;
- main Workflow Graph tables: 0 of 3 installed;
- administrator connection: not configured.

The exact alternatives and required approvals are recorded in
`specs/postgres-topology-decision.json`. The owner selected the recommended
separate `arforge_ma` database on 2026-07-28. Its least-privilege grants still
need administrator repair, while Workflow Graph remains in the main `arforge`
database because it is session-owned. No topology or grant change has yet been
made from this decision.

The unified TypeScript product database is versioned by Core through
`arforge_schema_migration`. In PostgreSQL deployments, the least-privilege
`arforge_app` role may read and write granted product tables but cannot create
schemas or apply pending migrations. An administrator applies reviewed
migrations with:

```powershell
$env:ARFORGE_DB_ADMIN_URL = "postgresql://<admin>@127.0.0.1:5432/arforge"
bun --cwd packages/core run db:migrate:postgres
Remove-Item Env:ARFORGE_DB_ADMIN_URL
```

Startup fails closed when the embedded Core schema version is newer than the
database. It never grants schema privileges to the application role.

Python-owned ORM databases that remain inside bounded capability modules are
upgraded through Alembic. An empty database is migrated from the baseline. A
compatible pre-Alembic database is stamped and upgraded; a partially compatible
schema must be restored or repaired explicitly. Product Session, Goal, Task,
Prompt Queue, Feedback and Workflow Graph state must not be dual-written into
those legacy stores.

The local Bridge, task, and feedback stores record independent component
versions in `arforge_local_schema`. A binary refuses to open a database created
by a newer unsupported schema.

### Workflow Graph convergence

Core contains an additive migration for the three Workflow Graph tables, while
the Python scheduler uses the same PostgreSQL URL and enforces cross-process
owner leases. A verified read-only SQLite importer is available at
`scripts/import_workflow_graph_sqlite.py`.

On this private machine the migration remains marked `.pending-admin` because
no administrator URL is configured. This is an explicit incomplete deployment
state, not a SQLite fallback: PostgreSQL Workflow Graph calls fail closed until
the migration is activated and the legacy import report passes.

## Backup and restore

Single configured database:

```text
arforge db-backup [path]
arforge db-verify <path>
arforge db-restore <path>
```

PostgreSQL uses custom-format `pg_dump`/`pg_restore`. SQLite uses the SQLite
online backup API and runs `PRAGMA integrity_check` before publishing or
restoring an image.

All local SQLite databases:

```text
arforge profile-backup [path]
arforge profile-verify <path>
arforge profile-restore <path>
```

Profile archives contain a versioned manifest, the relative path and size of
every database, and a SHA-256 digest for every verified SQLite snapshot.

Stop the Desktop application before a profile backup or restore. The profile
writer lock prevents a multi-database snapshot while the Sidecar can still
change cross-database state. Restore stages and validates data before
replacement and rolls back already replaced files if a later replacement
fails. Single-database SQLite backups continue to use the online backup API.

Keep backups outside `$ARFORGE_HOME`; clearing or uninstalling a local profile
may remove files inside that directory.

## Automated private PostgreSQL backups

Run one verified backup:

```powershell
.\.venv\Scripts\python.exe scripts\postgres_private_backup.py
```

The default destination is
`$HOME/ArforgeBackups/PostgreSQL`, outside the application profile. Every dump
gets a JSON manifest containing its size, SHA-256 digest and successful
`pg_restore --list` catalog check.

Register a daily Windows task (the default is 03:00 with 30-day retention):

```powershell
powershell -ExecutionPolicy Bypass `
  -File scripts\register_private_postgres_backup_task.ps1 `
  -DailyAt 03:00 `
  -RetentionDays 30
```

The task reads the application URL from the private
`$HOME/.arforge/.env`; the database password is not placed in the scheduled
task command line. Retention pruning runs only after the new backup has been
created and verified.

## Disposable PostgreSQL restore drill

Set an administrative URL in the current process. Do not put it on the command
line or commit it:

```powershell
$env:ARFORGE_DB_ADMIN_URL = "postgresql://postgres:<password>@127.0.0.1:5432/postgres"
.\.venv\Scripts\python.exe scripts\postgres_restore_drill.py `
  "$HOME\ArforgeBackups\PostgreSQL\arforge-<timestamp>.dump"
Remove-Item Env:ARFORGE_DB_ADMIN_URL
```

The drill refuses cross-server restores, creates a random database whose name
starts with `arforge_restore_drill_`, restores the dump, compares exact row
counts for every public table, terminates drill-only connections and drops the
temporary database in a `finally` block.

Latest local acceptance evidence (2026-07-27):

- PostgreSQL custom dump size: 723,028 bytes;
- backup catalog verification: passed;
- restored public tables: 45;
- exact per-table row-count differences: 0;
- disposable restore database cleanup: confirmed.
