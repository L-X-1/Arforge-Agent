"""Self-correction dogfood evals for real agent recovery behavior.

These evals create small broken projects, run an agent runner, and verify the
workspace state afterwards. The default runner uses the public ``arforge code``
CLI so the same permissions, hooks, file tools, and model path are exercised.
Tests can inject a fake runner to keep the suite deterministic and offline.
"""

from __future__ import annotations

import json
import math
import os
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class SelfCorrectDogfoodTask:
    task_id: str
    category: str
    prompt: str
    setup: Callable[[Path], None]
    verify: Callable[[Path], tuple[bool, str]]


@dataclass
class SelfCorrectDogfoodCase:
    task_id: str
    category: str
    success: bool
    elapsed_sec: float = 0.0
    runner_ok: bool = False
    verified: bool = False
    verification: str = ""
    output_preview: str = ""
    self_correct_signals: list[str] = field(default_factory=list)
    self_correct_summary: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SelfCorrectDogfoodReport:
    suite: str = "self_correct_dogfood"
    cases: list[SelfCorrectDogfoodCase] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.cases)

    @property
    def passed(self) -> int:
        return sum(1 for case in self.cases if case.success)

    @property
    def success_rate(self) -> float:
        return round(self.passed / self.total, 4) if self.total else 0.0

    @property
    def reliability(self) -> dict:
        elapsed = sorted(case.elapsed_sec for case in self.cases)
        runner_passed = sum(1 for case in self.cases if case.runner_ok)
        verified = sum(1 for case in self.cases if case.verified)
        metrics = [case.metrics for case in self.cases]
        p95_index = max(0, math.ceil(len(elapsed) * 0.95) - 1) if elapsed else 0
        return {
            "sample_size": self.total,
            "runner_success_rate": round(runner_passed / self.total, 4) if self.total else 0.0,
            "verification_success_rate": round(verified / self.total, 4) if self.total else 0.0,
            "end_to_end_success_rate": self.success_rate,
            "elapsed_sec_total": round(sum(elapsed), 3),
            "elapsed_sec_p50": round(statistics.median(elapsed), 3) if elapsed else 0.0,
            "elapsed_sec_p95": round(elapsed[p95_index], 3) if elapsed else 0.0,
            "max_steps": max((int(item.get("steps", 0) or 0) for item in metrics), default=0),
            "llm_calls": sum(int(item.get("llm_calls", 0) or 0) for item in metrics),
            "tool_calls": sum(int(item.get("tool_calls", 0) or 0) for item in metrics),
            "total_tokens": sum(int(item.get("total_tokens", 0) or 0) for item in metrics),
            "cost_cny": round(sum(float(item.get("cost_cny", 0.0) or 0.0) for item in metrics), 6),
            "minimum_sample_met": self.total >= 3,
            "reliability_gate_passed": self.total >= 3 and self.success_rate >= 0.8,
        }

    def to_dict(self) -> dict:
        return {
            "suite": self.suite,
            "total": self.total,
            "passed": self.passed,
            "success_rate": self.success_rate,
            "reliability": self.reliability,
            "cases": [case.to_dict() for case in self.cases],
        }


@dataclass
class RunnerResult:
    ok: bool
    output: str = ""
    self_correct_signals: list[str] = field(default_factory=list)
    self_correct_summary: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)


Runner = Callable[[SelfCorrectDogfoodTask, Path], RunnerResult]


