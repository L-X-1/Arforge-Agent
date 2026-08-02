"""Backup management for safe file modifications."""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional

from arforge.logger import write_log
from arforge.paths import data_path


def _backup_root() -> Path:
    return data_path("backups")


def _index_file() -> Path:
    return _backup_root() / "index.jsonl"


def file_hash(file_path: Path) -> str:
    h = hashlib.sha256()
    with Path(file_path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _backup_name(file_path: Path) -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    safe_name = Path(file_path).name.replace(" ", "_")
    return f"{stamp}_{safe_name}"


def backup_file(file_path: Path) -> Optional[Path]:
    path = Path(file_path)
    if not path.exists() or not path.is_file():
        return None
    backup_root = _backup_root()
    backup_root.mkdir(parents=True, exist_ok=True)
    target = backup_root / _backup_name(path)
    shutil.copy2(path, target)
    record_backup(path, target, reason="backup")
    return target


def record_backup(original_path: Path, backup_path: Path, reason: str = "", related_step: int = 0, description: str = "") -> dict:
    record = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "original_path": str(Path(original_path).resolve()),
        "backup_path": str(Path(backup_path).resolve()),
        "reason": reason,
        "related_step": related_step,
        "description": description,
        "sha256": file_hash(Path(backup_path)) if Path(backup_path).exists() else "",
    }
    backup_root = _backup_root()
    backup_root.mkdir(parents=True, exist_ok=True)
    with _index_file().open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def smart_backup(
    file_path: Path,
    reason: str = "auto",
    related_step: int = 0,
    description: str = "",
    auto_clean: bool = True,
) -> Optional[Path]:
    backup = backup_file(file_path)
    if backup is not None:
        record_backup(file_path, backup, reason, related_step, description)
    if auto_clean:
        auto_clean_backups(silent=True)
    return backup


def _read_index() -> list[dict]:
    index_file = _index_file()
    if not index_file.exists():
        return []
    records: list[dict] = []
    for line in index_file.read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def list_backups(file_name: str = None) -> list:
    records = _read_index()
    if file_name:
        records = [item for item in records if file_name in Path(item.get("original_path", "")).name]
    return records


def search_by_original(file_path: Path, limit: int = 20) -> List[dict]:
    resolved = str(Path(file_path).resolve())
    return [item for item in reversed(_read_index()) if item.get("original_path") == resolved][:limit]


def search_backups(
    file_pattern: str = "",
    date_from: str = "",
    date_to: str = "",
    reason: str = "",
    related_step: int = 0,
    keyword: str = "",
    limit: int = 50,
) -> List[dict]:
    records = _read_index()
    if file_pattern:
        records = [item for item in records if file_pattern in item.get("original_path", "")]
    if reason:
        records = [item for item in records if item.get("reason") == reason]
    if related_step:
        records = [item for item in records if item.get("related_step") == related_step]
    if keyword:
        records = [item for item in records if keyword in json.dumps(item, ensure_ascii=False)]
    if date_from:
        records = [item for item in records if item.get("created_at", "") >= date_from]
    if date_to:
        records = [item for item in records if item.get("created_at", "") <= date_to]
    return records[:limit]


def rebuild_index() -> dict:
    backup_root = _backup_root()
    index_file = _index_file()
    backup_root.mkdir(parents=True, exist_ok=True)
    count = 0
    index_file.write_text("", encoding="utf-8")
    for backup in backup_root.iterdir():
        if backup.is_file() and backup.name != index_file.name:
            record_backup(Path("unknown"), backup, reason="rebuild")
            count += 1
    return {"success": True, "count": count}


def auto_clean_backups(silent: bool = False) -> dict:
    cutoff = datetime.now() - timedelta(days=30)
    removed = 0
    backup_root = _backup_root()
    index_file = _index_file()
    backup_root.mkdir(parents=True, exist_ok=True)
    for item in backup_root.iterdir():
        if item.is_file() and item.name != index_file.name:
            modified = datetime.fromtimestamp(item.stat().st_mtime)
            if modified < cutoff:
                item.unlink(missing_ok=True)
                removed += 1
    if not silent:
        write_log("info", f"Cleaned {removed} old backups")
    return {"success": True, "removed": removed}


def backup_stats() -> dict:
    backup_root = _backup_root()
    index_file = _index_file()
    backup_root.mkdir(parents=True, exist_ok=True)
    files = [item for item in backup_root.iterdir() if item.is_file() and item.name != index_file.name]
    return {"count": len(files), "bytes": sum(item.stat().st_size for item in files)}


def backup_summary() -> str:
    stats = backup_stats()
    return f"Backups: {stats['count']} files, {stats['bytes']} bytes"
