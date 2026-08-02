"""Package final SHIP-01 immutable release approval evidence.

This script creates the final approval JSON consumed by `arforge ship-audit`.
It does not make a release ready by itself: all prior gate evidence files must
already exist and report a passing state before the approval package is written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


REQUIRED_GATE_IDS = ("SIGN-01", "SIGN-02", "REL-01", "UPGRADE-01", "A11Y-01", "GOV-01", "STAGE-01")


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    evidence_dir = (root / args.evidence_dir).resolve()
    _require_inside(root, evidence_dir, "evidence directory")

    manifest_path = (root / args.manifest).resolve()
    failures, manifest = _validation_failures(root, manifest_path, args)
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 2

    evidence_dir.mkdir(parents=True, exist_ok=True)
    approved_at = _utc_now()
    rollback_plan = _copy_retained_file(root, evidence_dir, Path(args.rollback_plan), "final/rollback-plan.md")
    release_notes = _copy_retained_file(root, evidence_dir, Path(args.release_notes), "final/release-notes.md")
    owner_proof = _copy_retained_file(root, evidence_dir, Path(args.release_owner_approval_proof), "final/release-owner-approval.txt")
    promotion_proof = _copy_retained_file(root, evidence_dir, Path(args.artifact_promotion_lock_proof), "final/artifact-promotion-lock.txt")
    prior_gates = _copy_prior_gates(root, evidence_dir, args.prior_gate)
    manifest_hash = _sha256(manifest_path)
    approval_path = _write_json(
        evidence_dir / "ship-gate-approval.json",
        _approval_evidence(
            args,
            manifest,
            manifest_hash,
            approved_at,
            rollback_plan,
            release_notes,
            owner_proof,
            promotion_proof,
            prior_gates,
        ),
    )

    print(f"Wrote final Ship Gate evidence: {_relative(root, approval_path)}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Package SHIP-01 final immutable release approval evidence.")
    parser.add_argument("--root", default=".", help="Repository root. Defaults to current directory.")
    parser.add_argument("--evidence-dir", default="desktop/release-evidence", help="Repository-relative evidence directory.")
    parser.add_argument("--manifest", default="dist/release-manifest.json", help="Repository-relative release manifest path.")
    parser.add_argument("--approver", required=True)
    parser.add_argument("--release-channel", required=True)
    parser.add_argument("--artifact-set-id", required=True)
    parser.add_argument("--release-candidate-id", required=True)
    parser.add_argument("--signed-candidate-workflow-run-id", required=True)
    parser.add_argument("--rollback-plan", required=True)
    parser.add_argument("--release-notes", required=True)
    parser.add_argument("--release-owner-approval-proof", required=True)
    parser.add_argument("--artifact-promotion-lock-proof", required=True)
    parser.add_argument(
        "--prior-gate",
        action="append",
        default=[],
        metavar="GATE_ID=PATH",
        help="Passing prior gate evidence file. Required for SIGN-01, SIGN-02, REL-01, UPGRADE-01, A11Y-01, GOV-01 and STAGE-01.",
    )
    parser.add_argument("--release-owner-approved", action="store_true")
    parser.add_argument("--artifact-promotion-locked", action="store_true")
    parser.add_argument("--immutable-storage", action="store_true")
    parser.add_argument("--replace-in-place-blocked", action="store_true")
    parser.add_argument("--rollback-plan-reviewed", action="store_true")
    parser.add_argument("--downgrade-or-rollback-path-reviewed", action="store_true")
    parser.add_argument("--docs-release-notes-reviewed", action="store_true")
    parser.add_argument("--known-limitations-reviewed", action="store_true")
    parser.add_argument("--user-docs-reviewed", action="store_true")
    parser.add_argument("--no-open-blocking-gates", action="store_true")
    return parser


def _validation_failures(root: Path, manifest_path: Path, args: argparse.Namespace) -> tuple[list[str], dict[str, Any]]:
    failures: list[str] = []
    manifest: dict[str, Any] = {}
    required_flags = {
        "--release-owner-approved": args.release_owner_approved,
        "--artifact-promotion-locked": args.artifact_promotion_locked,
        "--immutable-storage": args.immutable_storage,
        "--replace-in-place-blocked": args.replace_in_place_blocked,
        "--rollback-plan-reviewed": args.rollback_plan_reviewed,
        "--downgrade-or-rollback-path-reviewed": args.downgrade_or_rollback_path_reviewed,
        "--docs-release-notes-reviewed": args.docs_release_notes_reviewed,
        "--known-limitations-reviewed": args.known_limitations_reviewed,
        "--user-docs-reviewed": args.user_docs_reviewed,
        "--no-open-blocking-gates": args.no_open_blocking_gates,
    }
    failures.extend(f"{flag} is required" for flag, present in required_flags.items() if not present)
    if not manifest_path.is_file():
        failures.append(f"release manifest does not exist: {manifest_path}")
    else:
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            failures.append(f"release manifest is not valid JSON: {exc}")
        else:
            if isinstance(loaded, dict):
                manifest = loaded
                failures.extend(_manifest_failures(root, manifest_path, manifest))
            else:
                failures.append("release manifest must be a JSON object")
    failures.extend(_prior_gate_failures(root, args.prior_gate))
    for label, path_value in {
        "--rollback-plan": args.rollback_plan,
        "--release-notes": args.release_notes,
        "--release-owner-approval-proof": args.release_owner_approval_proof,
        "--artifact-promotion-lock-proof": args.artifact_promotion_lock_proof,
    }.items():
        if not Path(path_value).is_file():
            failures.append(f"{label} file does not exist: {path_value}")
    return failures, manifest


def _manifest_failures(root: Path, manifest_path: Path, manifest: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if manifest.get("schema_version") != 1:
        failures.append("release manifest schema_version=1 is required")
    if manifest.get("source", {}).get("dirty") is not False:
        failures.append("release manifest must record source.dirty=false")
    lockfile = manifest.get("lockfile") if isinstance(manifest.get("lockfile"), dict) else {}
    lock_path = root / str(lockfile.get("name") or "")
    if not lock_path.is_file() or _sha256(lock_path) != str(lockfile.get("sha256") or "").lower():
        failures.append("release lockfile hash must match manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        failures.append("release manifest files[] is required")
        return failures
    sbom_found = False
    for item in files:
        if not isinstance(item, dict):
            failures.append("release manifest files[] entries must be objects")
            continue
        name = str(item.get("name") or "")
        if name.endswith(".cdx.json"):
            sbom_found = True
        if not name or "/" in name or "\\" in name:
            failures.append(f"invalid manifest artifact name: {name or '<missing>'}")
            continue
        artifact = manifest_path.parent / name
        expected_sha = str(item.get("sha256") or "").lower()
        expected_bytes = int(item.get("bytes") or -1)
        if not artifact.is_file() or _sha256(artifact) != expected_sha or artifact.stat().st_size != expected_bytes:
            failures.append(f"artifact does not match manifest: {name}")
    if not sbom_found:
        failures.append("CycloneDX SBOM artifact is required in release manifest")
    return failures


def _prior_gate_failures(root: Path, values: list[str]) -> list[str]:
    failures: list[str] = []
    parsed: dict[str, Path] = {}
    for raw in values:
        try:
            gate_id, path = _parse_prior_gate(raw)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        if gate_id in parsed:
            failures.append(f"duplicate --prior-gate for {gate_id}")
        parsed[gate_id] = path
    missing = sorted(set(REQUIRED_GATE_IDS) - set(parsed))
    failures.extend(f"missing --prior-gate {gate_id}=PATH" for gate_id in missing)
    for gate_id, path in parsed.items():
        if gate_id not in REQUIRED_GATE_IDS:
            failures.append(f"unsupported prior gate id: {gate_id}")
            continue
        if not path.is_file():
            failures.append(f"prior gate evidence file does not exist for {gate_id}: {path}")
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            failures.append(f"prior gate evidence is not valid JSON for {gate_id}: {exc}")
            continue
        if not isinstance(data, dict):
            failures.append(f"prior gate evidence must be a JSON object for {gate_id}")
            continue
        if not _prior_gate_passed(data):
            failures.append(f"prior gate evidence is not passing for {gate_id}")
    return failures


def _approval_evidence(
    args: argparse.Namespace,
    manifest: dict[str, Any],
    manifest_hash: str,
    approved_at: str,
    rollback_plan: dict[str, str],
    release_notes: dict[str, str],
    owner_proof: dict[str, str],
    promotion_proof: dict[str, str],
    prior_gates: list[dict[str, str]],
) -> dict[str, Any]:
    source_commit = str(manifest.get("source", {}).get("commit") or "")
    version = str(manifest.get("version") or "")
    snapshot = {
        "captured_at_utc": approved_at,
        "artifact_set_id": args.artifact_set_id,
        "release_candidate_id": args.release_candidate_id,
        "signed_candidate_workflow_run_id": args.signed_candidate_workflow_run_id,
        "verdict": "READY_FOR_SHIP",
    }
    return {
        "schema_version": 1,
        "approver": args.approver,
        "approved_at_utc": approved_at,
        "release_channel": args.release_channel,
        "artifact_set_id": args.artifact_set_id,
        "release_manifest_sha256": manifest_hash,
        "version": version,
        "source_commit": source_commit,
        "prior_gate_snapshot": snapshot,
        "prior_gates": prior_gates,
        "review": {
            "reviewer": args.approver,
            "reviewed_at_utc": approved_at,
            "release_manifest_sha256": manifest_hash,
            "source_commit": source_commit,
            "version": version,
            "release_channel": args.release_channel,
            "artifact_set_id": args.artifact_set_id,
            "prior_gate_snapshot_captured_at_utc": approved_at,
            "release_candidate_id": args.release_candidate_id,
            "signed_candidate_workflow_run_id": args.signed_candidate_workflow_run_id,
            "release_owner_approval": True,
            "artifact_promotion_locked": True,
            "rollback_plan_reviewed": True,
            "docs_release_notes_reviewed": True,
            "known_limitations_reviewed": True,
            "no_open_blocking_gates": True,
            "rollback_plan_path": rollback_plan["path"],
            "rollback_plan_sha256": rollback_plan["sha256"],
            "release_notes_path": release_notes["path"],
            "release_notes_sha256": release_notes["sha256"],
        },
        "manual_validation": {
            "release_owner_approval": {
                "status": "pass",
                "reviewer": args.approver,
                "reviewed_at_utc": approved_at,
                "evidence": owner_proof["path"],
                "evidence_path": owner_proof["path"],
                "evidence_sha256": owner_proof["sha256"],
                "notes": "Release owner approved the immutable artifact set.",
                "release_owner_approval": True,
                "approver": args.approver,
                "release_manifest_sha256": manifest_hash,
                "artifact_set_id": args.artifact_set_id,
                "no_open_blocking_gates": True,
            },
            "artifact_promotion_lock": {
                "status": "pass",
                "reviewer": args.approver,
                "reviewed_at_utc": approved_at,
                "evidence": promotion_proof["path"],
                "evidence_path": promotion_proof["path"],
                "evidence_sha256": promotion_proof["sha256"],
                "notes": "Promotion target points to immutable artifacts only.",
                "artifact_promotion_locked": True,
                "artifact_set_id": args.artifact_set_id,
                "promotion_target": args.release_channel,
                "immutable_storage": True,
                "replace_in_place_blocked": True,
            },
            "rollback_plan_review": {
                "status": "pass",
                "reviewer": args.approver,
                "reviewed_at_utc": approved_at,
                "evidence": rollback_plan["path"],
                "notes": "Rollback and downgrade path reviewed.",
                "rollback_plan_reviewed": True,
                "rollback_plan_path": rollback_plan["path"],
                "rollback_plan_sha256": rollback_plan["sha256"],
                "downgrade_or_rollback_path_reviewed": True,
                "rollback_owner": args.approver,
            },
            "docs_release_notes_review": {
                "status": "pass",
                "reviewer": args.approver,
                "reviewed_at_utc": approved_at,
                "evidence": release_notes["path"],
                "notes": "Release notes, known limitations and user docs reviewed.",
                "docs_release_notes_reviewed": True,
                "release_notes_path": release_notes["path"],
                "release_notes_sha256": release_notes["sha256"],
                "known_limitations_reviewed": True,
                "user_docs_reviewed": True,
            },
        },
    }


def _copy_prior_gates(root: Path, evidence_dir: Path, values: list[str]) -> list[dict[str, str]]:
    copied: list[dict[str, str]] = []
    by_gate = dict(_parse_prior_gate(raw) for raw in values)
    for gate_id in REQUIRED_GATE_IDS:
        retained = _copy_retained_file(root, evidence_dir, by_gate[gate_id], f"final/prior-gates/{gate_id.lower()}-evidence.json")
        copied.append(
            {
                "id": gate_id,
                "status": "pass",
                "evidence_path": retained["path"],
                "evidence_sha256": retained["sha256"],
                "captured_at_utc": _utc_now(),
            }
        )
    return copied


def _parse_prior_gate(raw: str) -> tuple[str, Path]:
    if "=" not in raw:
        raise ValueError(f"invalid --prior-gate value: {raw}")
    gate_id, path = raw.split("=", 1)
    gate_id = gate_id.strip()
    path = path.strip()
    if not gate_id or not path:
        raise ValueError(f"invalid --prior-gate value: {raw}")
    return gate_id, Path(path).resolve()


def _prior_gate_passed(data: dict[str, Any]) -> bool:
    status = str(data.get("status") or data.get("verdict") or "").lower()
    return data.get("release_gate_ready") is True or status in {"pass", "passed", "ready_for_ship"}


def _copy_retained_file(root: Path, evidence_dir: Path, source: Path, target_name: str) -> dict[str, str]:
    source = source.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    target = (evidence_dir / target_name).resolve()
    _require_inside(root, target, "retained evidence file")
    target.parent.mkdir(parents=True, exist_ok=True)
    if source != target:
        shutil.copy2(source, target)
    return {"path": _relative(root, target), "sha256": _sha256(target)}


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


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _relative(base: Path, path: Path) -> str:
    return path.resolve().relative_to(base.resolve()).as_posix()


def _require_inside(root: Path, path: Path, label: str) -> None:
    try:
        path.resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside repository root: {path}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
