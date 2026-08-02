from __future__ import annotations

import json
from pathlib import Path

import pytest

from arforge.bridge import dispatch
from arforge.product.feedback_runtime import FeedbackRuntime, FeedbackRuntimeError


def _runtime(tmp_path: Path) -> FeedbackRuntime:
    return FeedbackRuntime(tmp_path / "feedback.db")


def test_feedback_is_local_redacted_listed_and_summarized(tmp_path: Path):
    runtime = _runtime(tmp_path)
    secret = "sk-" + "Q" * 38

    first = runtime.submit(
        category="bug",
        rating=2,
        message=f"Command failed with api_key={secret}",
        session_id="session-1",
    )
    runtime.submit(category="feature", rating=5, message="Please add a compact report")

    listed = runtime.list(limit=10)
    summary = runtime.summary()

    assert first["stored_locally"] is True
    assert secret not in first["feedback"]["message"]
    assert "[REDACTED_SECRET]" in first["feedback"]["message"]
    assert listed["count"] == 2
    assert listed["items"][0]["category"] == "feature"
    assert summary == {
        "schema_version": 1,
        "stored_locally": True,
        "total": 2,
        "average_rating": 3.5,
        "by_category": [
            {"category": "bug", "count": 1},
            {"category": "feature", "count": 1},
        ],
    }


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"category": "unknown"}, "INVALID_FEEDBACK_CATEGORY"),
        ({"rating": 0}, "INVALID_FEEDBACK_RATING"),
        ({"rating": True}, "INVALID_FEEDBACK_RATING"),
        ({"message": ""}, "INVALID_FEEDBACK_MESSAGE"),
        ({"message": "bad\x00message"}, "INVALID_FEEDBACK_MESSAGE"),
    ],
)
def test_feedback_validation_fails_closed(tmp_path: Path, changes: dict, code: str):
    payload = {"category": "experience", "rating": 4, "message": "Useful result", **changes}
    with pytest.raises(FeedbackRuntimeError) as caught:
        _runtime(tmp_path).submit(**payload)
    assert caught.value.code == code


def test_feedback_delete_is_explicit_and_idempotent(tmp_path: Path):
    runtime = _runtime(tmp_path)
    feedback_id = runtime.submit(category="other", rating=3, message="Neutral")["feedback"]["feedback_id"]

    deleted = runtime.delete(feedback_id)
    missing = runtime.delete(feedback_id)

    assert deleted["status"] == "deleted"
    assert missing["status"] == "not_found"
    assert runtime.summary()["total"] == 0


def test_feedback_uses_formal_learning_engine_and_skips_neutral(monkeypatch, tmp_path: Path):
    import arforge.learning_system as learning_system

    recorded = []

    class FakeLearningSystem:
        def record_outcome(self, outcome):
            recorded.append(outcome)
            return 1

    monkeypatch.setattr(learning_system, "get_learning_system", lambda: FakeLearningSystem())
    runtime = _runtime(tmp_path)

    runtime.submit(category="bug", rating=1, message="Search returned the wrong file", session_id="session-1")
    runtime.submit(category="experience", rating=3, message="Neutral")
    runtime.submit(category="feature", rating=5, message="The new workflow is useful")

    assert len(recorded) == 2
    assert recorded[0].success is False
    assert recorded[0].error_type == "explicit_feedback"
    assert recorded[0].user_feedback == "unhelpful"
    assert recorded[0].session_id == "session-1"
    assert recorded[0].tags == ["explicit-feedback", "bug", "rating-1"]
    assert recorded[1].success is True
    assert recorded[1].error_message == ""
    assert recorded[1].user_feedback == "helpful"
    assert recorded[1].tags == ["explicit-feedback", "feature", "rating-5"]


def test_bridge_advertises_feedback_governance_and_stable_errors(tmp_path: Path):
    runtime = _runtime(tmp_path)
    described = dispatch({"version": "1.2", "method": "protocol.describe"})
    submitted = dispatch(
        {
            "version": "1.2",
            "method": "feedback.submit",
            "params": {"category": "experience", "rating": 5, "message": "Fast and clear"},
        },
        feedback=runtime,
    )
    rejected = dispatch(
        {
            "version": "1.2",
            "method": "feedback.submit",
            "params": {"category": "experience", "rating": 9, "message": "Invalid"},
        },
        feedback=runtime,
    )
    listed = dispatch(
        {"version": "1.2", "method": "feedback.list", "params": {"limit": 10}},
        feedback=runtime,
    )

    assert "feedback.summary" in described["data"]["methods"]
    assert "feedback.submit" in described["data"]["mutating_methods"]
    assert "feedback.list" not in described["data"]["mutating_methods"]
    assert submitted["ok"] is True
    assert listed["data"]["count"] == 1
    assert rejected["error"]["code"] == "INVALID_FEEDBACK_RATING"


def test_feedback_cli_uses_the_shared_local_runtime(monkeypatch, tmp_path: Path, capsys):
    import arforge.cli as cli

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    assert cli.main(["feedback", "submit", "bug", "2", "Search", "missed", "a", "symbol", "--json"]) == 0
    submitted = json.loads(capsys.readouterr().out)
    assert submitted["feedback"]["message"] == "Search missed a symbol"

    assert cli.main(["feedback", "list", "bug", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed["count"] == 1
    assert listed["items"][0]["rating"] == 2
