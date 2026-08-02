"""Public contracts for deterministic learning reflection."""

from __future__ import annotations

import json


class _FakeLearningEngine:
    def consolidate(self):
        return {
            "patterns_found": 3,
            "saved_new": 1,
            "updated_existing": 2,
            "patterns": 3,
            "breakdown": {"failure": 1, "fix": 1, "preference": 1},
        }

    def dream(self):
        return {
            "total_turns": 12,
            "total_failures": 2,
            "total_patterns": 3,
            "insights": ["Success rate is high."],
            "suggestions": ["Keep collecting feedback."],
            "timestamp": "2026-07-16T12:00:00",
        }


def test_learning_dream_consolidates_before_reflection(monkeypatch):
    import arforge.learning_engine as learning_engine

    fake = _FakeLearningEngine()
    monkeypatch.setattr(learning_engine, "get_learning_engine", lambda: fake)

    result = learning_engine.run_learning_dream()

    assert result["consolidation"]["saved_new"] == 1
    assert result["dream"]["total_turns"] == 12


def test_learning_dream_cli_returns_json(monkeypatch, capsys):
    import arforge.learning_engine as learning_engine
    from arforge.cli import main

    monkeypatch.setattr(learning_engine, "get_learning_engine", lambda: _FakeLearningEngine())

    assert main(["learning", "dream", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["consolidation"]["updated_existing"] == 2
    assert payload["dream"]["insights"] == ["Success rate is high."]


def test_learn_dream_slash_returns_a_human_readable_summary(monkeypatch):
    import arforge.learning_engine as learning_engine
    from arforge.slash_memory_learning import learning_command

    monkeypatch.setattr(learning_engine, "get_learning_engine", lambda: _FakeLearningEngine())

    result = learning_command("dream")

    assert "Learning Reflection" in result
    assert "1 new" in result
    assert "Success rate is high." in result
