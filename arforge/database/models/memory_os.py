"""Governed Memory OS audit, relation, and retrieval telemetry models."""

from __future__ import annotations

from sqlalchemy import Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base, JSONText


class MemoryRevision(Base):
    __tablename__ = "memory_revisions"
    __table_args__ = (
        UniqueConstraint("memory_id", "version", name="uq_memory_revision_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    memory_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("memories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    memory_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    operation: Mapped[str] = mapped_column(String(32), nullable=False)
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_run_id: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_event_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=-1)
    snapshot: Mapped[dict] = mapped_column(JSONText, nullable=False, default=dict)
    content_digest: Mapped[str] = mapped_column(Text, nullable=False)
    previous_revision_digest: Mapped[str] = mapped_column(Text, nullable=False, default="")
    revision_digest: Mapped[str] = mapped_column(Text, nullable=False, unique=True)


class MemoryRelation(Base):
    __tablename__ = "memory_relations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    relation_uid: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    source_memory_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("memories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_memory_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("memories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    relation_type: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="proposed")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    evidence: Mapped[dict] = mapped_column(JSONText, nullable=False, default=dict)
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")


class MemoryRetrievalEvent(Base):
    __tablename__ = "memory_retrieval_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    retrieval_uid: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    scope_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    query_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    algorithm: Mapped[str] = mapped_column(String(64), nullable=False)
    algorithm_version: Mapped[str] = mapped_column(String(32), nullable=False)
    candidate_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    returned: Mapped[list] = mapped_column(JSONText, nullable=False, default=list)
    latency_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    feedback: Mapped[dict] = mapped_column(JSONText, nullable=False, default=dict)


__all__ = ["MemoryRelation", "MemoryRetrievalEvent", "MemoryRevision"]
