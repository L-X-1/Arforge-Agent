from __future__ import annotations

import json
from pathlib import Path

from arforge.mcp_http import HTTPTransport, PluginRegistry
from arforge.mcp_server import MCPServer


def _write_plugin(root: Path, name: str, *, enabled: bool = True, entrypoint: str = "plugin.py:create_plugin") -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    (directory / "plugin.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": "1.0.0",
                "description": "Test extension",
                "enabled": enabled,
                "entrypoint": entrypoint,
                "hooks": ["post_tool_use"],
            }
        ),
        encoding="utf-8",
    )
    (directory / "plugin.py").write_text(
        "from arforge.mcp_http import Plugin\n"
        "class TestPlugin(Plugin):\n"
        "    def on_load(self, server):\n"
        "        super().on_load(server)\n"
        "        server.plugin_loaded = self.manifest.name\n"
        "def create_plugin(manifest):\n"
        "    return TestPlugin(manifest)\n",
        encoding="utf-8",
    )
    return directory


def test_plugin_discovery_reads_manifest_without_importing_code(tmp_path: Path):
    root = tmp_path / "plugins"
    _write_plugin(root, "example-plugin")
    registry = PluginRegistry()

    result = registry.discover([root])

    assert result["count"] == 1
    assert result["items"][0]["name"] == "example-plugin"
    assert registry.list_plugins() == []


def test_plugin_registry_loads_only_enabled_validated_plugins(tmp_path: Path):
    root = tmp_path / "plugins"
    _write_plugin(root, "enabled-plugin")
    _write_plugin(root, "disabled-plugin", enabled=False)
    registry = PluginRegistry()
    registry.discover([root])
    server = type("Server", (), {})()

    loaded = registry.load_discovered(server)

    assert loaded == {"loaded": ["enabled-plugin"], "failed": {}}
    assert server.plugin_loaded == "enabled-plugin"
    assert registry.list_plugins()[0]["loaded"] is True


def test_plugin_discovery_rejects_entrypoint_outside_plugin_directory(tmp_path: Path):
    root = tmp_path / "plugins"
    _write_plugin(root, "unsafe-plugin", entrypoint="../outside.py:create_plugin")
    registry = PluginRegistry()

    discovered = registry.discover([root])
    loaded = registry.load_discovered(object())

    assert discovered["items"][0]["problems"]
    assert loaded == {"loaded": [], "failed": {}}


def test_http_transport_exposes_explicit_discovery_then_load(tmp_path: Path):
    root = tmp_path / "plugins"
    _write_plugin(root, "transport-plugin")
    server = MCPServer("test", "1.0")
    transport = HTTPTransport(server)

    discovered = transport.discover_plugins([root])
    loaded = transport.load_discovered_plugins()

    assert discovered["count"] == 1
    assert loaded["loaded"] == ["transport-plugin"]
    assert getattr(server, "plugin_loaded") == "transport-plugin"
