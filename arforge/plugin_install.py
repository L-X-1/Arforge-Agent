"""Transactional installation and recovery for profile-scoped plugins.

The installer is deliberately separate from plugin discovery/loading. Inspecting
or installing a package never imports its Python entrypoint, and newly installed
code remains disabled until the user explicitly enables it.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arforge.database.sqlite_runtime import ProfileLockError, ProfileWriterLock
from arforge.mcp_http import PluginRegistry
from arforge.paths import get_arforge_home
from arforge.plugin_state import set_plugin_enabled


MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_FILES = 2_000
INSPECTION_TTL_SECONDS = 30 * 60
_SAFE_TOKEN = re.compile(r"^[a-f0-9]{32}$")
_SAFE_NAME = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_METADATA_FILE = ".arforge-install.json"


class PluginInstallError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_source_label(source: str) -> str:
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme.casefold() in {"http", "https"}:
        host = parsed.hostname or ""
        port = f":{parsed.port}" if parsed.port else ""
        path = urllib.parse.quote(urllib.parse.unquote(parsed.path), safe="/:@-._~")
        return urllib.parse.urlunsplit((parsed.scheme, f"{host}{port}", path, "", ""))
    return str(Path(source).expanduser().resolve())


def _ensure_public_https(source: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme.casefold() != "https" or not parsed.hostname:
        raise PluginInstallError("UNSAFE_PLUGIN_SOURCE", "remote plugin sources must use HTTPS")
    if parsed.username or parsed.password:
        raise PluginInstallError("UNSAFE_PLUGIN_SOURCE", "plugin source URLs cannot contain credentials")
    try:
        port = parsed.port or 443
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except ValueError:
        raise PluginInstallError("INVALID_PLUGIN_SOURCE", "plugin source URL has an invalid port") from None
    except OSError as exc:
        raise PluginInstallError("PLUGIN_SOURCE_UNAVAILABLE", f"plugin source host could not be resolved: {exc}") from None
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise PluginInstallError(
                "UNSAFE_PLUGIN_SOURCE",
                "remote plugin sources cannot resolve to loopback, private, or reserved addresses",
            )
    return parsed


def _reject_unsafe_tree(root: Path) -> None:
    count = 0
    total = 0
    for path in root.rglob("*"):
        count += 1
        if count > MAX_FILES:
            raise PluginInstallError("PLUGIN_PACKAGE_TOO_LARGE", f"plugin package exceeds {MAX_FILES} entries")
        try:
            details = path.lstat()
        except OSError as exc:
            raise PluginInstallError("INVALID_PLUGIN_PACKAGE", f"plugin package could not be inspected: {exc}") from None
        attributes = getattr(details, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        if path.is_symlink() or (reparse_flag and attributes & reparse_flag):
            raise PluginInstallError("UNSAFE_PLUGIN_PACKAGE", "plugin packages cannot contain links or reparse points")
        if path.is_file():
            total += details.st_size
            if total > MAX_EXPANDED_BYTES:
                raise PluginInstallError(
                    "PLUGIN_PACKAGE_TOO_LARGE",
                    f"expanded plugin package exceeds {MAX_EXPANDED_BYTES} bytes",
                )


def _extract_zip(archive: Path, destination: Path) -> None:
    total = 0
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > MAX_FILES:
            raise PluginInstallError("PLUGIN_PACKAGE_TOO_LARGE", f"plugin archive exceeds {MAX_FILES} entries")
        root = destination.resolve()
        for entry in entries:
            name = entry.filename.replace("\\", "/")
            if not name or name.endswith("/"):
                continue
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
                raise PluginInstallError("UNSAFE_PLUGIN_PACKAGE", "plugin archive contains an absolute path")
            parts = [part for part in name.split("/") if part]
            reserved = {
                "con", "prn", "aux", "nul",
                *(f"com{index}" for index in range(1, 10)),
                *(f"lpt{index}" for index in range(1, 10)),
            }
            if any(
                ":" in part or part.rstrip(" .").split(".", 1)[0].casefold() in reserved
                for part in parts
            ):
                raise PluginInstallError("UNSAFE_PLUGIN_PACKAGE", "plugin archive contains an unsafe Windows path")
            target = (destination / name).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                raise PluginInstallError("UNSAFE_PLUGIN_PACKAGE", "plugin archive contains path traversal") from None
            mode = (entry.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise PluginInstallError("UNSAFE_PLUGIN_PACKAGE", "plugin archive contains a symbolic link")
            total += entry.file_size
            if total > MAX_EXPANDED_BYTES:
                raise PluginInstallError(
                    "PLUGIN_PACKAGE_TOO_LARGE",
                    f"expanded plugin archive exceeds {MAX_EXPANDED_BYTES} bytes",
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.open(entry) as source_handle, target.open("wb") as target_handle:
                shutil.copyfileobj(source_handle, target_handle, length=1024 * 1024)


def _download_zip(source: str, target: Path) -> None:
    _ensure_public_https(source)
    request = urllib.request.Request(source, headers={"User-Agent": "Arforge-Agent"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            final_url = response.geturl()
            _ensure_public_https(final_url)
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_ARCHIVE_BYTES:
                raise PluginInstallError(
                    "PLUGIN_PACKAGE_TOO_LARGE",
                    f"plugin archive exceeds {MAX_ARCHIVE_BYTES} bytes",
                )
            total = 0
            with target.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARCHIVE_BYTES:
                        raise PluginInstallError(
                            "PLUGIN_PACKAGE_TOO_LARGE",
                            f"plugin archive exceeds {MAX_ARCHIVE_BYTES} bytes",
                        )
                    handle.write(chunk)
    except PluginInstallError:
        raise
    except (OSError, urllib.error.URLError, ValueError) as exc:
        raise PluginInstallError("PLUGIN_SOURCE_UNAVAILABLE", f"plugin archive download failed: {exc}") from None


def _clone_git(source: str, target: Path, *, ref: str = "") -> None:
    _ensure_public_https(source)
    environment = dict(os.environ)
    environment.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "credential.helper",
            "GIT_CONFIG_VALUE_0": "",
        }
    )
    command = ["git", "clone", "--depth", "1", "--no-tags"]
    if ref:
        command.extend(["--branch", ref, "--single-branch"])
    command.extend(["--", source, str(target)])
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PluginInstallError("PLUGIN_SOURCE_UNAVAILABLE", f"plugin repository clone failed: {exc}") from None
    if completed.returncode != 0:
        detail = " ".join((completed.stderr or completed.stdout).split())[:500]
        raise PluginInstallError("PLUGIN_SOURCE_UNAVAILABLE", f"plugin repository clone failed: {detail}")
    git_metadata = target / ".git"
    if git_metadata.exists():
        shutil.rmtree(git_metadata)


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix()
        if relative == _METADATA_FILE:
            continue
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


class PluginInstallRuntime:
    """Stage, validate, atomically install, update, remove and restore plugins."""

    def __init__(self, profile_root: Path | None = None):
        self.profile_root = (profile_root or get_arforge_home()).expanduser().resolve()
        self.plugins_root = self.profile_root / "plugins"
        self.cache_root = self.profile_root / "cache" / "plugin-installs"
        self.trash_root = self.profile_root / "plugin-trash"

    def inspect(self, source: str) -> dict[str, Any]:
        normalized = str(source or "").strip()
        if not normalized or len(normalized) > 4_096:
            raise PluginInstallError("INVALID_PLUGIN_SOURCE", "plugin source must be a non-empty path or HTTPS URL")
        self._prune_expired()
        token = uuid.uuid4().hex
        inspection = self.cache_root / token
        payload_root = inspection / "payload"
        inspection.mkdir(parents=True, exist_ok=False)
        try:
            self._materialize(normalized, payload_root, inspection)
            _reject_unsafe_tree(payload_root)
            candidates = self._candidates(payload_root)
            metadata = {
                "token": token,
                "created_at": _utc_now(),
                "created_epoch": time.time(),
                "source": _safe_source_label(normalized),
                "candidates": candidates,
            }
            (inspection / "inspection.json").write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return {
                "token": token,
                "source": metadata["source"],
                "expires_in_seconds": INSPECTION_TTL_SECONDS,
                "selection_required": len(candidates) > 1,
                "candidates": [{key: value for key, value in item.items() if key != "relative_path"} for item in candidates],
            }
        except Exception:
            shutil.rmtree(inspection, ignore_errors=True)
            raise

    def apply(self, token: str, plugin_name: str = "", *, replace: bool = False) -> dict[str, Any]:
        try:
            with ProfileWriterLock(self.profile_root / "config" / "plugin-install.lock"):
                return self._apply(token, plugin_name, replace=replace)
        except ProfileLockError:
            raise PluginInstallError("PLUGIN_INSTALL_BUSY", "another plugin transaction is already running") from None

    def _apply(self, token: str, plugin_name: str = "", *, replace: bool = False) -> dict[str, Any]:
        inspection, metadata = self._load_inspection(token)
        candidates = metadata["candidates"]
        selected_name = str(plugin_name or "").strip().casefold()
        if selected_name:
            matches = [item for item in candidates if item["name"].casefold() == selected_name]
        elif len(candidates) == 1:
            matches = [candidates[0]]
        else:
            raise PluginInstallError("PLUGIN_SELECTION_REQUIRED", "select one plugin from the inspected package")
        if len(matches) != 1:
            raise PluginInstallError("PLUGIN_NOT_FOUND", f"inspected package does not contain plugin: {plugin_name}")
        selected = matches[0]
        name = selected["name"]
        source_dir = (inspection / "payload" / selected["relative_path"]).resolve()
        try:
            source_dir.relative_to((inspection / "payload").resolve())
        except ValueError:
            raise PluginInstallError("INVALID_INSPECTION", "inspection candidate escaped its staging directory") from None
        _reject_unsafe_tree(source_dir)
        if _tree_digest(source_dir) != selected.get("sha256"):
            raise PluginInstallError(
                "INSPECTION_CHANGED",
                "inspected plugin files changed before installation; inspect the package again",
            )
        self.plugins_root.mkdir(parents=True, exist_ok=True)
        target = self.plugins_root / name
        stage = self.plugins_root / f".install-{token}-{name}"
        backup = self.plugins_root / f".backup-{token}-{name}"
        if target.exists() and not replace:
            raise PluginInstallError("PLUGIN_ALREADY_INSTALLED", f"plugin is already installed: {name}")
        if replace and not target.exists():
            raise PluginInstallError("PLUGIN_NOT_INSTALLED", f"plugin is not installed and cannot be updated: {name}")
        if target.exists() and not (target / "plugin.json").is_file():
            raise PluginInstallError(
                "PLUGIN_TARGET_CONFLICT",
                f"profile plugin target exists without a valid manifest: {name}",
            )
        if stage.exists() or backup.exists():
            raise PluginInstallError("PLUGIN_INSTALL_BUSY", "a plugin transaction with this token already exists")
        shutil.copytree(source_dir, stage)
        try:
            if _tree_digest(stage) != selected.get("sha256"):
                raise PluginInstallError(
                    "INSPECTION_CHANGED",
                    "plugin files changed while staging; inspect the package again",
                )
            validation = PluginRegistry().discover([self.plugins_root], {})
            staged = next(
                (item for item in validation["items"] if Path(item["manifest_path"]).parent == stage),
                None,
            )
            if staged is None or staged["problems"]:
                detail = ", ".join(staged["problems"]) if staged else "staged manifest was not discoverable"
                raise PluginInstallError("INVALID_PLUGIN_MANIFEST", detail)
            metadata_path = stage / _METADATA_FILE
            metadata_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "source": metadata["source"],
                        "installed_at": _utc_now(),
                        "sha256": _tree_digest(stage),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            if target.exists():
                target.replace(backup)
            try:
                stage.replace(target)
            except Exception:
                if backup.exists() and not target.exists():
                    backup.replace(target)
                raise
            if backup.exists():
                recovery = self._move_to_trash(backup, name, reason="update")
            else:
                recovery = None
            set_plugin_enabled(target / "plugin.json", False)
            shutil.rmtree(inspection, ignore_errors=True)
            return {
                "name": name,
                "version": selected["version"],
                "path": str(target),
                "source": metadata["source"],
                "sha256": _tree_digest(target),
                "enabled": False,
                "updated": bool(replace),
                "recovery": recovery,
            }
        except PluginInstallError:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        except OSError as exc:
            shutil.rmtree(stage, ignore_errors=True)
            raise PluginInstallError("PLUGIN_INSTALL_FAILED", f"plugin transaction failed: {exc}") from None

    def remove(self, name: str) -> dict[str, Any]:
        try:
            with ProfileWriterLock(self.profile_root / "config" / "plugin-install.lock"):
                return self._remove(name)
        except ProfileLockError:
            raise PluginInstallError("PLUGIN_INSTALL_BUSY", "another plugin transaction is already running") from None

    def _remove(self, name: str) -> dict[str, Any]:
        normalized = str(name or "").strip().casefold()
        if not _SAFE_NAME.fullmatch(normalized):
            raise PluginInstallError("INVALID_PLUGIN_NAME", "plugin name must be lowercase and URL-safe")
        target = (self.plugins_root / normalized).resolve()
        try:
            target.relative_to(self.plugins_root.resolve())
        except ValueError:
            raise PluginInstallError("INVALID_PLUGIN_NAME", "plugin path escaped the profile plugin root") from None
        if not (target / "plugin.json").is_file():
            raise PluginInstallError("PLUGIN_NOT_FOUND", f"managed plugin was not found: {normalized}")
        set_plugin_enabled(target / "plugin.json", False)
        recovery = self._move_to_trash(target, normalized, reason="remove")
        return {"name": normalized, "removed": True, "recoverable": True, "recovery": recovery}

    def restore(self, recovery_id: str) -> dict[str, Any]:
        try:
            with ProfileWriterLock(self.profile_root / "config" / "plugin-install.lock"):
                return self._restore(recovery_id)
        except ProfileLockError:
            raise PluginInstallError("PLUGIN_INSTALL_BUSY", "another plugin transaction is already running") from None

    def _restore(self, recovery_id: str) -> dict[str, Any]:
        recovery = str(recovery_id or "").strip()
        if not re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}-\d{8}T\d{6}-[a-f0-9]{8}", recovery):
            raise PluginInstallError("INVALID_RECOVERY_ID", "invalid plugin recovery identifier")
        source = (self.trash_root / recovery).resolve()
        try:
            source.relative_to(self.trash_root.resolve())
        except ValueError:
            raise PluginInstallError("INVALID_RECOVERY_ID", "recovery path escaped the plugin trash root") from None
        metadata_path = source / ".recovery.json"
        try:
            recovery_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise PluginInstallError("RECOVERY_NOT_FOUND", "plugin recovery entry was not found") from None
        name = recovery_metadata.get("name")
        if not isinstance(name, str) or not _SAFE_NAME.fullmatch(name):
            raise PluginInstallError("INVALID_RECOVERY", "plugin recovery metadata is invalid")
        target = self.plugins_root / name
        if target.exists():
            raise PluginInstallError("PLUGIN_ALREADY_INSTALLED", f"plugin is already installed: {name}")
        metadata_path.unlink()
        try:
            source.replace(target)
        except OSError as exc:
            metadata_path.write_text(json.dumps(recovery_metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            raise PluginInstallError("PLUGIN_RESTORE_FAILED", f"plugin restore failed: {exc}") from None
        set_plugin_enabled(target / "plugin.json", False)
        return {"name": name, "restored": True, "path": str(target), "enabled": False}

    def _materialize(self, source: str, payload_root: Path, inspection: Path) -> None:
        parsed = urllib.parse.urlsplit(source)
        if parsed.scheme.casefold() in {"http", "https"}:
            _ensure_public_https(source)
            if parsed.path.casefold().endswith(".zip"):
                archive = inspection / "package.zip"
                _download_zip(source, archive)
                payload_root.mkdir()
                _extract_zip(archive, payload_root)
                archive.unlink(missing_ok=True)
            elif parsed.path.casefold().endswith(".git"):
                if parsed.query:
                    raise PluginInstallError(
                        "UNSAFE_PLUGIN_SOURCE",
                        "Git plugin source URLs cannot contain query credentials",
                    )
                options = urllib.parse.parse_qs(parsed.fragment, keep_blank_values=False)
                if set(options) - {"ref", "subdir"} or any(len(values) != 1 for values in options.values()):
                    raise PluginInstallError(
                        "INVALID_PLUGIN_SOURCE",
                        "Git source fragments may contain one ref and one subdir value",
                    )
                ref = options.get("ref", [""])[0]
                subdir = options.get("subdir", [""])[0]
                if ref and (
                    len(ref) > 128
                    or ref.startswith("-")
                    or "\\" in ref
                    or ".." in ref.split("/")
                    or not re.fullmatch(r"[A-Za-z0-9._/-]+", ref)
                ):
                    raise PluginInstallError("INVALID_PLUGIN_SOURCE", "Git ref contains unsupported characters")
                clone_source = urllib.parse.urlunsplit(
                    (parsed.scheme, parsed.netloc, parsed.path, parsed.query, "")
                )
                repository = inspection / "repository"
                _clone_git(clone_source, repository, ref=ref)
                if subdir:
                    relative = Path(urllib.parse.unquote(subdir))
                    if relative.is_absolute() or ".." in relative.parts:
                        raise PluginInstallError("UNSAFE_PLUGIN_SOURCE", "Git plugin subdirectory must stay in the repository")
                    selected = (repository / relative).resolve()
                    try:
                        selected.relative_to(repository.resolve())
                    except ValueError:
                        raise PluginInstallError("UNSAFE_PLUGIN_SOURCE", "Git plugin subdirectory escaped the repository") from None
                    if not selected.is_dir():
                        raise PluginInstallError("PLUGIN_SOURCE_NOT_FOUND", "Git plugin subdirectory was not found")
                    _reject_unsafe_tree(selected)
                    shutil.copytree(selected, payload_root)
                    shutil.rmtree(repository, ignore_errors=True)
                else:
                    repository.replace(payload_root)
            else:
                raise PluginInstallError(
                    "UNSUPPORTED_PLUGIN_SOURCE",
                    "remote plugin sources must be an HTTPS .zip archive or .git repository",
                )
            return
        local = Path(source).expanduser().resolve()
        if local.is_dir():
            _reject_unsafe_tree(local)
            shutil.copytree(local, payload_root)
        elif local.is_file() and local.suffix.casefold() == ".zip":
            if local.stat().st_size > MAX_ARCHIVE_BYTES:
                raise PluginInstallError("PLUGIN_PACKAGE_TOO_LARGE", f"plugin archive exceeds {MAX_ARCHIVE_BYTES} bytes")
            payload_root.mkdir()
            _extract_zip(local, payload_root)
        else:
            raise PluginInstallError(
                "PLUGIN_SOURCE_NOT_FOUND",
                "local plugin source must be an existing directory or ZIP archive",
            )

    @staticmethod
    def _candidates(payload_root: Path) -> list[dict[str, Any]]:
        manifest_paths = []
        root_manifest = payload_root / "plugin.json"
        if root_manifest.is_file():
            manifest_paths.append(root_manifest)
        manifest_paths.extend(sorted(payload_root.glob("*/plugin.json")))
        candidates = []
        seen: set[str] = set()
        for manifest_path in manifest_paths:
            candidate = PluginRegistry._read_manifest(manifest_path, payload_root)
            if candidate.problems:
                detail = ", ".join(candidate.problems)
                raise PluginInstallError("INVALID_PLUGIN_MANIFEST", f"{manifest_path}: {detail}")
            if candidate.manifest.name in seen:
                raise PluginInstallError("INVALID_PLUGIN_PACKAGE", f"duplicate plugin name: {candidate.manifest.name}")
            seen.add(candidate.manifest.name)
            candidates.append(
                {
                    **candidate.public(),
                    "relative_path": manifest_path.parent.relative_to(payload_root).as_posix(),
                    "sha256": _tree_digest(manifest_path.parent),
                }
            )
        if not candidates:
            raise PluginInstallError(
                "PLUGIN_MANIFEST_NOT_FOUND",
                "plugin package must contain plugin.json at its root or in an immediate subdirectory",
            )
        return candidates

    def _load_inspection(self, token: str) -> tuple[Path, dict[str, Any]]:
        normalized = str(token or "").strip().casefold()
        if not _SAFE_TOKEN.fullmatch(normalized):
            raise PluginInstallError("INVALID_INSPECTION", "invalid plugin inspection token")
        inspection = (self.cache_root / normalized).resolve()
        try:
            inspection.relative_to(self.cache_root.resolve())
        except ValueError:
            raise PluginInstallError("INVALID_INSPECTION", "inspection path escaped the cache root") from None
        try:
            metadata = json.loads((inspection / "inspection.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise PluginInstallError("INSPECTION_NOT_FOUND", "plugin inspection expired or was not found") from None
        created = metadata.get("created_epoch")
        if not isinstance(created, (int, float)) or time.time() - created > INSPECTION_TTL_SECONDS:
            shutil.rmtree(inspection, ignore_errors=True)
            raise PluginInstallError("INSPECTION_EXPIRED", "plugin inspection has expired")
        if not isinstance(metadata.get("candidates"), list) or not metadata["candidates"]:
            raise PluginInstallError("INVALID_INSPECTION", "plugin inspection metadata is invalid")
        return inspection, metadata

    def _move_to_trash(self, source: Path, name: str, *, reason: str) -> dict[str, Any]:
        self.trash_root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        recovery_id = f"{name}-{stamp}-{uuid.uuid4().hex[:8]}"
        destination = self.trash_root / recovery_id
        recovery = {
            "recovery_id": recovery_id,
            "name": name,
            "reason": reason,
            "removed_at": _utc_now(),
            "path": str(destination),
        }
        recovery_metadata = source / ".recovery.json"
        recovery_metadata.write_text(
            json.dumps(recovery, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        try:
            source.replace(destination)
        except OSError:
            recovery_metadata.unlink(missing_ok=True)
            raise
        return recovery

    def _prune_expired(self) -> None:
        if not self.cache_root.is_dir():
            return
        cutoff = time.time() - INSPECTION_TTL_SECONDS
        for candidate in self.cache_root.iterdir():
            try:
                if candidate.is_dir() and candidate.stat().st_mtime < cutoff:
                    shutil.rmtree(candidate, ignore_errors=True)
            except OSError:
                continue


__all__ = ["PluginInstallError", "PluginInstallRuntime"]
