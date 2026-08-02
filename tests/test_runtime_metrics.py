"""Tests for runtime metrics dashboard (T11)."""

import json


class TestRuntimeMetrics:
    """Tests for runtime_metrics.py."""

    def test_collector_singleton(self):
        from arforge.core.runtime_metrics import get_metrics, reset_metrics
        m1 = get_metrics()
        m2 = get_metrics()
        assert m1 is m2
        reset_metrics()

    def test_summary_empty(self):
        from arforge.core.runtime_metrics import MetricsCollector
        collector = MetricsCollector()
        s = collector.summary()
        assert s.total_runs == 0
        assert s.success_rate == 0.0

    def test_record_and_summary(self):
        from arforge.core.runtime_metrics import MetricsCollector, RunMetrics
        collector = MetricsCollector()

        collector.record_run(RunMetrics(
            task="test task",
            success=True,
            steps=5,
            tool_calls=3,
            tokens_total=1000,
            cost_cny=0.05,
            elapsed_ms=1500.0,
            explored_files=3,
            modified_files=1,
            commands_run=2,
        ))
        collector.record_run(RunMetrics(
            task="failed task",
            success=False,
            steps=2,
            tokens_total=500,
            cost_cny=0.02,
        ))

        s = collector.summary()
        assert s.total_runs == 2
        assert s.successful_runs == 1
        assert s.failed_runs == 1
        assert s.success_rate == 0.5
        assert s.total_tokens == 1500
        assert s.total_cost_cny == 0.07
        assert s.total_steps == 7
        assert s.avg_steps_per_run == 3.5
        assert s.total_files_explored == 3
        assert s.total_files_modified == 1

    def test_render(self):
        from arforge.core.runtime_metrics import MetricsCollector, RunMetrics
        collector = MetricsCollector()

        collector.record_run(RunMetrics(
            task="test", success=True, steps=3, tokens_total=800,
            cost_cny=0.03, explored_files=2,
        ))

        text = collector.render()
        assert "Arforge Agent" in text
        assert "Runs:" in text
        assert "Success:" in text
        assert "Tokens:" in text

    def test_render_json(self):
        from arforge.core.runtime_metrics import MetricsCollector, RunMetrics
        collector = MetricsCollector()

        collector.record_run(RunMetrics(task="test", success=True, steps=1))

        json_str = collector.render_json()
        data = json.loads(json_str)
        assert data["total_runs"] == 1
        assert data["success_rate"] == 1.0

    def test_render_empty(self):
        from arforge.core.runtime_metrics import MetricsCollector
        collector = MetricsCollector()
        text = collector.render()
        assert isinstance(text, str)

    def test_reset(self):
        from arforge.core.runtime_metrics import MetricsCollector, RunMetrics
        collector = MetricsCollector()

        collector.record_run(RunMetrics(task="x", success=True, steps=1))
        assert collector.summary().total_runs == 1

        collector.reset()
        assert collector.summary().total_runs == 0

    def test_complexity_distribution(self):
        from arforge.core.runtime_metrics import MetricsCollector, RunMetrics
        collector = MetricsCollector()

        collector.record_run(RunMetrics(task="simple", success=True, complexity_tier="simple"))
        collector.record_run(RunMetrics(task="medium", success=True, complexity_tier="medium"))
        collector.record_run(RunMetrics(task="complex", success=True, complexity_tier="complex"))
        collector.record_run(RunMetrics(task="complex2", success=False, complexity_tier="complex"))

        s = collector.summary()
        assert s.complexity_distribution["simple"] == 1
        assert s.complexity_distribution["medium"] == 1
        assert s.complexity_distribution["complex"] == 2

    def test_run_metrics_to_dict(self):
        from arforge.core.runtime_metrics import RunMetrics
        m = RunMetrics(
            task="test", success=True, steps=3, tokens_total=500,
            cost_cny=0.01, run_id="abc123",
        )
        d = m.to_dict()
        assert d["task"] == "test"
        assert d["success"] is True
        assert d["steps"] == 3
        assert d["tokens_total"] == 500
        assert d["cost_cny"] == 0.01
        assert d["run_id"] == "abc123"
