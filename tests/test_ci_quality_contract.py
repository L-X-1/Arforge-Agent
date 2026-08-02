from __future__ import annotations

import json
from pathlib import Path


def test_private_quality_commands_cover_lint_tests_typecheck_and_import_smoke():
    package = json.loads(Path("package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]
    verifier = Path("verify_modules.py").read_text(encoding="utf-8")

    assert "pytest" in scripts["python:test"]
    assert "ruff check" in scripts["python:lint"]
    assert scripts["lint"] == "oxlint packages script ide --quiet"
    assert "turbo typecheck" in scripts["typecheck"]
    assert "brand-audit.ts --check" in scripts["brand:check"]
    assert '"arforge.bridge"' in verifier
    assert "importlib.import_module" in verifier


def test_ci_workflow_enforces_python_and_harness_contracts():
    workflow = Path(".github/workflows/ci.yml")

    assert workflow.is_file()
    text = workflow.read_text(encoding="utf-8")
    assert "python -m ruff check arforge tests config.py main.py" in text
    assert "python -m pytest -q" in text
    assert "arforge capability-eval --json" in text
    assert "arforge doctor --json" in text
    assert "bun run lint" in text
    assert "bun run typecheck" in text
    assert "bun run brand:check" in text
