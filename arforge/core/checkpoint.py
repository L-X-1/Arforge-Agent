"""Task-level checkpoint and resume (G6) — save/restore agent state across interruptions.

Allows long-running code agent tasks to be paused, saved to disk, and resumed later.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from arforge.paths import data_path
from arforge.security_guard import sanitize_for_storage


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Checkpoint:
    """A saved agent task state."""

    run_id: str
    task: str
    workspace: str
    messages: list[dict]
    steps_completed: int
    max_steps: int
    tool_calls_made: int
    tokens_used: int
    created_at: str
    last_updated: str
    status: str = "paused"  # paused / resumed / completed / abandoned
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "task": self.task,
            "workspace": self.workspace,
            "messages": self.messages,
            "steps_completed": self.steps_completed,
            "max_steps": self.max_steps,
            "tool_calls_made": self.tool_calls_made,
            "tokens_used": self.tokens_used,
            "created_at": self.created_at,
            "last_updated": self.last_updated,
            "status": self.status,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Checkpoint:
        return cls(
            run_id=data.get("run_id", ""),
            task=data.get("task", ""),
            workspace=data.get("workspace", ""),
            messages=data.get("messages", []),
            steps_completed=data.get("steps_completed", 0),
            max_steps=data.get("max_steps", 0),
            tool_calls_made=data.get("tool_calls_made", 0),
            tokens_used=data.get("tokens_used", 0),
            created_at=data.get("created_at", ""),
            last_updated=data.get("last_updated", ""),
            status=data.get("status", "paused"),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# Checkpoint store
# ---------------------------------------------------------------------------


def _checkpoint_dir() -> Path:
    d = data_path("checkpoints")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _checkpoint_path(run_id: str) -> Path:
    return _checkpoint_dir() / f"{run_id}.json"


def _write_checkpoint_document(checkpoint: Checkpoint) -> None:
    """Atomically replace a checkpoint so interruption cannot leave half JSON."""
    path = _checkpoint_path(checkpoint.run_id)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(checkpoint.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def save_checkpoint(
    run_id: str,
    task: str,
    messages: list[dict],
    steps_completed: int = 0,
    max_steps: int = 0,
    tool_calls_made: int = 0,
    tokens_used: int = 0,
    workspace: str = "",
    **metadata,
) -> Checkpoint:
    """Save the current agent state to disk.

    Returns the Checkpoint object.
    """
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    cp = Checkpoint(
        run_id=run_id,
        task=sanitize_for_storage(task),
        workspace=workspace or str(Path.cwd()),
        messages=sanitize_for_storage(messages),
        steps_completed=steps_completed,
        max_steps=max_steps,
        tool_calls_made=tool_calls_made,
        tokens_used=tokens_used,
        created_at=now,
        last_updated=now,
        status="paused",
        metadata=sanitize_for_storage(dict(metadata)),
    )

    try:
        _write_checkpoint_document(cp)
    except OSError:
        pass

    return cp


def load_checkpoint(run_id: str) -> Checkpoint | None:
    """Load a saved checkpoint from disk."""
    path = _checkpoint_path(run_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return Checkpoint.from_dict(data)
    except (json.JSONDecodeError, OSError):
        return None


def list_checkpoints(limit: int = 20) -> list[dict]:
    """List all saved checkpoints."""
    d = _checkpoint_dir()
    items = []
    for p in sorted(d.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            items.append({
                "run_id": data.get("run_id", p.stem),
                "task": (data.get("task", "") or "")[:100],
                "status": data.get("status", "unknown"),
                "steps": data.get("steps_completed", 0),
                "tokens": data.get("tokens_used", 0),
                "created_at": data.get("created_at", ""),
            })
        except (json.JSONDecodeError, OSError):
            continue
        if len(items) >= limit:
            break
    return items


def update_checkpoint_status(run_id: str, status: str) -> bool:
    """Update a checkpoint's status."""
    cp = load_checkpoint(run_id)
    if cp is None:
        return False
    cp.status = status
    cp.last_updated = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        _write_checkpoint_document(cp)
        return True
    except OSError:
        return False


def delete_checkpoint(run_id: str) -> bool:
    """Delete a checkpoint."""
    path = _checkpoint_path(run_id)
    try:
        path.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def delete_all_checkpoints() -> int:
    """Delete all checkpoints. Returns count deleted."""
    d = _checkpoint_dir()
    count = 0
    for p in d.glob("*.json"):
        try:
            p.unlink()
            count += 1
        except OSError:
            pass
    return count


def generate_run_id() -> str:
    """Generate a unique run ID."""
    return f"run_{int(time.time())}_{uuid.uuid4().hex[:8]}"
