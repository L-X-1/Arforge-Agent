"""Signed desktop upgrade and downgrade release audit."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "pass"
BLOCKED = "blocked"
MANUAL = "manual"

_WORKFLOW_REQUIRED = [
    "environment: desktop-release-candidate",
    "baseline_run_id",
    "candidate_run_id",
    "baseline_msi_sha256",
    "candidate_msi_sha256",
    "actions/download-artifact@v4",
    "scripts/verify_desktop_upgrade.ps1",
    "RequireValidSignature",
    "actions/upload-artifact@v4",
]
_VERIFIER_REQUIRED = [
    "Get-AuthenticodeSignature",
    "TimeStamperCertificate",
    "Candidate MSI version",
    "Baseline MSI install failed",
    "Candidate MSI upgrade failed",
    "Older baseline MSI was allowed to downgrade",
    "Profile marker changed during candidate upgrade",
    "preserved_after_uninstall",
    "desktop-upgrade-evidence.json",
]
_MANUAL_REQUIRED = {
    "release_owner_review": "Release owner reviewed baseline/candidate run IDs, versions and SHA-256 values",
    "profile_preservation_review": "Profile preservation and uninstall behavior were reviewed on a real Windows profile",
}


def build_upgrade_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a fail-closed signed upgrade/downgrade audit."""
    project = Path(root).resolve()
    evidence = _latest_json(
        project,
        (
            "build/**/desktop-upgrade-evidence.json",
            "desktop/release-evidence/desktop-upgrade-evidence.json",
            "desktop/release-evidence/*upgrade*.json",
        ),
    )
    workflow = project / ".github" / "workflows" / "desktop-upgrade-matrix.yml"
    verifier = project / "scripts" / "verify_desktop_upgrade.ps1"
    checks = [
        _workflow_contract_check(project, workflow),
        _verifier_contract_check(project, verifier),
        _signed_pair_check(project, evidence),
        _upgrade_install_check(project, evidence),
        _downgrade_rejection_check(project, evidence),
        _profile_preservation_check(project, evidence),
        _uninstall_cleanup_check(project, evidence),
        _review_metadata_check(project, evidence),
        *_manual_checks(project, evidence),
    ]
    counts = _count_statuses(checks)
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "desktop_signed_upgrade",
        "status": PASS if counts[BLOCKED] == 0 and counts[MANUAL] == 0 else BLOCKED,
        "upgrade_ready": _all_pass(checks, {"signed_baseline_candidate", "upgrade_install"}),
        "downgrade_ready": _all_pass(checks, {"signed_baseline_candidate", "downgrade_rejected"}),
        "profile_ready": _all_pass(checks, {"profile_preserved", "uninstall_cleanup"}),
        "release_gate_ready": counts[BLOCKED] == 0 and counts[MANUAL] == 0,
        "summary": {
            "total": len(checks),
            PASS: counts[PASS],
            MANUAL: counts[MANUAL],
            BLOCKED: counts[BLOCKED],
        },
        "checks": checks,
        "required_manual_evidence": _MANUAL_REQUIRED,
        "evidence_files": [
            item
            for item in [
                _relative(project, evidence[1]) if evidence else None,
                _relative(project, workflow) if workflow.exists() else None,
                _relative(project, verifier) if verifier.exists() else None,
            ]
            if item
        ],
    }


def format_upgrade_audit(report: dict[str, Any]) -> str:
    lines = [
        f"Status: {report['status']}",
        f"Upgrade ready: {str(report['upgrade_ready']).lower()}",
        f"Downgrade ready: {str(report['downgrade_ready']).lower()}",
        f"Profile ready: {str(report['profile_ready']).lower()}",
        f"Checks: {report['summary']['pass']} pass, {report['summary']['manual']} manual, {report['summary']['blocked']} blocked",
        "",
        "Checks:",
    ]
    for check in report["checks"]:
        lines.append(f"- {check['status'].upper()} [{check['id']}] {check['title']}: {check['summary']}")
    return "\n".join(lines)


def write_upgrade_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def _workflow_contract_check(root: Path, workflow: Path) -> dict[str, Any]:
    text = _read_text(workflow)
    missing = [item for item in _WORKFLOW_REQUIRED if item not in text]
    return _check(
        "upgrade_workflow_contract",
        "Signed upgrade matrix workflow contract",
        workflow.exists() and not missing,
        "Upgrade workflow pins reviewed baseline/candidate artifacts, hashes, protected environment and evidence upload.",
        f"Upgrade workflow is missing required controls: {', '.join(missing) or 'workflow missing'}.",
        _relative(root, workflow) if workflow.exists() else None,
        {"missing": missing},
    )


