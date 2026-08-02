"""P0 1.2: Self-correct tests — classify, repeat detection, reflection injection."""

from __future__ import annotations


from arforge.core.self_correct import (
    ErrorClass,
    SelfCorrectState,
    classify,
    fingerprint,
    _STRATEGY_HINTS,
)
from arforge.core.agentic import run_tool_loop
from arforge.tool_registry import ToolResult


class TestClassify:
    def test_syntax_error(self):
        assert classify("SyntaxError: invalid syntax at line 3") is ErrorClass.SYNTAX

    def test_import_error(self):
        assert classify("ModuleNotFoundError: No module named 'foo'") is ErrorClass.IMPORT

    def test_name_error(self):
        assert classify("NameError: name 'process_order' is not defined") is ErrorClass.NAME

    def test_type_error(self):
        assert classify("TypeError: unsupported operand type(s)") is ErrorClass.TYPE

    def test_value_error(self):
        assert classify("ValueError: invalid literal for int()") is ErrorClass.TYPE

    def test_test_failure(self):
        assert classify("FAILED tests/test_foo.py::test_bar - AssertionError") is ErrorClass.TEST_FAILURE

    def test_command_error(self):
        assert classify("command returned non-zero exit code 1") is ErrorClass.COMMAND

    def test_tool_error(self):
        assert classify("file not found: /nonexistent/path.txt") is ErrorClass.TOOL

    def test_unknown_error(self):
        assert classify("something completely unexpected happened") is ErrorClass.UNKNOWN

    def test_fingerprint_normalizes_line_numbers(self):
        assert fingerprint("SyntaxError at line 12 in C:\\repo\\a.py") == fingerprint(
            "SyntaxError at line 99 in C:\\repo\\b.py"
        )


class TestSelfCorrectState:
    def test_empty_state_no_reflection(self):
        state = SelfCorrectState()
        assert state.reflection_needed(current_step=5) is None
        assert not state.is_hopeless()

    def test_single_failure_no_reflection(self):
        state = SelfCorrectState()
        state.record(error_text="SyntaxError: bad token", tool_name="run_cmd", step=1)
        assert state.reflection_needed(current_step=2) is None

    def test_two_same_class_triggers_reflection(self):
        state = SelfCorrectState()
        state.record(error_text="SyntaxError: bad token at line 5", tool_name="run_cmd", step=1)
        reflection = state.reflection_needed(current_step=2)
        assert reflection is None  # only 1 failure, no trigger yet

        state.record(error_text="SyntaxError: unexpected indent", tool_name="run_cmd", step=2)
        reflection = state.reflection_needed(current_step=3)
        assert reflection is not None
        assert "SelfCorrect" in reflection
        assert "SYNTAX" in reflection
        assert "syntax" in reflection.lower()

    def test_different_classes_no_trigger(self):
        state = SelfCorrectState()
        state.record(error_text="ModuleNotFoundError: no module 'foo'", tool_name="run_cmd", step=1)
        state.record(error_text="SyntaxError: invalid syntax", tool_name="run_cmd", step=2)
        assert state.reflection_needed(current_step=3) is None  # different classes, no trigger

    def test_three_same_tool_triggers(self):
        state = SelfCorrectState()
        state.record(error_text="command returned exit code 1", tool_name="pytest", step=1)
        state.record(error_text="TypeError: bad args", tool_name="pytest", step=2)
        state.record(error_text="ValueError: wrong value", tool_name="pytest", step=3)
        reflection = state.reflection_needed(current_step=4)
        assert reflection is not None
        assert "pytest" in reflection

    def test_no_double_injection_same_step(self):
        state = SelfCorrectState()
        state.record(error_text="NameError: undefined var", tool_name="run_cmd", step=1)
        state.record(error_text="NameError: undefined var", tool_name="run_cmd", step=2)
        first = state.reflection_needed(current_step=3)
        assert first is not None
        second = state.reflection_needed(current_step=3)
        assert second is None  # already injected this step

    def test_reflection_waits_for_new_failure_after_injection(self):
        state = SelfCorrectState()
        state.record(error_text="SyntaxError: bad token", tool_name="run_cmd", step=1)
        state.record(error_text="SyntaxError: unexpected indent", tool_name="run_cmd", step=2)
        assert state.reflection_needed(current_step=3) is not None
        assert state.reflection_needed(current_step=4) is None

        state.record(error_text="SyntaxError: missing colon", tool_name="run_cmd", step=4)
        assert state.reflection_needed(current_step=5) is not None

    def test_hopeless_after_four_same_class(self):
        state = SelfCorrectState()
        for i in range(4):
            state.record(error_text="TypeError: bad operand", tool_name="edit_file", step=i + 1)
        # is_hopeless() removed per user requirement — agent never aborts on error counts
        assert not state.is_hopeless()

    def test_not_hopeless_with_three(self):
        state = SelfCorrectState()
        for i in range(3):
            state.record(error_text="TypeError: bad operand", tool_name="edit_file", step=i + 1)
        assert not state.is_hopeless()

    def test_success_breaks_hopeless_failure_streak(self):
        state = SelfCorrectState()
        for i in range(4):
            state.record(error_text="TypeError: bad operand", tool_name="edit_file", step=i + 1)
        # is_hopeless() removed — never aborts
        assert not state.is_hopeless()

        state.record_success(tool_name="edit_file", step=5)

        assert not state.is_hopeless()
        state.record(error_text="TypeError: new failure", tool_name="run_cmd", step=6)
        assert state.reflection_needed(current_step=7) is None

    def test_abort_hint_is_helpful(self):
        state = SelfCorrectState()
        hint = state.abort_hint()
        assert "SelfCorrect" in hint
        assert "root cause" in hint.lower()


