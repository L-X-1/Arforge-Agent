"""多智能体模型 — 对应 multiagent_tasks + multiagent_conversations 表."""

from __future__ import annotations

from sqlalchemy import Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base


class MultiagentTask(Base):
    __tablename__ = "multiagent_tasks"

    task_id: Mapped[str] = mapped_column(Text, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(Text, nullable=False)
    parent_task_id: Mapped[str] = mapped_column(Text, nullable=False, default="")
    role: Mapped[str] = mapped_column(Text, nullable=False)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    inputs: Mapped[str] = mapped_column(Text, nullable=False, default="{}")  # JSON
    constraints: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    depends_on: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    deadline_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    success: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output: Mapped[str] = mapped_column(Text, nullable=False, default="")
    artifacts: Mapped[str] = mapped_column(Text, nullable=False, default="{}")  # JSON
    evidence: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    tool_calls: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON
    elapsed_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[str] = mapped_column(Text, nullable=False, default="")


class MultiagentConversation(Base):
    __tablename__ = "multiagent_conversations"

    conversation_id: Mapped[str] = mapped_column(Text, primary_key=True)
    master_goal: Mapped[str] = mapped_column(Text, nullable=False)
    shared_memory: Mapped[str] = mapped_column(Text, nullable=False, default="{}")  # JSON
    created_at: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[str] = mapped_column(Text, nullable=False, default="")
