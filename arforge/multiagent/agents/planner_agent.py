"""PlannerAgent — task decomposition and solution design.

Agentic-first: explores codebase, reads context, and produces structured plans.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class PlannerAgent(SubAgent):
    """PlannerAgent — planning specialist: decompose goals into 3-7 steps with title/detail/risk/depends_on."""

    role = "PlannerAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)
        messages.append({
            "role": "user",
            "content": (
                f"Planning task: {task.goal}\n"
                "Steps:\n"
                "- Explore the codebase with list_code_files and code_search\n"
                "- Read relevant files for context\n"
                "- Produce a structured plan with ordered steps\n"
                "- For each step: title, detail, risk, depends_on\n"
            ),
        })
        return messages
