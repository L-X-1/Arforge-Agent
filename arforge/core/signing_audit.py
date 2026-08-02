"""Windows Authenticode signing release audit."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "pass"
BLOCKED = "blocked"
MANUAL = "manual"

_SIGNED_ARTIFACT_SUFFIXES = (".exe", ".msi")
_REQUIRED_ARTIFACT_SUFFIXES = (".exe",)
_WORKFLOW_REQUIRED = [
    "environment: desktop-release-candidate",
    "digicert/code-signing-software-trust-action@",
    "secrets.SM_CLIENT_CERT_FILE_B64",
    "secrets.SM_API_KEY",
    "vars.ARFORGE_WINDOWS_KEYPAIR_ALIAS",
    "Verify signing readiness without exposing secrets",
    "Verify Authenticode signature and RFC 3161 timestamp",
    "actions/upload-artifact@v4",
    "Remove signing client credential",
]
_MANUAL_REQUIRED = {
    "release_environment_review": "Protected release environment and required reviewers were confirmed",
    "certificate_provenance_review": "Code-signing certificate provenance and custody were reviewed",
}


def build_signing_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a fail-closed signing and timestamp audit."""
    project = Path(root).resolve()
    readiness = _latest_json(project, ("build/**/signing-readiness.json", "desktop/release-evidence/signing-readiness.json"))
    candidate = _latest_json(
        project,
        (
            "build/**/signed-candidate*.json",
            "desktop/release-evidence/signed-candidate*.json",
            "desktop/release-evidence/*signature*.json",
        ),
    )
    workflow = project / ".github" / "workflows" / "desktop-signed-candidate.yml"
    checks = [
        _readiness_check(project, readiness),
        _signed_candidate_check(project, candidate),
        _timestamp_check(project, readiness, candidate),
        _workflow_contract_check(project, workflow),
        _workflow_success_check(project, candidate),
        _review_metadata_check(project, candidate),
        *_manual_checks(project, candidate or readiness),
    ]
    counts = _count_statuses(checks)
    sign_ready = _all_pass(checks, {"signing_readiness", "signed_candidate_artifacts"})
    timestamp_ready = _all_pass(checks, {"timestamp_configuration", "signed_candidate_artifacts"})
    workflow_ready = _all_pass(checks, {"protected_workflow_contract", "protected_workflow_success"}) and counts[MANUAL] == 0
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "windows_signing",
        "status": PASS if counts[BLOCKED] == 0 and counts[MANUAL] == 0 else BLOCKED,
        "sign_ready": sign_ready,
        "timestamp_ready": timestamp_ready,
        "workflow_ready": workflow_ready,
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
                _relative(project, readiness[1]) if readiness else None,
                _relative(project, candidate[1]) if candidate else None,
                _relative(project, workflow) if workflow.exists() else None,
            ]
            if item
        ],
    }


def format_signing_audit(report: dict[str, Any]) -> str:
    lines = [
        f"Status: {report['status']}",
        f"Sign ready: {str(report['sign_ready']).lower()}",
        f"Timestamp ready: {str(report['timestamp_ready']).lower()}",
        f"Workflow ready: {str(report['workflow_ready']).lower()}",
        f"Checks: {report['summary']['pass']} pass, {report['summary']['manual']} manual, {report['summary']['blocked']} blocked",
        "",
        "Checks:",
    ]
    for check in report["checks"]:
        lines.append(f"- {check['status'].upper()} [{check['id']}] {check['title']}: {check['summary']}")
    return "\n".join(lines)


def write_signing_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def gate_status(report: dict[str, Any], gate_id: str) -> dict[str, Any]:
    """Return a release-gates friendly result for SIGN-01/SIGN-02/REL-01."""
    checks = {check["id"]: check for check in report.get("checks", [])}
    if gate_id == "SIGN-01":
        relevant = ["signing_readiness", "signed_candidate_artifacts"]
        ready = report.get("sign_ready") is True
        title = "Real Authenticode signed candidate"
    elif gate_id == "SIGN-02":
        relevant = ["timestamp_configuration", "signed_candidate_artifacts"]
        ready = report.get("timestamp_ready") is True
        title = "RFC 3161 timestamp evidence"
    elif gate_id == "REL-01":
        relevant = [
            "protected_workflow_contract",
            "protected_workflow_success",
            "signing_review_metadata",
            "release_environment_review",
            "certificate_provenance_review",
        ]
        ready = report.get("workflow_ready") is True
        title = "Protected release workflow contract"
    else:
        raise ValueError(f"unknown signing gate: {gate_id}")
    open_checks = [item for item in relevant if checks.get(item, {}).get("status") != PASS]
    return {
        "title": title,
        "status": PASS if ready else BLOCKED,
        "summary": (
            f"Signing audit passed for {gate_id}."
            if ready
            else f"Signing audit is not release-ready for {gate_id}. Open checks: {', '.join(open_checks)}."
        ),
        "evidence": "; ".join(report.get("evidence_files") or []) or None,
        "open_checks": open_checks,
    }