def _verifier_contract_check(root: Path, verifier: Path) -> dict[str, Any]:
    text = _read_text(verifier)
    missing = [item for item in _VERIFIER_REQUIRED if item not in text]
    return _check(
        "upgrade_verifier_contract",
        "Signed upgrade verifier contract",
        verifier.exists() and not missing,
        "Verifier enforces signature, timestamp, upgrade, downgrade rejection, profile preservation and uninstall evidence.",
        f"Upgrade verifier is missing required assertions: {', '.join(missing) or 'verifier missing'}.",
        _relative(root, verifier) if verifier.exists() else None,
        {"missing": missing},
    )


def _signed_pair_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check(
            "signed_baseline_candidate",
            "Signed baseline and candidate evidence",
            False,
            "",
            "Desktop upgrade evidence is missing.",
            None,
        )
    data, path = evidence
    baseline = _mapping(data.get("baseline"))
    candidate = _mapping(data.get("candidate"))
    baseline_version = str(baseline.get("version") or "")
    candidate_version = str(candidate.get("version") or "")
    baseline_sha = str(baseline.get("sha256") or "")
    candidate_sha = str(candidate.get("sha256") or "")
    version_ok = _version_gt(candidate_version, baseline_version)
    sha_ok = _is_sha256(baseline_sha) and _is_sha256(candidate_sha) and baseline_sha.lower() != candidate_sha.lower()
    signatures = _signature_items(data)
    signature_ok = len(signatures) >= 2 and all(_signature_valid(item) for item in signatures)
    metadata_missing = [
        *_upgrade_metadata_missing(data, baseline, candidate),
        *_upgrade_artifact_file_missing(root, path.parent, "baseline", baseline),
        *_upgrade_artifact_file_missing(root, path.parent, "candidate", candidate),
    ]
    ok = version_ok and sha_ok and signature_ok and data.get("signatures_required") is True and not metadata_missing
    return _check(
        "signed_baseline_candidate",
        "Signed baseline and candidate evidence",
        ok,
        "Baseline and candidate have reviewed workflow provenance, ordered versions, retained MSI files, distinct SHA-256 values and valid timestamped signatures.",
        f"Evidence must prove two different signed/timestamped MSI versions with reviewed workflow provenance. Missing or invalid: {', '.join(metadata_missing) or 'signed/version/hash evidence'}.",
        _relative(root, path),
        {
            "baseline_version": baseline_version or None,
            "candidate_version": candidate_version or None,
            "version_ordered": version_ok,
            "distinct_sha256": sha_ok,
            "signatures_required": data.get("signatures_required") is True,
            "valid_signature_items": sum(1 for item in signatures if _signature_valid(item)),
            "signature_items": len(signatures),
            "missing_metadata": metadata_missing,
        },
    )


def _upgrade_install_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    data, path = _evidence_or_empty(evidence)
    baseline = _mapping(data.get("baseline"))
    candidate = _mapping(data.get("candidate"))
    baseline_ok = _exit_ok(baseline.get("install_exit_code"))
    candidate_ok = _exit_ok(candidate.get("install_exit_code")) and _is_sha256(str(candidate.get("installed_app_sha256") or ""))
    ok = baseline_ok and candidate_ok
    return _check(
        "upgrade_install",
        "Baseline install and candidate upgrade",
        ok,
        "Baseline install and candidate in-place upgrade completed successfully.",
        "Evidence must include successful baseline install and candidate upgrade exit codes plus installed app hash.",
        _relative(root, path),
        {"baseline_install": baseline_ok, "candidate_upgrade": candidate_ok},
    )


def _downgrade_rejection_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    data, path = _evidence_or_empty(evidence)
    downgrade = _mapping(data.get("downgrade"))
    ok = downgrade.get("rejected") is True and downgrade.get("candidate_app_preserved") is True
    return _check(
        "downgrade_rejected",
        "Older baseline downgrade rejection",
        ok,
        "Older baseline downgrade was rejected and candidate application hash was preserved.",
        "Evidence must prove the older baseline cannot downgrade or replace the candidate.",
        _relative(root, path),
        {
            "rejected": downgrade.get("rejected") is True,
            "candidate_app_preserved": downgrade.get("candidate_app_preserved") is True,
        },
    )


