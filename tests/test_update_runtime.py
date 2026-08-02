from __future__ import annotations

import json
from types import SimpleNamespace


class _Response:
    def __init__(self, body: bytes):
        self.body = body
        self.closed = False

    def read(self):
        return self.body

    def close(self):
        self.closed = True


def test_explicit_update_check_caches_result(monkeypatch, tmp_path):
    import arforge.update_runtime as updates
    import arforge.core.runtime_sandbox as runtime_sandbox

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.setenv("ARFORGE_UPDATE_METADATA_URL", "http://127.0.0.1:9999/arforge.json")
    monkeypatch.setattr(
        runtime_sandbox,
        "decide_network_egress",
        lambda *_args, **_kwargs: SimpleNamespace(allowed=True, reason=""),
    )
    monkeypatch.setattr(updates, "current_version", lambda: "0.7.0")
    response = _Response(b'{"info":{"version":"0.8.0"}}')
    result = updates.check_for_update(opener=lambda *_args, **_kwargs: response, force=True)

    assert result["update_available"] is True
    assert result["cached"] is False
    assert response.closed is True
    cached = updates.check_for_update(opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError()), force=False)
    assert cached["cached"] is True


def test_private_build_has_no_implicit_public_update_source(monkeypatch):
    import pytest

    import arforge.update_runtime as updates

    monkeypatch.delenv("ARFORGE_UPDATE_METADATA_URL", raising=False)
    with pytest.raises(updates.UpdateCheckError, match="not configured"):
        updates.check_for_update(force=True)


def test_update_cli_exposes_structured_result(monkeypatch, capsys):
    import arforge.update_runtime as updates
    from arforge.cli import main

    monkeypatch.setattr(updates, "check_for_update", lambda **_kwargs: {"current_version": "0.7.0", "latest_version": "0.8.0", "update_available": True, "cached": False})
    assert main(["update", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["latest_version"] == "0.8.0"


def test_version_comparison_treats_omitted_zero_components_as_equal():
    from arforge.update_runtime import _version_key

    assert _version_key("0.8") == _version_key("0.8.0")
