from __future__ import annotations

import json
from pathlib import Path

import yaml


def test_private_quality_commands_cover_lint_tests_typecheck_and_import_smoke():
    package = json.loads(Path("package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]
    verifier = Path("verify_modules.py").read_text(encoding="utf-8")

    assert "pytest" in scripts["python:test"]
    assert "ruff check" in scripts["python:lint"]
    assert scripts["lint"] == "oxlint packages script ide --quiet"
    assert "turbo typecheck" in scripts["typecheck"]
    assert "brand-audit.ts --check" in scripts["brand:check"]
    assert '"arforge.product.direct_dispatch"' in verifier
    assert "importlib.import_module" in verifier


def test_ci_workflow_enforces_python_and_harness_contracts():
    workflow = Path(".github/workflows/ci.yml")

    assert workflow.is_file()
    text = workflow.read_text(encoding="utf-8")
    assert "python -m ruff check arforge tests config.py main.py" in text
    assert "python -m pytest -q" in text
    assert "arforge capability-eval --json" not in text
    assert "node bin/arforge.js capabilities evaluate --json" in text
    assert "node bin/arforge.js doctor --json" in text
    assert "bun run lint" in text
    assert "bun run typecheck" in text
    assert "bun run brand:check" in text


def test_python_ci_installs_ts_dependencies_on_every_platform_before_tests():
    workflow = yaml.safe_load(Path(".github/workflows/ci.yml").read_text(encoding="utf-8"))
    steps = workflow["jobs"]["python-quality"]["steps"]
    install = next(i for i, step in enumerate(steps) if step.get("run") == "bun install --frozen-lockfile")
    tests = next(i for i, step in enumerate(steps) if step.get("run") == "python -m pytest -q")
    assert "if" not in steps[install], "TS dependencies must be installed on Linux as well as Windows"
    assert install < tests
    linux = next(step for step in steps if step.get("if") == "runner.os == 'Linux'")
    assert '.tools/bun-1.3.14/bun\n' in linux["run"]
    assert ".tools/bun-1.3.14/bun.exe" not in linux["run"]


def test_ci_keeps_static_capability_audit_separate_from_runtime_execution():
    workflow = yaml.safe_load(Path(".github/workflows/ci.yml").read_text(encoding="utf-8"))
    steps = workflow["jobs"]["typescript-recorded-replay"]["steps"]
    runtime = next(step for step in steps if "test/runtime/evaluation.test.ts" in step.get("run", ""))
    assert runtime["working-directory"] == "packages/core"
    assert "test/runtime/golden.test.ts" in runtime["run"]
    assert "--rerun-every" in runtime["run"]
    assert "--only-failures" not in runtime["run"]
    assert any("test/session-runner-recorded.test.ts" in step.get("run", "") for step in steps)
    assert workflow["jobs"]["typescript-recorded-replay"]["env"]["RECORD"] == "false"
