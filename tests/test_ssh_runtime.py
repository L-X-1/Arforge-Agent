"""Safety and CLI contracts for explicit SSH remote execution."""

from __future__ import annotations

import json
from types import SimpleNamespace


def test_ssh_profiles_store_metadata_without_credentials(monkeypatch, tmp_path):
    import arforge.ssh_runtime as ssh

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    saved = ssh.save_ssh_profile(ssh.SSHProfile("build-box", "deploy", "build.example.test", port=2222))

    assert saved.host == "build.example.test"
    assert ssh.get_ssh_profile("BUILD-BOX") == saved
    raw = json.loads((tmp_path / "profile" / "config" / "ssh_profiles.json").read_text(encoding="utf-8"))
    assert raw["profiles"] == [saved.public()]
    assert "password" not in json.dumps(raw).casefold()


def test_ssh_command_uses_strict_host_verification_and_no_shell(monkeypatch):
    import arforge.ssh_runtime as ssh

    monkeypatch.setattr(ssh.shutil, "which", lambda _name: r"C:\OpenSSH\ssh.exe")
    profile = ssh.SSHProfile("ops", "admin", "host.example.test")
    command = ssh.build_ssh_command(profile, ["uname", "-a"])

    assert command[0].endswith("ssh.exe")
    assert "StrictHostKeyChecking=yes" in command
    assert "admin@host.example.test" in command

def test_execute_ssh_confirms_and_invokes_subprocess_without_shell(monkeypatch):
    import arforge.ssh_runtime as ssh
    from arforge.security.sandbox_enforce import SandboxDecision

    profile = ssh.SSHProfile("ops", "admin", "host.example.test")
    monkeypatch.setattr(ssh.shutil, "which", lambda _name: "ssh")
    monkeypatch.setattr("arforge.security.sandbox_enforce.check_command_safety", lambda *_args, **_kwargs: (SandboxDecision.ALLOWED, ""))
    monkeypatch.setattr("arforge.permission.request_confirmation", lambda *_args: True)
    seen = {}

    def fake_run(*args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout="remote ok\n", stderr="")

    monkeypatch.setattr(ssh.subprocess, "run", fake_run)
    result = ssh.execute_ssh(profile, ["echo", "remote ok"], timeout_seconds=30)

    assert result == {"success": True, "returncode": 0, "stdout": "remote ok\n", "stderr": ""}
    assert seen["kwargs"]["shell"] is False
    assert seen["kwargs"]["timeout"] == 30


def test_ssh_cli_add_list_and_exec(monkeypatch, tmp_path, capsys):
    import arforge.ssh_runtime as ssh
    from arforge.cli import main

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    assert main(["ssh", "add", "ci", "runner", "ci.example.test", "--port", "2201"]) == 0
    capsys.readouterr()
    assert main(["ssh", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed["profiles"] == [{"host": "ci.example.test", "identity_file": "", "name": "ci", "port": 2201, "user": "runner"}]

    monkeypatch.setattr(ssh, "execute_ssh", lambda *_args, **_kwargs: {"success": True, "stdout": "done", "stderr": "", "returncode": 0})
    assert main(["ssh", "exec", "ci", "--timeout", "20", "--", "git", "status"]) == 0
    assert "done" in capsys.readouterr().out
