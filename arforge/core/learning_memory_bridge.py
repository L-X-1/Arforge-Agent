# -*- coding: utf-8 -*-
"""Learning-Memory Bridge — auto-promotes high-confidence memories into learning patterns.

Pipeline:
  1. Scan memories for high-importance, high-review-level items
  2. Classify them as learning pattern candidates (preference, convention, constraint, workflow)
  3. Upsert as LearningPattern records
  4. Track bidirectional links for traceability

This closes the loop between the memory layer (8-rule auto-extraction) and the
learning layer (pattern consolidation + injection).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime

from arforge.database import LearningPattern, Memory, get_session

logger = logging.getLogger(__name__)

# Minimum criteria for a memory to be promoted
_MIN_IMPORTANCE = 3
_MIN_REVIEW_LEVEL = 2
_MIN_FREQUENCY_FOR_PATTERN = 1

# Mapping: memory mem_type -> learning pattern_type
_TYPE_MAP: dict[str, str] = {
    "preference": "preference",
    "convention": "convention",
    "constraint": "constraint",
    "workflow": "workflow",
    "error": "failure",
    "identity": "preference",
    "project": "convention",
    "fact": "convention",
}


def _classify_memory(mem: Memory) -> str | None:
    """Map a memory to a learning pattern type, or None if not promotable."""
    mem_type = (mem.mem_type or "").lower()
    return _TYPE_MAP.get(mem_type)


def promote_memories_to_patterns(dry_run: bool = False) -> dict:
    """Scan memories and promote high-quality ones to learning patterns.

    Returns:
        dict with promoted, skipped, and total counts.
    """
    promoted = 0
    skipped_low_importance = 0
    skipped_low_review = 0
    skipped_unclassified = 0

    with get_session() as session:
        candidates = (
            session.query(Memory)
            .filter(Memory.importance >= _MIN_IMPORTANCE)
            .filter(Memory.review_level >= _MIN_REVIEW_LEVEL)
            .filter(Memory.lifecycle == "active")
            .all()
        )

    results = []
    for mem in candidates:
        pattern_type = _classify_memory(mem)
        if pattern_type is None:
            skipped_unclassified += 1
            continue

        if dry_run:
            results.append({
                "memory_id": mem.id,
                "content": (mem.content or "")[:100],
                "pattern_type": pattern_type,
                "importance": mem.importance,
                "review_level": mem.review_level,
            })
            promoted += 1
            continue

        # Upsert pattern
        with get_session() as session:
            existing = (
                session.query(LearningPattern)
                .filter(LearningPattern.description.like(f"%{mem.content[:60]}%"))
                .first()
            )

            if existing:
                existing.frequency = (existing.frequency or 0) + 1
                existing.confidence = min(0.95, (existing.confidence or 0.5) + 0.1)
                existing.updated_at = datetime.now().isoformat(timespec="seconds")
                existing.tags = _merge_tags(existing.tags, mem.tags, pattern_type)
                existing.provenance = {
                    "kind": "memory_promotion",
                    "memory_id": mem.id,
                    "memory_uid": mem.memory_uid,
                    "memory_version": mem.version,
                }
            else:
                pattern = LearningPattern(
                    created_at=datetime.now().isoformat(timespec="seconds"),
                    updated_at=datetime.now().isoformat(timespec="seconds"),
                    pattern_type=pattern_type,
                    description=f"[auto-from-memory] {mem.content[:200]}",
                    frequency=1,
                    confidence=min(0.7, 0.3 + 0.1 * max(1, mem.review_level or 0)),
                    tags=_merge_tags("", mem.tags, pattern_type),
                    provenance={
                        "kind": "memory_promotion",
                        "memory_id": mem.id,
                        "memory_uid": mem.memory_uid,
                        "memory_version": mem.version,
                    },
                )
                session.add(pattern)

        promoted += 1

    return {
        "promoted": promoted,
        "skipped_low_importance": skipped_low_importance,
        "skipped_low_review": skipped_low_review,
        "skipped_unclassified": skipped_unclassified,
        "total_candidates": len(candidates),
        "dry_run": dry_run,
    }


def _merge_tags(existing_tags: str | None, new_tags: str | None, pattern_type: str) -> str:
    """Merge tag strings, deduplicating."""
    tags_set: set[str] = set()
    if existing_tags:
        for t in json.loads(existing_tags) if existing_tags.startswith("[") else existing_tags.split(","):
            t = t.strip()
            if t:
                tags_set.add(t)
    if new_tags:
        for t in new_tags.split(","):
            t = t.strip()
            if t:
                tags_set.add(t)
    tags_set.add(pattern_type)
    return json.dumps(sorted(tags_set), ensure_ascii=False)


def get_bridge_stats() -> dict:
    """Get statistics about the learning-memory bridge state."""
    with get_session() as session:
        total_memories = session.query(Memory).count() or 0
        high_quality = (
            session.query(Memory)
            .filter(Memory.importance >= _MIN_IMPORTANCE)
            .filter(Memory.review_level >= _MIN_REVIEW_LEVEL)
            .count()
        ) or 0
        auto_patterns = (
            session.query(LearningPattern)
            .filter(LearningPattern.description.like("%[auto-from-memory]%"))
            .count()
        ) or 0
        total_patterns = session.query(LearningPattern).count() or 0

    return {
        "total_memories": total_memories,
        "high_quality_memories": high_quality,
        "auto_promoted_patterns": auto_patterns,
        "total_patterns": total_patterns,
        "promotion_threshold": {
            "min_importance": _MIN_IMPORTANCE,
            "min_review_level": _MIN_REVIEW_LEVEL,
        },
    }