def _readiness_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("signing_readiness", "Signing readiness evidence", False, "", "Signing readiness evidence is missing.", None)
    data, path = evidence
    blockers = data.get("blocker_codes") or []
    provider = data.get("provider")
    certificate = data.get("certificate") if isinstance(data.get("certificate"), dict) else {}
    missing: list[str] = []
    if data.get("ready") is not True:
        missing.append("ready=true")
    if blockers:
        missing.append("blocker_codes=[]")
    if provider not in {"digicert-keylocker", "microsoft-artifact-signing"}:
        missing.append("provider")
    if certificate.get("private_key_export_blocked") is not True:
        missing.append("certificate.private_key_export_blocked=true")
    ok = not missing
    return _check(
        "signing_readiness",
        "Signing readiness evidence",
        ok,
        "Signing readiness evidence has ready=true and no blockers.",
        f"Signing readiness is not ready: {', '.join([*blockers, *missing]) or 'unknown blockers'}.",
        _relative(root, path),
        {"provider": provider, "blocker_codes": blockers, "missing": missing},
    )


def _signed_candidate_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    marker = root / "desktop" / "release-evidence" / "SIGNED-CANDIDATE.txt"
    if not evidence and not marker.exists():
        return _check("signed_candidate_artifacts", "Signed candidate artifact verification", False, "", "Signed candidate verification evidence is missing.", None)
    data = evidence[0] if evidence else {}
    path = evidence[1] if evidence else marker
    artifacts = data.get("artifacts") if isinstance(data.get("artifacts"), list) else []
    if marker.exists() and not artifacts:
        return _check(
            "signed_candidate_artifacts",
            "Signed candidate artifact verification",
            False,
            "",
            "Signed-candidate marker exists, but per-artifact signature/timestamp verification JSON is missing.",
            _relative(root, marker),
        )
    missing = _candidate_metadata_missing(root, path.parent, data, artifacts)
    verified = [item for item in artifacts if isinstance(item, dict) and _artifact_valid(root, path.parent, item)]
    ok = not missing
    return _check(
        "signed_candidate_artifacts",
        "Signed candidate artifact verification",
        ok,
        f"All {len(verified)} signed candidate artifacts have valid signatures, timestamps, identities and hashes.",
        f"Signed candidate evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"artifacts": len(artifacts), "verified": len(verified), "missing": missing},
    )