def _profile_preservation_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    data, path = _evidence_or_empty(evidence)
    profile = _mapping(data.get("profile"))
    missing: list[str] = []
    if profile.get("preserved_through_upgrade") is not True:
        missing.append("preserved_through_upgrade=true")
    if not _is_sha256(str(profile.get("marker_sha256") or "")):
        missing.append("marker_sha256")
    missing.extend(_retained_evidence_file_missing(root, path.parent if path else root, profile, "marker_path", "marker_sha256"))
    ok = not missing
    return _check(
        "profile_preserved",
        "Profile preservation through upgrade",
        ok,
        "User profile marker was preserved through baseline startup, candidate upgrade and downgrade rejection.",
        f"Evidence must prove user profile preservation through upgrade and downgrade rejection: {', '.join(missing)}.",
        _relative(root, path),
        {"preserved_through_upgrade": profile.get("preserved_through_upgrade") is True, "missing": missing},
    )


def _uninstall_cleanup_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    data, path = _evidence_or_empty(evidence)
    candidate = _mapping(data.get("candidate"))
    profile = _mapping(data.get("profile"))
    missing: list[str] = []
    if not _exit_ok(candidate.get("uninstall_exit_code")):
        missing.append("candidate.uninstall_exit_code")
    if profile.get("preserved_after_uninstall") is not True:
        missing.append("preserved_after_uninstall=true")
    missing.extend(_retained_evidence_file_missing(root, path.parent if path else root, profile, "marker_path", "marker_sha256"))
    ok = not missing
    return _check(
        "uninstall_cleanup",
        "Candidate uninstall cleanup",
        ok,
        "Candidate uninstall succeeded while preserving the user profile marker.",
        f"Evidence must prove candidate uninstall cleanup and preserved user profile marker: {', '.join(missing)}.",
        _relative(root, path),
        {
            "candidate_uninstall": _exit_ok(candidate.get("uninstall_exit_code")),
            "profile_preserved_after_uninstall": profile.get("preserved_after_uninstall") is True,
            "missing": missing,
        },
    )


def _manual_checks(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> list[dict[str, Any]]:
    data = evidence[0] if evidence else None
    path = evidence[1] if evidence else None
    manual = data.get("manual_validation") if isinstance(data, dict) else None
    checks = []
    for check_id, title in _MANUAL_REQUIRED.items():
        value = manual.get(check_id) if isinstance(manual, dict) else None
        status, missing = _manual_upgrade_status(root, path.parent if path else root, check_id, value)
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": (
                    "Manual upgrade evidence accepted."
                    if status == PASS
                    else "Manual release-owner upgrade evidence is required."
                    if status == MANUAL
                    else f"Manual upgrade evidence is incomplete: {', '.join(missing)}."
                ),
                "evidence": _relative(root, path),
                "details": {"missing": missing},
            }
        )
    return checks


def _manual_upgrade_status(root: Path, evidence_dir: Path, check_id: str, value: Any) -> tuple[str, list[str]]:
    if value is None:
        return MANUAL, []
    if not isinstance(value, dict):
        return BLOCKED, ["structured_object"]
    status = value.get("status") or value.get("result")
    missing: list[str] = []
    if not (status is True or (isinstance(status, str) and status.lower() == PASS)):
        missing.append("status=pass")
    if not _non_empty(value.get("reviewer")):
        missing.append("reviewer")
    if not _timestamp(value.get("reviewed_at_utc")):
        missing.append("reviewed_at_utc")
    if not _non_empty(value.get("evidence")):
        missing.append("evidence")
    if not _non_empty(value.get("notes")):
        missing.append("notes")
    if check_id == "release_owner_review":
        for field in (
            "baseline_workflow_run_id",
            "candidate_workflow_run_id",
            "baseline_artifact_name",
            "candidate_artifact_name",
        ):
            if not _non_empty(value.get(field)):
                missing.append(field)
        for field in ("baseline_sha256", "candidate_sha256"):
            if not _is_sha256(str(value.get(field) or "")):
                missing.append(field)
        if value.get("version_ordered") is not True:
            missing.append("version_ordered=true")
        if value.get("downgrade_rejected") is not True:
            missing.append("downgrade_rejected=true")
    elif check_id == "profile_preservation_review":
        if value.get("profile_preserved_through_upgrade") is not True:
            missing.append("profile_preserved_through_upgrade=true")
        if not _is_sha256(str(value.get("profile_marker_sha256") or "")):
            missing.append("profile_marker_sha256")
        missing.extend(_retained_evidence_file_missing(root, evidence_dir, value, "profile_marker_path", "profile_marker_sha256"))
        if value.get("preserved_after_uninstall") is not True:
            missing.append("preserved_after_uninstall=true")
        if value.get("uninstall_cleanup_reviewed") is not True:
            missing.append("uninstall_cleanup_reviewed=true")
    return (PASS, []) if not missing else (BLOCKED, missing)


