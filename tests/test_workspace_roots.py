"""Contracts for explicitly trusted additional workspace directories."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def test_additional_workspace_root_requires_independent_trust(monkeypatch, tmp_path):
    import arforge.workspace_roots as roots

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    primary = tmp_path / "primary"
    additional = tmp_path / "additional"
    primary.mkdir()
    additional.mkdir()

    with pytest.raises(roots.WorkspaceRootError, match="trusted before"):
        roots.add_workspace_root(additional, primary=primary)

    from arforge.trust_screen import trust_workspace

    trust_workspace(additional)
    assert roots.add_workspace_root(additional, primary=primary) == additional.resolve()
    assert roots.authorized_workspace_roots(primary) == [primary.resolve(), additional.resolve()]


def test_nested_or_overlapping_roots_are_rejected(monkeypatch, tmp_path):
    import arforge.workspace_roots as roots
    from arforge.trust_screen import trust_workspace

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    primary = tmp_path / "primary"
    nested = primary / "nested"
    nested.mkdir(parents=True)
    trust_workspace(nested)

    with pytest.raises(roots.WorkspaceRootError, match="already covered"):
        roots.add_workspace_root(nested, primary=primary)


def test_file_tools_accept_absolute_paths_in_an_authorized_additional_root(monkeypatch, tmp_path):
    import arforge.tools.file_tools as files
    import arforge.workspace_roots as roots
    from arforge.trust_screen import trust_workspace

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    primary = tmp_path / "primary"
    additional = tmp_path / "additional"
    primary.mkdir()
    additional.mkdir()
    extra_file = additional / "notes.txt"
    extra_file.write_text("allowed", encoding="utf-8")
    trust_workspace(additional)
    roots.add_workspace_root(additional, primary=primary)
    monkeypatch.setattr(files, "WORKSPACE", primary.resolve())

    assert files._resolve(str(extra_file)) == extra_file.resolve()
    with pytest.raises(ValueError, match="authorized workspaces"):
        files._resolve(str(tmp_path / "outside.txt"))


def test_multiagent_write_gate_honors_authorized_additional_root(monkeypatch, tmp_path):
    import arforge.multiagent.security as security
    import arforge.workspace_roots as roots
    from arforge.trust_screen import trust_workspace

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    primary = tmp_path / "primary"
    additional = tmp_path / "additional"
    primary.mkdir()
    additional.mkdir()
    trust_workspace(additional)
    roots.add_workspace_root(additional, primary=primary)
    monkeypatch.setattr(security, "_DEFAULT_WORKSPACE", str(primary))

    class Role:
        name = "writer"

    assert security.check_path_write(Role(), additional / "report.txt") is True
    outside_temp = Path(tmp_path.anchor) / "arforge-workspace-root-outside.txt"
    assert security.check_path_write(Role(), outside_temp) is False


def test_sandbox_write_gate_honors_authorized_additional_root(monkeypatch, tmp_path):
    from arforge.security.sandbox_enforce import SandboxDecision, enforce
    import arforge.workspace_roots as roots
    from arforge.trust_screen import trust_workspace

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    primary = tmp_path / "primary"
    additional = tmp_path / "additional"
    primary.mkdir()
    additional.mkdir()
    target = additional / "report.txt"
    trust_workspace(additional)
    roots.add_workspace_root(additional, primary=primary)

    decision, _reason = enforce(
        "write_file",
        {"filename": str(target)},
        sandbox_mode="workspace-write",
        workspace=str(primary),
    )

    assert decision is SandboxDecision.ALLOWED


def test_workspace_cli_uses_explicit_trust_then_add(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    workspace = tmp_path / "workspace"
    additional = tmp_path / "additional"
    workspace.mkdir()
    additional.mkdir()
    monkeypatch.chdir(workspace)

    assert main(["workspace", "trust", str(additional), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["trusted"] is True
    assert main(["workspace", "add", str(additional), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["added"] is True
    assert main(["workspace", "list", "--json"]) == 0
    paths = [item["path"] for item in json.loads(capsys.readouterr().out)["roots"]]
    assert str(additional.resolve()) in paths