def _timestamp_check(
    root: Path,
    readiness: tuple[dict[str, Any], Path] | None,
    candidate: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    readiness_ok = readiness is not None and readiness[0].get("timestamp", {}).get("rfc3161") is True
    artifacts = candidate[0].get("artifacts") if candidate and isinstance(candidate[0].get("artifacts"), list) else []
    evidence_dir = candidate[1].parent if candidate else root
    artifact_ok = bool(artifacts) and all(
        isinstance(item, dict)
        and item.get("timestamped") is True
        and not _retained_file_missing(root, evidence_dir, item, "timestamp_proof_path", "timestamp_proof_sha256")
        for item in artifacts
    )
    evidence_path = candidate[1] if candidate else readiness[1] if readiness else None
    return _check(
        "timestamp_configuration",
        "RFC 3161 timestamp configuration and artifact proof",
        readiness_ok and artifact_ok,
        "RFC 3161 timestamping is configured and all candidate artifacts are timestamped.",
        "Timestamp evidence must prove RFC 3161 configuration and timestamped signed artifacts.",
        _relative(root, evidence_path),
        {"readiness_rfc3161": readiness_ok, "timestamped_artifacts": artifact_ok},
    )


def _candidate_metadata_missing(root: Path, evidence_dir: Path, data: dict[str, Any], artifacts: list[Any]) -> list[str]:
    missing: list[str] = []
    if data.get("schema_version") != 2:
        missing.append("schema_version=2")
    if not _passish(data.get("status")):
        missing.append("status=pass")
    if data.get("signing_provider") not in {"digicert-keylocker", "microsoft-artifact-signing"}:
        missing.append("signing_provider")
    if data.get("private_key_export_blocked") is not True:
        missing.append("private_key_export_blocked=true")
    if not str(data.get("workflow_run_url") or "").startswith("https://github.com/"):
        missing.append("workflow_run_url")
    if not _is_commit(str(data.get("commit") or "")):
        missing.append("commit")
    if not isinstance(artifacts, list) or not artifacts:
        missing.append("artifacts[]")
        return missing
    names = [str(item.get("name") or "").lower() for item in artifacts if isinstance(item, dict)]
    for suffix in _REQUIRED_ARTIFACT_SUFFIXES:
        if not any(name.endswith(suffix) for name in names):
            missing.append(f"artifact{suffix}")
    invalid = []
    for index, item in enumerate(artifacts):
        if not isinstance(item, dict):
            invalid.append(f"artifact[{index}]")
            continue
        item_missing = _artifact_missing(root, evidence_dir, item)
        if item_missing:
            invalid.append(f"{item.get('name') or f'artifact[{index}]'}:{'/'.join(item_missing)}")
    if invalid:
        missing.append(f"invalid_artifacts={'; '.join(invalid[:6])}")
    return missing


def _artifact_missing(root: Path, evidence_dir: Path, item: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    name = str(item.get("name") or "")
    if not name.lower().endswith(_SIGNED_ARTIFACT_SUFFIXES):
        missing.append("name(.exe|.msi)")
    expected_sha = str(item.get("sha256") or "")
    if not _is_sha256(expected_sha):
        missing.append("sha256")
    artifact_path = _resolve_artifact_path(root, evidence_dir, name)
    if artifact_path is None:
        missing.append("retained_file_path")
    elif not artifact_path.is_file():
        missing.append("retained_file_exists")
    elif _is_sha256(expected_sha) and _sha256(artifact_path) != expected_sha.lower():
        missing.append("sha256_matches_file")
    if item.get("signature_status") != "Valid":
        missing.append("signature_status=Valid")
    if item.get("timestamped") is not True:
        missing.append("timestamped=true")
    missing.extend(_retained_file_missing(root, evidence_dir, item, "timestamp_proof_path", "timestamp_proof_sha256"))
    if not _non_empty(item.get("signer_subject")):
        missing.append("signer_subject")
    if not _thumbprint(str(item.get("signer_thumbprint") or "")):
        missing.append("signer_thumbprint")
    if not _non_empty(item.get("timestamp_subject")):
        missing.append("timestamp_subject")
    return missing


def _artifact_valid(root: Path, evidence_dir: Path, item: dict[str, Any]) -> bool:
    return not _artifact_missing(root, evidence_dir, item)


def _retained_file_missing(
    root: Path,
    evidence_dir: Path,
    item: dict[str, Any],
    path_field: str,
    sha_field: str,
) -> list[str]:
    missing: list[str] = []
    path_value = str(item.get(path_field) or "").strip()
    expected_sha = str(item.get(sha_field) or "").lower()
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


def _workflow_contract_check(root: Path, workflow: Path) -> dict[str, Any]:
    text = _read_text(workflow)
    missing = [item for item in _WORKFLOW_REQUIRED if item not in text]
    return _check(
        "protected_workflow_contract",
        "Protected signed-candidate workflow contract",
        workflow.exists() and not missing,
        "Protected signed-candidate workflow contains the cloud signer, environment, verification, upload and cleanup controls.",
        f"Signed-candidate workflow is missing required controls: {', '.join(missing) or 'workflow missing'}.",
        _relative(root, workflow) if workflow.exists() else None,
        {"missing": missing},
    )


def _workflow_success_check(root: Path, candidate: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    workflow_run = root / "desktop" / "release-evidence" / "workflow-run.txt"
    commit = root / "desktop" / "release-evidence" / "commit.txt"
    data = candidate[0] if candidate else {}
    run_url = str(data.get("workflow_run_url") or "").strip()
    commit_sha = str(data.get("commit") or "").strip()
    missing: list[str] = []
    if workflow_run.exists():
        run_url = workflow_run.read_text(encoding="utf-8", errors="ignore").strip()
    if commit.exists():
        commit_sha = commit.read_text(encoding="utf-8", errors="ignore").strip()
    if not run_url.startswith("https://github.com/"):
        missing.append("workflow_run_url")
    if not _is_commit(commit_sha):
        missing.append("commit")
    if not _non_empty(data.get("workflow_run_id")):
        missing.append("workflow_run_id")
    if data.get("protected_environment") != "desktop-release-candidate":
        missing.append("protected_environment=desktop-release-candidate")
    if data.get("required_reviewers_approved") is not True:
        missing.append("required_reviewers_approved=true")
    if data.get("signing_material_removed") is not True:
        missing.append("signing_material_removed=true")
    ok = not missing
    return _check(
        "protected_workflow_success",
        "Protected workflow successful-run evidence",
        ok,
        "Workflow run evidence proves the protected environment, required reviewer approval and signing-material cleanup.",
        f"Protected workflow success evidence is incomplete: {', '.join(missing)}.",
        _relative(root, workflow_run if workflow_run.exists() else candidate[1] if candidate else None),
        {
            "workflow_run_url": bool(run_url),
            "commit": commit_sha[:12] if commit_sha else None,
            "workflow_run_id": data.get("workflow_run_id"),
            "protected_environment": data.get("protected_environment"),
            "required_reviewers_approved": data.get("required_reviewers_approved"),
            "signing_material_removed": data.get("signing_material_removed"),
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
        status, missing = _manual_signing_status(check_id, value)
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": (
                    "Manual signing evidence accepted."
                    if status == PASS
                    else "Manual release-owner signing evidence is required."
                    if status == MANUAL
                    else f"Manual signing evidence is incomplete: {', '.join(missing)}."
                ),
                "evidence": _relative(root, path),
                "details": {"missing": missing},
            }
        )
    return checks


def _manual_signing_status(check_id: str, value: Any) -> tuple[str, list[str]]:
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
    if check_id == "release_environment_review":
        if value.get("protected_environment") != "desktop-release-candidate":
            missing.append("protected_environment=desktop-release-candidate")
        if value.get("required_reviewers_approved") is not True:
            missing.append("required_reviewers_approved=true")
        if value.get("workflow_run_reviewed") is not True:
            missing.append("workflow_run_reviewed=true")
        if value.get("signing_material_removed") is not True:
            missing.append("signing_material_removed=true")
    elif check_id == "certificate_provenance_review":
        if value.get("certificate_provenance_reviewed") is not True:
            missing.append("certificate_provenance_reviewed=true")
        if not _thumbprint(str(value.get("signer_thumbprint") or "")):
            missing.append("signer_thumbprint")
        if not _non_empty(value.get("custody_record")):
            missing.append("custody_record")
        if value.get("private_key_export_blocked") is not True:
            missing.append("private_key_export_blocked=true")
    return (PASS, []) if not missing else (BLOCKED, missing)


def _review_metadata_check(root: Path, candidate: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not candidate:
        return {
            "id": "signing_review_metadata",
            "title": "Signing release-owner review metadata",
            "status": MANUAL,
            "summary": "Structured signing review evidence is required.",
            "evidence": None,
        }
    data, path = candidate
    review = data.get("review") if isinstance(data.get("review"), dict) else {}
    artifacts = data.get("artifacts") if isinstance(data.get("artifacts"), list) else []
    missing: list[str] = []
    if not _non_empty(review.get("reviewer")):
        missing.append("review.reviewer")
    if not _timestamp(review.get("reviewed_at_utc")):
        missing.append("review.reviewed_at_utc")
    if review.get("workflow_run_id") != data.get("workflow_run_id"):
        missing.append("review.workflow_run_id_matches_candidate")
    if review.get("protected_environment") != "desktop-release-candidate":
        missing.append("review.protected_environment=desktop-release-candidate")
    if review.get("required_reviewers_approved") is not True:
        missing.append("review.required_reviewers_approved=true")
    if review.get("certificate_provenance_reviewed") is not True:
        missing.append("review.certificate_provenance_reviewed=true")
    if not _review_thumbprint_matches_artifacts(review, artifacts):
        missing.append("review.signer_thumbprint_matches_artifacts")
    if not _review_timestamp_matches_artifacts(review, artifacts):
        missing.append("review.timestamp_subject_matches_artifacts")
    return _check(
        "signing_review_metadata",
        "Signing release-owner review metadata",
        not missing,
        "Signing review metadata binds reviewer, protected environment, certificate provenance, workflow run and signed artifacts.",
        f"Signing review metadata is incomplete: {', '.join(missing)}.",
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
    return isinstance(value, str) and bool(value.strip())


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    normalized = value.strip().replace("Z", "+00:00")
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return True


def _review_thumbprint_matches_artifacts(review: dict[str, Any], artifacts: list[Any]) -> bool:
    reviewed = str(review.get("signer_thumbprint") or "")
    if not _thumbprint(reviewed):
        return False
    artifact_thumbprints = {
        str(item.get("signer_thumbprint") or "")
        for item in artifacts
        if isinstance(item, dict) and str(item.get("name") or "").lower().endswith(_SIGNED_ARTIFACT_SUFFIXES)
    }
    return bool(artifact_thumbprints) and artifact_thumbprints == {reviewed}


def _review_timestamp_matches_artifacts(review: dict[str, Any], artifacts: list[Any]) -> bool:
    reviewed = str(review.get("timestamp_subject") or "").strip()
    if not reviewed:
        return False
    artifact_subjects = {
        str(item.get("timestamp_subject") or "")
        for item in artifacts
        if isinstance(item, dict) and str(item.get("name") or "").lower().endswith(_SIGNED_ARTIFACT_SUFFIXES)
    }
    return bool(artifact_subjects) and artifact_subjects == {reviewed}


def _is_commit(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{7,40}", value))


def _is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value))


def _thumbprint(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{40,128}", value))


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
