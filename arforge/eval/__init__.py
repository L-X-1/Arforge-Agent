"""P1 2.1: Arforge eval suite — fixed-task agentic evaluation.

Exports:
  builtin_tasks() -> list[EvalTask]      10 tasks across 7 categories
  default_runner() -> callable            agentic runner with isolated workspace
  run_eval(tasks, ...) -> dict            batch runner + scoring
  judge_answer(answer, rubric, adapter)   LLM-judge scoring
  run_code_check(code, test_code)         code execution scoring
"""

from __future__ import annotations

from arforge.eval.judge import judge_answer, run_code_check
from arforge.eval.report import EvalCase, EvalReport
from arforge.eval.runner import EvalResult, EvalTask, default_runner, run_eval
from arforge.eval.tasks import builtin_tasks
from arforge.eval.formal_tasks import builtin_formal_tasks
from arforge.eval.multistack_formal_tasks import builtin_multistack_formal_tasks

__all__ = [
    "EvalCase",
    "EvalReport",
    "EvalResult",
    "EvalTask",
    "builtin_tasks",
    "builtin_formal_tasks",
    "builtin_multistack_formal_tasks",
    "default_runner",
    "judge_answer",
    "run_code_check",
    "run_eval",
]