def builtin_self_correct_dogfood_tasks() -> list[SelfCorrectDogfoodTask]:
    return [
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-pytest-fix",
            category="test_failure_recovery",
            prompt=(
                "修复这个项目中失败的 pytest。先运行测试，读取失败信息，"
                "定位根因后修改源码，直到 pytest 通过。"
            ),
            setup=_setup_pytest_fix,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-syntax-fix",
            category="syntax_recovery",
            prompt=(
                "修复 app.py 的 Python 语法错误。先运行 py_compile 或测试确认失败，"
                "再精确修改文件，最终确保 python -m py_compile app.py 通过。"
            ),
            setup=_setup_syntax_fix,
            verify=_verify_py_compile_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-wrong-command",
            category="command_recovery",
            prompt=(
                "运行并修复这个项目的测试。注意如果 pytest 命令失败，"
                "请根据错误换一种正确命令或先检查项目文件，不要原样重复。"
            ),
            setup=_setup_command_recovery,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-multifile-regression",
            category="multi_file_regression",
            prompt=(
                "修复这个结账项目的失败测试。先运行测试并读取失败信息，"
                "注意问题可能跨多个文件；不要只修一个断言，最终确保 pytest 通过。"
            ),
            setup=_setup_multifile_regression,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-missing-dependency",
            category="dependency_recovery",
            prompt=(
                "运行并修复这个项目。项目不能依赖安装新的第三方包；"
                "如果遇到缺失依赖，请实现本地等价逻辑或调整代码，最终确保 pytest 通过。"
            ),
            setup=_setup_missing_dependency,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-flaky-test",
            category="flaky_recovery",
            prompt=(
                "修复这个项目的 flaky 测试。先运行测试并读取失败；"
                "不要改测试来放宽断言，要让生产代码确定性通过，最终 pytest 连续通过。"
            ),
            setup=_setup_flaky_test,
            verify=_verify_pytest_passes_twice,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-version-compat",
            category="version_compatibility",
            prompt=(
                "修复这个项目在当前 Python 版本下的失败。先运行测试确认错误；"
                "如果 API 在当前版本不存在，请实现兼容 fallback，最终 pytest 通过。"
            ),
            setup=_setup_version_compatibility,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-merge-conflict",
            category="merge_conflict_recovery",
            prompt=(
                "修复这个项目里的合并冲突。先运行测试或 py_compile 看到错误，"
                "再读取冲突文件，移除冲突标记并保留双方需要的行为，最终 pytest 通过。"
            ),
            setup=_setup_merge_conflict,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-service-timeout",
            category="external_service_recovery",
            prompt=(
                "修复这个订单项目的测试。支付网关可能超时，不要依赖真实外部服务恢复；"
                "读取失败和 README，给生产代码实现可靠 fallback，最终 pytest 通过。"
            ),
            setup=_setup_service_timeout,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-multipackage-contract",
            category="multi_package_contract",
            prompt=(
                "修复这个多包项目的失败测试。先运行测试并读取失败；"
                "问题跨 packages/shared 和 packages/billing，不要只改测试，"
                "需要维护共享契约并让所有 pytest 通过。"
            ),
            setup=_setup_multipackage_contract,
            verify=_verify_pytest_passes,
        ),
        SelfCorrectDogfoodTask(
            task_id="sc-dogfood-large-refactor",
            category="large_repo_refactor",
            prompt=(
                "修复这个较大多模块项目的失败测试。先运行测试并读取失败；"
                "多个 app 模块共享 packages/shared/normalizer.py 的契约，"
                "请修共享根因而不是逐个绕开调用方，最终所有 pytest 通过。"
            ),
            setup=_setup_large_refactor,
            verify=_verify_pytest_passes,
        ),
    ]


