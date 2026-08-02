"""Product documentation contracts for the supported user journey."""

from __future__ import annotations

import re
from pathlib import Path

from arforge import __version__
from arforge.cli import COMMANDS_HELP


ROOT = Path(__file__).resolve().parents[1]


def test_readme_describes_current_product_without_recovery_runtime_claims():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert f"Current status: `{__version__}`" in readme
    assert "ready for controlled local project work" in readme
    assert "docs/LOCAL_PROJECT_READINESS.md" in readme
    assert "recovered Python" not in readme
    assert "bytecode loader" not in readme.lower()
    assert "not yet published to public PyPI" in readme


def test_readme_covers_every_top_level_cli_command():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    missing = []
    for executable, syntax, _description in COMMANDS_HELP:
        command = syntax.split()[0].strip("[]")
        rendered = executable if command == "chat" else f"{executable} {command}"
        if rendered not in readme:
            missing.append(rendered)

    assert not missing, f"README is missing CLI commands: {missing}"


def test_readme_local_document_links_resolve():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    targets = re.findall(r"\[[^]]+\]\(([^)]+)\)", readme)
    local_targets = [target.split("#", 1)[0] for target in targets if "://" not in target]

    missing = [target for target in local_targets if not (ROOT / target).exists()]
    assert not missing, f"README contains broken local links: {missing}"


def test_environment_example_is_safe_and_complete():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")

    for variable in (
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_MODEL",
        "ARFORGE_DB_URL",
        "ARFORGE_MULTIAGENT_DB_URL",
        "ARFORGE_HOME",
        "ARFORGE_PG_BIN",
        "ARFORGE_AUTO_APPROVE",
        "ARFORGE_TRUST_WORKSPACE",
    ):
        assert variable in example

    assert "replace-with-your-key" in example
    assert not re.search(r"\bsk-[A-Za-z0-9_-]{12,}\b", example)
    assert "ARFORGE_AUTO_APPROVE=1" not in example
    assert "ARFORGE_TRUST_WORKSPACE=1" not in example


def test_user_and_developer_guides_link_to_real_operational_docs():
    user_guide = (ROOT / "docs" / "USER_GUIDE.md").read_text(encoding="utf-8")
    developer_guide = (ROOT / "docs" / "DEVELOPER_ONBOARDING.md").read_text(
        encoding="utf-8"
    )

    assert "DATABASE_MIGRATION_RUNBOOK.md" in user_guide
    assert "PRIVATE_HTTPS_DEPLOYMENT.md" in user_guide
    assert "DEPENDENCY_ATTRIBUTION_POLICY.md" in user_guide
    assert "RELEASE_RUNBOOK.md" not in user_guide
    assert "SHIP_GATE_REPORT_2026-06-18.md" not in developer_guide
    assert "python -m pytest -q" in developer_guide
    assert "ruff check arforge tests config.py main.py" in developer_guide
