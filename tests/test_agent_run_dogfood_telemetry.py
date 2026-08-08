"""AgentRun 生产 dogfood 遥测断点测试。

覆盖：record_dogfood_outcome 写出合法行（含 failed_tool_calls 与 record_hash）、
旧格式行兼容、RunMetrics 字段、_dogfood_payload 字段映射、execute() 接线传参。
"""

from __future__ import annotations

import json

import pytest

from arforge.core.dogfood import _record_hash_valid, load_outcomes, record_dogfood_outcome, stats
from arforge.core.runtime_metrics import RunMetrics


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))  # 隔离 dogfood.jsonl
    yield


def test_record_dogfood_outcome_writes_valid_row():
    assert record_dogfood_outcome(
        task="t1",
        success=True,
        run_id="run-1",
        steps=3,
        tool_calls=5,
        failed_tool_calls=2,
        tokens=100,
        cost_cny=0.01,
        modified_files=2,
        duration_seconds=4.0,
        stop_reason="final",
        verification={"records": [{"tool": "run_tests", "passed": True}]},
        verification_passed=True,
    )
    rows = load_outcomes()
    assert len(rows) == 1
    row = rows[0]
    assert row["task"] == "t1"
    assert row["success"] is True
    assert row["failed_tool_calls"] == 2
    assert row["verification_passed"] is True
    assert row["verification"] == {"records": [{"tool": "run_tests", "passed": True}]}
    assert _record_hash_valid(row)


def test_record_dogfood_outcome_failure_keeps_error():
    assert record_dogfood_outcome(
        task="t2",
        success=False,
        error="boom",
        run_id="run-2",
        failed_tool_calls=3,
    )
    rows = load_outcomes()
    assert len(rows) == 1
    assert rows[0]["success"] is False
    assert rows[0]["verification"] == {"error": "boom"}
    assert _record_hash_valid(rows[0])


