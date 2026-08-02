from __future__ import annotations

import json
from pathlib import Path

from arforge.core.self_correct_dogfood import (
    RunnerResult,
    SelfCorrectDogfoodCase,
    SelfCorrectDogfoodReport,
    builtin_self_correct_dogfood_tasks,
    format_self_correct_dogfood_report,
    default_cli_runner,
    report_to_json,
    run_self_correct_dogfood,
)


def test_builtin_self_correct_dogfood_tasks_start_broken(tmp_path):
    for task in builtin_self_correct_dogfood_tasks():
        workspace = tmp_path / task.task_id
        workspace.mkdir()

        task.setup(workspace)
        verified, _detail = task.verify(workspace)

        assert verified is False


def test_run_self_correct_dogfood_with_fake_runner_passes():
    def runner(task, workspace: Path) -> RunnerResult:
        if task.task_id == "sc-dogfood-syntax-fix":
            (workspace / "app.py").write_text(
                "def greet(name):\n"
                "    return f'hello {name}'\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-multifile-regression":
            (workspace / "catalog.py").write_text(
                "def tax_rate(region):\n"
                "    if region == 'CA':\n"
                "        return 0.08\n"
                "    return 0.0\n",
                encoding="utf-8",
            )
            (workspace / "checkout.py").write_text(
                "from catalog import tax_rate\n\n"
                "def total(items, region):\n"
                "    subtotal = sum(item['price'] * item.get('qty', 1) for item in items)\n"
                "    return round(subtotal * (1 + tax_rate(region)), 2)\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-missing-dependency":
            (workspace / "text_tools.py").write_text(
                "import re\n\n"
                "def make_slug(title):\n"
                "    text = re.sub(r'[^a-zA-Z0-9]+', '-', title.lower()).strip('-')\n"
                "    return re.sub(r'-+', '-', text)\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-flaky-test":
            (workspace / "token_generator.py").write_text(
                "import hashlib\n\n"
                "def new_token(user_id):\n"
                "    suffix = hashlib.sha1(user_id.encode()).hexdigest()[:8]\n"
                "    return f'{user_id}-{suffix}'\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-version-compat":
            (workspace / "compat.py").write_text(
                "def _sliding_window(values, size):\n"
                "    values = list(values)\n"
                "    for index in range(0, max(len(values) - size + 1, 0)):\n"
                "        yield tuple(values[index:index + size])\n\n"
                "def windows(values, size):\n"
                "    return list(_sliding_window(values, size))\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-merge-conflict":
            (workspace / "profile.py").write_text(
                "def display_name(user):\n"
                "    first = user.get('first_name', '').strip()\n"
                "    last = user.get('last_name', '').strip()\n"
                "    return ' '.join(part for part in (first, last) if part)\n\n"
                "def greeting(user):\n"
                "    return f\"Hello, {display_name(user)}!\"\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-service-timeout":
            (workspace / "orders.py").write_text(
                "from payment_gateway import charge\n\n"
                "def process_order(order):\n"
                "    try:\n"
                "        receipt = charge(order['id'], order['amount'])\n"
                "    except TimeoutError:\n"
                "        return {'status': 'pending_retry', 'order_id': order['id']}\n"
                "    return {'status': 'paid', 'receipt': receipt}\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-multipackage-contract":
            (workspace / "packages" / "shared" / "money.py").write_text(
                "from dataclasses import dataclass\n\n"
                "@dataclass\n"
                "class Money:\n"
                "    cents: int\n"
                "    currency: str\n\n"
                "def format_money(value):\n"
                "    prefix = '$' if value.currency == 'USD' else f'{value.currency} '\n"
                "    return f'{prefix}{value.cents / 100:.2f}'\n",
                encoding="utf-8",
            )
            (workspace / "packages" / "billing" / "invoice.py").write_text(
                "from packages.shared.money import Money, format_money\n\n"
                "def invoice_total(line_items):\n"
                "    total_cents = sum(item['price_cents'] * item.get('qty', 1) for item in line_items)\n"
                "    money = Money(total_cents, 'USD')\n"
                "    return {'total_cents': total_cents, 'display': format_money(money)}\n",
                encoding="utf-8",
            )
        elif task.task_id == "sc-dogfood-large-refactor":
            (workspace / "packages" / "shared" / "normalizer.py").write_text(
                "import re\n\n"
                "def normalize_name(value):\n"
                "    return re.sub(r'\\s+', ' ', value.strip()).title()\n",
                encoding="utf-8",
            )
        else:
            source = workspace / "math_utils.py"
            source.write_text(
                source.read_text(encoding="utf-8").replace("return a - b", "return a + b"),
                encoding="utf-8",
            )
        return RunnerResult(
            ok=True,
            output="self_correct_feedback",
            self_correct_signals=["feedback"],
            self_correct_summary={"events": {"feedback": 1}},
        )

    report = run_self_correct_dogfood(runner=runner)

    assert report.total == 11
    assert report.passed == 11
    assert report.success_rate == 1.0
    assert all(case.runner_ok for case in report.cases)
    assert all(case.verified for case in report.cases)
    assert all(case.self_correct_signals == ["feedback"] for case in report.cases)
    assert all(case.self_correct_summary["events"]["feedback"] == 1 for case in report.cases)


def test_run_self_correct_dogfood_records_failed_verification():
    def runner(_task, _workspace: Path) -> RunnerResult:
        return RunnerResult(ok=True, output="claimed success")

    report = run_self_correct_dogfood(
        tasks=builtin_self_correct_dogfood_tasks()[:1],
        runner=runner,
    )

    case = report.cases[0]
    assert report.passed == 0
    assert case.runner_ok is True
    assert case.success is False
    assert "assert" in case.verification or "failed" in case.verification.lower()


def test_run_self_correct_dogfood_treats_max_steps_runner_as_failure():
    def runner(task, workspace: Path) -> RunnerResult:
        source = workspace / "math_utils.py"
        source.write_text(
            source.read_text(encoding="utf-8").replace("return a - b", "return a + b"),
            encoding="utf-8",
        )
        return RunnerResult(ok=False, output="max steps reached", self_correct_summary={"stop_reason": "max_steps"})

    report = run_self_correct_dogfood(
        tasks=builtin_self_correct_dogfood_tasks()[:1],
        runner=runner,
    )

    case = report.cases[0]
    assert case.runner_ok is False
    assert case.success is False
    assert report.passed == 0


def test_format_and_json_report():
    report = SelfCorrectDogfoodReport()
    report.cases.append(
        SelfCorrectDogfoodCase(
            task_id="sc-example",
            category="example",
            success=True,
            verification="ok",
            self_correct_signals=["feedback"],
        )
    )

    text = format_self_correct_dogfood_report(report)
    payload = json.loads(report_to_json(report))

    assert "Self-Correct Dogfood: 1/1 passed" in text
    assert "signals: feedback" in text
    assert payload["suite"] == "self_correct_dogfood"
    assert payload["passed"] == 1
    assert payload["reliability"]["sample_size"] == 1
    assert payload["reliability"]["minimum_sample_met"] is False
    assert payload["cases"][0]["task_id"] == "sc-example"


def test_cli_self_correct_dogfood_requires_api_key(monkeypatch, capsys):
    from arforge.cli import main
    from arforge.product import model_config_runtime

    class MissingConfig:
        def get_resolved_config(self):
            return {"resolved": False, "provider": "deepseek"}

    monkeypatch.setattr(model_config_runtime, "get_model_config", lambda: MissingConfig())

    assert main(["self-correct-dogfood"]) == 1
    assert "arforge auth login deepseek" in capsys.readouterr().err


def test_default_cli_runner_uses_workspace_environment_not_unknown_cli_flag(
    tmp_path,
    monkeypatch,
):
    task = builtin_self_correct_dogfood_tasks()[0]
    captured = {}

    class Completed:
        returncode = 0
        stdout = "done"
        stderr = ""

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs["env"]
        return Completed()

    monkeypatch.setattr("arforge.core.self_correct_dogfood.subprocess.run", fake_run)

    result = default_cli_runner(task, tmp_path)

    assert result.ok is True
    assert "--workspace" not in captured["command"]
    assert "--json" in captured["command"]
    assert captured["env"]["ARFORGE_WORKSPACE"] == str(tmp_path)
    assert captured["command"][-2] == "code"
