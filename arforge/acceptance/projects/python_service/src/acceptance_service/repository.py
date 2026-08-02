from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sqlite3


@dataclass(frozen=True)
class WorkItem:
    item_id: int
    title: str
    status: str


class WorkItemRepository:
    def __init__(self, database: str | Path) -> None:
        self.database = str(database)

    def migrate(self) -> None:
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS work_items (
                    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    status TEXT NOT NULL DEFAULT 'open'
                        CHECK(status IN ('open', 'closed'))
                )
                """
            )

    def create(self, title: str) -> WorkItem:
        normalized = title.strip()
        if not normalized:
            raise ValueError("title must not be blank")
        with sqlite3.connect(self.database) as connection:
            cursor = connection.execute(
                "INSERT INTO work_items(title) VALUES (?)",
                (normalized,),
            )
            item_id = int(cursor.lastrowid)
        return WorkItem(item_id=item_id, title=normalized, status="open")

    def list_all(self) -> list[WorkItem]:
        with sqlite3.connect(self.database) as connection:
            rows = connection.execute(
                "SELECT item_id, title, status FROM work_items ORDER BY item_id"
            ).fetchall()
        return [WorkItem(int(row[0]), str(row[1]), str(row[2])) for row in rows]

    def close(self, item_id: int) -> WorkItem | None:
        with sqlite3.connect(self.database) as connection:
            cursor = connection.execute(
                "UPDATE work_items SET status = 'closed' WHERE item_id = ?",
                (item_id,),
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute(
                "SELECT item_id, title, status FROM work_items WHERE item_id = ?",
                (item_id,),
            ).fetchone()
        assert row is not None
        return WorkItem(int(row[0]), str(row[1]), str(row[2]))
