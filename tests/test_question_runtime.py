from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace

import pytest

from arforge.product.direct_dispatch import dispatch
from arforge.product.question_runtime import (
    QuestionRuntimeError,
    question_handler,
    request_questions,
    validate_questions,
)
from arforge.product.session_runtime import OperationRecord, SessionRuntime


QUESTIONS = [
    {
        "question": "Which storage should be used?",
        "header": "Storage",
        "options": [
            {"label": "SQLite", "description": "Local and embedded"},
            {"label": "Postgres", "description": "Shared service"},
        ],
        "multi_select": False,
    }
]


class FakeAgent:
    def __init__(self):
        self.adapter = object()
        self.conversation_history = []

    def should_use_multiagent(self, _text):
        return False


def test_question_validation_rejects_duplicates_other_and_preview_multiselect():
    duplicate = [QUESTIONS[0], QUESTIONS[0]]
    with pytest.raises(QuestionRuntimeError, match="unique"):
        validate_questions(duplicate)

    other = json.loads(json.dumps(QUESTIONS))
    other[0]["options"][0]["label"] = "Other"
    with pytest.raises(QuestionRuntimeError, match="supplied by the client"):
        validate_questions(other)

    preview = json.loads(json.dumps(QUESTIONS))
    preview[0]["multi_select"] = True
    preview[0]["options"][0]["preview"] = "example"
    with pytest.raises(QuestionRuntimeError, match="single-select"):
        validate_questions(preview)


def test_context_handler_returns_validated_answers_and_redacts_metadata():
    captured = {}

    def handler(questions, metadata):
        captured["questions"] = questions
        captured["metadata"] = metadata
        return {"answers": {questions[0]["question"]: "SQLite"}}

    with question_handler(handler):
        result = request_questions(QUESTIONS, {"authorization": "Bearer secret"})

    assert result["answers"] == {"Which storage should be used?": "SQLite"}
    assert "secret" not in captured["metadata"]["authorization"]


def test_question_tool_exports_nested_schema_and_executes_through_handler():
    from arforge.tool_executor import execute_tool_by_name
    from arforge.tool_registry import REGISTRY
    from arforge.tools import load_builtin_tools, question_tools

    load_builtin_tools()
    # The legacy Python wrapper is explicit compatibility; TS/Core ``question``
    # owns the default product registration.
    assert question_tools.ask_user_tool is not None
    schema = next(
        item for item in REGISTRY.to_openai_tools()
        if item["function"]["name"] == "ask_user"
    )
    questions_schema = schema["function"]["parameters"]["properties"]["questions"]
    assert questions_schema["type"] == "array"
    assert questions_schema["items"]["properties"]["options"]["minItems"] == 2

    with question_handler(
        lambda questions, _metadata: {
            "answers": {questions[0]["question"]: "Postgres"}
        }
    ):
        result = execute_tool_by_name("ask_user", {"questions": QUESTIONS})
    assert result.success
    assert json.loads(result.output)["answers"]["Which storage should be used?"] == "Postgres"


def test_python_builtin_registry_excludes_legacy_question_wrapper():
    """TS/Core ``question`` is canonical; Python ``ask_user`` stays opt-in."""

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.question_tools" not in BUILTIN_TOOL_MODULES


def test_bridge_question_response_resumes_same_agentic_operation(monkeypatch):
    from arforge.core.agent_loop_v2 import AgentLoopV2
    from arforge.product.question_runtime import request_questions

    events: list[dict] = []
    runtime = SessionRuntime(events.append, agent_factory=FakeAgent)
    session = runtime.create_session()
    operation = OperationRecord(
        operation_id="op-question",
        session_id=session["session_id"],
        created_at="2026-07-16T00:00:00Z",
        timeout_ms=10_000,
        status="running",
    )
    runtime._operations[operation.operation_id] = operation

    def fake_run_agentic(_self, *_args, **_kwargs):
        result = request_questions(QUESTIONS, {"source": "test"})
        return SimpleNamespace(
            answer=result["answers"]["Which storage should be used?"],
            trace=[],
            self_correct={},
        )

    monkeypatch.setattr(AgentLoopV2, "run_agentic", fake_run_agentic)
    answer_parts: list[str] = []
    outcome: dict[str, object] = {}

    def run():
        outcome["meta"] = runtime._run_agentic_turn(
            FakeAgent(),
            operation,
            "choose storage",
            time.monotonic(),
            answer_parts,
            [],
            [],
        )

    thread = threading.Thread(target=run)
    thread.start()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and not any(
        event["type"] == "question.requested" for event in events
    ):
        time.sleep(0.01)
    requested = next(event for event in events if event["type"] == "question.requested")
    question_id = requested["data"]["question_id"]

    response = dispatch(
        {
            "version": "1.2",
            "method": "question.respond",
            "params": {
                "session_id": session["session_id"],
                "question_id": question_id,
                "answers": {"Which storage should be used?": "SQLite"},
            },
        },
        runtime=runtime,
    )
    thread.join(2)

    assert response["ok"] is True
    assert not thread.is_alive()
    assert answer_parts == ["SQLite"]
    event_types = [event["type"] for event in events]
    assert event_types.index("question.requested") < event_types.index("question.answered")
    assert event_types.index("question.answered") < event_types.index("answer.delta")
    assert runtime.get_question(session["session_id"], question_id)["status"] == "answered"