def _review_metadata_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return {
            "id": "upgrade_review_metadata",
            "title": "Upgrade release-owner review metadata",
            "status": MANUAL,
            "summary": "Structured upgrade review evidence is required.",
            "evidence": None,
        }
    data, path = evidence
    baseline = _mapping(data.get("baseline"))
    candidate = _mapping(data.get("candidate"))
    profile = _mapping(data.get("profile"))
    downgrade = _mapping(data.get("downgrade"))
    review = _mapping(data.get("review"))
    missing: list[str] = []
    if not _non_empty(review.get("reviewer")):
        missing.append("review.reviewer")
    if not _timestamp(review.get("reviewed_at_utc")):
        missing.append("review.reviewed_at_utc")
    if review.get("baseline_workflow_run_id") != baseline.get("workflow_run_id"):
        missing.append("review.baseline_workflow_run_id")
    if review.get("candidate_workflow_run_id") != candidate.get("workflow_run_id"):
        missing.append("review.candidate_workflow_run_id")
    if review.get("baseline_artifact_name") != baseline.get("artifact_name"):
        missing.append("review.baseline_artifact_name")
    if review.get("candidate_artifact_name") != candidate.get("artifact_name"):
        missing.append("review.candidate_artifact_name")
    if str(review.get("baseline_sha256") or "").lower() != str(baseline.get("sha256") or "").lower():
        missing.append("review.baseline_sha256")
    if str(review.get("candidate_sha256") or "").lower() != str(candidate.get("sha256") or "").lower():
        missing.append("review.candidate_sha256")
    if review.get("version_ordered") is not True:
        missing.append("review.version_ordered=true")
    if review.get("downgrade_rejected") is not True or downgrade.get("rejected") is not True:
        missing.append("review.downgrade_rejected=true")
    if review.get("profile_marker_sha256") != profile.get("marker_sha256"):
        missing.append("review.profile_marker_sha256")
    if review.get("profile_marker_path") != profile.get("marker_path"):
        missing.append("review.profile_marker_path")
    missing.extend(_retained_evidence_file_missing(root, path.parent, profile, "marker_path", "marker_sha256"))
    missing.extend(_retained_evidence_file_missing(root, path.parent, review, "profile_marker_path", "profile_marker_sha256"))
    if review.get("uninstall_cleanup_reviewed") is not True:
        missing.append("review.uninstall_cleanup_reviewed=true")
    return _check(
        "upgrade_review_metadata",
        "Upgrade release-owner review metadata",
        not missing,
        "Upgrade review metadata binds reviewer, workflow runs, MSI artifacts, version ordering, profile marker and cleanup.",
        f"Upgrade review metadata is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"missing": missing},
    )


