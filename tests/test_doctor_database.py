from __future__ import annotations

from types import SimpleNamespace

from arforge.product.doctor import _check_database_config


class _Connection:
    def close(self) -> None:
        return None


def test_doctor_checks_main_and_derived_multiagent_postgresql(monkeypatch):
    calls: list[str] = []
    monkeypatch.setenv(
        "ARFORGE_DB_URL",
        "postgresql://agent:secret@db.example:5432/arforge",
    )
    monkeypatch.delenv("ARFORGE_MULTIAGENT_DB_URL", raising=False)

    def connect(url: str, *, connect_timeout: int):
        assert connect_timeout == 3
        calls.append(url)
        return _Connection()

    monkeypatch.setitem(
        __import__("sys").modules,
        "psycopg2",
        SimpleNamespace(connect=connect),
    )

    result = _check_database_config()

    assert result.ok is True
    assert len(calls) == 2
    assert calls[0].endswith("/arforge")
    assert calls[1].endswith("/arforge_ma")
    assert "main" in result.detail and "multiagent" in result.detail


def test_doctor_fails_when_multiagent_postgresql_is_unreachable(monkeypatch):
    monkeypatch.setenv(
        "ARFORGE_DB_URL",
        "postgresql://agent:secret@db.example:5432/arforge",
    )
    monkeypatch.setenv(
        "ARFORGE_MULTIAGENT_DB_URL",
        "postgresql://agent:secret@db.example:5432/arforge_ma",
    )

    def connect(url: str, *, connect_timeout: int):
        if url.endswith("/arforge_ma"):
            raise OSError("offline")
        return _Connection()

    monkeypatch.setitem(
        __import__("sys").modules,
        "psycopg2",
        SimpleNamespace(connect=connect),
    )

    result = _check_database_config()

    assert result.ok is False
    assert "multiagent" in result.detail
    assert "OSError" in result.detail
