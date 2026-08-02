"""Create and verify fail-closed evidence for an internal Windows Alpha installer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INSTALLER = ROOT / "packages" / "desktop" / "dist" / "arforge-desktop-win-x64.exe"
MANIFEST_FILE = "internal-alpha-manifest.json"
CHECKSUM_FILE = "SHA256SUMS.internal-alpha"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _timestamp() -> str:
    epoch = os.environ.get("SOURCE_DATE_EPOCH") or _git(
        ["show", "-s", "--format=%ct", "HEAD"]
    )
    value = (
        datetime.fromtimestamp(int(epoch), tz=timezone.utc)
        if epoch
        else datetime.now(timezone.utc)
    )
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _desktop_version() -> str:
    package = json.loads((ROOT / "packages" / "desktop" / "package.json").read_text(encoding="utf-8"))
    return str(package["version"])


def create_alpha_evidence(
    installer: Path,
    output_dir: Path,
    *,
    require_clean: bool = False,
) -> dict[str, Any]:
    installer = installer.resolve()
    output_dir = output_dir.resolve()
    if not installer.is_file() or installer.suffix.lower() != ".exe":
        raise ValueError(f"Windows installer missing or invalid: {installer}")
    if installer.parent != output_dir:
        raise ValueError("installer and Alpha evidence must share one directory")

    dirty = bool(_git(["status", "--porcelain=v1"]))
    if require_clean and dirty:
        raise ValueError("internal Alpha evidence requires a clean Git working tree")

    artifact = {
        "name": installer.name,
        "bytes": installer.stat().st_size,
        "sha256": _sha256(installer),
        "signature": {"required": False, "status": "unsigned"},
    }
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "release_stage": "internal-alpha",
        "distribution": "internal-only",
        "product": "Arforge Desktop",
        "version": _desktop_version(),
        "channel": "dev",
        "created_at": _timestamp(),
        "source": {
            "commit": os.environ.get("GITHUB_SHA") or _git(["rev-parse", "HEAD"]) or "unknown",
            "dirty": dirty,
        },
        "artifact": artifact,
        "limitations": [
            "unsigned-installer",
            "automatic-updates-disabled",
            "not-for-public-distribution",
        ],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / MANIFEST_FILE
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / CHECKSUM_FILE).write_text(
        f"{artifact['sha256']}  {installer.name}\n{_sha256(manifest_path)}  {MANIFEST_FILE}\n",
        encoding="utf-8",
    )
    return manifest


def verify_alpha_evidence(output_dir: Path) -> list[str]:
    output_dir = output_dir.resolve()
    checksum_path = output_dir / CHECKSUM_FILE
    manifest_path = output_dir / MANIFEST_FILE
    if not checksum_path.is_file() or not manifest_path.is_file():
        raise ValueError("internal Alpha manifest or checksum file is missing")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("release_stage") != "internal-alpha":
        raise ValueError("manifest is not an internal Alpha release")
    if manifest.get("distribution") != "internal-only":
        raise ValueError("manifest does not restrict distribution to internal users")
    signature = manifest.get("artifact", {}).get("signature", {})
    if signature != {"required": False, "status": "unsigned"}:
        raise ValueError("internal Alpha signature declaration is invalid")

    verified: list[str] = []
    for number, line in enumerate(checksum_path.read_text(encoding="utf-8").splitlines(), start=1):
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\]+)", line)
        if not match:
            raise ValueError(f"invalid checksum line {number}")
        expected, name = match.groups()
        target = output_dir / name
        if not target.is_file():
            raise ValueError(f"checksummed file missing: {name}")
        if _sha256(target) != expected:
            raise ValueError(f"checksum mismatch: {name}")
        verified.append(name)

    artifact = manifest.get("artifact", {})
    artifact_name = str(artifact.get("name") or "")
    if artifact_name not in verified:
        raise ValueError("manifest artifact is not covered by checksums")
    artifact_path = output_dir / artifact_name
    if artifact.get("bytes") != artifact_path.stat().st_size:
        raise ValueError("manifest artifact size does not match the retained file")
    if artifact.get("sha256") != _sha256(artifact_path):
        raise ValueError("manifest artifact hash does not match the retained file")
    return verified


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, default=DEFAULT_INSTALLER)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--require-clean", action="store_true")
    args = parser.parse_args()
    output_dir = (args.output_dir or args.installer.parent).resolve()
    try:
        if args.verify:
            files = verify_alpha_evidence(output_dir)
            print(f"Verified {len(files)} internal Alpha evidence files.")
        else:
            manifest = create_alpha_evidence(
                args.installer, output_dir, require_clean=args.require_clean
            )
            print(
                f"Created internal Alpha evidence for {manifest['artifact']['name']} "
                f"({manifest['artifact']['sha256']})."
            )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
