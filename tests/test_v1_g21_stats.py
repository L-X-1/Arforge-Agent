"""阶段 4.3 / G21 CLI stats dashboard 测试。"""

from __future__ import annotations


def test_stats_dashboard_renders_token_cache_and_dogfood(monkeypatch, capsys):
    import arforge.core.dogfood as dogfood
    import arforge.models.token_tracker as token_tracker
    from arforge.cli import _run_stats

    monkeypatch.setattr(
        token_tracker,
        "cumulative_usage",
        lambda: {
            "calls": 3,
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "prompt_cache_hit_tokens": 40,
            "prompt_cache_miss_tokens": 60,
            "cache_hit_rate": 0.4,
        },
    )
    monkeypatch.setattr(
        dogfood,
        "stats",
        lambda: {"total": 2, "success_rate": 0.5, "total_tokens": 70, "total_cost_cny": 0.0123},
    )

    assert _run_stats([]) == 0
    out = capsys.readouterr().out
    assert "Runtime Stats" in out
    assert "Total tokens" in out
    assert "150" in out
    assert "Prompt cache hit rate" in out
    assert "40.0%" in out
    assert "Dogfood runs" in out
    assert "2" in out


def test_stats_dashboard_degrades_when_token_db_unavailable(monkeypatch, capsys):
    import arforge.core.dogfood as dogfood
    import arforge.models.token_tracker as token_tracker
    from arforge.cli import _run_stats

    def boom():
        raise RuntimeError("db offline")

    monkeypatch.setattr(token_tracker, "cumulative_usage", boom)
    monkeypatch.setattr(
        dogfood,
        "stats",
        lambda: {"total": 0, "success_rate": 0.0, "total_tokens": 0, "total_cost_cny": 0.0},
    )

    assert _run_stats([]) == 0
    assert "unavailable (RuntimeError: db offline)" in capsys.readouterr().out
