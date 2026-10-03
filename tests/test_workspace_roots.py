"""Compatibility-boundary checks for the TypeScript workspace-root owner.

The historical Python trust/root writer is no longer the contract under test.
These tests exercise the Python entry only as an embedding bridge and compare
its observable result with the canonical TypeScript CLI. Core/TypeScript tests
own the detailed authorization, sandbox and writer contracts.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _environment(home: Path, bun: Path) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if key not in {"ARFORGE_DB_URL", "DATABASE_URL"}}
    environment.update(
        {
            "ARFORGE_BUN": str(bun),
            "ARFORGE_DB": ":memory:",
            "ARFORGE_HOME": str(home),
            "ARFORGE_TEST_HOME": str(home),
            "NO_COLOR": "1",
        }
    )
    return environment


def _runners(tmp_path: Path):
    bun = ROOT / ".tools" / "bun-1.3.14" / ("bun.exe" if os.name == "nt" else "bun")
    if not bun.is_file():
        pytest.skip("pinned Bun runtime is unavailable")
    home = tmp_path / "profile"
    environment = _environment(home, bun)

    def run_typescript(args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
            cwd=ROOT,
            env=environment,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    def run_python(args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "arforge", *args],
            cwd=ROOT,
            env=environment,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    return run_typescript, run_python, home


def test_python_workspace_list_matches_canonical_typescript_projection(tmp_path: Path) -> None:
    run_typescript, run_python, _home = _runners(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    args = ["workspace", "list", "--workspace", str(workspace), "--json"]

    typescript = run_typescript(args)
    python = run_python(args)

    assert python.returncode == typescript.returncode == 0
    assert python.stdout == typescript.stdout
    assert python.stderr == typescript.stderr
    payload = json.loads(python.stdout)
    assert payload["primary"] == str(workspace.resolve())
    assert payload["roots"] == [{"path": str(workspace.resolve()), "primary": True, "trusted": False}]


@pytest.mark.parametrize("action", ["trust", "add", "remove"])
def test_python_workspace_mutations_match_typescript_fail_closed_boundary(tmp_path: Path, action: str) -> None:
    run_typescript, run_python, home = _runners(tmp_path)
    workspace = tmp_path / "workspace"
    target = tmp_path / "additional"
    workspace.mkdir()
    target.mkdir()
    args = ["workspace", action, str(target), "--workspace", str(workspace), "--json"]

    typescript = run_typescript(args)
    python = run_python(args)

    assert python.returncode == typescript.returncode == 2
    assert python.stdout == typescript.stdout == ""
    assert python.stderr == typescript.stderr
    assert "fail-closed" in python.stderr
    assert not (home / "trusted_workspaces.json").exists()
    assert not (home / "workspace_roots.json").exists()


def test_python_contract_audit_matches_typescript_json(tmp_path: Path) -> None:
    run_typescript, run_python, _home = _runners(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    args = ["workspace", "--contract-audit", "--workspace", str(workspace), "--json"]

    typescript = run_typescript(args)
    python = run_python(args)

    assert python.returncode == typescript.returncode == 0
    assert python.stdout == typescript.stdout
    assert python.stderr == typescript.stderr
    payload = json.loads(python.stdout)
    assert payload["execution_mode"] == "read-only-workspace-root-mutation-contract-audit"
    assert payload["ready"] is False
    assert payload["writes"] == 0
    assert payload["decision"] == "fail-closed"
