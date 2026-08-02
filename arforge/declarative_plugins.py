"""Register explicitly enabled data-declared plugin tools with the Agent."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from arforge.mcp_http import (
    PluginRegistry,
    declarative_tool_name,
    run_declarative_plugin_tool,
)
from arforge.mcp_runtime import default_plugin_roots
from arforge.plugin_state import load_plugin_overrides
from arforge.tool_registry import ParamSchema, REGISTRY, register_tool


_LOCK = threading.RLock()
_REGISTERED: set[str] = set()
_TYPE_MAP = {
    "string": "string",
    "integer": "int",
    "number": "float",
    "boolean": "bool",
    "array": "array",
    "object": "object",
}


def _params(schema: dict[str, Any]) -> list[ParamSchema]:
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    result = []
    for name, definition in properties.items():
        result.append(
            ParamSchema(
                name=name,
                type=_TYPE_MAP.get(definition.get("type", "string"), "string"),
                description=str(definition.get("description", ""))[:1_000],
                required=name in required,
                default=definition.get("default"),
                json_schema=dict(definition),
            )
        )
    return result


def register_enabled_declarative_tools() -> dict[str, str]:
    """Expose only command plugins with an explicit persisted enable override."""

    failures: dict[str, str] = {}
    with _LOCK:
        for name in _REGISTERED:
            definition = REGISTRY.tools.get(name)
            if definition is not None and definition.source.startswith("declarative-plugin:"):
                REGISTRY.tools.pop(name, None)
        _REGISTERED.clear()

        overrides = load_plugin_overrides()
        registry = PluginRegistry()
        registry.discover(default_plugin_roots(), overrides)
        for candidate in registry.discovered_records():
            manifest_key = str(candidate.manifest_path.resolve())
            if (
                overrides.get(manifest_key) is not True
                or candidate.problems
                or not candidate.manifest.tools
            ):
                continue
            directory = candidate.manifest_path.parent.resolve()
            for tool in candidate.manifest.tools:
                exposed_name = declarative_tool_name(candidate.manifest.name, tool["name"])
                existing = REGISTRY.get(exposed_name)
                if existing is not None and not existing.source.startswith("declarative-plugin:"):
                    failures[exposed_name] = "tool name collides with an existing Arforge tool"
                    continue

                def execute(_directory: Path = directory, _tool: dict[str, Any] = tool, **arguments):
                    return run_declarative_plugin_tool(_directory, _tool, arguments)

                register_tool(
                    exposed_name,
                    tool["description"],
                    params=_params(tool["parameters"]),
                    risk="high",
                    requires_confirmation=True,
                    timeout=60,
                    output_limit=1_048_576,
                    source=f"declarative-plugin:{manifest_key}",
                    category="system",
                    should_defer=True,
                    search_hint=f"plugin {candidate.manifest.name} {tool['name']} {tool['description']}",
                )(execute)
                _REGISTERED.add(exposed_name)
    return failures


__all__ = ["register_enabled_declarative_tools"]
