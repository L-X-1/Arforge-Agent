"""Draft release evidence templates for Stage 5 gates."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


_DRAFT_SHA = "<64-char-sha256-of-retained-file>"
_DRAFT_COMMIT = "<git-commit-sha>"
_DRAFT_TIME = "<yyyy-mm-ddThh:mm:ssZ>"
_DRAFT_RUN = "<github-actions-run-id>"
_DRAFT_CANDIDATE = "<release-candidate-id>"
_DRAFT_ARTIFACT_SET = "<artifact-set-id>"
_DRAFT_REVIEWER = "<release-owner>"


def _manual_review(evidence_path: str) -> dict[str, Any]:
    return {
        "status": "draft",
        "reviewer": _DRAFT_REVIEWER,
        "reviewed_at_utc": _DRAFT_TIME,
        "evidence": "<human-readable evidence summary>",
        "notes": "<review notes>",
        "evidence_path": evidence_path,
        "evidence_sha256": _DRAFT_SHA,
    }


def _a11y_review(evidence_path: str, duration_minutes: int) -> dict[str, Any]:
    return {
        "status": "draft",
        "evidence": evidence_path,
        "evidence_path": evidence_path,
        "evidence_sha256": _DRAFT_SHA,
        "notes": "<native validation notes>",
        "duration_minutes": duration_minutes,
    }


def _signed_artifact(path: str) -> dict[str, Any]:
    return {
        "name": path,
        "sha256": _DRAFT_SHA,
        "signature_status": "Valid",
        "timestamped": True,
        "timestamp_proof_path": f"{path}.timestamp.txt",
        "timestamp_proof_sha256": _DRAFT_SHA,
        "signer_subject": "<code-signing-subject>",
        "signer_thumbprint": "<certificate-thumbprint>",
        "timestamp_subject": "<timestamp-authority-subject>",
    }


def _upgrade_artifact(role: str, version: str) -> dict[str, Any]:
    return {
        "version": version,
        "workflow_run_id": f"{_DRAFT_RUN}-{role}",
        "artifact_name": f"Arforge-Agent-{version}.msi",
        "sha256": _DRAFT_SHA,
        "sha256_reviewed": True,
        "signature_status": "Valid",
        "timestamped": True,
    }


def _prior_gate(gate_id: str) -> dict[str, Any]:
    return {
        "id": gate_id,
        "status": "pass",
        "captured_at_utc": _DRAFT_TIME,
        "evidence_path": f"desktop/release-evidence/{gate_id.lower()}-audit.json",
        "evidence_sha256": _DRAFT_SHA,
    }


_TEMPLATES: dict[str, dict[str, Any]] = {
    "installer": {
        "filename": "desktop-installer-evidence.template.json",
        "description": "Protected Desktop installer lifecycle evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "reviewer": _DRAFT_REVIEWER,
            "reviewed_at_utc": _DRAFT_TIME,
            "workflow_run_id": _DRAFT_RUN,
            "protected_environment": "desktop-release-candidate",
            "uac_elevated": True,
            "all_users_msi": True,
            "program_files_install_reviewed": True,
            "msi": {
                "install_exit_code": 0,
                "uninstall_exit_code": 0,
                "sidecar_started": True,
                "profile_preserved_after_uninstall": True,
                "profile_marker_path": "desktop/release-evidence/profile-marker.txt",
                "profile_marker_sha256": _DRAFT_SHA,
            },
            "artifacts": [
                {
                    "path": "desktop/release-evidence/Arforge-Agent-<version>.msi",
                    "size_bytes": 0,
                    "sha256": _DRAFT_SHA,
                },
                {
                    "path": "desktop/release-evidence/Arforge-Agent-<version>-setup.exe",
                    "size_bytes": 0,
                    "sha256": _DRAFT_SHA,
                },
            ],
            "manual_validation": {
                "protected_runner_review": _manual_review(
                    "desktop/release-evidence/protected-runner-review.txt"
                ),
                "installer_log_review": {
                    **_manual_review(
                        "desktop/release-evidence/installer-log-review.txt"
                    ),
                    "install_log_sha256": _DRAFT_SHA,
                    "uninstall_log_sha256": _DRAFT_SHA,
                    "install_log_reviewed": True,
                    "uninstall_log_reviewed": True,
                },
            },
        },
    },
    "signing": {
        "filename": "signed-candidate.template.json",
        "description": "Authenticode signed candidate and RFC 3161 timestamp evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "workflow_run_url": "https://github.com/<owner>/<repo>/actions/runs/<run-id>",
            "workflow_run_id": _DRAFT_RUN,
            "commit": _DRAFT_COMMIT,
            "protected_environment": "desktop-release-candidate",
            "required_reviewers_approved": True,
            "signing_material_removed": True,
            "review": {
                "reviewer": _DRAFT_REVIEWER,
                "reviewed_at_utc": _DRAFT_TIME,
                "workflow_run_id": _DRAFT_RUN,
                "protected_environment": "desktop-release-candidate",
                "required_reviewers_approved": True,
                "certificate_provenance_reviewed": True,
                "signer_thumbprint": "<certificate-thumbprint>",
                "timestamp_subject": "<timestamp-authority-subject>",
            },
            "artifacts": [
                _signed_artifact(
                    "desktop/release-evidence/Arforge-Agent-<version>.msi"
                ),
                _signed_artifact(
                    "desktop/release-evidence/Arforge-Agent-<version>-setup.exe"
                ),
            ],
            "manual_validation": {
                "release_environment_review": {
                    **_manual_review(
                        "desktop/release-evidence/release-environment-review.txt"
                    ),
                    "protected_environment": "desktop-release-candidate",
                    "required_reviewers_approved": True,
                    "workflow_run_reviewed": True,
                    "signing_material_removed": True,
                },
                "certificate_provenance_review": {
                    **_manual_review(
                        "desktop/release-evidence/certificate-provenance-review.txt"
                    ),
                    "certificate_provenance_reviewed": True,
                    "signer_thumbprint": "<certificate-thumbprint>",
                    "custody_record": "<ticket-or-vault-record>",
                    "private_key_export_blocked": True,
                },
            },
        },
    },
    "upgrade": {
        "filename": "desktop-upgrade-evidence.template.json",
        "description": "Signed upgrade, downgrade and profile preservation evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "baseline": _upgrade_artifact("baseline", "<previous-version>"),
            "candidate": _upgrade_artifact("candidate", "<candidate-version>"),
            "version_ordered": True,
            "downgrade_rejected": True,
            "profile": {
                "profile_preserved_through_upgrade": True,
                "preserved_after_uninstall": True,
                "profile_marker_path": "desktop/release-evidence/upgrade-profile-marker.txt",
                "profile_marker_sha256": _DRAFT_SHA,
            },
            "uninstall_cleanup_reviewed": True,
            "review": {
                "reviewer": _DRAFT_REVIEWER,
                "reviewed_at_utc": _DRAFT_TIME,
                "baseline_workflow_run_id": _DRAFT_RUN,
                "candidate_workflow_run_id": _DRAFT_RUN,
                "profile_marker_path": "desktop/release-evidence/upgrade-profile-marker.txt",
                "profile_marker_sha256": _DRAFT_SHA,
                "version_ordered": True,
                "downgrade_rejected": True,
                "uninstall_cleanup_reviewed": True,
            },
            "manual_validation": {
                "release_owner_review": _manual_review(
                    "desktop/release-evidence/upgrade-release-owner-review.txt"
                ),
                "profile_preservation_review": {
                    **_manual_review(
                        "desktop/release-evidence/upgrade-profile-review.txt"
                    ),
                    "profile_preserved_through_upgrade": True,
                    "profile_marker_path": "desktop/release-evidence/upgrade-profile-marker.txt",
                    "profile_marker_sha256": _DRAFT_SHA,
                    "preserved_after_uninstall": True,
                    "uninstall_cleanup_reviewed": True,
                },
            },
        },
    },
    "accessibility": {
        "filename": "accessibility.template.json",
        "description": "Native Desktop accessibility validation evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "reviewer": _DRAFT_REVIEWER,
            "validated_at_utc": _DRAFT_TIME,
            "evidence": "desktop/release-evidence/accessibility-<date>.json",
            "desktop_artifact": {
                "name": "Arforge-Agent-<version>.msi",
                "sha256": _DRAFT_SHA,
                "signed_candidate_workflow_run_id": _DRAFT_RUN,
                "signed_candidate_commit": _DRAFT_COMMIT,
                "signature_status": "Valid",
                "timestamped": True,
            },
            "environment": {
                "os": "Windows 11 <version>",
                "screen_reader": "NVDA <version>",
                "display_scaling_tested": [125, 150, 200],
            },
            "manual_validation": {
                "keyboard_navigation": _a11y_review(
                    "desktop/release-evidence/a11y-keyboard.txt", 12
                ),
                "screen_reader": {
                    **_a11y_review(
                        "desktop/release-evidence/a11y-screen-reader.txt", 15
                    ),
                    "tool": "NVDA <version>",
                },
                "scaling_125": {
                    **_a11y_review("desktop/release-evidence/a11y-scale-125.png", 5),
                    "scale_percent": 125,
                },
                "scaling_150": {
                    **_a11y_review("desktop/release-evidence/a11y-scale-150.png", 5),
                    "scale_percent": 150,
                },
                "scaling_200": {
                    **_a11y_review("desktop/release-evidence/a11y-scale-200.png", 5),
                    "scale_percent": 200,
                },
            },
        },
    },
    "governance": {
        "filename": "credential-cleanup.template.json",
        "description": "Credential, PostgreSQL restore and Git governance evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "reviewer": _DRAFT_REVIEWER,
            "reviewed_at_utc": _DRAFT_TIME,
            "source_commit": _DRAFT_COMMIT,
            "git_remote_url": "https://github.com/<owner>/<repo>.git",
            "postgres_restore": {
                "completed_at_utc": _DRAFT_TIME,
                "target_database": "<isolated-restore-db>",
                "backup_path": "desktop/release-evidence/postgres-backup.dump",
                "backup_sha256": _DRAFT_SHA,
                "catalog_verified": True,
                "schema_match": True,
                "table_counts_match": True,
                "representative_records_match": True,
            },
            "manual_validation": {
                "credential_rotation": _manual_review(
                    "desktop/release-evidence/credential-rotation-review.txt"
                ),
                "external_copies_review": _manual_review(
                    "desktop/release-evidence/external-copies-review.txt"
                ),
                "protected_remote_review": _manual_review(
                    "desktop/release-evidence/protected-remote-review.txt"
                ),
                "legacy_files_decision": {
                    **_manual_review(
                        "desktop/release-evidence/legacy-files-decision.txt"
                    ),
                    "decisions": [
                        {
                            "path": "<root-anomaly-path>",
                            "decision": "keep|remove",
                            "reason": "<why>",
                        }
                    ],
                },
            },
        },
    },
    "staging": {
        "filename": "provider-staging-smoke.template.json",
        "description": "Provider staging, load and long-run dogfood evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "release_candidate_id": _DRAFT_CANDIDATE,
            "artifact_set_id": _DRAFT_ARTIFACT_SET,
            "signed_candidate_workflow_run_id": _DRAFT_RUN,
            "provider": "<provider>",
            "model": "<model>",
            "credential_scope": "staging-test-only",
            "run_id": "<provider-smoke-run-id>",
            "started_at_utc": _DRAFT_TIME,
            "completed_at_utc": _DRAFT_TIME,
            "failure_recovery": True,
            "evidence_paths": {
                "provider": "desktop/release-evidence/provider-staging-smoke.json",
                "staging": "desktop/release-evidence/staging-e2e.json",
                "load": "desktop/release-evidence/provider-load.json",
                "dogfood": "desktop/release-evidence/dogfood.json",
            },
            "evidence_sha256": {
                "provider": _DRAFT_SHA,
                "staging": _DRAFT_SHA,
                "load": _DRAFT_SHA,
                "dogfood": _DRAFT_SHA,
            },
            "manual_validation": {
                "release_owner_review": _manual_review(
                    "desktop/release-evidence/staging-release-owner-review.txt"
                ),
                "test_credentials_review": _manual_review(
                    "desktop/release-evidence/staging-test-credentials-review.txt"
                ),
            },
        },
    },
    "ship": {
        "filename": "ship-gate.template.json",
        "description": "Final immutable artifact Ship Gate approval evidence",
        "data": {
            "schema_version": 1,
            "status": "draft",
            "template_only": True,
            "approver": _DRAFT_REVIEWER,
            "approved_at_utc": _DRAFT_TIME,
            "release_channel": "internal|pre-release|stable",
            "artifact_set_id": _DRAFT_ARTIFACT_SET,
            "release_candidate_id": _DRAFT_CANDIDATE,
            "signed_candidate_workflow_run_id": _DRAFT_RUN,
            "version": "<version>",
            "source_commit": _DRAFT_COMMIT,
            "release_manifest_sha256": _DRAFT_SHA,
            "prior_gate_snapshot": {
                "captured_at_utc": _DRAFT_TIME,
                "verdict": "READY_FOR_SHIP",
                "artifact_set_id": _DRAFT_ARTIFACT_SET,
                "release_candidate_id": _DRAFT_CANDIDATE,
                "signed_candidate_workflow_run_id": _DRAFT_RUN,
                "gates": [
                    _prior_gate(gate_id)
                    for gate_id in (
                        "SIGN-01",
                        "SIGN-02",
                        "REL-01",
                        "UPGRADE-01",
                        "A11Y-01",
                        "GOV-01",
                        "STAGE-01",
                    )
                ],
            },
            "final_review": {
                "reviewer": _DRAFT_REVIEWER,
                "reviewed_at_utc": _DRAFT_TIME,
                "rollback_plan_path": "desktop/release-evidence/rollback-plan.md",
                "rollback_plan_sha256": _DRAFT_SHA,
                "release_notes_path": "desktop/release-evidence/release-notes.md",
                "release_notes_sha256": _DRAFT_SHA,
                "no_open_blocking_gates": True,
            },
            "manual_validation": {
                "release_owner_approval": _manual_review(
                    "desktop/release-evidence/final-release-owner-approval.txt"
                ),
                "artifact_promotion_lock": _manual_review(
                    "desktop/release-evidence/artifact-promotion-lock.txt"
                ),
                "rollback_plan_review": _manual_review(
                    "desktop/release-evidence/rollback-plan-review.txt"
                ),
                "docs_release_notes_review": _manual_review(
                    "desktop/release-evidence/docs-release-notes-review.txt"
                ),
            },
        },
    },
}


def available_evidence_templates() -> tuple[str, ...]:
    return tuple(sorted(_TEMPLATES))


def build_evidence_template(kind: str) -> dict[str, Any]:
    """Return a copy of a draft evidence template by kind."""
    key = kind.strip().lower()
    if key not in _TEMPLATES:
        raise ValueError(f"unknown evidence template: {kind}")
    template = _TEMPLATES[key]
    return {
        "kind": key,
        "description": template["description"],
        "default_filename": template["filename"],
        "data": copy.deepcopy(template["data"]),
    }


def default_template_path(root: Path, kind: str) -> Path:
    template = build_evidence_template(kind)
    return root / "desktop" / "release-evidence" / str(template["default_filename"])


def write_evidence_template(kind: str, path: str | Path) -> Path:
    template = build_evidence_template(kind)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(template["data"], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return target
