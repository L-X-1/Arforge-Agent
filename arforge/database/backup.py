"""Verified PostgreSQL, SQLite, and local-profile backup/restore operations."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import zipfile

from sqlalchemy.engine import make_url

from arforge.database.sqlite_runtime import busy_timeout_ms, sqlite_connection


SQLITE_HEADER = b"SQLite format 3\x00"
PROFILE_BACKUP_VERSION = 1


@dataclass(frozen=True)
class BackupResult:
    success: bool
    path: str = ""
    error: str = ""
    size_bytes: int = 0


def _database_args(database_url: str) -> tuple[list[str], dict[str, str]]:
    url = make_url(database_url)
    if not url.drivername.startswith("postgresql"):
        raise ValueError("backup requires a PostgreSQL URL")
    if not url.database:
        raise ValueError("database name is required")
    args = ["--dbname", url.database]
    if url.host:
        args += ["--host", url.host]
    if url.port:
        args += ["--port", str(url.port)]
    if url.username:
        args += ["--username", url.username]
    env = os.environ.copy()
    if url.password:
        env["PGPASSWORD"] = url.password
    return args, env


def _sqlite_path(database_url: str) -> Path:
    url = make_url(database_url)
    if url.drivername.split("+", 1)[0] != "sqlite":
        raise ValueError("database URL is not SQLite")
    if not url.database or url.database == ":memory:":
        raise ValueError("SQLite backup requires a file-backed database")
    return Path(url.database).expanduser().resolve()


def _backup_sqlite_file(source: Path, target: Path) -> None:
    source = source.expanduser().resolve()
    target = target.expanduser().resolve()
    if source == target:
        raise ValueError("backup destination must differ from the source database")
    if not source.is_file():
        raise FileNotFoundError(f"SQLite database not found: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    with sqlite_connection(source, read_only=True, enable_wal=False) as source_db:
        destination = sqlite3.connect(
            target,
            timeout=busy_timeout_ms() / 1000,
        )
        try:
            source_db.backup(destination)
            result = destination.execute("PRAGMA integrity_check").fetchone()
            if result is None or result[0] != "ok":
                raise RuntimeError(
                    f"SQLite backup integrity check failed: {result[0] if result else 'empty'}"
                )
        finally:
            destination.close()


def _verify_sqlite_file(path: Path) -> BackupResult:
    try:
        with sqlite_connection(path, read_only=True, enable_wal=False) as connection:
            result = connection.execute("PRAGMA integrity_check").fetchone()
        if result is None or result[0] != "ok":
            return BackupResult(
                False,
                path=str(path),
                error=f"SQLite integrity check failed: {result[0] if result else 'empty'}",
                size_bytes=path.stat().st_size,
            )
        return BackupResult(True, path=str(path), size_bytes=path.stat().st_size)
    except Exception as exc:
        return BackupResult(
            False,
            path=str(path),
            error=str(exc),
            size_bytes=path.stat().st_size if path.exists() else 0,
        )


def check_backup_tools() -> dict[str, bool]:
    return {
        "pg_dump": bool(_find_pg_tool("pg_dump")),
        "pg_restore": bool(_find_pg_tool("pg_restore")),
        "sqlite_online_backup": True,
    }


def _find_pg_tool(name: str) -> str | None:
    executable = shutil.which(name)
    if executable:
        return executable
    configured = os.getenv("ARFORGE_PG_BIN", "").strip()
    suffix = f"{name}.exe" if os.name == "nt" else name
    if configured:
        candidate = os.path.join(os.path.expanduser(configured), suffix)
        if os.path.isfile(candidate):
            return candidate
    if os.name == "nt":
        root = Path(os.getenv("ProgramFiles", r"C:\Program Files")) / "PostgreSQL"
        if root.is_dir():
            versions = sorted(
                (item for item in root.iterdir() if item.is_dir()),
                key=lambda item: item.name,
                reverse=True,
            )
            for version in versions:
                candidate = version / "bin" / suffix
                if candidate.is_file():
                    return str(candidate)
    return None


def create_backup(
    destination: str | Path,
    database_url: str | None = None,
    *,
    require_confirm: bool = True,
) -> BackupResult:
    """Create one atomic backup using the backend's native safe mechanism."""
    from arforge.database.config import get_database_url
    from arforge.security.file_ops import request_confirmation

    selected_url = database_url or get_database_url()
    driver = make_url(selected_url).drivername.split("+", 1)[0]
    target = Path(destination).expanduser().resolve()
    if driver == "postgresql" and target.suffix.lower() not in {".dump", ".backup"}:
        target = target.with_suffix(".dump")
    elif driver == "sqlite" and not target.suffix:
        target = target.with_suffix(".db")
    if require_confirm and not request_confirmation(
        "medium",
        f"create database backup at {target}",
    ):
        return BackupResult(False, error="confirmation denied")

    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=".arforge-backup-",
        suffix=target.suffix or ".tmp",
        dir=target.parent,
    )
    os.close(fd)
    temporary = Path(temp_name)
    temporary.unlink(missing_ok=True)
    try:
        if driver == "sqlite":
            _backup_sqlite_file(_sqlite_path(selected_url), temporary)
        elif driver == "postgresql":
            executable = _find_pg_tool("pg_dump")
            if not executable:
                return BackupResult(False, error="pg_dump not found")
            db_args, env = _database_args(selected_url)
            completed = subprocess.run(
                [
                    executable,
                    "--format=custom",
                    "--no-owner",
                    "--no-privileges",
                    "--file",
                    str(temporary),
                    *db_args,
                ],
                capture_output=True,
                text=True,
                env=env,
                timeout=600,
                shell=False,
            )
            if completed.returncode != 0:
                return BackupResult(
                    False,
                    error=completed.stderr.strip() or "pg_dump failed",
                )
        else:
            return BackupResult(False, error=f"unsupported database driver: {driver}")
        os.replace(temporary, target)
        return BackupResult(True, path=str(target), size_bytes=target.stat().st_size)
    except Exception as exc:
        return BackupResult(False, error=str(exc))
    finally:
        temporary.unlink(missing_ok=True)


