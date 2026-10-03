"""Regression tests for the legacy Python CLI retirement inventory."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_cli_compat_inventory_is_frozen_and_points_to_the_ts_owner() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/cli_compat_inventory.py", "--json", "--check"],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    inventory = json.loads(result.stdout)
    definitions = inventory["legacy_definitions"]
    names = [item["name"] for item in definitions]
    assert inventory["schema_version"] == 1
    assert inventory["status"] == "migration-window"
    assert inventory["canonical_runtime"] == "typescript"
    assert inventory["canonical_entry"] == "packages/arforge/src/index.ts"
    assert inventory["embedding_facade"] == "arforge.cli_compat"
    assert inventory["legacy_definition_count"] == len(definitions) >= 100
    assert len(names) == len(set(names))
    assert "main" in names
    assert all(item["status"] == "frozen-legacy" for item in definitions)
    assert inventory["frozen_compat_import_count"] == 0
    assert inventory["frozen_compat_imports"] == []
    assert inventory["embedding_facade_exports"] == [
        "CliInvocationResult",
        "UnifiedCliUnavailable",
        "build_command",
        "invoke",
        "main",
        "resolve_unified_cli",
        "run",
    ]
    policy = inventory["retirement_policy"]
    assert policy["new_product_commands"] == "forbidden"
    assert policy["new_python_state_writers"] == "forbidden"
    assert policy["executable_entry"] == "cli_bridge-only"
    assert policy["direct_import"] == "explicit-migration-only"
    assert len(policy["removal_prerequisites"]) == 4