def _check(
    check_id: str,
    title: str,
    ok: bool,
    success: str,
    failure: str,
    evidence: str | None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item = {
        "id": check_id,
        "title": title,
        "status": PASS if ok else BLOCKED,
        "summary": success if ok else failure,
        "evidence": evidence,
    }
    if details is not None:
        item["details"] = details
    return item


def _latest_json(root: Path, patterns: tuple[str, ...]) -> tuple[dict[str, Any], Path] | None:
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(path for path in root.glob(pattern) if path.is_file())
    for path in sorted(matches, key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if isinstance(data, dict):
            return data, path
    return None


def _signature_items(data: dict[str, Any]) -> list[dict[str, Any]]:
    signatures = data.get("signatures")
    if not isinstance(signatures, list):
        return []
    return [item for item in signatures if isinstance(item, dict)]


def _signature_valid(item: dict[str, Any]) -> bool:
    return item.get("status") == "Valid" and bool(item.get("timestamp_subject"))


def _upgrade_metadata_missing(data: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not _passish(data.get("status")):
        missing.append("status=pass")
    for label, item in (("baseline", baseline), ("candidate", candidate)):
        if not _non_empty(item.get("workflow_run_id")):
            missing.append(f"{label}.workflow_run_id")
        if not _msi_artifact_name(str(item.get("artifact_name") or "")):
            missing.append(f"{label}.artifact_name(.msi)")
        if item.get("sha256_reviewed") is not True:
            missing.append(f"{label}.sha256_reviewed=true")
    if baseline.get("workflow_run_id") and baseline.get("workflow_run_id") == candidate.get("workflow_run_id"):
        missing.append("distinct_workflow_run_ids")
    return missing


def _upgrade_artifact_file_missing(root: Path, evidence_dir: Path, label: str, item: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    artifact_name = str(item.get("artifact_name") or "")
    expected_sha = str(item.get("sha256") or "")
    if not _msi_artifact_name(artifact_name):
        return missing
    artifact_path = _resolve_artifact_path(root, evidence_dir, artifact_name)
    if artifact_path is None:
        missing.append(f"{label}.artifact_path_relative")
    elif not artifact_path.is_file():
        missing.append(f"{label}.retained_file_exists")
    elif _is_sha256(expected_sha) and _sha256(artifact_path) != expected_sha.lower():
        missing.append(f"{label}.sha256_matches_file")
    return missing


def _retained_evidence_file_missing(
    root: Path,
    evidence_dir: Path,
    data: dict[str, Any],
    path_field: str,
    sha_field: str,
) -> list[str]:
    missing: list[str] = []
    path_value = str(data.get(path_field) or "").strip()
    expected_sha = str(data.get(sha_field) or "").lower()
    if not path_value:
        missing.append(path_field)
    if not _is_sha256(expected_sha):
        missing.append(sha_field)
    if not path_value:
        return missing
    resolved = _resolve_artifact_path(root, evidence_dir, path_value)
    if resolved is None:
        missing.append(f"{path_field}_relative")
    elif not resolved.is_file():
        missing.append(f"{path_field}_exists")
    elif _is_sha256(expected_sha) and _sha256(resolved) != expected_sha:
        missing.append(f"{sha_field}_matches_file")
    return missing


def _evidence_or_empty(evidence: tuple[dict[str, Any], Path] | None) -> tuple[dict[str, Any], Path | None]:
    return evidence if evidence else ({}, None)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _all_pass(checks: list[dict[str, Any]], ids: set[str]) -> bool:
    by_id = {check["id"]: check for check in checks}
    return all(by_id.get(check_id, {}).get("status") == PASS for check_id in ids)


def _count_statuses(checks: list[dict[str, Any]]) -> dict[str, int]:
    return {
        PASS: sum(1 for check in checks if check["status"] == PASS),
        MANUAL: sum(1 for check in checks if check["status"] == MANUAL),
        BLOCKED: sum(1 for check in checks if check["status"] == BLOCKED),
    }


def _passish(value: Any) -> bool:
    return isinstance(value, str) and value.lower() in {"pass", "passed", "ok", "success", "succeeded"}


def _non_empty(value: Any) -> bool:
    return isinstance(value, (str, int)) and bool(str(value).strip())


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    normalized = value.strip().replace("Z", "+00:00")
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return True


def _exit_ok(value: Any) -> bool:
    return value in {0, 3010}


def _version_gt(candidate: str, baseline: str) -> bool:
    candidate_parts = _version_parts(candidate)
    baseline_parts = _version_parts(baseline)
    return bool(candidate_parts and baseline_parts and candidate_parts > baseline_parts)


def _version_parts(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(?:\.\d+){1,3}", value):
        return ()
    return tuple(int(part) for part in value.split("."))


def _is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value))


def _msi_artifact_name(value: str) -> bool:
    return bool(value.strip()) and value.lower().endswith(".msi")


def _resolve_artifact_path(root: Path, evidence_dir: Path, value: str) -> Path | None:
    normalized = value.replace("\\", "/").strip()
    if not normalized:
        return None
    relative = Path(normalized)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    for base in (evidence_dir, root / "dist", root):
        candidate = (base / relative).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if candidate.exists():
            return candidate
    return (evidence_dir / relative).resolve()


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _relative(root: Path, path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)
