"""Create and verify deterministic release evidence for Arforge artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid5


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / "dist"
LOCKFILE = ROOT / "requirements-release.lock"
CHECKSUM_FILE = "SHA256SUMS"
MANIFEST_FILE = "release-manifest.json"
SBOM_FILE = "arforge-agent.cdx.json"
ARTIFACT_SUFFIXES = (".whl", ".tar.gz", ".tgz")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _version() -> str:
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.10
        import tomli as tomllib

    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return str(project["project"]["version"])


def _git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _timestamp() -> str:
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if not epoch:
        epoch = _git(["show", "-s", "--format=%ct", "HEAD"])
    if epoch:
        value = datetime.fromtimestamp(int(epoch), tz=timezone.utc)
    else:
        value = datetime.now(timezone.utc)
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _locked_components(lockfile: Path) -> list[dict[str, object]]:
    pattern = re.compile(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)")
    components: list[dict[str, object]] = []
    for line in lockfile.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if not match:
            continue
        name, version = match.groups()
        canonical = name.lower().replace("_", "-")
        purl = f"pkg:pypi/{quote(canonical)}@{quote(version)}"
        components.append(
            {
                "type": "library",
                "bom-ref": purl,
                "name": canonical,
                "version": version,
                "purl": purl,
            }
        )
    return sorted(components, key=lambda item: str(item["name"]))


def _write_sbom(dist: Path, version: str) -> Path:
    lock_digest = _sha256(LOCKFILE)
    root_ref = f"pkg:pypi/arforge-agent@{quote(version)}"
    components = _locked_components(LOCKFILE)
    sbom = {
        "$schema": "https://cyclonedx.org/schema/bom-1.6.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{uuid5(NAMESPACE_URL, f'arforge:{version}:{lock_digest}')}",
        "version": 1,
        "metadata": {
            "timestamp": _timestamp(),
            "component": {
                "type": "application",
                "bom-ref": root_ref,
                "name": "arforge-agent",
                "version": version,
                "purl": root_ref,
            },
            "properties": [
                {"name": "arforge:lockfile", "value": LOCKFILE.name},
                {"name": "arforge:lockfile:sha256", "value": lock_digest},
            ],
        },
        "components": components,
        "dependencies": [
            {"ref": root_ref, "dependsOn": [item["bom-ref"] for item in components]}
        ],
    }
    path = dist / SBOM_FILE
    path.write_text(json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _artifact_files(dist: Path) -> list[Path]:
    return sorted(
        path
        for path in dist.iterdir()
        if path.is_file() and path.name.endswith(ARTIFACT_SUFFIXES)
    )


def create_evidence(dist: Path, *, require_clean: bool = False) -> dict[str, object]:
    dist.mkdir(parents=True, exist_ok=True)
    artifacts = _artifact_files(dist)
    if not artifacts:
        raise ValueError(f"no wheel, sdist or npm tarball found in {dist}")
    if not LOCKFILE.is_file():
        raise ValueError(f"release lockfile missing: {LOCKFILE}")

    version = _version()
    sbom = _write_sbom(dist, version)
    checksummed = [*artifacts, sbom]
    entries = [
        {"name": path.name, "bytes": path.stat().st_size, "sha256": _sha256(path)}
        for path in checksummed
    ]
    dirty = bool(_git(["status", "--porcelain=v1"]))
    if require_clean and dirty:
        raise ValueError("release evidence requires a clean Git working tree")
    commit = os.environ.get("GITHUB_SHA") or _git(["rev-parse", "HEAD"])
    manifest = {
        "schema_version": 1,
        "product": "Arforge Agent",
        "version": version,
        "created_at": _timestamp(),
        "source": {"commit": commit or "unknown", "dirty": dirty},
        "lockfile": {"name": LOCKFILE.name, "sha256": _sha256(LOCKFILE)},
        "files": entries,
    }
    manifest_path = dist / MANIFEST_FILE
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    checksum_paths = [*checksummed, manifest_path]
    (dist / CHECKSUM_FILE).write_text(
        "".join(f"{_sha256(path)}  {path.name}\n" for path in checksum_paths),
        encoding="utf-8",
    )
    return manifest


def verify_evidence(dist: Path) -> list[str]:
    checksum_path = dist / CHECKSUM_FILE
    if not checksum_path.is_file():
        raise ValueError(f"checksum file missing: {checksum_path}")
    verified: list[str] = []
    for number, line in enumerate(
        checksum_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\]+)", line)
        if not match:
            raise ValueError(f"invalid checksum line {number}")
        expected, name = match.groups()
        target = dist / name
        if not target.is_file():
            raise ValueError(f"checksummed file missing: {name}")
        actual = _sha256(target)
        if actual != expected:
            raise ValueError(f"checksum mismatch: {name}")
        verified.append(name)
    return verified


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument(
        "--require-clean",
        action="store_true",
        help="refuse to create release evidence from a dirty Git tree",
    )
    args = parser.parse_args()
    try:
        if args.verify:
            files = verify_evidence(args.dist.resolve())
            print(f"Verified {len(files)} release evidence files.")
        else:
            manifest = create_evidence(
                args.dist.resolve(), require_clean=args.require_clean
            )
            print(f"Created release evidence for {len(manifest['files'])} artifacts.")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
