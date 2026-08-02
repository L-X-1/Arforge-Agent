from __future__ import annotations


def _reset_provider_environment(monkeypatch) -> None:
    for name in (
        "DEEPSEEK_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ARFORGE_PROVIDER",
    ):
        monkeypatch.delenv(name, raising=False)


def test_first_run_accepts_non_deepseek_environment_provider(monkeypatch):
    from arforge import onboarding

    _reset_provider_environment(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "configured-openai-key")

    assert onboarding.is_first_run() is False
    assert onboarding.onboarding_completed() is True


def test_first_run_accepts_encrypted_active_provider(monkeypatch, tmp_path):
    from arforge import onboarding
    from arforge.product import model_config_runtime

    _reset_provider_environment(monkeypatch)
    runtime = model_config_runtime.ModelConfigRuntime(data_dir=tmp_path)
    runtime.set_api_key("anthropic", "configured-compatible-key")
    runtime.set_active_provider("anthropic")
    monkeypatch.setattr(model_config_runtime, "_runtime", runtime)

    assert onboarding.is_first_run() is False
    assert onboarding.onboarding_completed() is True


def test_first_run_remains_true_without_any_provider(monkeypatch, tmp_path):
    from arforge import onboarding
    from arforge.product import model_config_runtime

    _reset_provider_environment(monkeypatch)
    runtime = model_config_runtime.ModelConfigRuntime(data_dir=tmp_path)
    monkeypatch.setattr(model_config_runtime, "_runtime", runtime)

    assert onboarding.is_first_run() is True
    assert onboarding.onboarding_completed() is False
