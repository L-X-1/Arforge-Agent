"""P1 2.1: Eval task runner — deterministic, local-first agentic evaluation.

Each task runs in an isolated temp workspace.  The runner executes the task
through `run_tool_loop`, then calls the verify function to check results.

EvalTask supports two constructor patterns:
  New:  EvalTask(id, category, prompt, setup, verify, ...)
  Test: EvalTask(task_id, prompt, check=..., judge=..., code_test=..., setup=...)
"""

from __future__ import annotations

import os
import shutil
import inspect
import hashlib
import json
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


DEFAULT_EVAL_TOKEN_BUDGET = 300_000
EVAL_TOKEN_BUDGET_ENV = "ARFORGE_EVAL_TOKEN_BUDGET"


@dataclass
class EvalTask:
    """One evaluation task with setup, prompt, and verification.

    Supports positional constructor: EvalTask(task_id, prompt, check=None)
    and keyword-rich constructor with judge/code_test/setup fields.
    """
    task_id: str
    prompt: str
    check: Callable[[], bool] | None = None
    # Extended fields for LLM-judge and code-execution eval
    judge: str | None = None       # Rubric text for LLM-judge scoring
    code_test: str | None = None   # Test code to run against agent output
    setup: Callable[[], None] | None = None  # Pre-task fixture setup
    # Backward-compat aliases
    id: str = ""                    # Alias for task_id
    category: str = ""
    verify: Callable[[Path], bool] | None = None
    expected_files: list[str] = field(default_factory=list)
    timeout_steps: int = 15
    run_id: str = ""
    suite_id: str = ""
    formal: bool = False
    token_budget: int | None = None

    def __post_init__(self) -> None:
        if self.id and not self.task_id:
            self.task_id = self.id
        if self.task_id and not self.id:
            self.id = self.task_id
        if not self.category:
            self.category = "unknown"
        if self.token_budget is not None and self.token_budget <= 0:
            raise ValueError("token_budget must be positive")


@dataclass
class EvalResult:
    task_id: str
    category: str
    passed: bool
    steps: int
    tools_called: int
    failures: int
    tokens: int
    elapsed_sec: float
    answer: str
    error: str | None = None
    score: float = 0.0
    judge_reason: str | None = None
    cost_cny: float = 0.0
    artifact_path: str | None = None
    trace: list[dict] = field(default_factory=list)
    tool_calls: list[dict] = field(default_factory=list)
    incomplete_report: dict | None = None
    token_budget: int = 0


def resolve_eval_token_budget(task: EvalTask) -> int:
    """Resolve a mandatory positive per-task eval budget."""
    raw: object = getattr(task, "token_budget", None)
    if raw is None:
        raw = os.getenv(EVAL_TOKEN_BUDGET_ENV, str(DEFAULT_EVAL_TOKEN_BUDGET))
    try:
        budget = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{EVAL_TOKEN_BUDGET_ENV} must be a positive integer"
        ) from exc
    if budget <= 0:
        raise ValueError(f"{EVAL_TOKEN_BUDGET_ENV} must be a positive integer")
    return budget


def _enforce_token_budget(result: EvalResult, token_budget: int) -> EvalResult:
    result.token_budget = token_budget
    incomplete_text = json.dumps(
        result.incomplete_report or {}, ensure_ascii=False
    ).casefold()
    overrun = result.tokens > token_budget
    stopped_by_budget = bool(result.incomplete_report) and "budget" in incomplete_text
    if not overrun and not stopped_by_budget:
        return result

    result.passed = False
    result.error = (
        f"eval token budget exceeded ({result.tokens}/{token_budget})"
        if overrun
        else f"eval token budget cannot fit the next model call ({result.tokens}/{token_budget})"
    )
    result.incomplete_report = {
        "stop_reason": "token_budget_exceeded",
        "tokens_used": result.tokens,
        "token_budget": token_budget,
    }
    return result


