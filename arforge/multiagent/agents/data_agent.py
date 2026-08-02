"""DataAgent — data analysis and visualization.

Agentic-first: loads data, computes statistics, generates charts.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class DataAgent(SubAgent):
    """DataAgent — data analyst: load data -> compute statistics -> generate visualizations (if applicable)."""

    role = "DataAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)
        messages.append({
            "role": "user",
            "content": (
                f"Data analysis task: {task.goal}\n"
                "Steps:\n"
                "- Load and preview data with csv_preview or read_file\n"
                "- Analyze with run_cmd (Python scripts)\n"
                "- Report findings with clear statistics\n"
            ),
        })
        return messages
