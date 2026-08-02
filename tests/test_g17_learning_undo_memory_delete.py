from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from arforge.database.base import Base


@pytest.fixture
def isolated_db(monkeypatch, tmp_path):
    db_url = f"sqlite:///{tmp_path / 'learning_undo.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", db_url)

    engine = create_engine(db_url)
    Base.metadata.create_all(bind=engine)

    from arforge.database.engine import dispose_engines

    dispose_engines()
    monkeypatch.setattr("arforge.database.engine._engine", engine)
    monkeypatch.setattr(
        "arforge.database.engine._SessionLocal",
        sessionmaker(bind=engine, expire_on_commit=False),
    )

    import arforge.learning_system as learning_module

    previous_learning = learning_module._LEARNING
    learning_module._LEARNING = None

    yield

    learning_module._LEARNING = previous_learning
    dispose_engines()
    Base.metadata.drop_all(bind=engine)


def test_learn_undo_deletes_learning_outcome(isolated_db):
    from arforge.learning_system import get_learning_system
    from arforge.slash_commands import run_slash_command

    learning = get_learning_system()
    row_id = learning.record_turn(
        "bad learning should be removable",
        "answer",
        injected_context_size=17,
    )

    assert any(item.outcome_id == row_id for item in learning.get_outcomes(limit=10))

    result = run_slash_command(f"/learn undo {row_id}")

    assert f"Deleted learning #{row_id}" in result
    assert all(item.outcome_id != row_id for item in learning.get_outcomes(limit=10))


def test_memory_delete_removes_saved_memory(isolated_db):
    from arforge.memory import query_memories, save_memory_v2
    from arforge.slash_commands import run_slash_command

    memory_id = save_memory_v2(
        "wrong project convention", mem_type="convention", importance=4
    )
    assert memory_id is not None

    result = run_slash_command(f"/memory delete {memory_id}")

    assert result == f"Deleted memory #{memory_id}."
    assert all(item["id"] != memory_id for item in query_memories(limit=20))


def test_memory_delete_validates_id(isolated_db):
    from arforge.slash_commands import run_slash_command

    assert run_slash_command("/memory delete nope") == "Usage: /memory delete <id>"