def default_runner(adapter: Any = None) -> Callable:
    """Return the default agentic runner for eval tasks.

    Args:
        adapter: Optional pre-built model adapter. When None, the active
                 provider configuration adapter is created per task run.
    """

    def run(task: EvalTask, workspace: Path) -> EvalResult:
        from arforge.core.agentic import run_tool_loop
        from arforge.core.budget import (
            budget_scope,
            current_usage,
            install_budget_hooks,
            safe_completion_allowance,
        )
        from arforge.core.permission import permission_scope
        from arforge.tools import load_builtin_tools
        from arforge.product.model_config_runtime import get_model_config
        from arforge.models.token_tracker import token_usage_scope

        load_failures = load_builtin_tools()
        if load_failures:
            names = ", ".join(sorted(load_failures))
            raise RuntimeError(f"built-in tools failed to load: {names}")

        active_adapter = (
            adapter if adapter is not None else get_model_config().create_active_adapter()
        )
        token_budget = resolve_eval_token_budget(task)
        start = time.monotonic()

        # Build messages
        if task.code_test:
            system = (
                "Solve the programming task. Return only complete executable Python code "
                "in one markdown code block, with no file edits or explanatory prose."
            )
        elif task.judge:
            system = "Answer the question directly, accurately, and concisely."
        else:
            system = (
                "You are an expert coding agent. Complete the task in the workspace. "
                "Use tools to read, edit, run commands. Keep changes minimal and correct."
            )
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": task.prompt},
        ]

        if task.judge or task.code_test:
            completion_allowance = safe_completion_allowance(
                messages,
                None,
                available_tokens=token_budget,
            )
            if not completion_allowance:
                return _enforce_token_budget(
                    EvalResult(
                        task_id=task.task_id,
                        category=task.category,
                        passed=False,
                        steps=0,
                        tools_called=0,
                        failures=0,
                        tokens=0,
                        elapsed_sec=round(time.monotonic() - start, 1),
                        answer="",
                        error="eval token budget cannot fit the initial prompt",
                        incomplete_report={
                            "stop_reason": "token_budget_exceeded",
                            "tokens_used": 0,
                            "token_budget": token_budget,
                        },
                    ),
                    token_budget,
                )
            with token_usage_scope(run_id=task.run_id, task_id=task.task_id):
                response = active_adapter.generate_with_tools(
                    messages,
                    tools=None,
                    max_tokens=min(2048, completion_allowance),
                )
            usage = response.usage or {}
            elapsed = time.monotonic() - start
            return _enforce_token_budget(EvalResult(
                task_id=task.task_id,
                category=task.category,
                passed=True,
                steps=1,
                tools_called=0,
                failures=0,
                tokens=int(usage.get("total_tokens", 0) or 0),
                elapsed_sec=round(elapsed, 1),
                answer=response.content[:8000],
            ), token_budget)

        # Load tools schema
        from arforge.tool_registry import REGISTRY
        tools = REGISTRY.to_openai_tools()

        # Eval workspaces are disposable and isolated.  Approve ordinary file
        # edits and project-local commands so the suite can run unattended;
        # network, system, and dangerous categories remain gated by policy.
        install_budget_hooks()
        budget_usage = 0
        with permission_scope("autoApprove"), token_usage_scope(
            run_id=task.run_id,
            task_id=task.task_id,
        ), budget_scope(token_budget):
            result = run_tool_loop(
                active_adapter,
                messages,
                tools=tools,
                max_steps=task.timeout_steps,
                task=task.prompt,
                span_name=f"eval.{task.task_id}",
            )
            budget_state = current_usage() or {}
            budget_usage = int(budget_state.get("used", 0) or 0)

        elapsed = time.monotonic() - start

        obs = result.observability or {}
        summary = obs.get("summary", {})

        return _enforce_token_budget(EvalResult(
            task_id=task.task_id,
            category=task.category,
            passed=result.incomplete_report is None,
            steps=result.steps,
            tools_called=len(result.tool_calls),
            failures=sum(1 for tc in result.tool_calls if not tc.get("success", True)),
            tokens=max(int(summary.get("total_tokens", 0) or 0), budget_usage),
            elapsed_sec=round(elapsed, 1),
            answer=result.answer[:500],
            cost_cny=float(summary.get("cost_cny", 0.0) or 0.0),
            trace=list(result.trace),
            tool_calls=list(result.tool_calls),
            incomplete_report=result.incomplete_report,
        ), token_budget)

    return run


