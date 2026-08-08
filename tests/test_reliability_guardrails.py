from __future__ import annotations

import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import arforge.tools.basic_tools  # noqa: F401
import arforge.tools.code_tools  # noqa: F401
import arforge.tools.file_tools  # noqa: F401
import arforge.tools.browser_tools  # noqa: F401
import arforge.tools.subagent_tools  # noqa: F401
from arforge.browser_runtime import _page_error_text, _perform_action, resolve_browser_target
from arforge.core.agent_core import ArforgeAgent
from arforge.core.agent_loop_v2 import AgentLoopV2
from arforge.core.agentic import run_tool_loop
from arforge.core.subagent import get_subagent_adapter, subagent_adapter_scope
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.product.session_runtime import MAX_TIMEOUT_MS
from arforge.product.settings_runtime import SettingsRuntime, SettingsRuntimeError
from arforge.tool_registry import REGISTRY, ToolResult
from arforge.tools.basic_tools import run_script
from arforge.reasoning.prompts import build_reasoning_system_prompt
from arforge.logo import render_logo


class _ScriptedAdapter:
    def __init__(self, responses):
        self.responses = list(responses)
        self.index = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        response = self.responses[min(self.index, len(self.responses) - 1)]
        self.index += 1
        return response


def _call(call_id: str, name: str, args: dict) -> ToolCallResponse:
    return ToolCallResponse(
        content="",
        finish_reason="tool_calls",
        tool_calls=[ToolCall(call_id, name, json.dumps(args))],
    )


def _final(text: str = "done") -> ToolCallResponse:
    return ToolCallResponse(content=text, finish_reason="stop", tool_calls=[])


def test_targeted_test_evidence_grounds_claims_for_all_named_files():
    adapter = _ScriptedAdapter(
        [
            _call(
                "tests-1",
                "run_tests",
                {
                    "framework": "pytest",
                    "targets": ["tests/test_alpha.py", "tests/test_beta.py"],
                },
            ),
            _final(
                "tests/test_alpha.py and tests/test_beta.py passed: 2 passed, 0 failed."
            ),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "Run the two named test files."}],
        tools=[],
        max_steps=3,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "Framework: pytest | Exit: 0 | 2 passed, 0 failed",
            "",
        ),
    )

    assert result.self_correct["stop_reason"] == "final"
    assert not any(item["event"] == "evidence_required" for item in result.trace)


def test_cli_logo_is_provider_neutral_and_has_no_secondary_brand():
    rendered = render_logo()

    assert "AI DEVELOPMENT AGENT" in rendered
    assert "智能开发代理运行时" in rendered
    assert "DeepSeek" not in rendered
    assert "Spiritual Pivot" not in rendered
    assert "灵枢" not in rendered


def test_run_script_uses_and_removes_os_temp_file():
    output = run_script("python", "from pathlib import Path\nprint(Path(__file__).resolve())")
    generated = Path(output.strip())

    assert generated.name.startswith("arforge-validation-")
    assert not generated.exists()


def test_run_script_defaults_to_no_timeout_and_keeps_explicit_limits_optional():
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("run_script")
    assert tool is not None
    timeout_param = next(item for item in tool.schema.params if item.name == "timeout_seconds")

    assert tool.schema.timeout == 0
    assert timeout_param.default == 0
    assert run_script("python", "import time\ntime.sleep(0.05)\nprint('done')").strip() == "done"

    with pytest.raises(ValueError, match="non-negative"):
        run_script("python", "print('x')", timeout_seconds=-1)


def test_frozen_run_script_uses_plain_python_invocation(tmp_path, monkeypatch):
    from arforge.tools.basic_tools import _python_script_command

    process_env: dict[str, str] = {}
    script = Path(tempfile.gettempdir()) / "arforge-validation-command.py"

    command = _python_script_command("python", script, process_env, tmp_path)

    assert command == ["python", str(script)]
    assert process_env == {}


def test_run_script_drains_large_output_without_pipe_deadlock():
    payload_size = 200_000

    output = run_script(
        "python",
        f"import sys\nprint('x' * {payload_size})\nprint('y' * {payload_size}, file=sys.stderr)",
        timeout_seconds=5,
    )

    assert len(output.strip()) == payload_size


