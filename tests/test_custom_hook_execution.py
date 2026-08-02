from __future__ import annotations

import json
import sys

from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager


def _write_hook(path, *, command):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "name": "protect-shell",
                "event": "pre_tool_use",
                "description": "Block shell execution for this workspace.",
                "enabled": True,
                "matcher": "run_cmd",
                "timeout_seconds": 10,
                "command": command,
            }
        ),
        encoding="utf-8",
    )


def test_custom_hook_execution_is_disabled_by_default(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _write_hook(
        workspace / ".arforge" / "hooks" / "protect.json",
        command=[sys.executable, "-c", "import json; print(json.dumps({'action': 'block'}))"],
    )
    monkeypatch.chdir(workspace)
    monkeypatch.delenv("ARFORGE_ENABLE_CUSTOM_HOOKS", raising=False)
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    reset_hook_manager()
    from arforge.customization import install_custom_hooks

    result = install_custom_hooks()

    assert result["installed"] == 0
    assert "requires ARFORGE_ENABLE_CUSTOM_HOOKS" in result["reason"]
    assert get_hook_manager().handler_count(HookEvent.PRE_TOOL_USE) == 0


def test_enabled_custom_hook_can_block_matching_tool_and_receives_redacted_input(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    script = (
        "import json, sys; "
        "payload = json.load(sys.stdin); "
        "assert payload['tool_args']['api_key'] == '***'; "
        "print(json.dumps({'action': 'block', 'reason': 'workspace policy'}))"
    )
    _write_hook(
        workspace / ".arforge" / "hooks" / "protect.json",
        command=[sys.executable, "-c", script],
    )
    monkeypatch.chdir(workspace)
    monkeypatch.setenv("ARFORGE_ENABLE_CUSTOM_HOOKS", "1")
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    reset_hook_manager()
    from arforge.customization import install_custom_hooks, list_customizations

    result = install_custom_hooks()
    decision = get_hook_manager().fire(
        HookContext(HookEvent.PRE_TOOL_USE, tool_name="run_cmd", tool_args={"api_key": "secret-value"})
    )
    listing = list_customizations()

    assert result == {"installed": 1, "skipped": 0, "reason": ""}
    assert decision.action == "block"
    assert decision.reason == "workspace policy"
    assert listing["hooks"]["items"][0]["command_configured"] is True
    assert "command" not in listing["hooks"]["items"][0]


def test_custom_hook_rejects_unapproved_executable(tmp_path):
    root = tmp_path / "custom"
    _write_hook(
        root / "hooks" / "unsafe.json",
        command=["powershell", "-NoProfile", "-Command", "Write-Output unsafe"],
    )
    from arforge.customization import list_customizations

    data = list_customizations([root])

    assert "command executable is not allowed for custom hooks" in data["hooks"]["items"][0]["problems"]
