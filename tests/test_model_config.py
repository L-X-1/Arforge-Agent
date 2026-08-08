# -*- coding: utf-8 -*-
"""Tests for model config runtime — secure provider/key management."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Clean leaked env vars that may interfere with model config tests."""
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
                 "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
                 "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
                 "ARFORGE_PROVIDER"):
        monkeypatch.delenv(var, raising=False)

@pytest.fixture
def temp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


@pytest.fixture
def mc(temp_dir):
    from arforge.product.model_config_runtime import ModelConfigRuntime
    return ModelConfigRuntime(data_dir=temp_dir)


class TestModelConfigRuntime:
    def test_list_providers(self, mc):
        providers = mc.list_providers()
        assert len(providers) == 3
        ids = {p["id"] for p in providers}
        assert ids == {"deepseek", "openai", "anthropic"}

    def test_default_active_is_deepseek(self, mc):
        assert mc.get_active_provider() == "deepseek"

    def test_pristine_profile_uses_first_configured_environment_provider(self, mc, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "environment-key")

        assert mc.get_active_provider() == "anthropic"
        providers = {item["id"]: item for item in mc.list_providers()}
        assert providers["anthropic"]["configured"] is True
        assert providers["anthropic"]["is_active"] is True

    def test_saved_provider_choice_overrides_first_run_discovery(self, mc, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "environment-key")
        mc.set_active_provider("openai")

        assert mc.get_active_provider() == "openai"

    def test_set_active_provider(self, mc):
        result = mc.set_active_provider("openai")
        assert result["active_provider"] == "openai"
        assert mc.get_active_provider() == "openai"

    def test_set_active_unknown_provider(self, mc):
        from arforge.product.model_config_runtime import ModelConfigError
        with pytest.raises(ModelConfigError, match="unsupported"):
            mc.set_active_provider("unknown")

    def test_set_and_get_api_key(self, mc):
        mc.set_api_key("deepseek", "sk-test-key-12345")
        key = mc.get_api_key("deepseek")
        assert key == "sk-test-key-12345"

    def test_delete_api_key(self, mc):
        mc.set_api_key("openai", "sk-openai-test")
        assert mc.get_api_key("openai") == "sk-openai-test"
        result = mc.delete_api_key("openai")
        assert result["configured"] is False
        assert mc.get_api_key("openai") == ""

    def test_compatible_endpoint_label_and_non_secret_settings_survive_key_removal(self, mc):
        mc.set_display_label("openai", "Enterprise Gateway")
        mc.set_base_url("openai", "https://gateway.example.com/v1")
        mc.set_model("openai", "company-model-v2")
        mc.set_api_key("openai", "sk-enterprise-test")

        mc.delete_api_key("openai")

        provider = {item["id"]: item for item in mc.list_providers()}["openai"]
        assert provider["label"] == "Enterprise Gateway"
        assert provider["resolved_base_url"] == "https://gateway.example.com/v1"
        assert provider["selected_model"] == "company-model-v2"
        assert provider["configured"] is False

    def test_explicit_provider_reset_removes_all_local_overrides(self, mc):
        mc.set_display_label("openai", "Enterprise Gateway")
        mc.set_base_url("openai", "https://gateway.example.com/v1")
        mc.set_model("openai", "company-model-v2")
        mc.set_api_key("openai", "sk-enterprise-test")

        result = mc.reset_provider("openai")

        assert result == {"provider": "openai", "configured": False, "reset": True}
        resolved = mc.get_resolved_config("openai")
        assert mc.get_api_key("openai") == ""
        assert resolved["base_url"] == "https://api.openai.com/v1"
        assert resolved["model"] == "gpt-4o"
        provider = {item["id"]: item for item in mc.list_providers()}["openai"]
        assert provider["label"] == "OpenAI"

    @pytest.mark.parametrize("label", ["", "   ", "x" * 81, "unsafe\nlabel"])
    def test_provider_display_label_is_bounded(self, mc, label):
        from arforge.product.model_config_runtime import ModelConfigError

        with pytest.raises(ModelConfigError) as error:
            mc.set_display_label("openai", label)

        assert error.value.code == "INVALID_PROVIDER_LABEL"

    def test_set_model(self, mc):
        result = mc.set_model("deepseek", "deepseek-v4-pro")
        assert result["model"] == "deepseek-v4-pro"

    def test_switching_models_refreshes_the_catalog_context_window(self, mc):
        deepseek = {item["id"]: item for item in mc.list_providers()}["deepseek"]
        assert deepseek["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
        assert deepseek["context_window_tokens"] == 1_000_000
        assert deepseek["context_window_source"] == "catalog"

        mc.set_model("openai", "gpt-4o")
        gpt_4o = {item["id"]: item for item in mc.list_providers()}["openai"]
        assert gpt_4o["context_window_tokens"] == 128_000

        mc.set_model("openai", "o3-mini")
        o3_mini = {item["id"]: item for item in mc.list_providers()}["openai"]
        assert o3_mini["selected_model"] == "o3-mini"
        assert o3_mini["context_window_tokens"] == 200_000
        assert o3_mini["context_window_source"] == "catalog"

    def test_catalog_model_context_window_cannot_be_manually_overridden(self, mc):
        from arforge.product.model_config_runtime import ModelConfigError

        mc.set_model("openai", "gpt-4o")
        with pytest.raises(ModelConfigError) as error:
            mc.set_context_window("openai", 258_000)

        assert error.value.code == "CONTEXT_WINDOW_MANAGED"

    def test_context_window_override_is_persisted_and_exposed(self, mc):
        mc.set_model("anthropic", "v4-pro[1m]")
        inferred = next(item for item in mc.list_providers() if item["id"] == "anthropic")
        assert inferred["context_window_tokens"] == 1_000_000
        assert inferred["context_window_source"] == "model_name"

        result = mc.set_context_window("anthropic", 258_000)
        assert result["context_window_tokens"] == 258_000
        configured = next(item for item in mc.list_providers() if item["id"] == "anthropic")
        assert configured["context_window_tokens"] == 258_000
        assert configured["context_window_source"] == "configured"

    @pytest.mark.parametrize("value", [4095, 10_000_001, 1.5, True])
    def test_context_window_override_rejects_invalid_values(self, mc, value):
        from arforge.product.model_config_runtime import ModelConfigError

        with pytest.raises(ModelConfigError):
            mc.set_context_window("anthropic", value)

    def test_set_model_invalid(self, mc):
        from arforge.product.model_config_runtime import ModelConfigError
        with pytest.raises(ModelConfigError, match="unknown model"):
            mc.set_model("deepseek", "nonexistent-model")

    def test_set_base_url(self, mc):
        result = mc.set_base_url("openai", "https://proxy.example.com/v1")
        assert result["base_url"] == "https://proxy.example.com/v1"

    @pytest.mark.parametrize(
        "endpoint",
        [
            "file:///tmp/model.sock",
            "ftp://gateway.example.com/v1",
            "http://gateway.example.com/v1",
            "https://user:password@gateway.example.com/v1",
            "https://gateway.example.com/v1?token=secret",
            "https://169.254.169.254/latest",
            "https://10.0.0.10/v1",
        ],
    )
    def test_set_base_url_rejects_unsafe_endpoints(self, mc, endpoint):
        from arforge.product.model_config_runtime import ModelConfigError

        with pytest.raises(ModelConfigError) as error:
            mc.set_base_url("openai", endpoint)

        assert error.value.code == "INVALID_BASE_URL"

    def test_set_base_url_allows_local_loopback_model_server(self, mc):
        result = mc.set_base_url("openai", "http://127.0.0.1:11434/v1")

        assert result["base_url"] == "http://127.0.0.1:11434/v1"

    def test_set_base_url_requires_explicit_private_network_opt_in(self, mc, monkeypatch):
        from arforge.product.model_config_runtime import ModelConfigError

        with pytest.raises(ModelConfigError, match="ARFORGE_ALLOW_PRIVATE_MODEL_ENDPOINTS"):
            mc.set_base_url("openai", "https://10.0.0.10/v1")

        monkeypatch.setenv("ARFORGE_ALLOW_PRIVATE_MODEL_ENDPOINTS", "1")
        result = mc.set_base_url("openai", "https://10.0.0.10/v1")

        assert result["base_url"] == "https://10.0.0.10/v1"

    def test_set_base_url_honors_endpoint_allowlist(self, mc, monkeypatch):
        from arforge.product.model_config_runtime import ModelConfigError

        monkeypatch.setenv("ARFORGE_MODEL_ENDPOINT_ALLOWLIST", "gateway.example.com")
        assert mc.set_base_url("openai", "https://gateway.example.com/v1")["base_url"]
        with pytest.raises(ModelConfigError, match="ALLOWLIST"):
            mc.set_base_url("openai", "https://other.example.com/v1")

    def test_resolved_config_fails_closed_for_unsafe_environment_endpoint(self, mc, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "environment-key")
        monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://169.254.169.254/latest")

        resolved = mc.get_resolved_config("deepseek")

        assert resolved["resolved"] is False
        assert resolved["base_url"] == ""
        assert "private model endpoint" in resolved["error"]

    def test_get_resolved_config_env_precedence(self, mc, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-from-env")
        config = mc.get_resolved_config("deepseek")
        assert config["resolved"] is True
        assert config["model"] == "deepseek-v4-flash"
        assert config["key_source"] == "env"

    def test_active_provider_environment_precedence(self, mc, monkeypatch):
        monkeypatch.setenv("ARFORGE_PROVIDER", "OPENAI")

        assert mc.get_active_provider() == "openai"
        providers = {item["id"]: item for item in mc.list_providers()}
        assert providers["openai"]["is_active"] is True
        assert providers["deepseek"]["is_active"] is False
        assert all(item["provider_locked"] is True for item in providers.values())
        from arforge.product.model_config_runtime import ModelConfigError
        with pytest.raises(ModelConfigError, match="managed by environment"):
            mc.set_active_provider("deepseek")

    def test_list_providers_reports_environment_and_stored_credentials(self, mc, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "environment-key")
        mc.set_api_key("deepseek", "stored-key")

        providers = {item["id"]: item for item in mc.list_providers()}

        assert providers["openai"]["configured"] is True
        assert providers["openai"]["key_source"] == "env"
        assert providers["deepseek"]["configured"] is True
        assert providers["deepseek"]["key_source"] == "stored"

    def test_list_providers_exposes_effective_custom_model_configuration(self, mc, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "environment-key")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gateway.example.com/v1")
        monkeypatch.setenv("ANTHROPIC_MODEL", "custom-model-v2")

        provider = {item["id"]: item for item in mc.list_providers()}["anthropic"]

        assert provider["allow_custom_model"] is True
        assert provider["resolved_base_url"] == "https://gateway.example.com/v1"
        assert provider["selected_model"] == "custom-model-v2"

    def test_explicit_model_selection_overrides_environment_default(self, mc, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "environment-key")
        monkeypatch.setenv("ANTHROPIC_MODEL", "environment-default-model")

        mc.set_model("anthropic", "desktop-selected-model")

        resolved = mc.get_resolved_config("anthropic")
        assert resolved["model"] == "desktop-selected-model"
        provider = {item["id"]: item for item in mc.list_providers()}["anthropic"]
        assert provider["selected_model"] == "desktop-selected-model"

    def test_loaded_env_file_locks_provider_and_model_for_product_runtime(self, temp_dir, monkeypatch):
        import config
        from arforge.product.model_config_runtime import ModelConfigRuntime

        env_file = temp_dir / ".env"
        env_file.write_text(
            "DEEPSEEK_API_KEY=environment-key\n"
            "DEEPSEEK_BASE_URL=https://gateway.example.com/v1\n"
            "DEEPSEEK_MODEL=deepseek-v4-flash\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(config, "_loaded_config_file", str(env_file))
        monkeypatch.setenv("DEEPSEEK_API_KEY", "environment-key")
        monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://gateway.example.com/v1")
        monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-v4-flash")

        runtime = ModelConfigRuntime()
        runtime._dir = temp_dir / "product-config"
        runtime._path = runtime._dir / "model_config.json"
        from arforge.product.model_config_runtime import ModelConfigError
        with pytest.raises(ModelConfigError, match="managed by environment"):
            runtime.set_active_provider("anthropic")
        with pytest.raises(ModelConfigError, match="DEEPSEEK_MODEL"):
            runtime.set_model("deepseek", "deepseek-v4-pro")
        with pytest.raises(ModelConfigError, match="DEEPSEEK_BASE_URL"):
            runtime.set_base_url("deepseek", "https://proxy.example.com/v1")

        assert runtime.get_active_provider() == "deepseek"
        resolved = runtime.get_resolved_config()
        assert resolved["model"] == "deepseek-v4-flash"
        assert resolved["model_source"] == "env"
        assert resolved["model_locked"] is True
        provider = {item["id"]: item for item in runtime.list_providers()}["deepseek"]
        assert provider["provider_locked"] is True
        assert provider["model_locked"] is True
        assert provider["base_url_locked"] is True

    def test_inherited_environment_endpoint_can_be_overridden(self, mc, monkeypatch):
        monkeypatch.setenv("OPENAI_BASE_URL", "https://gateway.example.com/v1")
        provider = {item["id"]: item for item in mc.list_providers()}["openai"]

        assert provider["resolved_base_url"] == "https://gateway.example.com/v1"
        assert provider["base_url_source"] == "env"
        assert provider["base_url_locked"] is False

        mc.set_base_url("openai", "https://proxy.example.com/v1")
        updated = {item["id"]: item for item in mc.list_providers()}["openai"]
        assert updated["resolved_base_url"] == "https://proxy.example.com/v1"
        assert updated["base_url_source"] == "stored"

    def test_environment_key_source_is_reported_as_locked(self, mc, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "environment-key")

        provider = {item["id"]: item for item in mc.list_providers()}["openai"]

        assert provider["key_source"] == "env"
        assert provider["key_locked"] is True

    def test_get_resolved_config_stored_fallback(self, mc):
        mc.set_api_key("anthropic", "sk-anthropic-stored")
        mc.set_model("anthropic", "vendor-compatible-v1")
        config = mc.get_resolved_config("anthropic")
        assert config["resolved"] is True
        assert config["model"] == "vendor-compatible-v1"
        assert config["key_source"] == "stored"

    def test_get_resolved_config_none(self, mc):
        config = mc.get_resolved_config("openai")
        assert config["resolved"] is False
        assert config["key_source"] == "none"

    def test_create_active_adapter_uses_secure_active_provider(self, mc, monkeypatch):
        calls = []

        def fake_factory(provider, **kwargs):
            calls.append((provider, kwargs))
            return object()

        monkeypatch.setattr("arforge.models.model_factory.create_model_adapter", fake_factory)
        mc.set_active_provider("openai")
        mc.set_api_key("openai", "stored-openai-key")
        mc.set_model("openai", "gpt-4o-mini")
        mc.set_base_url("openai", "https://proxy.example.com/v1")

        adapter = mc.create_active_adapter()

        assert adapter is not None
        assert calls == [("openai", {
            "api_key": "stored-openai-key",
            "base_url": "https://proxy.example.com/v1",
            "model": "gpt-4o-mini",
        })]

    def test_create_active_adapter_prefers_environment_key(self, mc, monkeypatch):
        calls = []

        def fake_factory(provider, **kwargs):
            calls.append((provider, kwargs))
            return object()

        monkeypatch.setattr("arforge.models.model_factory.create_model_adapter", fake_factory)
        monkeypatch.setenv("DEEPSEEK_API_KEY", "environment-key")
        mc.set_api_key("deepseek", "stored-key")

        mc.create_active_adapter()

        assert calls[0][0] == "deepseek"
        assert calls[0][1]["api_key"] == "environment-key"

    def test_create_adapter_uses_secure_explicit_provider_configuration(self, mc, monkeypatch):
        calls = []

        def fake_factory(provider, **kwargs):
            calls.append((provider, kwargs))
            return object()

        monkeypatch.setattr("arforge.models.model_factory.create_model_adapter", fake_factory)
        mc.set_api_key("openai", "stored-openai-key")
        mc.set_model("openai", "gpt-4o-mini")

        adapter = mc.create_adapter("openai")

        assert adapter is not None
        assert calls == [(
            "openai",
            {
                "api_key": "stored-openai-key",
                "base_url": "https://api.openai.com/v1",
                "model": "gpt-4o-mini",
            },
        )]

    def test_persistence_across_instances(self, temp_dir):
        from arforge.product.model_config_runtime import ModelConfigRuntime
        mc1 = ModelConfigRuntime(data_dir=temp_dir)
        mc1.set_active_provider("anthropic")
        mc1.set_api_key("anthropic", "sk-persist-test")

        mc2 = ModelConfigRuntime(data_dir=temp_dir)
        assert mc2.get_active_provider() == "anthropic"
        assert mc2.get_api_key("anthropic") == "sk-persist-test"

    def test_key_never_plaintext_on_disk(self, mc):
        mc.set_api_key("deepseek", "sk-super-secret-12345")
        config_path = mc._path
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        stored = raw["providers"]["deepseek"]["api_key_encrypted"]
        assert "sk-super-secret-12345" not in stored
        assert stored != "sk-super-secret-12345"

    def test_bridge_preserves_model_config_error_codes(self, mc, monkeypatch):
        from arforge.product import direct_dispatch as bridge
        from arforge.product import model_config_runtime

        monkeypatch.setenv("ARFORGE_PROVIDER", "openai")
        monkeypatch.setattr(model_config_runtime, "get_model_config", lambda: mc)

        response = bridge.dispatch({
            "id": "locked-provider",
            "version": "1.1",
            "method": "model_config.set_active",
            "params": {"provider_id": "deepseek"},
        })

        assert response["ok"] is False
        assert response["error"]["code"] == "CONFIG_LOCKED"
        assert "managed by environment" in response["error"]["message"]

    def test_empty_key_rejected(self, mc):
        from arforge.product.model_config_runtime import ModelConfigError
        with pytest.raises(ModelConfigError, match="cannot be empty"):
            mc.set_api_key("deepseek", "")

    def test_model_config_fails_closed_when_encryption_is_unavailable(self, mc, monkeypatch):
        from arforge.product import model_config_runtime

        monkeypatch.setattr(model_config_runtime, "_CRYPTO_AVAILABLE", False)
        with pytest.raises(model_config_runtime.ModelConfigError) as error:
            mc.set_api_key("deepseek", "stored-key")

        assert error.value.code == "CRYPTOGRAPHY_UNAVAILABLE"

    def test_each_provider_has_models(self, mc):
        for p in mc.list_providers():
            assert len(p["models"]) > 0
            assert p["default_model"] in p["models"]


def test_bridge_exposes_model_config_read_methods(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    from arforge.product.direct_dispatch import dispatch

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    listed = dispatch({"id": 2, "version": "1.1", "method": "model_config.list"})
    active = dispatch({"id": 3, "version": "1.1", "method": "model_config.active"})

    assert "model_config.list" in described["data"]["methods"]
    assert "model_config.active" in described["data"]["methods"]
    assert listed["ok"] is True
    assert active["ok"] is True


def test_factory_availability_includes_securely_stored_credentials(mc, monkeypatch):
    from arforge.models.model_factory import list_available_providers

    mc.set_api_key("openai", "stored-openai-key")
    monkeypatch.setattr("arforge.product.model_config_runtime.get_model_config", lambda: mc)

    available = list_available_providers()

    assert available["openai"] is True


def test_agent_uses_active_model_configuration(monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    expected_adapter = object()

    class FakeConfig:
        def create_active_adapter(self):
            return expected_adapter

    monkeypatch.setattr("arforge.product.model_config_runtime.get_model_config", lambda: FakeConfig())

    assert ArforgeAgent().adapter is expected_adapter


def test_agent_refreshes_cached_adapter_after_configuration_changes(monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    first_adapter = object()
    second_adapter = object()

    class FakeConfig:
        identity = ("deepseek", "model-a", "https://example.test", "key-a")

        def adapter_identity(self):
            return self.identity

        def create_active_adapter(self):
            return first_adapter if self.identity[1] == "model-a" else second_adapter

    config = FakeConfig()
    monkeypatch.setattr("arforge.product.model_config_runtime.get_model_config", lambda: config)

    agent = ArforgeAgent()
    assert agent.adapter is first_adapter
    config.identity = ("anthropic", "model-b", "https://example.test/v2", "key-b")
    assert agent.adapter is second_adapter
