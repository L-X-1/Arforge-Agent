"""Contract tests for the Python-to-TypeScript workspace admission bridge."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from arforge import ts_workspace


@pytest.fixture(autouse=True)
def clear_bridge_cache():
    ts_workspace.clear_typescript_workspace_cache()
    yield
    ts_workspace.clear_typescript_workspace_cache()


def _result(stdout: str, returncode: int = 0):
    return SimpleNamespace(stdout=stdout, stderr="", returncode=returncode)


def test_valid_projection_authorizes_primary_and_extra_root(tmp_path, monkeypatch):
    primary = tmp_path / "primary"
    extra = tmp_path / "extra"
    primary.mkdir()
    extra.mkdir()
    payload = {
        "primary": str(primary),
        "roots": [
            {"path": str(primary), "primary": True, "trusted": False},
            {"path": str(extra), "primary": False, "trusted": True},
        ],
    }
    calls = []

    def invoke(argv, **kwargs):
        calls.append((argv, kwargs))
        return _result(json.dumps(payload))

    monkeypatch.setattr(ts_workspace, "invoke", invoke)
    assert ts_workspace.typescript_path_is_authorized(primary / "src" / "main.ts", primary=primary)
    assert ts_workspace.typescript_path_is_authorized(extra / "out.txt", primary=primary)
    assert not ts_workspace.typescript_path_is_authorized(tmp_path / "outside.txt", primary=primary)
    # State fingerprint caching prevents a subprocess per path check.
    assert len(calls) == 1
    assert calls[0][0] == ["workspace", "list", "--workspace", str(primary.resolve()), "--json"]
    assert calls[0][1]["env"]["ARFORGE_DB"] == ":memory:"


def test_bridge_failure_is_fail_closed(tmp_path, monkeypatch):
    primary = tmp_path / "primary"
    primary.mkdir()
    monkeypatch.setattr(ts_workspace, "invoke", lambda *_args, **_kwargs: _result("", returncode=2))
    assert ts_workspace.typescript_workspace_roots(primary) is None
    assert not ts_workspace.typescript_path_is_authorized(primary / "file.txt", primary=primary)


def test_untrusted_extra_root_is_rejected(tmp_path, monkeypatch):
    primary = tmp_path / "primary"
    extra = tmp_path / "extra"
    primary.mkdir()
    extra.mkdir()
    payload = {
        "primary": str(primary),
        "roots": [
            {"path": str(primary), "primary": True, "trusted": False},
            {"path": str(extra), "primary": False, "trusted": False},
        ],
    }
    monkeypatch.setattr(ts_workspace, "invoke", lambda *_args, **_kwargs: _result(json.dumps(payload)))
    assert ts_workspace.typescript_workspace_roots(primary) is None
    assert not ts_workspace.typescript_path_is_authorized(extra / "file.txt", primary=primary)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"primary": "/other", "roots": []},
        {"primary": "/workspace", "roots": [{"path": "/workspace"}]},
        {"primary": "/workspace", "roots": "not-a-list"},
    ],
)
def test_malformed_projection_is_fail_closed(tmp_path, monkeypatch, payload):
    primary = tmp_path / "primary"
    primary.mkdir()
    monkeypatch.setattr(ts_workspace, "invoke", lambda *_args, **_kwargs: _result(json.dumps(payload)))
    assert ts_workspace.typescript_workspace_roots(primary) is None
    assert not ts_workspace.typescript_path_is_authorized(primary / "file.txt", primary=primary)


def test_force_refresh_reloads_changed_projection(tmp_path, monkeypatch):
    primary = tmp_path / "primary"
    extra = tmp_path / "extra"
    primary.mkdir()
    extra.mkdir()
    payload = {"primary": str(primary), "roots": [{"path": str(primary), "primary": True, "trusted": False}]}
    calls = []

    def invoke(*_args, **_kwargs):
        calls.append(1)
        return _result(json.dumps(payload))

    monkeypatch.setattr(ts_workspace, "invoke", invoke)
    assert ts_workspace.typescript_workspace_roots(primary) == (primary.resolve(),)
    payload["roots"].append({"path": str(extra), "primary": False, "trusted": True})
    assert ts_workspace.typescript_workspace_roots(primary, force_refresh=True) == (primary.resolve(), extra.resolve())
    assert len(calls) == 2
