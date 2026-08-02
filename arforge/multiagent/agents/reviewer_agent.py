"""ReviewerAgent — code review and security audit.

Agentic-first: reads code files, searches for patterns, and produces structured
review results with severity classification.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class ReviewerAgent(SubAgent):
    """ReviewerAgent — senior reviewer: find bugs/security/performance/style issues, classify by severity."""

    role = "ReviewerAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)

        dep_context = ""
        if task.depends_on:
            for dep_id in task.depends_on:
                dep_result = conversation.result_for(dep_id)
                if dep_result and dep_result.success:
                    dep_context += f"\nCode to review [{dep_result.role}]:\n{dep_result.output[:1000]}\n"

        messages.append({
            "role": "user",
            "content": (
                f"Review task: {task.goal}\n"
                f"{dep_context}\n"
                "Steps:\n"
                "- Find and read the code files with list_code_files and read_file\n"
                "- Search for security patterns with code_search\n"
                "- Do not repeat equivalent tool calls; stop once the requested review is grounded\n"
                "- Produce a structured review with severity ratings\n"
            ),
        })
        return messages
