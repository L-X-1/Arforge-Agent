from __future__ import annotations

import json

import pytest

from arforge.core.hooks import reset_hook_manager
from arforge.core.permission import (
    PermissionMode,
    classify_command,
    get_permission_manager,
    install_permission_hooks,
    reset_permission_manager,
)
from arforge.core.runtime_sandbox import (
    SandboxMode,
    decide_network_egress,
    extract_network_hosts,
    normalize_mode,
)
from arforge.security.sandbox_enforce import SandboxDecision, enforce
from arforge.tool_registry import ToolResult


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    reset_hook_manager()
    reset_permission_manager()
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    monkeypatch.delenv("ARFORGE_NETWORK_ALLOWLIST", raising=False)
    yield
    reset_hook_manager()
    reset_permission_manager()


def test_sandbox_mode_aliases_match_existing_permission_modes():
    assert normalize_mode("requestApproval") == SandboxMode.LOCAL_COMPUTER
    assert normalize_mode("autoApprove") == SandboxMode.LOCAL_COMPUTER
    assert normalize_mode("fullAccess") == SandboxMode.LOCAL_COMPUTER
    assert normalize_mode("plan") == SandboxMode.READ_ONLY
    assert normalize_mode("acceptEdits") == SandboxMode.WORKSPACE_WRITE
    assert normalize_mode("auto") == SandboxMode.DANGER_FULL


def test_network_host_extraction_supports_urls_and_git_shorthand():
    assert extract_network_hosts("git clone https://github.com/org/repo.git") == ["github.com"]
    assert extract_network_hosts("git clone git@github.com:org/repo.git") == ["github.com"]
    assert extract_network_hosts("pip install pytest") == ["pypi.org", "files.pythonhosted.org"]


def test_network_allowlist_blocks_unknown_host():
    decision = decide_network_egress(
        "git clone https://evil.example/repo.git",
        mode="workspace-write",
        allowlist=frozenset({"github.com"}),
    )

    assert not decision.allowed
    assert decision.blocked_hosts == ("evil.example",)
    assert "allowlisted" in decision.reason


def test_network_allowlist_allows_subdomains():
    decision = decide_network_egress(
        "git clone https://api.github.com/org/repo.git",
        mode="workspace-write",
        allowlist=frozenset({"github.com"}),
    )

    assert decision.allowed
    assert decision.hosts == ("api.github.com",)


def test_read_only_sandbox_denies_network_even_when_host_allowed():
    decision = decide_network_egress(
        "git clone https://github.com/org/repo.git",
        mode="read-only",
        allowlist=frozenset({"github.com"}),
    )

    assert not decision.allowed
    assert "read-only" in decision.reason


def test_local_computer_sandbox_allows_network_without_allowlist():
    decision = decide_network_egress(
        "git clone https://evil.example/repo.git",
        mode="autoApprove",
        allowlist=frozenset({"github.com"}),
    )

    assert decision.allowed
    assert decision.hosts == ("evil.example",)


def test_read_only_sandbox_denies_workspace_commands():
    decision, reason = enforce("run_cmd", {"command": "echo hello"}, sandbox_mode="read-only")

    assert decision == SandboxDecision.BLOCKED_WRITE_READONLY
    assert "read-only" in reason


def test_workspace_write_sandbox_blocks_filename_outside_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside.txt"
    workspace.mkdir()

    decision, reason = enforce(
        "write_file",
        {"filename": str(outside)},
        sandbox_mode="workspace-write",
        workspace=str(workspace),
    )

    assert decision == SandboxDecision.BLOCKED_TRAVERSAL
    assert "outside workspace" in reason


def test_workspace_write_sandbox_blocks_delete_outside_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside.txt"
    workspace.mkdir()
    outside.write_text("x", encoding="utf-8")

    decision, reason = enforce(
        "delete_file",
        {"filename": str(outside)},
        sandbox_mode="workspace-write",
        workspace=str(workspace),
    )

    assert decision == SandboxDecision.BLOCKED_TRAVERSAL
    assert "outside workspace" in reason


def test_local_computer_sandbox_allows_filename_outside_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside.txt"
    workspace.mkdir()

    decision, reason = enforce(
        "write_file",
        {"filename": str(outside)},
        sandbox_mode="local-computer",
        workspace=str(workspace),
    )

    assert decision == SandboxDecision.ALLOWED
    assert reason == ""


