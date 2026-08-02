"""M1 acceptance tests: Usable Local Agent CLI.

Verifies that the Arforge Agent CLI can:
1. Start one-shot ask with real model response
2. Export data to JSON
3. Run slash commands
4. Execute tools correctly
5. Display version and help
"""

import json


def test_arforge_version_shows_brand():
    from arforge.cli_ui import version_line

    line = version_line()
    assert "Arforge Agent" in line
    assert __import__("arforge").__version__ in line


def test_arforge_doctor_runs():
    from arforge.product.doctor import run_checks

    results = run_checks()
    assert len(results) >= 10
    assert any(r.name == "Python" for r in results)


def test_arforge_export_writes_json(tmp_path):
    from arforge.export_cli import export_data

    output = tmp_path / "export.json"
    data = export_data(str(output))

    assert "memories" in data
    assert output.exists()
    content = json.loads(output.read_text(encoding="utf-8"))
    assert "memories" in content


def test_arforge_agent_returns_response():
    """Verify agent returns a non-empty response (model must be configured)."""
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    response = agent.chat("Say hello in one word.")

    assert response.answer
    assert len(response.answer) > 0
    assert response.meta
    assert response.meta.get("type") == "chat"


def test_arforge_slash_help_lists_commands():
    from arforge.slash_commands import run_slash_command

    output = run_slash_command("/help")
    assert "/status" in output
    assert "/help" in output
    assert "/doctor" in output
    assert "/learn" in output


def test_arforge_slash_status_works():
    from arforge.slash_commands import run_slash_command

    output = run_slash_command("/status")
    assert "Arforge" in output


def test_tool_calculate_executes():
    from arforge.tool_executor import run_tool_if_match

    result = run_tool_if_match("calculate 2+2")
    assert result is not None
    assert "4" in str(result)


def test_tool_time_executes():
    from arforge.tool_executor import run_tool_if_match

    result = run_tool_if_match("what time is it")
    assert result is not None


def test_tool_no_match_returns_none():
    from arforge.tool_executor import run_tool_if_match

    result = run_tool_if_match("just chatting about weather")
    assert result is None


def test_agent_plan_mode():
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    plan_result = agent.enter_plan_mode("add a login page")

    assert plan_result["success"]
    assert len(plan_result["plan"]) > 0