class TestStrategyHints:
    def test_all_classes_have_hints(self):
        for cls in ErrorClass:
            assert cls in _STRATEGY_HINTS, f"{cls.name} missing strategy hint"


class _ToolCall:
    def __init__(self, call_id: str, name: str, arguments: str):
        self.id = call_id
        self.name = name
        self.arguments = arguments


class _Response:
    def __init__(self, content: str = "", tool_calls=None, usage=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = usage or {}


class _ScriptedAdapter:
    model_name = "self-correct-test"

    def __init__(self, script):
        self.script = script
        self.idx = 0
        self.seen_messages = []

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        self.seen_messages.append([dict(item) for item in messages])
        response = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        if callable(response):
            return response(messages)
        return response


def test_agentic_failure_feedback_lets_model_change_strategy():
    def second_turn(messages):
        joined = "\n".join(str(item.get("content", "")) for item in messages)
        assert "Tool failure recovery required" in joined
        assert "Before your next tool call" in joined
        return _Response("", [_ToolCall("c2", "run_cmd", '{"command":"python -m pytest -q"}')])

    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "run_cmd", '{"command":"pytest -q"}')]),
            second_turn,
            _Response("fixed"),
        ]
    )
    calls: list[str] = []

    def executor(name: str, args: dict) -> ToolResult:
        calls.append(args["command"])
        if args["command"] == "pytest -q":
            return ToolResult(name, False, "", "command returned non-zero exit code 1: pytest not found")
        return ToolResult(name, True, "1 passed", "")

    result = run_tool_loop(adapter, [{"role": "user", "content": "fix failing tests"}], tools=[], max_steps=5, executor=executor)

    assert result.answer == "fixed"
    assert calls == ["pytest -q", "python -m pytest -q"]
    assert any(item["event"] == "self_correct_feedback" for item in result.trace)
    assert result.self_correct["total_failures"] == 1
    assert result.self_correct["events"]["feedback"] == 1
    assert result.self_correct["failure_classes"] == ["TEST_FAILURE"]
    assert result.self_correct["failed_tools"] == ["run_cmd"]
    failed_call = next(call for call in result.tool_calls if not call["success"])
    assert "pytest not found" in failed_call["error"]


def test_agentic_repeated_failed_call_is_blocked_before_execution():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "run_cmd", '{"command":"pytest -q"}')]),
            _Response("", [_ToolCall("c2", "run_cmd", '{"command":"pytest -q"}')]),
            _Response("stopped repeating"),
        ]
    )
    executed = 0

    def executor(name: str, args: dict) -> ToolResult:
        nonlocal executed
        executed += 1
        return ToolResult(name, False, "", "command returned non-zero exit code 1: pytest not found")

    result = run_tool_loop(adapter, [{"role": "user", "content": "fix failing tests"}], tools=[], max_steps=5, executor=executor)

    assert executed == 1
    assert result.answer == "stopped repeating"
    assert any(item["event"] == "self_correct_repeat_blocked" for item in result.trace)
    assert any(call.get("blocked_repeat") for call in result.tool_calls)
    assert result.self_correct["events"]["repeat_blocked"] == 1


