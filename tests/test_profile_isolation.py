"""Cross-module contracts for ARFORGE_HOME profile isolation."""

from __future__ import annotations

import json
import os
import subprocess
import sys


def test_runtime_state_uses_active_profile_even_after_import(monkeypatch, tmp_path):
    import arforge
    import arforge.i18n as i18n
    import arforge.logger as logger
    from arforge.security import backup_manager
    from arforge.tools import basic_tools, task_tools

    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))

    assert arforge.get_db_path() == str(profile / "memory.db")
    logger.write_log("info", "isolated-log")
    log_file = profile / "logs" / "arforge.log"
    assert log_file.is_file()
    record = json.loads(log_file.read_text(encoding="utf-8"))
    assert record["level"] == "INFO"
    assert record["message"] == "isolated-log"
    assert record["event_id"]
    assert "isolated-log" in basic_tools.show_logs()

    task = task_tools.create_task("isolated task")
    assert task["id"] == 1
    assert json.loads((profile / "tasks.json").read_text(encoding="utf-8"))[0][
        "title"
    ] == "isolated task"

    assert i18n.set_active_lang("en") == "en"
    assert (profile / ".arforge_lang").is_file()
    (profile / "trusted_workspaces.json").write_text(
        json.dumps({"workspaces": [str(tmp_path)]}),
        encoding="utf-8",
    )
    assert (profile / "trusted_workspaces.json").is_file()

    original = tmp_path / "document.txt"
    original.write_text("content", encoding="utf-8")
    backup = backup_manager.backup_file(original)
    assert backup is not None
    assert backup.is_relative_to(profile / "backups")


def test_import_does_not_create_profile(monkeypatch, tmp_path):
    profile = tmp_path / "not-created"
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    env = os.environ.copy()
    env["ARFORGE_HOME"] = str(profile)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import arforge, pathlib; print(pathlib.Path(arforge.get_db_path()).parent.exists())",
        ],
        cwd=workdir,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"
    assert not profile.exists()
