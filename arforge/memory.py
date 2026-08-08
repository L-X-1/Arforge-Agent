"""Local memory store — SQLAlchemy backend (SQLite / PostgreSQL)."""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Optional

from sqlalchemy import and_, func, or_

from arforge.database import Memory, get_session


def auto_extract_tags(content: str) -> str:
    text = content.lower()
    tags = []
    rules = {
        "code": ["code", "代码", "函数", "class", "def "],
        "bug": ["bug", "错误", "异常", "traceback", "fail"],
        "test": ["test", "pytest", "测试"],
        "architecture": ["architecture", "架构", "模块"],
        "brand": ["arforge", "brand"],
    }
    for tag, needles in rules.items():
        if any(needle in text for needle in needles):
            tags.append(tag)
    return ",".join(tags)


# ====================================================================
# Compat wrappers — 旧代码可能调用这些函数，保留空壳
# ====================================================================

def run_single_db_init(create_sql: str):  # noqa: ARG001
    """占位 — 表由 init_db() 自动创建."""
    pass


def register_db_init(name: str, fn):
    """占位 — 表由 init_db() 自动创建."""
    return {"name": name, "registered": True}


def init_memory_db():
    """占位 — 表由 init_db() 自动创建."""
    pass


# ====================================================================
# Core CRUD
# ====================================================================

def _similar_existing(content: str, project_id: str = "", workspace_path: str = "") -> Optional[int]:
    for item in query_memories(project_id=project_id, workspace_path=workspace_path, limit=500):
        if item.get("lifecycle", "active") != "active":
            continue
        if SequenceMatcher(None, content, item["content"]).ratio() > 0.92:
            return item["id"]
    return None


def save_memory(content: str):
    return save_memory_v2(content)


def save_memory_v2(
    content: str,
    mem_type: str = "knowledge",
    tags: str = "",
    importance: int = 1,
    source: str = "user",
    related_to: str = "",
    dedupe: bool = True,
    project_id: str = "",
    workspace_path: str = "",
) -> Optional[int]:
    from arforge.security_guard import sanitize_for_storage

    content = sanitize_for_storage(content)
    if not content or not content.strip():
        return None
    if dedupe:
        existing = _similar_existing(content, project_id=project_id, workspace_path=workspace_path)
        if existing is not None:
            return existing
    tags = tags or auto_extract_tags(content)
    from arforge.memory_os import MemoryOS

    actor = source if source in {"user", "user-corrected", "imported"} else f"runtime:{source}"
    memory = MemoryOS().create(
        content,
        mem_type=mem_type,
        tags=tags,
        importance=importance,
        source=source,
        related_to=related_to,
        project_id=project_id,
        workspace_path=workspace_path,
        provenance={"kind": "compatibility_api", "source": source},
        actor=actor,
        reason="created through save_memory_v2",
    )
    try:
        from arforge.core.memory_digest import refresh_digest_file

        refresh_digest_file()
    except Exception:
        pass
    return int(memory["id"])


def query_memories(
    query_text: str = "",
    mem_type: str = "",
    tag_filter: str = "",
    source_filter: str = "",
    project_id: str = "",
    workspace_path: str = "",
    importance_min: int = 0,
    limit: int = 20,
    lifecycle_filter: str = "",
) -> list[dict]:
    with get_session() as session:
        q = session.query(Memory)
        if query_text:
            q = q.filter(Memory.content.like(f"%{query_text}%"))
        if mem_type:
            q = q.filter(Memory.mem_type == mem_type)
        if tag_filter:
            q = q.filter(Memory.tags.like(f"%{tag_filter}%"))
        if source_filter:
            q = q.filter(Memory.source == source_filter)
        if project_id:
            q = q.filter(Memory.project_id == project_id)
        if workspace_path:
            q = q.filter(Memory.workspace_path == workspace_path)
        if importance_min:
            q = q.filter(Memory.importance >= importance_min)
        if lifecycle_filter:
            q = q.filter(Memory.lifecycle == lifecycle_filter)
        q = q.order_by(Memory.importance.desc(), Memory.id.desc()).limit(limit)
        rows = q.all()
    return [_memory_record(row) for row in rows]


