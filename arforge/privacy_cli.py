"""Privacy audit command helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
from typing import Callable

from arforge.paths import get_arforge_home


_SECRET_BYTE_PATTERNS = {
    "openai_style": rb"\bsk-[A-Za-z0-9_-]{20,}",
    "github_token": rb"\bghp_[A-Za-z0-9]{36}\b",
    "aws_access_key": rb"\bAKIA[0-9A-Z]{16}\b",
    "database_url": rb"(?i)\b(?:postgresql|postgres|mysql)://[^\s:/]+:[^@\s]+@",
}


def data_inventory(home: Path | None = None) -> dict:
    """Return a metadata-only inventory; file contents are never read."""
    root = (home or get_arforge_home()).resolve()
    files = [path for path in root.rglob("*") if path.is_file()] if root.exists() else []
    total_bytes = sum(path.stat().st_size for path in files)
    return {
        "path": str(root),
        "files": len(files),
        "bytes": total_bytes,
        "credentials_present": (root / ".env").is_file(),
        "logs_bytes": sum(path.stat().st_size for path in files if path.is_relative_to(root / "logs")),
        "backups": sum(1 for path in files if path.is_relative_to(root / "backups")),
    }


def scan_sensitive_files(home: Path | None = None, max_file_bytes: int = 512 * 1024 * 1024) -> dict:
    """Scan local data for credential patterns without returning matched values."""
    import re

    root = (home or get_arforge_home()).resolve()
    findings: list[dict] = []
    skipped: list[str] = []
    if not root.exists():
        return {"root": str(root), "files_scanned": 0, "findings": [], "skipped": []}
    files_scanned = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.name == ".env":
            continue
        relative = str(path.relative_to(root))
        if path.stat().st_size > max_file_bytes:
            skipped.append(relative)
            continue
        data = path.read_bytes()
        files_scanned += 1
        categories = {
            name: len(re.findall(pattern, data))
            for name, pattern in _SECRET_BYTE_PATTERNS.items()
            if re.search(pattern, data)
        }
        if categories:
            findings.append({"path": relative, "categories": categories})
    return {"root": str(root), "files_scanned": files_scanned, "findings": findings, "skipped": skipped}


def privacy_audit() -> dict:
    arforge_home = get_arforge_home()
    return {
        "local_first": True,
        "arforge_home": str(arforge_home),
        "arforge_home_exists": arforge_home.exists(),
        "network_use": "model API calls only when configured/requested",
        "inventory": data_inventory(arforge_home),
    }


def prune_logs(retention_days: int = 30, home: Path | None = None, now: datetime | None = None) -> dict:
    """Delete local log files older than the configured retention window."""
    if retention_days < 0:
        raise ValueError("retention_days must be zero or greater")
    root = (home or get_arforge_home()).resolve()
    log_dir = (root / "logs").resolve()
    if not log_dir.is_relative_to(root):
        raise ValueError("log directory escaped Arforge home")
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=retention_days)
    removed: list[str] = []
    reclaimed = 0
    if log_dir.exists():
        for path in log_dir.rglob("*"):
            if not path.is_file():
                continue
            modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
            if modified <= cutoff:
                reclaimed += path.stat().st_size
                path.unlink()
                removed.append(str(path))
    return {"removed": removed, "files": len(removed), "bytes": reclaimed, "retention_days": retention_days}


def clear_local_data(
    *,
    home: Path | None = None,
    dry_run: bool = True,
    include_credentials: bool = False,
    confirm: Callable[[str, str], bool] | None = None,
) -> dict:
    """Preview or remove per-user Arforge data while preserving credentials by default."""
    root = (home or get_arforge_home()).resolve()
    if root == Path.home().resolve() or root == Path(root.anchor):
        raise ValueError("refusing unsafe data directory")
    if not root.exists():
        return {"success": True, "dry_run": dry_run, "removed": [], "preserved": []}

    targets = [path for path in root.iterdir() if include_credentials or path.name != ".env"]
    preserved = [str(root / ".env")] if not include_credentials and (root / ".env").exists() else []
    if dry_run:
        return {"success": True, "dry_run": True, "removed": [str(path) for path in targets], "preserved": preserved}

    if confirm is None:
        from arforge.permission import request_confirmation

        confirm = request_confirmation
    description = f"permanently delete local Arforge data under {root}"
    if include_credentials:
        description += ", including API/database credentials"
    if not confirm("high", description):
        return {"success": False, "dry_run": False, "removed": [], "preserved": preserved, "error": "confirmation denied"}

    removed: list[str] = []
    for path in targets:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
        removed.append(str(path))
    if include_credentials:
        root.rmdir()
    return {"success": True, "dry_run": False, "removed": removed, "preserved": preserved}


def privacy_summary() -> str:
    audit = privacy_audit()
    return "\n".join(f"{key}: {value}" for key, value in audit.items())


def main() -> int:
    print(privacy_summary())
    return 0
