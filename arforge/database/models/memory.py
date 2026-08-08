"""记忆模型 — 对应 memories 表."""

from __future__ import annotations

import uuid

from sqlalchemy import Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base, JSONText


class Memory(Base):
    __tablename__ = "memories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    mem_type: Mapped[str] = mapped_column(String(50), nullable=False, default="knowledge")
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="")
    importance: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="user")
    project_id: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    workspace_path: Mapped[str] = mapped_column(Text, nullable=False, default="")
    related_to: Mapped[str] = mapped_column(Text, nullable=False, default="")
    strength: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    review_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_reviewed_at: Mapped[str] = mapped_column(Text, nullable=False, default="")
    memory_uid: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, default=lambda: uuid.uuid4().hex
    )
    memory_class: Mapped[str] = mapped_column(String(32), nullable=False, default="semantic")
    lifecycle: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    content_digest: Mapped[str] = mapped_column(Text, nullable=False, default="")
    provenance: Mapped[dict] = mapped_column(JSONText, nullable=False, default=dict)
