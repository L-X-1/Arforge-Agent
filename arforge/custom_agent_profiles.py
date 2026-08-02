"""Validated, project-scoped definitions for specialized sub-agents.

Profiles are data-only JSON files under ``.arforge/agents``. They never
execute project code and remain inactive until workspace trust and an explicit
environment opt-in are present.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from arforge.trust_screen import _auto_trust_enabled, is_workspace_trusted


SCHEMA_VERSION = 1
PROFILE_DIRECTORY = Path(".arforge") / "agents"
ROLE_PREFIX = "CustomAgent."
_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{2,47}$")
_TOOL_RE = re.compile(r"^[a-z][a-z0-9_]{1,79}$")
_SUPPORTED_FIELDS = {
    "schema_version",
    "name",
    "description",
    "system_prompt",
    "tools",
    "capabilities",
    "max_steps",
    "max_tokens",
    "timeout_seconds",
}
_KNOWN_CAPABILITIES = {
    "planning",
    "context_search",
    "safe_modify",
    "code_search",
    "code_review",
    "security_review",
    "test_generation",
    "command_execution",
    "memory_search",
    "multimodal_inspection",
    "data_analysis",
}


class CustomAgentProfileError(ValueError):
    """Raised when a custom agent profile violates the data contract."""


@dataclass(frozen=True)
class CustomAgentProfile:
    """A validated profile that can be represented by the existing agent pool."""

    name: str
    description: str
    system_prompt: str
    tools: tuple[str, ...]
    capabilities: tuple[str, ...]
    max_steps: int
    max_tokens: int
    timeout_seconds: int
    source_path: Path

    @property
    def role_name(self) -> str:
        return f"{ROLE_PREFIX}{self.name}"

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "role": self.role_name,
            "description": self.description,
            "tools": list(self.tools),
            "capabilities": list(self.capabilities),
            "max_steps": self.max_steps,
            "max_tokens": self.max_tokens,
            "timeout_seconds": self.timeout_seconds,
            "path": str(self.source_path),
        }

    def pool_metadata(self) -> dict[str, Any]:
        return {
            "description": self.description,
            "capabilities": list(self.capabilities),
            "tools": list(self.tools),
            "system_prompt": self.system_prompt,
            "max_steps": self.max_steps,
            "max_tokens": self.max_tokens,
            "timeout": self.timeout_seconds,
        }


def profile_directory(workspace: str | Path | None = None) -> Path:
    """Return the fixed profile directory beneath a workspace."""
    root = Path(workspace).resolve() if workspace is not None else Path.cwd().resolve()
    return root / PROFILE_DIRECTORY


def custom_agents_enabled(workspace: str | Path | None = None) -> bool:
    """Require an explicit opt-in as well as established workspace trust."""
    enabled = os.getenv("ARFORGE_ENABLE_CUSTOM_AGENTS", "").strip().casefold()
    if enabled not in {"1", "true", "yes", "on"}:
        return False
    root = Path(workspace).resolve() if workspace is not None else Path.cwd().resolve()
    if workspace is not None:
        return is_workspace_trusted(root)
    return _auto_trust_enabled() or is_workspace_trusted(root)


def known_tool_names() -> set[str]:
    """Return Arforge's own registered tool names for whitelist validation."""
    from arforge.tool_registry import REGISTRY
    from arforge.tools import load_builtin_tools

    load_builtin_tools()
    return set(REGISTRY.tools)


def _require_text(payload: dict[str, Any], field: str, *, minimum: int, maximum: int) -> str:
    value = payload.get(field)
    if not isinstance(value, str):
        raise CustomAgentProfileError(f"{field} must be a string")
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise CustomAgentProfileError(f"{field} must contain {minimum}-{maximum} characters")
    if any(ord(char) < 32 and char not in "\n\t\r" for char in value):
        raise CustomAgentProfileError(f"{field} contains an unsupported control character")
    return value


