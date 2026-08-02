"""Local memory store — SQLAlchemy backend (SQLite / PostgreSQL)."""

from __future__ import annotations

from datetime import datetime
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
    now = datetime.now().isoformat(timespec="seconds")
    tags = tags or auto_extract_tags(content)
    with get_session() as session:
        mem = Memory(
            created_at=now,
            updated_at=now,
            content=content.strip(),
            mem_type=mem_type,
            tags=tags,
            importance=importance,
            source=source,
            project_id=project_id,
            workspace_path=workspace_path,
            related_to=related_to,
        )
        session.add(mem)
        session.flush()
        return int(mem.id)


def query_memories(
    query_text: str = "",
    mem_type: str = "",
    tag_filter: str = "",
    source_filter: str = "",
    project_id: str = "",
    workspace_path: str = "",
    importance_min: int = 0,
    limit: int = 20,
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
            .filter(~Memory.source.like("quarantined:%"))
            .order_by(Memory.importance.desc(), Memory.id.desc())
            .limit(limit)
            .all()
        )
    return [_memory_record(row) for row in rows]


def load_memories(limit: int = 20) -> list[str]:
    return [item["content"] for item in query_memories(limit=limit)]


def search_memories(keywords: str, limit: int = 10) -> list[dict]:
    return query_memories(query_text=keywords, limit=limit)


def update_memory(memory_id: int, content: str = "", importance: int = 0) -> bool:
    with get_session() as session:
        mem = session.get(Memory, memory_id)
        if mem is None:
            return False
        if content:
            from arforge.security_guard import sanitize_for_storage

            mem.content = sanitize_for_storage(content)
        if importance:
            mem.importance = importance
        mem.updated_at = datetime.now().isoformat(timespec="seconds")
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
    with get_session() as session:
        mem = session.get(Memory, memory_id)
        if mem is None:
            return None
        if content is not None:
            from arforge.security_guard import sanitize_for_storage

            cleaned = sanitize_for_storage(content).strip()
            if not cleaned:
                raise ValueError("content must not be empty")
            mem.content = cleaned
        if mem_type is not None:
            mem.mem_type = mem_type
        if tags is not None:
            mem.tags = tags
        if importance is not None:
            mem.importance = importance
        if source is not None:
            mem.source = source
        mem.updated_at = datetime.now().isoformat(timespec="seconds")
        session.flush()
        return _memory_record(mem)


def delete_memory(memory_id: int) -> bool:
    with get_session() as session:
        mem = session.get(Memory, memory_id)
        if mem is None:
            return False
        session.delete(mem)
        return True


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
    with get_session() as session:
        for memory_id in requested:
            mem = session.get(Memory, memory_id)
            if mem is None:
                not_found.append(memory_id)
            else:
                session.delete(mem)
                deleted.append(memory_id)
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
    with get_session() as session:
        for memory_id, reason in candidates.items():
            mem = session.get(Memory, memory_id)
            if mem is None or str(mem.source).casefold().startswith("quarantined:"):
                continue
            original_source = mem.source
            mem.source = f"quarantined:{original_source}"
            mem.importance = 1
            mem.strength = 0.1
            reason_tag = f"quarantine:{reason}"
            existing_tags = [tag.strip() for tag in str(mem.tags).split(",") if tag.strip()]
            if reason_tag not in existing_tags:
                existing_tags.append(reason_tag)
            mem.tags = ",".join(existing_tags)
            mem.updated_at = datetime.now().isoformat(timespec="seconds")
            quarantined.append(memory_id)
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
    }


def decay_memory_strength(dry_run: bool = False) -> dict:
    if dry_run:
        return {"success": True, "updated": 0, "dry_run": True}
    with get_session() as session:
        updated = session.query(Memory).update(
            {Memory.strength: func.max(0.1, Memory.strength * 0.99)},
            synchronize_session="fetch",
        )
        return {"success": True, "updated": updated, "dry_run": False}
