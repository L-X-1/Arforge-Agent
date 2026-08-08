"""数据库层统一入口.

导出核心 API:
- get_session / get_engine — 连接管理
- Base — 模型基类
- init_db — 自动建表
- 所有 Model 类
"""

from __future__ import annotations

from arforge.database.base import Base, JSONText
from arforge.database.config import get_database_url, get_multiagent_database_url
from arforge.database.engine import (
    dispose_engines,
    get_engine,
    get_ma_engine,
    get_ma_session,
    get_session,
)
from arforge.database.migration import init_db, init_ma_db, show_db_info

# ── 模型 ─────────────────────────────────────────────────────────────────
from arforge.database.models.learning_experience import LearningExperience
from arforge.database.models.learning_outcome import LearningOutcome
from arforge.database.models.learning_pattern import LearningPattern
from arforge.database.models.memory import Memory
from arforge.database.models.memory_os import MemoryRelation, MemoryRetrievalEvent, MemoryRevision
from arforge.database.models.multiagent import MultiagentConversation, MultiagentTask
from arforge.database.models.token_usage import TokenUsage

__all__ = [
    # 核心
    "Base",
    "JSONText",
    "get_engine",
    "get_ma_engine",
    "get_session",
    "get_ma_session",
    "get_database_url",
    "get_multiagent_database_url",
    "init_db",
    "init_ma_db",
    "dispose_engines",
    "show_db_info",
    # 模型
    "Memory",
    "MemoryRevision",
    "MemoryRelation",
    "MemoryRetrievalEvent",
    "LearningExperience",
    "LearningOutcome",
    "LearningPattern",
    "TokenUsage",
    "MultiagentTask",
    "MultiagentConversation",
]
