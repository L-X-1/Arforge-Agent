from __future__ import annotations

import json

from arforge.product.direct_dispatch import dispatch
from arforge.skills import list_skills, load_skill_manifest, read_skill


def test_loads_markdown_skill_front_matter(tmp_path):
    skill = tmp_path / "reviewer"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\n"
        "id: code-reviewer\n"
        "name: Code Reviewer\n"
        "description: Reviews code for risks and regressions.\n"
        "version: 1.2.3\n"
        "tags: [code, review]\n"
        "---\n"
        "# Body\n",
        encoding="utf-8",
    )

    manifest = load_skill_manifest(skill, root=tmp_path)

    assert manifest is not None
    assert manifest.id == "code-reviewer"
    assert manifest.description.startswith("Reviews code")
    assert manifest.version == "1.2.3"
    assert manifest.tags == ["code", "review"]
    assert manifest.problems == []


def test_loads_markdown_multiline_description(tmp_path):
    skill = tmp_path / "model-api"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\n"
        "name: model-api\n"
        "description: |-\n"
        "  Reference for the model API.\n"
        "  Use when SDK work is requested.\n"
        "license: Complete terms in LICENSE.txt\n"
        "---\n"
        "# Body\n",
        encoding="utf-8",
    )

    manifest = load_skill_manifest(skill, root=tmp_path)

    assert manifest is not None
    assert "model API" in manifest.description
    assert "SDK work" in manifest.description
    assert manifest.license == "Complete terms in LICENSE.txt"


def test_loads_json_skill_and_reports_invalid_manifest(tmp_path):
    good = tmp_path / "good"
    good.mkdir()
    (good / "skill.json").write_text(
        json.dumps({"id": "good.skill", "name": "Good", "description": "A valid local skill."}),
        encoding="utf-8",
    )
    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "SKILL.md").write_text("---\nid: bad skill!\nname: Bad\n---\n", encoding="utf-8")

    data = list_skills([tmp_path])

    assert data["count"] == 2
    assert data["enabled_count"] == 1
    by_id = {item["id"]: item for item in data["items"]}
    assert by_id["good.skill"]["problems"] == []
    assert by_id["bad skill!"]["problems"]


def test_loads_json_skill_with_utf8_bom(tmp_path):
    skill = tmp_path / "bom"
    skill.mkdir()
    (skill / "skill.json").write_text(
        "\ufeff" + json.dumps({"id": "bom", "name": "BOM", "description": "Windows-authored manifest."}),
        encoding="utf-8",
    )

    manifest = load_skill_manifest(skill, root=tmp_path)

    assert manifest is not None
    assert manifest.problems == []
    assert manifest.id == "bom"


def test_skills_list_honors_env_roots(monkeypatch, tmp_path):
    root = tmp_path / "skills"
    skill = root / "helper"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: helper\ndescription: Helps with local tasks.\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))

    data = list_skills()

    by_id = {item["id"]: item for item in data["items"]}
    assert "helper" in by_id
    assert str(root.resolve()) in data["roots"]


def test_bridge_no_longer_exposes_skills_list(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_SKILL_PATHS", raising=False)

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 2, "version": "1.1", "method": "skills.list"})

    assert "skills.list" not in described["data"]["methods"]
    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"


def test_default_listing_includes_bundled_agent_skills(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_SKILL_PATHS", raising=False)

    data = list_skills()
    by_id = {item["id"]: item for item in data["items"]}

    assert "pdf" in by_id
    assert "spreadsheets" in by_id
    assert "documents" in by_id
    assert "model-api" in by_id
    assert by_id["pdf"]["source"] == "builtin:agent-skills"
    assert by_id["model-api"]["source"] == "builtin:agent-skills"


def test_read_bundled_agent_skill(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_SKILL_PATHS", raising=False)

    data = read_skill("pdf", max_chars=4000)

    assert data["ok"] is True
    assert data["manifest"]["id"] == "pdf"
    assert "SKILL.md" not in data["resources"]
    assert "PDF" in data["content"] or "pdf" in data["content"].lower()


def test_cli_skills_lists_manifest(monkeypatch, tmp_path, capsys):
    root = tmp_path / "skills"
    skill = root / "writer"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\n"
        "name: writer\n"
        "description: Drafts short technical notes.\n"
        "---\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    from arforge.cli import _run_skills

    assert _run_skills() == 0
    output = capsys.readouterr().out
    assert "Skills" in output
    assert "writer" in output
    assert "Drafts short technical notes" in output


def test_skill_disable_is_reflected_in_listing(monkeypatch, tmp_path):
    root = tmp_path / "skills"
    skill = root / "writer"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: writer\ndescription: Drafts short technical notes.\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    import arforge.skills as skills

    skills._cache_loaded = False
    skills._skills_disabled.clear()

    assert skills.disable_skill("writer") is True
    data = skills.list_skills()

    by_id = {item["id"]: item for item in data["items"]}
    assert by_id["writer"]["enabled"] is False


def test_cli_skills_enable_disable_roundtrip(monkeypatch, tmp_path, capsys):
    root = tmp_path / "skills"
    skill = root / "ops"
    skill.mkdir(parents=True)
    (skill / "skill.json").write_text(
        json.dumps({"id": "ops", "name": "Ops", "description": "Operational runbook helper."}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    import arforge.skills as skills
    from arforge.cli import main

    skills._cache_loaded = False
    skills._skills_disabled.clear()

    assert main(["skills", "disable", "ops"]) == 0
    assert main(["skills"]) == 0
    output = capsys.readouterr().out
    assert "ops" in output
    assert "disabled" in output

    assert main(["skills", "enable", "ops"]) == 0
    assert skills.is_skill_enabled("ops") is True


def test_bridge_no_longer_exposes_skill_enable_disable(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_SKILL_PATHS", raising=False)

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    disabled = dispatch(
        {"id": 2, "version": "1.1", "method": "skills.disable", "params": {"skill_id": "ops"}}
    )
    enabled = dispatch(
        {"id": 3, "version": "1.1", "method": "skills.enable", "params": {"skill_id": "ops"}}
    )

    assert "skills.disable" not in described["data"]["methods"]
    assert "skills.enable" not in described["data"]["methods"]
    assert disabled["ok"] is False
    assert disabled["error"]["code"] == "METHOD_NOT_FOUND"
    assert enabled["ok"] is False


def test_bridge_no_longer_exposes_skill_read(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_SKILL_PATHS", raising=False)

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch(
        {"id": 2, "version": "1.1", "method": "skills.read", "params": {"skill_id": "ops", "max_chars": 5000}}
    )

    assert "skills.read" not in described["data"]["methods"]
    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"


def test_skill_read_tool_is_registered_and_read_only():
    import arforge.tools.skill_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("skill_read")

    assert tool is not None
    assert tool.schema.category == "read"
    assert tool.schema.risk_level == "low"
