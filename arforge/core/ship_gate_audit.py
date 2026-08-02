"""Final immutable artifact Ship Gate audit."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "pass"
BLOCKED = "blocked"
MANUAL = "manual"

_MANUAL_REQUIRED = {
    "release_owner_approval": "Release owner approved the immutable artifact set",
    "artifact_promotion_lock": "Promoted artifacts are immutable and cannot be replaced in-place",
    "rollback_plan_review": "Rollback and downgrade handling were reviewed",
    "docs_release_notes_review": "Release notes, user docs and known limitations were reviewed",
}

_REQUIRED_GATE_IDS = {"SIGN-01", "SIGN-02", "REL-01", "UPGRADE-01", "A11Y-01", "GOV-01", "STAGE-01"}


def build_ship_gate_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a fail-closed final release artifact audit."""
    project = Path(root).resolve()
    manifest = _load_json(project / "dist" / "release-manifest.json")
    approval = _latest_json(
        project,
        (
            "build/**/ship-gate*.json",
            "desktop/release-evidence/ship-gate*.json",
            "dist/ship-gate*.json",
        ),
    )
    checks = [
        _manifest_present_check(project, manifest),
        _manifest_schema_check(project, manifest),
        _source_clean_check(project, manifest),
        _artifact_hash_check(project, manifest),
        _lockfile_hash_check(project, manifest),
        _sbom_check(project, manifest),
        _approval_metadata_check(project, manifest, approval),
        _prior_gates_check(project, approval),
        _final_review_metadata_check(project, manifest, approval),
        *_manual_checks(project, approval),
    ]
    counts = _count_statuses(checks)
    release_gate_ready = counts[BLOCKED] == 0 and counts[MANUAL] == 0
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "final_ship_gate",
        "status": PASS if release_gate_ready else BLOCKED,
        "release_gate_ready": release_gate_ready,
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
                _relative(project, manifest[1]) if manifest else None,
                _relative(project, approval[1]) if approval else None,
            ]
            if item
        ],
    }


def format_ship_gate_audit(report: dict[str, Any]) -> str:
    lines = [
        f"Status: {report['status']}",
        f"Release gate ready: {str(report['release_gate_ready']).lower()}",
        f"Checks: {report['summary']['pass']} pass, {report['summary']['manual']} manual, {report['summary']['blocked']} blocked",
        "",
        "Checks:",
    ]
    for check in report["checks"]:
        lines.append(f"- {check['status'].upper()} [{check['id']}] {check['title']}: {check['summary']}")
    return "\n".join(lines)