def test_agentic_feedback_waits_until_all_parallel_tool_messages_are_added():
    def second_turn(messages):
        assistant_index = next(i for i, item in enumerate(messages) if item.get("role") == "assistant")
        after_assistant = messages[assistant_index + 1 : assistant_index + 4]
        assert [item.get("role") for item in after_assistant] == ["tool", "tool", "user"]
        assert "Tool failure recovery required" in after_assistant[2]["content"]
        return _Response("done")

    adapter = _ScriptedAdapter(
        [
            _Response(
                "",
                [
                    _ToolCall("c1", "run_cmd", '{"command":"pytest -q"}'),
                    _ToolCall("c2", "read_file", '{"filename":"README.md"}'),
                ],
            ),
            second_turn,
        ]
    )

    def executor(name: str, args: dict) -> ToolResult:
        if name == "run_cmd":
            return ToolResult(name, False, "", "command returned non-zero exit code 1")
        return ToolResult(name, True, "readme", "")

    result = run_tool_loop(adapter, [{"role": "user", "content": "fix failing tests"}], tools=[], max_steps=3, executor=executor)

    assert result.answer == "done"


def test_agentic_blocks_plain_text_tool_call_before_final_answer():
    adapter = _ScriptedAdapter(
        [
            _Response('<tool_calls><invoke name="write_file"></invoke></tool_calls>'),
            _Response("", [_ToolCall("c1", "write_file", '{"filename":"ABC.txt","content":"hello，world"}')]),
            _Response("wrote and verified"),
        ]
    )
    calls: list[tuple[str, dict]] = []

    def executor(name: str, args: dict) -> ToolResult:
        calls.append((name, args))
        return ToolResult(name, True, "wrote ABC.txt", "")

    result = run_tool_loop(adapter, [{"role": "user", "content": "write ABC.txt"}], tools=[], max_steps=5, executor=executor)

    assert result.answer == "wrote and verified"
    assert calls == [("write_file", {"filename": "ABC.txt", "content": "hello，world"})]
    assert any(item["event"] == "unexecuted_tool_text_blocked" for item in result.trace)


def test_agentic_repeated_successful_call_is_not_finalized_as_tool_text():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "run_cmd", '{"command":"python verify.py"}')]),
            _Response("", [_ToolCall("c2", "run_cmd", '{"command":"python verify.py"}')]),
            _Response("verified"),
        ]
    )
    executed = 0

    def executor(name: str, args: dict) -> ToolResult:
        nonlocal executed
        executed += 1
        return ToolResult(name, True, "OK", "")

    result = run_tool_loop(adapter, [{"role": "user", "content": "verify work"}], tools=[], max_steps=5, executor=executor)

    assert executed == 1
    assert result.answer == "verified"
    assert any(item["event"] == "repeat_success_blocked" for item in result.trace)
    assert not any(item["event"] == "final_after_loop" for item in result.trace)


def test_agentic_allows_same_failed_test_after_workspace_write():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "run_cmd", '{"command":"node --test"}')]),
            _Response("", [_ToolCall("c2", "edit_file", '{"filename":"src/slug.ts","old":"a","new":"b"}')]),
            _Response("", [_ToolCall("c3", "run_cmd", '{"command":"node --test"}')]),
            _Response("fixed and verified"),
        ]
    )
    test_runs = 0

    def executor(name: str, args: dict) -> ToolResult:
        nonlocal test_runs
        if name == "run_cmd":
            test_runs += 1
            if test_runs == 1:
                return ToolResult(name, False, "", "2 tests failed")
            return ToolResult(name, True, "2 tests passed", "")
        return ToolResult(name, True, "edited", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix failing TypeScript tests"}],
        tools=[],
        max_steps=4,
        executor=executor,
    )

    assert test_runs == 2
    assert result.answer == "fixed and verified"
    assert result.self_correct["stop_reason"] == "final"
    assert any(
        item["event"] == "workspace_revision_advanced" for item in result.trace
    )
    assert not any(
        item["event"] == "self_correct_repeat_blocked" and item.get("tools") == ["run_cmd"]
        for item in result.trace
    )


def test_agentic_requires_verification_before_final_answer_after_writes():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "write_file", '{"filename":"calc.py","content":"x=1"}')]),
            _Response("done, wrote calc.py"),
            _Response("", [_ToolCall("c2", "verify_work", '{}')]),
            _Response("verified, task complete"),
        ]
    )
    def executor(name: str, args: dict) -> ToolResult:
        return ToolResult(name, True, "ok", "")

    result = run_tool_loop(adapter, [{"role": "user", "content": "create calc.py"}], tools=[], max_steps=5, executor=executor)

    assert result.answer == "verified, task complete"
    assert any(item["event"] == "final_answer_verification_required" for item in result.trace)
    # After verification, normal finalization (not through the gate again)
    assert any(item["event"] == "final" for item in result.trace)


