"""Built-in tool loading for Arforge Agent.

Both the CLI and Machine Bridge execute the same agentic loop.  Keeping tool
registration in one idempotent place prevents the two surfaces from drifting
apart as capabilities are added.
"""

from __future__ import annotations

import importlib
import threading


BUILTIN_TOOL_MODULES: tuple[str, ...] = (
    "arforge.tools.basic_tools",
    "arforge.tools.file_tools",
    "arforge.tools.code_tools",
    "arforge.tools.data_tools",
    "arforge.tools.office_tools",
    "arforge.tools.task_tools",
    "arforge.tools.skill_tools",
    "arforge.tools.symbol_tools",
    "arforge.tools.test_runner_tools",
    "arforge.tools.git_tools",
    "arforge.tools.verify_tools",
    "arforge.tools.subagent_tools",
    "arforge.tools.web_tools",
    "arforge.tools.browser_tools",
    "arforge.tools.computer_tools",
    "arforge.tools.js_tools",
    "arforge.tools.frontend_tools",
    "arforge.tools.asset_tools",
    "arforge.tools.infra_tools",
    "arforge.tools.perception_tools",
    "arforge.tools.permission_tools",
    "arforge.tools.plan_tools",
    "arforge.tools.workflow_tools",
    "arforge.tools.regression_tools",
    "arforge.tools.question_tools",
    "arforge.tools.lsp_tools",
    "arforge.tools.notebook_tools",
    "arforge.tools.worktree_tools",
    "arforge.tools.schedule_tools",
    "arforge.tools.tool_search_tools",
    "arforge.tools.team_tools",
    "arforge.tools.mcp_client_tools",
    "arforge.tools.user_message_tools",
    "arforge.tools.trigger_tools",
    "arforge.tools.wait_tools",
)

_load_lock = threading.RLock()


def load_builtin_tools() -> dict[str, str]:
    """Import built-in tool modules and return optional-module failures.

    Tool modules register themselves through decorators.  A missing optional
    dependency must not prevent a user from starting the agent, so failures are
    isolated per module and returned to callers that want diagnostics.
    """
    failures: dict[str, str] = {}
    with _load_lock:
        for module_name in BUILTIN_TOOL_MODULES:
            try:
                importlib.import_module(module_name)
            except Exception as exc:  # noqa: BLE001 - optional tool dependency
                failures[module_name] = f"{exc.__class__.__name__}: {exc}"
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


__all__ = ["BUILTIN_TOOL_MODULES", "load_builtin_tools"]
