"""Manual PostgreSQL connection smoke test for ARFORGE_DB_URL."""

from __future__ import annotations

from sqlalchemy import text

from arforge.database import init_db
from arforge.database.config import get_database_url
from arforge.database.engine import dispose_engines, get_engine
from arforge.memory import get_memory_stats, query_memories, save_memory_v2


def main() -> int:
    """Connect to PostgreSQL, initialize schema and run a small memory smoke test."""
    get_database_url()
    dispose_engines()

    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(text("SELECT current_database(), version()")).fetchone()
        if row is None:
            raise RuntimeError("PostgreSQL did not return database metadata")
        print(f"Database: {row[0]}")
        print(f"Version: {row[1][:80]}...")

    init_db()
    print("Database tables initialized")

    memory_id = save_memory_v2("PostgreSQL smoke test memory")
    print(f"Saved memory ID={memory_id}")
    stats = get_memory_stats()
    print(f"Stats: {stats}")
    results = query_memories(limit=3)
    print(f"Query: {len(results)} rows")
    print("\n=== PostgreSQL smoke test completed ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
