from __future__ import annotations

from pathlib import Path

from arforge.bridge import dispatch


ALL_DEVELOPMENT_SKILLS = {"grill-me", "openspec", "trellis", "superpowers"}


def test_project_rules_define_the_default_development_skill_relationship():
    rules = (Path(__file__).parents[1] / "ARFORGE.md").read_text(encoding="utf-8")

    assert "grill-me → OpenSpec → Trellis → Superpowers" in rules
    assert "简单且明确的任务直接执行" in rules
    assert "前端视觉工作自动加载 `design-taste-frontend`" in rules


def test_routes_simple_questions_without_process_overhead():
    from arforge.skill_runtime import route_skills

    route = route_skills("你好，请解释 Python 列表。", available_ids=ALL_DEVELOPMENT_SKILLS)

    assert route.mode == "direct"
    assert route.selected == ()


def test_routes_ambiguous_product_work_through_clarification_then_spec():
    from arforge.skill_runtime import route_skills

    route = route_skills(
        "我想做一个权限系统，但具体行为还不确定。",
        available_ids=ALL_DEVELOPMENT_SKILLS,
    )

    assert route.mode == "clarify"
    assert route.selected == ("grill-me", "openspec", "superpowers")
    assert route.phases[:2] == ("clarify", "specify")


def test_routes_long_clear_delivery_without_reasking_resolved_requirements():
    from arforge.skill_runtime import route_skills

    route = route_skills(
        "请一步一步完整实现登录功能，覆盖前端、后端和数据库迁移，实际测试后交付。",
        available_ids=ALL_DEVELOPMENT_SKILLS,
    )

    assert route.mode == "long_delivery"
    assert route.selected == ("openspec", "trellis", "superpowers")
    assert "grill-me" not in route.selected


def test_routes_bug_fix_to_superpowers_systematic_debugging_only():
    from arforge.skill_runtime import route_skills

    route = route_skills(
        "这个按钮点击后崩溃，请查明原因并修复。",
        available_ids=ALL_DEVELOPMENT_SKILLS,
    )

    assert route.mode == "delivery"
    assert route.selected == ("superpowers",)


def test_explicit_skill_names_are_honored_and_missing_skills_are_not_selected():
    from arforge.skill_runtime import route_skills

    route = route_skills(
        "用 OpenSpec 和 Trellis 规划这项工作。",
        available_ids={"openspec", "trellis"},
    )

    assert route.selected == ("openspec", "trellis")
    assert route.missing == ()


def test_default_system_prompt_includes_relationship_and_selected_skill_content(tmp_path, monkeypatch):
    from arforge.skill_runtime import build_skill_system_prompt

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    skill_root = tmp_path / "skills"
    for skill_id in ("openspec", "trellis", "superpowers"):
        directory = skill_root / skill_id
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(
            "---\n"
            f"name: {skill_id}\n"
            f"description: {skill_id} integration test.\n"
            "---\n"
            f"# {skill_id}\nUse {skill_id} faithfully.\n",
            encoding="utf-8",
        )

    prompt = build_skill_system_prompt(
        "请一步一步完整实现登录功能，覆盖前端、后端和数据库迁移，实际测试后交付。",
        roots=[skill_root],
    )

    assert "grill-me → OpenSpec → Trellis → Superpowers" in prompt
    assert "Activated skills: openspec, trellis, superpowers" in prompt
    assert "Use openspec faithfully" in prompt
    assert "Use trellis faithfully" in prompt
    assert "Use superpowers faithfully" in prompt


def test_automatic_prompt_uses_trusted_bundled_skill_not_profile_shadow(tmp_path, monkeypatch):
    from arforge.skill_runtime import build_skill_system_prompt

    home = tmp_path / "profile"
    shadow = home / "skills" / "openspec"
    shadow.mkdir(parents=True)
    (shadow / "SKILL.md").write_text(
        "---\nname: openspec\ndescription: shadow.\n---\nUNTRUSTED_PROFILE_SHADOW\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ARFORGE_HOME", str(home))

    prompt = build_skill_system_prompt("请完整实现跨前后端功能并测试后交付。")

    assert "UNTRUSTED_PROFILE_SHADOW" not in prompt
    assert "# OpenSpec for Arforge" in prompt


