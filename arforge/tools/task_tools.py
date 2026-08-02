"""Persistent task graph tools with legacy-compatible local storage."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from arforge.core.hooks import HookEvent, fire_event
from arforge.paths import data_path
from arforge.security_guard import sanitize_for_storage
from arforge.tool_registry import ParamSchema, adapt_task_title, register_tool


UTC = timezone.utc
VALID_PRIORITIES = frozenset({"low", "medium", "high"})
VALID_STATUSES = frozenset({"pending", "in_progress", "completed", "failed", "cancelled"})
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
_DEPENDENCY_GATED_STATUSES = frozenset({"in_progress", "completed"})
_ALLOWED_STATUS_TRANSITIONS = {
    "pending": frozenset(
        {"pending", "in_progress", "completed", "failed", "cancelled"}
    ),
    "in_progress": frozenset(
        {"pending", "in_progress", "completed", "failed", "cancelled"}
    ),
    # Reopening a completed task is explicit.  It must return to pending before
    # it can be claimed again, which prevents silently bypassing dependencies.
    "completed": frozenset({"completed", "pending"}),
    "failed": frozenset({"failed", "pending"}),
    "cancelled": frozenset({"cancelled", "pending"}),
}
MAX_TASK_FILE_BYTES = 4 * 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024
_THREAD_LOCK = threading.RLock()


class TaskStoreError(ValueError):
    """Raised when persistent task state or a task graph mutation is invalid."""


def _task_file() -> Path:
    return data_path("tasks.json")


def _highwater_file() -> Path:
    return data_path("tasks.highwater")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean_text(value: Any, *, field: str, maximum: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise TaskStoreError(f"{field} must be a string")
    cleaned = str(sanitize_for_storage(value)).strip()
    if required and not cleaned:
        raise TaskStoreError(f"{field} is required")
    if len(cleaned) > maximum:
        raise TaskStoreError(f"{field} must be at most {maximum} characters")
    return cleaned


def _validate_priority(value: str) -> str:
    priority = _clean_text(value, field="priority", maximum=16, required=True).casefold()
    if priority not in VALID_PRIORITIES:
        raise TaskStoreError("priority must be low, medium, or high")
    return priority


def _validate_status(value: str) -> str:
    status = _clean_text(value, field="status", maximum=24, required=True).casefold()
    if status not in VALID_STATUSES:
        raise TaskStoreError("status must be pending, in_progress, or completed")
    return status


def _normalize_id_list(value: Iterable[Any] | None, *, field: str) -> list[int]:
    if value is None:
        return []
    if isinstance(value, (str, bytes, dict)):
        raise TaskStoreError(f"{field} must be a list of task IDs")
    result: list[int] = []
    for item in value:
        if isinstance(item, bool):
            raise TaskStoreError(f"{field} must contain positive task IDs")
        try:
            task_id = int(item)
        except (TypeError, ValueError):
            raise TaskStoreError(f"{field} must contain positive task IDs") from None
        if task_id < 1:
            raise TaskStoreError(f"{field} must contain positive task IDs")
        if task_id not in result:
            result.append(task_id)
    return result


def _normalize_metadata(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TaskStoreError("metadata must be an object")
    cleaned = sanitize_for_storage(value)
    try:
        encoded = json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        raise TaskStoreError("metadata must be JSON serializable") from None
    if len(encoded.encode("utf-8")) > MAX_METADATA_BYTES:
        raise TaskStoreError(f"metadata must be at most {MAX_METADATA_BYTES} bytes")
    return cleaned


def _normalize_metadata_patch(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TaskStoreError("metadata must be an object")
    patch: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise TaskStoreError("metadata keys must be strings")
        patch[key] = None if item is None else sanitize_for_storage({key: item})[key]
    try:
        encoded = json.dumps(patch, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        raise TaskStoreError("metadata must be JSON serializable") from None
    if len(encoded.encode("utf-8")) > MAX_METADATA_BYTES:
        raise TaskStoreError(f"metadata must be at most {MAX_METADATA_BYTES} bytes")
    return patch


def _normalize_task(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TaskStoreError("task storage contains a non-object entry")
    task_id = raw.get("id")
    if isinstance(task_id, bool):
        raise TaskStoreError("task ID must be a positive integer")
    try:
        task_id = int(task_id)
    except (TypeError, ValueError):
        raise TaskStoreError("task ID must be a positive integer") from None
    if task_id < 1:
        raise TaskStoreError("task ID must be a positive integer")

    created_at = raw.get("created_at")
    if not isinstance(created_at, str) or not created_at.strip():
        created_at = _utc_now()
    updated_at = raw.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at.strip():
        updated_at = created_at

    return {
        "id": task_id,
        "title": _clean_text(raw.get("title", ""), field="title", maximum=500, required=True),
        "description": _clean_text(raw.get("description", ""), field="description", maximum=8_000),
        "active_form": _clean_text(raw.get("active_form", ""), field="active_form", maximum=500),
        "priority": _validate_priority(str(raw.get("priority", "medium"))),
        "tag": _clean_text(raw.get("tag", ""), field="tag", maximum=128),
        "status": _validate_status(str(raw.get("status", "pending"))),
        "owner": _clean_text(raw.get("owner", ""), field="owner", maximum=128),
        "blocks": _normalize_id_list(raw.get("blocks", []), field="blocks"),
        "blocked_by": _normalize_id_list(raw.get("blocked_by", []), field="blocked_by"),
        "metadata": _normalize_metadata(raw.get("metadata", {})),
        "created_at": created_at,
        "updated_at": updated_at,
    }


def _load_unlocked() -> list[dict[str, Any]]:
    path = _task_file()
    if not path.exists():
        return []
    try:
        if not path.is_file() or path.stat().st_size > MAX_TASK_FILE_BYTES:
            raise TaskStoreError("task storage is invalid or too large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except TaskStoreError:
        raise
    except (OSError, json.JSONDecodeError):
        raise TaskStoreError("task storage is unreadable") from None
    if not isinstance(value, list):
        raise TaskStoreError("task storage must contain a JSON list")
    tasks = [_normalize_task(item) for item in value]
    ids = [task["id"] for task in tasks]
    if len(ids) != len(set(ids)):
        raise TaskStoreError("task storage contains duplicate IDs")
    known = set(ids)
    for task in tasks:
        task["blocks"] = [item for item in task["blocks"] if item in known and item != task["id"]]
        task["blocked_by"] = [item for item in task["blocked_by"] if item in known and item != task["id"]]
    _repair_relations(tasks)
    _assert_acyclic(tasks)
    return tasks


def _atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _exclusive_update_lock():
    lock_path = _task_file().with_suffix(".json.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 3.0
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(descriptor, str(os.getpid()).encode("ascii"))
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > 30:
                    lock_path.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TaskStoreError("another process is updating tasks") from None
            time.sleep(0.02)
    try:
        yield
    finally:
        if descriptor is not None:
            os.close(descriptor)
        lock_path.unlink(missing_ok=True)


def _save_unlocked(tasks: list[dict[str, Any]]) -> None:
    _atomic_write(_task_file(), tasks)


def _load_highwater_unlocked(tasks: list[dict[str, Any]]) -> int:
    existing = max((task["id"] for task in tasks), default=0)
    path = _highwater_file()
    if not path.exists():
        return existing
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise TaskStoreError("task ID high-water mark is unreadable") from None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TaskStoreError("task ID high-water mark is invalid")
    return max(existing, value)


def _task_map(tasks: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {task["id"]: task for task in tasks}


def _unresolved_blockers(
    task: dict[str, Any], tasks: list[dict[str, Any]]
) -> list[int]:
    by_id = _task_map(tasks)
    return [
        blocker_id
        for blocker_id in task["blocked_by"]
        if blocker_id in by_id and by_id[blocker_id]["status"] != "completed"
    ]


def _assert_dependencies_resolved(
    task: dict[str, Any], tasks: list[dict[str, Any]], *, action: str
) -> None:
    unresolved = _unresolved_blockers(task, tasks)
    if unresolved:
        joined = ", ".join(f"#{item}" for item in unresolved)
        raise TaskStoreError(
            f"task #{task['id']} cannot be {action}; blocked by {joined}"
        )


def _validate_status_transition(current_status: str, target_status: str) -> None:
    if target_status not in _ALLOWED_STATUS_TRANSITIONS[current_status]:
        raise TaskStoreError(
            f"invalid status transition: {current_status} -> {target_status}"
        )


def _assert_impacted_dependency_states(
    tasks: list[dict[str, Any]], task_ids: Iterable[int]
) -> None:
    """Keep active and completed tasks consistent after a local graph mutation."""
    by_id = _task_map(tasks)
    for task_id in sorted(set(task_ids)):
        affected = by_id.get(task_id)
        if affected is None or affected["status"] not in _DEPENDENCY_GATED_STATUSES:
            continue
        _assert_dependencies_resolved(affected, tasks, action=f"{affected['status']}")


def _repair_relations(tasks: list[dict[str, Any]]) -> None:
    by_id = _task_map(tasks)
    for task in tasks:
        for blocked_id in list(task["blocks"]):
            other = by_id[blocked_id]
            if task["id"] not in other["blocked_by"]:
                other["blocked_by"].append(task["id"])
        for blocker_id in list(task["blocked_by"]):
            other = by_id[blocker_id]
            if task["id"] not in other["blocks"]:
                other["blocks"].append(task["id"])
    for task in tasks:
        task["blocks"].sort()
        task["blocked_by"].sort()


def _assert_acyclic(tasks: list[dict[str, Any]]) -> None:
    graph = {task["id"]: tuple(task["blocks"]) for task in tasks}
    visiting: set[int] = set()
    visited: set[int] = set()

    def visit(task_id: int) -> None:
        if task_id in visiting:
            raise TaskStoreError("task dependency would create a cycle")
        if task_id in visited:
            return
        visiting.add(task_id)
        for child_id in graph.get(task_id, ()):
            visit(child_id)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in graph:
        visit(task_id)


def _remove_references(tasks: list[dict[str, Any]], removed_ids: set[int]) -> None:
    for task in tasks:
        task["blocks"] = [item for item in task["blocks"] if item not in removed_ids]
        task["blocked_by"] = [item for item in task["blocked_by"] if item not in removed_ids]


def _apply_relations(
    tasks: list[dict[str, Any]],
    task: dict[str, Any],
    *,
    add_blocks: Iterable[Any] | None = None,
    add_blocked_by: Iterable[Any] | None = None,
    remove_blocks: Iterable[Any] | None = None,
    remove_blocked_by: Iterable[Any] | None = None,
) -> None:
    by_id = _task_map(tasks)
    operations = {
        "add_blocks": _normalize_id_list(add_blocks, field="add_blocks"),
        "add_blocked_by": _normalize_id_list(add_blocked_by, field="add_blocked_by"),
        "remove_blocks": _normalize_id_list(remove_blocks, field="remove_blocks"),
        "remove_blocked_by": _normalize_id_list(remove_blocked_by, field="remove_blocked_by"),
    }
    for values in operations.values():
        for related_id in values:
            if related_id == task["id"]:
                raise TaskStoreError("a task cannot depend on itself")
            if related_id not in by_id:
                raise TaskStoreError(f"task #{related_id} not found")

    for related_id in operations["add_blocks"]:
        if related_id not in task["blocks"]:
            task["blocks"].append(related_id)
        if task["id"] not in by_id[related_id]["blocked_by"]:
            by_id[related_id]["blocked_by"].append(task["id"])
    for related_id in operations["add_blocked_by"]:
        if related_id not in task["blocked_by"]:
            task["blocked_by"].append(related_id)
        if task["id"] not in by_id[related_id]["blocks"]:
            by_id[related_id]["blocks"].append(task["id"])
    for related_id in operations["remove_blocks"]:
        task["blocks"] = [item for item in task["blocks"] if item != related_id]
        by_id[related_id]["blocked_by"] = [
            item for item in by_id[related_id]["blocked_by"] if item != task["id"]
        ]
    for related_id in operations["remove_blocked_by"]:
        task["blocked_by"] = [item for item in task["blocked_by"] if item != related_id]
        by_id[related_id]["blocks"] = [
            item for item in by_id[related_id]["blocks"] if item != task["id"]
        ]
    _repair_relations(tasks)
    _assert_acyclic(tasks)


def _gate_task(event: HookEvent, tool_name: str, task: dict[str, Any]) -> None:
    decision = fire_event(
        event,
        tool_name=tool_name,
        tool_args={"task_id": task["id"]},
        metadata={"task": task},
    )
    if decision.action in {"block", "ask"}:
        reason = decision.reason or f"{event.value} requires approval"
        raise TaskStoreError(reason)


def create_task(
    title: str,
    priority: str = "medium",
    tag: str = "",
    description: str = "",
    active_form: str = "",
    owner: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a persistent task while preserving the legacy call signature."""
    with _THREAD_LOCK, _exclusive_update_lock():
        tasks = _load_unlocked()
        task_id = _load_highwater_unlocked(tasks) + 1
        now = _utc_now()
        task = {
            "id": task_id,
            "title": _clean_text(title, field="title", maximum=500, required=True),
            "description": _clean_text(description, field="description", maximum=8_000),
            "active_form": _clean_text(active_form, field="active_form", maximum=500),
            "priority": _validate_priority(priority),
            "tag": _clean_text(tag, field="tag", maximum=128),
            "status": "pending",
            "owner": _clean_text(owner, field="owner", maximum=128),
            "blocks": [],
            "blocked_by": [],
            "metadata": _normalize_metadata(metadata),
            "created_at": now,
            "updated_at": now,
        }
        _gate_task(HookEvent.TASK_CREATED, "create_task", task)
        _atomic_write(_highwater_file(), task_id)
        tasks.append(task)
        _save_unlocked(tasks)
        return dict(task)


