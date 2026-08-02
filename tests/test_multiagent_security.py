"""Test B10: Multi-agent security boundaries.

Verifies:
- Capability whitelist enforcement
- Tool whitelist enforcement
- Token budget enforcement
- Path sandbox enforcement
- Gate check composability
- Audit logging
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from arforge.multiagent.protocol import AgentRole
from arforge.multiagent.security import (
    audit_log,
    check_capability,
    check_path_write,
    check_token_budget,
    check_tool,
    gate_check,
)


@pytest.fixture
def coder_role():
    return AgentRole(
        name="CoderAgent",
        description="Coder",
        capabilities=["safe_modify", "code_search"],
        tools=["read_file", "write_file"],
        max_tokens=4096,
    )


@pytest.fixture
def restricted_role():
    return AgentRole(
        name="RestrictedAgent",
        description="Restricted",
        capabilities=[],
        tools=["read_file"],
        max_tokens=512,
    )


class TestCapabilityWhitelist:
    def test_allowed_capability(self, coder_role):
        assert check_capability(coder_role, "safe_modify") is True

    def test_blocked_capability(self, coder_role):
        assert check_capability(coder_role, "security_review") is False

    def test_empty_capabilities(self, restricted_role):
        assert check_capability(restricted_role, "anything") is False


class TestToolWhitelist:
    def test_allowed_tool(self, coder_role):
        assert check_tool(coder_role, "read_file") is True

    def test_blocked_tool(self, coder_role):
        assert check_tool(coder_role, "run_cmd") is False

    def test_write_file_allowed_for_coder(self, coder_role):
        assert check_tool(coder_role, "write_file") is True


class TestTokenBudget:
    def test_within_budget(self, coder_role):
        assert check_token_budget(coder_role, 1000) is True

    def test_exceeds_budget(self, coder_role):
        assert check_token_budget(coder_role, 5000) is False

    def test_exact_budget(self, coder_role):
        assert check_token_budget(coder_role, 4096) is True

    def test_restricted_small_budget(self, restricted_role):
        assert check_token_budget(restricted_role, 100) is True
        assert check_token_budget(restricted_role, 1000) is False


class TestPathSandbox:
    def test_workspace_path_allowed(self, coder_role):
        workspace = Path(os.getcwd())
        test_path = workspace / "test_file.py"
        assert check_path_write(coder_role, test_path) is True

    def test_temp_dir_allowed(self, coder_role):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            tmp_path = f.name
        try:
            assert check_path_write(coder_role, tmp_path) is True
        finally:
            os.unlink(tmp_path)

    def test_system_path_blocked(self, coder_role):
        if os.name == "nt":
            assert check_path_write(coder_role, "C:\\Windows\\System32\\test.dll") is False
        else:
            assert check_path_write(coder_role, "/etc/passwd") is False


class TestGateCheck:
    def test_all_passes(self, coder_role):
        result = gate_check(
            coder_role,
            capability="safe_modify",
            tool="write_file",
            tokens_used=1000,
            write_path=str(Path(os.getcwd()) / "test.py"),
        )
        assert result["allowed"] is True
        assert len(result["blocks"]) == 0

    def test_capability_blocked(self, coder_role):
        result = gate_check(coder_role, capability="security_review")
        assert result["allowed"] is False
        assert any("capability" in b for b in result["blocks"])

    def test_tool_and_capability_blocked(self, restricted_role):
        result = gate_check(restricted_role, capability="safe_modify", tool="write_file")
        assert result["allowed"] is False
        assert len(result["blocks"]) >= 2

    def test_token_budget_blocks(self, restricted_role):
        result = gate_check(restricted_role, tokens_used=1000)
        assert result["allowed"] is False


class TestAuditLog:
    def test_audit_log_writes(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
        audit_log("TestAgent", "test_action", "test detail", allowed=True)
        log_path = tmp_path / "multiagent_audit.log"
        assert log_path.exists()
        content = log_path.read_text(encoding="utf-8")
        assert "TestAgent" in content
        assert "test_action" in content

    def test_audit_log_blocked(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
        audit_log("TestAgent", "blocked_action", allowed=False)
        log_path = tmp_path / "multiagent_audit.log"
        content = log_path.read_text(encoding="utf-8")
        assert "allowed=False" in content
