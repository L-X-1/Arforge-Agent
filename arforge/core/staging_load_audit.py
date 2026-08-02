"""Provider staging, load and long-run dogfood release audit."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "pass"
BLOCKED = "blocked"
MANUAL = "manual"

_MANUAL_REQUIRED = {
    "release_owner_review": "Release owner reviewed staging, load and failure evidence",
    "test_credentials_review": "Provider tests used independent test credentials, not personal production keys",
}


def build_staging_load_audit(root: str | Path = ".") -> dict[str, Any]:
    """Return a fail-closed STAGE-01 audit."""
    project = Path(root).resolve()
    provider = _latest_json(
        project,
        (
            "build/**/provider*staging*.json",
            "build/**/staging*provider*.json",
            "desktop/release-evidence/provider*staging*.json",
        ),
    )
    staging = _latest_json(
        project,
        (
            "build/**/staging*.json",
            "desktop/release-evidence/staging*.json",
        ),
    )
    load = _latest_json(
        project,
        (
            "build/**/*load*.json",
            "desktop/release-evidence/*load*.json",
        ),
    )
    dogfood = _latest_json(
        project,
        (
            "build/**/dogfood*.json",
            "desktop/release-evidence/dogfood*.json",
        ),
    )
    manual = _manual_source(provider, staging, load, dogfood)
    checks = [
        _provider_check(project, provider),
        _staging_check(project, staging),
        _load_check(project, load),
        _dogfood_check(project, dogfood),
        _release_candidate_consistency_check(project, provider, staging, load, dogfood),
        _failure_recovery_check(project, provider, staging),
        _review_metadata_check(project, provider, staging, load, dogfood),
        *_manual_checks(project, manual),
    ]
    counts = _count_statuses(checks)
    release_gate_ready = counts[BLOCKED] == 0 and counts[MANUAL] == 0
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "surface": "provider_staging_load",
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
                _relative(project, provider[1]) if provider else None,
                _relative(project, staging[1]) if staging else None,
                _relative(project, load[1]) if load else None,
                _relative(project, dogfood[1]) if dogfood else None,
            ]
            if item
        ],
    }


def format_staging_load_audit(report: dict[str, Any]) -> str:
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


def write_staging_load_audit(report: dict[str, Any], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def _provider_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("provider_staging_smoke", "Real provider staging smoke", False, "", "Provider-backed staging smoke evidence is missing.", None)
    data, path = evidence
    missing = _provider_missing(data)
    ready = not missing
    return _check(
        "provider_staging_smoke",
        "Real provider staging smoke",
        ready,
        "Provider staging smoke used real provider, independent test credentials and traceable run metadata.",
        f"Provider evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"status": data.get("status"), "missing": missing},
    )


def _staging_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("staging_e2e", "Staging environment E2E", False, "", "Staging E2E evidence is missing.", None)
    data, path = evidence
    missing = _staging_missing(data)
    ready = not missing
    return _check(
        "staging_e2e",
        "Staging environment E2E",
        ready,
        "Staging E2E evidence proves isolated staging execution with traceable run metadata.",
        f"Staging evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"status": data.get("status"), "missing": missing},
    )


def _load_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("load_validation", "Provider load validation", False, "", "Provider load evidence is missing.", None)
    data, path = evidence
    metrics = _load_metrics(data)
    missing = _load_missing(data, metrics)
    ready = not missing
    return _check(
        "load_validation",
        "Provider load validation",
        ready,
        "Load evidence meets traceability, concurrency, request, duration, error-rate and latency bounds.",
        f"Load evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"status": data.get("status"), **metrics, "missing": missing},
    )


def _dogfood_check(root: Path, evidence: tuple[dict[str, Any], Path] | None) -> dict[str, Any]:
    if not evidence:
        return _check("long_run_dogfood", "Long-run dogfood evidence", False, "", "Long-run dogfood release evidence is missing.", None)
    data, path = evidence
    total = int(data.get("total") or data.get("runs") or 0)
    success_rate = float(data.get("success_rate") or 0.0)
    missing = _dogfood_missing(data, total, success_rate)
    ready = not missing
    return _check(
        "long_run_dogfood",
        "Long-run dogfood evidence",
        ready,
        "Dogfood evidence meets run-count, success-rate and traceability requirements.",
        f"Dogfood evidence is incomplete: {', '.join(missing)}.",
        _relative(root, path),
        {"status": data.get("status"), "total": total, "success_rate": success_rate, "missing": missing},
    )


def _failure_recovery_check(
    root: Path,
    provider: tuple[dict[str, Any], Path] | None,
    staging: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    candidates = [item for item in (provider, staging) if item]
    for data, path in candidates:
        missing = _transport_fault_injection_missing(data)
        if not missing:
            return _check(
                "failure_recovery",
                "Transport fault detection and provider recovery",
                True,
                "HTTP 429, HTTP 503 and connection-drop faults crossed the provider transport boundary, were rejected as failures, and were followed by a valid real-provider recovery call.",
                "",
                _relative(root, path),
                {"missing": []},
            )
    return _check(
        "failure_recovery",
        "Transport fault detection and provider recovery",
        False,
        "",
        "Provider evidence must prove transport-level HTTP 429, HTTP 503 and connection-drop detection followed by a real-provider recovery call.",
        _relative(root, candidates[0][1]) if candidates else None,
        {
            "missing": (
                _transport_fault_injection_missing(candidates[0][0])
                if candidates
                else ["fault_injection"]
            )
        },
    )


def _release_candidate_consistency_check(
    root: Path,
    provider: tuple[dict[str, Any], Path] | None,
    staging: tuple[dict[str, Any], Path] | None,
    load: tuple[dict[str, Any], Path] | None,
    dogfood: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    items = [item for item in (provider, staging, load, dogfood) if item]
    if len(items) < 4:
        return _check(
            "release_candidate_consistency",
            "Release candidate evidence consistency",
            False,
            "",
            "Provider, staging, load and dogfood evidence must all exist for one release-candidate validation package.",
            _relative(root, items[0][1]) if items else None,
        )
    release_candidate_ids = {str(data.get("release_candidate_id") or "").strip() for data, _ in items}
    artifact_set_ids = {str(data.get("artifact_set_id") or "").strip() for data, _ in items}
    signed_candidate_runs = {str(data.get("signed_candidate_workflow_run_id") or "").strip() for data, _ in items}
    missing: list[str] = []
    if "" in release_candidate_ids or len(release_candidate_ids) != 1:
        missing.append("same release_candidate_id")
    if "" in artifact_set_ids or len(artifact_set_ids) != 1:
        missing.append("same artifact_set_id")
    if "" in signed_candidate_runs or len(signed_candidate_runs) != 1:
        missing.append("same signed_candidate_workflow_run_id")
    ready = not missing
    return _check(
        "release_candidate_consistency",
        "Release candidate evidence consistency",
        ready,
        "Provider, staging, load and dogfood evidence all reference the same release candidate, artifact set and signed workflow run.",
        f"Staging/load evidence is not bound to one release candidate: {', '.join(missing)}.",
        _relative(root, provider[1]) if provider else None,
        {
            "release_candidate_ids": sorted(release_candidate_ids),
            "artifact_set_ids": sorted(artifact_set_ids),
            "signed_candidate_workflow_run_ids": sorted(signed_candidate_runs),
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
        status, missing = _manual_staging_status(root, path.parent if path else root, check_id, value)
        checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "summary": (
                    "Manual staging/load evidence accepted."
                    if status == PASS
                    else "Manual release-owner staging/load evidence is required."
                    if status == MANUAL
                    else f"Manual staging/load evidence is incomplete: {', '.join(missing)}."
                ),
                "evidence": _relative(root, path),
                "details": {"missing": missing},
            }
        )
    return checks


def _manual_staging_status(root: Path, evidence_dir: Path, check_id: str, value: Any) -> tuple[str, list[str]]:
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
    if check_id == "release_owner_review":
        for field in (
            "release_candidate_id",
            "artifact_set_id",
            "signed_candidate_workflow_run_id",
            "provider_run_id",
            "staging_run_id",
            "load_run_id",
            "dogfood_run_id",
        ):
            if not _non_empty(value.get(field)):
                missing.append(field)
        if value.get("failure_recovery_reviewed") is not True:
            missing.append("failure_recovery_reviewed=true")
        if value.get("load_thresholds_reviewed") is not True:
            missing.append("load_thresholds_reviewed=true")
    elif check_id == "test_credentials_review":
        if value.get("test_credentials_scoped") is not True:
            missing.append("test_credentials_scoped=true")
        if value.get("production_credentials_absent") is not True:
            missing.append("production_credentials_absent=true")
        if not _non_empty(value.get("credential_scope")):
            missing.append("credential_scope")
        if not _non_empty(value.get("provider")):
            missing.append("provider")
        if not _non_empty(value.get("model")):
            missing.append("model")
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
    resolved = _resolve_evidence_path(root, evidence_dir, path_value)
    if resolved is None:
        missing.append(f"{path_field}_relative")
    elif not resolved.is_file():
        missing.append(f"{path_field}_exists")
    elif _is_sha256(expected_sha) and _sha256(resolved) != expected_sha:
        missing.append(f"{sha_field}_matches_file")
    return missing


def _review_metadata_check(
    root: Path,
    provider: tuple[dict[str, Any], Path] | None,
    staging: tuple[dict[str, Any], Path] | None,
    load: tuple[dict[str, Any], Path] | None,
    dogfood: tuple[dict[str, Any], Path] | None,
) -> dict[str, Any]:
    items = [item for item in (provider, staging, load, dogfood) if item]
    review_source = _review_source(provider, staging, load, dogfood)
    if len(items) < 4 or not review_source:
        return {
            "id": "staging_review_metadata",
            "title": "Release-owner staging review metadata",
            "status": MANUAL,
            "summary": "Structured staging/load review evidence is required.",
            "evidence": _relative(root, review_source[1]) if review_source else (_relative(root, items[0][1]) if items else None),
        }
    review = review_source[0].get("review")
    if not isinstance(review, dict):
        return {
            "id": "staging_review_metadata",
            "title": "Release-owner staging review metadata",
            "status": MANUAL,
            "summary": "Structured staging/load review evidence is required.",
            "evidence": _relative(root, review_source[1]),
        }
    provider_data = provider[0] if provider else {}
    staging_data = staging[0] if staging else {}
    load_data = load[0] if load else {}
    dogfood_data = dogfood[0] if dogfood else {}
    missing: list[str] = []
    for field in ("reviewer",):
        if not _non_empty(review.get(field)):
            missing.append(field)
    if not _timestamp(review.get("reviewed_at_utc")):
        missing.append("reviewed_at_utc")
    expected = {
        "release_candidate_id": provider_data.get("release_candidate_id"),
        "artifact_set_id": provider_data.get("artifact_set_id"),
        "signed_candidate_workflow_run_id": provider_data.get("signed_candidate_workflow_run_id"),
        "provider_run_id": provider_data.get("run_id"),
        "staging_run_id": staging_data.get("run_id"),
        "load_run_id": load_data.get("run_id"),
        "dogfood_run_id": dogfood_data.get("run_id"),
        "dogfood_dataset_hash": dogfood_data.get("dataset_hash"),
    }
    for field, expected_value in expected.items():
        if not _non_empty(review.get(field)) or str(review.get(field)).strip() != str(expected_value or "").strip():
            missing.append(f"{field}=evidence")
    evidence_paths = review.get("evidence_paths") if isinstance(review.get("evidence_paths"), dict) else {}
    path_expectations = {
        "provider": _relative(root, provider[1]) if provider else None,
        "staging": _relative(root, staging[1]) if staging else None,
        "load": _relative(root, load[1]) if load else None,
        "dogfood": _relative(root, dogfood[1]) if dogfood else None,
    }
    path_objects = {
        "provider": provider[1] if provider else None,
        "staging": staging[1] if staging else None,
        "load": load[1] if load else None,
        "dogfood": dogfood[1] if dogfood else None,
    }
    evidence_hashes = review.get("evidence_sha256") if isinstance(review.get("evidence_sha256"), dict) else {}
    for field, expected_path in path_expectations.items():
        if not _non_empty(evidence_paths.get(field)) or evidence_paths.get(field) != expected_path:
            missing.append(f"evidence_paths.{field}")
        expected_file = path_objects.get(field)
        if expected_file and expected_file != review_source[1]:
            expected_hash = str(evidence_hashes.get(field) or "")
            if not _is_sha256(expected_hash):
                missing.append(f"evidence_sha256.{field}")
            elif _sha256(expected_file) != expected_hash.lower():
                missing.append(f"evidence_sha256.{field}_matches_file")
    for field in (
        "test_credentials_scoped",
        "production_credentials_absent",
        "load_thresholds_reviewed",
        "failure_recovery_reviewed",
    ):
        if review.get(field) is not True:
            missing.append(f"{field}=true")
    ready = not missing
    return {
        "id": "staging_review_metadata",
        "title": "Release-owner staging review metadata",
        "status": PASS if ready else BLOCKED,
        "summary": "Release-owner review is bound to the staging evidence package." if ready else f"Staging review metadata is incomplete: {', '.join(missing)}.",
        "evidence": _relative(root, review_source[1]),
        "details": {"missing": missing},
    }


def _manual_source(*items: tuple[dict[str, Any], Path] | None) -> tuple[dict[str, Any], Path] | None:
    for item in items:
        if item and isinstance(item[0].get("manual_validation"), dict):
            return item
    return next((item for item in items if item), None)


def _review_source(*items: tuple[dict[str, Any], Path] | None) -> tuple[dict[str, Any], Path] | None:
    for item in items:
        if item and isinstance(item[0].get("review"), dict):
            return item
    return _manual_source(*items)


def _provider_missing(data: dict[str, Any]) -> list[str]:
    missing = _base_run_missing(data)
    if data.get("provider_real") is not True:
        missing.append("provider_real=true")
    if data.get("test_credentials") is not True:
        missing.append("test_credentials=true")
    if not _non_empty(data.get("provider")):
        missing.append("provider")
    if not _non_empty(data.get("model")):
        missing.append("model")
    if not _non_empty(data.get("credential_scope")):
        missing.append("credential_scope")
    if data.get("production_credentials") is True:
        missing.append("production_credentials=false")
    if _transport_fault_injection_missing(data):
        missing.append("transport_fault_injection")
    return missing


def _transport_fault_injection_missing(data: dict[str, Any]) -> list[str]:
    from arforge.core.provider_fault_injection import (
        validate_transport_fault_evidence,
    )

    return validate_transport_fault_evidence(data.get("fault_injection"))


def _staging_missing(data: dict[str, Any]) -> list[str]:
    missing = _base_run_missing(data)
    if str(data.get("environment") or "").lower() != "staging":
        missing.append("environment=staging")
    if data.get("isolated") is not True:
        missing.append("isolated=true")
    if not _non_empty(data.get("workspace_profile")):
        missing.append("workspace_profile")
    if data.get("production_data") is True:
        missing.append("production_data=false")
    return missing


def _load_missing(data: dict[str, Any], metrics: dict[str, Any]) -> list[str]:
    missing = _base_run_missing(data)
    if str(data.get("environment") or "").lower() != "staging":
        missing.append("environment=staging")
    if data.get("isolated") is not True:
        missing.append("isolated=true")
    if int(data.get("concurrency") or 0) < 2:
        missing.append("concurrency>=2")
    if metrics["requests"] < 100:
        missing.append("requests>=100")
    if metrics["duration_minutes"] < 15:
        missing.append("duration_minutes>=15")
    if metrics["error_rate"] > 0.02:
        missing.append("error_rate<=0.02")
    if not 0 < metrics["p95_latency_ms"] <= 10000:
        missing.append("0<p95_latency_ms<=10000")
    if data.get("production_credentials") is True:
        missing.append("production_credentials=false")
    return missing


def _dogfood_missing(data: dict[str, Any], total: int, success_rate: float) -> list[str]:
    missing = _base_run_missing(data)
    if total < 50:
        missing.append("total/runs>=50")
    if success_rate < 0.85:
        missing.append("success_rate>=0.85")
    if not _non_empty(data.get("scope")):
        missing.append("scope")
    if not _non_empty(data.get("dataset_hash")):
        missing.append("dataset_hash")
    return missing


def _base_run_missing(data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if data.get("schema_version") != 1:
        missing.append("schema_version=1")
    if not _passish(data.get("status")):
        missing.append("status=pass")
    if not _non_empty(data.get("run_id")):
        missing.append("run_id")
    if not _timestamp(data.get("started_at_utc")):
        missing.append("started_at_utc")
    if not _timestamp(data.get("completed_at_utc")):
        missing.append("completed_at_utc")
    if not _non_empty(data.get("release_candidate_id")):
        missing.append("release_candidate_id")
    if not _non_empty(data.get("artifact_set_id")):
        missing.append("artifact_set_id")
    if not _non_empty(data.get("signed_candidate_workflow_run_id")):
        missing.append("signed_candidate_workflow_run_id")
    return missing


def _load_metrics(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "requests": int(data.get("requests") or data.get("total_requests") or 0),
        "duration_minutes": float(data.get("duration_minutes") or 0),
        "error_rate": float(data.get("error_rate") or 0.0),
        "p95_latency_ms": float(data.get("p95_latency_ms") or 0.0),
    }


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
        # Never consume this audit's own retained output as fresh staging
        # evidence on a subsequent run.
        if isinstance(data, dict) and data.get("surface") == "provider_staging_load":
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
    import re

    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value))


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
    for base in (evidence_dir, root):
        candidate = (base / relative).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if candidate.exists():
            return candidate
    return (evidence_dir / relative).resolve()