def query_memories_for_scope(
    *,
    project_id: str,
    workspace_path: str,
    limit: int = 500,
    include_global_user_memories: bool = True,
) -> list[dict]:
    """Return active memories for one workspace without cross-project leakage.

    Explicit user memories may be global. Automatically generated, model-made,
    or quarantined memories must match the active workspace exactly.
    """
    with get_session() as session:
        scoped = and_(Memory.project_id == project_id, Memory.workspace_path == workspace_path)
        clauses = [scoped]
        if include_global_user_memories:
            clauses.append(
                and_(
                    Memory.project_id == "",
                    Memory.workspace_path == "",
                    Memory.source.in_(("user", "user-corrected", "imported")),
                )
            )
        rows = (
            session.query(Memory)
            .filter(or_(*clauses))
            .filter(Memory.lifecycle == "active")
            .filter(~Memory.source.like("quarantined:%"))
            .order_by(Memory.importance.desc(), Memory.id.desc())
            .limit(limit)
            .all()
        )
    return [_memory_record(row) for row in rows]


def load_memories(limit: int = 20) -> list[str]:
    return [item["content"] for item in query_memories(lifecycle_filter="active", limit=limit)]


def search_memories(keywords: str, limit: int = 10) -> list[dict]:
    return query_memories(query_text=keywords, lifecycle_filter="active", limit=limit)


def update_memory(memory_id: int, content: str = "", importance: int = 0) -> bool:
    from arforge.memory_os import MemoryNotFoundError, MemoryOS

    memory_os = MemoryOS()
    try:
        current = memory_os.get(memory_id)
    except MemoryNotFoundError:
        return False
    fields: dict = {}
    if content:
        fields["content"] = content
    if importance:
        fields["importance"] = importance
    if fields:
        memory_os.update(
            memory_id,
            expected_version=current["version"],
            actor="compatibility",
            reason="updated through update_memory",
            **fields,
        )
    return True


def update_memory_fields(
    memory_id: int,
    *,
    content: str | None = None,
    mem_type: str | None = None,
    tags: str | None = None,
    importance: int | None = None,
    source: str | None = None,
) -> dict | None:
    """Update an explicit set of memory fields and return the final record."""
    from arforge.memory_os import MemoryNotFoundError, MemoryOS

    memory_os = MemoryOS()
    try:
        current = memory_os.get(memory_id)
    except MemoryNotFoundError:
        return None
    fields = {
        key: value
        for key, value in {
            "content": content,
            "mem_type": mem_type,
            "tags": tags,
            "importance": importance,
            "source": source,
        }.items()
        if value is not None
    }
    if not fields:
        return current
    return memory_os.update(
        memory_id,
        expected_version=current["version"],
        actor=source or "compatibility",
        reason="updated through update_memory_fields",
        **fields,
    )


def delete_memory(memory_id: int) -> bool:
    from arforge.memory_os import MemoryOS

    return bool(
        MemoryOS().delete(
            memory_id,
            actor="compatibility",
            reason="deleted through delete_memory",
        )["deleted"]
    )


def delete_memories(memory_ids: list[int]) -> dict[str, list[int] | int]:
    """Delete explicitly selected memories, preserving the caller's ID order."""
    requested: list[int] = []
    seen: set[int] = set()
    for memory_id in memory_ids:
        if memory_id not in seen:
            requested.append(memory_id)
            seen.add(memory_id)
    deleted: list[int] = []
    not_found: list[int] = []
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    for memory_id in requested:
        result = memory_os.delete(
            memory_id,
            actor="compatibility",
            reason="deleted through delete_memories",
        )
        (deleted if result["deleted"] else not_found).append(memory_id)
    return {"requested": len(requested), "deleted": deleted, "not_found": not_found}


def get_memory_stats() -> dict:
    with get_session() as session:
        count = session.query(func.count(Memory.id)).scalar() or 0
        important = session.query(func.count(Memory.id)).filter(Memory.importance >= 3).scalar() or 0
    return {"count": count, "important": important}


def memory_facets(limit: int = 10_000) -> dict:
    """Return stable filter facets without exposing any memory content."""
    items = query_memories(limit=limit)

    def counts(field: str) -> list[dict]:
        grouped: dict[str, int] = {}
        for item in items:
            value = str(item.get(field, "")).strip()
            if value:
                grouped[value] = grouped.get(value, 0) + 1
        return [{"value": value, "count": count} for value, count in sorted(grouped.items(), key=lambda pair: (-pair[1], pair[0]))]

    tag_counts: dict[str, int] = {}
    for item in items:
        for tag in str(item.get("tags", "")).split(","):
            cleaned = tag.strip()
            if cleaned:
                tag_counts[cleaned] = tag_counts.get(cleaned, 0) + 1
    return {
        "schema_version": 1,
        "total": len(items),
        "projects": counts("project_id"),
        "workspaces": counts("workspace_path"),
        "types": counts("mem_type"),
        "sources": counts("source"),
        "tags": [{"value": value, "count": count} for value, count in sorted(tag_counts.items(), key=lambda pair: (-pair[1], pair[0]))],
    }


