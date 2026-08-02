from __future__ import annotations

import json
import sys
from pathlib import Path

from arforge.declarative_plugins import register_enabled_declarative_tools
from arforge.mcp_http import PluginRegistry
from arforge.mcp_server import MCPServer
from arforge.plugin_state import set_plugin_enabled
from arforge.tool_registry import REGISTRY


def _write_declarative_plugin(root: Path) -> Path:
    directory = root / "command-tools"
    directory.mkdir(parents=True)
    (directory / "greet.py").write_text(
        "import json, sys\n"
        "payload = json.load(sys.stdin)\n"
        "print(json.dumps({'greeting': 'Hello ' + payload['name']}))\n",
        encoding="utf-8",
    )
    (directory / "plugin.json").write_text(
        json.dumps(
            {
                "name": "command-tools",
                "version": "1.0.0",
                "description": "Data-declared tools",
                "tools": [
                    {
                        "name": "greet",
                        "description": "Greet one person",
                        "command": [Path(sys.executable).name, "greet.py"],
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "Person name"}
                            },
                            "required": ["name"],
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return directory


def test_declarative_plugin_loads_into_mcp_without_importing_entrypoint(tmp_path):
    root = tmp_path / "plugins"
    directory = _write_declarative_plugin(root)
    registry = PluginRegistry()
    discovered = registry.discover([root])
    server = MCPServer("test", "1.0")

    loaded = registry.load_discovered(server)
    result = server.registry.call_tool("plugin_command_tools_greet", {"name": "Ada"})

    assert discovered["items"][0]["entrypoint"] == ""
    assert discovered["items"][0]["tools"][0]["name"] == "greet"
    assert loaded == {"loaded": ["command-tools"], "failed": {}}
    assert "Hello Ada" in result["content"][0]["text"]
    assert not (directory / "__pycache__").exists()


def test_agent_registration_requires_explicit_enable_override(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    directory = _write_declarative_plugin(profile / "plugins")
    exposed_name = "plugin_command_tools_greet"
    REGISTRY.tools.pop(exposed_name, None)

    register_enabled_declarative_tools()
    assert REGISTRY.get(exposed_name) is None

    set_plugin_enabled(directory / "plugin.json", True)
    failures = register_enabled_declarative_tools()
    definition = REGISTRY.get(exposed_name)
    try:
        assert failures == {}
        assert definition is not None
        assert definition.schema.requires_confirmation is True
        assert definition.schema.risk_level == "high"
        assert "Hello Lin" in definition.execute_fn(name="Lin")
    finally:
        REGISTRY.tools.pop(exposed_name, None)


def test_invalid_declarative_manifest_never_loads(tmp_path):
    root = tmp_path / "plugins"
    directory = root / "unsafe"
    directory.mkdir(parents=True)
    (directory / "plugin.json").write_text(
        json.dumps(
            {
                "name": "unsafe",
                "version": "1.0.0",
                "description": "Unsafe",
                "tools": [
                    {
                        "name": "bad",
                        "description": "Bad command",
                        "command": [],
                        "parameters": {"type": "array"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    registry = PluginRegistry()

    discovered = registry.discover([root])
    loaded = registry.load_discovered(MCPServer("test", "1.0"))

    assert discovered["items"][0]["problems"]
    assert loaded == {"loaded": [], "failed": {}}
