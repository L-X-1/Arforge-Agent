"""
Fork sub-agent: spawns a child agent that inherits the parent's full
conversation context and system prompt. Based on industry-standard patterns.

When a complex task benefits from full context visibility, the fork mechanism
creates a sub-agent that can see everything the parent can see, avoiding the
context loss that comes with fresh sub-agent spawns.

Key properties:
- Inherits parent's conversation history (messages)
- Inherits parent's system prompt + project conventions
- Shares parent's tool pool
- Runs with configurable permission mode (default: bubble to parent)
- Has its own step budget
- Returns structured result to parent
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
    permission_mode: str = "acceptEdits"
    inherit_tools: bool = True
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

    The fork inherits the parent's system prompt and adds task-specific
    instructions based on the agent type definition.
    """
    parts = [parent_system]

    atype = agent_type or GENERAL_PURPOSE_AGENT
    system_add = atype.get_system_prompt()
    if system_add:
        parts.append(f"\n## Agent Role\n{system_add}")

    parts.append(f"\n## Current Task\n{task}")
    parts.append(
        "\n## Instructions\n"
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