def test_legacy_row_without_failed_tool_calls_is_readable(tmp_path, monkeypatch):
    from arforge.core.dogfood import _dogfood_file

    f = _dogfood_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        json.dumps(
            {
                "task": "legacy",
                "success": True,
                "steps": 1,
                "tool_calls": 2,
                "ts": "2024-01-01 00:00:00",
                "schema_version": 2,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    rows = load_outcomes()
    assert len(rows) == 1
    assert rows[0]["task"] == "legacy"
    assert rows[0].get("failed_tool_calls", 0) == 0
    s = stats()
    assert s["total"] == 1
    assert s["passed"] == 1


def test_run_metrics_to_dict_includes_failed_tool_calls():
    metrics = RunMetrics(
        task="t",
        success=True,
        steps=2,
        tool_calls=4,
        failed_tool_calls=1,
        tokens_total=50,
    )
    d = metrics.to_dict()
    assert d["failed_tool_calls"] == 1
    assert d["tool_calls"] == 4
    assert d["tokens_total"] == 50


def test_dogfood_payload_maps_loop_fields():
    from arforge.core.agent_run import RunResult, RunState, _dogfood_payload

    result = RunResult(run_id="run-payload", state=RunState.COMPLETED)
    result.budget_used = {"tokens_used": 120, "elapsed_seconds": 3}
    result.report = {"modified_files": ["a.py", "b.py"]}

    class FakeLoop:
        steps = 3
        tool_calls = [{"success": False}]
        verifications = [{"passed": True}, {"passed": False}]
        incomplete_report = {
            "failures": 2,
            "tools_called": 5,
            "stop_reason": "max_steps",
            "max_steps": 10,
        }

    payload = _dogfood_payload(result, FakeLoop(), 6.5)
    assert payload["steps"] == 3
    assert payload["tool_calls"] == 1  # len(loop_result.tool_calls) 优先
    assert payload["failed_tool_calls"] == 2  # incomplete_report.failures 优先
    assert payload["tokens"] == 120
    assert payload["modified_files"] == 2
    assert payload["duration_seconds"] == 6.5
    assert payload["stop_reason"] == "max_steps"
    assert payload["max_steps"] == 10
    assert payload["verification_passed"] is True
    assert payload["verification"] == {
        "records": [{"passed": True}, {"passed": False}]
    }


def test_dogfood_payload_fallback_to_result_and_none_loop():
    from arforge.core.agent_run import RunResult, RunState, _dogfood_payload

    result = RunResult(run_id="run-fallback", state=RunState.COMPLETED)
    result.steps = 4
    result.tool_calls = [{"success": True}, {"success": False}]
    result.verifications = [{"passed": True}]
    payload = _dogfood_payload(result, None, 2.0)
    assert payload["steps"] == 4
    assert payload["tool_calls"] == 2
    assert payload["failed_tool_calls"] == 1
    assert payload["verification_passed"] is True
    assert payload["verification"] == {"records": [{"passed": True}]}


def test_execute_success_path_records_dogfood_and_metrics(monkeypatch):
    from arforge.core import agent_loop_v2, agent_run
    from arforge.core.agent_run import AgentRun, RunState
    from arforge.core.agentic import ToolLoopResult

    captured = {}

    class StubLoop:
        def __init__(self, agent):
            self.agent = agent

        def run_agentic(self, **_kwargs):
            return ToolLoopResult(
                answer="done",
                messages=[{"role": "user", "content": "Repair cache"}],
                steps=2,
                tool_calls=[{"success": True}, {"success": False}],
                verifications=[{"tool": "run_tests", "criterion": "pass", "passed": True}],
            )

    def fake_dogfood(**kwargs):
        captured["dogfood"] = kwargs

    def fake_metrics(self, metrics):
        captured["metrics"] = metrics.to_dict()

    monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", StubLoop)
    monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
    monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
    monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
    monkeypatch.setattr(agent_run, "persist_run_transaction", lambda _run_id: None)
    monkeypatch.setattr(agent_run, "save_run_messages", lambda _run_id, _messages: None)
    monkeypatch.setattr(agent_run, "get_run_report", lambda: None)
    monkeypatch.setattr("arforge.core.dogfood.record_dogfood_outcome", fake_dogfood)
    monkeypatch.setattr("arforge.core.runtime_metrics.get_metrics", lambda: type("M", (), {"record_run": fake_metrics})())

    result = AgentRun(
        run_id="run-telemetry-ok",
        agent=object(),
        user_input="Repair cache",
    ).execute()

    assert result.state is RunState.COMPLETED
    assert captured["dogfood"]["task"] == "Repair cache"
    assert captured["dogfood"]["success"] is True
    assert captured["dogfood"]["steps"] == 2
    assert captured["dogfood"]["tool_calls"] == 2
    assert captured["dogfood"]["failed_tool_calls"] == 1
    assert captured["dogfood"]["verification_passed"] is True
    assert captured["metrics"]["success"] is True
    assert captured["metrics"]["failed_tool_calls"] == 1
    assert captured["metrics"]["run_id"] == "run-telemetry-ok"


def test_execute_exception_path_records_dogfood_and_metrics(monkeypatch):
    from arforge.core import agent_loop_v2, agent_run
    from arforge.core.agent_run import AgentRun, RunState

    captured = {}

    class FailingLoop:
        def __init__(self, agent):
            self.agent = agent

        def run_agentic(self, **_kwargs):
            raise RuntimeError("tool failed")

    def fake_dogfood(**kwargs):
        captured["dogfood"] = kwargs

    def fake_metrics(self, metrics):
        captured["metrics"] = metrics.to_dict()

    monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", FailingLoop)
    monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
    monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
    monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
    monkeypatch.setattr(agent_run, "revert_run", lambda _run_id: ([], [], []))
    monkeypatch.setattr("arforge.core.dogfood.record_dogfood_outcome", fake_dogfood)
    monkeypatch.setattr("arforge.core.runtime_metrics.get_metrics", lambda: type("M", (), {"record_run": fake_metrics})())

    result = AgentRun(
        run_id="run-telemetry-err",
        agent=object(),
        user_input="Repair cache",
    ).execute()

    assert result.state is RunState.ROLLED_BACK
    assert captured["dogfood"]["task"] == "Repair cache"
    assert captured["dogfood"]["success"] is False
    assert captured["dogfood"]["error"] == "tool failed"
    assert captured["dogfood"]["failed_tool_calls"] == 0
    assert captured["metrics"]["success"] is False
    assert captured["metrics"]["run_id"] == "run-telemetry-err"