def test_document_delivery_automatically_loads_document_and_pdf_capabilities():
    from arforge.skill_runtime import build_skill_system_prompt

    prompt = build_skill_system_prompt(
        "请撰写毕业论文并交付完整 DOCX、PDF 和 Markdown，实际验证后完成。"
    )

    assert "Activated capability skills: documents, pdf" in prompt
    assert '<skill id="documents">' in prompt
    assert '<skill id="pdf">' in prompt
    assert "A4" in prompt


def test_frontend_design_automatically_loads_the_complete_taste_skill():
    from arforge.skill_runtime import build_skill_system_prompt, route_skills

    request = "请为设计工作室创建一个高端作品集网站，完成前端设计并实际实现。"
    route = route_skills(request)
    prompt = build_skill_system_prompt(request)

    assert route.capabilities == ("design-taste-frontend",)
    assert "Activated capability skills: design-taste-frontend" in prompt
    assert '<skill id="design-taste-frontend">' in prompt
    assert "# tasteskill: Anti-Slop Frontend Skill" in prompt
    assert "**End of appendices.**" in prompt
    assert "...[truncated]" not in prompt


def test_non_frontend_design_does_not_load_the_taste_skill():
    from arforge.skill_runtime import build_skill_system_prompt

    prompt = build_skill_system_prompt("请设计数据库迁移方案并实现。")

    assert "design-taste-frontend" not in prompt


def test_agent_build_messages_automatically_injects_skill_route(monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    monkeypatch.setattr(
        "arforge.skill_runtime.build_skill_system_prompt",
        lambda _request: "## Automatic Skill Route\nroute-marker",
    )
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    system = agent.build_messages("实现一个明确的小功能。", use_reasoning=False)[0]["content"]

    assert "## Automatic Skill Route\nroute-marker" in system


def test_bridge_exposes_installed_development_skills_and_route(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_SKILL_PATHS", raising=False)

    listed = dispatch({"id": 1, "version": "1.2", "method": "skills.list"})
    routed = dispatch({
        "id": 2,
        "version": "1.2",
        "method": "skills.route",
        "params": {"request": "请完整实现跨前后端功能并测试后交付。"},
    })

    ids = {item["id"] for item in listed["data"]["items"]}
    assert ALL_DEVELOPMENT_SKILLS <= ids
    assert routed["ok"] is True
    assert routed["data"]["selected"] == ["openspec", "trellis", "superpowers"]


def test_cli_can_explain_the_automatic_skill_route(capsys):
    from arforge.cli import _run_skills

    assert _run_skills(["route", "修复这个崩溃问题并验证。"] ) == 0
    output = capsys.readouterr().out

    assert "Skill Route" in output
    assert "superpowers" in output


def test_cli_route_shows_automatic_frontend_capability(capsys):
    from arforge.cli import _run_skills

    assert _run_skills(["route", "请做一个作品集网站的前端设计。"]) == 0
    output = capsys.readouterr().out

    assert "Capabilities" in output
    assert "design-taste-frontend" in output


def test_bundled_skill_metadata_is_private_and_has_no_distribution_provenance():
    from arforge.skills import bundled_agent_skill_root

    root = bundled_agent_skill_root()
    for skill_id in ALL_DEVELOPMENT_SKILLS:
        skill = root / skill_id
        assert not (skill / "upstream.json").exists()
        metadata = (skill / "SKILL.md").read_text(encoding="utf-8")
        assert "license: LicenseRef-Proprietary" in metadata
        assert "github.com" not in metadata.lower()
        assert "installed_via_proxy" not in metadata
