from __future__ import annotations

import io
import json

import pytest

from arforge.print_mode import (
    PrintEventRenderer,
    PrintModeInputError,
    PrintModeOptions,
    iter_stream_messages,
    run_print_mode,
)
from arforge.product.session_runtime import SessionRuntime


class StreamingAgent:
    def __init__(self):
        self.conversation_history: list[dict] = []

    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, value: str, **_kwargs):
        answer = f"answer:{value}"
        yield {"type": "answer_delta", "data": {"content": answer[:7]}}
        yield {"type": "answer_delta", "data": {"content": answer[7:]}}
        self.conversation_history.extend([
            {"role": "user", "content": value},
            {"role": "assistant", "content": answer},
        ])
        yield {
            "type": "done",
            "data": {
                "answer": answer,
                "reasoning": {},
                "tool_events": [],
                "artifacts": [],
            },
        }


class RetryableFailureAgent(StreamingAgent):
    def chat_stream(self, _value: str, **_kwargs):
        yield {
            "type": "error",
            "data": {
                "code": "MODEL_ERROR",
                "message": "provider returned 429 rate limit",
            },
        }


def _factory(agent_type):
    return lambda emit: SessionRuntime(emit, agent_factory=agent_type)


def test_stream_json_input_accepts_text_and_text_parts():
    values = list(iter_stream_messages([
        '{"role":"user","content":"hello"}\n',
        "\n",
        '{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}\n',
    ]))
    assert values == ["hello", "ab"]

    with pytest.raises(PrintModeInputError):
        list(iter_stream_messages(['{"role":"assistant","content":"no"}\n']))
    with pytest.raises(PrintModeInputError):
        list(iter_stream_messages(['{"role":"user","content":[{"type":"image","url":"x"}]}\n']))


def test_final_only_text_uses_normal_session_pipeline():
    stdout = io.StringIO()
    stderr = io.StringIO()

    code = run_print_mode(
        ["hello"],
        PrintModeOptions(final_message_only=True),
        stdout=stdout,
        stderr=stderr,
        runtime_factory=_factory(StreamingAgent),
    )

    assert code == 0
    assert stdout.getvalue() == "answer:hello\n"
    assert stderr.getvalue() == ""


def test_stream_json_processes_multiple_messages_in_one_session():
    stdout = io.StringIO()
    code = run_print_mode(
        ["first", "second"],
        PrintModeOptions(input_format="stream-json", output_format="stream-json"),
        stdout=stdout,
        stderr=io.StringIO(),
        runtime_factory=_factory(StreamingAgent),
    )

    assert code == 0
    records = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert records == [
        {"role": "assistant", "content": "answer:first"},
        {"role": "assistant", "content": "answer:second"},
    ]


def test_stream_json_renderer_emits_tool_call_and_tool_result_messages():
    stdout = io.StringIO()
    renderer = PrintEventRenderer(
        PrintModeOptions(output_format="stream-json"),
        stdout=stdout,
        stderr=io.StringIO(),
    )
    renderer.begin_turn()
    renderer.handle({
        "type": "tool.prepared",
        "data": {
            "tool_name": "read_file",
            "summary": "src/app.py",
            "arguments": {"path": "src/app.py"},
        },
    })
    renderer.handle({
        "type": "tool.completed",
        "data": {
            "tool_name": "read_file",
            "success": True,
            "summary": "short preview",
            "content": "complete file contents",
        },
    })

    records = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert records[0]["role"] == "assistant"
    assert records[0]["tool_calls"][0]["function"]["name"] == "read_file"
    assert json.loads(records[0]["tool_calls"][0]["function"]["arguments"]) == {
        "path": "src/app.py"
    }
    assert records[1] == {
        "role": "tool",
        "tool_call_id": "tool-1",
        "content": "complete file contents",
        "is_error": False,
    }


def test_stream_json_renderer_does_not_duplicate_answer_after_tool_flush():
    stdout = io.StringIO()
    renderer = PrintEventRenderer(
        PrintModeOptions(output_format="stream-json"),
        stdout=stdout,
        stderr=io.StringIO(),
    )
    renderer.begin_turn()
    renderer.handle({"type": "answer.delta", "data": {"content": "first"}})
    renderer.handle({
        "type": "tool.prepared",
        "data": {"tool_name": "lookup", "arguments": {"query": "x"}},
    })
    renderer.handle({
        "type": "operation.completed",
        "data": {"answer": "first"},
    })

    records = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert len(records) == 2
    assert records[0]["content"] == "first"
    assert records[1]["tool_calls"][0]["function"]["name"] == "lookup"


def test_retryable_provider_failures_return_exit_code_75():
    stderr = io.StringIO()
    code = run_print_mode(
        ["hello"],
        PrintModeOptions(final_message_only=True),
        stdout=io.StringIO(),
        stderr=stderr,
        runtime_factory=_factory(RetryableFailureAgent),
    )
    assert code == 75
    assert "429" in stderr.getvalue()


def test_wait_operation_validates_timeout_and_returns_terminal_state():
    runtime = SessionRuntime(lambda _event: None, agent_factory=StreamingAgent)
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "hello", 0)
    runtime.release_operation(operation["operation_id"])
    assert runtime.wait_operation(operation["operation_id"], timeout=2)["status"] == "succeeded"
    with pytest.raises(Exception) as captured:
        runtime.wait_operation(operation["operation_id"], timeout=-1)
    assert getattr(captured.value, "code", "") == "INVALID_PARAMS"
    runtime.shutdown()


def test_cli_print_flag_preserves_positional_prompt(monkeypatch):
    import arforge.cli as cli

    seen = {}

    def fake_run_print(args, namespace):
        seen["args"] = args
        seen["print_mode"] = namespace.print_mode
        return 0

    monkeypatch.setattr(cli, "_run_print", fake_run_print)
    assert cli.main(["--print", "hello", "world"]) == 0
    assert seen == {"args": ["hello", "world"], "print_mode": True}
