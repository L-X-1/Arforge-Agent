"""Database configuration uses the canonical runtime loader."""

from pathlib import Path


def test_database_config_imports_canonical_runtime_loader():
    source = Path("arforge/database/config.py").read_text(encoding="utf-8")
    assert "import config as _runtime_config" in source


def test_multiagent_url_derivation_replaces_database_name(monkeypatch):
    from arforge.database.config import get_multiagent_database_url

    monkeypatch.setenv(
        "ARFORGE_DB_URL", "postgresql://agent:secret@db.example:5432/forge?sslmode=require"
    )
    monkeypatch.delenv("ARFORGE_MULTIAGENT_DB_URL", raising=False)

    derived = get_multiagent_database_url()
    assert derived == (
        "postgresql://agent:secret@db.example:5432/forge_ma?sslmode=require"
    )


def test_multiagent_url_derivation_preserves_encoded_password_bytes(monkeypatch):
    from sqlalchemy.engine import make_url
    from arforge.database.config import get_multiagent_database_url

    main = "postgresql://agent:prefix%2Fsuffix@db.example:5432/forge?sslmode=require"
    monkeypatch.setenv("ARFORGE_DB_URL", main)
    monkeypatch.delenv("ARFORGE_MULTIAGENT_DB_URL", raising=False)

    derived = get_multiagent_database_url()

    assert derived == (
        "postgresql://agent:prefix%2Fsuffix@db.example:5432/forge_ma?sslmode=require"
    )
    assert make_url(derived).password == make_url(main).password


def test_database_description_never_exposes_credentials():
    from arforge.database.config import describe_database_url

    display = describe_database_url(
        "postgresql+psycopg2://agent:plain-password@db.example:5432/arforge"
    )
    assert display == "postgresql://db.example:5432/arforge (credentials hidden)"
    assert "agent" not in display
    assert "plain-password" not in display
