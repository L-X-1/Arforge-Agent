"""Ablation eval — enhanced vs bare-model A/B comparison across providers.

提供"增强（工具循环）与裸模型（单次生成）对照"以及跨模型/弱模型评测：
  parse_model_spec         "provider/model" spec 解析
  create_adapter_for       按 provider/model 显式构建模型 adapter
  make_bare_runner         裸模型 runner：不操作工作区，只做单次生成
  run_ablation_eval        多模型对照评测入口（结果追加落盘 JSONL）
  ablation_history         读取历史记录
  clear_ablation_history   清空历史记录
"""

from __future__ import annotations

import json
import os
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from arforge.eval.runner import (
    EvalResult,
    EvalTask,
    _enforce_token_budget,
    default_runner,
    resolve_eval_token_budget,
    run_eval,
)
from arforge.models.model_factory import create_model_adapter
from arforge.product.model_config_runtime import (
    SUPPORTED_PROVIDERS,
    ModelConfigError,
    get_model_config,
)

_PROVIDER_API_KEY_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

_BARE_UNSUPPORTED_MARKER = "bare_unsupported"


def parse_model_spec(spec: str) -> tuple[str, str]:
    """解析模型 spec 为 (provider, model)。

    "deepseek"            -> ("deepseek", "")     空 model 表示用 resolved 默认模型
    "openai/gpt-4o-mini"  -> ("openai", "gpt-4o-mini")
    provider 必须属于 SUPPORTED_PROVIDERS，否则抛 ValueError。
    """
    if not isinstance(spec, str) or not spec.strip():
        raise ValueError("model spec must be a non-empty string")
    text = spec.strip()
    if "/" in text:
        provider, model = text.split("/", 1)
        provider = provider.strip()
        model = model.strip()
    else:
        provider, model = text, ""
    if provider not in SUPPORTED_PROVIDERS:
        supported = ", ".join(sorted(SUPPORTED_PROVIDERS))
        raise ValueError(f"unsupported provider: {provider!r}; supported: {supported}")
    return provider, model


def create_adapter_for(provider: str, model: str = ""):
    """按显式 provider/model 构建模型 adapter（复制 runtime.create_adapter 逻辑）。

    model 为空时使用 resolved 配置的模型；api_key 从环境变量或加密存储解析；
    context_window_tokens 通过 resolve_context_window 设置。解析失败抛
    ModelConfigError/ValueError，由调用方处理。
    """
    runtime = get_model_config()
    resolved = runtime.get_resolved_config(provider)
    resolved_provider = resolved.get("provider")
    if resolved_provider not in SUPPORTED_PROVIDERS:
        raise ModelConfigError("INVALID_PROVIDER_CONFIG", "provider configuration is invalid")
    if resolved.get("error"):
        raise ModelConfigError("INVALID_PROVIDER_CONFIG", str(resolved["error"]))
    resolved_model = str(resolved.get("model", "") or "")
    effective_model = model or resolved_model
    environment_key = _PROVIDER_API_KEY_ENV[resolved_provider]
    adapter = create_model_adapter(
        resolved_provider,
        api_key=os.getenv(environment_key) or runtime.get_api_key(resolved_provider) or None,
        base_url=resolved.get("base_url") or None,
        model=effective_model or None,
    )
    from arforge.core.context import resolve_context_window

    try:
        adapter.context_window_tokens = resolve_context_window(
            effective_model,
            resolved.get("context_window_tokens"),
        ).tokens
    except AttributeError:
        pass
    return adapter


