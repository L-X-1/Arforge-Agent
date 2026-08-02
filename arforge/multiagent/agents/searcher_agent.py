"""SearcherAgent — code/memory/web search.

Agentic-first: uses code_search, code_read, list_code_files, and web_search
to find relevant code, files, and information.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class SearcherAgent(SubAgent):
    """SearcherAgent — search specialist: given a query, return most relevant files/memory/resources + summary."""

    role = "SearcherAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)
        messages.append({
            "role": "user",
            "content": (
                f"Search task: {task.goal}\n"
                "Steps:\n"
                "- list_code_files to see project structure\n"
                "- code_search to find relevant code by keyword\n"
                "- code_read or read_file to examine interesting files\n"
                "- Do not repeat equivalent tool calls; once the requested facts are grounded, stop\n"
                "- Summarize findings with file paths and relevance notes\n"
            ),
        })
        return messages