def _governance_reason(item: dict) -> str | None:
    source = str(item.get("source", "")).casefold()
    if source.startswith("quarantined:"):
        return None
    if source not in {"auto", "model"}:
        return None
    from arforge.auto_memory import assess_auto_memory_candidate

    eligible, reason = assess_auto_memory_candidate(item.get("content", ""), item.get("mem_type", ""))
    if not item.get("project_id") or not item.get("workspace_path"):
        return "unscoped_auto_memory"
    if not eligible:
        return reason
    return None


def memory_governance_audit(limit: int = 10_000, sample_limit: int = 100) -> dict:
    """Preview reversible quarantine candidates without changing user data."""
    items = query_memories(limit=limit)
    reasons: dict[str, int] = {}
    candidates: list[dict] = []
    already_quarantined = 0
    for item in items:
        if str(item.get("source", "")).casefold().startswith("quarantined:"):
            already_quarantined += 1
            continue
        reason = _governance_reason(item)
        if reason is None:
            continue
        reasons[reason] = reasons.get(reason, 0) + 1
        if len(candidates) < sample_limit:
            candidates.append(
                {
                    "id": item["id"],
                    "reason": reason,
                    "mem_type": item["mem_type"],
                    "source": item["source"],
                    "project_id": item["project_id"],
                    "workspace_path": item["workspace_path"],
                    "content_preview": item["content"][:160],
                }
            )
    return {
        "schema_version": 1,
        "scanned": len(items),
        "candidate_count": sum(reasons.values()),
        "already_quarantined": already_quarantined,
        "reasons": [
            {"reason": reason, "count": count}
            for reason, count in sorted(reasons.items(), key=lambda pair: (-pair[1], pair[0]))
        ],
        "candidates": candidates,
        "truncated": len(items) >= limit,
        "action": "quarantine",
        "reversible": True,
    }


def apply_memory_governance(limit: int = 10_000) -> dict:
    """Quarantine unsafe auto memories while retaining them for user review."""
    items = query_memories(limit=limit)
    candidates = {item["id"]: _governance_reason(item) for item in items}
    candidates = {memory_id: reason for memory_id, reason in candidates.items() if reason}
    quarantined: list[int] = []
    from arforge.memory_os import MemoryNotFoundError, MemoryOS, MemoryValidationError

    memory_os = MemoryOS()
    for memory_id, reason in candidates.items():
        try:
            current = memory_os.get(memory_id)
            memory_os.quarantine(
                memory_id,
                expected_version=current["version"],
                actor="runtime:governance",
                reason=str(reason),
            )
            quarantined.append(memory_id)
        except (MemoryNotFoundError, MemoryValidationError):
            continue
    return {
        "schema_version": 1,
        "scanned": len(items),
        "quarantined": len(quarantined),
        "quarantined_ids": quarantined,
        "reversible": True,
        "status": "applied",
    }


def semantic_search_memories(*args, **kwargs):
    """Lazy compatibility entry point for scoped semantic memory recall."""
    from arforge.semantic_memory import semantic_search_memories as search

    return search(*args, **kwargs)


def _memory_record(memory: Memory) -> dict:
    return {
        "id": memory.id,
        "created_at": memory.created_at,
        "updated_at": memory.updated_at,
        "content": memory.content,
        "mem_type": memory.mem_type,
        "tags": memory.tags,
        "importance": memory.importance,
        "source": memory.source,
        "project_id": memory.project_id,
        "workspace_path": memory.workspace_path,
        "related_to": memory.related_to,
        "strength": memory.strength,
        "review_level": memory.review_level,
        "last_reviewed_at": memory.last_reviewed_at,
        "memory_uid": memory.memory_uid,
        "memory_class": memory.memory_class,
        "lifecycle": memory.lifecycle,
        "confidence": memory.confidence,
        "version": memory.version,
        "content_digest": memory.content_digest,
        "provenance": dict(memory.provenance or {}),
    }


def decay_memory_strength(dry_run: bool = False) -> dict:
    if dry_run:
        return {"success": True, "updated": 0, "dry_run": True}
    from arforge.memory_os import MemoryOS

    updated = MemoryOS().decay()
    return {"success": True, "updated": updated, "dry_run": False}
