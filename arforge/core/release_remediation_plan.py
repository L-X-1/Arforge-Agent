"""Machine-readable remediation plan for blocked Stage 5 release gates."""

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


GATE_AUDITS = {
    "INSTALLER-01": ("installer", build_installer_audit, "arforge installer-audit"),
    "SIGN-01": ("signing", build_signing_audit, "arforge signing-audit"),
    "SIGN-02": ("signing", build_signing_audit, "arforge signing-audit"),
    "REL-01": ("signing", build_signing_audit, "arforge signing-audit"),
    "UPGRADE-01": ("upgrade", build_upgrade_audit, "arforge upgrade-audit"),
    "A11Y-01": ("accessibility", build_desktop_accessibility_audit, "arforge accessibility-audit"),
    "GOV-01": ("governance", build_governance_audit, "arforge governance-audit"),
    "STAGE-01": ("staging", build_staging_load_audit, "arforge staging-audit"),
    "SHIP-01": ("ship", build_ship_gate_audit, "arforge ship-audit"),
}

COLLECTION_HELPERS = {
    "INSTALLER-01": ["scripts/verify_desktop_installer.ps1", "scripts/verify_desktop_nsis.ps1"],
    "SIGN-01": ["scripts/write_desktop_signed_candidate_evidence.ps1"],
    "SIGN-02": ["scripts/write_desktop_signed_candidate_evidence.ps1"],
    "REL-01": ["scripts/write_desktop_signed_candidate_evidence.ps1"],
    "UPGRADE-01": ["scripts/verify_desktop_upgrade.ps1"],
    "A11Y-01": ["scripts/write_desktop_accessibility_evidence.ps1"],
    "GOV-01": ["scripts/write_governance_evidence.py"],
    "STAGE-01": ["scripts/write_staging_load_evidence.py"],
    "SHIP-01": ["scripts/write_ship_gate_evidence.py"],
}


def build_release_remediation_plan(root: str | Path = ".") -> dict[str, Any]:
    """Return an ordered remediation plan for the current release gate state."""
    project = Path(root).resolve()
    gates_report = build_release_gates(project)
    audits_by_surface = _build_audits(project)
    items = [
        _plan_item(project, gate, audits_by_surface)
        for gate in gates_report["gates"]
        if gate["status"] != "pass"
    ]
    return {
        "schema_version": 1,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "release_remediation_plan",
        "verdict": gates_report["verdict"],
        "product_status": gates_report["product_status"],
        "remaining": len(items),
        "release_order": gates_report["release_order"],
        "items": items,
        "note": "Plan only; execute real validation and retained evidence collection before re-running gates.",
    }


def write_release_remediation_plan(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target


def _build_audits(root: Path) -> dict[str, dict[str, Any]]:
    audits: dict[str, dict[str, Any]] = {}
    for surface, builder, _command in {value for value in GATE_AUDITS.values()}:
        if surface not in audits:
            audits[surface] = builder(root)
    return audits


def _plan_item(root: Path, gate: dict[str, Any], audits_by_surface: dict[str, dict[str, Any]]) -> dict[str, Any]:
    gate_id = gate["id"]
    surface, _builder, audit_command = GATE_AUDITS[gate_id]
    audit = audits_by_surface[surface]
    open_checks = [
        {
            "id": check["id"],
            "status": check["status"],
            "summary": check["summary"],
            "evidence": check.get("evidence"),
        }
        for check in audit.get("checks", [])
        if check.get("status") != "pass"
    ]
    return {
        "gate": gate_id,
        "title": gate["title"],
        "status": gate["status"],
        "severity": gate["severity"],
        "summary": gate["summary"],
        "next_action": gate.get("next_action"),
        "audit_command": audit_command,
        "audit_surface": surface,
        "collection_helpers": _existing_helpers(root, COLLECTION_HELPERS.get(gate_id, [])),
        "open_checks": open_checks,
    }


def _existing_helpers(root: Path, helpers: list[str]) -> list[str]:
    return [helper for helper in helpers if (root / helper).exists()]
