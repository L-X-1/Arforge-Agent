# Packaged Desktop PostgreSQL recovery

If Desktop reports a missing or outdated PostgreSQL schema, close Arforge and run its installed executable with:

```powershell
& 'C:\path\to\Arforge.exe' --migrate-postgres
```

This explicit maintenance mode uses Electron's bundled utility runtime. It does not require Bun, a source checkout, or an OS installation. It does not start the application server, a workspace, WSL, Docker, or PostgreSQL. A running Arforge instance must be closed normally first; the command does not stop it.

Configure `ARFORGE_DB_ADMIN_URL` in the private Arforge environment file selected by `ARFORGE_ENV_FILE`, or the existing user `.arforge/.env` selection. Use the administrative role for the same intended PostgreSQL database. Do not put the URL in command arguments, source control, screenshots, or reports. The normal application's `ARFORGE_DB_URL` and role permissions stay unchanged; there is no application-URL fallback, privilege grant, or SQLite substitution.

The command asks for confirmation before applying the existing ordered migrations. PostgreSQL must already be reachable and the configured role must have the required administrative permissions. The existing transaction, advisory lock, and migration ledger coordinate the operation. Keep an appropriate backup before an administrative schema change.

A native dialog reports the resulting schema version and applied count, or a safe configuration/connection/permission failure. A second successful invocation against the current schema applies zero migrations. After success, start Arforge normally. Maintenance never restarts it automatically.

Cancel repair, or Quit, requests interruption and waits for the owned utility and its SQL scope to close. A bounded timeout escalates only that utility. If exit cannot be confirmed, Arforge withholds shutdown so it does not abandon a live owned process. Shared database and Docker services are never stopped. Cancellation close to commit can leave an already committed migration; inspect the schema or retry the idempotent command rather than assuming it rolled back.

Exit codes are `0` for a confirmed successful migration and utility exit, `1` for a safe failure, and `2` for cancellation. No credentials, raw SQL errors, or raw stacks are included in migration receipts, dialogs, or logs.