def write_ship_gate_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def _manifest_present_check(root: Path, manifest: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    return _check(
        "release_manifest_present",
        "Release manifest exists",
        manifest is not None,
        "dist/release-manifest.json is present.",
        "dist/release-manifest.json is missing or unreadable.",
        _relative(root, manifest[1]) if manifest else None,
    )


def _manifest_schema_check(root: Path, manifest: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not manifest:
        return _check("release_manifest_schema", "Release manifest schema", False, "", "Release manifest is missing.", None)
    data, path = manifest
    files = data.get("files")
    source = data.get("source")
    lockfile = data.get("lockfile")
    ok = (
        data.get("schema_version") == 1
        and bool(data.get("product"))
        and bool(data.get("version"))
        and isinstance(files, list)
        and bool(files)
        and isinstance(source, dict)
        and _is_commit(str(source.get("commit") or ""))
        and isinstance(lockfile, dict)
        and bool(lockfile.get("name"))
        and _is_sha256(str(lockfile.get("sha256") or ""))
    )
    return _check(
        "release_manifest_schema",
        "Release manifest schema",
        ok,
        "Release manifest schema has product, version, source, files and lockfile metadata.",
        "Release manifest must include schema_version=1, product, version, source commit, files and lockfile metadata.",
        _relative(root, path),
    )


def _source_clean_check(root: Path, manifest: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not manifest:
        return _check("source_clean", "Manifest source tree was clean", False, "", "Release manifest is missing.", None)
    data, path = manifest
    clean = data.get("source", {}).get("dirty") is False
    return _check(
        "source_clean",
        "Manifest source tree was clean",
        clean,
        "Release manifest records a clean source tree.",
        "Release manifest was generated from a dirty source tree.",
        _relative(root, path),
    )


def _artifact_hash_check(root: Path, manifest: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not manifest:
        return _check("artifact_hashes", "Artifact hashes match manifest", False, "", "Release manifest is missing.", None)
    data, path = manifest
    artifact_root = path.parent
    failures: list[str] = []
    checked = 0
    for item in data.get("files") or []:
        name = str(item.get("name") or "")
        expected = str(item.get("sha256") or "")
        size = int(item.get("bytes") or -1)
        if not name or "/" in name or "\\" in name or not _is_sha256(expected):
            failures.append(name or "<missing-name>")
            continue
        artifact = artifact_root / name
        if not artifact.is_file() or _sha256(artifact) != expected or artifact.stat().st_size != size:
            failures.append(name)
            continue
        checked += 1
    ok = checked > 0 and not failures
    return _check(
        "artifact_hashes",
        "Artifact hashes match manifest",
        ok,
        f"All {checked} manifest artifacts exist and match SHA-256/size.",
        f"Artifact hash or size validation failed for: {', '.join(failures[:8]) or 'no artifacts checked'}.",
        _relative(root, path),
        {"checked": checked, "failures": failures[:20]},
    )


def _lockfile_hash_check(root: Path, manifest: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not manifest:
        return _check("release_lockfile_hash", "Release lockfile hash", False, "", "Release manifest is missing.", None)
    data, path = manifest
    lock = data.get("lockfile") or {}
    name = str(lock.get("name") or "")
    expected = str(lock.get("sha256") or "")
    lockfile = root / name
    ok = bool(name) and _is_sha256(expected) and lockfile.is_file() and _sha256(lockfile) == expected
    return _check(
        "release_lockfile_hash",
        "Release lockfile hash",
        ok,
        "Release lockfile exists and matches manifest hash.",
        "Release lockfile is missing or does not match manifest hash.",
        _relative(root, lockfile if lockfile.exists() else path),
    )


def _sbom_check(root: Path, manifest: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not manifest:
        return _check("sbom_present", "SBOM artifact present", False, "", "Release manifest is missing.", None)
    data, path = manifest
    sbom_items = [item for item in data.get("files") or [] if str(item.get("name") or "").endswith(".cdx.json")]
    ok = bool(sbom_items) and all((path.parent / str(item["name"])).is_file() for item in sbom_items)
    return _check(
        "sbom_present",
        "SBOM artifact present",
        ok,
        "CycloneDX SBOM artifact is included in the immutable manifest.",
        "CycloneDX SBOM artifact is missing from the manifest or dist directory.",
        _relative(root, path),
    )


def _prior_gates_check(root: Path, approval: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not approval:
        return _check("prior_gate_snapshot", "Prior release gates snapshot", False, "", "Final Ship Gate approval evidence is missing.", None)
    data, path = approval
    gates = data.get("prior_gates") or data.get("gates") or []
    passed = {str(item.get("id")) for item in gates if _passish(item.get("status"))}
    missing = sorted(_REQUIRED_GATE_IDS - passed)
    snapshot = data.get("prior_gate_snapshot") if isinstance(data.get("prior_gate_snapshot"), dict) else {}
    metadata_missing: list[str] = []
    if not _timestamp(snapshot.get("captured_at_utc")):
        metadata_missing.append("prior_gate_snapshot.captured_at_utc")
    if snapshot.get("artifact_set_id") != data.get("artifact_set_id"):
        metadata_missing.append("prior_gate_snapshot.artifact_set_id_matches_approval")
    if not _non_empty(snapshot.get("release_candidate_id")):
        metadata_missing.append("prior_gate_snapshot.release_candidate_id")
    if not _non_empty(snapshot.get("signed_candidate_workflow_run_id")):
        metadata_missing.append("prior_gate_snapshot.signed_candidate_workflow_run_id")
    if snapshot.get("verdict") != "READY_FOR_SHIP":
        metadata_missing.append("prior_gate_snapshot.verdict=READY_FOR_SHIP")
    gate_metadata_missing = _prior_gate_item_metadata_missing(root, gates)
    all_missing = [*missing, *metadata_missing, *gate_metadata_missing]
    return _check(
        "prior_gate_snapshot",
        "Prior release gates snapshot",
        not all_missing,
        "Final evidence contains a passing snapshot for all prior release gates.",
        f"Final evidence prior-gate snapshot is incomplete: {', '.join(all_missing)}.",
        _relative(root, path),
        {"missing": all_missing},
    )


def _approval_metadata_check(
    root: Path,
    manifest: tuple[dict[str, Any], Path] | None,
    approval: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    if not approval:
        return _check("final_approval_metadata", "Final approval metadata", False, "", "Final Ship Gate approval evidence is missing.", None)
    data, path = approval
    manifest_data = manifest[0] if manifest else {}
    manifest_path = manifest[1] if manifest else None
    missing: list[str] = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not _non_empty(data.get("approver")):
        missing.append("approver")
    if not _timestamp(data.get("approved_at_utc")):
        missing.append("approved_at_utc")
    if not _non_empty(data.get("release_channel")):
        missing.append("release_channel")
    if not _non_empty(data.get("artifact_set_id")):
        missing.append("artifact_set_id")
    expected_manifest_hash = _sha256(manifest_path) if manifest_path and manifest_path.is_file() else None
    if not expected_manifest_hash or data.get("release_manifest_sha256") != expected_manifest_hash:
        missing.append("release_manifest_sha256")
    if data.get("version") != manifest_data.get("version"):
        missing.append("version_matches_manifest")
    if data.get("source_commit") != manifest_data.get("source", {}).get("commit"):
        missing.append("source_commit_matches_manifest")
    ok = not missing
    return _check(
        "final_approval_metadata",
        "Final approval metadata",
        ok,
        "Final approval metadata binds approver, release channel and immutable manifest identity.",
        f"Final approval metadata is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"missing": missing},
    )


def _manual_checks(root: Path, approval: tuple[dict[str, Any], Path] | None) -> list[dict[str, Any]]:
    data = approval[0] if approval else None
    path = approval[1] if approval else None
    manual = data.get("manual_validation") if isinstance(data, dict) else None
    checks = []
    for check_id, title in _MANUAL_REQUIRED.items():
        value = manual.get(check_id) if isinstance(manual, dict) else None
        status, missing = _manual_ship_status(root, check_id, value, data if isinstance(data, dict) else {})
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": _manual_ship_summary(status, missing),
                "evidence": _relative(root, path),
                "details": {"missing": missing},
            }
        )
    return checks


def _manual_ship_status(root: Path, check_id: str, value: Any, approval: dict[str, Any]) -> tuple[str, list[str]]:
    if value is None:
        return MANUAL, ["manual_validation"]
    if not isinstance(value, dict):
        return BLOCKED, ["structured_object"]

    missing = _manual_common_missing(value)
    if check_id == "release_owner_approval":
        if value.get("release_owner_approval") is not True:
            missing.append("release_owner_approval=true")
        if not (_non_empty(value.get("approver")) or _non_empty(value.get("release_owner"))):
            missing.append("approver")
        if not _is_sha256(str(value.get("release_manifest_sha256") or "")):
            missing.append("release_manifest_sha256")
        elif str(value.get("release_manifest_sha256")).lower() != str(approval.get("release_manifest_sha256") or "").lower():
            missing.append("release_manifest_sha256_matches_approval")
        if not _manual_value_matches(value, approval, "artifact_set_id"):
            missing.append("artifact_set_id")
        if value.get("no_open_blocking_gates") is not True:
            missing.append("no_open_blocking_gates=true")
    elif check_id == "artifact_promotion_lock":
        if value.get("artifact_promotion_locked") is not True:
            missing.append("artifact_promotion_locked=true")
        if not _manual_value_matches(value, approval, "artifact_set_id"):
            missing.append("artifact_set_id")
        if not _non_empty(value.get("promotion_target")):
            missing.append("promotion_target")
        if value.get("immutable_storage") is not True and value.get("immutable_artifacts") is not True:
            missing.append("immutable_storage=true")
        if value.get("replace_in_place_blocked") is not True:
            missing.append("replace_in_place_blocked=true")
    elif check_id == "rollback_plan_review":
        if value.get("rollback_plan_reviewed") is not True:
            missing.append("rollback_plan_reviewed=true")
        if not _is_sha256(str(value.get("rollback_plan_sha256") or "")):
            missing.append("rollback_plan_sha256")
        missing.extend(_retained_evidence_file_missing(root, value, "rollback_plan_path", "rollback_plan_sha256"))
        if value.get("downgrade_or_rollback_path_reviewed") is not True:
            missing.append("downgrade_or_rollback_path_reviewed=true")
        if not _non_empty(value.get("rollback_owner")):
            missing.append("rollback_owner")
    elif check_id == "docs_release_notes_review":
        if value.get("docs_release_notes_reviewed") is not True:
            missing.append("docs_release_notes_reviewed=true")
        if not _is_sha256(str(value.get("release_notes_sha256") or "")):
            missing.append("release_notes_sha256")
        missing.extend(_retained_evidence_file_missing(root, value, "release_notes_path", "release_notes_sha256"))
        if value.get("known_limitations_reviewed") is not True:
            missing.append("known_limitations_reviewed=true")
        if value.get("user_docs_reviewed") is not True:
            missing.append("user_docs_reviewed=true")
    return (PASS if not missing else BLOCKED), missing


def _manual_common_missing(value: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if not _passish(value.get("status")):
        missing.append("status=pass")
    if not _non_empty(value.get("reviewer")):
        missing.append("reviewer")
    if not _timestamp(value.get("reviewed_at_utc")):
        missing.append("reviewed_at_utc")
    if not _non_empty(value.get("evidence")):
        missing.append("evidence")
    if not _non_empty(value.get("notes")):
        missing.append("notes")
    return missing


def _manual_value_matches(value: dict[str, Any], approval: dict[str, Any], field: str) -> bool:
    return _non_empty(value.get(field)) and str(value.get(field)).strip() == str(approval.get(field) or "").strip()


def _manual_ship_summary(status: str, missing: list[str]) -> str:
    if status == PASS:
        return "Structured manual final Ship Gate evidence accepted."
    if status == MANUAL:
        return "Structured manual final Ship Gate evidence is required."
    return f"Structured manual final Ship Gate evidence is incomplete: {', '.join(missing)}."


def _final_review_metadata_check(
    root: Path,
    manifest: tuple[dict[str, Any], Path] | None,
    approval: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    if not approval:
        return _check("final_review_metadata", "Final manual review metadata", False, "", "Final Ship Gate review metadata is missing.", None)
    data, path = approval
    review = data.get("review") if isinstance(data.get("review"), dict) else None
    if not review:
        return {
            "id": "final_review_metadata",
            "title": "Final manual review metadata",
            "status": MANUAL,
            "summary": "Structured final manual review metadata is required.",
            "evidence": _relative(root, path),
        }
    manifest_data = manifest[0] if manifest else {}
    manifest_path = manifest[1] if manifest else None
    snapshot = data.get("prior_gate_snapshot") if isinstance(data.get("prior_gate_snapshot"), dict) else {}
    missing: list[str] = []
    if not _non_empty(review.get("reviewer")):
        missing.append("reviewer")
    if not _timestamp(review.get("reviewed_at_utc")):
        missing.append("reviewed_at_utc")
    expected_manifest_hash = _sha256(manifest_path) if manifest_path and manifest_path.is_file() else None
    comparisons = {
        "release_manifest_sha256": expected_manifest_hash,
        "source_commit": manifest_data.get("source", {}).get("commit"),
        "version": manifest_data.get("version"),
        "release_channel": data.get("release_channel"),
        "artifact_set_id": data.get("artifact_set_id"),
        "prior_gate_snapshot_captured_at_utc": snapshot.get("captured_at_utc"),
        "release_candidate_id": snapshot.get("release_candidate_id"),
        "signed_candidate_workflow_run_id": snapshot.get("signed_candidate_workflow_run_id"),
    }
    for field, expected in comparisons.items():
        if not _non_empty(review.get(field)) or str(review.get(field)).strip() != str(expected or "").strip():
            missing.append(f"{field}=evidence")
    for field in (
        "release_owner_approval",
        "artifact_promotion_locked",
        "rollback_plan_reviewed",
        "docs_release_notes_reviewed",
        "known_limitations_reviewed",
        "no_open_blocking_gates",
    ):
        if review.get(field) is not True:
            missing.append(f"{field}=true")
    for field in ("rollback_plan_sha256", "release_notes_sha256"):
        if not _is_sha256(str(review.get(field) or "")):
            missing.append(field)
    missing.extend(_retained_evidence_file_missing(root, review, "rollback_plan_path", "rollback_plan_sha256"))
    missing.extend(_retained_evidence_file_missing(root, review, "release_notes_path", "release_notes_sha256"))
    ready = not missing
    return {
        "id": "final_review_metadata",
        "title": "Final manual review metadata",
        "status": PASS if ready else BLOCKED,
        "summary": "Final manual review metadata is bound to the immutable release package." if ready else f"Final manual review metadata is incomplete: {', '.join(missing)}.",
        "evidence": _relative(root, path),
        "details": {"missing": missing},
    }


def _prior_gate_item_metadata_missing(root: Path, gates: Any) -> list[str]:
    missing: list[str] = []
    if not isinstance(gates, list):
        return ["prior_gates[]"]
    for item in gates:
        if not isinstance(item, dict):
            missing.append("prior_gates[].object")
            continue
        gate_id = str(item.get("id") or "")
        if gate_id not in _REQUIRED_GATE_IDS:
            continue
        evidence_sha = str(item.get("evidence_sha256") or "")
        if not _is_sha256(evidence_sha):
            missing.append(f"{gate_id}.evidence_sha256")
        evidence_path = str(item.get("evidence_path") or "").strip()
        resolved = _resolve_relative(root, evidence_path)
        if not evidence_path:
            missing.append(f"{gate_id}.evidence_path")
        elif resolved is None or not resolved.is_file():
            missing.append(f"{gate_id}.evidence_path_exists")
        elif _is_sha256(evidence_sha) and _sha256(resolved) != evidence_sha.lower():
            missing.append(f"{gate_id}.evidence_sha256_matches_path")
        if not _timestamp(item.get("captured_at_utc")):
            missing.append(f"{gate_id}.captured_at_utc")
    return missing


def _retained_evidence_file_missing(
    root: Path,
    data: dict[str, Any],
    path_field: str,
    sha_field: str,
) -> list[str]:
    missing: list[str] = []
    evidence_path = str(data.get(path_field) or "").strip()
    expected_sha = str(data.get(sha_field) or "").lower()
    resolved = _resolve_relative(root, evidence_path)
    if not evidence_path:
        missing.append(path_field)
    elif resolved is None:
        missing.append(f"{path_field}_relative")
    elif not resolved.is_file():
        missing.append(f"{path_field}_exists")
    elif _is_sha256(expected_sha) and _sha256(resolved) != expected_sha:
        missing.append(f"{sha_field}_matches_path")
    return missing


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


def _load_json(path: Path) -> tuple[dict[str, Any], Path] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return None
    return (data, path) if isinstance(data, dict) else None


def _latest_json(root: Path, patterns: tuple[str, ...]) -> tuple[dict[str, Any], Path] | None:
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(path for path in root.glob(pattern) if path.is_file())
    for path in sorted(matches, key=lambda item: item.stat().st_mtime, reverse=True):
        loaded = _load_json(path)
        if loaded:
            return loaded
    return None


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


def _is_commit(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{7,40}", value))


def _is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _count_statuses(checks: list[dict[str, Any]]) -> dict[str, int]:
    return {
        PASS: sum(1 for check in checks if check["status"] == PASS),
        MANUAL: sum(1 for check in checks if check["status"] == MANUAL),
        BLOCKED: sum(1 for check in checks if check["status"] == BLOCKED),
    }


def _relative(root: Path, path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _resolve_relative(root: Path, value: str) -> Path | None:
    if not value or Path(value).is_absolute() or ".." in Path(value).parts:
        return None
    return root / value
