from __future__ import annotations

from datetime import datetime, timedelta

from arforge.core.runtime_metrics import build_runtime_metrics


def test_runtime_metrics_groups_by_model_and_time_window(monkeypatch):
    now = datetime.now()
    recent = now.strftime("%Y-%m-%dT%H:%M:%S")
    old = (now - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%S")

    monkeypatch.setattr(
        "arforge.models.token_tracker.list_token_usage",
        lambda limit=500: [
            {
                "created_at": recent,
                "model_name": "deepseek-v4-flash",
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150,
                "prompt_cache_hit_tokens": 80,
                "prompt_cache_miss_tokens": 20,
            },
            {
                "created_at": recent,
                "model_name": "deepseek-chat",
                "prompt_tokens": 200,
                "completion_tokens": 100,
                "total_tokens": 300,
                "prompt_cache_hit_tokens": 0,
                "prompt_cache_miss_tokens": 100,
            },
            {
                "created_at": old,
                "model_name": "deepseek-chat",
                "prompt_tokens": 999,
                "completion_tokens": 1,
                "total_tokens": 1000,
                "prompt_cache_hit_tokens": 0,
                "prompt_cache_miss_tokens": 1,
            },
        ],
    )
    monkeypatch.setattr(
        "arforge.core.dogfood.load_outcomes",
        lambda: [
            {"ts": recent, "success": True, "steps": 2, "tokens": 30, "cost_cny": 0.001, "task": "ok"},
            {"ts": recent, "success": False, "steps": 4, "tokens": 40, "cost_cny": 0.002, "task": "fail"},
            {"ts": old, "success": False, "steps": 9, "tokens": 900, "cost_cny": 9.0, "task": "old"},
        ],
    )

    metrics = build_runtime_metrics(window_hours=24, bucket="hour")

    assert metrics["tokens"]["calls"] == 2
    assert metrics["tokens"]["total_tokens"] == 450
    assert metrics["tokens"]["cache_hit_rate"] == 0.4
    assert metrics["tokens"]["estimated_cost_cny"] is None
    assert metrics["tokens"]["cost_status"] == "unavailable"
    assert metrics["tokens"]["unpriced_calls"] == 2
    assert metrics["dogfood"]["total"] == 2
    assert metrics["dogfood"]["success_rate"] == 0.5
    assert [item["model"] for item in metrics["by_model"]] == ["deepseek-chat", "deepseek-v4-flash"]
    assert metrics["series"][0]["calls"] == 2
    assert metrics["series"][0]["dogfood_total"] == 2
    assert any(alert["code"] == "low_dogfood_success_rate" for alert in metrics["alerts"])
    assert any(alert["code"] == "cost_unavailable" for alert in metrics["alerts"])


def test_runtime_metrics_reports_cost_only_when_every_call_is_priced(monkeypatch):
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    monkeypatch.setattr(
        "arforge.models.token_tracker.list_token_usage",
        lambda limit=500: [
            {"created_at": now, "model_name": "model-a", "total_tokens": 10, "estimated_cost_cny": 0.12},
            {"created_at": now, "model_name": "model-a", "total_tokens": 20, "estimated_cost_cny": 0.23},
        ],
    )
    monkeypatch.setattr("arforge.core.dogfood.load_outcomes", lambda: [])

    metrics = build_runtime_metrics()

    assert metrics["tokens"]["estimated_cost_cny"] == 0.35
    assert metrics["tokens"]["cost_status"] == "available"
    assert metrics["by_model"][0]["estimated_cost_cny"] == 0.35


def test_runtime_metrics_degrades_without_breaking_dashboard(monkeypatch):
    def token_boom(limit=500):
        raise RuntimeError("token db offline")

    monkeypatch.setattr("arforge.models.token_tracker.list_token_usage", token_boom)
    monkeypatch.setattr("arforge.core.dogfood.load_outcomes", lambda: [])

    metrics = build_runtime_metrics()

    assert metrics["degraded"] is True
    assert metrics["issues"]["tokens"] == "token db offline"
    assert metrics["tokens"]["calls"] == 0
    assert metrics["series"] == []


def test_runtime_metrics_supports_day_bucket(monkeypatch):
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    monkeypatch.setattr(
        "arforge.models.token_tracker.list_token_usage",
        lambda limit=500: [
            {
                "created_at": now,
                "model_name": "deepseek-v4-flash",
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "prompt_cache_hit_tokens": 1,
                "prompt_cache_miss_tokens": 1,
            }
        ],
    )
    monkeypatch.setattr("arforge.core.dogfood.load_outcomes", lambda: [])

    metrics = build_runtime_metrics(bucket="day")

    assert metrics["window"]["bucket"] == "day"
    assert len(metrics["series"][0]["bucket"]) == 10
