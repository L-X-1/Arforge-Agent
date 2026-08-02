"""Primary user-message delivery with local, authorized attachments."""

from __future__ import annotations

import hashlib
import mimetypes
import os
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator


MAX_MESSAGE_CHARS = 20_000
MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_PATH_CHARS = 2_048

_ALLOWED_SUFFIX_MIME = {
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".csv": "text/csv",
    ".css": "text/css",
    ".diff": "text/x-diff",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".go": "text/x-go",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".html": "text/html",
    ".java": "text/x-java-source",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/jsx",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".patch": "text/x-diff",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".py": "text/x-python",
    ".rs": "text/x-rust",
    ".svg": "image/svg+xml",
    ".toml": "application/toml",
    ".ts": "text/typescript",
    ".tsv": "text/tab-separated-values",
    ".tsx": "text/tsx",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".zip": "application/zip",
}


class UserMessageError(ValueError):
    """Raised when a user-visible message violates the delivery contract."""


@dataclass
class DeliveryState:
    deliveries: list[dict[str, Any]] = field(default_factory=list)
    on_delivery: Callable[[dict[str, Any]], None] | None = None


_DELIVERY_STATE: ContextVar[DeliveryState | None] = ContextVar(
    "arforge_user_message_delivery",
    default=None,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _has_unsafe_control(value: str) -> bool:
    return any(ord(char) < 32 and char not in "\n\r\t" for char in value)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_attachment(raw_path: str, *, primary: Path) -> dict[str, Any]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise UserMessageError("attachment paths must be non-empty strings")
    if len(raw_path) > MAX_PATH_CHARS or "\x00" in raw_path:
        raise UserMessageError("attachment path is invalid or too long")
    expanded = Path(os.path.expandvars(os.path.expanduser(raw_path.strip())))
    candidate = expanded if expanded.is_absolute() else primary / expanded
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        raise UserMessageError(f"attachment does not exist: {raw_path}") from None

    from arforge.workspace_roots import path_is_authorized

    if not path_is_authorized(resolved, primary=primary):
        raise UserMessageError(f"attachment is outside authorized workspaces: {raw_path}")
    if candidate.is_symlink():
        raise UserMessageError(f"attachment must not be a symbolic link: {raw_path}")
    if not resolved.is_file():
        raise UserMessageError(f"attachment is not a regular file: {raw_path}")
    suffix = resolved.suffix.casefold()
    if suffix not in _ALLOWED_SUFFIX_MIME:
        raise UserMessageError(f"attachment type is not allowed: {suffix or '(no extension)'}")

    before = resolved.stat()
    if before.st_size > MAX_ATTACHMENT_BYTES:
        raise UserMessageError(
            f"attachment exceeds {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB: {raw_path}"
        )
    digest = _sha256(resolved)
    after = resolved.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise UserMessageError(f"attachment changed while it was being inspected: {raw_path}")

    mime = _ALLOWED_SUFFIX_MIME[suffix] or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
    return {
        "artifact_id": f"msg-{digest[:16]}",
        "path": str(resolved),
        "display_name": resolved.name,
        "mime": mime,
        "size_bytes": after.st_size,
        "created_at": _utc_now(),
        "source": "user_message",
        "is_image": mime.startswith("image/"),
        "sha256": digest,
    }


def publish_user_message(
    message: str,
    *,
    status: str = "normal",
    attachments: list[str] | None = None,
) -> dict[str, Any]:
    """Validate and publish one primary visible message in the active run."""

    if not isinstance(message, str) or not message.strip():
        raise UserMessageError("message must be a non-empty string")
    if len(message) > MAX_MESSAGE_CHARS:
        raise UserMessageError(f"message exceeds {MAX_MESSAGE_CHARS} characters")
    if _has_unsafe_control(message):
        raise UserMessageError("message contains unsupported control characters")
    if status not in {"normal", "proactive"}:
        raise UserMessageError("status must be normal or proactive")
    if attachments is None:
        raw_attachments: list[str] = []
    elif isinstance(attachments, list) and all(isinstance(item, str) for item in attachments):
        raw_attachments = attachments
    else:
        raise UserMessageError("attachments must be an array of file paths")
    if len(raw_attachments) > MAX_ATTACHMENTS:
        raise UserMessageError(f"no more than {MAX_ATTACHMENTS} attachments are allowed")

    from arforge.tools.file_tools import get_workspace

    primary = get_workspace().expanduser().resolve()
    resolved: list[dict[str, Any]] = []
    seen: set[Path] = set()
    total_bytes = 0
    for raw_path in raw_attachments:
        attachment = _resolve_attachment(raw_path, primary=primary)
        canonical = Path(attachment["path"])
        if canonical in seen:
            continue
        seen.add(canonical)
        total_bytes += int(attachment["size_bytes"])
        if total_bytes > MAX_TOTAL_ATTACHMENT_BYTES:
            raise UserMessageError(
                f"attachments exceed {MAX_TOTAL_ATTACHMENT_BYTES // (1024 * 1024)} MB in total"
            )
        resolved.append(attachment)

    delivery = {
        "message": message.strip(),
        "status": status,
        "sent_at": _utc_now(),
        "attachment_count": len(resolved),
        "attachments": resolved,
        "local_only": True,
        "uploaded": False,
    }
    state = _DELIVERY_STATE.get()
    if state is not None:
        state.deliveries.append(delivery)
        if state.on_delivery is not None:
            state.on_delivery(delivery)
    return delivery


@contextmanager
def delivery_scope(
    on_delivery: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[DeliveryState]:
    """Isolate message deliveries to one agent run."""

    state = DeliveryState(on_delivery=on_delivery)
    token = _DELIVERY_STATE.set(state)
    try:
        yield state
    finally:
        _DELIVERY_STATE.reset(token)


__all__ = [
    "DeliveryState",
    "MAX_ATTACHMENTS",
    "MAX_ATTACHMENT_BYTES",
    "MAX_MESSAGE_CHARS",
    "MAX_TOTAL_ATTACHMENT_BYTES",
    "UserMessageError",
    "delivery_scope",
    "publish_user_message",
]
