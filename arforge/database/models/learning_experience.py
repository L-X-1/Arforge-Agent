"""学习经验模型 — 对应 learning_experiences 表."""

from __future__ import annotations

from sqlalchemy import Float, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base


class LearningExperience(Base):
    __tablename__ = "learning_experiences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)  # JSON 字符串
    route_type: Mapped[str] = mapped_column(Text, nullable=False, default="unknown")
    has_error: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    importance: Mapped[float] = mapped_column(Float, nullable=False, default=0)
