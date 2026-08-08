from __future__ import annotations

import json

from arforge.product.direct_dispatch import dispatch
from arforge.customization import list_customizations, render_custom_command


def test_custom_command_markdown_renders_template(tmp_path):
    root = tmp_path / "custom"
    commands = root / "commands"
    commands.mkdir(parents=True)
    (commands / "review.md").write_text(
        "---\n"
        "name: review-fast\n"
        "description: Review a change quickly.\n"
        "category: code\n"
        "---\n"
        "Review this change and list only blocking risks:\n{{args}}\n",
        encoding="utf-8",
    )

    data = list_customizations([root])
    rendered = render_custom_command("review-fast", "diff here", roots=[root])

    assert data["commands"]["count"] == 1
    assert data["commands"]["enabled_count"] == 1
    assert data["commands"]["items"][0]["name"] == "review-fast"
    assert rendered == "Review this change and list only blocking risks:\ndiff here"


def test_custom_command_json_with_utf8_bom(tmp_path):
    root = tmp_path / "custom"
    commands = root / "commands"
    commands.mkdir(parents=True)
    (commands / "note.json").write_text(
        "\ufeff" + json.dumps({"name": "note", "description": "Draft a note.", "template": "Draft: {{args}}"}),
        encoding="utf-8",
    )

    rendered = render_custom_command("note", "ship notes", roots=[root])

    assert rendered == "Draft: ship notes"


def test_hook_manifest_is_indexed_but_not_executed(tmp_path):
    root = tmp_path / "custom"
    hooks = root / "hooks"
    hooks.mkdir(parents=True)
    (hooks / "audit.json").write_text(
        json.dumps(
            {
                "name": "audit-trace",
                "event": "post_tool_use",
                "description": "Record tool use metadata.",
                "enabled": True,
                "priority": 90,
            }
        ),
        encoding="utf-8",
    )

    data = list_customizations([root])

    assert data["hooks"]["count"] == 1
    assert data["hooks"]["enabled_count"] == 1
    hook = data["hooks"]["items"][0]
    assert hook["event"] == "post_tool_use"
    assert hook["enabled"] is True
    assert hook["priority"] == 90


def test_invalid_custom_manifests_report_problems(tmp_path):
    root = tmp_path / "custom"
    (root / "commands").mkdir(parents=True)
    (root / "hooks").mkdir()
    (root / "commands" / "bad.md").write_text("---\nname: bad command!\n---\n", encoding="utf-8")
    (root / "hooks" / "bad.json").write_text(
        json.dumps({"name": "bad-hook", "event": "not_real", "description": "Broken."}),
        encoding="utf-8",
    )

    data = list_customizations([root])

    assert data["commands"]["enabled_count"] == 0
    assert data["hooks"]["enabled_count"] == 0
    assert data["commands"]["items"][0]["problems"]
    assert data["hooks"]["items"][0]["problems"] == ["event must be a known HookEvent"]


def test_slash_dispatcher_falls_back_to_custom_command(monkeypatch, tmp_path):
    root = tmp_path / "custom"
    commands = root / "commands"
    commands.mkdir(parents=True)
    (commands / "triage.md").write_text(
        "---\nname: triage\ndescription: Triage an issue.\n---\n"
        "Triage this issue: {{input}}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_CUSTOM_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    from arforge.slash_commands import list_slash_commands, run_slash_command

    assert run_slash_command("/triage crash on startup") == "Triage this issue: crash on startup"
    names = {item["name"] for item in list_slash_commands()}
    assert "triage" in names


def test_bridge_exposes_customizations_list(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    response = dispatch({"id": 1, "version": "1.2", "method": "customizations.list"})

    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"



def test_bridge_renders_custom_command(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    response = dispatch({"id": 1, "version": "1.2", "method": "customizations.render"})

    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"



def test_cli_custom_render(monkeypatch, tmp_path, capsys):
    root = tmp_path / "custom"
    commands = root / "commands"
    commands.mkdir(parents=True)
    (commands / "triage.md").write_text(
        "---\nname: triage\ndescription: Triage an issue.\n---\n"
        "Triage this issue: {{args}}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_CUSTOM_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    from arforge.cli import main

    assert main(["custom", "render", "triage", "crash", "on", "startup"]) == 0
    assert capsys.readouterr().out.strip() == "Triage this issue: crash on startup"


def test_cli_custom_lists_commands_and_hooks(monkeypatch, tmp_path, capsys):
    root = tmp_path / "custom"
    (root / "commands").mkdir(parents=True)
    (root / "hooks").mkdir()
    (root / "commands" / "note.md").write_text(
        "---\nname: note\ndescription: Draft a note.\n---\nNote: {{args}}\n",
        encoding="utf-8",
    )
    (root / "hooks" / "audit.json").write_text(
        json.dumps({"name": "audit", "event": "post_tool_use", "description": "Audit.", "enabled": False}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_CUSTOM_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    from arforge.cli import _run_custom

    assert _run_custom() == 0
    output = capsys.readouterr().out
    assert "Custom Commands and Hooks" in output
    assert "note" in output
    assert "audit" in output
