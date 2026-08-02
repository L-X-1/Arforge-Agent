"""DebuggerAgent — error diagnosis and fix proposals.

Agentic-first: reads error context, finds relevant code, diagnoses root causes,
and proposes fixes.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class DebuggerAgent(SubAgent):
    """DebuggerAgent — debugging specialist: locate code -> analyze root cause -> propose fix patch."""

    role = "DebuggerAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)
        messages.append({
            "role": "user",
            "content": (
                f"Debugging task: {task.goal}\n"
                "Steps:\n"
                "- Search for the relevant code files with code_search\n"
                "- Read the files to understand the logic\n"
                "- Reproduce the error with run_cmd if applicable\n"
                "- Diagnose root cause and propose a fix\n"
            ),
        })
        return messages
