"""Structured, append-only and redacted product logging contracts."""

from __future__ import annotations

import json


def test_logger_writes_redacted_json_lines(monkeypatch, tmp_path):
    from arforge.logger import write_log

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    write_log(
        "error",
        "postgresql://alice:plain-password@db/arforge",
        context={"authorization": "Bearer raw-token", "attempt": 2},
        event_id="evt-test",
    )
    write_log("info", "next")

    lines = (tmp_path / "logs" / "arforge.log").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["event_id"] == "evt-test"
    assert first["level"] == "ERROR"
    assert first["context"] == {"authorization": "[REDACTED]", "attempt": 2}
    assert "plain-password" not in lines[0]
    assert "raw-token" not in lines[0]
