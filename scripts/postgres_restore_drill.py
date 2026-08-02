"""Restore a private backup into a random disposable database and compare rows."""

from __future__ import annotations

import argparse
import json
import os
import secrets
from pathlib import Path

import psycopg2
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
from sqlalchemy.engine import make_url

from arforge.database.backup import restore_backup, verify_backup


TARGET_PREFIX = "arforge_restore_drill_"


def _endpoint(url) -> tuple[str, int]:
    host = (url.host or "").lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        host = "loopback"
    return host, url.port or 5432


def _load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def _autocommit(dsn: str):
    connection = psycopg2.connect(dsn)
    connection.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    return connection


def _counts(dsn: str) -> dict[str, int]:
    result: dict[str, int] = {}
    with psycopg2.connect(dsn) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                ORDER BY table_schema, table_name
                """
            )
            for schema_name, table_name in cursor.fetchall():
                cursor.execute(
                    sql.SQL("SELECT count(*) FROM {}.{}").format(
                        sql.Identifier(schema_name),
                        sql.Identifier(table_name),
                    )
                )
                result[f"{schema_name}.{table_name}"] = cursor.fetchone()[0]
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", type=Path)
    parser.add_argument("--private-env", type=Path, default=Path.home() / ".arforge" / ".env")
    parser.add_argument("--admin-url-env", default="ARFORGE_DB_ADMIN_URL")
    parser.add_argument(
        "--database",
        choices=("main", "multiagent"),
        default="main",
        help="Select which configured source database must match the restored backup.",
    )
    args = parser.parse_args()

    backup = args.backup.expanduser().resolve()
    verified = verify_backup(backup)
    if not verified.success:
        raise SystemExit(f"backup verification failed: {verified.error}")

    values = _load_env(args.private_env.expanduser().resolve())
    source_url = values.get("ARFORGE_DB_URL", "")
    if args.database == "multiagent":
        source_url = values.get("ARFORGE_MULTIAGENT_DB_URL", "")
        if not source_url:
            main = make_url(values.get("ARFORGE_DB_URL", ""))
            if main.drivername.split("+", 1)[0] != "postgresql" or not main.database:
                raise SystemExit("ARFORGE_DB_URL must identify a PostgreSQL database")
            source_url = main.set(database=f"{main.database}_ma").render_as_string(
                hide_password=False
            )
    source = make_url(source_url)
    admin_url = (
        os.getenv(args.admin_url_env, "").strip()
        or values.get(args.admin_url_env, "").strip()
    )
    admin = make_url(admin_url)
    if source.drivername.split("+", 1)[0] != "postgresql" or not source.database:
        raise SystemExit("ARFORGE_DB_URL must identify a PostgreSQL database")
    if admin.drivername.split("+", 1)[0] != "postgresql":
        raise SystemExit(f"{args.admin_url_env} must identify PostgreSQL")
    if _endpoint(source) != _endpoint(admin):
        raise SystemExit("source and administrative URLs must target the same PostgreSQL server")

    target_name = TARGET_PREFIX + secrets.token_hex(5)
    if not target_name.startswith(TARGET_PREFIX):
        raise SystemExit("invalid temporary database name")
    admin_dsn = admin.set(database=admin.database or "postgres").render_as_string(hide_password=False)
    target_dsn = admin.set(database=target_name).render_as_string(hide_password=False)
    created = False
    report: dict[str, object] | None = None

    try:
        connection = _autocommit(admin_dsn)
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target_name)))
        finally:
            connection.close()
        created = True

        restored = restore_backup(backup, target_dsn, require_confirm=False)
        if not restored.success:
            raise RuntimeError(f"restore failed: {restored.error}")

        source_counts = _counts(source_url)
        target_counts = _counts(target_dsn)
        differences = {
            key: {"source": source_counts.get(key), "restored": target_counts.get(key)}
            for key in sorted(set(source_counts) | set(target_counts))
            if source_counts.get(key) != target_counts.get(key)
        }
        report = {
            "source_database": source.database,
            "temporary_database_prefix_valid": target_name.startswith(TARGET_PREFIX),
            "backup": str(backup),
            "backup_catalog_verified": True,
            "restored_table_count": len(target_counts),
            "exact_row_count_match": not differences,
            "row_count_differences": differences,
        }
    finally:
        if created:
            connection = _autocommit(admin_dsn)
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT pg_terminate_backend(pid)
                        FROM pg_stat_activity
                        WHERE datname = %s AND pid <> pg_backend_pid()
                        """,
                        (target_name,),
                    )
                    cursor.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(target_name)))
            finally:
                connection.close()

    if report is None:
        raise RuntimeError("restore drill completed without an acceptance report")
    report["temporary_database_removed"] = True
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["exact_row_count_match"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
