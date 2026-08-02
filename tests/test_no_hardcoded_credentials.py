"""Credential hygiene checks for operational scripts."""

from pathlib import Path


def test_postgres_scripts_do_not_embed_connection_passwords():
    connection_test = Path("scripts/test_pg_connection.py").read_text(encoding="utf-8")
    setup_script = Path("scripts/setup_postgres.bat").read_text(encoding="utf-8")
    combined = connection_test + setup_script
    assert "postgresql://postgres:" not in combined
    assert "ALTER USER postgres WITH PASSWORD" not in combined
    assert "ARFORGE_POSTGRES_PASSWORD" in setup_script