def test_desktop_permission_confirmation_resumes_the_same_agentic_operation(monkeypatch):
    from arforge.core.agent_loop_v2 import AgentLoopV2
    from arforge.permission import request_confirmation

    events: list[dict] = []
    runtime = SessionRuntime(events.append, agent_factory=FakeAgent)
    session = runtime.create_session()
    operation = OperationRecord(
        operation_id="op-permission",
        session_id=session["session_id"],
        created_at="2026-07-18T00:00:00Z",
        timeout_ms=10_000,
        status="running",
    )
    runtime._operations[operation.operation_id] = operation

    def fake_run_agentic(_self, *_args, **_kwargs):
        approved = request_confirmation(
            "medium",
            "run_cmd: python -c print(321) (workspace_cmd) in requestApproval mode",
        )
        return SimpleNamespace(
            answer="approved" if approved else "rejected",
            trace=[],
            self_correct={},
        )

    monkeypatch.setattr(AgentLoopV2, "run_agentic", fake_run_agentic)
    answer_parts: list[str] = []

    thread = threading.Thread(
        target=runtime._run_agentic_turn,
        args=(
            FakeAgent(),
            operation,
            "run a command",
            time.monotonic(),
            answer_parts,
            {},
            [],
        ),
    )
    thread.start()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and not any(
        event["type"] == "question.requested" for event in events
    ):
        time.sleep(0.01)

    requested = next(event for event in events if event["type"] == "question.requested")
    question = requested["data"]["questions"][0]
    assert "python -c print(321)" in question["question"]
    runtime.respond_question(
        session["session_id"],
        requested["data"]["question_id"],
        {question["question"]: "允许一次"},
    )
    thread.join(2)

    assert not thread.is_alive()
    assert answer_parts == ["approved"]
    assert [event["type"] for event in events].index("question.requested") < [
        event["type"] for event in events
    ].index("question.answered")


def test_bridge_rejects_cross_session_and_duplicate_question_answers(monkeypatch):
    runtime = SessionRuntime(lambda _event: None, agent_factory=FakeAgent)
    first = runtime.create_session()
    second = runtime.create_session()
    operation = OperationRecord(
        operation_id="op",
        session_id=first["session_id"],
        created_at="2026-07-16T00:00:00Z",
        timeout_ms=10_000,
        status="running",
    )
    runtime._operations[operation.operation_id] = operation
    from arforge.product.session_runtime import PendingQuestionRecord

    pending = PendingQuestionRecord(
        question_id="question",
        session_id=first["session_id"],
        operation_id=operation.operation_id,
        created_at="2026-07-16T00:00:00Z",
        questions=validate_questions(QUESTIONS),
        metadata={},
    )
    runtime._questions[pending.question_id] = pending

    cross = dispatch(
        {
            "version": "1.2",
            "method": "question.respond",
            "params": {
                "session_id": second["session_id"],
                "question_id": pending.question_id,
                "answers": {"Which storage should be used?": "SQLite"},
            },
        },
        runtime=runtime,
    )
    accepted = runtime.respond_question(
        first["session_id"],
        pending.question_id,
        {"Which storage should be used?": "SQLite"},
    )
    duplicate = dispatch(
        {
            "version": "1.2",
            "method": "question.respond",
            "params": {
                "session_id": first["session_id"],
                "question_id": pending.question_id,
                "answers": {"Which storage should be used?": "Postgres"},
            },
        },
        runtime=runtime,
    )

    assert cross["error"]["code"] == "QUESTION_NOT_FOUND"
    assert accepted["status"] == "answered"
    assert duplicate["error"]["code"] == "INVALID_STATE"


def test_protocol_advertises_question_methods_as_local_state_mutations():
    described = dispatch({"version": "1.2", "method": "protocol.describe"})

    assert "question.get" in described["data"]["methods"]
    assert "question.respond" in described["data"]["mutating_methods"]
    assert "question.respond" not in described["data"]["workspace_mutating_methods"]
