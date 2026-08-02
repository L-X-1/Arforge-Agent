"""Read-only release gate audit for Arforge's ordered ship path."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arforge import __version__


BLOCKED = "blocked"
MANUAL = "manual"
PASS = "pass"


@dataclass(frozen=True)
class Gate:
    id: str
    title: str
    status: str
    severity: str
    summary: str
    evidence: str | None = None
    next_action: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "severity": self.severity,
            "summary": self.summary,
            "evidence": self.evidence,
            "next_action": self.next_action,
        }


def build_release_gates(root: str | Path = ".") -> dict[str, Any]:
    """Return the current ordered release-gate verdict.

    This function is intentionally conservative: workflow definitions can prove
    a gate exists, but only evidence files from successful runs can prove that a
    release gate has passed.
    """
    project = Path(root).resolve()
    signing_audit = _signing_audit(project)
    gates = [
        _installer_lifecycle_gate(project),
        _signed_candidate_gate(project, signing_audit),
        _timestamp_gate(project, signing_audit),
        _protected_workflow_gate(project, signing_audit),
        _upgrade_matrix_gate(project),
        _accessibility_gate(project),
        _credential_data_git_gate(project),
        _staging_load_gate(project),
        _immutable_ship_gate(project),
    ]
    blocked = sum(1 for gate in gates if gate.status == BLOCKED)
    manual = sum(1 for gate in gates if gate.status == MANUAL)
    passed = sum(1 for gate in gates if gate.status == PASS)
    verdict = "DO_NOT_SHIP" if blocked or manual else "READY_FOR_RELEASE_REVIEW"
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "product_status": f"{__version__} / DO NOT SHIP" if verdict == "DO_NOT_SHIP" else "release review required",
        "verdict": verdict,
        "summary": {
            "total": len(gates),
            "pass": passed,
            "manual": manual,
            "blocked": blocked,
        },
        "gates": [gate.to_dict() for gate in gates],
        "release_order": [
            "installer_lifecycle",
            "signed_candidate",
            "upgrade_downgrade_accessibility",
            "security_data_git_governance",
            "provider_staging_load",
            "final_ship_gate",
        ],
    }


def format_release_gates(report: dict[str, Any]) -> str:
    lines = [
        f"Verdict: {report['verdict']}",
        f"Product status: {report['product_status']}",
        "",
        "Gates:",
    ]
    for gate in report["gates"]:
        marker = {"pass": "PASS", "manual": "MANUAL", "blocked": "BLOCKED"}[gate["status"]]
        lines.append(f"- {marker} [{gate['id']}] {gate['title']}: {gate['summary']}")
        if gate.get("next_action"):
            lines.append(f"  next: {gate['next_action']}")
    return "\n".join(lines)


def _signed_candidate_gate(root: Path, audit: dict[str, Any]) -> Gate:
    result = _signing_gate(audit, "SIGN-01")
    return Gate(
        "SIGN-01",
        result["title"],
        result["status"],
        "critical",
        result["summary"],
        result["evidence"],
        "Run the protected desktop-signed-candidate workflow and retain per-artifact signature evidence."
        if result["status"] != PASS
        else None,
    )


def _installer_lifecycle_gate(root: Path) -> Gate:
    from arforge.core.installer_audit import build_installer_audit

    audit = build_installer_audit(root)
    evidence = "; ".join(audit.get("evidence_files") or []) or None
    summary = audit.get("summary", {})
    if audit.get("release_gate_ready"):
        return Gate(
            "INSTALLER-01",
            "Protected Desktop installer lifecycle",
            PASS,
            "critical",
            "Desktop NSIS/MSI installer lifecycle, verbose logs and release-owner review evidence are complete.",
            evidence,
        )
    blockers = [check["id"] for check in audit.get("checks", []) if check.get("status") != PASS]
    return Gate(
        "INSTALLER-01",
        "Protected Desktop installer lifecycle",
        BLOCKED,
        "critical",
        (
            f"Installer audit is not release-ready: "
            f"{summary.get('pass', 0)} pass, {summary.get('manual', 0)} manual, "
            f"{summary.get('blocked', 0)} blocked. Open checks: {', '.join(blockers[:8])}."
        ),
        evidence,
        "Run `arforge installer-audit <path>` with elevated MSI lifecycle evidence, verbose logs and release-owner review.",
    )


def _timestamp_gate(root: Path, audit: dict[str, Any]) -> Gate:
    result = _signing_gate(audit, "SIGN-02")
    return Gate(
        "SIGN-02",
        result["title"],
        result["status"],
        "critical",
        result["summary"],
        result["evidence"],
        "Retain HTTPS RFC 3161 timestamp configuration and timestamped Authenticode verification output."
        if result["status"] != PASS
        else None,
    )


def _protected_workflow_gate(root: Path, audit: dict[str, Any]) -> Gate:
    result = _signing_gate(audit, "REL-01")
    return Gate(
        "REL-01",
        result["title"],
        result["status"],
        "critical",
        result["summary"],
        result["evidence"],
        "Prove protected workflow success, required reviewers and signing material cleanup before promotion."
        if result["status"] != PASS
        else None,
    )


def _upgrade_matrix_gate(root: Path) -> Gate:
    from arforge.core.upgrade_audit import build_upgrade_audit

    audit = build_upgrade_audit(root)
    evidence = "; ".join(audit.get("evidence_files") or []) or None
    summary = audit.get("summary", {})
    if audit.get("release_gate_ready"):
        return Gate(
            "UPGRADE-01",
            "Signed upgrade/downgrade matrix",
            PASS,
            "critical",
            "Signed upgrade, downgrade rejection, profile preservation, uninstall and manual review evidence are complete.",
            evidence,
        )
    blockers = [check["id"] for check in audit.get("checks", []) if check.get("status") != PASS]
    return Gate(
        "UPGRADE-01",
        "Signed upgrade/downgrade matrix",
        BLOCKED,
        "critical",
        (
            f"Upgrade audit is not release-ready: "
            f"{summary.get('pass', 0)} pass, {summary.get('manual', 0)} manual, "
            f"{summary.get('blocked', 0)} blocked. Open checks: {', '.join(blockers[:8])}."
        ),
        evidence,
        "Run `arforge upgrade-audit <path>` with two reviewed signed MSI artifacts and retain desktop-upgrade-evidence.json.",
    )


def _accessibility_gate(root: Path) -> Gate:
    from arforge.core.accessibility_audit import build_desktop_accessibility_audit

    audit = build_desktop_accessibility_audit(root)
    evidence = "; ".join(audit.get("evidence_files") or []) or None
    summary = audit.get("summary", {})
    if audit.get("release_gate_ready"):
        return Gate(
            "A11Y-01",
            "Native accessibility validation",
            PASS,
            "high",
            "Desktop accessibility preflight and native manual evidence are complete.",
            evidence,
        )
    missing = audit.get("missing_manual_evidence") or []
    missing_text = f" Missing manual evidence: {', '.join(missing)}." if missing else ""
    return Gate(
        "A11Y-01",
        "Native accessibility validation",
        BLOCKED,
        "high",
        (
            f"Desktop accessibility audit is not release-ready: "
            f"{summary.get('pass', 0)} pass, {summary.get('manual', 0)} manual, "
            f"{summary.get('blocked', 0)} blocked.{missing_text}"
        ),
        evidence,
        "Run `arforge accessibility-audit <path>` plus native keyboard, screen reader and 125/150/200 percent scaling validation.",
    )


def _credential_data_git_gate(root: Path) -> Gate:
    from arforge.core.governance_audit import build_governance_audit

    audit = build_governance_audit(root)
    evidence = "; ".join(audit.get("evidence_files") or []) or None
    summary = audit.get("summary", {})
    if not audit.get("release_gate_ready"):
        blockers = [check["id"] for check in audit.get("checks", []) if check.get("status") != PASS]
        return Gate(
            "GOV-01",
            "Credential, data and Git governance",
            BLOCKED,
            "critical",
            (
                f"Governance audit is not release-ready: "
                f"{summary.get('pass', 0)} pass, {summary.get('manual', 0)} manual, "
                f"{summary.get('blocked', 0)} blocked. Open checks: {', '.join(blockers[:8])}."
            ),
            evidence,
            "Clean/review the release baseline, configure remote, prove credential rotation and PostgreSQL restore drill.",
        )
    return Gate(
        "GOV-01",
        "Credential, data and Git governance",
        PASS,
        "critical",
        "Git baseline, remote, credential cleanup and PostgreSQL restore evidence are present.",
        evidence,
    )


def _staging_load_gate(root: Path) -> Gate:
    from arforge.core.staging_load_audit import build_staging_load_audit

    audit = build_staging_load_audit(root)
    evidence = "; ".join(audit.get("evidence_files") or []) or None
    summary = audit.get("summary", {})
    if audit.get("release_gate_ready"):
        return Gate(
            "STAGE-01",
            "Provider staging and load validation",
            PASS,
            "critical",
            "Provider staging, load, dogfood and release-owner evidence are complete.",
            evidence,
        )
    blockers = [check["id"] for check in audit.get("checks", []) if check.get("status") != PASS]
    return Gate(
        "STAGE-01",
        "Provider staging and load validation",
        BLOCKED,
        "critical",
        (
            f"Staging/load audit is not release-ready: "
            f"{summary.get('pass', 0)} pass, {summary.get('manual', 0)} manual, "
            f"{summary.get('blocked', 0)} blocked. Open checks: {', '.join(blockers[:8])}."
        ),
        evidence,
        "Run provider-backed staging smoke, long-run dogfood and load tests with retained logs.",
    )


def _immutable_ship_gate(root: Path) -> Gate:
    from arforge.core.ship_gate_audit import build_ship_gate_audit

    audit = build_ship_gate_audit(root)
    evidence = "; ".join(audit.get("evidence_files") or []) or None
    summary = audit.get("summary", {})
    if not audit.get("release_gate_ready"):
        blockers = [check["id"] for check in audit.get("checks", []) if check.get("status") != PASS]
        return Gate(
            "SHIP-01",
            "Final immutable artifact Ship Gate",
            BLOCKED,
            "critical",
            (
                f"Final Ship Gate audit is not release-ready: "
                f"{summary.get('pass', 0)} pass, {summary.get('manual', 0)} manual, "
                f"{summary.get('blocked', 0)} blocked. Open checks: {', '.join(blockers[:8])}."
            ),
            evidence,
            "Regenerate immutable artifacts from a clean reviewed commit after all prior gates pass.",
        )
    return Gate(
        "SHIP-01",
        "Final immutable artifact Ship Gate",
        PASS,
        "critical",
        "Immutable artifact manifest, hashes, prior gates snapshot and final approvals are complete.",
        evidence,
    )


def _latest_json(root: Path, pattern: str) -> tuple[dict[str, Any], Path] | None:
    path = _latest_file(root, pattern)
    if not path:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig")), path
    except Exception:
        return None


def _signing_audit(root: Path) -> dict[str, Any]:
    from arforge.core.signing_audit import build_signing_audit

    return build_signing_audit(root)


def _signing_gate(audit: dict[str, Any], gate_id: str) -> dict[str, Any]:
    from arforge.core.signing_audit import gate_status

    return gate_status(audit, gate_id)


def _latest_file(root: Path, pattern: str) -> Path | None:
    matches = [path for path in root.glob(pattern) if path.is_file()]
    if not matches:
        return None
    return max(matches, key=lambda path: path.stat().st_mtime)


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _git(root: Path, args: list[str]) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        return completed.stdout if completed.returncode == 0 else ""
    except Exception:
        return ""


def _relative(root: Path, path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)