def test_tool_output_and_callbacks_redact_source_credentials():
    secret = "db-pass-123"
    adapter = _ScriptedAdapter(
        [
            _call("r1", "read_file", {"filename": "db.php"}),
            _final("inspection complete"),
        ]
    )
    completed = []

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "inspect config"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=3,
        executor=lambda name, args: ToolResult(
            name,
            True,
            f"new PDO('mysql:host=127.0.0.1;dbname=app', 'root', '{secret}')",
            "",
        ),
        on_tool_complete=lambda _name, _args, tool_result, _step: completed.append(
            tool_result.output
        ),
    )

    assert secret not in str(result.messages)
    assert secret not in str(result.tool_calls)
    assert secret not in str(completed)
    assert "[REDACTED]" in str(result.messages)


@pytest.mark.parametrize("language", ["shell", "powershell", ""])
def test_run_script_rejects_unbounded_languages(language):
    with pytest.raises(ValueError, match="python.*javascript"):
        run_script(language, "print('x')")


def test_run_script_allows_read_only_workspace_inspection(tmp_path, monkeypatch):
    target = tmp_path / "state.txt"
    target.write_text("safe", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)

    output = run_script("python", "with open('state.txt', 'r', encoding='utf-8') as f:\n print(f.read())")

    assert output.strip() == "safe"


def test_run_script_can_import_workspace_modules(tmp_path, monkeypatch):
    (tmp_path / "workspace_module.py").write_text(
        "VALUE = 'workspace-import-ok'\n", encoding="utf-8"
    )
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)

    output = run_script("python", "from workspace_module import VALUE\nprint(VALUE)")

    assert output.strip() == "workspace-import-ok"


def test_run_script_allows_non_filesystem_replace_operations():
    output = run_script("python", "print('a-b'.replace('-', '/'))")

    assert output.strip() == "a/b"


@pytest.mark.parametrize(
    "code, expected",
    [
        ("open('start.bat', 'w').write('unsafe')", "read-only"),
        ("import os\nos.remove('state.txt')", "remove"),
        ("from pathlib import Path\nPath('x').write_text('unsafe')", "write_text"),
        ("import subprocess\nsubprocess.run(['python', '-V'])", "subprocess"),
    ],
)
def test_run_script_rejects_python_workspace_mutations(tmp_path, monkeypatch, code, expected):
    target = tmp_path / "state.txt"
    target.write_text("safe", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)

    with pytest.raises(PermissionError, match=expected):
        run_script("python", code)

    assert target.read_text(encoding="utf-8") == "safe"
    assert not (tmp_path / "start.bat").exists()
    assert not (tmp_path / "x").exists()


def test_run_script_rejects_javascript_workspace_mutation(tmp_path, monkeypatch):
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)

    with pytest.raises(PermissionError, match="read-only"):
        run_script("javascript", "require('fs').writeFileSync('start.bat', 'unsafe')")

    assert not (tmp_path / "start.bat").exists()


@pytest.mark.parametrize(
    "code",
    [
        "payload = {'clear_week': '1', 'apply': '1'}\nprint(payload)",
        "query = 'DELETE FROM tasks WHERE user_id=1'\nprint(query)",
        "const payload = {clear_week: 1, apply: 1}; console.log(payload);",
    ],
)
def test_run_script_rejects_destructive_persistent_data_validation(code):
    language = "javascript" if code.startswith("const ") else "python"

    with pytest.raises(PermissionError, match="destructive persistent-data"):
        run_script(language, code)


def test_all_reasoning_efforts_include_live_data_safety_rule():
    for effort in ("low", "medium", "high", "ultra"):
        prompt = build_reasoning_system_prompt(effort=effort)
        assert "Never test bulk delete" in prompt
        assert "verified restorable snapshot" in prompt


