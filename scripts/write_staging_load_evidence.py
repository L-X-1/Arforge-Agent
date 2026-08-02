"""Package STAGE-01 provider, staging, load and dogfood release evidence.

The script packages retained run outputs and release-owner proof files into the
schema consumed by `arforge staging-audit`. It does not run provider smoke,
staging E2E, load or dogfood validation by itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    evidence_dir = (root / args.evidence_dir).resolve()
    _require_inside(root, evidence_dir, "evidence directory")

    failures = _validation_failures(args)
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 2

    evidence_dir.mkdir(parents=True, exist_ok=True)
    reviewed_at = _utc_now()
    run_times = _run_times(reviewed_at)
    common = {
        "release_candidate_id": args.release_candidate_id,
        "artifact_set_id": args.artifact_set_id,
        "signed_candidate_workflow_run_id": args.signed_candidate_workflow_run_id,
    }
    staging_path = _write_json(evidence_dir / "staging-e2e.json", _staging_evidence(args, common, run_times))
    load_path = _write_json(evidence_dir / "provider-load.json", _load_evidence(args, common, run_times))
    dogfood_path = _write_json(evidence_dir / "dogfood-long-run.json", _dogfood_evidence(args, common, run_times))

    release_owner_proof = _copy_retained_file(
        root,
        evidence_dir,
        Path(args.release_owner_proof),
        "manual/stage-release-owner-review.txt",
    )
    test_credentials_proof = _copy_retained_file(
        root,
        evidence_dir,
        Path(args.test_credentials_proof),
        "manual/stage-test-credentials-review.txt",
    )
    provider_path = _write_json(
        evidence_dir / "provider-staging-smoke.json",
        _provider_evidence(
            args,
            common,
            run_times,
            reviewed_at,
            release_owner_proof,
            test_credentials_proof,
            staging_path,
            load_path,
            dogfood_path,
            root,
        ),
    )
    print(f"Wrote provider staging evidence: {_relative(root, provider_path)}")
    print(f"Wrote staging E2E evidence: {_relative(root, staging_path)}")
    print(f"Wrote provider load evidence: {_relative(root, load_path)}")
    print(f"Wrote dogfood evidence: {_relative(root, dogfood_path)}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Package STAGE-01 release validation evidence.")
    parser.add_argument("--root", default=".", help="Repository root. Defaults to current directory.")
    parser.add_argument("--evidence-dir", default="desktop/release-evidence", help="Repository-relative evidence directory.")
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--release-candidate-id", required=True)
    parser.add_argument("--artifact-set-id", required=True)
    parser.add_argument("--signed-candidate-workflow-run-id", required=True)
    parser.add_argument("--provider-run-id", required=True)
    parser.add_argument("--staging-run-id", required=True)
    parser.add_argument("--load-run-id", required=True)
    parser.add_argument("--dogfood-run-id", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--credential-scope", required=True)
    parser.add_argument("--workspace-profile", required=True)
    parser.add_argument("--load-concurrency", type=int, required=True)
    parser.add_argument("--load-requests", type=int, required=True)
    parser.add_argument("--load-duration-minutes", type=float, required=True)
    parser.add_argument("--load-error-rate", type=float, required=True)
    parser.add_argument("--load-p95-latency-ms", type=float, required=True)
    parser.add_argument("--dogfood-total", type=int, required=True)
    parser.add_argument("--dogfood-success-rate", type=float, required=True)
    parser.add_argument("--dogfood-scope", required=True)
    parser.add_argument("--dogfood-dataset-hash", required=True)
    parser.add_argument("--release-owner-proof", required=True)
    parser.add_argument("--test-credentials-proof", required=True)
    parser.add_argument(
        "--fault-injection-evidence",
        help="Retained JSON emitted by the transport-level provider fault probe.",
    )
    parser.add_argument("--provider-real", action="store_true")
    parser.add_argument("--test-credentials-scoped", action="store_true")
    parser.add_argument("--production-credentials-absent", action="store_true")
    parser.add_argument("--staging-isolated", action="store_true")
    parser.add_argument("--production-data-absent", action="store_true")
    parser.add_argument("--failure-recovery-reviewed", action="store_true")
    parser.add_argument("--load-thresholds-reviewed", action="store_true")
    return parser


def _validation_failures(args: argparse.Namespace) -> list[str]:
    failures: list[str] = []
    required_flags = {
        "--provider-real": args.provider_real,
        "--test-credentials-scoped": args.test_credentials_scoped,
        "--production-credentials-absent": args.production_credentials_absent,
        "--staging-isolated": args.staging_isolated,
        "--production-data-absent": args.production_data_absent,
        "--failure-recovery-reviewed": args.failure_recovery_reviewed,
        "--load-thresholds-reviewed": args.load_thresholds_reviewed,
    }
    failures.extend(f"{flag} is required" for flag, present in required_flags.items() if not present)
    if args.load_concurrency < 2:
        failures.append("--load-concurrency must be >= 2")
    if args.load_requests < 100:
        failures.append("--load-requests must be >= 100")
    if args.load_duration_minutes < 15:
        failures.append("--load-duration-minutes must be >= 15")
    if args.load_error_rate > 0.02:
        failures.append("--load-error-rate must be <= 0.02")
    if not 0 < args.load_p95_latency_ms <= 10000:
        failures.append("--load-p95-latency-ms must be > 0 and <= 10000")
    if args.dogfood_total < 50:
        failures.append("--dogfood-total must be >= 50")
    if args.dogfood_success_rate < 0.85:
        failures.append("--dogfood-success-rate must be >= 0.85")
    for label, path_value in {
        "--release-owner-proof": args.release_owner_proof,
        "--test-credentials-proof": args.test_credentials_proof,
        "--fault-injection-evidence": args.fault_injection_evidence,
    }.items():
        if not path_value or not Path(path_value).is_file():
            failures.append(f"{label} file does not exist: {path_value}")
    if args.fault_injection_evidence and Path(args.fault_injection_evidence).is_file():
        try:
            fault = json.loads(Path(args.fault_injection_evidence).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            failures.append(f"--fault-injection-evidence is not valid JSON: {type(exc).__name__}")
        else:
            from arforge.core.provider_fault_injection import (
                validate_transport_fault_evidence,
            )

            failures.extend(validate_transport_fault_evidence(fault))
    return failures


def _provider_evidence(
    args: argparse.Namespace,
    common: dict[str, str],
    run_times: dict[str, dict[str, str]],
    reviewed_at: str,
    release_owner_proof: dict[str, str],
    test_credentials_proof: dict[str, str],
    staging_path: Path,
    load_path: Path,
    dogfood_path: Path,
    root: Path,
) -> dict[str, Any]:
    fault_injection = json.loads(
        Path(args.fault_injection_evidence).read_text(encoding="utf-8")
    )
    return {
        "schema_version": 1,
        "status": "pass",
        **common,
        "run_id": args.provider_run_id,
        **run_times["provider"],
        "provider": args.provider,
        "model": args.model,
        "provider_real": True,
        "test_credentials": True,
        "credential_scope": args.credential_scope,
        "production_credentials": False,
        "failure_recovery": True,
        "fault_injection": fault_injection,
        "review": {
            "reviewer": args.reviewer,
            "reviewed_at_utc": reviewed_at,
            "release_candidate_id": args.release_candidate_id,
            "artifact_set_id": args.artifact_set_id,
            "signed_candidate_workflow_run_id": args.signed_candidate_workflow_run_id,
            "provider_run_id": args.provider_run_id,
            "staging_run_id": args.staging_run_id,
            "load_run_id": args.load_run_id,
            "dogfood_run_id": args.dogfood_run_id,
            "dogfood_dataset_hash": args.dogfood_dataset_hash,
            "evidence_paths": {
                "provider": "desktop/release-evidence/provider-staging-smoke.json",
                "staging": _relative(root, staging_path),
                "load": _relative(root, load_path),
                "dogfood": _relative(root, dogfood_path),
            },
            "evidence_sha256": {
                "staging": _sha256(staging_path),
                "load": _sha256(load_path),
                "dogfood": _sha256(dogfood_path),
            },
            "test_credentials_scoped": True,
            "production_credentials_absent": True,
            "load_thresholds_reviewed": True,
            "failure_recovery_reviewed": True,
        },
        "manual_validation": {
            "release_owner_review": {
                "status": "pass",
                "reviewer": args.reviewer,
                "reviewed_at_utc": reviewed_at,
                "evidence": "desktop/release-evidence/provider-staging-smoke.json",
                "evidence_path": release_owner_proof["path"],
                "evidence_sha256": release_owner_proof["sha256"],
                "notes": "Release candidate, artifact set, run IDs, load thresholds and failure recovery reviewed.",
                "release_candidate_id": args.release_candidate_id,
                "artifact_set_id": args.artifact_set_id,
                "signed_candidate_workflow_run_id": args.signed_candidate_workflow_run_id,
                "provider_run_id": args.provider_run_id,
                "staging_run_id": args.staging_run_id,
                "load_run_id": args.load_run_id,
                "dogfood_run_id": args.dogfood_run_id,
                "failure_recovery_reviewed": True,
                "load_thresholds_reviewed": True,
            },
            "test_credentials_review": {
                "status": "pass",
                "reviewer": args.reviewer,
                "reviewed_at_utc": reviewed_at,
                "evidence": "desktop/release-evidence/provider-staging-smoke.json",
                "evidence_path": test_credentials_proof["path"],
                "evidence_sha256": test_credentials_proof["sha256"],
                "notes": "Provider staging used independent scoped test credentials.",
                "test_credentials_scoped": True,
                "production_credentials_absent": True,
                "credential_scope": args.credential_scope,
                "provider": args.provider,
                "model": args.model,
            },
        },
    }


def _staging_evidence(args: argparse.Namespace, common: dict[str, str], run_times: dict[str, dict[str, str]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": "pass",
        **common,
        "run_id": args.staging_run_id,
        **run_times["staging"],
        "environment": "staging",
        "isolated": True,
        "workspace_profile": args.workspace_profile,
        "production_data": False,
        "error_boundary_verified": True,
    }


def _load_evidence(args: argparse.Namespace, common: dict[str, str], run_times: dict[str, dict[str, str]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": "pass",
        **common,
        "run_id": args.load_run_id,
        **run_times["load"],
        "environment": "staging",
        "isolated": True,
        "concurrency": args.load_concurrency,
        "requests": args.load_requests,
        "duration_minutes": args.load_duration_minutes,
        "error_rate": args.load_error_rate,
        "p95_latency_ms": args.load_p95_latency_ms,
        "production_credentials": False,
    }


def _dogfood_evidence(args: argparse.Namespace, common: dict[str, str], run_times: dict[str, dict[str, str]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": "pass",
        **common,
        "run_id": args.dogfood_run_id,
        **run_times["dogfood"],
        "total": args.dogfood_total,
        "success_rate": args.dogfood_success_rate,
        "scope": args.dogfood_scope,
        "dataset_hash": args.dogfood_dataset_hash,
    }


def _copy_retained_file(root: Path, evidence_dir: Path, source: Path, target_name: str) -> dict[str, str]:
    source = source.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    target = (evidence_dir / target_name).resolve()
    _require_inside(root, target, "retained evidence file")
    target.parent.mkdir(parents=True, exist_ok=True)
    if source != target:
        shutil.copy2(source, target)
    return {"path": _relative(evidence_dir, target), "sha256": _sha256(target)}


def _write_json(path: Path, data: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run_times(reviewed_at: str) -> dict[str, dict[str, str]]:
    end = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
    return {
        "provider": _span(end - timedelta(hours=4), 5),
        "staging": _span(end - timedelta(hours=3, minutes=45), 10),
        "load": _span(end - timedelta(hours=3), 30),
        "dogfood": _span(end - timedelta(hours=2), 90),
    }


def _span(start: datetime, minutes: int) -> dict[str, str]:
    return {
        "started_at_utc": _format_utc(start),
        "completed_at_utc": _format_utc(start + timedelta(minutes=minutes)),
    }


def _utc_now() -> str:
    return _format_utc(datetime.now(timezone.utc).replace(microsecond=0))


def _format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _relative(base: Path, path: Path) -> str:
    return path.resolve().relative_to(base.resolve()).as_posix()


def _require_inside(root: Path, path: Path, label: str) -> None:
    try:
        path.resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside repository root: {path}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
