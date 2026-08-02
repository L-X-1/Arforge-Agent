"""学习结果模型 — 对应 learning_outcomes 表."""

from __future__ import annotations

from sqlalchemy import Float, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base


class LearningOutcome(Base):
    __tablename__ = "learning_outcomes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    user_input: Mapped[str] = mapped_column(Text, nullable=False, default="")
    intent: Mapped[str] = mapped_column(Text, nullable=False, default="general")
    route: Mapped[str] = mapped_column(Text, nullable=False, default="unknown")
    tools_used: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    success: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    error_type: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    user_feedback: Mapped[str] = mapped_column(Text, nullable=False, default="")
    fix_strategy: Mapped[str] = mapped_column(Text, nullable=False, default="")
    regression: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    response_time_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    importance: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    injected_context_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
