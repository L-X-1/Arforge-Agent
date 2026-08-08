"""Signed remote feature rollout tests with no real network traffic."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest

from arforge.feature_flags import FeatureFlagError, FeatureFlagRegistry


class _Response:
    def __init__(self, body: bytes, signature: str, etag: str = "rollout-v1"):
        self._body = body
        self.headers = {"X-Arforge-Feature-Signature": signature, "ETag": etag}
        self.closed = False

    def read(self) -> bytes:
        return self._body

    def close(self) -> None:
        self.closed = True


def _signed_response(payload: dict, key: str) -> _Response:
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    signature = hmac.new(key.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return _Response(body, f"sha256={signature}")


def test_signed_remote_refresh_is_explicit_cached_and_lower_precedence_than_local(tmp_path):
    key = "feature-signing-key"
    environ = {
        "ARFORGE_FEATURE_CONFIG_URL": "https://config.example.test/flags.json",
        "ARFORGE_FEATURE_CONFIG_HMAC_KEY": key,
    }
    registry = FeatureFlagRegistry(state_path=tmp_path / "feature_flags.json", environ=environ)
    response = _signed_response({"overrides": {"file_history": False}, "ttl_seconds": 600}, key)
    seen = {}

    def fake_open(request, timeout):
        seen["url"] = request.full_url
        seen["timeout"] = timeout
        return response

    assert registry.get("file_history")["source"] == "default"
    refreshed = registry.refresh_remote_config(opener=fake_open)
    assert refreshed["status"] == "refreshed"
    assert response.closed is True
    assert seen == {"url": "https://config.example.test/flags.json", "timeout": 10.0}
    assert registry.get("file_history")["source"] == "remote_cache"
    assert registry.enabled("file_history") is False

    registry.set_override("file_history", True)
    assert registry.get("file_history")["source"] == "local_override"
    assert registry.enabled("file_history") is True

    environ["ARFORGE_FEATURE_FILE_HISTORY"] = "off"
    assert registry.get("file_history")["source"] == "environment"
    assert registry.enabled("file_history") is False


def test_remote_refresh_rejects_invalid_signature_without_cache_write(tmp_path):
    environ = {
        "ARFORGE_FEATURE_CONFIG_URL": "https://config.example.test/flags.json",
        "ARFORGE_FEATURE_CONFIG_HMAC_KEY": "expected-key",
    }
    registry = FeatureFlagRegistry(state_path=tmp_path / "feature_flags.json", environ=environ)
    response = _Response(b'{"overrides":{"file_history":false}}', "sha256=bad")

    with pytest.raises(FeatureFlagError, match="signature is invalid"):
        registry.refresh_remote_config(opener=lambda *_args, **_kwargs: response)

    assert not registry.remote_state_path.exists()
    assert registry.enabled("file_history") is True


def test_remote_cache_requires_complete_configuration_and_valid_https_url(tmp_path):
    registry = FeatureFlagRegistry(
        state_path=tmp_path / "feature_flags.json",
        environ={"ARFORGE_FEATURE_CONFIG_URL": "http://insecure.example.test/flags.json", "ARFORGE_FEATURE_CONFIG_HMAC_KEY": "key"},
    )

    with pytest.raises(FeatureFlagError, match="HTTPS"):
        registry.refresh_remote_config(opener=lambda *_args, **_kwargs: None)
    assert "HTTPS" in registry.list()["problems"][0]


def test_cli_features_refresh_uses_existing_registry(monkeypatch, capsys):
    import arforge.feature_flags as flags_module
    from arforge.cli import main

    class FakeRegistry:
        def refresh_remote_config(self):
            return {"status": "refreshed", "source": "remote_cache", "count": 1}

    monkeypatch.setattr(flags_module, "get_feature_flags", lambda: FakeRegistry())

    assert main(["features", "refresh", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 1


def test_bridge_features_refresh_uses_versioned_product_method(monkeypatch):
    import arforge.feature_flags as flags_module
    from arforge.product.direct_dispatch import dispatch

    class FakeRegistry:
        def refresh_remote_config(self):
            return {"status": "not_modified", "source": "remote_cache", "expires_at": 123.0}

    monkeypatch.setattr(flags_module, "get_feature_flags", lambda: FakeRegistry())

    response = dispatch({"version": "1.2", "method": "features.refresh", "params": {}})

    assert response["ok"] is True
    assert response["data"]["status"] == "not_modified"