def verify_backup(source: str | Path) -> BackupResult:
    """Verify a SQLite image or PostgreSQL custom-format dump."""
    backup = Path(source).expanduser().resolve()
    if not backup.is_file():
        return BackupResult(False, error="backup file not found")
    try:
        header = _file_header(backup)
    except OSError as exc:
        return BackupResult(False, path=str(backup), error=str(exc))
    if header == SQLITE_HEADER:
        return _verify_sqlite_file(backup)

    executable = _find_pg_tool("pg_restore")
    if not executable:
        return BackupResult(
            False,
            path=str(backup),
            error="pg_restore not found",
            size_bytes=backup.stat().st_size,
        )
    try:
        completed = subprocess.run(
            [executable, "--list", str(backup)],
            capture_output=True,
            text=True,
            timeout=120,
            shell=False,
        )
        if completed.returncode != 0 or not completed.stdout.strip():
            return BackupResult(
                False,
                path=str(backup),
                error=completed.stderr.strip() or "backup catalog is empty",
                size_bytes=backup.stat().st_size,
            )
        return BackupResult(True, path=str(backup), size_bytes=backup.stat().st_size)
    except Exception as exc:
        return BackupResult(
            False,
            path=str(backup),
            error=str(exc),
            size_bytes=backup.stat().st_size,
        )


