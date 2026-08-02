"""令牌用量模型 — 对应 token_usage 表."""

from __future__ import annotations

from sqlalchemy import Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from arforge.database.base import Base


class TokenUsage(Base):
    __tablename__ = "token_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # P0-1: DeepSeek 上下文缓存命中/未命中 token，用于缓存命中率与成本监控
    prompt_cache_hit_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt_cache_miss_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    provider_name: Mapped[str] = mapped_column(Text, nullable=False, default="")
    request_kind: Mapped[str] = mapped_column(Text, nullable=False, default="")
    stable_prefix_fingerprint: Mapped[str] = mapped_column(Text, nullable=False, default="")
    prompt_fingerprint: Mapped[str] = mapped_column(Text, nullable=False, default="")
    run_id: Mapped[str] = mapped_column(Text, nullable=False, default="")
    task_id: Mapped[str] = mapped_column(Text, nullable=False, default="")