def test_local_browser_target_is_workspace_confined(tmp_path):
    page = tmp_path / "index.html"
    page.write_text("<title>ok</title>", encoding="utf-8")

    assert resolve_browser_target("index.html", tmp_path) == page.resolve().as_uri()
    assert resolve_browser_target("index.html?mode=test#ready", tmp_path) == (
        page.resolve().as_uri() + "?mode=test#ready"
    )
    with pytest.raises(ValueError, match="inside the active workspace"):
        resolve_browser_target(str(tmp_path.parent / "outside.html"), tmp_path)


def test_local_browser_target_allows_absolute_file_in_full_access(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    delivery = tmp_path / "desktop-delivery"
    workspace.mkdir()
    delivery.mkdir()
    page = delivery / "index.html"
    page.write_text("<title>delivery</title>", encoding="utf-8")
    monkeypatch.setattr(
        "arforge.tools.file_tools._uses_local_computer_paths",
        lambda: True,
    )

    assert resolve_browser_target(str(page), workspace) == page.resolve().as_uri()


def test_local_server_side_page_requires_http_server(tmp_path):
    page = tmp_path / "index.php"
    page.write_text("<?php echo 'ok';", encoding="utf-8")

    with pytest.raises(ValueError, match=r"cannot be validated through file://"):
        resolve_browser_target("index.php?p=home", tmp_path)


def test_browser_rejects_exposed_server_source(monkeypatch, tmp_path):
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)
    monkeypatch.setattr(
        "arforge.tools.browser_tools.run_browser_diagnostics",
        lambda *_args, **_kwargs: {
            "engine": "fake",
            "snapshot": {"bodyText": "<?php echo 'secret';"},
        },
    )

    with pytest.raises(RuntimeError, match="server-side source code"):
        arforge.tools.browser_tools.test_browser("http://127.0.0.1:8200/")


def test_external_node_check_script_counts_as_verification():
    from arforge.core.agentic import _is_successful_verification

    assert _is_successful_verification(
        {
            "tool": "run_cmd",
            "success": True,
            "args": {"command": "node tests/check.js"},
            "output": "45 通过, 0 失败",
        }
    )


def test_required_browser_runtime_detects_web_delivery_without_evidence():
    from arforge.core.agentic import (
        _has_successful_browser_runtime,
        _has_written_web_artifact,
        _task_requires_browser_runtime,
    )

    calls = [
        {
            "tool": "write_file",
            "success": True,
            "args": {"filename": r"C:\Users\dev\Desktop\site\index.html"},
        },
        {
            "tool": "open_file",
            "success": True,
            "args": {"filename": r"C:\Users\dev\Desktop\site\index.html"},
            "output": "launch_only=true",
        },
    ]

    assert _task_requires_browser_runtime("交付前必须完成真实浏览器检查")
    assert _has_written_web_artifact(calls)
    assert not _has_successful_browser_runtime(calls)


def test_browser_tool_is_visible_without_deferred_search():
    tool = REGISTRY.get("test_browser")
    interaction = REGISTRY.get("interact_browser")
    assert tool is not None
    assert tool.schema.always_load is True
    assert interaction is not None
    assert interaction.schema.always_load is True
    assert interaction.schema.risk_level == "medium"
    assert interaction.schema.requires_confirmation is True
    assert any(item["function"]["name"] == "test_browser" for item in REGISTRY.to_openai_tools())


def test_browser_visible_text_precedes_large_element_inventories(monkeypatch, tmp_path):
    marker = "ARFORGE_ERROR_PATH SUCCESS_PATH_OK"
    huge_buttons = [{"text": "x" * 1000} for _ in range(30)]
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)
    monkeypatch.setattr(
        "arforge.tools.browser_tools.run_browser_diagnostics",
        lambda *_args, **_kwargs: {
            "engine": "fake",
            "actions": ["filled textarea", "clicked run"],
            "console_errors": [],
            "page_errors": [],
            "network_failures": [],
            "http_errors": [],
            "snapshot": {
                "url": "http://127.0.0.1/",
                "title": "probe",
                "readyState": "complete",
                "bodyTextLength": len(marker),
                "bodyText": marker,
                "viewport": {"width": 1280, "height": 720},
                "document": {
                    "scrollWidth": 1280,
                    "scrollHeight": 720,
                    "horizontalOverflow": False,
                },
                "canvases": [],
                "buttons": huge_buttons,
                "interactives": [],
                "selects": [],
                "inputs": [],
            },
        },
    )

    output = arforge.tools.browser_tools.test_browser("http://127.0.0.1/")

    assert output.index("Visible text sample:") < output.index("Buttons:")
    assert marker in output[:20000]