def make_bare_runner(adapter) -> Callable:
    """返回裸模型 runner：`run(task, workspace) -> EvalResult`。

    工作区任务（check/verify）无法由裸模型操作，直接返回 bare_unsupported
    失败结果且不调用模型（省 token，uplift 计算据此排除）；
    judge/code_test 任务走与 default_runner 一致的单次生成分支，实际判定
    由 run_eval 统一执行。
    """

    def run(task: EvalTask, workspace: Path) -> EvalResult:
        from arforge.core.budget import safe_completion_allowance
        from arforge.models.token_tracker import token_usage_scope

        if task.check is not None or task.verify is not None:
            return EvalResult(
                task_id=task.task_id,
                category=task.category,
                passed=False,
                steps=0,
                tools_called=0,
                failures=0,
                tokens=0,
                elapsed_sec=0.0,
                answer="",
                error=f"{_BARE_UNSUPPORTED_MARKER}: bare model cannot operate the workspace",
            )

        token_budget = resolve_eval_token_budget(task)
        start = time.monotonic()
        if task.code_test:
            system = (
                "Solve the programming task. Return only complete executable Python code "
                "in one markdown code block, with no file edits or explanatory prose."
            )
        else:
            system = "Answer the question directly, accurately, and concisely."
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": task.prompt},
        ]

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
            response = adapter.generate_with_tools(
                messages,
                tools=None,
                max_tokens=min(2048, completion_allowance),
            )
        usage = response.usage or {}
        elapsed = time.monotonic() - start
        return _enforce_token_budget(
            EvalResult(
                task_id=task.task_id,
                category=task.category,
                passed=True,
                steps=1,
                tools_called=0,
                failures=0,
                tokens=int(usage.get("total_tokens", 0) or 0),
                elapsed_sec=round(elapsed, 1),
                answer=response.content[:8000],
            ),
            token_budget,
        )

    return run


def _report_stats(report: Any) -> dict:
    """提取报告级聚合指标（elapsed_sec 依赖 EvalCase 后续扩展字段，缺失按 0）。"""
    total_elapsed = 0.0
    for case in report.cases:
        total_elapsed += float(getattr(case, "elapsed_sec", 0.0) or 0.0)
    return {
        "success_rate": round(float(report.success_rate), 3),
        "passed": int(report.passed),
        "total": int(report.total),
        "total_tokens": int(report.total_tokens),
        "total_cost_cny": round(float(report.total_cost_cny), 6),
        "total_elapsed_sec": round(total_elapsed, 1),
    }


def _comparable_rate(report: Any, comparable_ids: set[str]) -> float:
    if not comparable_ids:
        return 0.0
    by_id = {case.task_id: case for case in report.cases}
    passed = sum(1 for tid in comparable_ids if by_id.get(tid) is not None and by_id[tid].success)
    return round(passed / len(comparable_ids), 3)


def _efficiency(stats: dict) -> dict:
    cost = stats["total_cost_cny"]
    elapsed = stats["total_elapsed_sec"]
    tokens = stats["total_tokens"]
    passed = stats["passed"]
    return {
        "success_per_cost_cny": round(passed / cost, 4) if cost > 0 else None,
        "success_per_elapsed_sec": round(passed / elapsed, 4) if elapsed > 0 else None,
        "cost_cny_per_success": round(cost / passed, 6) if passed > 0 else None,
        "tokens_per_success": round(tokens / passed, 1) if passed > 0 else None,
    }


def _ablation_history_path() -> Path:
    home = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return Path(home) / "ablation_results.jsonl"


