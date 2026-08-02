from __future__ import annotations

import importlib
import sys

import pytest

from arforge.core.file_state import reset_file_state_tracker


@pytest.fixture
def file_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    reset_file_state_tracker()
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools") or mod.startswith("arforge.tools.code_tools"):
            del sys.modules[mod]
    import arforge.tools.file_tools as ft

    return importlib.reload(ft)


def test_cost_optimization_counts_avoidable_repeated_reads(file_tools, tmp_path):
    from arforge.core.cost_optimization import build_cost_optimization_report

    target = tmp_path / "notes.md"
    target.write_text("repeat me", encoding="utf-8")

    file_tools.read_file("notes.md")
    file_tools.read_file("notes.md")
    file_tools.read_file("notes.md")

    report = build_cost_optimization_report()
    [item] = report["items"]

    assert report["observed_files"] == 1
    assert report["repeated_files"] == 1
    assert report["stale_files"] == 0
    assert report["avoidable_reread_bytes"] == target.stat().st_size * 2
    assert report["estimated_avoidable_chars"] == report["avoidable_reread_bytes"]
    assert item["read_count"] == 3
    assert item["repeated_reads"] == 2
    assert item["changed_since_observed"] is False
    assert "read_file_if_changed" in report["recommendations"][0]


def test_cost_optimization_does_not_count_stale_files_as_avoidable(file_tools, tmp_path):
    from arforge.core.cost_optimization import build_cost_optimization_report

    target = tmp_path / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    file_tools.read_file("app.py")
    file_tools.read_file("app.py")

    target.write_text("value = 2\n", encoding="utf-8")

    report = build_cost_optimization_report()
    [item] = report["items"]

    assert report["observed_files"] == 1
    assert report["repeated_files"] == 1
    assert report["stale_files"] == 1
    assert report["avoidable_reread_bytes"] == 0
    assert item["changed_since_observed"] is True
    assert item["avoidable_reread_bytes"] == 0
    assert any("Re-read changed files" in rec for rec in report["recommendations"])


def test_bridge_exposes_cost_optimization_as_read_only(file_tools, tmp_path):
    from arforge.bridge import dispatch

    target = tmp_path / "cost.txt"
    target.write_text("cost", encoding="utf-8")
    file_tools.read_file("cost.txt")
    file_tools.read_file("cost.txt")

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 2, "version": "1.1", "method": "cost.optimization", "params": {"limit": 10}})
    rejected = dispatch({"id": 3, "version": "1.1", "method": "cost.optimization", "params": {"leak": True}})

    assert "cost.optimization" in described["data"]["methods"]
    assert "cost.optimization" not in described["data"]["mutating_methods"]
    assert response["ok"] is True
    assert response["data"]["observed_files"] == 1
    assert response["data"]["avoidable_reread_bytes"] == target.stat().st_size
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "INVALID_PARAMS"


def test_cli_cost_optimization_and_stats_render_report(file_tools, tmp_path, monkeypatch, capsys):
    import arforge.core.dogfood as dogfood
    import arforge.models.token_tracker as token_tracker
    from arforge.cli import _run_cost_optimization, _run_stats

    target = tmp_path / "ui.txt"
    target.write_text("desktop context", encoding="utf-8")
    file_tools.read_file("ui.txt")
    file_tools.read_file("ui.txt")

    monkeypatch.setattr(
        token_tracker,
        "cumulative_usage",
        lambda: {
            "calls": 1,
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "prompt_cache_hit_tokens": 4,
            "prompt_cache_miss_tokens": 6,
            "cache_hit_rate": 0.4,
        },
    )
    monkeypatch.setattr(
        dogfood,
        "stats",
        lambda: {"total": 0, "success_rate": 0.0, "total_tokens": 0, "total_cost_cny": 0.0},
    )

    assert _run_cost_optimization() == 0
    output = capsys.readouterr().out
    assert "Cost Optimization" in output
    assert "Avoidable reread bytes" in output
    assert "ui.txt" in output

    assert _run_stats([]) == 0
    output = capsys.readouterr().out
    assert "Repeated-read files" in output
    assert str(target.stat().st_size) in output
