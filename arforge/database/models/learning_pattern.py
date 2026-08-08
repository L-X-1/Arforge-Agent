"""学习模式模型 — 对应 learning_patterns 表."""

from __future__ import annotations

from sqlalchemy import Float, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base, JSONText


class LearningPattern(Base):
    __tablename__ = "learning_patterns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)
    pattern_type: Mapped[str] = mapped_column(Text, nullable=False, default="failure")
    description: Mapped[str] = mapped_column(Text, nullable=False)
    frequency: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    provenance: Mapped[dict] = mapped_column(JSONText, nullable=False, default=dict)
