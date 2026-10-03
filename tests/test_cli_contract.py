"""Public CLI presentation-to-handler contract tests."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


def test_every_documented_top_level_command_has_exactly_one_handler():
    from arforge.cli import COMMANDS_HELP, _COMMAND_MAP

    displayed = {
        syntax.split()[0].strip("[]")
        for _executable, syntax, _description in COMMANDS_HELP
    }
    displayed.discard("chat")
    displayed.add("chat")

    assert displayed == set(_COMMAND_MAP)
    assert len(COMMANDS_HELP) == len(_COMMAND_MAP)


def test_cli_help_describes_all_backend_handlers(capsys):
    from arforge.cli import _COMMAND_MAP, main

    assert main(["--help"]) == 0
    output = capsys.readouterr().out
    for command in _COMMAND_MAP:
        if command != "chat":
            assert f"arforge {command}" in output


def test_tools_verbose_reports_registry_contract_health(capsys):
    from arforge.cli import main
    from arforge.tool_registry import REGISTRY

    assert main(["tools", "--verbose"]) == 0
    output = capsys.readouterr().out
    audit = REGISTRY.audit_contracts()
    assert "Contract audit: PASS" in output
    assert f"{audit['exported']}/{audit['registered']} exported" in output


def test_cli_ansi_styles_emit_valid_single_escape_sequences(monkeypatch):
    import arforge.cli_ui as ui

    monkeypatch.setattr(ui, "supports_color", lambda: True)

    assert ui.bold("bold") == "\x1b[1mbold\x1b[0m"
    assert ui.dim("dim") == "\x1b[2mdim\x1b[0m"
    assert "\x1b[\x1b[" not in ui.heading("heading")


def test_root_python_entrypoint_preserves_backend_exit_code():
    # The repository-root Python launcher is now a thin bridge into the
    # TypeScript CLI. Use a known migration guard so the assertion exercises
    # the canonical exit-code contract without falling through to the
    # interactive TUI's no-TTY diagnostic.
    result = subprocess.run(
        [sys.executable, "main.py", "ssh"],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 2


@pytest.mark.skipif(sys.platform != "win32", reason="private launcher uses Windows PowerShell")
def test_unified_cli_launcher_validates_only_project_root(tmp_path):
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(root / "scripts" / "run_cli.ps1"),
            "-ValidateOnly",
        ],
        cwd=root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert f"workspace={root}" in result.stdout
    assert "packages\\arforge\\src\\index.ts" in result.stdout
    assert not (tmp_path / "trusted_workspaces.json").exists()


def test_global_options_work_after_the_command(monkeypatch):
    import arforge.cli as cli

    seen = {}

    def run_tools(verbose=False):
        seen["verbose"] = verbose
        return 0

    monkeypatch.setattr(cli, "_run_tools", run_tools)
    assert cli.main(["tools", "--verbose"]) == 0
    assert seen == {"verbose": True}


def test_eval_uses_the_active_provider_instead_of_a_hardcoded_key(monkeypatch, capsys):
    from types import SimpleNamespace

    import arforge.cli as cli
    import arforge.eval as eval_module
    import arforge.product.model_config_runtime as model_runtime

    adapter = object()

    class Runtime:
        def get_resolved_config(self):
            return {"resolved": True, "provider": "openai"}

        def create_active_adapter(self):
            return adapter

    seen = {}

    def fake_run_eval(tasks, **kwargs):
        seen["judge_adapter"] = kwargs["judge_adapter"]
        return SimpleNamespace(passed=1, total=1, success_rate=1.0)

    monkeypatch.setattr(model_runtime, "get_model_config", lambda: Runtime())
    monkeypatch.setattr(eval_module, "builtin_tasks", lambda: [SimpleNamespace(category="core")])
    monkeypatch.setattr(eval_module, "run_eval", fake_run_eval)
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)

    assert cli._run_eval([]) == 0
    assert seen["judge_adapter"] is adapter
    assert "Passed: 1/1" in capsys.readouterr().out


def test_workspace_option_binds_project_and_is_not_part_of_prompt(monkeypatch, tmp_path):
    import os

    import arforge.cli as cli
    from arforge.workspace_context import current_workspace

    original_cwd = Path.cwd()
    original_workspace = os.environ.get("ARFORGE_WORKSPACE")
    seen = {}

    def run_code(args, namespace):
        seen["args"] = args
        seen["namespace"] = namespace.workspace
        seen["cwd"] = Path.cwd()
        seen["workspace"] = current_workspace(original_cwd)
        seen["environment"] = os.environ.get("ARFORGE_WORKSPACE")
        return 0

    monkeypatch.setattr(cli, "_run_code", run_code)

    assert cli.main(["code", "--workspace", str(tmp_path), "fix", "tests"]) == 0
    assert seen == {
        "args": ["fix", "tests"],
        "namespace": str(tmp_path),
        "cwd": tmp_path.resolve(),
        "workspace": tmp_path.resolve(),
        "environment": str(tmp_path.resolve()),
    }
    assert Path.cwd() == original_cwd
    assert os.environ.get("ARFORGE_WORKSPACE") == original_workspace


def test_workspace_option_rejects_missing_directory(monkeypatch, tmp_path, capsys):
    import arforge.cli as cli

    called = False

    def run_code(_args, _namespace):
        nonlocal called
        called = True
        return 0

    monkeypatch.setattr(cli, "_run_code", run_code)

    assert cli.main(["code", "--workspace", str(tmp_path / "missing"), "work"]) == 2
    assert called is False
    assert "workspace must be an existing directory" in capsys.readouterr().err


def test_cli_invocation_restores_permission_default(monkeypatch):
    import arforge.cli as cli
    from arforge.core.permission import get_permission_manager, install_permission_hooks

    manager = get_permission_manager()
    manager.set_mode(None)

    def run_tools(_verbose=False):
        install_permission_hooks("fullAccess")
        assert manager.is_active()
        return 0

    monkeypatch.setattr(cli, "_run_tools", run_tools)

    assert cli.main(["tools"]) == 0
    assert manager.is_active() is False


def test_keybindings_cli_updates_the_shared_runtime(monkeypatch, tmp_path, capsys):
    import arforge.cli as cli

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    assert cli.main(["keybindings", "set", "history:search", "ctrl+g", "--json"]) == 0
    payload = __import__("json").loads(capsys.readouterr().out)
    assert payload["bindings"]["history:search"] == "ctrl+g"

    assert cli.main(["keybindings", "--json"]) == 0
    listed = __import__("json").loads(capsys.readouterr().out)
    assert listed["bindings"]["history:search"] == "ctrl+g"
    assert listed["cli_bindings"]["cli:thinking-cycle"] == "ctrl+t"

    assert cli.main(["keybindings", "set", "cli:thinking-cycle", "alt+t", "--json"]) == 0
    cli_payload = __import__("json").loads(capsys.readouterr().out)
    assert cli_payload["bindings"]["cli:thinking-cycle"] == "alt+t"


def test_explicit_chat_command_uses_the_same_handler_contract(monkeypatch):
    import arforge.cli as cli

    seen = {}

    def run_chat(no_stream=False, thinking_effort="normal", permission_mode="acceptEdits"):
        seen["no_stream"] = no_stream
        seen["thinking_effort"] = thinking_effort
        seen["permission_mode"] = permission_mode
        return 0

    monkeypatch.setattr(cli, "_run_chat", run_chat)
    assert cli.main(["chat", "--no-stream"]) == 0
    assert seen == {
        "no_stream": True,
        "thinking_effort": "medium",
        "permission_mode": "acceptEdits",
    }
    # --thinking deep propagates to the handler.
    assert cli.main(["chat", "--thinking", "deep"]) == 0
    assert seen["thinking_effort"] == "deep"
    assert cli.main(["chat", "--thinking", "quick"]) == 0
    assert seen["thinking_effort"] == "quick"
    assert cli.main(["chat", "--mode", "auto"]) == 0
    assert seen["permission_mode"] == "auto"


def test_code_max_steps_env_override(monkeypatch, tmp_path):
    import arforge.cli as cli

    seen = {}

    class FakeAgent:
        adapter = object()

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _task, max_steps=0, **kwargs):
            from types import SimpleNamespace
            from arforge.core.permission import get_permission_manager

            seen["max_steps"] = max_steps
            seen["permission_mode"] = get_permission_manager().get_mode().value
            seen["reasoning_effort"] = kwargs.get("reasoning_effort")
            return SimpleNamespace(
                answer="done",
                trace=[],
                observability={"summary": {}},
                messages=[],
                self_correct={},
            )

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.setenv("ARFORGE_CODE_MAX_STEPS", "37")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr("arforge.core.agent_core.ArforgeAgent", lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent())
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)

    assert cli.main(["--mode", "auto", "--thinking", "ultra", "code", "fix this"]) == 0
    assert seen["max_steps"] == 37
    assert seen["permission_mode"] == "auto"
    assert seen["reasoning_effort"] == "ultra"


def test_code_max_steps_cli_option_overrides_environment(monkeypatch, tmp_path):
    import arforge.cli as cli

    seen = {}

    class FakeAgent:
        adapter = object()

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _task, max_steps=0, **_kwargs):
            from types import SimpleNamespace

            seen["max_steps"] = max_steps
            return SimpleNamespace(answer="done", trace=[], observability={}, messages=[])

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.setenv("ARFORGE_CODE_MAX_STEPS", "37")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(
        "arforge.core.agent_core.ArforgeAgent",
        lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent(),
    )
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)

    assert cli.main(["--max-steps", "14", "--mode", "auto", "code", "fix this"]) == 0
    assert seen["max_steps"] == 14


def test_code_command_returns_failure_when_step_budget_is_exhausted(monkeypatch, tmp_path, capsys):
    import arforge.cli as cli

    class FakeAgent:
        adapter = object()

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _task, **_kwargs):
            from types import SimpleNamespace

            return SimpleNamespace(
                answer="Verified so far: the parser tests passed; implementation remains unfinished.",
                trace=[],
                observability={},
                messages=[],
                self_correct={"stop_reason": "max_steps"},
                incomplete_report={"stop_reason": "max_steps"},
            )

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(
        "arforge.core.agent_core.ArforgeAgent",
        lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent(),
    )
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)

    assert cli.main(["--max-steps", "1", "code", "fix this"]) == 1
    output = capsys.readouterr().out
    assert "Verified so far: the parser tests passed" in output
    assert "Task incomplete" in output or "任务未完成" in output


def test_code_json_returns_machine_readable_execution_metrics(monkeypatch, tmp_path, capsys):
    import json

    import arforge.cli as cli

    class FakeAgent:
        adapter = object()

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _task, **_kwargs):
            from types import SimpleNamespace

            return SimpleNamespace(
                answer="done",
                steps=3,
                trace=[],
                tool_calls=[{"tool": "run_tests", "success": True}],
                observability={
                    "summary": {
                        "llm_calls": 3,
                        "tool_calls": 2,
                        "total_tokens": 120,
                        "cost_cny": 0.01,
                    }
                },
                messages=[],
                self_correct={"stop_reason": "final"},
                incomplete_report=None,
            )

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(
        "arforge.core.agent_core.ArforgeAgent",
        lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent(),
    )
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)

    assert cli.main(["--json", "code", "fix this"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["success"] is True
    assert payload["run_id"]
    assert payload["steps"] == 3
    assert payload["observability"]["total_tokens"] == 120
    assert payload["tool_calls"][0]["tool"] == "run_tests"


def test_code_resume_loads_saved_messages_and_reuses_run_id(monkeypatch, tmp_path, capsys):
    import json

    import arforge.cli as cli
    from arforge.core.checkpoint import save_checkpoint

    workspace = tmp_path / "project"
    workspace.mkdir()
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    save_checkpoint(
        "resume123",
        task="fix it",
        messages=[{"role": "user", "content": "fix it"}],
        max_steps=37,
        workspace=str(workspace),
    )
    seen = {}

    class FakeAgent:
        adapter = object()

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, task, **kwargs):
            from types import SimpleNamespace

            seen["task"] = task
            seen["messages"] = kwargs["resume_messages"]
            seen["max_steps"] = kwargs["max_steps"]
            return SimpleNamespace(
                answer="finished",
                steps=1,
                trace=[],
                tool_calls=[],
                observability={"summary": {"total_tokens": 5}},
                messages=[*kwargs["resume_messages"], {"role": "assistant", "content": "finished"}],
                self_correct={"stop_reason": "final"},
                incomplete_report=None,
            )

    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(
        "arforge.core.agent_core.ArforgeAgent",
        lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent(),
    )
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)

    assert cli.main([
        "--json", "--workspace", str(workspace), "--resume", "resume123", "code", "continue verification"
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["run_id"] == "resume123"
    assert seen["messages"][-1] == {"role": "user", "content": "continue verification"}
    assert seen["task"] == "fix it\n\nContinuation request: continue verification"
    assert seen["max_steps"] == 37


def test_code_interrupt_persists_incremental_checkpoint(monkeypatch, tmp_path, capsys):
    import arforge.cli as cli
    from arforge.core.checkpoint import list_checkpoints, load_checkpoint

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")

    class FakeAgent:
        adapter = object()

    class InterruptingLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _task, **kwargs):
            kwargs["on_checkpoint"](
                [
                    {"role": "user", "content": "interrupt me"},
                    {"role": "assistant", "content": "working"},
                    {"role": "tool", "content": "partial evidence"},
                ],
                2,
                [{"tool": "code_search", "success": True}],
            )
            raise KeyboardInterrupt

    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(
        "arforge.core.agent_core.ArforgeAgent",
        lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent(),
    )
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", InterruptingLoop)

    assert cli.main(["--json", "code", "interrupt me"]) == 130
    checkpoints = list_checkpoints()
    assert len(checkpoints) == 1
    checkpoint = load_checkpoint(checkpoints[0]["run_id"])
    assert checkpoint is not None
    assert checkpoint.status == "paused"
    assert checkpoint.steps_completed == 2
    assert checkpoint.tool_calls_made == 1
    assert checkpoint.messages[-1]["content"] == "partial evidence"
    assert "Resume with:" in capsys.readouterr().out


def test_invalid_extra_arguments_fail_with_usage(capsys):
    from arforge.cli import main

    assert main(["status", "unexpected"]) == 2
    assert "Usage: arforge status" in capsys.readouterr().err
    assert main(["clear-data", "--unknown"]) == 2


def test_backend_exception_is_redacted_and_returns_failure(monkeypatch, capsys, tmp_path):
    import arforge.cli as cli

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

    def fail(_args, _namespace):
        raise RuntimeError("postgresql://alice:plain-password@db/arforge")

    monkeypatch.setitem(cli._COMMAND_MAP, "status", fail)
    assert cli.main(["status"]) == 1
    output = capsys.readouterr().err
    assert "plain-password" not in output
    assert "[REDACTED]" in output


def test_doctor_json_output_is_supported(capsys):
    import json

    from arforge.cli import main

    code = main(["doctor", "--json"])
    output = capsys.readouterr().out

    assert code in {0, 1}
    payload = json.loads(output)
    assert "checks" in payload
    assert "summary" in payload


def test_doctor_text_output_is_visible(capsys):
    from arforge.cli import main

    code = main(["doctor"])
    output = capsys.readouterr().out

    assert code in {0, 1}
    assert "Environment Diagnostics" in output
    assert "Result:" in output


def test_config_command_uses_public_status_and_never_prints_key(monkeypatch, capsys):
    import config
    from arforge.cli import main

    secret = "sk-private-secret-value-1234"
    monkeypatch.setenv("DEEPSEEK_API_KEY", secret)
    monkeypatch.setattr(
        config,
        "get_config_file_status",
        lambda: ({"path": "C:/safe/.env", "exists": True, "loaded": True},),
    )

    assert main(["config"]) == 0
    output = capsys.readouterr().out
    assert "API Key" in output
    assert "configured" in output
    assert "C:/safe/.env" in output
    assert secret not in output
    assert secret[:8] not in output
    assert secret[-4:] not in output


def test_learning_recall_cli_subcommand(capsys):
    from arforge.cli import main

    assert main(["learning", "recall"]) == 0
    output = capsys.readouterr().out
    assert "Memory Recall Quality" in output
    assert "Top-1 Hit Rate" in output


def test_non_interactive_commands_fail_when_workspace_is_not_trusted(monkeypatch):
    import arforge.cli as cli
    import arforge.eval as eval_runtime

    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(
        eval_runtime,
        "run_eval",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("evaluation must not run before workspace trust")
        ),
    )

    assert cli.main(["ask", "hello"]) == 1
    assert cli.main(["code", "touch a file"]) == 1
    assert cli.main(["eval"]) == 1


def test_complex_request_uses_real_multiagent_path(capsys):
    from arforge.cli import _print_agent_response

    class FakeAgent:
        def should_use_multiagent(self, _text):
            return True

        def chat_multiagent(self, _text):
            return {
                "answer": "merged answer",
                "mode": "multi",
                "agents_used": 3,
                "iterations": 2,
            }

        def chat(self, _text):
            raise AssertionError("single-agent path must not run")

    _print_agent_response(FakeAgent(), "implement and test this system", True, "en")
    output = capsys.readouterr().out
    assert "merged answer" in output
    assert "3 roles, 2 iteration" in output


def test_multiagent_progress_and_failure_are_visible(capsys):
    from arforge.cli import _print_agent_response

    class FakeAgent:
        def should_use_multiagent(self, _text):
            return True

        def chat_multiagent(self, _text, progress_callback=None):
            assert progress_callback is not None
            progress_callback("phase_start", {"phase": "decompose"})
            progress_callback(
                "task_start", {"task_id": "search", "role": "SearcherAgent"}
            )
            progress_callback(
                "agent_tool_start",
                {"role": "SearcherAgent", "tool": "read_file"},
            )
            progress_callback(
                "agent_tool_end",
                {"role": "SearcherAgent", "tool": "read_file", "success": True},
            )
            progress_callback(
                "task_end",
                {
                    "task_id": "search",
                    "role": "SearcherAgent",
                    "success": False,
                    "error": "deadline exceeded",
                    "elapsed_ms": 1000,
                },
            )
            return {
                "answer": "partial answer",
                "mode": "multi",
                "agents_used": 1,
                "iterations": 1,
                "success": False,
                "failed_count": 1,
            }

    succeeded = _print_agent_response(
        FakeAgent(), "inspect and test", True, "en"
    )
    output = capsys.readouterr().out

    assert succeeded is False
    assert "Decompose" in output
    assert "SearcherAgent" in output
    assert "read_file" in output
    assert "deadline exceeded" in output
    assert "Task incomplete" in output


def test_cli_stream_hides_reasoning_by_default(capsys, monkeypatch):
    """Default CLI output (normal mode) keeps reasoning out of the answer body."""
    from arforge.cli import _print_stream

    class ReasoningAgent:
        def chat_stream(self, _user_input):
            yield {"type": "reasoning_started", "data": {}}
            yield {"type": "reasoning_delta", "data": {"section": "thinking", "content": "内部分析不应出现"}}
            yield {"type": "reasoning_completed", "data": {"reasoning": {"thinking": "内部分析不应出现"}}}
            yield {"type": "answer_delta", "data": {"content": "最终结论。"}}
            yield {"type": "done", "data": {"answer": "最终结论。", "thinking_time": 0.4, "reasoning": {"thinking": "内部分析不应出现"}}}

    monkeypatch.setattr("arforge.cli.get_lang", lambda: "zh")
    _print_stream(ReasoningAgent(), "分析这个报错", reasoning_effort="normal")
    output = capsys.readouterr().out
    assert "最终结论。" in output
    # Reasoning text must NOT appear in default (normal) output.
    assert "内部分析不应出现" not in output
    # The status line is present with the normal-mode label.
    assert "中等深度思考" in output


def test_cli_stream_shows_reasoning_in_deep_mode(capsys, monkeypatch):
    """``--thinking deep`` prints the collapsible reasoning sections."""
    from arforge.cli import _print_stream

    class ReasoningAgent:
        def chat_stream(self, _user_input):
            yield {"type": "reasoning_started", "data": {}}
            yield {"type": "reasoning_delta", "data": {"section": "thinking", "content": "定位到根因。"}}
            yield {"type": "reasoning_completed", "data": {"reasoning": {"thinking": "定位到根因。"}}}
            yield {"type": "answer_delta", "data": {"content": "已修复。"}}
            yield {"type": "done", "data": {"answer": "已修复。", "thinking_time": 0.3, "reasoning": {"thinking": "定位到根因。"}}}

    monkeypatch.setattr("arforge.cli.get_lang", lambda: "zh")
    _print_stream(ReasoningAgent(), "修个 bug", reasoning_effort="deep")
    output = capsys.readouterr().out
    assert "已修复。" in output
    assert "定位到根因。" in output  # deep mode shows reasoning
    assert "高深度思考" in output  # legacy alias resolves to the high tier


def test_cli_stream_quick_mode_label_shows(capsys, monkeypatch):
    """Quick mode prints a quick-think status line."""
    from arforge.cli import _print_stream

    class QuickAgent:
        def chat_stream(self, _user_input):
            yield {"type": "reasoning_started", "data": {}}
            yield {"type": "reasoning_completed", "data": {"reasoning": {}}}
            yield {"type": "answer_delta", "data": {"content": "你好！"}}
            yield {"type": "done", "data": {"answer": "你好！", "thinking_time": 0.1, "reasoning": {}}}

    monkeypatch.setattr("arforge.cli.get_lang", lambda: "zh")
    _print_stream(QuickAgent(), "你好", reasoning_effort="quick")
    output = capsys.readouterr().out
    assert "你好！" in output
    assert "低深度思考" in output


def test_thinking_toggle_command_changes_tier():
    """Public tiers and legacy aliases resolve to canonical depth."""
    from arforge.cli import _handle_thinking_command

    state = {"effort": "normal"}
    r = _handle_thinking_command("/thinking deep", state, "zh")
    assert r is not None
    assert state["effort"] == "high"
    assert _handle_thinking_command("/thinking quick", state, "zh") is not None
    assert state["effort"] == "low"
    assert _handle_thinking_command("/thinking ultra", state, "zh") == "ultra"
    assert state["effort"] == "ultra"
    # Unrelated input returns None.
    assert _handle_thinking_command("你好", state, "zh") is None


def test_interactive_shortcut_state_controls_the_next_turn(monkeypatch, tmp_path):
    import arforge.cli as cli
    import arforge.cli_input as cli_input
    from arforge.core.permission import PermissionMode, get_permission_manager

    class FakePrompt:
        enhanced = True

        def __init__(self, state, **_kwargs):
            self.state = state
            self.calls = 0

        def read(self):
            self.calls += 1
            if self.calls > 1:
                raise EOFError
            self.state["permission_mode"] = "fullAccess"
            self.state["effort"] = "deep"
            return "hello"

    seen = {}

    def render(
        _agent,
        _text,
        *,
        no_stream,
        lang,
        reasoning_effort,
        permission_mode,
        resume_messages,
    ):
        seen["reasoning_effort"] = reasoning_effort
        seen["permission_mode"] = permission_mode
        seen["scoped_mode"] = get_permission_manager().get_mode()
        seen["no_stream"] = no_stream
        seen["lang"] = lang
        seen["resume_messages"] = resume_messages
        return __import__("types").SimpleNamespace(
            answer="done",
            messages=[{"role": "assistant", "content": "done"}],
        )

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(cli, "get_lang", lambda: "en")
    monkeypatch.setattr(cli_input, "CliPromptSession", FakePrompt)
    monkeypatch.setattr("arforge.core.agent_core.ArforgeAgent", lambda: object())
    monkeypatch.setattr(cli, "_print_agentic_chat_response", render)

    assert cli._run_chat() == 0
    assert seen == {
        "reasoning_effort": "deep",
        "permission_mode": "fullAccess",
        "scoped_mode": PermissionMode.FULL_ACCESS,
        "no_stream": False,
        "lang": "en",
        "resume_messages": None,
    }


def test_interactive_chat_preserves_agentic_tool_context_between_turns(monkeypatch, tmp_path):
    import arforge.cli as cli
    import arforge.cli_input as cli_input

    class FakePrompt:
        enhanced = True

        def __init__(self, _state, **_kwargs):
            self.values = iter(["生成报告", "帮我打开", EOFError()])

        def read(self):
            value = next(self.values)
            if isinstance(value, BaseException):
                raise value
            return value

    calls = []

    def render(_agent, text, **kwargs):
        calls.append((text, kwargs["resume_messages"]))
        messages = list(kwargs["resume_messages"] or [])
        if not messages:
            messages = [{"role": "user", "content": text}]
        messages.append({"role": "assistant", "content": f"answered:{text}"})
        return __import__("types").SimpleNamespace(answer="done", messages=messages)

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(cli, "get_lang", lambda: "zh")
    monkeypatch.setattr(cli_input, "CliPromptSession", FakePrompt)
    monkeypatch.setattr("arforge.core.agent_core.ArforgeAgent", lambda: object())
    monkeypatch.setattr(cli, "_print_agentic_chat_response", render)

    assert cli._run_chat() == 0
    assert calls[0] == ("生成报告", None)
    assert calls[1][0] == "帮我打开"
    assert calls[1][1][-2:] == [
        {"role": "assistant", "content": "answered:生成报告"},
        {"role": "user", "content": "帮我打开"},
    ]


def test_agentic_chat_renders_a_final_answer_after_tool_failure(monkeypatch, capsys):
    from types import SimpleNamespace

    import arforge.cli as cli

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _text, **kwargs):
            kwargs["on_reasoning"]("定位文件")
            kwargs["on_tool_start"]("read_file", {"filename": "111.docx"}, 1)
            kwargs["on_tool_complete"](
                "read_file",
                {"filename": "111.docx"},
                SimpleNamespace(success=False, output="", error="file does not exist"),
                1,
            )
            kwargs["on_token"]("没有找到该文件，请告诉我正确路径。")
            return SimpleNamespace(
                answer="没有找到该文件，请告诉我正确路径。",
                messages=[{"role": "assistant", "content": "没有找到该文件，请告诉我正确路径。"}],
                usage={"total_tokens": 12},
            )

    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)
    agent = SimpleNamespace(reasoning_effort="normal")

    result = cli._print_agentic_chat_response(
        agent,
        "帮我打开",
        no_stream=False,
        lang="zh",
        reasoning_effort="normal",
        permission_mode="requestApproval",
    )

    output = capsys.readouterr().out
    assert result.answer == "没有找到该文件，请告诉我正确路径。"
    assert "read_file" in output
    assert "file does not exist" in output
    assert "没有找到该文件，请告诉我正确路径。" in output


def test_cli_stream_logs_artifact_creation(capsys, monkeypatch):
    """File creation surfaces as a concise one-line tool log."""
    from arforge.cli import _print_stream

    class ArtifactAgent:
        def chat_stream(self, _user_input):
            yield {"type": "reasoning_started", "data": {}}
            yield {"type": "reasoning_completed", "data": {"reasoning": {}}}
            yield {"type": "artifact.created", "data": {"artifact": {"path": "C:\\Users\\14181\\Desktop\\summary.txt", "source": "file.write"}}}
            yield {"type": "answer_delta", "data": {"content": "已生成桌面总结文件。"}}
            yield {"type": "done", "data": {"answer": "已生成桌面总结文件。", "reasoning": {}, "thinking_time": 0.2}}

    monkeypatch.setattr("arforge.cli.get_lang", lambda: "en")
    _print_stream(ArtifactAgent(), "生成txt到桌面")
    output = capsys.readouterr().out
    assert "C:\\Users\\14181\\Desktop\\summary.txt" in output
    assert "file.write -> created" in output
    assert "已生成桌面总结文件。" in output


def test_cli_stream_renders_tool_workflow_and_footer(capsys, monkeypatch):
    from arforge.cli import _print_stream

    class ToolAgent:
        def chat_stream(self, _user_input, reasoning_effort=None):
            assert reasoning_effort == "normal"
            yield {"type": "reasoning_started", "data": {}}
            yield {"type": "reasoning_completed", "data": {"reasoning": {}}}
            yield {
                "type": "tool_call_start",
                "data": {
                    "tool_name": "read_file",
                    "args": {"path": "src/app.py"},
                    "iteration": 1,
                },
            }
            yield {
                "type": "tool_call_done",
                "data": {
                    "tool_name": "read_file",
                    "result_summary": "loaded 42 lines",
                    "iteration": 1,
                    "success": True,
                },
            }
            yield {"type": "answer_delta", "data": {"content": "Analysis complete."}}
            yield {
                "type": "done",
                "data": {
                    "answer": "Analysis complete.",
                    "thinking_time": 1.25,
                    "usage": {"total_tokens": 321},
                },
            }

    monkeypatch.setattr("arforge.cli.get_lang", lambda: "en")
    _print_stream(
        ToolAgent(),
        "analyze this project",
        reasoning_effort="normal",
        permission_mode="fullAccess",
    )

    output = capsys.readouterr().out
    assert "Thought" in output
    assert "Explore(read_file)" in output
    assert "src/app.py" in output
    assert "loaded 42 lines" in output
    assert "Analysis complete." in output
    assert "321 tokens" in output
    assert "full access" in output
    assert "1 agent" in output


def test_code_command_streams_hooked_tool_progress(monkeypatch, tmp_path, capsys):
    import arforge.cli as cli

    class FakeAgent:
        adapter = object()

    class ToolResult:
        success = True
        output = "created src/report.txt"
        error = ""

    class FakeLoop:
        def __init__(self, _agent):
            pass

        def run_agentic(self, _task, **kwargs):
            from types import SimpleNamespace

            kwargs["on_reasoning"]("Inspecting project structure.")
            kwargs["on_tool_start"](
                "write_file",
                {"filename": "src/report.txt"},
                1,
            )
            kwargs["on_tool_complete"](
                "write_file",
                {"filename": "src/report.txt"},
                ToolResult(),
                1,
            )
            kwargs["on_token"]("Done.")
            return SimpleNamespace(answer="Done.", usage={"total_tokens": 99})

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(cli, "_entry_flow", lambda _lang: True)
    monkeypatch.setattr(cli, "get_lang", lambda: "en")
    monkeypatch.setattr(
        "arforge.product.model_config_runtime.ModelConfigRuntime.get_resolved_config",
        lambda _self: {"resolved": True, "provider": "test"},
    )
    monkeypatch.setattr(
        "arforge.core.agent_core.ArforgeAgent",
        lambda reasoning_enabled=False, multiagent_enabled=False: FakeAgent(),
    )
    monkeypatch.setattr("arforge.core.agent_loop_v2.AgentLoopV2", FakeLoop)

    assert cli.main(["--mode", "auto", "code", "create report"]) == 0
    output = capsys.readouterr().out
    assert "create report" in output
    assert "Edit(write_file)" in output
    assert "src/report.txt" in output
    assert "created src/report.txt" in output
    assert "Done." in output
    assert "99 tokens" in output
    assert "auto mode" in output


def test_failed_tool_is_visible_and_does_not_fall_through_to_model(capsys):
    from types import SimpleNamespace

    from arforge.cli import _render_direct_tool_result

    agent = SimpleNamespace(conversation_history=[])
    result = SimpleNamespace(
        success=False,
        tool_name="write_file",
        output="",
        error="permission denied",
    )

    assert _render_direct_tool_result(result, agent, "write file", "en") is True
    assert "permission denied" in capsys.readouterr().err
    assert agent.conversation_history[-1]["content"].startswith("[Tool failed:")


def test_cli_side_question_uses_an_isolated_history_snapshot(monkeypatch):
    from types import SimpleNamespace

    import arforge.cli as cli

    main_history = [
        {"role": "user", "content": "previous question"},
        {"role": "assistant", "content": "previous answer"},
    ]
    main = SimpleNamespace(conversation_history=main_history)
    side = SimpleNamespace(conversation_history=[])
    streamed = {}

    def fake_stream(agent, question, reasoning_effort, *, permission_mode):
        streamed.update(
            {
                "agent": agent,
                "question": question,
                "reasoning_effort": reasoning_effort,
                "permission_mode": permission_mode,
            }
        )
        agent.conversation_history.append(
            {"role": "assistant", "content": "side-only answer"}
        )

    monkeypatch.setattr(cli, "_print_stream", fake_stream)
    cli._run_cli_side_question(
        main,
        "current status?",
        agent_factory=lambda: side,
    )

    assert streamed["agent"] is side
    assert streamed["question"] == "current status?"
    assert streamed["reasoning_effort"] == "low"
    assert side.conversation_history[:2] == main_history
    assert main.conversation_history == main_history
