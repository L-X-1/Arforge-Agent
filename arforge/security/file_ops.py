"""Safe filesystem operations."""

from __future__ import annotations

import os
import sys
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Callable, Iterator, Optional

from arforge.logger import write_log
from arforge.security.backup_manager import backup_file, file_hash as _file_hash, list_backups


class FileTransaction:
    def __init__(self) -> None:
        self.created: list[Path] = []
        self.backups: list[tuple[Path, Optional[Path]]] = []

    def track(self, path: Path, backup: Optional[Path]) -> None:
        self.backups.append((path, backup))


def file_hash(file_path: Path) -> str:
    return _file_hash(file_path)


_CONFIRMED_SCOPE: ContextVar[bool] = ContextVar("arforge_confirmed_scope", default=False)
ConfirmationHandler = Callable[[str, str], bool]
_CONFIRMATION_HANDLER: ContextVar[ConfirmationHandler | None] = ContextVar(
    "arforge_confirmation_handler",
    default=None,
)


@contextmanager
def confirmed_operation():
    """Mark a centrally approved tool call so nested operations do not prompt twice."""
    token = _CONFIRMED_SCOPE.set(True)
    try:
        yield
    finally:
        _CONFIRMED_SCOPE.reset(token)


@contextmanager
def confirmation_handler(handler: ConfirmationHandler) -> Iterator[None]:
    """Route a synchronous confirmation through the active product client.

    Desktop chats run on worker threads while the Bridge protocol itself stays
    on stdin/stdout.  Binding a context-local handler lets that worker pause for
    a real UI decision without reading from the Bridge's protocol stdin.
    """
    token = _CONFIRMATION_HANDLER.set(handler)
    try:
        yield
    finally:
        _CONFIRMATION_HANDLER.reset(token)


# ---------------------------------------------------------------------------
# Confirmation policy — opt-in skip via env var, otherwise interactive prompt.
# ---------------------------------------------------------------------------


def _is_auto_approve_env() -> bool:
    """True when the environment opts into automatic confirmation.

    Set ARFORGE_AUTO_APPROVE=1 in CI / scripts that intentionally accept all
    confirmations. Otherwise a real terminal prompt is shown.
    """
    flag = os.environ.get("ARFORGE_AUTO_APPROVE", "").strip().lower()
    return flag in {"1", "true", "yes", "y", "on"}


def request_confirmation(risk: str, description: str) -> bool:
    """Ask the user to confirm a risky action.

    - Returns True automatically when ARFORGE_AUTO_APPROVE is set (CI / scripts).
    - Returns True automatically for ``low`` risk operations.
    - Otherwise prompts on the controlling TTY; returns False when stdin is not
      attached to a terminal so callers don't silently proceed.
    """
    if _CONFIRMED_SCOPE.get() or risk.lower() == "low":
        return True
    if _is_auto_approve_env():
        return True
    handler = _CONFIRMATION_HANDLER.get()
    if handler is not None:
        return bool(handler(risk, description))
    if not sys.stdin.isatty():
        write_log(
            "warning",
            f"confirmation prompt suppressed (no TTY) for {risk} action: {description}",
        )
        return False
    try:
        prompt = f"\n[Arforge confirm] {risk.upper()} action: {description}\nProceed? [y/N] "
        answer = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    return answer in {"y", "yes"}


def authorize_session(operation_key: str):
    return {"authorized": True, "operation_key": operation_key}


def check_file_permission(operation_type: str, file_path: str) -> dict:
    path = Path(file_path)
    if operation_type in {"read", "delete", "modify"} and not path.exists():
        return {"allowed": False, "reason": "file does not exist"}
    if operation_type in {"write", "modify"}:
        parent = path.parent if path.parent != Path("") else Path.cwd()
        return {"allowed": parent.exists(), "reason": "ok" if parent.exists() else "parent does not exist"}
    return {"allowed": True, "reason": "ok"}


def is_file_locked(file_path: Path) -> bool:
    path = Path(file_path)
    if not path.exists():
        return False
    try:
        with path.open("a", encoding="utf-8"):
            return False
    except OSError:
        return True


def safe_read(file_path: Path, max_size: int = 5 * 1024 * 1024) -> dict:
    path = Path(file_path)
    if not path.exists():
        return {"success": False, "content": "", "error": "file does not exist"}
    if path.stat().st_size > max_size:
        return {"success": False, "content": "", "error": "file too large"}
    try:
        return {"success": True, "content": path.read_text(encoding="utf-8"), "error": ""}
    except Exception as exc:
        return {"success": False, "content": "", "error": str(exc)}


def safe_write(
    file_path: Path,
    content: str,
    encoding: str = "utf-8",
    auto_backup: bool = True,
    require_confirm: bool = True,
) -> dict:
    path = Path(file_path)
    if require_confirm and not request_confirmation("write", str(path)):
        return {"success": False, "error": "not confirmed"}
    backup = backup_file(path) if auto_backup and path.exists() else None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding=encoding, delete=False, dir=str(path.parent)) as handle:
            handle.write(content)
            temp_name = handle.name
        os.replace(temp_name, path)
        return {"success": True, "file_path": str(path), "backup_path": str(backup) if backup else "", "error": ""}
    except Exception as exc:
        write_log("error", f"safe_write failed for {path}: {exc}")
        return {"success": False, "file_path": str(path), "backup_path": str(backup) if backup else "", "error": str(exc)}


def safe_delete(file_path: Path, require_confirm: bool = True) -> dict:
    path = Path(file_path)
    if require_confirm and not request_confirmation("delete", str(path)):
        return {"success": False, "error": "not confirmed"}
    backup = backup_file(path) if path.exists() else None
    try:
        path.unlink()
        return {"success": True, "backup_path": str(backup) if backup else ""}
    except Exception as exc:
        return {"success": False, "backup_path": str(backup) if backup else "", "error": str(exc)}


def restore_backup(backup_name: str, target_path: Path = None) -> dict:
    backup = Path(backup_name)
    if not backup.exists():
        candidates = [item for item in list_backups() if Path(item.get("backup_path", "")).name == backup_name]
        if not candidates:
            return {"success": False, "error": "backup not found"}
        backup = Path(candidates[-1]["backup_path"])
        target_path = target_path or Path(candidates[-1]["original_path"])
    target = Path(target_path) if target_path else Path(backup.name)
    return safe_write(target, backup.read_text(encoding="utf-8"), auto_backup=True, require_confirm=False)


def clean_old_backups(keep_days: int = 7) -> dict:
    from arforge.security.backup_manager import auto_clean_backups

    return auto_clean_backups(silent=True)
