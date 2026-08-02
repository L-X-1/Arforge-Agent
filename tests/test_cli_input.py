from __future__ import annotations

import json

import pytest

from arforge.cli_input import (
    CliKeybindingError,
    CliKeybindingRuntime,
    CliPromptSession,
    PERMISSION_MODES,
    THINKING_ACTION,
    cycle_value,
    normalize_permission_mode,
    prompt_toolkit_keys,
    validate_thinking_chord,
)


def test_permission_aliases_normalize_to_the_three_cli_modes():
    assert normalize_permission_mode("plan") == "requestApproval"
    assert normalize_permission_mode("acceptEdits") == "autoApprove"
    assert normalize_permission_mode("auto") == "fullAccess"
    assert normalize_permission_mode("fullAccess") == "fullAccess"
    assert cycle_value("requestApproval", PERMISSION_MODES) == "autoApprove"
    assert cycle_value("autoApprove", PERMISSION_MODES) == "fullAccess"
    assert cycle_value("fullAccess", PERMISSION_MODES) == "requestApproval"


def test_cli_thinking_keybinding_is_validated_and_persisted(tmp_path):
    path = tmp_path / "cli-keybindings.json"
    runtime = CliKeybindingRuntime(path)

    assert runtime.get()["bindings"][THINKING_ACTION] == "ctrl+t"
    updated = runtime.set_thinking_chord("ALT+T")

    assert updated["bindings"][THINKING_ACTION] == "alt+t"
    assert (
        json.loads(path.read_text(encoding="utf-8"))["bindings"][THINKING_ACTION]
        == "alt+t"
    )
    assert CliKeybindingRuntime(path).get()["bindings"][THINKING_ACTION] == "alt+t"


@pytest.mark.parametrize(
    "chord", ["shift+tab", "ctrl+c", "ctrl+shift+t", "t", "ctrl+1"]
)
def test_cli_thinking_keybinding_rejects_reserved_or_unreliable_chords(chord):
    with pytest.raises(CliKeybindingError):
        validate_thinking_chord(chord)


def test_prompt_toolkit_chord_translation():
    assert prompt_toolkit_keys("ctrl+t") == ("c-t",)
    assert prompt_toolkit_keys("alt+t") == ("escape", "t")
    assert prompt_toolkit_keys("f6") == ("f6",)


def test_prompt_shortcuts_cycle_modes_without_submitting(tmp_path):
    from prompt_toolkit.input.defaults import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    state = {"permission_mode": "requestApproval", "effort": "low"}
    with create_pipe_input() as pipe:
        prompt = CliPromptSession(
            state,
            lang="zh",
            thinking_chord="ctrl+t",
            history_path=tmp_path / "history",
            input_stream=pipe,
            output_stream=DummyOutput(),
        )
        pipe.send_bytes(b"\x1b[Z")  # Shift+Tab
        pipe.send_bytes(b"\x14")  # Ctrl+T
        pipe.send_text("hello\r")

        assert prompt.read() == "hello"

    assert state == {"permission_mode": "autoApprove", "effort": "medium"}
    assert "替我审批" in prompt.toolbar_text()
    assert "中等深度思考" in prompt.toolbar_text()


def test_ctrl_x_switches_to_safe_shell_without_submitting(tmp_path):
    from prompt_toolkit.input.defaults import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    state = {
        "permission_mode": "autoApprove",
        "effort": "medium",
        "input_mode": "agent",
    }
    with create_pipe_input() as pipe:
        prompt = CliPromptSession(
            state,
            lang="en",
            thinking_chord="ctrl+t",
            history_path=tmp_path / "history",
            input_stream=pipe,
            output_stream=DummyOutput(),
        )
        pipe.send_bytes(b"\x18")
        pipe.send_text("python --version\r")

        assert prompt.read() == "python --version"

    assert state["input_mode"] == "shell"
    assert "safe shell" in prompt.toolbar_text()
