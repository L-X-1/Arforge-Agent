"""Persistent plugin enablement contracts without implicit code loading."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _write_plugin(root: Path, name: str) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    manifest = directory / "plugin.json"
    manifest.write_text(
        json.dumps(
            {
                "name": name,
                "version": "1.0.0",
                "description": "State test plugin",
                "enabled": True,
                "entrypoint": "plugin.py:create_plugin",
            }
        ),
        encoding="utf-8",
    )
    (directory / "plugin.py").write_text("raise RuntimeError('must not import during discovery')\n", encoding="utf-8")
    return manifest


def test_plugin_state_overrides_manifest_without_mutating_it(monkeypatch, tmp_path):
    import arforge.plugin_state as plugin_state
    from arforge.mcp_http import PluginRegistry

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    manifest = _write_plugin(tmp_path / "plugins", "state-plugin")

    updated = plugin_state.set_plugin_enabled(manifest, False)
    result = PluginRegistry().discover([tmp_path / "plugins"], plugin_state.load_plugin_overrides())

    assert updated["enabled"] is False
    assert result["items"][0]["enabled"] is False
    assert json.loads(manifest.read_text(encoding="utf-8"))["enabled"] is True


def test_plugin_state_update_fails_closed_while_profile_lock_is_held(monkeypatch, tmp_path):
    import arforge.plugin_state as plugin_state
    from arforge.database.sqlite_runtime import ProfileLockError, ProfileWriterLock

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    manifest = _write_plugin(tmp_path / "plugins", "busy-plugin")
    with ProfileWriterLock(plugin_state._state_lock_path()):
        with pytest.raises(ProfileLockError):
            plugin_state.set_plugin_enabled(manifest, False)
    assert not plugin_state._state_path().exists()


def test_plugins_cli_persists_enablement_without_loading_plugin_code(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    _write_plugin(profile / "plugins", "cli-plugin")

    assert main(["plugins", "disable", "cli-plugin"]) == 0
    capsys.readouterr()
    assert main(["plugins", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["items"][0]["name"] == "cli-plugin"
    assert payload["items"][0]["enabled"] is False


def test_server_loads_plugins_only_when_explicitly_requested(monkeypatch, tmp_path):
    import arforge.cli as cli

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    seen = {}

    class FakeTransport:
        def discover_plugins(self, roots, overrides):
            seen["roots"] = roots
            seen["overrides"] = overrides
            return {"count": 0, "items": [], "roots": []}

        def load_discovered_plugins(self):
            seen["loaded"] = True
            return {"loaded": [], "failed": {}}

        def run(self):
            seen["ran"] = True

    monkeypatch.setattr("arforge.mcp_runtime.create_arforge_mcp_transport", lambda **_kwargs: FakeTransport())

    assert cli.main(["server", "--load-plugins"]) == 0
    assert seen["loaded"] is True
    assert seen["ran"] is True
    assert seen["overrides"] == {}
