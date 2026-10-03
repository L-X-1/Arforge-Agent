"""Built-in tool loading for Arforge Agent.

Both the CLI and Machine Bridge execute the same agentic loop.  Keeping tool
registration in one idempotent place prevents the two surfaces from drifting
apart as capabilities are added.

The TypeScript/Core runtime is the product owner for capabilities that have
already been ported there.  Their Python modules remain available through an
explicit compatibility loader only; they are intentionally absent from the
default Python bootstrap so a legacy schema cannot become a second owner.
"""

from __future__ import annotations

import importlib
import threading


BUILTIN_TOOL_MODULES: tuple[str, ...] = (
    "arforge.tools.basic_tools",
    "arforge.tools.file_tools",
    "arforge.tools.code_tools",
    "arforge.tools.data_tools",
    "arforge.tools.skill_tools",
    "arforge.tools.test_runner_tools",
    "arforge.tools.git_tools",
    "arforge.tools.verify_tools",
    "arforge.tools.subagent_tools",
    "arforge.tools.web_tools",
    "arforge.tools.browser_tools",
    "arforge.tools.computer_tools",
    "arforge.tools.infra_tools",
    "arforge.tools.perception_tools",
    "arforge.tools.permission_tools",
    "arforge.tools.workflow_tools",
    "arforge.tools.regression_tools",
    "arforge.tools.schedule_tools",
    "arforge.tools.tool_search_tools",
    "arforge.tools.team_tools",
)

# Compatibility modules are deliberately opt-in.  The product task graph is
# owned by TypeScript/Core ``TaskGraphV2``; the Python task store is retained
# only for old CLI/embedding callers until their call sites migrate.
COMPATIBILITY_TOOL_MODULES: tuple[str, ...] = (
    "arforge.tools.task_tools",
)

_load_lock = threading.RLock()


def _load_modules(module_names: tuple[str, ...]) -> dict[str, str]:
    """Import a module tuple and return optional-module failures."""

    failures: dict[str, str] = {}
    with _load_lock:
        for module_name in module_names:
            try:
                importlib.import_module(module_name)
            except Exception as exc:  # noqa: BLE001 - optional tool dependency
                failures[module_name] = f"{exc.__class__.__name__}: {exc}"
    return failures


def load_builtin_tools() -> dict[str, str]:
    """Import default Python tools and return optional-module failures.

    Tool modules register themselves through decorators.  A missing optional
    dependency must not prevent a user from starting the agent, so failures are
    isolated per module and returned to callers that want diagnostics.
    """
    failures = _load_modules(BUILTIN_TOOL_MODULES)
    with _load_lock:
        try:
            from arforge.declarative_plugins import register_enabled_declarative_tools

            failures.update(
                {
                    f"plugin:{name}": message
                    for name, message in register_enabled_declarative_tools().items()
                }
            )
        except Exception as exc:  # noqa: BLE001 - one extension cannot block built-ins
            failures["arforge.declarative_plugins"] = f"{exc.__class__.__name__}: {exc}"
    return failures


def load_compatibility_tools() -> dict[str, str]:
    """Explicitly load Python wrappers whose product owner is TypeScript/Core.

    This seam exists for legacy tests, CLI embeddings, and integrations that
    still import the Python API.  Product bootstrap paths must call only
    :func:`load_builtin_tools` and use the canonical TypeScript/Core surface.
    """

    return _load_modules(COMPATIBILITY_TOOL_MODULES)


__all__ = [
    "BUILTIN_TOOL_MODULES",
    "COMPATIBILITY_TOOL_MODULES",
    "load_builtin_tools",
    "load_compatibility_tools",
]
