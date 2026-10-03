"""Compatibility helpers for a context-aware sub-agent.

The parent may provide context needed to understand a delegated objective, but
authorization is never inherited from that context.  The active execution
boundary must apply the child's explicit role, tool, capability, budget, and
DurableRun binding before any tool is called.  This module only builds the
bounded prompt/configuration envelope; it is not a second run state machine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from arforge.multiagent.agent_types import AgentTypeDef, GENERAL_PURPOSE_AGENT


@dataclass
class ForkSubAgentConfig:
    """Configuration for a fork sub-agent spawn."""
    task: str
    agent_type: AgentTypeDef | None = None
    max_steps: int | None = None
    permission_mode: str = "plan"
    inherit_tools: bool = False
    allowed_tools: tuple[str, ...] = ()
    allowed_capabilities: tuple[str, ...] = ()
    extra_system: str = ""


@dataclass
class ForkResult:
    """Result returned by a fork sub-agent."""
    answer: str
    success: bool
    steps_used: int = 0
    tool_calls: list[dict] = field(default_factory=list)
    error: str | None = None


def build_fork_system_prompt(
    parent_system: str,
    task: str,
    agent_type: AgentTypeDef | None = None,
    extra: str = "",
) -> str:
    """Build the system prompt for a forked sub-agent.

    The parent prompt is context only.  It does not grant the child the
    parent's tools, capabilities, credentials, or approval state.
    """
    parts = [parent_system]

    atype = agent_type or GENERAL_PURPOSE_AGENT
    system_add = atype.get_system_prompt()
    if system_add:
        parts.append(f"\n## Agent Role\n{system_add}")

    parts.append(f"\n## Current Task\n{task}")
    parts.append(
        "\n## Instructions\n"
        "- Parent context is informational; do not infer permissions from it\n"
        "- Use only the explicitly declared child role/tool/capability allowlist\n"
        "- Complete the task using available tools\n"
        "- Return a clear final answer\n"
        "- Report any errors or blockers\n"
        "- Do not ask clarifying questions — make your best judgment\n"
    )

    if extra:
        parts.append(f"\n## Additional Context\n{extra}")

    return "\n".join(parts)


def is_fork_depth_exceeded(messages: list[dict], max_depth: int = 3) -> bool:
    """Guard against recursive forking beyond a safe depth."""
    fork_count = sum(
        1 for m in messages
        if isinstance(m, dict) and "[FORK:" in str(m.get("content", ""))
    )
    return fork_count > max_depth


def format_fork_result_for_parent(result: ForkResult) -> dict[str, Any]:
    """Format a fork result as a message the parent agent can consume."""
    status = "completed" if result.success else "failed"
    return {
        "role": "user",
        "content": (
            f"[FORK:{status}]\n"
            f"Task: {result.answer[:200]}\n"
            f"Steps used: {result.steps_used}\n"
            f"Error: {result.error or 'none'}"
        ),
    }
