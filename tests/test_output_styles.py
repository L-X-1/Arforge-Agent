from __future__ import annotations

from pathlib import Path


def _write_style(directory: Path, style_id: str, description: str, prompt: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{style_id}.md").write_text(
        f"---\nid: {style_id}\ndescription: {description}\nkeep-coding-instructions: true\n---\n{prompt}\n",
        encoding="utf-8",
    )


def test_workspace_style_overrides_profile_style(tmp_path):
    from arforge.output_styles import list_output_styles

    profile = tmp_path / "profile" / "output-styles"
    workspace = tmp_path / "workspace" / ".arforge" / "output-styles"
    _write_style(profile, "review", "Profile review", "Use the profile format.")
    _write_style(workspace, "review", "Workspace review", "Use the workspace format.")

    data = list_output_styles([(profile, "profile"), (workspace, "workspace")])

    assert data["count"] == 1
    assert data["items"][0]["source"] == "workspace"
    assert data["items"][0]["prompt"] == "Use the workspace format."


def test_active_style_persists_and_is_available_to_agent(monkeypatch, tmp_path):
    home = tmp_path / "profile"
    workspace = tmp_path / "workspace"
    _write_style(home / "output-styles", "concise", "Keep responses concise", "Answer in concise bullet points.")
    workspace.mkdir()
    monkeypatch.setenv("ARFORGE_HOME", str(home))
    monkeypatch.chdir(workspace)

    from arforge.output_styles import get_active_output_style_prompt, set_active_output_style

    result = set_active_output_style("concise")

    assert result["style_id"] == "concise"
    assert get_active_output_style_prompt() == "Answer in concise bullet points."


def test_agent_appends_active_style_after_system_contract(monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    monkeypatch.setattr(
        "arforge.output_styles.get_active_output_style_prompt",
        lambda: "Use a numbered delivery summary.",
    )
    agent = ArforgeAgent(reasoning_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    system = agent.build_messages("Summarize this change.")[0]["content"]

    assert "## Response Style\nUse a numbered delivery summary." in system


def test_cli_output_style_set_show_and_clear(monkeypatch, tmp_path, capsys):
    home = tmp_path / "profile"
    workspace = tmp_path / "workspace"
    _write_style(home / "output-styles", "concise", "Keep responses concise", "Answer in concise bullet points.")
    workspace.mkdir()
    monkeypatch.setenv("ARFORGE_HOME", str(home))
    monkeypatch.chdir(workspace)
    from arforge.cli import main

    assert main(["output-style", "set", "concise"]) == 0
    assert main(["output-style", "show", "concise"]) == 0
    assert main(["output-style", "clear"]) == 0

    output = capsys.readouterr().out
    assert "Active response style" in output
    assert "Answer in concise bullet points." in output
