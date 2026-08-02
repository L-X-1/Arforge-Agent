"""Stage 5 release audit snapshot bundle.

The bundle is a read-only snapshot of current release gate audits. It is useful
for release review and for retaining prior-gate audit reports, but it is not
release evidence by itself and never changes a gate status.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arforge.core.accessibility_audit import build_desktop_accessibility_audit
from arforge.core.governance_audit import build_governance_audit
from arforge.core.installer_audit import build_installer_audit
from arforge.core.release_gates import build_release_gates
from arforge.core.ship_gate_audit import build_ship_gate_audit
from arforge.core.signing_audit import build_signing_audit
from arforge.core.staging_load_audit import build_staging_load_audit
from arforge.core.upgrade_audit import build_upgrade_audit


AUDIT_BUILDERS = {
    "installer": build_installer_audit,
    "signing": build_signing_audit,
    "upgrade": build_upgrade_audit,
    "accessibility": build_desktop_accessibility_audit,
    "governance": build_governance_audit,
    "staging": build_staging_load_audit,
    "ship": build_ship_gate_audit,
}


def build_release_audit_bundle(root: str | Path = ".", output_dir: str | Path = "build/release-audit-snapshot") -> dict[str, Any]:
    """Run all Stage 5 audits and write a structured snapshot bundle."""
    project = Path(root).resolve()
    target = Path(output_dir)
    if not target.is_absolute():
        target = project / target
    target = target.resolve()
    _require_inside(project, target)
    target.mkdir(parents=True, exist_ok=True)

    reports: dict[str, dict[str, Any]] = {
        name: builder(project)
        for name, builder in AUDIT_BUILDERS.items()
    }
    release_gates = build_release_gates(project)
    written_reports = {
        name: _write_json(target / f"{name}-audit.json", report)
        for name, report in reports.items()
    }
    release_gates_path = _write_json(target / "release-gates.json", release_gates)
    summary = _bundle_summary(project, target, reports, release_gates, written_reports, release_gates_path)
    summary_path = _write_json(target / "summary.json", summary)
    summary["summary_path"] = _relative(project, summary_path)
    _write_json(summary_path, summary)
    return summary


def _bundle_summary(
    root: Path,
    target: Path,
    reports: dict[str, dict[str, Any]],
    release_gates: dict[str, Any],
    written_reports: dict[str, Path],
    release_gates_path: Path,
) -> dict[str, Any]:
    audit_items = []
    for name, report in reports.items():
        summary = report.get("summary", {})
        audit_items.append(
            {
                "id": name,
                "path": _relative(root, written_reports[name]),
                "status": report.get("status", "blocked"),
                "release_gate_ready": bool(report.get("release_gate_ready")),
                "pass": int(summary.get("pass", 0)),
                "manual": int(summary.get("manual", 0)),
                "blocked": int(summary.get("blocked", 0)),
            }
        )
    return {
        "schema_version": 1,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "release_audit_bundle",
        "output_dir": _relative(root, target),
        "verdict": release_gates.get("verdict"),
        "product_status": release_gates.get("product_status"),
        "release_gate_ready": release_gates.get("verdict") != "DO_NOT_SHIP",
        "release_gates_path": _relative(root, release_gates_path),
        "audits": audit_items,
        "release_gates_summary": release_gates.get("summary", {}),
        "note": "Audit snapshot only; generated reports do not replace retained release evidence files.",
    }


def _write_json(path: Path, data: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _require_inside(root: Path, path: Path) -> None:
    try:
        path.resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError(f"release audit bundle output must stay inside repository root: {path}") from exc
