"""CoderAgent — code implementation and file editing.

Capabilities: safe_modify, code_search, code_review, command_execution
Tools: read_file, write_file, run_cmd, code_read, code_search, list_code_files

Agentic-first: uses full tool loop with function calling to actively read,
search, write, and run code rather than single-shot prompt completion.
"""

from __future__ import annotations

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class CoderAgent(SubAgent):
    """CoderAgent — software engineer: implement requirements, output runnable code + explanation."""

    role = "CoderAgent"

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        """Add coding-specific instructions to the default prompt."""
        messages = super()._build_prompt(task, conversation)

        # Collect dependency context (search results, planner output, etc.)
        dep_context = ""
        if task.depends_on:
            for dep_id in task.depends_on:
                dep_result = conversation.result_for(dep_id)
                if dep_result and dep_result.success:
                    dep_context += f"\nDependency result [{dep_result.role}]:\n{dep_result.output[:1000]}\n"

        # Append coding-specific user message with task detail
        messages.append({
            "role": "user",
            "content": (
                f"Task: {task.goal}\n"
                f"{dep_context}\n"
                "Please implement the code change. Steps:\n"
                "- First use list_code_files and code_search to find relevant files\n"
                "- Read the files that need changes with read_file or code_read\n"
                "- Write your implementation with write_file\n"
                "- Run tests or verify with run_cmd\n"
                "- Explain what you did and why\n"
            ),
        })
        return messages
