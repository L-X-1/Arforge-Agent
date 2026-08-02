"""CLI contracts for encrypted provider credential management."""

from __future__ import annotations

import json


def test_auth_status_never_exposes_api_key(monkeypatch, tmp_path, capsys):
    import arforge.product.model_config_runtime as model_config
    from arforge.cli import main

    runtime = model_config.ModelConfigRuntime(data_dir=tmp_path)
    runtime.set_api_key("openai", "secret-token-that-must-not-appear")
    runtime.set_active_provider("openai")
    monkeypatch.setattr(model_config, "get_model_config", lambda: runtime)

    assert main(["auth", "status", "--json"]) == 0
    output = capsys.readouterr().out
    payload = json.loads(output)

    assert payload["active_provider"] == "openai"
    assert payload["providers"][1]["configured"] is True
    assert "secret-token-that-must-not-appear" not in output
    assert "api_key" not in output


def test_auth_login_uses_hidden_input_and_stores_encrypted_key(monkeypatch, tmp_path):
    import getpass
    import arforge.product.model_config_runtime as model_config
    from arforge.cli import main

    runtime = model_config.ModelConfigRuntime(data_dir=tmp_path)
    monkeypatch.setattr(model_config, "get_model_config", lambda: runtime)
    monkeypatch.setattr(getpass, "getpass", lambda _prompt: "stored-via-hidden-input")

    assert main(["auth", "login", "deepseek"]) == 0
    assert runtime.get_active_provider() == "deepseek"
    assert runtime.get_api_key("deepseek") == "stored-via-hidden-input"
    assert "stored-via-hidden-input" not in runtime._path.read_text(encoding="utf-8")


def test_auth_supports_provider_model_endpoint_and_logout(monkeypatch, tmp_path):
    import arforge.product.model_config_runtime as model_config
    from arforge.cli import main

    runtime = model_config.ModelConfigRuntime(data_dir=tmp_path)
    runtime.set_api_key("openai", "secret")
    monkeypatch.setattr(model_config, "get_model_config", lambda: runtime)

    assert main(["auth", "use", "openai"]) == 0
    assert main(["auth", "model", "openai", "gpt-4o-mini"]) == 0
    assert main(["auth", "endpoint", "openai", "https://proxy.example.com/v1"]) == 0
    assert main(["auth", "logout", "openai"]) == 0

    assert runtime.get_active_provider() == "openai"
    assert runtime.get_api_key("openai") == ""
    resolved = runtime.get_resolved_config("openai")
    assert resolved["base_url"] == "https://api.openai.com/v1"
