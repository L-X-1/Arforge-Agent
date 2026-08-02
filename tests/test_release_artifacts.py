"""Release evidence and integrity verification tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import scripts.release_artifacts as release_artifacts
from scripts.release_artifacts import (
    CHECKSUM_FILE,
    MANIFEST_FILE,
    SBOM_FILE,
    create_evidence,
    verify_evidence,
)


def test_release_evidence_contains_artifacts_lock_and_sbom(tmp_path, monkeypatch):
    (tmp_path / "arforge_agent-0.7.0-py3-none-any.whl").write_bytes(b"wheel")
    (tmp_path / "arforge-agent-0.7.0.tgz").write_bytes(b"npm")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "0")
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setattr(
        release_artifacts,
        "_git",
        lambda args: "dirty" if args[:2] == ["status", "--porcelain=v1"] else "",
    )

    manifest = create_evidence(tmp_path)

    assert manifest["source"] == {"commit": "a" * 40, "dirty": True}
    assert manifest["lockfile"]["name"] == "requirements-release.lock"
    assert {item["name"] for item in manifest["files"]} == {
        "arforge_agent-0.7.0-py3-none-any.whl",
        "arforge-agent-0.7.0.tgz",
        SBOM_FILE,
    }
    sbom = json.loads((tmp_path / SBOM_FILE).read_text(encoding="utf-8"))
    assert sbom["bomFormat"] == "CycloneDX"
    assert sbom["specVersion"] == "1.6"
    assert any(item["name"] == "sqlalchemy" for item in sbom["components"])
    assert (tmp_path / MANIFEST_FILE).is_file()
    assert verify_evidence(tmp_path)


def test_verify_evidence_rejects_tampering(tmp_path, monkeypatch):
    artifact = tmp_path / "arforge_agent-0.7.0-py3-none-any.whl"
    artifact.write_bytes(b"original")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "0")
    create_evidence(tmp_path)
    artifact.write_bytes(b"tampered")

    with pytest.raises(ValueError, match="checksum mismatch"):
        verify_evidence(tmp_path)


def test_verify_evidence_rejects_path_traversal(tmp_path):
    (tmp_path / CHECKSUM_FILE).write_text("0" * 64 + "  ../secret\n", encoding="utf-8")

    with pytest.raises(ValueError, match="invalid checksum line"):
        verify_evidence(tmp_path)


def test_release_evidence_can_require_clean_source(tmp_path, monkeypatch):
    (tmp_path / "arforge_agent-0.7.0-py3-none-any.whl").write_bytes(b"wheel")
    monkeypatch.setattr(
        release_artifacts,
        "_git",
        lambda args: " M README.md" if args[:2] == ["status", "--porcelain=v1"] else "",
    )

    with pytest.raises(ValueError, match="clean Git working tree"):
        create_evidence(tmp_path, require_clean=True)


def test_lockfiles_and_private_verifiers_enforce_hashed_installs():
    root = Path(__file__).resolve().parents[1]
    release_lock = (root / "requirements-release.lock").read_text(encoding="utf-8")
    development_lock = (root / "requirements-dev.lock").read_text(encoding="utf-8")
    verifier = (root / "scripts" / "release_artifacts.py").read_text(encoding="utf-8")

    assert "--hash=sha256:" in release_lock
    assert "--hash=sha256:" in development_lock
    assert "--require-clean" in verifier
    assert "--verify" in verifier
