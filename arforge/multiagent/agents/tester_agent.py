"""TesterAgent — test generation and execution.

Agentic-first: reads code, writes tests, runs them, parses failures.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class TesterAgent(SubAgent):
    """TesterAgent — test engineer: write high-coverage pytest tests, cover happy path/edge cases/error handling."""

    __test__ = False
    role = "TesterAgent"
    prefer_agentic_with_custom_run = True

    def _run(self, task: Task, conversation) -> tuple[str, dict, list, list]:
        messages = self._build_prompt(task, conversation)
        output = self._call_model(messages)
        test_count = len(re.findall(r"(?m)^\s*def\s+test_[A-Za-z0-9_]*\s*\(", output))
        test_results = self._execute_tests(output, task)
        return (
            output,
            {"test_count": test_count, "test_results": test_results},
            [],
            [],
        )

    def _execute_tests(self, generated: str, task: Task) -> dict:
        match = re.search(
            r"```(?:python|py)?\s*\n?(.*?)```",
            generated or "",
            flags=re.DOTALL | re.IGNORECASE,
        )
        code = match.group(1).strip() if match else ""
        if not code:
            return {"success": False, "passed": 0, "failed": 0, "error": "未找到测试代码"}

        temporary_path = ""
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix="_test.py",
                delete=False,
                encoding="utf-8",
            ) as handle:
                handle.write(code)
                temporary_path = handle.name
            completed = subprocess.run(
                [sys.executable, "-m", "pytest", temporary_path, "-q"],
                capture_output=True,
                text=True,
                timeout=max(10, min(self.timeout, 120)),
                check=False,
            )
            output = f"{completed.stdout}\n{completed.stderr}".strip()
            passed_match = re.search(r"(\d+)\s+passed", output)
            failed_match = re.search(r"(\d+)\s+failed", output)
            passed = int(passed_match.group(1)) if passed_match else 0
            failed = int(failed_match.group(1)) if failed_match else 0
            return {
                "success": completed.returncode == 0,
                "passed": passed,
                "failed": failed,
                "exit_code": completed.returncode,
                "output": output[-4000:],
                "error": "" if completed.returncode == 0 else output[-2000:],
                "task_id": task.task_id,
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "passed": 0, "failed": 0, "error": "测试执行超时"}
        except OSError as exc:
            return {"success": False, "passed": 0, "failed": 0, "error": str(exc)}
        finally:
            if temporary_path:
                Path(temporary_path).unlink(missing_ok=True)

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        messages = super()._build_prompt(task, conversation)

        dep_context = ""
        if task.depends_on:
            for dep_id in task.depends_on:
                dep_result = conversation.result_for(dep_id)
                if dep_result and dep_result.success:
                    dep_context += f"\nCode to test [{dep_result.role}]:\n{dep_result.output[:1000]}\n"

        messages.append({
            "role": "user",
            "content": (
                f"Testing task: {task.goal}\n"
                f"{dep_context}\n"
                "Steps:\n"
                "- Find and read the source code to understand what to test\n"
                "- If the task asks only to verify existing tests, do not write files\n"
                "- Prefer run_tests for the current workspace; run_cmd already runs in the workspace, so never use cd\n"
                "- Write test file(s) only when the task explicitly requires new tests\n"
                "- If tests fail, read the error output, fix, and re-run\n"
                "- After a successful test run, stop calling tools and report exact pass/fail counts\n"
            ),
        })
        return messages
