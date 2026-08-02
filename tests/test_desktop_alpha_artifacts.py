"""Internal Desktop Alpha release evidence tests."""

from __future__ import annotations

import json

import pytest

import scripts.desktop_alpha_artifacts as alpha


def test_alpha_evidence_binds_unsigned_installer_to_source(tmp_path, monkeypatch):
    installer = tmp_path / "arforge-desktop-win-x64.exe"
    installer.write_bytes(b"alpha-installer")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "0")
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setattr(
        alpha,
        "_git",
        lambda args: " M local-change" if args[:2] == ["status", "--porcelain=v1"] else "",
    )

    manifest = alpha.create_alpha_evidence(installer, tmp_path)

    assert manifest["release_stage"] == "internal-alpha"
    assert manifest["distribution"] == "internal-only"
    assert manifest["source"] == {"commit": "a" * 40, "dirty": True}
    assert manifest["artifact"]["signature"] == {"required": False, "status": "unsigned"}
    assert "not-for-public-distribution" in manifest["limitations"]
    assert set(alpha.verify_alpha_evidence(tmp_path)) == {
        installer.name,
        alpha.MANIFEST_FILE,
    }


def test_alpha_evidence_rejects_dirty_release_source(tmp_path, monkeypatch):
    installer = tmp_path / "arforge-desktop-win-x64.exe"
    installer.write_bytes(b"alpha-installer")
    monkeypatch.setattr(alpha, "_git", lambda _args: " M local-change")

    with pytest.raises(ValueError, match="clean Git working tree"):
        alpha.create_alpha_evidence(installer, tmp_path, require_clean=True)


def test_alpha_verifier_rejects_installer_tampering(tmp_path, monkeypatch):
    installer = tmp_path / "arforge-desktop-win-x64.exe"
    installer.write_bytes(b"original")
    monkeypatch.setattr(alpha, "_git", lambda _args: "")
    alpha.create_alpha_evidence(installer, tmp_path)
    installer.write_bytes(b"tampered")

    with pytest.raises(ValueError, match="checksum mismatch"):
        alpha.verify_alpha_evidence(tmp_path)


def test_alpha_verifier_rejects_public_or_signed_manifest_relabeling(tmp_path, monkeypatch):
    installer = tmp_path / "arforge-desktop-win-x64.exe"
    installer.write_bytes(b"alpha-installer")
    monkeypatch.setattr(alpha, "_git", lambda _args: "")
    alpha.create_alpha_evidence(installer, tmp_path)
    manifest_path = tmp_path / alpha.MANIFEST_FILE
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["distribution"] = "public"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="restrict distribution"):
        alpha.verify_alpha_evidence(tmp_path)


def test_alpha_verifier_rejects_checksum_path_traversal(tmp_path):
    (tmp_path / alpha.MANIFEST_FILE).write_text("{}", encoding="utf-8")
    (tmp_path / alpha.CHECKSUM_FILE).write_text(
        "0" * 64 + "  ../outside.exe\n", encoding="utf-8"
    )

    with pytest.raises(ValueError, match="manifest is not an internal Alpha release|invalid checksum"):
        alpha.verify_alpha_evidence(tmp_path)