def test_agentic_does_not_report_success_when_verification_request_is_ignored():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "write_file", '{"filename":"calc.py","content":"x=1"}')]),
            _Response("done, wrote calc.py"),
            _Response("it is definitely complete"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "create calc.py"}],
        tools=[],
        max_steps=5,
        executor=lambda name, args: ToolResult(name, True, "ok", ""),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "verification_missing"
    assert result.incomplete_report["stop_reason"] == "verification_missing"
    assert any(item["event"] == "verification_missing_terminal" for item in result.trace)


def test_agentic_accepts_successful_test_evidence_without_extra_gate_rounds():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "edit_file", '{"filename":"src/slug.ts","old":"a","new":"b"}')]),
            _Response("", [_ToolCall("c2", "run_cmd", '{"command":"node --test"}')]),
            _Response("fixed src/slug.ts; all tests pass"),
        ]
    )

    def executor(name: str, args: dict) -> ToolResult:
        output = "ℹ pass 2\nℹ fail 0" if name == "run_cmd" else "edited"
        return ToolResult(name, True, output, "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix TypeScript tests"}],
        tools=[],
        max_steps=3,
        executor=executor,
    )

    assert result.answer == "fixed src/slug.ts; all tests pass"
    assert result.self_correct["stop_reason"] == "final"
    assert any(
        item["event"] == "evidence_grounded_by_execution" for item in result.trace
    )
    assert not any(
        item["event"] == "final_answer_verification_required"
        for item in result.trace
    )


def test_agentic_max_steps_does_not_return_unexecuted_tool_text():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "read_file", '{"filename":"missing.txt"}')]),
            _Response('<｜｜DSML｜｜tool_calls><invoke name="write_file"></invoke>'),
        ]
    )

    def executor(name: str, args: dict) -> ToolResult:
        return ToolResult(name, False, "", "file not found: missing.txt")

    result = run_tool_loop(adapter, [{"role": "user", "content": "create files"}], tools=[], max_steps=1, executor=executor)

    assert "任务未完成" in result.answer
    assert "DSML" not in result.answer
    assert any(
        item["event"] == "unexecuted_tool_text_blocked" and item.get("phase") == "max_steps"
        for item in result.trace
    )


def test_agentic_self_correct_no_longer_aborts_on_repeated_errors():
    adapter = _ScriptedAdapter(
        [
            _Response("", [_ToolCall("c1", "run_cmd", '{"command":"python one.py"}')]),
            _Response("", [_ToolCall("c2", "run_cmd", '{"command":"python two.py"}')]),
            _Response("", [_ToolCall("c3", "run_cmd", '{"command":"python three.py"}')]),
            _Response("", [_ToolCall("c4", "run_cmd", '{"command":"python four.py"}')]),
            _Response('<｜｜DSML｜｜tool_calls><invoke name="write_file"></invoke>'),
        ]
    )

    def executor(name: str, args: dict) -> ToolResult:
        return ToolResult(name, False, "", f"TypeError: failed {args['command']}")

    result = run_tool_loop(adapter, [{"role": "user", "content": "fix code"}], tools=[], max_steps=6, executor=executor)

    assert "任务未完成" in result.answer
    assert "DSML" not in result.answer
    # is_hopeless() removed — agent now runs to max_steps instead of aborting
    assert result.self_correct["stop_reason"] == "max_steps"
    # Verify agent continued processing instead of aborting early
    assert result.steps == 6
    # verify trace reflects new behavior: no abort, runs to max_steps
    assert any(
        item["event"] == "max_steps_reached"
        for item in result.trace
    ), "Expected max_steps_reached trace event"


def test_agentic_traces_pre_llm_context_injection():
    from arforge.core.hooks import HookDecision, HookEvent, get_hook_manager, reset_hook_manager

    def inject_memory(ctx):
        return HookDecision.modify(
            new_messages=[*(ctx.messages or []), {"role": "system", "content": "## Relevant Memories\n\n- preference"}]
        )

    reset_hook_manager()
    get_hook_manager().register(HookEvent.PRE_LLM_CALL, inject_memory, name="test_memory_inject")
    try:
        adapter = _ScriptedAdapter([_Response("done")])

        result = run_tool_loop(adapter, [{"role": "user", "content": "use memory"}], tools=[], max_steps=1)
    finally:
        reset_hook_manager()

    event = next(item for item in result.trace if item["event"] == "pre_llm_context_injected")
    assert event["added_messages"] == 1
    assert event["labels"] == ["memory"]
