"""Desktop accessibility preflight and release evidence contract."""

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
    "keyboard_navigation": "Keyboard-only navigation and focus order",
    "screen_reader": "Screen reader names, roles and state",
    "scaling_125": "Windows display scaling at 125 percent",
    "scaling_150": "Windows display scaling at 150 percent",
    "scaling_200": "Windows display scaling at 200 percent",
}
_SCALING_REQUIRED = {125, 150, 200}


def build_desktop_accessibility_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a conservative Desktop accessibility audit."""
    project = Path(root).resolve()
    app = project / "desktop" / "src" / "App.tsx"
    styles = project / "desktop" / "src" / "styles.css"
    app_text = _read_text(app)
    style_text = _read_text(styles)
    manual_evidence = _latest_manual_evidence(project)
    signed_candidate = _latest_signed_candidate_evidence(project)
    manual_data = manual_evidence[0] if manual_evidence else None
    manual_checks = [
        _manual_metadata_check(
            project,
            manual_data,
            manual_evidence[1] if manual_evidence else None,
            signed_candidate,
        )
    ]
    manual_checks.extend(
        _manual_checks(
            project,
            manual_data,
            manual_evidence[1] if manual_evidence else None,
        )
    )
    source_checks = [
        _check(
            "desktop_source_present",
            "Desktop source files exist",
            bool(app_text and style_text),
            "desktop/src/App.tsx and desktop/src/styles.css are required for source accessibility preflight.",
            _paths(project, [app, styles]),
        ),
        _check(
            "skip_link",
            "Skip link to main content",
            'className="skip-link"' in app_text and 'href="#main"' in app_text,
            "Desktop shell needs a visible-on-focus skip link that targets #main.",
            _relative(project, app),
        ),
        _check(
            "main_focus_target",
            "Main landmark can receive skipped focus",
            'id="main"' in app_text and "tabIndex={-1}" in app_text,
            "The main content landmark must be addressable by the skip link.",
            _relative(project, app),
        ),
        _check(
            "focus_visible",
            "Visible keyboard focus styling",
            ":focus-visible" in style_text,
            "Keyboard users need a distinct focus-visible outline.",
            _relative(project, styles),
        ),
        _check(
            "reduced_motion",
            "Reduced motion preference",
            "prefers-reduced-motion" in style_text,
            "Motion effects must respect the OS reduced-motion setting.",
            _relative(project, styles),
        ),
        _check(
            "safe_text_rendering",
            "No raw HTML injection in Desktop source",
            "dangerouslySetInnerHTML" not in app_text,
            "Desktop UI must not bypass React text rendering for release surfaces.",
            _relative(project, app),
        ),
        _button_name_check(project, app_text, app),
    ]
    checks = [*source_checks, *manual_checks]
    counts = _count_statuses(checks)
    release_gate_ready = counts[BLOCKED] == 0 and counts[MANUAL] == 0
    missing_manual = [check["id"] for check in manual_checks if check["status"] != PASS]
    evidence_files = [_relative(project, manual_evidence[1])] if manual_evidence else []
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "desktop",
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
        "missing_manual_evidence": missing_manual,
        "evidence_files": evidence_files,
    }


def format_accessibility_audit(report: dict[str, Any]) -> str:
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


def write_accessibility_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def _check(check_id: str, title: str, ok: bool, failure: str, evidence: str | None) -> dict[str, Any]:
    return {
        "id": check_id,
        "title": title,
        "status": PASS if ok else BLOCKED,
        "summary": "Static preflight passed." if ok else failure,
        "evidence": evidence,
    }


def _manual_checks(root: Path, data: dict[str, Any] | None, evidence_path: Path | None) -> list[dict[str, Any]]:
    manual = data.get("manual_validation") if isinstance(data, dict) else None
    evidence_dir = evidence_path.parent if evidence_path else root
    checks = []
    for check_id, title in _MANUAL_REQUIRED.items():
        value = manual.get(check_id) if isinstance(manual, dict) else None
        status, missing = _manual_validation_status(root, evidence_dir, check_id, value)
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": (
                    "Manual release evidence accepted."
                    if status == PASS
                    else "Manual native Desktop validation evidence is required."
                    if status == MANUAL
                    else f"Manual native Desktop validation evidence is incomplete: {', '.join(missing)}."
                ),
                "evidence": data.get("evidence") if isinstance(data, dict) else None,
                "details": _manual_details(value),
            }
        )
    return checks


def _manual_metadata_check(
    root: Path,
    data: dict[str, Any] | None,
    path: Path | None,
    signed_candidate: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {
            "id": "manual_evidence_metadata",
            "title": "Manual accessibility evidence package metadata",
            "status": MANUAL,
            "summary": "Manual accessibility evidence package is required.",
            "evidence": None,
        }
    missing: list[str] = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not _non_empty(data.get("reviewer")):
        missing.append("reviewer")
    if not _timestamp(data.get("validated_at_utc")):
        missing.append("validated_at_utc")
    artifact = data.get("desktop_artifact") if isinstance(data.get("desktop_artifact"), dict) else {}
    if not _non_empty(artifact.get("name")):
        missing.append("desktop_artifact.name")
    if not _is_sha256(str(artifact.get("sha256") or "")):
        missing.append("desktop_artifact.sha256")
    if not _non_empty(artifact.get("signed_candidate_workflow_run_id")):
        missing.append("desktop_artifact.signed_candidate_workflow_run_id")
    if not _is_commit(str(artifact.get("signed_candidate_commit") or "")):
        missing.append("desktop_artifact.signed_candidate_commit")
    if artifact.get("signature_status") != "Valid":
        missing.append("desktop_artifact.signature_status=Valid")
    if artifact.get("timestamped") is not True:
        missing.append("desktop_artifact.timestamped=true")
    if signed_candidate is None:
        missing.append("signed_candidate_evidence")
    else:
        candidate_data = signed_candidate[0]
        if artifact.get("signed_candidate_workflow_run_id") != candidate_data.get("workflow_run_id"):
            missing.append("desktop_artifact.workflow_run_matches_signed_candidate")
        if artifact.get("signed_candidate_commit") != candidate_data.get("commit"):
            missing.append("desktop_artifact.commit_matches_signed_candidate")
        if not _artifact_matches_signed_candidate(artifact, candidate_data):
            missing.append("desktop_artifact.matches_signed_candidate_artifact")
        missing.extend(_signed_artifact_file_missing(root, signed_candidate[1].parent, artifact, candidate_data))
    environment = data.get("environment") if isinstance(data.get("environment"), dict) else {}
    if "windows" not in str(environment.get("os") or "").lower():
        missing.append("environment.os=Windows")
    if not _non_empty(environment.get("screen_reader")):
        missing.append("environment.screen_reader")
    if not _SCALING_REQUIRED.issubset(_scaling_values(environment.get("display_scaling_tested"))):
        missing.append("environment.display_scaling_tested=125,150,200")
    ok = not missing
    return {
        "id": "manual_evidence_metadata",
        "title": "Manual accessibility evidence package metadata",
        "status": PASS if ok else BLOCKED,
        "summary": (
            "Manual accessibility evidence identifies reviewer, artifact, Windows environment, screen reader and scaling coverage."
            if ok
            else f"Manual accessibility evidence metadata is incomplete: {', '.join(missing)}."
        ),
        "evidence": _relative(root, path),
        "details": {"missing": missing},
    }


def _button_name_check(root: Path, app_text: str, app: Path) -> dict[str, Any]:
    unnamed: list[str] = []
    for match in re.finditer(r"<button(?P<attrs>[^>]*)>(?P<body>.*?)</button>", app_text, re.DOTALL):
        attrs = match.group("attrs")
        body = match.group("body")
        plain = re.sub(r"<[^>]+>", "", body)
        plain = re.sub(r"\{[^}]+\}", "", plain).strip()
        has_name_attr = "aria-label=" in attrs or "title=" in attrs or "aria-labelledby=" in attrs
        has_dynamic_text = bool(
            re.search(r"<(?:span|strong|small|p|h[1-6])[^>]*>\s*\{[^}]+\}\s*</", body)
            or re.search(r"\{[^}]*['\"][^'\"]+['\"][^}]*\}", body)
        )
        if not plain and not has_name_attr and not has_dynamic_text:
            line = app_text[: match.start()].count("\n") + 1
            unnamed.append(f"line {line}")
    if unnamed:
        return {
            "id": "button_accessible_names",
            "title": "Buttons expose accessible names",
            "status": BLOCKED,
            "summary": f"Icon-only or dynamic buttons without explicit names: {', '.join(unnamed[:8])}.",
            "evidence": _relative(root, app),
        }
    return {
        "id": "button_accessible_names",
        "title": "Buttons expose accessible names",
        "status": PASS,
        "summary": "Static button-name preflight passed.",
        "evidence": _relative(root, app),
    }


def _latest_manual_evidence(root: Path) -> tuple[dict[str, Any], Path] | None:
    candidates: list[Path] = []
    for pattern in (
        "desktop/release-evidence/accessibility*.json",
        "build/**/desktop-accessibility*.json",
        "build/**/accessibility*.json",
    ):
        candidates.extend(path for path in root.glob(pattern) if path.is_file())
    for path in sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if isinstance(data, dict):
            return data, path
    return None


def _latest_signed_candidate_evidence(root: Path) -> tuple[dict[str, Any], Path] | None:
    candidates: list[Path] = []
    for pattern in (
        "desktop/release-evidence/signed-candidate.json",
        "desktop/release-evidence/*signed-candidate*.json",
        "build/**/signed-candidate*.json",
    ):
        candidates.extend(path for path in root.glob(pattern) if path.is_file())
    for path in sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if isinstance(data, dict):
            return data, path
    return None


def _artifact_matches_signed_candidate(artifact: dict[str, Any], signed_candidate: dict[str, Any]) -> bool:
    artifacts = signed_candidate.get("artifacts")
    if not isinstance(artifacts, list):
        return False
    expected_name = str(artifact.get("name") or "")
    expected_sha = str(artifact.get("sha256") or "").lower()
    return any(
        isinstance(item, dict)
        and item.get("name") == expected_name
        and str(item.get("sha256") or "").lower() == expected_sha
        for item in artifacts
    )


def _signed_artifact_file_missing(
    root: Path,
    evidence_dir: Path,
    artifact: dict[str, Any],
    signed_candidate: dict[str, Any],
) -> list[str]:
    artifacts = signed_candidate.get("artifacts")
    if not isinstance(artifacts, list):
        return []
    expected_name = str(artifact.get("name") or "")
    expected_sha = str(artifact.get("sha256") or "").lower()
    signed_artifact = next(
        (
            item
            for item in artifacts
            if isinstance(item, dict)
            and item.get("name") == expected_name
            and str(item.get("sha256") or "").lower() == expected_sha
        ),
        None,
    )
    if not isinstance(signed_artifact, dict):
        return []
    artifact_path = _resolve_signed_artifact_path(root, evidence_dir, str(signed_artifact.get("name") or ""))
    if artifact_path is None:
        return ["desktop_artifact.path_relative"]
    if not artifact_path.is_file():
        return ["desktop_artifact.retained_file_exists"]
    if _is_sha256(expected_sha) and _sha256_file(artifact_path) != expected_sha:
        return ["desktop_artifact.sha256_matches_file"]
    return []


def _resolve_signed_artifact_path(root: Path, evidence_dir: Path, value: str) -> Path | None:
    relative = value.replace("\\", "/").strip()
    if not relative:
        return None
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    for base in (evidence_dir, root / "dist", root):
        path = (base / candidate).resolve()
        if root == path or root in path.parents:
            if path.exists():
                return path
    return (evidence_dir / candidate).resolve()


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
    elif _is_sha256(expected_sha) and _sha256_file(resolved) != expected_sha:
        missing.append(f"{sha_field}_matches_file")
    return missing


def _resolve_evidence_path(root: Path, evidence_dir: Path, value: str) -> Path | None:
    relative = value.replace("\\", "/").strip()
    if not relative:
        return None
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    for base in (evidence_dir, root):
        path = (base / candidate).resolve()
        if root == path or root in path.parents:
            if path.exists():
                return path
    return (evidence_dir / candidate).resolve()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manual_validation_status(root: Path, evidence_dir: Path, check_id: str, value: Any) -> tuple[str, list[str]]:
    if value is None:
        return MANUAL, []
    if not isinstance(value, dict):
        return BLOCKED, ["structured_object"]
    status = value.get("status") or value.get("result")
    missing: list[str] = []
    if not (status is True or (isinstance(status, str) and status.lower() == PASS)):
        missing.append("status=pass")
    if not _non_empty(value.get("evidence")):
        missing.append("evidence")
    if not _non_empty(value.get("notes")):
        missing.append("notes")
    missing.extend(_retained_evidence_file_missing(root, evidence_dir, value, "evidence_path", "evidence_sha256"))
    if float(value.get("duration_minutes") or 0) < 3:
        missing.append("duration_minutes>=3")
    if check_id == "screen_reader" and not _non_empty(value.get("tool")):
        missing.append("tool")
    if check_id.startswith("scaling_"):
        expected = int(check_id.rsplit("_", 1)[1])
        try:
            scale = int(value.get("scale_percent"))
        except (TypeError, ValueError):
            scale = 0
        if scale != expected:
            missing.append(f"scale_percent={expected}")
    return (PASS, []) if not missing else (BLOCKED, missing)


def _manual_details(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return {
            key: item
            for key, item in value.items()
            if key
            in {
                "status",
                "result",
                "tool",
                "notes",
                "evidence",
                "evidence_path",
                "evidence_sha256",
                "scale_percent",
                "duration_minutes",
            }
        }
    return {}


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


def _scaling_values(value: Any) -> set[int]:
    if not isinstance(value, list):
        return set()
    values: set[int] = set()
    for item in value:
        try:
            values.add(int(item))
        except (TypeError, ValueError):
            continue
    return values


def _is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value))


def _is_commit(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{7,40}", value))


def _count_statuses(checks: list[dict[str, Any]]) -> dict[str, int]:
    return {
        PASS: sum(1 for check in checks if check["status"] == PASS),
        MANUAL: sum(1 for check in checks if check["status"] == MANUAL),
        BLOCKED: sum(1 for check in checks if check["status"] == BLOCKED),
    }


def _paths(root: Path, paths: list[Path]) -> str:
    return "; ".join(_relative(root, path) or str(path) for path in paths)


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
