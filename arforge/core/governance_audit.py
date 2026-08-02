"""Credential, database and Git governance release audit."""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "pass"
BLOCKED = "blocked"
MANUAL = "manual"

_SECRET_PATTERNS = {
    "openai_style": rb"\bsk-[A-Za-z0-9_-]{20,}",
    "github_token": rb"\bghp_[A-Za-z0-9]{36}\b",
    "aws_access_key": rb"\bAKIA[0-9A-Z]{16}\b",
    "database_url": rb"(?i)\b(?:postgresql|postgres|mysql)://[^\s:/]+:[^@\s]+@",
}

_SKIP_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
}

_MANUAL_REQUIRED = {
    "credential_rotation": "Production/API/database credentials have been rotated or explicitly invalidated",
    "external_copies_review": "External copies, backups and release secrets have been reviewed",
    "protected_remote_review": "Remote, branch protection and release environment were reviewed",
    "legacy_files_decision": "Legacy/anomalous root files have explicit keep/remove decisions",
}


def build_governance_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a fail-closed governance audit for GOV-01."""
    project = Path(root).resolve()
    restore_evidence = _latest_json(project, ("build/**/postgres*restore*.json", "desktop/release-evidence/postgres*restore*.json"))
    credential_evidence = _latest_json(
        project,
        (
            "build/**/credential*cleanup*.json",
            "build/**/credential*rotation*.json",
            "desktop/release-evidence/credential*cleanup*.json",
            "desktop/release-evidence/credential*rotation*.json",
        ),
    )
    checks = [
        _git_repository_check(project),
        _git_status_check(project),
        _git_remote_check(project),
        _root_anomaly_check(project),
        _secret_scan_check(project),
        _postgres_restore_check(project, restore_evidence),
        _governance_evidence_metadata_check(project, credential_evidence),
        *_manual_credential_checks(project, credential_evidence),
    ]
    counts = _count_statuses(checks)
    release_gate_ready = counts[BLOCKED] == 0 and counts[MANUAL] == 0
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "governance",
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
            path
            for path in [
                _relative(project, restore_evidence[1]) if restore_evidence else None,
                _relative(project, credential_evidence[1]) if credential_evidence else None,
            ]
            if path
        ],
    }


def format_governance_audit(report: dict[str, Any]) -> str:
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


def write_governance_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def _git_repository_check(root: Path) -> dict[str, Any]:
    inside = _git(root, ["rev-parse", "--is-inside-work-tree"]).strip() == "true"
    head = _git(root, ["rev-parse", "--short", "HEAD"]).strip()
    return _check(
        "git_repository",
        "Git repository exists",
        inside,
        f"Git repository is available at {head or 'unknown HEAD'}.",
        "Release governance requires a Git repository.",
        None,
    )


def _git_status_check(root: Path) -> dict[str, Any]:
    status = _git(root, ["status", "--short"])
    changed = [line for line in status.splitlines() if line.strip()]
    return _check(
        "git_clean_baseline",
        "Reviewed clean release baseline",
        not changed,
        "Working tree is clean.",
        f"Working tree has {len(changed)} changed entries.",
        None,
        {"changed_entries": len(changed), "sample": changed[:20]},
    )


def _git_remote_check(root: Path) -> dict[str, Any]:
    remotes = [line.strip() for line in _git(root, ["remote"]).splitlines() if line.strip()]
    return _check(
        "git_remote",
        "Reviewed Git remote exists",
        bool(remotes),
        f"Configured Git remotes: {', '.join(remotes)}.",
        "No Git remote is configured.",
        None,
        {"remotes": remotes},
    )


def _root_anomaly_check(root: Path) -> dict[str, Any]:
    status = _git(root, ["status", "--short"])
    root_untracked = []
    for line in status.splitlines():
        if not line.startswith("?? "):
            continue
        path = line[3:].strip().replace("\\", "/")
        if "/" not in path:
            root_untracked.append(path)
    return _check(
        "root_anomalies",
        "Anomalous root files reviewed",
        not root_untracked,
        "No untracked root-level files are present.",
        f"Untracked root-level files require keep/remove decisions: {', '.join(root_untracked[:12])}.",
        None,
        {"untracked_root_files": root_untracked[:50]},
    )


def _secret_scan_check(root: Path) -> dict[str, Any]:
    result = _scan_repository_secrets(root)
    return _check(
        "repository_secret_scan",
        "Repository secret-pattern scan",
        not result["findings"],
        f"No credential patterns found in {result['files_scanned']} scanned files.",
        f"Credential-like patterns found in {len(result['findings'])} files.",
        None,
        result,
    )


def _postgres_restore_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check(
            "postgres_restore_drill",
            "Isolated PostgreSQL restore drill",
            False,
            "",
            "No PostgreSQL restore evidence file was found.",
            None,
        )
    data, path = evidence
    missing = _postgres_restore_missing(root, path.parent, data)
    ready = not missing
    return _check(
        "postgres_restore_drill",
        "Isolated PostgreSQL restore drill",
        ready,
        "PostgreSQL restore evidence proves isolated restore, backup identity, schema/table counts and representative record comparison.",
        f"PostgreSQL evidence exists but is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"status": data.get("status"), "missing": missing},
    )


def _manual_credential_checks(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> list[dict[str, Any]]:
    data = evidence[0] if evidence else None
    path = evidence[1] if evidence else None
    manual = data.get("manual_validation") if isinstance(data, dict) else None
    checks = []
    for check_id, title in _MANUAL_REQUIRED.items():
        value = manual.get(check_id) if isinstance(manual, dict) else None
        status, missing = _manual_governance_status(root, path.parent if path else root, check_id, value)
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": (
                    "Manual governance evidence accepted."
                    if status == PASS
                    else "Manual release-owner governance evidence is required."
                    if status == MANUAL
                    else f"Manual governance evidence is incomplete: {', '.join(missing)}."
                ),
                "evidence": _relative(root, path),
                "details": {"missing": missing},
            }
        )
    return checks


def _manual_governance_status(root: Path, evidence_dir: Path, check_id: str, value: Any) -> tuple[str, list[str]]:
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
    missing.extend(_retained_evidence_file_missing(root, evidence_dir, value, "evidence_path", "evidence_sha256"))
    if check_id == "credential_rotation":
        if value.get("production_credentials_rotated") is not True and value.get("production_credentials_invalidated") is not True:
            missing.append("production_credentials_rotated_or_invalidated=true")
        if not _non_empty(value.get("rotation_ticket")):
            missing.append("rotation_ticket")
    elif check_id == "external_copies_review":
        if value.get("external_copies_reviewed") is not True:
            missing.append("external_copies_reviewed=true")
        if value.get("untracked_release_secrets") is not False:
            missing.append("untracked_release_secrets=false")
    elif check_id == "protected_remote_review":
        if value.get("branch_protection_verified") is not True:
            missing.append("branch_protection_verified=true")
        if value.get("release_environment_reviewed") is not True:
            missing.append("release_environment_reviewed=true")
    elif check_id == "legacy_files_decision":
        if value.get("root_anomalies_reviewed") is not True:
            missing.append("root_anomalies_reviewed=true")
        decisions = value.get("decisions")
        if not isinstance(decisions, list):
            missing.append("decisions[]")
        elif not all(isinstance(item, dict) and _non_empty(item.get("path")) and str(item.get("decision") or "") in {"keep", "remove"} for item in decisions):
            missing.append("decisions[].path/decision")
    return (PASS, []) if not missing else (BLOCKED, missing)


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
    resolved = _resolve_governance_evidence_path(root, evidence_dir, path_value)
    if resolved is None:
        missing.append(f"{path_field}_relative")
    elif not resolved.is_file():
        missing.append(f"{path_field}_exists")
    elif _is_sha256(expected_sha) and _sha256(resolved) != expected_sha:
        missing.append(f"{sha_field}_matches_file")
    return missing


def _governance_evidence_metadata_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return {
            "id": "governance_evidence_metadata",
            "title": "Governance evidence package metadata",
            "status": MANUAL,
            "summary": "Structured governance evidence package is required.",
            "evidence": None,
        }
    data, path = evidence
    missing: list[str] = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not _non_empty(data.get("reviewer")):
        missing.append("reviewer")
    if not _timestamp(data.get("reviewed_at_utc")):
        missing.append("reviewed_at_utc")
    if not _is_commit(str(data.get("source_commit") or "")):
        missing.append("source_commit")
    remote_url = str(data.get("remote_url") or "").strip()
    remote_urls = _git_remote_urls(root)
    if not remote_url:
        missing.append("remote_url")
    elif remote_urls and remote_url not in remote_urls:
        missing.append("remote_url_matches_git_remote")
    branch = data.get("branch_protection") if isinstance(data.get("branch_protection"), dict) else {}
    if branch.get("reviewed") is not True:
        missing.append("branch_protection.reviewed=true")
    if not _non_empty(branch.get("branch")):
        missing.append("branch_protection.branch")
    release_environment = data.get("release_environment") if isinstance(data.get("release_environment"), dict) else {}
    if release_environment.get("name") != "desktop-release-candidate":
        missing.append("release_environment.name=desktop-release-candidate")
    if release_environment.get("required_reviewers") is not True:
        missing.append("release_environment.required_reviewers=true")
    if release_environment.get("secrets_reviewed") is not True:
        missing.append("release_environment.secrets_reviewed=true")
    ok = not missing
    return _check(
        "governance_evidence_metadata",
        "Governance evidence package metadata",
        ok,
        "Governance evidence identifies reviewer, reviewed commit, remote, branch protection and release environment review.",
        f"Governance evidence metadata is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"missing": missing},
    )


def _postgres_restore_missing(root: Path, evidence_dir: Path, data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not (_passish(data.get("status")) or data.get("restore_drill") is True):
        missing.append("status=pass")
    if not (data.get("target_isolated") is True or data.get("isolated") is True or data.get("isolated_restore") is True):
        missing.append("target_isolated=true")
    backup = data.get("backup") if isinstance(data.get("backup"), dict) else {}
    if not _non_empty(backup.get("name")):
        missing.append("backup.name")
    expected_sha = str(backup.get("sha256") or "")
    if not _is_sha256(expected_sha):
        missing.append("backup.sha256")
    backup_path = _resolve_backup_path(root, evidence_dir, str(backup.get("name") or ""))
    if backup_path is None:
        missing.append("backup.path_relative")
    elif not backup_path.is_file():
        missing.append("backup.file_exists")
    elif _is_sha256(expected_sha) and _sha256(backup_path) != expected_sha.lower():
        missing.append("backup.sha256_matches_file")
    restore = data.get("restore") if isinstance(data.get("restore"), dict) else {}
    if not _timestamp(restore.get("completed_at_utc") or data.get("restored_at_utc")):
        missing.append("restore.completed_at_utc")
    if not _non_empty(restore.get("target_database") or data.get("target_database")):
        missing.append("restore.target_database")
    if data.get("catalog_verified") is not True:
        missing.append("catalog_verified=true")
    if data.get("schema_match") is not True:
        missing.append("schema_match=true")
    if not (data.get("table_counts_match") is True or data.get("record_counts_match") is True):
        missing.append("table_counts_match=true")
    tables = data.get("tables")
    if not _tables_match(tables):
        missing.append("tables[].source_count/restored_count")
    if data.get("representative_records_match") is not True and data.get("sampled_records_match") is not True:
        missing.append("representative_records_match=true")
    if data.get("destructive_target") is True:
        missing.append("destructive_target=false")
    return missing


def _tables_match(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    for item in value:
        if not isinstance(item, dict) or not _non_empty(item.get("name")):
            return False
        if item.get("source_count") != item.get("restored_count"):
            return False
    return True


def _scan_repository_secrets(root: Path, *, max_file_bytes: int = 512 * 1024) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    skipped: list[str] = []
    scanned = 0
    if not root.exists():
        return {"files_scanned": 0, "findings": [], "skipped": []}
    for path in root.rglob("*"):
        if not path.is_file() or any(part in _SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        relative = path.relative_to(root).as_posix()
        if path.stat().st_size > max_file_bytes:
            skipped.append(relative)
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        scanned += 1
        categories = {
            name: len(re.findall(pattern, data))
            for name, pattern in _SECRET_PATTERNS.items()
            if re.search(pattern, data)
        }
        if categories:
            findings.append({"path": relative, "categories": categories})
    return {"files_scanned": scanned, "findings": findings[:50], "skipped": skipped[:50]}


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


def _is_commit(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{7,40}", value))


def _resolve_backup_path(root: Path, evidence_dir: Path, value: str) -> Path | None:
    normalized = value.replace("\\", "/").strip()
    if not normalized:
        return None
    relative = Path(normalized)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    for base in (evidence_dir, root / "backups", root):
        candidate = (base / relative).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if candidate.exists():
            return candidate
    return (evidence_dir / relative).resolve()


def _resolve_governance_evidence_path(root: Path, evidence_dir: Path, value: str) -> Path | None:
    normalized = value.replace("\\", "/").strip()
    if not normalized:
        return None
    relative = Path(normalized)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    for base in (evidence_dir, root):
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


def _count_statuses(checks: list[dict[str, Any]]) -> dict[str, int]:
    return {
        PASS: sum(1 for check in checks if check["status"] == PASS),
        MANUAL: sum(1 for check in checks if check["status"] == MANUAL),
        BLOCKED: sum(1 for check in checks if check["status"] == BLOCKED),
    }


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


def _git_remote_urls(root: Path) -> list[str]:
    urls: list[str] = []
    for remote in [line.strip() for line in _git(root, ["remote"]).splitlines() if line.strip()]:
        url = _git(root, ["remote", "get-url", remote]).strip()
        if url:
            urls.append(url)
    return urls


def _relative(root: Path, path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)
