"""Runtime guardrail policy for tool execution.

The policy is deliberately local and deterministic.  It does not perform
network I/O; it classifies requested operations before execution so permission
hooks can enforce approval rules.  The modern permission modes are local-computer
modes: they are not workspace-folder sandboxes.  Workspace-only and read-only
remain as legacy explicit sandbox modes.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from enum import Enum
from urllib.parse import urlparse


class SandboxMode(str, Enum):
    READ_ONLY = "read-only"
    WORKSPACE_WRITE = "workspace-write"
    LOCAL_COMPUTER = "local-computer"
    DANGER_FULL = "danger-full"


_MODE_ALIASES = {
    "requestApproval": SandboxMode.LOCAL_COMPUTER,
    "requestapproval": SandboxMode.LOCAL_COMPUTER,
    "autoApprove": SandboxMode.LOCAL_COMPUTER,
    "autoapprove": SandboxMode.LOCAL_COMPUTER,
    "fullAccess": SandboxMode.LOCAL_COMPUTER,
    "fullaccess": SandboxMode.LOCAL_COMPUTER,
    "plan": SandboxMode.READ_ONLY,
    "readonly": SandboxMode.READ_ONLY,
    "read_only": SandboxMode.READ_ONLY,
    "read-only": SandboxMode.READ_ONLY,
    "acceptEdits": SandboxMode.WORKSPACE_WRITE,
    "acceptedits": SandboxMode.WORKSPACE_WRITE,
    "workspace_write": SandboxMode.WORKSPACE_WRITE,
    "workspace-write": SandboxMode.WORKSPACE_WRITE,
    "local": SandboxMode.LOCAL_COMPUTER,
    "local_computer": SandboxMode.LOCAL_COMPUTER,
    "local-computer": SandboxMode.LOCAL_COMPUTER,
    "auto": SandboxMode.DANGER_FULL,
    "danger": SandboxMode.DANGER_FULL,
    "danger_full": SandboxMode.DANGER_FULL,
    "danger-full": SandboxMode.DANGER_FULL,
}

_DEFAULT_NETWORK_ALLOWLIST = {
    "github.com",
    "api.github.com",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
}

_NETWORK_BINARIES = {
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "git",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "pip",
    "pip3",
    "uv",
    "poetry",
    "docker",
}


@dataclass(frozen=True)
class NetworkDecision:
    allowed: bool
    hosts: tuple[str, ...] = ()
    blocked_hosts: tuple[str, ...] = ()
    reason: str = ""


@dataclass(frozen=True)
class RuntimeSandboxPolicy:
    mode: SandboxMode = SandboxMode.WORKSPACE_WRITE
    network_allowlist: frozenset[str] = field(default_factory=lambda: frozenset(_DEFAULT_NETWORK_ALLOWLIST))

    @classmethod
    def from_mode(cls, mode: str | SandboxMode | None) -> "RuntimeSandboxPolicy":
        return cls(mode=normalize_mode(mode))


def normalize_mode(mode: str | SandboxMode | None) -> SandboxMode:
    if isinstance(mode, SandboxMode):
        return mode
    if mode is None:
        return SandboxMode.WORKSPACE_WRITE
    return _MODE_ALIASES.get(str(mode), SandboxMode.WORKSPACE_WRITE)


def default_network_allowlist() -> frozenset[str]:
    raw = os.getenv("ARFORGE_NETWORK_ALLOWLIST", "")
    if not raw.strip():
        return frozenset(_DEFAULT_NETWORK_ALLOWLIST)
    hosts = {_normalize_host(item) for item in re.split(r"[,;\s]+", raw) if item.strip()}
    return frozenset(host for host in hosts if host)


def _normalize_host(value: str) -> str:
    host = value.strip().lower()
    if not host:
        return ""
    if "://" in host:
        host = urlparse(host).hostname or ""
    host = host.strip("[]")
    if "@" in host:
        host = host.rsplit("@", 1)[-1]
    if ":" in host and not re.match(r"^[0-9a-f:]+$", host):
        host = host.split(":", 1)[0]
    return host.rstrip(".")


def host_allowed(host: str, allowlist: frozenset[str] | set[str] | None = None) -> bool:
    normalized = _normalize_host(host)
    if not normalized:
        return True
    allowed = allowlist or default_network_allowlist()
    return any(normalized == item or normalized.endswith(f".{item}") for item in allowed)


def _tokens(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=os.name != "nt")
    except ValueError:
        return command.split()


def _binary(tokens: list[str]) -> str:
    if not tokens:
        return ""
    return os.path.basename(tokens[0]).lower()


def _host_from_token(token: str) -> str:
    token = token.strip().strip("'\"")
    if not token:
        return ""
    parsed = urlparse(token)
    if parsed.scheme and parsed.hostname:
        return _normalize_host(parsed.hostname)
    # Git/scp shorthand: git@github.com:org/repo.git or user@host:path
    if re.match(r"^[\w.-]+@[\w.-]+:", token):
        return _normalize_host(token.split("@", 1)[1].split(":", 1)[0])
    return ""


def extract_network_hosts(command: str) -> list[str]:
    """Extract explicit or implied network hosts from a command string."""
    tokens = _tokens(command)
    if not tokens:
        return []
    binary = _binary(tokens)
    hosts: list[str] = []
    for token in tokens[1:]:
        host = _host_from_token(token)
        if host:
            hosts.append(host)

    low = " ".join(tokens).lower()
    if binary in {"npm", "npx", "pnpm", "yarn"} and any(word in low for word in (" install", " add", " ci")):
        hosts.append("registry.npmjs.org")
    if binary in {"pip", "pip3", "uv", "poetry"} and " install" in low:
        hosts.extend(["pypi.org", "files.pythonhosted.org"])
    if binary == "docker" and any(word in low for word in (" pull", " push", " run")):
        hosts.append("registry-1.docker.io")

    seen: set[str] = set()
    unique: list[str] = []
    for host in hosts:
        normalized = _normalize_host(host)
        if normalized and normalized not in seen:
            seen.add(normalized)
            unique.append(normalized)
    return unique


def command_uses_network(command: str) -> bool:
    tokens = _tokens(command)
    if not tokens:
        return False
    binary = _binary(tokens)
    if binary not in _NETWORK_BINARIES:
        return False
    low = " ".join(tokens).lower()
    if binary == "git":
        return any(word in low for word in (" clone", " fetch", " pull", " push", " ls-remote"))
    if binary == "docker":
        return any(word in low for word in (" pull", " push", " run", " login"))
    return True


def decide_network_egress(
    command: str,
    *,
    mode: str | SandboxMode | None = None,
    allowlist: frozenset[str] | set[str] | None = None,
) -> NetworkDecision:
    """Return whether the command's network egress targets fit the sandbox policy."""
    sandbox_mode = normalize_mode(mode)
    if not command_uses_network(command):
        return NetworkDecision(True, reason="no network egress detected")
    if sandbox_mode == SandboxMode.READ_ONLY:
        return NetworkDecision(False, reason="network egress denied in read-only sandbox")
    if sandbox_mode in {SandboxMode.LOCAL_COMPUTER, SandboxMode.DANGER_FULL}:
        return NetworkDecision(True, hosts=tuple(extract_network_hosts(command)), reason="network egress allowed in danger-full sandbox")

    hosts = tuple(extract_network_hosts(command))
    allowed_hosts = frozenset(allowlist) if allowlist is not None else default_network_allowlist()
    blocked = tuple(host for host in hosts if not host_allowed(host, allowed_hosts))
    if blocked:
        return NetworkDecision(
            False,
            hosts=hosts,
            blocked_hosts=blocked,
            reason=f"network host not allowlisted: {', '.join(blocked)}",
        )
    if sandbox_mode == SandboxMode.WORKSPACE_WRITE and not hosts:
        return NetworkDecision(False, reason="network command has no explicit allowlisted host")
    return NetworkDecision(True, hosts=hosts, reason="network egress allowlisted")
