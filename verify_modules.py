"""Import-smoke verifier for core Arforge modules.

This script is intentionally lightweight: it checks that key modules import
without running provider calls, database writes, installers or release actions.
Use the focused pytest suites for behavioral verification.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass


PASS = "[OK]"
FAIL = "[FAIL]"


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str = ""


MODULES = (
    # The user-facing launcher is the TypeScript CLI.  Keep the legacy Python
    # parser out of the default import smoke; compatibility tests exercise it
    # explicitly where needed.
    "arforge.cli_bridge",
    # The Python capability bridge was retired; direct_dispatch is the
    # remaining compatibility/runtime seam for legacy CLI-only modules.
    "arforge.product.direct_dispatch",
    "arforge.core.agent_core",
    "arforge.core.agent_loop_v2",
    "arforge.core.release_gates",
    "arforge.core.installer_audit",
    "arforge.core.signing_audit",
    "arforge.core.upgrade_audit",
    "arforge.core.accessibility_audit",
    "arforge.core.governance_audit",
    "arforge.core.staging_load_audit",
    "arforge.core.ship_gate_audit",
    "arforge.core.evidence_templates",
    "arforge.core.runtime_metrics",
    "arforge.core.quality_gate",
    "arforge.models.model_adapter",
    "arforge.tool_registry",
    "arforge.tools.basic_tools",
    "arforge.tools.file_tools",
    "arforge.tools.code_tools",
    "arforge.tools.git_tools",
    "arforge.tools.verify_tools",
    "arforge.product.service",
    "arforge.product.session_runtime",
    "arforge.semantic_memory",
    "arforge.memory_vector",
)


def check_import(module_name: str) -> CheckResult:
    try:
        importlib.import_module(module_name)
    except Exception as exc:  # pragma: no cover - script diagnostics
        return CheckResult(module_name, False, f"{type(exc).__name__}: {exc}")
    return CheckResult(module_name, True)


def run_checks() -> list[CheckResult]:
    return [check_import(module_name) for module_name in MODULES]


def main() -> int:
    print("=" * 60)
    print("Arforge module import smoke verification")
    print("=" * 60)
    results = run_checks()
    for result in results:
        icon = PASS if result.ok else FAIL
        detail = f" - {result.detail}" if result.detail else ""
        print(f"  {icon} {result.name}{detail}")

    passed = sum(1 for result in results if result.ok)
    failed = len(results) - passed
    print()
    print(f"  Passed: {passed}/{len(results)}")
    print(f"  Failed: {failed}/{len(results)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
