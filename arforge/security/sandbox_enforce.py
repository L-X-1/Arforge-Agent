"""Sandbox hardening — dangerous command interception, directory traversal protection,
network boundary enforcement, and audit trail (G18).

This module provides the enforcement layer on top of runtime_sandbox.py's
classification. It intercepts tool execution and blocks dangerous operations
before they reach the OS.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable


# ---------------------------------------------------------------------------
# Audit trail
# ---------------------------------------------------------------------------


class SandboxDecision(str, Enum):
    ALLOWED = "allowed"
    BLOCKED_DANGEROUS = "blocked_dangerous"
    BLOCKED_TRAVERSAL = "blocked_traversal"
    BLOCKED_NETWORK = "blocked_network"
    BLOCKED_WRITE_READONLY = "blocked_write_readonly"
    BLOCKED_PROTECTED_PATH = "blocked_protected_path"


@dataclass
class AuditEntry:
    timestamp: str = ""
    tool: str = ""
    args: str = ""
    decision: SandboxDecision = SandboxDecision.ALLOWED
    reason: str = ""
    workspace: str = ""


class AuditTrail:
    """In-memory audit trail for sandbox decisions."""

    def __init__(self, max_entries: int = 1000) -> None:
        self._entries: list[AuditEntry] = []
        self._max = max_entries
        self._blocked_count = 0
        self._allowed_count = 0

    def record(self, entry: AuditEntry) -> None:
        self._entries.append(entry)
        if len(self._entries) > self._max:
            self._entries = self._entries[-self._max:]
        if entry.decision != SandboxDecision.ALLOWED:
            self._blocked_count += 1
        else:
            self._allowed_count += 1

    def stats(self) -> dict:
        return {
            "total": len(self._entries),
            "allowed": self._allowed_count,
            "blocked": self._blocked_count,
            "recent": [
                {"tool": e.tool, "decision": e.decision.value, "reason": e.reason}
                for e in self._entries[-10:]
            ],
        }

    def entries(self, *, limit: int = 20) -> list[dict]:
        return [
            {
                "tool": e.tool,
                "args": e.args,
                "decision": e.decision.value,
                "reason": e.reason,
                "workspace": e.workspace,
            }
            for e in self._entries[-max(1, min(limit, 200)) :]
        ]

    def clear(self) -> None:
        self._entries.clear()
        self._blocked_count = 0
        self._allowed_count = 0


_audit = AuditTrail()


def get_audit_trail() -> AuditTrail:
    return _audit


# ---------------------------------------------------------------------------
# Dangerous command patterns
# ---------------------------------------------------------------------------


# Commands that are always blocked regardless of mode
_ALWAYS_BLOCKED_COMMANDS = {
    "rm", "-rf", "rmdir", "del", "format",
    "shutdown", "reboot", "halt", "poweroff",
    "chmod", "chown", "cacls", "icacls",
    "dd", "mkfs", "fdisk", "diskpart",
    "sudo", "su", "runas",
    "kill", "pkill", "taskkill", "tskill",
    ":(){ :|:& };:",  # fork bomb
}

# Patterns that indicate data destruction
_DESTRUCTIVE_PATTERNS = [
    re.compile(r"(?i)rm\s+-rf\s+/"),
    re.compile(r"(?i)remove-item\s+-recurse\s+-force"),
    re.compile(r"(?i)del\s+/[fsq].*\*"),
    re.compile(r"(?i)format\s+[a-zA-Z]:"),
    re.compile(r"(?i)>?\s*/dev/null"),
    re.compile(r"(?i)drop\s+(table|database)"),
]

# Patterns indicating directory traversal attempt
_TRAVERSAL_PATTERNS = [
    re.compile(r"\.\./\.\./\.\."),
    re.compile(r"\.\.\\\.\.\\"),
    re.compile(r"(?i)%systemroot%"),
    re.compile(r"(?i)/etc/(passwd|shadow|sudoers)"),
    re.compile(r"(?i)c:\\\\windows\\\\system32"),
    re.compile(r"(?i)~\/\.ssh"),
]

# Safe workspace prefix
_SAFE_PREFIXES: set[str] = set()

# Network callbacks
_network_allowed_callback: Callable[[str, str], bool] | None = None


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------


def set_workspace(workspace: str | Path) -> None:
    """Refresh safe prefixes from the primary and explicitly authorized roots."""
    primary = Path(workspace).resolve()
    try:
        from arforge.workspace_roots import authorized_workspace_roots

        roots = authorized_workspace_roots(primary)
    except Exception:  # noqa: BLE001 - sandbox must retain a safe primary-root fallback
        roots = [primary]
    _SAFE_PREFIXES.clear()
    for root in roots:
        resolved = str(root.resolve())
        _SAFE_PREFIXES.add(resolved)
        _SAFE_PREFIXES.add(resolved + os.sep)
        _SAFE_PREFIXES.add(resolved + "/")


def is_path_safe(path: str | Path) -> bool:
    """Check if a path is within the trusted workspace."""
    if not _SAFE_PREFIXES:
        return True  # No workspace set, cannot enforce

    resolved = str(Path(path).resolve())
    for prefix in _SAFE_PREFIXES:
        if resolved.startswith(prefix) or resolved == prefix.rstrip(os.sep).rstrip("/"):
            return True
    return False


_PROTECTED_PATH_SEGMENTS = {
    "windows", "system32", "syswow64", "program files", "program files (x86)", "etc",
    "boot", "recovery", "$recycle.bin", "system volume information",
    ".git", ".svn", ".hg", "node_modules", "__pycache__",
    ".ssh", ".aws", ".azure", ".gnupg",
}
_PROTECTED_SUFFIXES = {".exe", ".bat", ".cmd", ".ps1", ".com", ".scr", ".msi", ".dll", ".sys", ".vbs"}
_EDITABLE_WORKSPACE_SCRIPT_SUFFIXES = {".bat", ".cmd", ".ps1"}


def protected_path_reason(path: str | Path) -> str:
    """Return a hard-block reason for protected local paths, or an empty string."""
    try:
        resolved = Path(path).expanduser().resolve()
    except Exception:  # noqa: BLE001
        return "path could not be resolved safely"
    resolved_str = str(resolved).replace("\\", "/").lower()
    segments = {part for part in resolved_str.split("/") if part}
    if segments & _PROTECTED_PATH_SEGMENTS:
        return "protected system, credential, VCS, dependency, or build directory"
    if resolved.suffix.lower() in _PROTECTED_SUFFIXES:
        return "executable or system binary writes are blocked"
    try:
        if resolved.parent == resolved.parents[-1]:
            return "filesystem root writes are blocked"
    except IndexError:
        return "filesystem root writes are blocked"
    return ""


def check_directory_traversal(args: str) -> SandboxDecision | None:
    """Check if command args attempt directory traversal."""
    for pattern in _TRAVERSAL_PATTERNS:
        if pattern.search(args):
            return SandboxDecision.BLOCKED_TRAVERSAL
    return None


# ---------------------------------------------------------------------------
# Command safety
# ---------------------------------------------------------------------------


def classify_command(command: str) -> str:
    """Classify a command: 'safe', 'dangerous', 'network', 'destructive', 'traversal'."""
    cmd_lower = command.lower().strip()
    cmd_first = cmd_lower.split()[0] if cmd_lower else ""

    # Check always-blocked
    if cmd_first in _ALWAYS_BLOCKED_COMMANDS:
        return "dangerous"

    # Check destructive patterns
    for pattern in _DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            return "destructive"

    # Check traversal
    for pattern in _TRAVERSAL_PATTERNS:
        if pattern.search(command):
            return "traversal"

    # Check network commands
    network_binaries = {
        "curl", "wget", "ssh", "scp", "sftp", "nc", "netcat",
        "nslookup", "dig", "host", "ping", "traceroute", "tracert",
    }
    if cmd_first in network_binaries:
        return "network"

    return "safe"


def check_command_safety(command: str, sandbox_mode: str = "workspace-write") -> tuple[SandboxDecision, str]:
    """Check a command before execution.

    Returns (decision, reason).
    """
    cmd_class = classify_command(command)

    if cmd_class == "dangerous":
        return SandboxDecision.BLOCKED_DANGEROUS, f"Dangerous command blocked: {command[:80]}"

    if cmd_class == "destructive":
        return SandboxDecision.BLOCKED_DANGEROUS, f"Destructive command blocked: {command[:80]}"

    if cmd_class == "traversal":
        return SandboxDecision.BLOCKED_TRAVERSAL, f"Directory traversal blocked: {command[:80]}"

    if sandbox_mode == "read-only":
        if cmd_class == "network":
            return SandboxDecision.BLOCKED_NETWORK, f"Network command blocked in read-only mode: {command[:80]}"
        return SandboxDecision.BLOCKED_WRITE_READONLY, f"Command blocked in read-only mode: {command[:80]}"

    try:
        from arforge.core.runtime_sandbox import decide_network_egress

        network = decide_network_egress(command, mode=sandbox_mode)
        if not network.allowed:
            return SandboxDecision.BLOCKED_NETWORK, network.reason or f"Network command blocked: {command[:80]}"
    except Exception:  # noqa: BLE001
        if cmd_class == "network":
            if sandbox_mode == "read-only":
                return SandboxDecision.BLOCKED_NETWORK, f"Network command blocked in read-only mode: {command[:80]}"
            if _network_allowed_callback:
                cmd_first = command.strip().split()[0] if command.strip() else ""
                if not _network_allowed_callback(cmd_first, command):
                    return SandboxDecision.BLOCKED_NETWORK, f"Network command not in allowlist: {command[:80]}"

    return SandboxDecision.ALLOWED, ""


def set_network_callback(callback: Callable[[str, str], bool]) -> None:
    """Set a callback for network allowlisting."""
    global _network_allowed_callback
    _network_allowed_callback = callback


# ---------------------------------------------------------------------------
# File write safety
# ---------------------------------------------------------------------------


def check_file_write(path: str | Path, sandbox_mode: str = "workspace-write") -> tuple[SandboxDecision, str]:
    """Check if a file write is allowed.

    Returns (decision, reason).
    """
    if sandbox_mode == "read-only":
        return SandboxDecision.BLOCKED_WRITE_READONLY, f"Write blocked in read-only mode: {path}"

    reason = protected_path_reason(path)
    if reason:
        candidate = Path(path)
        editable_workspace_script = (
            reason == "executable or system binary writes are blocked"
            and candidate.suffix.lower() in _EDITABLE_WORKSPACE_SCRIPT_SUFFIXES
            and bool(_SAFE_PREFIXES)
            and is_path_safe(candidate)
        )
        if not editable_workspace_script:
            return SandboxDecision.BLOCKED_PROTECTED_PATH, f"Protected path blocked: {path} ({reason})"

    if sandbox_mode == "workspace-write":
        if not is_path_safe(path):
            return SandboxDecision.BLOCKED_TRAVERSAL, f"Write outside workspace blocked: {path}"

    return SandboxDecision.ALLOWED, ""


# ---------------------------------------------------------------------------
# Unified enforcement
# ---------------------------------------------------------------------------


def enforce(
    tool_name: str,
    tool_args: dict | None = None,
    sandbox_mode: str = "workspace-write",
    workspace: str | None = None,
) -> tuple[SandboxDecision, str]:
    """Unified sandbox enforcement for tool execution.

    Returns (decision, reason). If decision is ALLOWED, proceed.
    """
    args = tool_args or {}

    if workspace:
        set_workspace(workspace)

    # Check command execution
    if tool_name in {"run_cmd", "run_background_cmd"}:
        command = args.get("command", args.get("cmd", ""))
        if command:
            decision, reason = check_command_safety(str(command), sandbox_mode)
            if decision != SandboxDecision.ALLOWED:
                _audit.record(AuditEntry(
                    tool=tool_name,
                    args=str(command)[:200],
                    decision=decision,
                    reason=reason,
                    workspace=workspace or "",
                ))
                return decision, reason

    # Check file writes/deletes
    if tool_name in ("write_file", "edit_file", "replace_in_file", "create_file", "delete_file", "apply_patch_batch", "write_docx"):
        filepath = args.get("filename") or args.get("path") or args.get("file_path") or args.get("file") or ""
        if filepath:
            checked_path = Path(str(filepath))
            if workspace and not checked_path.is_absolute():
                checked_path = Path(workspace) / checked_path
            decision, reason = check_file_write(str(checked_path), sandbox_mode)
            if decision != SandboxDecision.ALLOWED:
                _audit.record(AuditEntry(
                    tool=tool_name,
                    args=str(filepath)[:200],
                    decision=decision,
                    reason=reason,
                    workspace=workspace or "",
                ))
                return decision, reason

    _audit.record(AuditEntry(
        tool=tool_name,
        args=str(args)[:200],
        decision=SandboxDecision.ALLOWED,
        reason="",
        workspace=workspace or "",
    ))
    return SandboxDecision.ALLOWED, ""


def current_sandbox_report(*, limit: int = 20) -> dict:
    """Return the active local sandbox policy and recent decisions."""
    from arforge.core.runtime_sandbox import default_network_allowlist, normalize_mode

    mode = "workspace-write"
    permission_mode = None
    try:
        from arforge.core.permission import PermissionMode, get_permission_manager

        current = get_permission_manager().get_mode()
        permission_mode = current.value if isinstance(current, PermissionMode) else current
        if permission_mode:
            mode = normalize_mode(permission_mode).value
    except Exception:  # noqa: BLE001
        pass

    workspace = ""
    try:
        from arforge.tools.file_tools import WORKSPACE

        workspace = str(WORKSPACE.resolve())
    except Exception:  # noqa: BLE001
        pass

    return {
        "schema_version": 1,
        "mode": mode,
        "permission_mode": permission_mode,
        "workspace": workspace,
        "network_allowlist": sorted(default_network_allowlist()),
        "audit": get_audit_trail().stats(),
        "recent": get_audit_trail().entries(limit=limit),
    }
