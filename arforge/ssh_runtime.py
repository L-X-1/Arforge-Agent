"""Auditable SSH profile storage and explicit remote command execution."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from arforge.paths import data_path
from arforge.security_guard import sanitize_log_message

_PROFILE_NAME = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$")
_HOST_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$")
_USER_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
_LOCK = threading.RLock()
_MAX_TIMEOUT_SECONDS = 3_600
_MAX_OUTPUT_CHARS = 40_000


class SSHRuntimeError(Exception):
    """Raised for invalid profiles or a denied remote operation."""


@dataclass(frozen=True)
class SSHProfile:
    name: str
    user: str
    host: str
    port: int = 22
    identity_file: str = ""

    def public(self) -> dict[str, Any]:
        return asdict(self)


def _state_path() -> Path:
    return Path(data_path("config")) / "ssh_profiles.json"


def _validate_profile(profile: SSHProfile) -> SSHProfile:
    name = profile.name.strip()
    user = profile.user.strip()
    host = profile.host.strip().rstrip(".")
    if not _PROFILE_NAME.fullmatch(name):
        raise SSHRuntimeError("profile name must be 1-64 URL-safe characters")
    if not _USER_NAME.fullmatch(user):
        raise SSHRuntimeError("SSH user contains unsupported characters")
    if not _HOST_NAME.fullmatch(host) or ".." in host:
        raise SSHRuntimeError("SSH host must be a DNS name or IPv4 address")
    if not isinstance(profile.port, int) or not 1 <= profile.port <= 65535:
        raise SSHRuntimeError("SSH port must be an integer between 1 and 65535")
    identity_file = profile.identity_file.strip()
    if identity_file:
        path = Path(identity_file).expanduser().resolve()
        if not path.is_file():
            raise SSHRuntimeError("SSH identity file does not exist")
        identity_file = str(path)
    return SSHProfile(name=name, user=user, host=host, port=profile.port, identity_file=identity_file)


def list_ssh_profiles() -> list[SSHProfile]:
    """Return validated profiles, ignoring malformed local entries."""
    try:
        payload = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    records = payload.get("profiles", []) if isinstance(payload, dict) else []
    if not isinstance(records, list):
        return []
    profiles: list[SSHProfile] = []
    for item in records:
        if not isinstance(item, dict):
            continue
        try:
            profiles.append(
                _validate_profile(
                    SSHProfile(
                        name=str(item.get("name", "")),
                        user=str(item.get("user", "")),
                        host=str(item.get("host", "")),
                        port=int(item.get("port", 22)),
                        identity_file=str(item.get("identity_file", "")),
                    )
                )
            )
        except (SSHRuntimeError, TypeError, ValueError):
            continue
    return sorted(profiles, key=lambda item: item.name.casefold())


def get_ssh_profile(name: str) -> SSHProfile | None:
    target = name.strip().casefold()
    return next((item for item in list_ssh_profiles() if item.name.casefold() == target), None)


def save_ssh_profile(profile: SSHProfile) -> SSHProfile:
    """Save one profile without storing credentials or host-key overrides."""
    validated = _validate_profile(profile)
    with _LOCK:
        profiles = [item for item in list_ssh_profiles() if item.name.casefold() != validated.name.casefold()]
        profiles.append(validated)
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"version": 1, "profiles": [item.public() for item in profiles]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return validated


def remove_ssh_profile(name: str) -> bool:
    target = name.strip().casefold()
    with _LOCK:
        current = list_ssh_profiles()
        retained = [item for item in current if item.name.casefold() != target]
        if len(retained) == len(current):
            return False
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"version": 1, "profiles": [item.public() for item in retained]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return True


def build_ssh_command(profile: SSHProfile, command: list[str]) -> list[str]:
    """Build a no-shell OpenSSH invocation with strict host verification."""
    if not command or not all(isinstance(item, str) and item for item in command):
        raise SSHRuntimeError("remote command is required")
    executable = shutil.which("ssh")
    if not executable:
        raise SSHRuntimeError("OpenSSH client executable was not found")
    args = [
        executable,
        "-p", str(profile.port),
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=15",
    ]
    if profile.identity_file:
        args.extend(["-i", profile.identity_file])
    args.append(f"{profile.user}@{profile.host}")
    args.extend(command)
    return args


def execute_ssh(profile: SSHProfile, command: list[str], *, timeout_seconds: int = 60) -> dict[str, Any]:
    """Run an explicitly confirmed SSH command and return bounded diagnostics."""
    if not 1 <= timeout_seconds <= _MAX_TIMEOUT_SECONDS:
        raise SSHRuntimeError(f"timeout must be between 1 and {_MAX_TIMEOUT_SECONDS} seconds")
    invocation = build_ssh_command(profile, command)
    # Use the portable binary name for policy classification even when OpenSSH
    # resolves to an absolute Windows executable path.
    command_text = " ".join(["ssh", *invocation[1:]])
    from arforge.security.sandbox_enforce import SandboxDecision, check_command_safety

    decision, reason = check_command_safety(command_text, sandbox_mode="local-computer")
    if decision is not SandboxDecision.ALLOWED:
        raise SSHRuntimeError(reason or "SSH command blocked by sandbox policy")
    from arforge.permission import request_confirmation

    if not request_confirmation("high", f"run remote command through SSH profile '{profile.name}'"):
        raise SSHRuntimeError("remote command was not approved")
    try:
        completed = subprocess.run(
            invocation,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"success": False, "returncode": None, "stdout": "", "stderr": "SSH command timed out"}
    except OSError as exc:
        return {"success": False, "returncode": None, "stdout": "", "stderr": sanitize_log_message(str(exc))}
    return {
        "success": completed.returncode == 0,
        "returncode": completed.returncode,
        "stdout": completed.stdout[:_MAX_OUTPUT_CHARS],
        "stderr": sanitize_log_message(completed.stderr[:_MAX_OUTPUT_CHARS]),
    }