def test_read_only_browser_rejects_interactions_before_launch(monkeypatch):
    launched = False

    def fake_run(*_args, **_kwargs):
        nonlocal launched
        launched = True
        return {}

    monkeypatch.setattr("arforge.tools.browser_tools.run_browser_diagnostics", fake_run)

    with pytest.raises(PermissionError, match="interact_browser"):
        arforge.tools.browser_tools.test_browser(
            "http://127.0.0.1:8200/",
            actions=["click:#save"],
        )
    assert launched is False


def test_browser_form_actions_are_bounded_and_dispatch_changes():
    class FakeCdp:
        def __init__(self, results):
            self.results = iter(results)
            self.expressions = []

        def evaluate(self, expression, **_kwargs):
            self.expressions.append(expression)
            return next(self.results)

    cdp = FakeCdp(["filled", "selected", "changed", "changed"])

    assert _perform_action(cdp, "fill:#title:复习英语") == "filled #title"
    assert _perform_action(cdp, "select:#pomoTask:4") == "selected #pomoTask=4"
    assert _perform_action(cdp, "check:#done") == "checked #done"
    assert _perform_action(cdp, "uncheck:#done") == "unchecked #done"
    joined = "\n".join(cdp.expressions)
    assert "dispatchEvent(new Event('input'" in joined
    assert "HTMLSelectElement" in joined
    assert "el.checked=true" in joined
    assert "el.checked=false" in joined


def test_browser_click_supports_human_readable_button_text_selector():
    class FakeCdp:
        def __init__(self):
            self.expression = ""

        def evaluate(self, expression, **_kwargs):
            self.expression = expression
            return "clicked"

    cdp = FakeCdp()
    assert _perform_action(cdp, "click:button:＋ 添加") == "clicked button:＋ 添加"
    assert "querySelectorAll(scope)" in cdp.expression
    assert "raw.indexOf(':')" in cdp.expression
    assert ".wk-block" in cdp.expression
    assert "PointerEvent('pointerdown'" in cdp.expression
    assert "PointerEvent('pointerup'" in cdp.expression
    assert "el.click()" in cdp.expression


def test_subagent_adapter_scope_restores_and_isolates_threads():
    outer = object()
    first = object()
    second = object()
    with subagent_adapter_scope(outer):
        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(
                pool.map(
                    lambda adapter: _adapter_seen_inside_scope(adapter),
                    (first, second),
                )
            )
        assert values == [first, second]
        assert get_subagent_adapter() is outer
    assert get_subagent_adapter() is None


def test_primary_agentic_loop_binds_adapter_for_spawned_subagent():
    adapter = _ScriptedAdapter(
        [
            _call("s1", "spawn_subagent", {"task": "inspect", "role": "explore"}),
            _final("subagent evidence"),
            _final("main completed"),
        ]
    )
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    agent._adapter = adapter

    result = AgentLoopV2(agent).run_agentic("inspect the module", max_steps=5)

    spawn = next(item for item in result.tool_calls if item["tool"] == "spawn_subagent")
    assert spawn["success"] is True
    assert "subagent evidence" in spawn["output"]
    assert result.answer == "main completed"


def _adapter_seen_inside_scope(adapter):
    with subagent_adapter_scope(adapter):
        return get_subagent_adapter()


def test_consecutive_distinct_reads_are_bounded():
    responses = [
        _call(f"r{index}", "code_search", {"query": f"distinct-{index}"})
        for index in range(26)
    ] + [_final()]
    adapter = _ScriptedAdapter(responses)

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "inspect then act"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=30,
        executor=lambda name, args: ToolResult(name, True, "ok", ""),
    )

    assert any(item["event"] == "read_streak_blocked" for item in result.trace)
    assert sum(1 for item in result.tool_calls if item["success"]) == 24


