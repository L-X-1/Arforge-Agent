"""CoordinatorAgent — bridges AgentRun state machine with multi-agent orchestration (WP-14).

The Coordinator is the top-level execution entry point. It decides whether a task
needs multi-agent decomposition or can be handled by a single agent, then executes
through the appropriate path while maintaining the AgentRun state machine contract.

Architecture:
    CoordinatorAgent
    ├── AgentRun (state machine, budget, file tracking, rollback)
    │   └── AgentLoopV2 (tool loop)
    └── MasterAgent (multi-agent decomposition)
        ├── TaskDispatcher
        ├── SubAgentPool
        └── ResultMerger

Worker roles with scratchpads and tool allowlists are defined here as the single
source of truth for role contracts.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from arforge.core.agent_run import AgentRun, RunResult
from arforge.core.budget import WorkBudget
from arforge.core.file_state import FileStateTracker


# ---------------------------------------------------------------------------
# Worker role definitions (WP-14: scratchpad + role contracts)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WorkerRole:
    """A subagent role with tool allowlist and capability contract."""
    role_id: str
    display_name: str
    description: str
    tools: tuple[str, ...]          # Tool names this role may use
    capabilities: tuple[str, ...]   # Capability tags
    read_only: bool = True          # Whether this role can write files
    max_steps: int = 15             # Budget per subagent task
    system_prompt_suffix: str = ""  # Additional instructions


# Canonical worker roles
WORKER_ROLES: dict[str, WorkerRole] = {
    "explorer": WorkerRole(
        role_id="explorer",
        display_name="Code Explorer",
        description="Read-only exploration: searches code, reads files, finds patterns.",
        tools=("code_read", "code_search", "grep_search", "list_files", "code_symbols"),
        capabilities=("code_search", "file_read", "symbol_lookup"),
        read_only=True,
        max_steps=10,
        system_prompt_suffix="You are an explorer. Read code, search for patterns, "
        "and report what you find. Never modify files.",
    ),
    "planner": WorkerRole(
        role_id="planner",
        display_name="Task Planner",
        description="Analyzes requirements and produces structured task plans.",
        tools=("update_plan", "code_read", "code_search", "code_symbols"),
        capabilities=("task_planning", "dependency_analysis"),
        read_only=True,
        max_steps=8,
        system_prompt_suffix="You are a planner. Read the codebase, understand the "
        "requirements, and produce a structured plan. Never modify files.",
    ),
    "implementer": WorkerRole(
        role_id="implementer",
        display_name="Code Implementer",
        description="Writes and edits code, applies patches, runs commands.",
        tools=("edit_file", "write_file", "apply_patch_batch", "run_cmd",
               "code_read", "code_search"),
        capabilities=("code_write", "file_edit", "patch_apply"),
        read_only=False,
        max_steps=20,
        system_prompt_suffix="You are an implementer. Write code, edit files, "
        "and run commands to verify your changes.",
    ),
    "reviewer": WorkerRole(
        role_id="reviewer",
        display_name="Code Reviewer",
        description="Reviews changes for correctness, style, and safety.",
        tools=("code_read", "code_search", "verify_work", "run_impacted_tests",
               "run_cmd"),
        capabilities=("code_review", "quality_check", "test_verification"),
        read_only=True,
        max_steps=12,
        system_prompt_suffix="You are a reviewer. Inspect changes, run tests, "
        "and report issues. Never modify files yourself.",
    ),
    "tester": WorkerRole(
        role_id="tester",
        display_name="Test Writer",
        description="Writes and runs tests for changed code.",
        tools=("write_file", "edit_file", "run_cmd", "run_tests",
               "code_read", "code_search"),
        capabilities=("test_writing", "test_execution"),
        read_only=False,
        max_steps=15,
        system_prompt_suffix="You are a test writer. Write tests for the changed "
        "code, run them, and report results. Only write test files.",
    ),
}


def get_role(role_id: str) -> WorkerRole | None:
    return WORKER_ROLES.get(role_id)


def list_roles() -> list[WorkerRole]:
    return sorted(WORKER_ROLES.values(), key=lambda r: r.role_id)


# ---------------------------------------------------------------------------
# CoordinatorAgent
# ---------------------------------------------------------------------------


@dataclass
class CoordinatorAgent:
    """Top-level agent that routes between single-agent and multi-agent execution.

    Usage::

        coordinator = CoordinatorAgent()
        result = coordinator.execute("Add authentication to the API")
        print(result.answer)
        print(result.mode)  # "single" or "multi"
    """

    # Configuration
    force_single: bool = False          # Skip multi-agent even for complex tasks
    force_multi: bool = False           # Always use multi-agent
    max_iterations: int = 3             # Max refinement iterations
    budget: WorkBudget | None = None    # Shared budget across all agents

    # Runtime state
    agent: Any = None
    file_tracker: FileStateTracker | None = None
    _master_agent: Any = None

    def __post_init__(self) -> None:
        self.file_tracker = FileStateTracker()

    # -- execution -----------------------------------------------------------

    def execute(self, user_input: str, **kwargs) -> RunResult:
        """Execute a user task through the appropriate path.

        Simple tasks go through single-agent (AgentRun + tool loop).
        Complex tasks go through multi-agent (MasterAgent decomposition).
        """
        started = time.perf_counter()

        # Determine path
        use_multi = self._should_use_multi(user_input)

        if use_multi:
            result = self._execute_multi(user_input, **kwargs)
        else:
            result = self._execute_single(user_input, **kwargs)

        result.elapsed_seconds = round(time.perf_counter() - started, 3)
        return result

    # -- path selection ------------------------------------------------------

    def _should_use_multi(self, user_input: str) -> bool:
        if self.force_single:
            return False
        if self.force_multi:
            return True
        # Heuristic: short/simple queries don't need multi-agent
        words = len(user_input.split())
        complexity_markers = (
            "refactor", "migrate", "restructure", "multi-file", "整个",
            "全部", "所有", "batch", "parallel", "concurrent",
        )
        is_complex = words > 30 or any(m in user_input.lower() for m in complexity_markers)
        return is_complex

    # -- single-agent path ---------------------------------------------------

    def _execute_single(self, user_input: str, **kwargs) -> RunResult:
        run = AgentRun(budget=self.budget)
        run.user_input = user_input
        run.agent = self.agent
        run.extra_system = kwargs.get("extra_system", "")
        run.max_steps = kwargs.get("max_steps")
        run.on_token = kwargs.get("on_token")
        return run.execute()

    # -- multi-agent path ----------------------------------------------------

    def _execute_multi(self, user_input: str, **kwargs) -> RunResult:
        """Execute through MasterAgent multi-agent pipeline."""
        from arforge.multiagent.master_agent import MasterAgent

        if self._master_agent is None:
            self._master_agent = MasterAgent(agent=self.agent)

        master: MasterAgent = self._master_agent
        master.max_iterations = self.max_iterations

        raw_result = master.handle(user_input)
        answer = raw_result.get("answer", "")
        mode = raw_result.get("mode", "multi")
        agents_used = raw_result.get("agents_used", 0)
        conv_id = raw_result.get("conversation_id", "")
        cancelled = bool(raw_result.get("cancelled"))
        try:
            failed_count = max(0, int(raw_result.get("failed_count", 0) or 0))
        except (TypeError, ValueError):
            failed_count = 0
        raw_success = raw_result.get("success")

        from arforge.core.agent_run import RunResult as RR, RunState as RS

        # Older master implementations returned no explicit success bit for a
        # single-agent fallback. Preserve that successful legacy outcome, but
        # never turn an explicit failed, cancelled, or incomplete orchestration
        # into a completed run.
        if cancelled:
            state = RS.INTERRUPTED
            error = str(raw_result.get("cancel_reason") or "multi-agent run was cancelled")
            incomplete_report = None
        elif raw_success is True or (raw_success is None and failed_count == 0):
            state = RS.COMPLETED
            error = None
            incomplete_report = None
        elif failed_count > 0:
            state = RS.FAILED
            error = f"{failed_count} delegated task(s) failed"
            incomplete_report = None
        else:
            state = RS.INCOMPLETE
            error = "multi-agent run stopped before all delegated tasks completed"
            incomplete_report = {
                "stop_reason": "multiagent_incomplete",
                "iterations": raw_result.get("iterations", 0),
                "task_count": raw_result.get("task_count", 0),
            }

        return RR(
            run_id=conv_id or "multi",
            state=state,
            answer=f"[{mode} mode, {agents_used} agents]\n\n{answer}",
            intent="multiagent",
            steps=raw_result.get("iterations", 0),
            budget_used={"tokens_used": raw_result.get("tokens_estimated", 0)},
            error=error,
            incomplete_report=incomplete_report,
            observability=raw_result.get("observability"),
        )

    # -- worker helpers ------------------------------------------------------

    def spawn_worker(self, role_id: str, task: str) -> RunResult | None:
        """Spawn a subagent with a specific role to handle a subtask."""
        role = get_role(role_id)
        if role is None:
            return None

        # Create a restricted AgentRun for this worker
        worker_budget = WorkBudget(max_steps=role.max_steps)
        run = AgentRun(budget=worker_budget)
        run.user_input = task
        run.agent = self.agent
        run.extra_system = role.system_prompt_suffix

        # Tool filtering: restrict to role's allowlist
        from arforge.tool_registry import REGISTRY
        allowed = set(role.tools)
        try:
            REGISTRY.push_filter(allowed)  # Activate role-scoped tool filter
            run_result = run.execute()
        finally:
            REGISTRY.pop_filter()  # Restore full tool set

        return run_result
        return run.execute()

    def file_stats(self) -> dict:
        """Return file tracking statistics for the current session."""
        if self.file_tracker:
            return self.file_tracker.get_stats()
        return {}
