# Database Migration Runbook

Arforge uses one Alembic revision chain against two physical databases. The `main` target owns memory, learning and token tables. The `multiagent` target owns task and conversation tables. Each database records its own revision in `alembic_version`.

## New installation

1. Configure `ARFORGE_DB_URL` and `ARFORGE_MULTIAGENT_DB_URL` with separate non-root database users.
2. Create and verify a backup if either target already contains data.
3. Preview SQL with `arforge db-sql main` and `arforge db-sql multiagent`.
4. Run `arforge db-migrate all` from an interactive terminal, or set explicit automation approval in a controlled deployment job.
5. Verify both targets with `arforge db-current main` and `arforge db-current multiagent`.

## Adopting an existing 0.7.0 database

Existing Alpha databases were created without an Alembic revision. Do not run the initial upgrade directly because the tables already exist.

1. Back up and verify both databases.
2. Run application/schema compatibility tests against a disposable restore.
3. Run `arforge db-stamp main` and `arforge db-stamp multiagent` independently.
4. Stamping is refused when a required table or column is missing and requires high-risk confirmation.
5. Confirm both report `0001_initial` before applying later revisions.

## Rollback

Schema downgrade is never a substitute for data recovery. Before `arforge db-downgrade`, verify a restorable backup and review the generated revision downgrade. The command requires high-risk confirmation.

Rollback triggers include migration errors, missing required columns, failed record reconciliation or an application startup regression. Stop writes, preserve logs, restore the last verified backup when data loss is possible, then roll the application back to the matching release.

## Validation evidence

For every release retain the before/after revision, offline SQL, backup identifier, row counts for every owned table, representative record checks and the operator/time that approved the migration.
