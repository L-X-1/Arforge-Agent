"""Arforge Agent public package."""

from __future__ import annotations

__version__ = "1.0.0-test.1"
__brand__ = "Arforge Agent"
__brand_zh__ = "Arforge Agent"

def get_db_path() -> str:
    """兼容旧代码 — 返回 SQLite 数据库路径（仅用于文件级操作）.

    新代码请使用 arforge.database.get_session() 进行数据操作.
    """
    from arforge.paths import data_path

    return str(data_path("memory.db"))


# Explicit compatibility helper. Importing the package must never connect to
# or mutate an operator's database.
def auto_init_db():
    """Create legacy schemas explicitly for compatibility and local tests."""
    try:
        from arforge.database import init_db, init_ma_db

        init_db()
        init_ma_db()
    except Exception:
        pass  # 首次安装时 sqlalchemy 可能未安装