def test_local_computer_sandbox_blocks_protected_write():
    target = "C:\\Windows\\System32\\evil.txt" if __import__("os").name == "nt" else "/etc/evil.txt"

    decision, reason = enforce(
        "write_file",
        {"filename": target},
        sandbox_mode="local-computer",
    )

    assert decision == SandboxDecision.BLOCKED_PROTECTED_PATH
    assert "Protected path" in reason


def test_local_computer_sandbox_allows_editable_script_inside_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    decision, reason = enforce(
        "write_file",
        {"filename": "start.bat"},
        sandbox_mode="local-computer",
        workspace=str(workspace),
    )

    assert decision == SandboxDecision.ALLOWED
    assert reason == ""


def test_file_tool_auto_approve_writes_local_path_outside_workspace(tmp_path, monkeypatch):
    import arforge.tools.file_tools as ft

    workspace = tmp_path / "workspace"
    outside = tmp_path / "Desktop" / "note.txt"
    workspace.mkdir()
    outside.parent.mkdir()
    monkeypatch.setattr(ft, "WORKSPACE", workspace)
    get_permission_manager().set_mode(PermissionMode.AUTO_APPROVE)

    assert "wrote" in ft.write_file(str(outside), "hello")
    assert outside.read_text(encoding="utf-8") == "hello"


def test_legacy_workspace_write_escalates_non_allowlisted_network_to_dangerous(monkeypatch):
    monkeypatch.setenv("ARFORGE_NETWORK_ALLOWLIST", "github.com")
    get_permission_manager().set_mode(PermissionMode.ACCEPT_EDITS)

    assert classify_command("git clone https://github.com/org/repo.git") == "network"
    assert classify_command("git clone https://evil.example/repo.git") == "dangerous"


def test_modern_local_computer_modes_keep_network_as_network(monkeypatch):
    monkeypatch.setenv("ARFORGE_NETWORK_ALLOWLIST", "github.com")
    get_permission_manager().set_mode(PermissionMode.AUTO_APPROVE)

    assert classify_command("git clone https://evil.example/repo.git") == "network"


class _ToolCall:
    id = "call-1"
    name = "run_cmd"

    def __init__(self, command: str):
        self.arguments = json.dumps({"command": command})


class _Adapter:
    model_name = "fake"

    def __init__(self, command: str):
        self.command = command
        self.calls = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        self.calls += 1
        if self.calls == 1:
            return type("Response", (), {"content": "", "tool_calls": [_ToolCall(self.command)], "usage": {}})()
        return type("Response", (), {"content": "done", "tool_calls": [], "usage": {}})()


def test_permission_hook_blocks_non_allowlisted_network_command(monkeypatch):
    from arforge.core.agentic import run_tool_loop

    monkeypatch.setenv("ARFORGE_NETWORK_ALLOWLIST", "github.com")
    install_permission_hooks("acceptEdits")
    executed: list[tuple[str, dict]] = []

    def executor(name: str, args: dict) -> ToolResult:
        executed.append((name, dict(args)))
        return ToolResult(name, True, "ok")

    result = run_tool_loop(
        _Adapter("git clone https://evil.example/repo.git"),
        [{"role": "user", "content": "clone"}],
        tools=[],
        executor=executor,
    )

    assert executed == []
    assert any(item["tool"] == "run_cmd" and not item["success"] for item in result.tool_calls)


def test_bridge_exposes_sandbox_status(monkeypatch, tmp_path):
    from arforge.bridge import dispatch

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    enforce("run_cmd", {"command": "git clone https://evil.example/repo.git"}, sandbox_mode="workspace-write")

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 2, "version": "1.1", "method": "sandbox.status", "params": {"limit": 5}})

    assert "sandbox.status" in described["data"]["methods"]
    assert response["ok"]
    assert response["data"]["schema_version"] == 1
    assert response["data"]["audit"]["total"] >= 1
    assert response["data"]["recent"]


def test_cli_sandbox_status_renders(capsys):
    from arforge.cli import _run_sandbox_status

    assert _run_sandbox_status() == 0
    output = capsys.readouterr().out
    assert "Runtime Sandbox" in output
    assert "Network allowlist" in output