def run_eval(
    tasks: list[EvalTask],
    runner: Callable | None = None,
    *,
    verbose: bool = False,
    suite: str = "core",
    judge_adapter: Any = None,
    failure_artifacts_dir: str | Path | None = None,
    formal: bool = False,
    formal_artifacts_dir: str | Path | None = None,
) -> Any:
    """Run all tasks and return summary + per-task results."""
    if runner is None:
        runner = default_runner()

    results: list[EvalResult] = []
    passed = 0
    total_tokens = 0
    total_cost = 0.0
    total_time = 0.0
    all_scores: list[float] = []
    from arforge.tools.file_tools import get_workspace, set_workspace
    from arforge.workspace_context import execution_scope

    original_workspace = get_workspace()
    suite_run_id = f"{suite}-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    if formal and formal_artifacts_dir is None:
        from arforge.paths import data_path

        formal_artifacts_dir = data_path("formal-dogfood") / suite_run_id

    def tree_digest(root: Path) -> str:
        digest = hashlib.sha256()
        for file_path in sorted(path for path in root.rglob("*") if path.is_file()):
            relative = file_path.relative_to(root).as_posix()
            digest.update(relative.encode("utf-8"))
            try:
                digest.update(file_path.read_bytes())
            except OSError:
                digest.update(b"<unreadable>")
        return digest.hexdigest()

    def persist_formal_evidence(
        task: EvalTask,
        result: EvalResult,
        workspace: Path,
    ) -> str:
        from arforge.core.dogfood import RunOutcome, record_outcome
        from arforge.product.model_config_runtime import get_model_config

        artifact_root = Path(formal_artifacts_dir).resolve()
        artifact_root.mkdir(parents=True, exist_ok=True)
        destination = artifact_root / re.sub(
            r"[^A-Za-z0-9_.-]+", "-", task.task_id
        ).strip("-.")
        if destination.exists():
            destination = artifact_root / (
                destination.name + "-" + uuid.uuid4().hex[:6]
            )
        shutil.copytree(workspace, destination)
        evidence = {
            "schema_version": 1,
            "suite_run_id": suite_run_id,
            "task_id": task.task_id,
            "category": task.category,
            "passed": result.passed,
            "steps": result.steps,
            "tools_called": result.tools_called,
            "failures": result.failures,
            "tokens": result.tokens,
            "token_budget": result.token_budget,
            "elapsed_sec": result.elapsed_sec,
            "workspace_sha256": tree_digest(destination),
            "error": result.error,
            "incomplete_report": result.incomplete_report,
            "tool_calls": result.tool_calls,
            "trace": result.trace,
        }
        evidence_file = destination / "formal-evidence.json"
        evidence_file.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        resolved = get_model_config().get_resolved_config()
        record_outcome(
            RunOutcome(
                task=task.prompt,
                success=result.passed,
                steps=result.steps,
                tool_calls=result.tools_called,
                llm_calls=max(1, result.steps),
                tokens=result.tokens,
                cost_cny=result.cost_cny,
                modified_files=len(
                    [
                        path
                        for path in destination.rglob("*")
                        if path.is_file() and path.name != "formal-evidence.json"
                    ]
                ),
                run_id=suite_run_id,
                task_id=task.task_id,
                suite_id=suite,
                task_category=task.category,
                provider=str(resolved.get("provider", "") or ""),
                model=str(resolved.get("model", "") or ""),
                workspace=str(destination),
                duration_seconds=result.elapsed_sec,
                stop_reason=(
                    "verified"
                    if result.passed
                    else "verification_failed"
                ),
                max_steps=task.timeout_steps,
                formal=True,
                real_model=True,
                isolated_workspace=True,
                verification_passed=result.passed,
                artifact_dir=str(destination),
                verification={
                    "evidence_file": str(evidence_file),
                    "workspace_sha256": evidence["workspace_sha256"],
                    "token_budget": result.token_budget,
                    "verify_kind": (
                        "judge"
                        if task.judge
                        else "code_test"
                        if task.code_test
                        else "workspace"
                    ),
                },
            )
        )
        return str(destination)

    def invoke(active_runner: Callable, task: EvalTask, workspace: Path) -> EvalResult:
        start = time.monotonic()
        try:
            signature = inspect.signature(active_runner)
        except (TypeError, ValueError):
            signature = None
        accepts_workspace = False
        if signature is not None:
            try:
                signature.bind(task, workspace)
                accepts_workspace = True
            except TypeError:
                signature.bind(task.prompt)

        if accepts_workspace:
            raw = active_runner(task, workspace)
        else:
            raw = active_runner(task.prompt)

        if isinstance(raw, EvalResult):
            result = raw
        else:
            summary = (getattr(raw, "observability", None) or {}).get("summary", {}) or {}
            result = EvalResult(
                task_id=task.task_id,
                category=task.category,
                passed=not bool(getattr(raw, "incomplete_report", None)),
                steps=int(summary.get("steps", summary.get("llm_calls", 0)) or 0),
                tools_called=int(summary.get("tool_calls", 0) or 0),
                failures=int(summary.get("failures", summary.get("errors", 0)) or 0),
                tokens=int(summary.get("total_tokens", 0) or 0),
                elapsed_sec=round(time.monotonic() - start, 3),
                answer=str(getattr(raw, "answer", "") or ""),
                cost_cny=float(summary.get("cost_cny", 0.0) or 0.0),
            )

        if task.check is not None:
            try:
                result.passed = result.passed and bool(task.check())
            except Exception:
                result.passed = False
        elif task.verify is not None:
            try:
                result.passed = result.passed and bool(task.verify(workspace))
            except Exception:
                result.passed = False
        elif task.judge or task.code_test:
            result.passed = True
        return result

    for i, task in enumerate(tasks, start=1):
        tid = getattr(task, "task_id", "") or getattr(task, "id", "?")
        task.run_id = suite_run_id
        task.suite_id = suite
        task.formal = formal
        if verbose:
            print(f"  [{i}/{len(tasks)}] {tid} ({task.category})...", end=" ", flush=True)

        workspace = Path(tempfile.mkdtemp(prefix=f"arforge_eval_{tid}_"))
        try:
            set_workspace(workspace)
            # Seed each fixture in the same isolated workspace the agent will
            # receive. Support both setup(workspace) and legacy setup().
            if task.setup is not None:
                try:
                    setup_signature = inspect.signature(task.setup)
                except (TypeError, ValueError):
                    setup_signature = None
                if setup_signature is not None:
                    try:
                        setup_signature.bind(workspace)
                    except TypeError:
                        task.setup()
                    else:
                        task.setup(workspace)
                else:
                    task.setup()

            # Every task needs an isolated change/compaction/report context.
            # Merely swapping the global file-tool workspace left changed-file
            # evidence from the previous task visible to verify_work.
            with execution_scope(
                f"eval:{suite_run_id}:{tid}",
                workspace=workspace,
            ):
                result = invoke(runner, task, workspace)

            # Judge scoring if applicable
            if task.judge:
                if judge_adapter is None:
                    result.passed = False
                    result.score = 0.0
                    result.judge_reason = "judge adapter was not configured"
                    result.error = result.error or result.judge_reason
                else:
                    from arforge.eval.judge import judge_answer
                    judge_result = judge_answer(result.answer, task.judge, judge_adapter)
                    result.score = judge_result.get("score", 0.0)
                    result.judge_reason = judge_result.get("reason", "")
                    if not judge_result.get("passed", False):
                        result.passed = False
            elif task.code_test:
                from arforge.eval.judge import run_code_check
                code_result = run_code_check(result.answer, task.code_test)
                result.score = code_result.get("score", 0.0)
                if not code_result.get("passed", False):
                    result.passed = False
            else:
                result.score = 1.0 if result.passed else 0.0

            if formal:
                result.artifact_path = persist_formal_evidence(
                    task, result, workspace
                )

            if not result.passed and failure_artifacts_dir is not None:
                safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", tid).strip("-.") or "task"
                artifact_root = Path(failure_artifacts_dir).resolve()
                artifact_root.mkdir(parents=True, exist_ok=True)
                artifact = artifact_root / f"{safe_id}-{time.time_ns()}"
                shutil.copytree(workspace, artifact)
                (artifact / "eval-result.json").write_text(
                    json.dumps(
                        {
                            "task_id": result.task_id,
                            "category": result.category,
                            "passed": result.passed,
                            "steps": result.steps,
                            "tools_called": result.tools_called,
                            "failures": result.failures,
                            "tokens": result.tokens,
                            "answer": result.answer,
                            "error": result.error,
                            "judge_reason": result.judge_reason,
                            "incomplete_report": result.incomplete_report,
                            "tool_calls": result.tool_calls,
                            "trace": result.trace,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                result.artifact_path = str(artifact)

            results.append(result)
            if result.passed:
                passed += 1
            all_scores.append(result.score)
            total_tokens += result.tokens
            total_cost += result.cost_cny
            total_time += result.elapsed_sec
            if verbose:
                status = "PASS" if result.passed else "FAIL"
                print(f"{status} ({result.steps} steps, {result.tokens} tokens)")
        except Exception as exc:
            failed_result = EvalResult(
                task_id=tid,
                category=task.category,
                passed=False,
                steps=0,
                tools_called=0,
                failures=0,
                tokens=0,
                elapsed_sec=0.0,
                answer="",
                error=str(exc)[:500],
            )
            if formal:
                try:
                    failed_result.artifact_path = persist_formal_evidence(
                        task, failed_result, workspace
                    )
                except Exception:
                    pass
            results.append(failed_result)
            if verbose:
                print(f"ERROR: {exc!s}")
        finally:
            set_workspace(original_workspace)
            shutil.rmtree(workspace, ignore_errors=True)

    success_rate = passed / len(tasks) if tasks else 0.0
    avg_score = sum(all_scores) / len(all_scores) if all_scores else 0.0

    from arforge.eval.report import EvalCase, EvalReport

    cases = [
        EvalCase(
            task_id=r.task_id,
            category=r.category,
            success=r.passed,
            steps=r.steps,
            tokens=r.tokens,
            error=r.error,
            answer=r.answer,
            score=r.score,
            judge_reason=r.judge_reason,
            artifact_path=r.artifact_path,
            token_budget=r.token_budget,
            cost_cny=r.cost_cny,
            elapsed_sec=r.elapsed_sec,
        )
        for r in results
    ]

    return EvalReport(
        suite=suite,
        cases=cases,
        total=len(tasks),
        passed=passed,
        success_rate=round(success_rate, 3),
        avg_score=round(avg_score, 3),
        total_tokens=total_tokens,
        total_cost_cny=round(total_cost, 6),
        total_elapsed_sec=round(total_time, 6),
    )