def restore_backup(
    source: str | Path,
    target_database_url: str,
    *,
    require_confirm: bool = True,
) -> BackupResult:
    """Restore a verified backup into an explicitly supplied target."""
    from arforge.security.file_ops import request_confirmation

    verified = verify_backup(source)
    if not verified.success:
        return verified
    if require_confirm and not request_confirmation(
        "high",
        "restore backup into the explicitly configured target database",
    ):
        return BackupResult(
            False,
            path=verified.path,
            error="confirmation denied",
            size_bytes=verified.size_bytes,
        )

    target_url = make_url(target_database_url)
    driver = target_url.drivername.split("+", 1)[0]
    source_path = Path(verified.path)
    is_sqlite_backup = _file_header(source_path) == SQLITE_HEADER
    if driver == "sqlite":
        if not is_sqlite_backup:
            return BackupResult(
                False,
                path=verified.path,
                error="cannot restore a PostgreSQL dump into SQLite",
                size_bytes=verified.size_bytes,
            )
        try:
            target = _sqlite_path(target_database_url)
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                prefix=".arforge-restore-",
                suffix=".db",
                dir=target.parent,
            )
            os.close(fd)
            temporary = Path(temp_name)
            temporary.unlink(missing_ok=True)
            try:
                _backup_sqlite_file(source_path, temporary)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            return BackupResult(
                True,
                path=str(target),
                size_bytes=target.stat().st_size,
            )
        except Exception as exc:
            return BackupResult(
                False,
                path=verified.path,
                error=str(exc),
                size_bytes=verified.size_bytes,
            )

    if driver != "postgresql":
        return BackupResult(
            False,
            path=verified.path,
            error=f"unsupported database driver: {driver}",
            size_bytes=verified.size_bytes,
        )
    if is_sqlite_backup:
        return BackupResult(
            False,
            path=verified.path,
            error="cannot restore a SQLite backup into PostgreSQL",
            size_bytes=verified.size_bytes,
        )

    executable = _find_pg_tool("pg_restore")
    if not executable:
        return BackupResult(
            False,
            path=verified.path,
            error="pg_restore not found",
            size_bytes=verified.size_bytes,
        )
    try:
        db_args, env = _database_args(target_database_url)
        completed = subprocess.run(
            [
                executable,
                "--clean",
                "--if-exists",
                "--no-owner",
                "--no-privileges",
                *db_args,
                verified.path,
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=600,
            shell=False,
        )
        if completed.returncode != 0:
            return BackupResult(
                False,
                path=verified.path,
                error=completed.stderr.strip() or "pg_restore failed",
                size_bytes=verified.size_bytes,
            )
        return verified
    except Exception as exc:
        return BackupResult(
            False,
            path=verified.path,
            error=str(exc),
            size_bytes=verified.size_bytes,
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_header(path: Path) -> bytes:
    with path.open("rb") as stream:
        return stream.read(len(SQLITE_HEADER))


def _profile_database_paths(profile: Path) -> list[Path]:
    candidates = [profile / "learning.db", profile / "multiagent.db"]
    state = profile / "state"
    if state.is_dir():
        candidates.extend(sorted(state.glob("*.db")))
    return [path.resolve() for path in candidates if path.is_file()]


def create_profile_backup(
    destination: str | Path,
    profile: str | Path | None = None,
    *,
    require_confirm: bool = True,
) -> BackupResult:
    """Create one verified archive containing every local profile SQLite store."""
    from arforge.paths import get_arforge_home
    from arforge.security.file_ops import request_confirmation

    root = Path(profile).expanduser().resolve() if profile else get_arforge_home()
    target = Path(destination).expanduser().resolve()
    if target.suffix.casefold() != ".zip":
        target = target.with_suffix(".zip")
    if require_confirm and not request_confirmation(
        "medium",
        f"create local profile backup at {target}",
    ):
        return BackupResult(False, error="confirmation denied")
    databases = _profile_database_paths(root)
    if not databases:
        return BackupResult(False, error="profile contains no SQLite databases")

    from arforge.database.sqlite_runtime import ProfileLockError, ProfileWriterLock

    profile_lock = ProfileWriterLock(root / "state" / "sidecar.lock")
    try:
        profile_lock.acquire()
    except ProfileLockError as exc:
        return BackupResult(False, error=str(exc))
    archive: Path | None = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_archive = tempfile.mkstemp(
            prefix=".arforge-profile-",
            suffix=".zip",
            dir=target.parent,
        )
        os.close(fd)
        archive = Path(temp_archive)
        with tempfile.TemporaryDirectory(prefix="arforge-profile-snapshot-") as staging:
            staging_root = Path(staging)
            entries = []
            for source in databases:
                relative = source.relative_to(root)
                snapshot = staging_root / relative
                _backup_sqlite_file(source, snapshot)
                entries.append(
                    {
                        "path": relative.as_posix(),
                        "size_bytes": snapshot.stat().st_size,
                        "sha256": _sha256(snapshot),
                    }
                )
            manifest = {
                "format": "arforge.sqlite-profile",
                "version": PROFILE_BACKUP_VERSION,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "entries": entries,
            }
            with zipfile.ZipFile(
                archive,
                "w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=6,
            ) as bundle:
                bundle.writestr(
                    "manifest.json",
                    json.dumps(manifest, ensure_ascii=False, indent=2),
                )
                for entry in entries:
                    bundle.write(
                        staging_root / entry["path"],
                        f"databases/{entry['path']}",
                    )
        verified = verify_profile_backup(archive)
        if not verified.success:
            return verified
        os.replace(archive, target)
        return BackupResult(True, path=str(target), size_bytes=target.stat().st_size)
    except Exception as exc:
        return BackupResult(False, error=str(exc))
    finally:
        if archive is not None:
            archive.unlink(missing_ok=True)
        profile_lock.release()


def _safe_archive_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe profile backup path: {value}")
    return path


def verify_profile_backup(source: str | Path) -> BackupResult:
    """Verify archive structure, checksums, and each SQLite database image."""
    archive = Path(source).expanduser().resolve()
    if not archive.is_file():
        return BackupResult(False, error="backup file not found")
    try:
        with tempfile.TemporaryDirectory(prefix="arforge-profile-verify-") as staging:
            root = Path(staging)
            with zipfile.ZipFile(archive, "r") as bundle:
                manifest = json.loads(bundle.read("manifest.json"))
                if (
                    manifest.get("format") != "arforge.sqlite-profile"
                    or manifest.get("version") != PROFILE_BACKUP_VERSION
                    or not isinstance(manifest.get("entries"), list)
                ):
                    raise ValueError("unsupported profile backup manifest")
                for entry in manifest["entries"]:
                    relative = _safe_archive_path(str(entry["path"]))
                    member = f"databases/{relative.as_posix()}"
                    target = root.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(member) as source_stream, target.open("wb") as target_stream:
                        shutil.copyfileobj(source_stream, target_stream)
                    if target.stat().st_size != int(entry["size_bytes"]):
                        raise ValueError(f"size mismatch for {relative.as_posix()}")
                    if _sha256(target) != entry["sha256"]:
                        raise ValueError(f"checksum mismatch for {relative.as_posix()}")
                    verified = _verify_sqlite_file(target)
                    if not verified.success:
                        raise ValueError(verified.error)
        return BackupResult(
            True,
            path=str(archive),
            size_bytes=archive.stat().st_size,
        )
    except Exception as exc:
        return BackupResult(
            False,
            path=str(archive),
            error=str(exc),
            size_bytes=archive.stat().st_size if archive.exists() else 0,
        )


def restore_profile_backup(
    source: str | Path,
    target_profile: str | Path,
    *,
    require_confirm: bool = True,
) -> BackupResult:
    """Restore a verified profile archive with rollback on replacement failure."""
    from arforge.security.file_ops import request_confirmation

    verified = verify_profile_backup(source)
    if not verified.success:
        return verified
    if require_confirm and not request_confirmation(
        "high",
        "replace local Arforge profile databases from the verified backup",
    ):
        return BackupResult(False, error="confirmation denied")

    archive = Path(source).expanduser().resolve()
    profile = Path(target_profile).expanduser().resolve()
    profile.mkdir(parents=True, exist_ok=True)
    from arforge.database.sqlite_runtime import ProfileLockError, ProfileWriterLock

    profile_lock = ProfileWriterLock(profile / "state" / "sidecar.lock")
    try:
        profile_lock.acquire()
    except ProfileLockError as exc:
        return BackupResult(False, path=str(profile), error=str(exc))
    replaced: list[tuple[Path, Path | None]] = []
    staging_root: Path | None = None
    try:
        staging_root = Path(
            tempfile.mkdtemp(
                prefix="arforge-profile-restore-",
                dir=profile.parent,
            )
        )
        rollback = staging_root / "rollback"
        with zipfile.ZipFile(archive, "r") as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            for entry in manifest["entries"]:
                relative = _safe_archive_path(str(entry["path"]))
                staged = (staging_root / "databases").joinpath(*relative.parts)
                staged.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(
                    f"databases/{relative.as_posix()}"
                ) as source_stream, staged.open("wb") as target_stream:
                    shutil.copyfileobj(source_stream, target_stream)
                target = profile.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                previous = None
                if target.exists():
                    previous = rollback.joinpath(*relative.parts)
                    previous.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, previous)
                os.replace(staged, target)
                replaced.append((target, previous))
        return BackupResult(True, path=str(profile), size_bytes=verified.size_bytes)
    except Exception as exc:
        for target, previous in reversed(replaced):
            try:
                if previous is None:
                    target.unlink(missing_ok=True)
                elif previous.exists():
                    os.replace(previous, target)
            except OSError:
                pass
        return BackupResult(False, path=str(profile), error=str(exc))
    finally:
        if staging_root is not None:
            shutil.rmtree(staging_root, ignore_errors=True)
        profile_lock.release()
