"""SQLAlchemy declarative base + cross-backend JSON type.

SQLite 存 TEXT, PostgreSQL 自动切换 JSONB — 对上层完全透明.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import TypeDecorator


class JSONText(TypeDecorator):
    """跨后端 JSON 列类型.

    SQLite:    TEXT (json.dumps / json.loads)
    PostgreSQL: JSONB (原生传递, 支持索引)
    """

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(Text())

    def process_bind_param(self, value: Any | None, dialect: Dialect) -> Any:
        if value is None:
            return None
        if dialect.name == "postgresql":
            return value  # psycopg2 原生处理 list/dict
        return json.dumps(value, ensure_ascii=False)

    def process_result_value(self, value: Any | None, dialect: Dialect) -> Any:
        if value is None:
            return None
        if dialect.name == "postgresql":
            return value  # SQLAlchemy JSONB 自动反序列化
        if isinstance(value, str):
            try:
                return json.loads(value)
            except (json.JSONDecodeError, TypeError):
                return value
        return value


class Base(DeclarativeBase):
    """所有模型的基类."""
    pass