def _require_integer(payload: dict[str, Any], field: str, *, default: int, minimum: int, maximum: int) -> int:
    value = payload.get(field, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise CustomAgentProfileError(f"{field} must be an integer between {minimum} and {maximum}")
    return value


def _require_string_list(
    payload: dict[str, Any],
    field: str,
    *,
    minimum: int,
    maximum: int,
    allowed: set[str] | None = None,
) -> tuple[str, ...]:
    value = payload.get(field, [] if minimum == 0 else None)
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise CustomAgentProfileError(f"{field} must contain {minimum}-{maximum} items")
    if not all(isinstance(item, str) for item in value):
        raise CustomAgentProfileError(f"{field} must contain only strings")
    normalized = tuple(item.strip() for item in value)
    if any(not item for item in normalized) or len(set(normalized)) != len(normalized):
        raise CustomAgentProfileError(f"{field} cannot contain empty or duplicate values")
    if allowed is not None and any(item not in allowed for item in normalized):
        unknown = sorted(set(normalized) - allowed)
        raise CustomAgentProfileError(f"{field} contains unsupported values: {', '.join(unknown)}")
    return normalized


def parse_custom_agent_profile(payload: Any, *, source_path: str | Path = "<memory>") -> CustomAgentProfile:
    """Validate one data-only profile and return its immutable representation."""
    if not isinstance(payload, dict):
        raise CustomAgentProfileError("profile must be a JSON object")
    unknown_fields = sorted(set(payload) - _SUPPORTED_FIELDS)
    if unknown_fields:
        raise CustomAgentProfileError(f"unsupported fields: {', '.join(unknown_fields)}")
    if payload.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
        raise CustomAgentProfileError(f"schema_version must be {SCHEMA_VERSION}")

    name = _require_text(payload, "name", minimum=3, maximum=48)
    if not _NAME_RE.fullmatch(name):
        raise CustomAgentProfileError("name must be lowercase kebab-case")
    description = _require_text(payload, "description", minimum=1, maximum=500)
    system_prompt = _require_text(payload, "system_prompt", minimum=20, maximum=8000)
    tools = _require_string_list(payload, "tools", minimum=1, maximum=24)
    if any(not _TOOL_RE.fullmatch(tool) for tool in tools):
        raise CustomAgentProfileError("tools must contain registered tool names")
    unsupported_tools = sorted(set(tools) - known_tool_names())
    if unsupported_tools:
        raise CustomAgentProfileError(f"tools contains unsupported values: {', '.join(unsupported_tools)}")
    capabilities = _require_string_list(
        payload,
        "capabilities",
        minimum=0,
        maximum=12,
        allowed=_KNOWN_CAPABILITIES,
    )
    return CustomAgentProfile(
        name=name,
        description=description,
        system_prompt=system_prompt,
        tools=tools,
        capabilities=capabilities,
        max_steps=_require_integer(payload, "max_steps", default=8, minimum=1, maximum=25),
        max_tokens=_require_integer(payload, "max_tokens", default=4096, minimum=256, maximum=16000),
        timeout_seconds=_require_integer(payload, "timeout_seconds", default=60, minimum=10, maximum=600),
        source_path=Path(source_path).resolve(),
    )


def load_custom_agent_profile(path: str | Path, *, workspace: str | Path | None = None) -> CustomAgentProfile:
    """Load a profile only when it is a JSON file inside the project profile directory."""
    root = profile_directory(workspace)
    candidate = Path(path).expanduser().resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise CustomAgentProfileError("profile path must be inside .arforge/agents") from exc
    if candidate.suffix.casefold() != ".json" or not candidate.is_file():
        raise CustomAgentProfileError("profile must be an existing .json file")
    try:
        payload = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CustomAgentProfileError(f"invalid profile JSON: {exc}") from exc
    return parse_custom_agent_profile(payload, source_path=candidate)


def discover_custom_agent_profiles(workspace: str | Path | None = None) -> tuple[list[CustomAgentProfile], list[dict[str, str]]]:
    """Inspect every JSON profile without executing user-provided code."""
    root = profile_directory(workspace)
    if not root.is_dir():
        return [], []
    profiles: list[CustomAgentProfile] = []
    errors: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for path in sorted(root.glob("*.json"), key=lambda item: item.name.casefold()):
        try:
            profile = load_custom_agent_profile(path, workspace=workspace)
            if profile.name in seen_names:
                raise CustomAgentProfileError(f"duplicate profile name: {profile.name}")
            seen_names.add(profile.name)
            profiles.append(profile)
        except CustomAgentProfileError as exc:
            errors.append({"path": str(path.resolve()), "error": str(exc)})
    return profiles, errors


def load_enabled_custom_agent_profiles(workspace: str | Path | None = None) -> tuple[list[CustomAgentProfile], list[dict[str, str]]]:
    """Return profiles for runtime only when all activation guards pass."""
    if not custom_agents_enabled(workspace):
        return [], []
    profiles, errors = discover_custom_agent_profiles(workspace)
    return ([], errors) if errors else (profiles, [])


__all__ = [
    "CustomAgentProfile",
    "CustomAgentProfileError",
    "custom_agents_enabled",
    "discover_custom_agent_profiles",
    "load_custom_agent_profile",
    "load_enabled_custom_agent_profiles",
    "parse_custom_agent_profile",
    "profile_directory",
]