def _persist_ablation_row(payload: dict) -> None:
    """把本次结果摘要追加到 JSONL（写失败静默）。"""
    try:
        path = _ablation_history_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "ts": payload["generated_at"],
            "specs": list(payload["models"].keys()),
            "models": {
                spec: {
                    "enhanced_success_rate": model["enhanced"]["success_rate"],
                    "uplift": model.get("uplift"),
                }
                for spec, model in payload["models"].items()
            },
            "summary": payload["summary"],
        }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def run_ablation_eval(
    tasks: list[EvalTask],
    *,
    model_specs: list[str],
    judge_adapter: Any = None,
    skip_bare: bool = False,
    verbose: bool = False,
    suite: str = "ablation",
    weak_model_spec: str | None = None,
) -> dict:
    """跑增强/裸模型对照评测并聚合跨模型统计。

    每个 spec 先用 create_adapter_for 建 adapter，跑增强路径（default_runner）
    与裸模型路径（make_bare_runner）；uplift 仅基于可对比任务（judge/code_test）
    计算；结果写入 {ARFORGE_HOME}/ablation_results.jsonl。
    """
    comparable_ids = {
        task.task_id for task in tasks if task.judge is not None or task.code_test is not None
    }
    models: dict[str, dict] = {}
    for spec in model_specs:
        provider, model = parse_model_spec(spec)
        adapter = create_adapter_for(provider, model)
        enhanced = run_eval(
            tasks,
            runner=default_runner(adapter),
            judge_adapter=judge_adapter or adapter,
            verbose=verbose,
            suite=suite,
        )
        bare = None
        if not skip_bare:
            bare = run_eval(
                tasks,
                runner=make_bare_runner(adapter),
                judge_adapter=judge_adapter or adapter,
                verbose=verbose,
                suite=f"{suite}-bare",
            )

        entry: dict[str, Any] = {
            "model": spec,
            "provider": provider,
            "enhanced": _report_stats(enhanced),
            "comparable_tasks": len(comparable_ids),
            "enhanced_rate_on_comparable": _comparable_rate(enhanced, comparable_ids),
            "bare_rate_on_comparable": None,
        }
        if bare is not None:
            bare_stats = _report_stats(bare)
            bare_stats["bare_unsupported"] = sum(
                1
                for case in bare.cases
                if case.error is not None and _BARE_UNSUPPORTED_MARKER in case.error
            )
            entry["bare"] = bare_stats
            entry["bare_rate_on_comparable"] = _comparable_rate(bare, comparable_ids)
        entry["uplift"] = (
            round(entry["enhanced_rate_on_comparable"] - entry["bare_rate_on_comparable"], 3)
            if not skip_bare and comparable_ids
            else None
        )
        entry["efficiency"] = _efficiency(entry["enhanced"])
        models[spec] = entry

    summary: dict[str, Any] = {
        "cross_model_spread": None,
        "cross_model_std": None,
        "best_model": None,
        "worst_model": None,
    }
    if len(models) >= 2:
        rates = [models[spec]["enhanced"]["success_rate"] for spec in model_specs]
        summary["cross_model_spread"] = round(max(rates) - min(rates), 4)
        summary["cross_model_std"] = round(statistics.pstdev(rates), 4)
        best = max(model_specs, key=lambda s: models[s]["enhanced"]["success_rate"])
        worst = min(model_specs, key=lambda s: models[s]["enhanced"]["success_rate"])
        summary["best_model"] = best
        summary["worst_model"] = worst
    if weak_model_spec is not None and weak_model_spec in models:
        summary["weak_model_uplift"] = models[weak_model_spec].get("uplift")

    payload = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "suite": suite,
        "skip_bare": skip_bare,
        "models": models,
        "summary": summary,
        "note": (
            f"{_BARE_UNSUPPORTED_MARKER}: 工作区任务（check/verify）在裸模型 runner 下"
            "不调用模型、直接判失败以节省 token，故从 uplift 计算中排除；"
            "uplift 仅基于可对比任务（judge/code_test）计算。"
        ),
    }
    _persist_ablation_row(payload)
    return payload


def ablation_history(limit: int = 50) -> list[dict]:
    """读取最近的历史记录（每行含 ts/specs/summary），按写入顺序返回。"""
    rows: list[dict] = []
    try:
        lines = _ablation_history_path().read_text(encoding="utf-8").splitlines()
    except OSError:
        return rows
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows[-max(1, limit):]


def clear_ablation_history() -> int:
    """清空历史文件并返回删除的记录数。"""
    path = _ablation_history_path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0
    count = sum(1 for line in lines if line.strip())
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return 0
    return count