def list_tasks() -> list[dict[str, Any]]:
    with _THREAD_LOCK:
        return _load_unlocked()


def get_task(task_id: int) -> dict[str, Any] | None:
    normalized_id = int(task_id)
    for task in list_tasks():
        if task["id"] == normalized_id:
            return task
    return None


def update_task(
    task_id: int,
    *,
    title: str | None = None,
    description: str | None = None,
    active_form: str | None = None,
    priority: str | None = None,
    tag: str | None = None,
    status: str | None = None,
    owner: str | None = None,
    add_blocks: Iterable[Any] | None = None,
    add_blocked_by: Iterable[Any] | None = None,
    remove_blocks: Iterable[Any] | None = None,
    remove_blocked_by: Iterable[Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    normalized_id = int(task_id)
    with _THREAD_LOCK, _exclusive_update_lock():
        tasks = _load_unlocked()
        task = _task_map(tasks).get(normalized_id)
        if task is None:
            return None
        if title is not None:
            task["title"] = _clean_text(title, field="title", maximum=500, required=True)
        if description is not None:
            task["description"] = _clean_text(description, field="description", maximum=8_000)
        if active_form is not None:
            task["active_form"] = _clean_text(active_form, field="active_form", maximum=500)
        if priority is not None:
            task["priority"] = _validate_priority(priority)
        if tag is not None:
            task["tag"] = _clean_text(tag, field="tag", maximum=128)
        if owner is not None:
            task["owner"] = _clean_text(owner, field="owner", maximum=128)
        target_status = None
        if status is not None:
            target_status = _validate_status(status)
            _validate_status_transition(task["status"], target_status)
        if metadata is not None:
            patch = _normalize_metadata_patch(metadata)
            merged = dict(task["metadata"])
            for key, value in patch.items():
                if value is None:
                    merged.pop(key, None)
                else:
                    merged[key] = value
            task["metadata"] = _normalize_metadata(merged)
        _apply_relations(
            tasks,
            task,
            add_blocks=add_blocks,
            add_blocked_by=add_blocked_by,
            remove_blocks=remove_blocks,
            remove_blocked_by=remove_blocked_by,
        )
        if target_status is not None:
            if target_status in _DEPENDENCY_GATED_STATUSES:
                _assert_dependencies_resolved(task, tasks, action=target_status)
            if target_status == "completed" and task["status"] != "completed":
                _gate_task(HookEvent.TASK_COMPLETED, "complete_task", task)
            task["status"] = target_status
        _assert_impacted_dependency_states(tasks, [task["id"], *task["blocks"]])
        task["updated_at"] = _utc_now()
        _save_unlocked(tasks)
        return dict(task)


def complete_task(task_id: int) -> dict[str, Any] | None:
    return update_task(task_id, status="completed")


def cancel_task(task_id: int) -> dict[str, Any] | None:
    return update_task(task_id, status="cancelled")


def claim_task(task_id: int, owner: str, *, require_owner_idle: bool = True) -> dict[str, Any] | None:
    normalized_id = int(task_id)
    clean_owner = _clean_text(owner, field="owner", maximum=128, required=True)
    with _THREAD_LOCK, _exclusive_update_lock():
        tasks = _load_unlocked()
        by_id = _task_map(tasks)
        task = by_id.get(normalized_id)
        if task is None:
            return None
        if task["status"] == "completed":
            raise TaskStoreError("completed tasks cannot be claimed")
        if task["status"] in TERMINAL_STATUSES:
            raise TaskStoreError(
                f"{task['status']} tasks must be reopened before they can be claimed"
            )
        if task["owner"] and task["owner"] != clean_owner:
            raise TaskStoreError(f"task #{normalized_id} is already owned by {task['owner']}")
        _assert_dependencies_resolved(task, tasks, action="claimed")
        if require_owner_idle:
            busy = next(
                (
                    other
                    for other in tasks
                    if other["id"] != normalized_id
                    and other["owner"] == clean_owner
                    and other["status"] == "in_progress"
                ),
                None,
            )
            if busy is not None:
                raise TaskStoreError(f"{clean_owner} is already working on task #{busy['id']}")
        task["owner"] = clean_owner
        task["status"] = "in_progress"
        task["updated_at"] = _utc_now()
        _save_unlocked(tasks)
        return dict(task)


def delete_task(task_id: int) -> bool:
    normalized_id = int(task_id)
    with _THREAD_LOCK, _exclusive_update_lock():
        tasks = _load_unlocked()
        if normalized_id not in _task_map(tasks):
            return False
        remaining = [task for task in tasks if task["id"] != normalized_id]
        _remove_references(remaining, {normalized_id})
        _save_unlocked(remaining)
        return True


def search_tasks(keyword: str) -> list[dict[str, Any]]:
    needle = _clean_text(keyword, field="keyword", maximum=500, required=True).casefold()
    return [
        task
        for task in list_tasks()
        if needle in task["title"].casefold()
        or needle in task["description"].casefold()
        or needle in task["tag"].casefold()
    ]


def clear_completed() -> list[dict[str, Any]]:
    with _THREAD_LOCK, _exclusive_update_lock():
        tasks = _load_unlocked()
        removed = {task["id"] for task in tasks if task["status"] == "completed"}
        remaining = [task for task in tasks if task["id"] not in removed]
        _remove_references(remaining, removed)
        _save_unlocked(remaining)
        return remaining


def _format_task(task: dict[str, Any], tasks: list[dict[str, Any]]) -> str:
    owner = f" owner={task['owner']}" if task["owner"] else ""
    blockers = _unresolved_blockers(task, tasks)
    blocked = f" blocked_by={','.join(f'#{item}' for item in blockers)}" if blockers else ""
    return (
        f"#{task['id']} [{task['priority']}] [{task['status']}] "
        f"{task['title']}{owner}{blocked}"
    )


def _parse_id_list(value: str) -> list[int]:
    text = value.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = [item.strip() for item in text.split(",") if item.strip()]
    if not isinstance(parsed, list):
        raise TaskStoreError("task ID list must be a JSON array or comma-separated IDs")
    return _normalize_id_list(parsed, field="task IDs")


def _parse_metadata(value: str) -> dict[str, Any]:
    if not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise TaskStoreError(f"metadata_json is invalid JSON: {exc.msg}") from None
    return _normalize_metadata(parsed)


@register_tool(
    "list_tasks",
    "List persistent local tasks and unresolved dependencies",
    keywords=["list tasks", "show tasks", "all tasks", "todo list"],
    priority=110,
    params=[],
    source=__name__,
)
def show_tasks() -> str:
    tasks = list_tasks()
    return "\n".join(_format_task(task, tasks) for task in tasks) if tasks else "No tasks."


def list_tasks_tool() -> str:
    return show_tasks()


@register_tool(
    "create_task",
    "Create a persistent task with optional execution context",
    keywords=["create task", "add task", "new task"],
    match_fn=lambda text: any(
        task_word in text.lower() and create_word in text.lower()
        for task_word in ["task", "todo"]
        for create_word in ["create", "add", "new", "make"]
    ),
    priority=95,
    params=[
        ParamSchema("title", "string", "task title"),
        ParamSchema("priority", "string", "priority: low/medium/high", required=False, default="medium"),
        ParamSchema("description", "string", "detailed completion requirements", required=False, default=""),
        ParamSchema("active_form", "string", "short present-tense activity label", required=False, default=""),
        ParamSchema("owner", "string", "optional assignee", required=False, default=""),
        ParamSchema("tag", "string", "optional task tag", required=False, default=""),
        ParamSchema("metadata_json", "string", "optional JSON object metadata", required=False, default=""),
    ],
    input_adapter=adapt_task_title,
    source=__name__,
)
def create_task_tool(
    title: str,
    priority: str = "medium",
    description: str = "",
    active_form: str = "",
    owner: str = "",
    tag: str = "",
    metadata_json: str = "",
) -> str:
    task = create_task(
        title.strip(),
        priority,
        tag,
        description,
        active_form,
        owner,
        _parse_metadata(metadata_json),
    )
    return f"Created task #{task['id']}: {task['title']} [{task['priority']}]"


@register_tool(
    "get_task",
    "Get one persistent task including dependencies and metadata",
    params=[ParamSchema("task_id", "int", "task ID")],
    source=__name__,
)
def get_task_tool(task_id: int) -> str:
    task = get_task(int(task_id))
    if task is None:
        return f"Task #{task_id} not found"
    return json.dumps(task, ensure_ascii=False, indent=2)


@register_tool(
    "update_task",
    "Update task fields, status, metadata, or dependency relations",
    params=[
        ParamSchema("task_id", "int", "task ID"),
        ParamSchema("title", "string", "replacement title", required=False, default=""),
        ParamSchema("status", "string", "pending/in_progress/completed/failed/cancelled", required=False, default=""),
        ParamSchema("owner", "string", "replacement owner", required=False, default=""),
        ParamSchema("add_blocks", "string", "JSON array or comma-separated task IDs", required=False, default=""),
        ParamSchema("add_blocked_by", "string", "JSON array or comma-separated task IDs", required=False, default=""),
        ParamSchema("remove_blocks", "string", "JSON array or comma-separated task IDs", required=False, default=""),
        ParamSchema("remove_blocked_by", "string", "JSON array or comma-separated task IDs", required=False, default=""),
        ParamSchema("metadata_json", "string", "JSON object merged into metadata; null removes keys", required=False, default=""),
    ],
    source=__name__,
)
def update_task_tool(
    task_id: int,
    title: str = "",
    status: str = "",
    owner: str = "",
    add_blocks: str = "",
    add_blocked_by: str = "",
    remove_blocks: str = "",
    remove_blocked_by: str = "",
    metadata_json: str = "",
) -> str:
    task = update_task(
        int(task_id),
        title=title if title else None,
        status=status if status else None,
        owner=owner if owner else None,
        add_blocks=_parse_id_list(add_blocks),
        add_blocked_by=_parse_id_list(add_blocked_by),
        remove_blocks=_parse_id_list(remove_blocks),
        remove_blocked_by=_parse_id_list(remove_blocked_by),
        metadata=_parse_metadata(metadata_json) if metadata_json else None,
    )
    return f"Updated task #{task_id}: {task['title']}" if task else f"Task #{task_id} not found"


@register_tool(
    "claim_task",
    "Claim an unblocked task for an owner and mark it in progress",
    params=[
        ParamSchema("task_id", "int", "task ID to claim"),
        ParamSchema("owner", "string", "owner claiming the task"),
    ],
    source=__name__,
)
def claim_task_tool(task_id: int, owner: str) -> str:
    task = claim_task(int(task_id), owner)
    return (
        f"Claimed task #{task_id} for {task['owner']}: {task['title']}"
        if task
        else f"Task #{task_id} not found"
    )


@register_tool(
    "complete_task",
    "Mark a task as completed",
    keywords=["complete task", "done task", "finish task"],
    params=[ParamSchema("task_id", "int", "task ID to complete")],
    source=__name__,
)
def complete_task_tool(task_id: int) -> str:
    task = complete_task(int(task_id))
    return f"Completed #{task_id}: {task['title']}" if task else f"Task #{task_id} not found"


@register_tool(
    "cancel_task",
    "Cancel a pending or in-progress persistent task",
    keywords=["cancel task", "stop task"],
    params=[ParamSchema("task_id", "int", "task ID to cancel")],
    source=__name__,
)
def cancel_task_tool(task_id: int) -> str:
    task = cancel_task(int(task_id))
    return f"Cancelled #{task_id}: {task['title']}" if task else f"Task #{task_id} not found"


@register_tool(
    "delete_task",
    "Delete a task and clean dependency references",
    keywords=["delete task", "remove task"],
    params=[ParamSchema("task_id", "int", "task ID to delete")],
    source=__name__,
)
def delete_task_tool(task_id: int) -> str:
    ok = delete_task(int(task_id))
    return f"Deleted task #{task_id}" if ok else f"Task #{task_id} not found"


@register_tool(
    "search_tasks",
    "Search task titles, descriptions, and tags",
    keywords=["search tasks", "find task"],
    params=[ParamSchema("keyword", "string", "keyword to search for")],
    source=__name__,
)
def search_tasks_tool(keyword: str) -> str:
    results = search_tasks(keyword.strip())
    if not results:
        return f"No tasks matching '{keyword}'"
    tasks = list_tasks()
    return "\n".join(_format_task(task, tasks) for task in results)
