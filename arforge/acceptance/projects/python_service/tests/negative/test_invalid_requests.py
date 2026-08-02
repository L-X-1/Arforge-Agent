import sqlite3

import pytest
from fastapi.testclient import TestClient

from acceptance_service.app import create_app
from acceptance_service.repository import WorkItemRepository


def test_api_rejects_blank_title_and_missing_item(tmp_path):
    client = TestClient(create_app(tmp_path / "negative.db"))

    assert client.post("/items", json={"title": ""}).status_code == 422
    assert client.post("/items/999/close").status_code == 404


def test_database_constraint_rejects_invalid_status(tmp_path):
    database = tmp_path / "constraint.db"
    repository = WorkItemRepository(database)
    repository.migrate()

    with sqlite3.connect(database) as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO work_items(title, status) VALUES (?, ?)",
                ("invalid", "deleted"),
            )
