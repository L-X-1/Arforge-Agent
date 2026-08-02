"""Isolated first-run and automation acceptance tests."""

from __future__ import annotations

from pathlib import Path


def test_onboarding_writes_private_user_config(monkeypatch, tmp_path):
    import arforge.onboarding as onboarding

    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.chdir(project)

    onboarding._append_env("DEEPSEEK_API_KEY", "sk-test-private")

    user_env = tmp_path / ".arforge" / ".env"
    assert user_env.read_text(encoding="utf-8") == "DEEPSEEK_API_KEY=sk-test-private\n"
    assert not (tmp_path / "project" / ".env").exists()


def test_onboarding_honours_isolated_arforge_home(monkeypatch, tmp_path):
    import arforge.onboarding as onboarding

    isolated_home = tmp_path / "isolated-profile"
    monkeypatch.setenv("ARFORGE_HOME", str(isolated_home))

    onboarding._append_env("DEEPSEEK_API_KEY", "sk-test-isolated")

    assert (isolated_home / ".env").read_text(encoding="utf-8") == (
        "DEEPSEEK_API_KEY=sk-test-isolated\n"
    )


def test_onboarding_secret_input_uses_hidden_prompt(monkeypatch):
    import arforge.onboarding as onboarding

    observed = []
    monkeypatch.setattr(onboarding, "getpass", lambda prompt: observed.append(prompt) or "sk-private")

    assert onboarding._secret_input("API key") == "sk-private"
    assert observed == ["  API key: "]


def test_onboarding_rejects_multiline_environment_values(monkeypatch, tmp_path):
    import pytest
    import arforge.onboarding as onboarding

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    with pytest.raises(ValueError, match="single line"):
        onboarding._append_env("DEEPSEEK_API_KEY", "safe\ninjected=value")
    assert not (tmp_path / ".env").exists()


def test_non_tty_entry_fails_closed(monkeypatch, capsys):
    import arforge.trust_screen as trust

    monkeypatch.delenv("ARFORGE_TRUST_WORKSPACE", raising=False)
    monkeypatch.setattr(trust.sys.stdin, "isatty", lambda: False)

    assert trust.show_entry_screen("en") is False
    assert "requires workspace trust" in capsys.readouterr().err


def test_non_tty_entry_allows_explicit_trust(monkeypatch, tmp_path):
    import arforge.trust_screen as trust

    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setattr(trust, "_trust_file", lambda: tmp_path / "trusted.json")
    monkeypatch.setattr(trust.sys.stdin, "isatty", lambda: False)

    assert trust.show_entry_screen("en") is True
    assert trust.is_workspace_trusted()