def test_validation_task_blocks_run_script_read_bypass_until_baseline():
    responses = [
        _call(f"r{index}", "code_search", {"query": f"context-{index}"})
        for index in range(12)
    ] + [
        _call(
            "script-read",
            "run_script",
            {"language": "python", "code": "print(open('app.py').read())"},
        ),
        _call("verify", "verify_work", {}),
        _final("verified"),
    ]
    adapter = _ScriptedAdapter(responses)

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "inspect and run tests"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=20,
        task="inspect and run tests",
        executor=lambda name, args: ToolResult(name, True, "checks passed", ""),
    )

    assert result.answer == "verified"
    assert any(item["event"] == "validation_overdue_blocked" for item in result.trace)
    script_call = next(item for item in result.tool_calls if item["tool"] == "run_script")
    assert script_call["success"] is False
    assert script_call["meta"]["outcome"] == "blocked"
    assert not any(item["event"] == "self_correct_feedback" and item["tool"] == "run_script" for item in result.trace)
    assert any(item["tool"] == "verify_work" and item["success"] for item in result.tool_calls)


def test_update_plan_is_not_misclassified_as_context_gathering():
    responses = [
        _call(f"r{index}", "code_search", {"query": f"context-{index}"})
        for index in range(12)
    ] + [
        _call("plan", "update_plan", {"plan_json": "[]"}),
        _call("verify", "verify_work", {}),
        _final("verified"),
    ]

    result = run_tool_loop(
        _ScriptedAdapter(responses),
        [{"role": "user", "content": "inspect and run tests"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=20,
        task="inspect and run tests",
        executor=lambda name, args: ToolResult(name, True, "ok", ""),
    )

    plan_call = next(item for item in result.tool_calls if item["tool"] == "update_plan")
    assert plan_call["success"] is True
    assert result.answer == "verified"


def test_asserting_run_script_is_concrete_verification():
    adapter = _ScriptedAdapter(
        [
            _call("write", "edit_file", {"filename": "greet.py", "old_string": "x", "new_string": "y"}),
            _call(
                "verify",
                "run_script",
                {"language": "python", "code": "from greet import greet\nassert greet() == 'Hello, World!'"},
            ),
            _final("greet.py updated and verified"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix greet.py"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=6,
        task="fix greet.py and verify it",
        executor=lambda name, args: ToolResult(name, True, "ok", ""),
    )

    assert result.answer == "greet.py updated and verified"
    assert result.incomplete_report is None


def test_run_script_language_is_recovered_from_unambiguous_code():
    captured = {}
    adapter = _ScriptedAdapter(
        [
            _call("script", "run_script", {"code": "import os\nprint(os.getcwd())"}),
            _final("done"),
        ]
    )

    def execute(name, args):
        captured.update(args)
        return ToolResult(name, True, "ok", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "run a Python validation"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        task="run a Python validation",
        executor=execute,
    )

    assert result.answer == "done"
    assert captured["language"] == "python"
    assert any(item["event"] == "tool_arguments_recovered" for item in result.trace)


def test_resume_refreshes_stale_system_contract():
    class ResumeAgent:
        def __init__(self):
            self.adapter = _ScriptedAdapter([_final("continued")])
            self.reasoning_effort = "medium"

        def _should_use_structured_reasoning(self, _task):
            return False

        def build_messages(self, task, *, use_reasoning=False):
            return [
                {"role": "system", "content": "current runtime contract"},
                {"role": "user", "content": task},
            ]

    loop = AgentLoopV2(ResumeAgent())
    result = loop.run_agentic(
        "original task\n\nContinuation request: continue",
        max_steps=3,
        resume_messages=[
            {"role": "system", "content": "stale contract"},
            {"role": "user", "content": "original task"},
            {"role": "assistant", "content": "unfinished"},
            {"role": "user", "content": "continue"},
        ],
    )

    assert result.answer == "continued"
    assert result.messages[0] == {"role": "system", "content": "current runtime contract"}
    assert all(item.get("content") != "stale contract" for item in result.messages)


def test_agentic_loop_emits_incremental_checkpoint_after_tool_batch():
    snapshots = []
    adapter = _ScriptedAdapter(
        [
            _call("read", "code_search", {"query": "entrypoint"}),
            _final("done"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "inspect"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        task="inspect",
        executor=lambda name, args: ToolResult(name, True, "evidence", ""),
        on_checkpoint=lambda messages, step, calls: snapshots.append(
            (messages, step, calls)
        ),
    )

    assert result.answer == "done"
    assert snapshots and snapshots[-1][1] == 1
    assert snapshots[-1][2][-1]["tool"] == "code_search"
    assert snapshots[-1][0][-1]["role"] == "tool"
    assert any(item["event"] == "checkpoint_persisted" for item in result.trace)


def test_changing_temporary_helper_rewrites_are_bounded():
    responses = [
        _call(
            f"w{index}",
            "write_file",
            {"filename": "_check.py", "content": f"print({index})"},
        )
        for index in range(3)
    ] + [_final()]
    adapter = _ScriptedAdapter(responses)
    executed: list[dict] = []

    def execute(name, args):
        executed.append(args)
        return ToolResult(name, True, "ok", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "validate repeatedly"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=8,
        executor=execute,
    )

    assert len(executed) == 2
    assert any(item["event"] == "temporary_helper_churn_blocked" for item in result.trace)


def test_browser_success_claim_requires_real_browser_tool_evidence():
    adapter = _ScriptedAdapter(
        [
            _final("浏览器测试通过"),
            _call("b1", "test_browser", {"url": "index.html"}),
            _final("浏览器测试通过"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "test the page"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(name, True, "Runtime issues: 0", ""),
    )

    assert result.answer == "浏览器测试通过"
    assert any(item["event"] == "browser_evidence_required" for item in result.trace)
    assert any(item["tool"] == "test_browser" and item["success"] for item in result.tool_calls)


def test_browser_result_with_runtime_issues_cannot_support_success_claim():
    adapter = _ScriptedAdapter(
        [
            _call("b1", "test_browser", {"url": "index.html"}),
            _final("browser test passed"),
            _final("browser test passed"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "test the page"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nRuntime issues: 2",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_approved_browser_interaction_can_support_success_claim():
    adapter = _ScriptedAdapter(
        [
            _call(
                "b1",
                "interact_browser",
                {"url": "index.html", "actions": ["click:#open"]},
            ),
            _final("browser interaction passed"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "test the browser interaction"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=3,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nRuntime issues: 0",
            "",
        ),
    )

    assert result.answer == "browser interaction passed"
    assert result.verifications == [
        {"tool": "interact_browser", "step": 1, "passed": True, "command": ""}
    ]


def test_repeated_unsupported_browser_claim_becomes_incomplete():
    result = run_tool_loop(
        _ScriptedAdapter([_final("browser test passed"), _final("browser test passed")]),
        [{"role": "user", "content": "test the page"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=3,
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"
    assert result.incomplete_report["stop_reason"] == "browser_verification_missing"
    assert "No browser-test success is being reported" in result.answer


@pytest.mark.parametrize(
    "claim",
    [
        "移动端适配已经完成，375px 设备核心功能可用。",
        "响应式布局正常。",
        "首页页面渲染正确。",
        "The responsive layout works at mobile widths.",
    ],
)
def test_responsive_and_rendering_claims_require_browser_evidence(claim):
    result = run_tool_loop(
        _ScriptedAdapter([_final(claim), _final(claim)]),
        [{"role": "user", "content": "validate the responsive page"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=3,
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"
    assert any(item["event"] == "browser_evidence_required" for item in result.trace)


def test_claimed_mobile_width_must_match_actual_browser_viewport():
    adapter = _ScriptedAdapter(
        [
            _call("b1", "test_browser", {"url": "index.html", "viewport_width": 1280}),
            _final("移动端适配通过，375px 设备无水平溢出。"),
            _final("移动端适配通过，375px 设备无水平溢出。"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "test desktop and mobile"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nViewport: 1280x720\nRuntime issues: 0",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"
    assert any(item["event"] == "browser_evidence_required" for item in result.trace)


def test_claimed_mobile_width_accepts_matching_browser_viewport():
    adapter = _ScriptedAdapter(
        [
            _call("b1", "test_browser", {"url": "index.html", "viewport_width": 375}),
            _final("移动端适配通过，375px 设备无水平溢出。"),
        ]
    )

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "test mobile"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nViewport: 375x812\nRuntime issues: 0\n"
            "Visible text sample: Product dashboard",
            "",
        ),
    )

    assert result.answer == "移动端适配通过，375px 设备无水平溢出。"


def test_claimed_unicode_viewport_dimensions_require_matching_width():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call("b1", "test_browser", {"url": "index.html", "viewport_width": 1280}),
            _final("浏览器页面桌面 1280×800 与移动端 375×800 回归均通过。"),
            _final("浏览器页面桌面 1280×800 与移动端 375×800 回归均通过。"),
        ]),
        [{"role": "user", "content": "test desktop and mobile"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nViewport: 1280x800\n"
            "Runtime issues: 0\nVisible text sample: Product dashboard",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_short_loading_shell_is_not_mobile_product_evidence():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call("b1", "test_browser", {"url": "index.html", "viewport_width": 375}),
            _final("移动端浏览器 375×800 完整页面回归通过。"),
            _final("移动端浏览器 375×800 完整页面回归通过。"),
        ]),
        [{"role": "user", "content": "test the loaded mobile product"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nViewport: 375x800\n"
            "Runtime issues: 0\nVisible text sample: "
            "正在加载知珩学习……如果长时间没有响应，请运行 npm run dev。",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_code_runner_error_path_claim_requires_fill_and_visible_error():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call(
                "b1",
                "interact_browser",
                {"url": "index.html", "actions": ["click:#run"]},
            ),
            _final("CodeRunner/Pyodide 错误路径已验证。"),
            _final("CodeRunner/Pyodide 错误路径已验证。"),
        ]),
        [{"role": "user", "content": "verify the Pyodide error path"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nActions completed: [clicked #run]\nRuntime issues: 0",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_code_runner_error_path_claim_accepts_edit_run_error_evidence():
    adapter = _ScriptedAdapter([
        _call(
            "b1",
            "interact_browser",
            {
                "url": "index.html",
                "actions": ["fill:#editor:raise ValueError('boom')", "click:#run"],
            },
        ),
        _final("CodeRunner/Pyodide 错误路径已验证。"),
    ])

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "verify the Pyodide error path"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=4,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nActions completed: [filled #editor, clicked #run]"
            "\nVisible text sample: ❌ ValueError: boom\nRuntime issues: 0",
            "",
        ),
    )

    assert result.answer == "CodeRunner/Pyodide 错误路径已验证。"


def test_code_runner_error_path_ignores_empty_diagnostic_error_labels():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call(
                "b1",
                "interact_browser",
                {
                    "url": "index.html",
                    "actions": ["fill:#editor:raise ValueError('boom')", "click:#run"],
                },
            ),
            _final("CodeRunner/Pyodide error path verified."),
            _final("CodeRunner/Pyodide error path verified."),
        ]),
        [{"role": "user", "content": "verify the Pyodide error path"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nRuntime issues: 0\n"
            "Console errors: []\nPage errors: []\n"
            "Visible text sample: loading... Clear",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_code_runner_error_path_does_not_treat_input_inventory_as_visible_text():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call(
                "b1",
                "interact_browser",
                {
                    "url": "index.html",
                    "actions": [
                        "fill:#editor:raise ValueError('ARFORGE_ERROR_PATH')",
                        "click:#run",
                    ],
                },
            ),
            _final("CodeRunner/Pyodide 错误路径显示 ValueError: ARFORGE_ERROR_PATH ❌。"),
            _final("CodeRunner/Pyodide 错误路径显示 ValueError: ARFORGE_ERROR_PATH ❌。"),
        ]),
        [{"role": "user", "content": "verify the Pyodide error path"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nRuntime issues: 0\n"
            "Visible text sample: loading... Clear\n"
            "Buttons: [{\"text\": \"Run\"}]\n"
            "Inputs: [{\"value\": \"raise ValueError('ARFORGE_ERROR_PATH')\"}]",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_code_runner_fixture_page_cannot_satisfy_product_browser_claim():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call(
                "b1",
                "interact_browser",
                {
                    "url": "http://localhost:5199/pyodide-test.html",
                    "actions": [
                        "fill:#editor:raise ValueError('ARFORGE_ERROR_PATH')",
                        "click:#run",
                    ],
                },
            ),
            _final("CodeRunner/Pyodide 错误路径显示 ValueError: ARFORGE_ERROR_PATH ❌。"),
            _final("CodeRunner/Pyodide 错误路径显示 ValueError: ARFORGE_ERROR_PATH ❌。"),
        ]),
        [{"role": "user", "content": "verify the product CodeRunner"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\n"
            "Final URL: http://localhost:5199/pyodide-test.html\n"
            "Runtime issues: 0\n"
            "Visible text sample: ❌ ValueError: ARFORGE_ERROR_PATH",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_claimed_browser_output_markers_must_appear_in_visible_text():
    result = run_tool_loop(
        _ScriptedAdapter([
            _call(
                "b1",
                "interact_browser",
                {
                    "url": "index.html",
                    "actions": ["fill:#editor:raise ValueError('boom')", "click:#run"],
                },
            ),
            _final(
                "CodeRunner/Pyodide error path verified; "
                "ARFORGE_ERROR_PATH and SUCCESS_PATH_OK were visible."
            ),
            _final(
                "CodeRunner/Pyodide error path verified; "
                "ARFORGE_ERROR_PATH and SUCCESS_PATH_OK were visible."
            ),
        ]),
        [{"role": "user", "content": "verify both browser output markers"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=5,
        executor=lambda name, args: ToolResult(
            name,
            True,
            "=== Real Browser Validation ===\nRuntime issues: 0\n"
            "Visible text sample: ValueError: boom",
            "",
        ),
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "browser_verification_missing"


def test_npm_missing_version_claim_requires_registry_query():
    result = run_tool_loop(
        _ScriptedAdapter([
            _final("vite 8.1.1 版本不存在。"),
            _final("vite 8.1.1 版本不存在。"),
        ]),
        [{"role": "user", "content": "check the dependency version"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=3,
    )

    assert result.answer.startswith("[Arforge] Task incomplete")
    assert result.self_correct["stop_reason"] == "registry_evidence_missing"


def test_npm_missing_version_claim_accepts_registry_query():
    from arforge.core.permission import permission_scope

    with permission_scope("fullAccess"):
        result = run_tool_loop(
            _ScriptedAdapter([
                _call("n1", "run_cmd", {"command": "npm view vite@8.1.1 version"}),
                _final("旧报告称 vite 8.1.1 版本不存在；npm view 已证明该说法错误。"),
            ]),
            [{"role": "user", "content": "check the dependency version"}],
            tools=REGISTRY.to_openai_tools(),
            max_steps=4,
            executor=lambda name, args: ToolResult(name, True, "8.1.1", ""),
        )

    assert result.answer == "旧报告称 vite 8.1.1 版本不存在；npm view 已证明该说法错误。"


def test_browser_exception_keeps_actionable_description():
    detail = {
        "text": "Uncaught",
        "exception": {
            "description": "ReferenceError: missingInit is not defined\n    at app.js:10:3"
        },
    }

    assert _page_error_text(detail).startswith(
        "ReferenceError: missingInit is not defined"
    )


def test_agent_timeout_setting_is_disabled(tmp_path):
    settings = SettingsRuntime(tmp_path / "settings.json")

    updated = settings.update({"chat_timeout_ms": 0}, expected_revision=0)

    # Agent operations have no wall-clock deadline by default and remain
    # independently cancellable through the operation guard.
    assert MAX_TIMEOUT_MS == 86_400_000
    assert updated["settings"]["chat_timeout_ms"] == 0
    with pytest.raises(SettingsRuntimeError, match="invalid value"):
        settings.update({"chat_timeout_ms": 1_000}, expected_revision=1)
