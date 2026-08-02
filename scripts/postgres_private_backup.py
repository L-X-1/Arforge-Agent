"""Create and verify one private PostgreSQL backup without exposing credentials."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.engine import make_url

from arforge.database.backup import create_backup, verify_backup


def _load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-env", type=Path, default=Path.home() / ".arforge" / ".env")
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / "ArforgeBackups" / "PostgreSQL",
    )
    parser.add_argument("--retention-days", type=int, default=30)
    parser.add_argument("--prune", action="store_true")
    parser.add_argument(
        "--database",
        choices=("main", "multiagent"),
        default="main",
        help="Select the main product database or the isolated multi-agent database.",
    )
    parser.add_argument(
        "--administrator",
        action="store_true",
        help="Use the temporary private administrator URL for a complete pre-migration dump.",
    )
    args = parser.parse_args()

    if args.retention_days < 1:
        parser.error("--retention-days must be at least 1")
    values = _load_env(args.private_env.expanduser().resolve())
    database_url = values.get("ARFORGE_DB_URL", "")
    if args.database == "multiagent":
        database_url = values.get("ARFORGE_MULTIAGENT_DB_URL", "")
        if not database_url:
            main = make_url(values.get("ARFORGE_DB_URL", ""))
            if main.drivername.split("+", 1)[0] != "postgresql" or not main.database:
                raise SystemExit("ARFORGE_DB_URL must identify a PostgreSQL database")
            database_url = main.set(database=f"{main.database}_ma").render_as_string(
                hide_password=False
            )
    url = make_url(database_url)
    if url.drivername.split("+", 1)[0] != "postgresql" or not url.database:
        raise SystemExit("ARFORGE_DB_URL must identify a PostgreSQL database")
    if args.administrator:
        admin = make_url(values.get("ARFORGE_DB_ADMIN_URL", ""))
        if admin.drivername.split("+", 1)[0] != "postgresql":
            raise SystemExit("ARFORGE_DB_ADMIN_URL must identify PostgreSQL")
        database_url = admin.set(database=url.database).render_as_string(hide_password=False)
        url = make_url(database_url)

    destination = args.destination.expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = destination / f"{url.database}-{timestamp}.dump"
    backup = create_backup(target, database_url, require_confirm=False)
    if not backup.success:
        raise SystemExit(f"backup failed: {backup.error}")
    verified = verify_backup(backup.path)
    if not verified.success:
        raise SystemExit(f"backup verification failed: {verified.error}")

    backup_path = Path(backup.path)
    manifest = {
        "schema_version": 1,
        "created_at": timestamp,
        "database": url.database,
        "backup": backup_path.name,
        "size_bytes": backup.size_bytes,
        "sha256": _sha256(backup_path),
        "catalog_verified": True,
    }
    manifest_path = backup_path.with_suffix(backup_path.suffix + ".json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pruned: list[str] = []
    if args.prune:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.retention_days)
        for candidate in sorted(destination.glob(f"{url.database}-*.dump")):
            if candidate == backup_path:
                continue
            modified = datetime.fromtimestamp(candidate.stat().st_mtime, tz=timezone.utc)
            if modified >= cutoff:
                continue
            candidate.unlink()
            candidate.with_suffix(candidate.suffix + ".json").unlink(missing_ok=True)
            pruned.append(candidate.name)

    print(
        json.dumps(
            {
                "database": url.database,
                "backup": str(backup_path),
                "manifest": str(manifest_path),
                "size_bytes": backup.size_bytes,
                "catalog_verified": True,
                "pruned": pruned,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
