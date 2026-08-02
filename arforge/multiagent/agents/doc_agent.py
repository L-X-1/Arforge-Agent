"""DocAgent — documentation generation and reading.

Agentic-first: reads code and produces structured documentation.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class DocAgent(SubAgent):
    """DocAgent — documentation specialist: read multimodal resources, output structured summaries."""

    role = "DocAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)
        messages.append({
            "role": "user",
            "content": (
                f"Documentation task: {task.goal}\n"
                "Steps:\n"
                "- Explore relevant code with list_code_files and code_search\n"
                "- Read source files for details\n"
                "- Write documentation with write_file\n"
            ),
        })
        return messages
