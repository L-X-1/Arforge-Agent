from __future__ import annotations

from types import SimpleNamespace

from arforge.product.doctor import _check_active_provider, _check_database_config


def test_doctor_reports_runtime_active_provider_without_exposing_key(monkeypatch):
    runtime = SimpleNamespace(
        get_resolved_config=lambda: {
            "provider": "deepseek",
            "resolved": True,
            "model": "deepseek-chat",
            "base_url": "https://api.deepseek.com",
            "key_source": "stored",
        }
    )
    monkeypatch.setattr(
        "arforge.product.model_config_runtime.get_model_config", lambda: runtime
    )
    monkeypatch.setattr("socket.gethostbyname", lambda host: "127.0.0.1")

    checks = _check_active_provider()

    assert [item.name for item in checks] == [
        "Active provider credentials",
        "Active provider model",
        "API DNS",
    ]
    assert checks[0].warning is False
    assert checks[0].detail == "DeepSeek: configured (stored)"
    assert "deepseek-chat" in checks[1].detail


def test_doctor_gives_actionable_login_command_from_any_workspace(monkeypatch):
    runtime = SimpleNamespace(
        get_resolved_config=lambda: {
            "provider": "deepseek",
            "resolved": False,
            "model": "deepseek-v4-flash",
            "base_url": "https://api.deepseek.com",
            "key_source": "none",
        }
    )
    monkeypatch.setattr(
        "arforge.product.model_config_runtime.get_model_config", lambda: runtime
    )
    monkeypatch.setattr("socket.gethostbyname", lambda host: "127.0.0.1")

    checks = _check_active_provider()

    assert checks[0].warning is True
    assert "arforge auth login deepseek" in checks[0].detail
    assert all("API key" not in item.detail for item in checks)


def test_doctor_version_drift_names_installed_source_and_remediation(monkeypatch):
    from arforge.product.doctor import _check_package_versions

    monkeypatch.setattr(
        "arforge.product.doctor.package_version",
        lambda _name: "0.7.0",
    )

    result = _check_package_versions()

    assert result.ok is False
    assert "installed=0.7.0" in result.detail
    assert "source=1.0.0.dev1" in result.detail
    assert "python -m pip install -e ." in result.detail


def test_doctor_probes_configured_database_without_exposing_credentials(monkeypatch):
    closed = []
    connection = SimpleNamespace(close=lambda: closed.append(True))
    monkeypatch.setenv(
        "ARFORGE_DB_URL",
        "postgresql+psycopg2://private-user:private-password@db.example:5433/arforge",
    )
    monkeypatch.setenv(
        "ARFORGE_MULTIAGENT_DB_URL",
        "postgresql+psycopg2://private-user:private-password@db.example:5433/arforge_ma",
    )
    monkeypatch.setattr("psycopg2.connect", lambda *_args, **_kwargs: connection)

    result = _check_database_config()

    assert result.ok is True
    assert closed == [True, True]
    assert "db.example:5433/arforge" in result.detail
    assert "private-user" not in result.detail
    assert "private-password" not in result.detail


def test_doctor_fails_when_configured_database_is_unreachable(monkeypatch):
    monkeypatch.setenv(
        "ARFORGE_DB_URL",
        "postgresql://private-user:private-password@db.example/arforge",
    )

    def unavailable(*_args, **_kwargs):
        raise UnicodeDecodeError(
            "utf-8", b"\xd6", 0, 1, "invalid continuation byte"
        )

    monkeypatch.setattr("psycopg2.connect", unavailable)

    result = _check_database_config()

    assert result.ok is False
    assert "UnicodeDecodeError" in result.detail
    assert "verify ARFORGE_DB_URL" in result.detail
    assert "private-user" not in result.detail
    assert "private-password" not in result.detail