def run_self_correct_dogfood(
    tasks: list[SelfCorrectDogfoodTask] | None = None,
    *,
    runner: Runner | None = None,
) -> SelfCorrectDogfoodReport:
    selected = tasks or builtin_self_correct_dogfood_tasks()
    active_runner = runner or default_cli_runner
    report = SelfCorrectDogfoodReport()
    with tempfile.TemporaryDirectory(prefix="arforge_self_correct_dogfood_") as temp:
        root = Path(temp)
        for task in selected:
            workspace = root / task.task_id
            workspace.mkdir(parents=True, exist_ok=True)
            started = time.perf_counter()
            try:
                task.setup(workspace)
                result = active_runner(task, workspace)
                verified, verification = task.verify(workspace)
                success = bool(result.ok and verified)
                report.cases.append(
                    SelfCorrectDogfoodCase(
                        task_id=task.task_id,
                        category=task.category,
                        success=success,
                        elapsed_sec=round(time.perf_counter() - started, 3),
                        runner_ok=result.ok,
                        verified=verified,
                        verification=verification,
                        output_preview=result.output[:800],
                        self_correct_signals=result.self_correct_signals,
                        self_correct_summary=result.self_correct_summary,
                        metrics=result.metrics,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - eval reports failures, not crashes
                report.cases.append(
                    SelfCorrectDogfoodCase(
                        task_id=task.task_id,
                        category=task.category,
                        success=False,
                        elapsed_sec=round(time.perf_counter() - started, 3),
                        error=f"{type(exc).__name__}: {exc}",
                    )
                )
    return report


def default_cli_runner(task: SelfCorrectDogfoodTask, workspace: Path) -> RunnerResult:
    env = os.environ.copy()
    env["ARFORGE_AUTO_APPROVE"] = "1"
    env["ARFORGE_TRUST_WORKSPACE"] = "1"
    env["ARFORGE_WORKSPACE"] = str(workspace)
    env["ARFORGE_HOME"] = str(workspace / ".arforge-home")
    env["ARFORGE_CODE_MAX_STEPS"] = "60"
    env["NO_COLOR"] = "1"
    cmd = [
        sys.executable,
        "-m",
        "arforge.cli",
        "--no-stream",
        "--mode",
        "fullAccess",
        "--json",
        "code",
        task.prompt,
    ]
    proc = subprocess.run(
        cmd,
        cwd=Path.cwd(),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=240,
    )
    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    worker_payload: dict = {}
    for line in reversed((proc.stdout or "").splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "stop_reason" in candidate:
            worker_payload = candidate
            break
    trace_doc = _latest_trace_doc(Path(env["ARFORGE_HOME"]))
    self_correct_summary = (
        worker_payload.get("self_correct", {})
        if worker_payload
        else trace_doc.get("self_correct", {}) if trace_doc else {}
    )
    observability_summary = (
        trace_doc.get("observability", {}).get("summary", {}) if trace_doc else {}
    )
    trace = trace_doc.get("trace", []) if trace_doc else []
    if worker_payload:
        worker_observability = worker_payload.get("observability", {})
        worker_tool_calls = worker_payload.get("tool_calls", [])
        metrics = {
            "steps": int(worker_payload.get("steps", 0) or 0),
            "llm_calls": int(worker_observability.get("llm_calls", 0) or 0),
            "tool_calls": int(
                worker_observability.get("tool_calls", len(worker_tool_calls)) or 0
            ),
            "total_tokens": int(worker_observability.get("total_tokens", 0) or 0),
            "cost_cny": float(worker_observability.get("cost_cny", 0.0) or 0.0),
        }
    else:
        metrics = {
            "steps": max(
                (int(item.get("step", 0) or 0) for item in trace if isinstance(item, dict)),
                default=0,
            ),
            "llm_calls": int(observability_summary.get("llm_calls", 0) or 0),
            "tool_calls": int(observability_summary.get("tool_calls", 0) or 0),
            "total_tokens": int(observability_summary.get("total_tokens", 0) or 0),
            "cost_cny": float(observability_summary.get("cost_cny", 0.0) or 0.0),
        }
    stop_reason = str(self_correct_summary.get("stop_reason", ""))
    return RunnerResult(
        ok=(
            proc.returncode == 0
            and stop_reason != "max_steps"
            and worker_payload.get("success", True) is not False
        ),
        output=output,
        self_correct_signals=_extract_self_correct_signals(output, self_correct_summary),
        self_correct_summary=self_correct_summary,
        metrics=metrics,
    )


def format_self_correct_dogfood_report(report: SelfCorrectDogfoodReport) -> str:
    lines = [
        f"Self-Correct Dogfood: {report.passed}/{report.total} passed ({report.success_rate:.0%})",
    ]
    reliability = report.reliability
    lines.append(
        "Reliability: "
        f"p50={reliability['elapsed_sec_p50']:.1f}s, "
        f"p95={reliability['elapsed_sec_p95']:.1f}s, "
        f"steps<={reliability['max_steps']}, "
        f"tokens={reliability['total_tokens']}, "
        f"gate={'PASS' if reliability['reliability_gate_passed'] else 'INSUFFICIENT/FAIL'}"
    )
    for case in report.cases:
        status = "PASS" if case.success else "FAIL"
        detail = case.verification or case.error
        lines.append(f"- {status} [{case.category}] {case.task_id}: {detail}")
        if case.self_correct_signals:
            lines.append(f"  signals: {', '.join(case.self_correct_signals)}")
    return "\n".join(lines)


def _setup_pytest_fix(workspace: Path) -> None:
    (workspace / "math_utils.py").write_text(
        "def add(a, b):\n"
        "    return a - b\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_math_utils.py").write_text(
        "from math_utils import add\n\n"
        "def test_add():\n"
        "    assert add(2, 3) == 5\n",
        encoding="utf-8",
    )


def _setup_syntax_fix(workspace: Path) -> None:
    (workspace / "app.py").write_text(
        "def greet(name)\n"
        "    return f'hello {name}'\n",
        encoding="utf-8",
    )


def _setup_command_recovery(workspace: Path) -> None:
    _setup_pytest_fix(workspace)
    (workspace / "README.md").write_text(
        "This project has pytest tests. If a command fails, inspect files and use python -m pytest -q.\n",
        encoding="utf-8",
    )


def _setup_multifile_regression(workspace: Path) -> None:
    (workspace / "catalog.py").write_text(
        "def tax_rate(region):\n"
        "    if region == 'CA':\n"
        "        return 0.0\n"
        "    return 0.0\n",
        encoding="utf-8",
    )
    (workspace / "checkout.py").write_text(
        "from catalog import tax_rate\n\n"
        "def total(items, region):\n"
        "    subtotal = sum(item['price'] * item.get('qty', 1) for item in items)\n"
        "    return round(subtotal, 2)\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_checkout.py").write_text(
        "from catalog import tax_rate\n"
        "from checkout import total\n\n"
        "def test_ca_tax_rate():\n"
        "    assert tax_rate('CA') == 0.08\n\n"
        "def test_total_includes_tax():\n"
        "    items = [{'price': 10.0, 'qty': 2}]\n"
        "    assert total(items, 'CA') == 21.6\n",
        encoding="utf-8",
    )


def _setup_missing_dependency(workspace: Path) -> None:
    (workspace / "text_tools.py").write_text(
        "from slugify import slugify\n\n"
        "def make_slug(title):\n"
        "    return slugify(title)\n",
        encoding="utf-8",
    )
    (workspace / "README.md").write_text(
        "Do not install new third-party packages. Keep this project dependency-free.\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_text_tools.py").write_text(
        "from text_tools import make_slug\n\n"
        "def test_make_slug_without_external_dependency():\n"
        "    assert make_slug('Hello, World 2026!') == 'hello-world-2026'\n",
        encoding="utf-8",
    )


def _setup_flaky_test(workspace: Path) -> None:
    (workspace / "token_generator.py").write_text(
        "import random\n\n"
        "def new_token(user_id):\n"
        "    return f'{user_id}-{random.randint(1000, 9999)}'\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_token_generator.py").write_text(
        "from token_generator import new_token\n\n"
        "def test_token_is_stable_for_same_user():\n"
        "    assert new_token('alice') == new_token('alice')\n\n"
        "def test_token_keeps_user_prefix():\n"
        "    assert new_token('alice').startswith('alice-')\n",
        encoding="utf-8",
    )


def _setup_version_compatibility(workspace: Path) -> None:
    (workspace / "compat.py").write_text(
        "from itertools import sliding_window\n\n"
        "def windows(values, size):\n"
        "    return [tuple(item) for item in sliding_window(values, size)]\n",
        encoding="utf-8",
    )
    (workspace / "README.md").write_text(
        "Support the current Python interpreter without installing packages or changing tests.\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_compat.py").write_text(
        "from compat import windows\n\n"
        "def test_sliding_windows_current_python():\n"
        "    assert windows([1, 2, 3, 4], 3) == [(1, 2, 3), (2, 3, 4)]\n",
        encoding="utf-8",
    )


def _setup_merge_conflict(workspace: Path) -> None:
    (workspace / "profile.py").write_text(
        "def display_name(user):\n"
        "<<<<<<< HEAD\n"
        "    return user.get('first_name', '').strip()\n"
        "=======\n"
        "    return user.get('last_name', '').strip()\n"
        ">>>>>>> feature/full-name\n\n"
        "def greeting(user):\n"
        "    return f\"Hello, {display_name(user)}!\"\n",
        encoding="utf-8",
    )
    (workspace / "README.md").write_text(
        "Resolve the conflict by preserving both first_name and last_name in display_name.\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_profile.py").write_text(
        "from profile import display_name, greeting\n\n"
        "def test_display_name_keeps_both_sides():\n"
        "    user = {'first_name': 'Ada', 'last_name': 'Lovelace'}\n"
        "    assert display_name(user) == 'Ada Lovelace'\n\n"
        "def test_greeting_uses_resolved_name():\n"
        "    user = {'first_name': 'Grace', 'last_name': 'Hopper'}\n"
        "    assert greeting(user) == 'Hello, Grace Hopper!'\n",
        encoding="utf-8",
    )


def _setup_service_timeout(workspace: Path) -> None:
    (workspace / "payment_gateway.py").write_text(
        "def charge(order_id, amount):\n"
        "    raise TimeoutError('gateway timeout')\n",
        encoding="utf-8",
    )
    (workspace / "orders.py").write_text(
        "from payment_gateway import charge\n\n"
        "def process_order(order):\n"
        "    receipt = charge(order['id'], order['amount'])\n"
        "    return {'status': 'paid', 'receipt': receipt}\n",
        encoding="utf-8",
    )
    (workspace / "README.md").write_text(
        "If the payment gateway times out, keep the order by returning status 'pending_retry' "
        "with the original order_id. Do not call external services in tests.\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_orders.py").write_text(
        "from orders import process_order\n\n"
        "def test_gateway_timeout_uses_local_fallback():\n"
        "    order = {'id': 'ord-100', 'amount': 42.5}\n"
        "    assert process_order(order) == {'status': 'pending_retry', 'order_id': 'ord-100'}\n",
        encoding="utf-8",
    )


def _setup_multipackage_contract(workspace: Path) -> None:
    shared = workspace / "packages" / "shared"
    billing = workspace / "packages" / "billing"
    shared.mkdir(parents=True)
    billing.mkdir(parents=True)
    (workspace / "packages" / "__init__.py").write_text("", encoding="utf-8")
    (shared / "__init__.py").write_text("", encoding="utf-8")
    (billing / "__init__.py").write_text("", encoding="utf-8")
    (shared / "money.py").write_text(
        "from dataclasses import dataclass\n\n"
        "@dataclass\n"
        "class Money:\n"
        "    amount: float\n"
        "    currency: str\n\n"
        "def format_money(value):\n"
        "    return f\"{value.amount:.2f} {value.currency}\"\n",
        encoding="utf-8",
    )
    (billing / "invoice.py").write_text(
        "from packages.shared.money import Money, format_money\n\n"
        "def invoice_total(line_items):\n"
        "    subtotal = sum(item['price'] * item.get('qty', 1) for item in line_items)\n"
        "    return {'total': format_money(Money(subtotal, 'USD'))}\n",
        encoding="utf-8",
    )
    (workspace / "README.md").write_text(
        "Shared contract: invoice_total must expose total_cents as int and display as '$12.34'. "
        "Keep Money as the shared boundary object used by billing.\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_billing_contract.py").write_text(
        "from packages.billing.invoice import invoice_total\n"
        "from packages.shared.money import Money, format_money\n\n"
        "def test_shared_money_contract_display():\n"
        "    assert format_money(Money(1234, 'USD')) == '$12.34'\n\n"
        "def test_invoice_total_contract():\n"
        "    items = [{'price_cents': 250, 'qty': 2}, {'price_cents': 199, 'qty': 1}]\n"
        "    assert invoice_total(items) == {'total_cents': 699, 'display': '$6.99'}\n",
        encoding="utf-8",
    )


def _setup_large_refactor(workspace: Path) -> None:
    packages = workspace / "packages"
    shared = packages / "shared"
    apps = packages / "apps"
    shared.mkdir(parents=True)
    apps.mkdir(parents=True)
    (packages / "__init__.py").write_text("", encoding="utf-8")
    (shared / "__init__.py").write_text("", encoding="utf-8")
    (apps / "__init__.py").write_text("", encoding="utf-8")
    (shared / "normalizer.py").write_text(
        "def normalize_name(value):\n"
        "    return value.strip()\n",
        encoding="utf-8",
    )
    app_names = ["crm", "billing", "support", "analytics", "notifications", "search"]
    for app in app_names:
        (apps / f"{app}.py").write_text(
            "from packages.shared.normalizer import normalize_name\n\n"
            f"def label(record):\n"
            f"    return '{app}:' + normalize_name(record['name'])\n",
            encoding="utf-8",
        )
    (workspace / "README.md").write_text(
        "All apps share packages/shared/normalizer.py. Fix normalization centrally: "
        "trim whitespace, collapse internal whitespace, and title-case words.\n",
        encoding="utf-8",
    )
    tests = workspace / "tests"
    tests.mkdir()
    (tests / "test_large_refactor.py").write_text(
        "from packages.apps import analytics, billing, crm, notifications, search, support\n"
        "from packages.shared.normalizer import normalize_name\n\n"
        "def test_shared_normalizer_contract():\n"
        "    assert normalize_name('  ada   lovelace ') == 'Ada Lovelace'\n\n"
        "def test_all_apps_use_shared_contract():\n"
        "    record = {'name': '  grace   hopper '}\n"
        "    assert crm.label(record) == 'crm:Grace Hopper'\n"
        "    assert billing.label(record) == 'billing:Grace Hopper'\n"
        "    assert support.label(record) == 'support:Grace Hopper'\n"
        "    assert analytics.label(record) == 'analytics:Grace Hopper'\n"
        "    assert notifications.label(record) == 'notifications:Grace Hopper'\n"
        "    assert search.label(record) == 'search:Grace Hopper'\n",
        encoding="utf-8",
    )


def _verify_pytest_passes(workspace: Path) -> tuple[bool, str]:
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q"],
        cwd=workspace,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    summary = (proc.stdout.strip() or proc.stderr.strip())[-300:]
    return proc.returncode == 0, summary


def _verify_pytest_passes_twice(workspace: Path) -> tuple[bool, str]:
    first_ok, first_summary = _verify_pytest_passes(workspace)
    second_ok, second_summary = _verify_pytest_passes(workspace)
    return first_ok and second_ok, f"run1: {first_summary}\nrun2: {second_summary}"[-300:]


def _verify_py_compile_passes(workspace: Path) -> tuple[bool, str]:
    proc = subprocess.run(
        [sys.executable, "-m", "py_compile", "app.py"],
        cwd=workspace,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    detail = proc.stderr.strip() or proc.stdout.strip() or "py_compile passed"
    return proc.returncode == 0, detail[-300:]


def _latest_trace_doc(home: Path) -> dict:
    runs_dir = home / "runs"
    if not runs_dir.is_dir():
        return {}
    traces = sorted(runs_dir.glob("*.trace.json"), key=lambda item: item.stat().st_mtime)
    if not traces:
        return {}
    try:
        return json.loads(traces[-1].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _extract_self_correct_signals(output: str, summary: dict | None = None) -> list[str]:
    signals: list[str] = []
    events = (summary or {}).get("events", {}) if isinstance(summary, dict) else {}
    event_map = {
        "feedback": "feedback",
        "repeat_blocked": "repeat_block",
        "reflections": "reflection",
        "abort_injected": "abort",
    }
    for key, label in event_map.items():
        if int(events.get(key, 0) or 0) > 0:
            signals.append(label)
    checks = {
        "feedback": "self_correct_feedback",
        "repeat_block": "self_correct_repeat_blocked",
        "reflection": "self_correct_injected",
        "abort": "self_correct_abort",
        "prompt": "Tool failure recovery required",
    }
    for label, needle in checks.items():
        if needle in output and label not in signals:
            signals.append(label)
    return signals


def report_to_json(report: SelfCorrectDogfoodReport) -> str:
    return json.dumps(report.to_dict(), ensure_ascii=False)
