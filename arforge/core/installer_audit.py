"""Windows Desktop installer lifecycle release audit."""

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
    "npm run tauri build -- --bundles nsis,msi",
    "scripts/verify_desktop_nsis.ps1",
    "scripts/verify_desktop_installer.ps1",
    "actions/upload-artifact@v4",
    "desktop/release-evidence",
]
_MANUAL_REQUIRED = {
    "protected_runner_review": "Protected elevated Windows runner and UAC context were reviewed",
    "installer_log_review": "MSI verbose install/uninstall logs were reviewed",
}


def build_installer_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a fail-closed installer lifecycle audit for INSTALLER-01."""
    project = Path(root).resolve()
    msi = _latest_json(
        project,
        (
            "build/**/desktop-installer-evidence.json",
            "desktop/release-evidence/desktop-installer-evidence.json",
        ),
    )
    nsis = _latest_json(
        project,
        (
            "build/**/desktop-nsis-evidence.json",
            "desktop/release-evidence/desktop-nsis-evidence.json",
        ),
    )
    workflow = project / ".github" / "workflows" / "desktop-package.yml"
    signed_workflow = project / ".github" / "workflows" / "desktop-signed-candidate.yml"
    checks = [
        _workflow_contract_check(project, workflow, signed_workflow),
        _msi_lifecycle_check(project, msi),
        _msi_logs_check(project, msi),
        _artifact_manifest_check(project, msi),
        _nsis_lifecycle_check(project, nsis),
        _review_metadata_check(project, msi or nsis),
        *_manual_checks(project, msi or nsis),
    ]
    counts = _count_statuses(checks)
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "desktop_installer_lifecycle",
        "status": PASS if counts[BLOCKED] == 0 and counts[MANUAL] == 0 else BLOCKED,
        "installer_ready": _all_pass(checks, {"installer_workflow_contract", "msi_lifecycle", "msi_verbose_logs", "installer_artifacts"}),
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
                _relative(project, msi[1]) if msi else None,
                _relative(project, nsis[1]) if nsis else None,
                _relative(project, workflow) if workflow.exists() else None,
                _relative(project, signed_workflow) if signed_workflow.exists() else None,
            ]
            if item
        ],
    }


def format_installer_audit(report: dict[str, Any]) -> str:
    lines = [
        f"Status: {report['status']}",
        f"Installer ready: {str(report['installer_ready']).lower()}",
        f"Release gate ready: {str(report['release_gate_ready']).lower()}",
        f"Checks: {report['summary']['pass']} pass, {report['summary']['manual']} manual, {report['summary']['blocked']} blocked",
        "",
        "Checks:",
    ]
    for check in report["checks"]:
        lines.append(f"- {check['status'].upper()} [{check['id']}] {check['title']}: {check['summary']}")
    return "\n".join(lines)


def write_installer_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def _workflow_contract_check(root: Path, workflow: Path, signed_workflow: Path) -> dict[str, Any]:
    text = "\n".join([_read_text(workflow), _read_text(signed_workflow)])
    missing = [item for item in _WORKFLOW_REQUIRED if item not in text]
    return _check(
        "installer_workflow_contract",
        "Desktop installer workflow contract",
        workflow.exists() and signed_workflow.exists() and not missing,
        "Desktop workflows build NSIS/MSI, verify installer lifecycle and upload release evidence.",
        f"Installer workflows are missing required controls: {', '.join(missing) or 'workflow missing'}.",
        "; ".join(item for item in [_relative(root, workflow), _relative(root, signed_workflow)] if item),
        {"missing": missing},
    )


def _msi_lifecycle_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("msi_lifecycle", "Elevated all-users MSI lifecycle", False, "", "Desktop MSI lifecycle evidence is missing.", None)
    data, path = evidence
    missing = _msi_missing(root, path.parent, data)
    return _check(
        "msi_lifecycle",
        "Elevated all-users MSI lifecycle",
        not missing,
        "MSI evidence proves elevated all-users install/start/sidecar/uninstall/profile lifecycle.",
        f"MSI lifecycle evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"missing": missing},
    )


def _msi_logs_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("msi_verbose_logs", "MSI verbose logs retained", False, "", "Desktop MSI lifecycle evidence is missing.", None)
    _data, path = evidence
    install_log = path.parent / "msi-install.log"
    uninstall_log = path.parent / "msi-uninstall.log"
    ok = install_log.is_file() and install_log.stat().st_size > 0 and uninstall_log.is_file() and uninstall_log.stat().st_size > 0
    return _check(
        "msi_verbose_logs",
        "MSI verbose logs retained",
        ok,
        "MSI install and uninstall verbose logs are retained.",
        "MSI install/uninstall verbose logs are missing or empty.",
        _relative(root, path.parent),
        {"install_log": install_log.name, "uninstall_log": uninstall_log.name},
    )


def _artifact_manifest_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("installer_artifacts", "Installer artifact manifest", False, "", "Desktop MSI lifecycle evidence is missing.", None)
    data, path = evidence
    artifacts = data.get("artifacts") if isinstance(data.get("artifacts"), list) else []
    missing: list[str] = []
    names = [str(item.get("path") or "").lower() for item in artifacts if isinstance(item, dict)]
    if not any(name.endswith(".msi") for name in names):
        missing.append("artifact.msi")
    if not any(name.endswith(".exe") for name in names):
        missing.append("artifact.exe")
    for index, item in enumerate(artifacts):
        if not isinstance(item, dict):
            missing.append(f"artifact[{index}]")
            continue
        if not _non_empty(item.get("path")):
            missing.append(f"artifact[{index}].path")
        if int(item.get("size_bytes") or 0) <= 0:
            missing.append(f"{item.get('path') or f'artifact[{index}]'}.size_bytes")
        expected_sha = str(item.get("sha256") or "")
        if not _is_sha256(expected_sha):
            missing.append(f"{item.get('path') or f'artifact[{index}]'}.sha256")
            continue
        artifact_path = _resolve_evidence_path(root, path.parent, str(item.get("path") or ""))
        if artifact_path is None:
            missing.append(f"{item.get('path') or f'artifact[{index}]'}.path_relative")
            continue
        if not artifact_path.is_file():
            missing.append(f"{item.get('path') or f'artifact[{index}]'}.exists")
            continue
        if artifact_path.stat().st_size != int(item.get("size_bytes") or 0):
            missing.append(f"{item.get('path') or f'artifact[{index}]'}.size_matches_file")
        if _sha256(artifact_path) != expected_sha.lower():
            missing.append(f"{item.get('path') or f'artifact[{index}]'}.sha256_matches_file")
    return _check(
        "installer_artifacts",
        "Installer artifact manifest",
        not missing,
        "Installer evidence contains MSI/NSIS artifact names, sizes and SHA-256 values bound to retained files.",
        f"Installer artifact evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"artifacts": len(artifacts), "missing": missing},
    )


def _nsis_lifecycle_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("nsis_lifecycle", "NSIS current-user lifecycle", False, "", "Desktop NSIS lifecycle evidence is missing.", None)
    data, path = evidence
    installer = data.get("installer") if isinstance(data.get("installer"), dict) else {}
    missing = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not _exit_ok(installer.get("install_exit_code")):
        missing.append("installer.install_exit_code")
    if not _exit_ok(installer.get("uninstall_exit_code")):
        missing.append("installer.uninstall_exit_code")
    if not _is_sha256(str(installer.get("sha256") or "")):
        missing.append("installer.sha256")
    if data.get("sidecar_started") is not True:
        missing.append("sidecar_started=true")
    if data.get("profile_preserved_after_uninstall") is not True:
        missing.append("profile_preserved_after_uninstall=true")
    if not _is_sha256(str(data.get("profile_marker_sha256") or "")):
        missing.append("profile_marker_sha256")
    missing.extend(_retained_evidence_file_missing(root, path.parent, data, "profile_marker_path", "profile_marker_sha256"))
    ok = not missing
    return _check(
        "nsis_lifecycle",
        "NSIS current-user lifecycle",
        ok,
        "NSIS evidence proves install/start/sidecar/uninstall/profile lifecycle.",
        f"NSIS evidence must prove install/uninstall, sidecar startup and profile preservation: {', '.join(missing)}.",
        _relative(root, path),
        {"missing": missing},
    )


def _manual_checks(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> list[dict[str, Any]]:
    data = evidence[0] if evidence else None
    path = evidence[1] if evidence else None
    manual = data.get("manual_validation") if isinstance(data, dict) else None
    checks = []
    for check_id, title in _MANUAL_REQUIRED.items():
        value = manual.get(check_id) if isinstance(manual, dict) else None
        status, missing = _manual_installer_status(check_id, value)
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": (
                    "Manual installer lifecycle evidence accepted."
                    if status == PASS
                    else "Manual release-owner installer evidence is required."
                    if status == MANUAL
                    else f"Manual installer evidence is incomplete: {', '.join(missing)}."
                ),
                "evidence": _relative(root, path),
                "details": {"missing": missing},
            }
        )
    return checks


def _manual_installer_status(check_id: str, value: Any) -> tuple[str, list[str]]:
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
    if check_id == "protected_runner_review":
        if not _non_empty(value.get("protected_runner")):
            missing.append("protected_runner")
        if value.get("uac_elevated") is not True:
            missing.append("uac_elevated=true")
        if value.get("all_users_msi") is not True:
            missing.append("all_users_msi=true")
        if value.get("program_files_install_reviewed") is not True:
            missing.append("program_files_install_reviewed=true")
    elif check_id == "installer_log_review":
        log_hashes = value.get("log_sha256") if isinstance(value.get("log_sha256"), dict) else {}
        for log_name in ("msi-install.log", "msi-uninstall.log"):
            if not _is_sha256(str(log_hashes.get(log_name) or "")):
                missing.append(f"log_sha256.{log_name}")
        if value.get("install_log_reviewed") is not True:
            missing.append("install_log_reviewed=true")
        if value.get("uninstall_log_reviewed") is not True:
            missing.append("uninstall_log_reviewed=true")
    return (PASS, []) if not missing else (BLOCKED, missing)


def _review_metadata_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return {
            "id": "installer_review_metadata",
            "title": "Installer release-owner review metadata",
            "status": MANUAL,
            "summary": "Structured installer review evidence is required.",
            "evidence": None,
        }
    data, path = evidence
    review = data.get("review") if isinstance(data.get("review"), dict) else {}
    missing: list[str] = []
    if not _non_empty(review.get("reviewer")):
        missing.append("review.reviewer")
    if not _timestamp(review.get("reviewed_at_utc")):
        missing.append("review.reviewed_at_utc")
    if not _non_empty(review.get("protected_runner")):
        missing.append("review.protected_runner")
    if review.get("uac_elevated") is not True:
        missing.append("review.uac_elevated=true")
    if review.get("all_users_msi") is not True:
        missing.append("review.all_users_msi=true")
    if not _artifact_review_matches(data, ".msi"):
        missing.append("review.msi_artifact_sha256")
    if not _artifact_review_matches(data, ".exe"):
        missing.append("review.nsis_artifact_sha256")
    log_hashes = review.get("log_sha256") if isinstance(review.get("log_sha256"), dict) else {}
    for log_name in ("msi-install.log", "msi-uninstall.log"):
        log_path = path.parent / log_name
        expected = str(log_hashes.get(log_name) or "")
        if not log_path.is_file() or not _is_sha256(expected) or _sha256(log_path) != expected:
            missing.append(f"review.log_sha256.{log_name}")
    return _check(
        "installer_review_metadata",
        "Installer release-owner review metadata",
        not missing,
        "Installer review metadata binds reviewer, protected runner, artifacts and MSI verbose logs.",
        f"Installer review metadata is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"missing": missing},
    )


def _msi_missing(root: Path, evidence_dir: Path, data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if int(data.get("schema_version") or 0) < 3:
        missing.append("schema_version>=3")
    if not _exit_ok(data.get("installer_exit_code")):
        missing.append("installer_exit_code")
    if not _exit_ok(data.get("uninstaller_exit_code")):
        missing.append("uninstaller_exit_code")
    if "program files" not in str(data.get("installed_app") or "").lower():
        missing.append("installed_app=Program Files")
    if "program files" not in str(data.get("installed_sidecar") or "").lower():
        missing.append("installed_sidecar=Program Files")
    scope = data.get("install_scope_contract") if isinstance(data.get("install_scope_contract"), dict) else {}
    if scope.get("action") != "ForceArforgePerMachineInstallDir":
        missing.append("install_scope_contract.action")
    if scope.get("property") != "INSTALLDIR":
        missing.append("install_scope_contract.property")
    if scope.get("target") != "[ProgramFiles64Folder]Arforge Agent":
        missing.append("install_scope_contract.target")
    if scope.get("installed_under_program_files") is not True:
        missing.append("installed_under_program_files=true")
    if data.get("sidecar_started") is not True:
        missing.append("sidecar_started=true")
    if data.get("profile_preserved_after_uninstall") is not True:
        missing.append("profile_preserved_after_uninstall=true")
    if not _is_sha256(str(data.get("profile_marker_sha256") or "")):
        missing.append("profile_marker_sha256")
    missing.extend(_retained_evidence_file_missing(root, evidence_dir, data, "profile_marker_path", "profile_marker_sha256"))
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
    resolved = _resolve_evidence_path(root, evidence_dir, path_value)
    if resolved is None:
        missing.append(f"{path_field}_relative")
    elif not resolved.is_file():
        missing.append(f"{path_field}_exists")
    elif _is_sha256(expected_sha) and _sha256(resolved) != expected_sha:
        missing.append(f"{sha_field}_matches_file")
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


def _exit_ok(value: Any) -> bool:
    return value in {0, 3010}


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


def _is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value))


def _artifact_review_matches(data: dict[str, Any], suffix: str) -> bool:
    review = data.get("review") if isinstance(data.get("review"), dict) else {}
    reviewed = review.get("artifact_sha256") if isinstance(review.get("artifact_sha256"), dict) else {}
    artifacts = data.get("artifacts") if isinstance(data.get("artifacts"), list) else []
    expected = str(reviewed.get(suffix.lstrip(".")) or "").lower()
    if not _is_sha256(expected):
        return False
    return any(
        isinstance(item, dict)
        and str(item.get("path") or "").lower().endswith(suffix)
        and str(item.get("sha256") or "").lower() == expected
        for item in artifacts
    )


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


def _resolve_evidence_path(root: Path, evidence_dir: Path, value: str) -> Path | None:
    normalized = value.replace("\\", "/").strip()
    if not normalized:
        return None
    relative = Path(normalized)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    for base in (root, evidence_dir):
        candidate = (base / relative).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if candidate.exists():
            return candidate
    return (evidence_dir / relative).resolve()
