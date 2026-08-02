"""
Enhanced sub-agent type library for Arforge Agent.

Provides specialized agent definitions (GeneralPurpose, Explorer, Planner,
Verifier) following industry-standard patterns. Each agent type has:
- A clear `when_to_use` description (for model routing)
- Tool whitelist
- Max steps budget
- Permission mode
- System prompt builder

These complement the existing multiagent agents (coder, tester, reviewer, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class AgentTypeDef:
    """Definition of a specialized agent type, akin to CC's AgentDefinition."""
    agent_type: str
    when_to_use: str
    tools: list[str] = field(default_factory=list)  # empty = all tools
    max_steps: int = 25
    permission_mode: str = "acceptEdits"
    model: str = "inherit"  # inherit from parent, or specific model
    get_system_prompt: Callable[[], str] = lambda: ""

    def to_dict(self) -> dict:
        return {
            "agent_type": self.agent_type,
            "when_to_use": self.when_to_use,
            "tools": self.tools,
            "max_steps": self.max_steps,
            "permission_mode": self.permission_mode,
            "model": self.model,
        }


# ---------------------------------------------------------------------------
# Built-in agent type definitions
# ---------------------------------------------------------------------------

GENERAL_PURPOSE_AGENT = AgentTypeDef(
    agent_type="general",
    when_to_use="General-purpose coding tasks: fix bugs, add features, refactor, "
                "write tests, answer questions about code. Use this when no "
                "specialized agent is clearly needed.",
    max_steps=25,
    permission_mode="acceptEdits",
    get_system_prompt=lambda: (
        "You are a general-purpose coding assistant. You can read, write, edit, "
        "and search code. Use tools to explore the codebase before making changes. "
        "Verify your changes by running tests. Be thorough and careful."
    ),
)

EXPLORER_AGENT = AgentTypeDef(
    agent_type="explorer",
    when_to_use="Understanding unfamiliar code, searching across the codebase, "
                "finding patterns, tracing dependencies, answering 'how does X work' "
                "questions. Read-only — never modifies files.",
    tools=["read_file", "code_search", "code_symbols", "glob", "grep",
           "git_log", "git_diff", "git_blame"],
    max_steps=20,
    permission_mode="plan",
    get_system_prompt=lambda: (
        "You are a code exploration specialist. Your job is to understand and "
        "explain code, not to modify it. Search thoroughly, trace dependencies, "
        "and provide clear explanations with file references. Never edit files."
    ),
)

PLANNER_AGENT = AgentTypeDef(
    agent_type="planner",
    when_to_use="Before making complex changes: explore the codebase, identify "
                "all files that need changes, assess risk, estimate effort, and "
                "produce a structured plan. Use this for multi-file refactors, "
                "new feature design, or architecture changes.",
    tools=["read_file", "code_search", "code_symbols", "glob", "grep",
           "git_log", "git_diff", "git_status"],
    max_steps=30,
    permission_mode="plan",
    get_system_prompt=lambda: (
        "You are a planning specialist. Before any code changes happen, you "
        "explore the codebase and produce a structured plan. Your output must "
        "include: (1) files to modify, (2) change description per file, "
        "(3) risk assessment, (4) estimated steps, (5) rollback strategy. "
        "Do NOT make any edits — only plan."
    ),
)

VERIFIER_AGENT = AgentTypeDef(
    agent_type="verifier",
    when_to_use="After code changes are made: verify correctness by running tests, "
                "checking for regressions, reviewing the diff, and confirming the "
                "changes match the original intent. Use this after every significant "
                "code modification.",
    tools=["read_file", "run_tests", "git_diff", "code_search",
           "run_cmd", "glob"],
    max_steps=15,
    permission_mode="plan",
    get_system_prompt=lambda: (
        "You are a verification specialist. After code changes are made, you "
        "verify correctness. Run relevant tests, check the diff for issues, "
        "confirm that changes match the original requirements. Report any "
        "problems clearly. Do not make new edits — only verify existing changes."
    ),
)

STATUSLINE_AGENT = AgentTypeDef(
    agent_type="statusline",
    when_to_use="Quick status checks: summarize current git state, show recent "
                "changes, list modified files, check test results. Fast, read-only, "
                "gives the user an at-a-glance project health summary.",
    tools=["git_status", "git_diff", "git_log", "run_tests"],
    max_steps=5,
    permission_mode="plan",
    get_system_prompt=lambda: (
        "You provide quick project status summaries. Report: git branch and "
        "status, recent commits, modified files, and test results. Keep it "
        "concise — this is an at-a-glance health check, not a deep analysis."
    ),
)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_BUILTIN_AGENTS: dict[str, AgentTypeDef] = {
    "general": GENERAL_PURPOSE_AGENT,
    "explorer": EXPLORER_AGENT,
    "planner": PLANNER_AGENT,
    "verifier": VERIFIER_AGENT,
    "statusline": STATUSLINE_AGENT,
}


def get_builtin_agents() -> list[AgentTypeDef]:
    """Return all built-in agent type definitions."""
    return list(_BUILTIN_AGENTS.values())


def get_agent_type(name: str) -> AgentTypeDef | None:
    """Get a built-in agent type by name."""
    return _BUILTIN_AGENTS.get(name)


def register_agent_type(defn: AgentTypeDef) -> None:
    """Register a custom agent type definition."""
    _BUILTIN_AGENTS[defn.agent_type] = defn


def list_agent_types() -> list[str]:
    """List all registered agent type names."""
    return list(_BUILTIN_AGENTS.keys())
