"""Learning database helpers — SQLAlchemy backend."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime

from sqlalchemy import desc

from arforge.database import LearningExperience, get_session
from arforge.learning_schema import TurnExperience


def init_learning_db():
    """占位 — 表由 init_db() 自动创建."""
    pass


def record_experience(experience: TurnExperience) -> int:
    from arforge.security_guard import sanitize_for_storage

    payload = sanitize_for_storage(asdict(experience))
    created_at = experience.timestamp or datetime.now().isoformat(timespec="seconds")
    with get_session() as session:
        exp = LearningExperience(
            created_at=created_at,
            payload=json.dumps(payload, ensure_ascii=False),
            route_type=experience.route_type,
            has_error=int(experience.has_error),
            importance=experience.importance,
        )
        session.add(exp)
        session.flush()
        return int(exp.id)


def list_experiences(limit: int = 20) -> list[dict]:
    with get_session() as session:
        rows = (
            session.query(LearningExperience)
            .order_by(desc(LearningExperience.id))
            .limit(limit)
            .all()
        )
    results = []
    for row in rows:
        payload = json.loads(row.payload)
        payload.update({"id": row.id, "created_at": row.created_at})
        results.append(payload)
    return results
