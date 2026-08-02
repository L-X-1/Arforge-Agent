"""Acceptance tests for offline dogfood and performance harnesses."""

from dogfood import run_dogfood
from scripts.performance_baseline import measure


def test_offline_dogfood_one_round():
    result = run_dogfood(rounds=1)
    assert result["success"] is True
    assert result["turns"] == 20
    assert result["model_calls"] == 20
    assert result["network_calls"] == 0


def test_performance_harness_smoke():
    results = measure(runs=2)
    assert set(results) == {"package_import", "agent_init", "cli_version", "cli_help", "cli_privacy"}
    assert all(item["p50_ms"] > 0 for item in results.values())
