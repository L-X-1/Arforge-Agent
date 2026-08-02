"""PostgreSQL backup/restore safety tests."""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace


def test_database_args_keep_password_out_of_command():
    from arforge.database.backup import _database_args

    args, env = _database_args("postgresql://alice:super-secret@db.example:5433/arforge")
    assert "super-secret" not in " ".join(args)
    assert env["PGPASSWORD"] == "super-secret"
    assert args[-2:] == ["--username", "alice"]


def test_create_and_verify_backup_without_shell(monkeypatch, tmp_path):
    import arforge.database.backup as backup

    calls = []
    monkeypatch.setattr(backup, "_find_pg_tool", lambda name: f"/safe/{name}")

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        if "pg_dump" in command[0]:
            output = Path(command[command.index("--file") + 1])
            output.write_bytes(b"PGDMP-test")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=0, stdout="catalog entry", stderr="")

    monkeypatch.setattr(backup.subprocess, "run", fake_run)
    result = backup.create_backup(
        tmp_path / "snapshot.dump",
        "postgresql://alice:secret@localhost/arforge",
        require_confirm=False,
    )
    assert result.success
    assert backup.verify_backup(result.path).success
    assert all(kwargs["shell"] is False for _, kwargs in calls)


def test_restore_requires_explicit_confirmation(monkeypatch, tmp_path):
    import arforge.database.backup as backup
    import arforge.security.file_ops as file_ops

    source = tmp_path / "snapshot.dump"
    source.write_bytes(b"PGDMP-test")
    monkeypatch.setattr(backup, "verify_backup", lambda path: backup.BackupResult(True, str(source), size_bytes=source.stat().st_size))
    monkeypatch.setattr(file_ops.sys.stdin, "isatty", lambda: False)
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)

    result = backup.restore_backup(source, "postgresql://localhost/restore_target")
    assert not result.success
    assert result.error == "confirmation denied"


def test_verify_rejects_missing_backup(tmp_path):
    from arforge.database.backup import verify_backup

    result = verify_backup(tmp_path / "missing.dump")
    assert not result.success
    assert result.error == "backup file not found"


def test_pg_tool_can_be_discovered_from_configured_bin(monkeypatch, tmp_path):
    import arforge.database.backup as backup

    monkeypatch.setattr(backup.shutil, "which", lambda name: None)
    executable = tmp_path / ("pg_dump.exe" if os.name == "nt" else "pg_dump")
    executable.write_bytes(b"")
    monkeypatch.setenv("ARFORGE_PG_BIN", str(tmp_path))
    assert backup._find_pg_tool("pg_dump") == str(executable)
