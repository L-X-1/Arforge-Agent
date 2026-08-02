from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from arforge.database.base import Base


@pytest.fixture
def isolated_db(monkeypatch, tmp_path):
    db_url = f"sqlite:///{tmp_path / 'semantic_memory.db'}"
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

    import arforge.semantic_memory as semantic_memory

    previous_index = semantic_memory._INDEX
    semantic_memory._INDEX = None

    yield

    semantic_memory._INDEX = previous_index
    dispose_engines()
    Base.metadata.drop_all(bind=engine)


def test_bm25_ranks_more_relevant_memory_first(isolated_db):
    from arforge.memory import save_memory_v2
    from arforge.semantic_memory import rebuild_semantic_index, semantic_search_memories

    focused_id = save_memory_v2(
        "User prefers black formatting for Python code; always run black after edits.",
        mem_type="preference",
        tags="python,formatting,black",
        importance=3,
    )
    save_memory_v2(
        "User mentioned Python once while discussing deployment notes.",
        mem_type="fact",
        tags="python,deployment",
        importance=3,
    )

    rebuild_semantic_index(force=True)
    results = semantic_search_memories("python formatting black preference", top_k=2)

    assert results
    assert results[0]["id"] == focused_id
    assert results[0]["score_details"]["algorithm"] == "bm25"
    assert "black" in results[0]["score_details"]["matched_terms"]


def test_synonym_expansion_finds_non_literal_memory(isolated_db):
    from arforge.memory import save_memory_v2
    from arforge.semantic_memory import rebuild_semantic_index, semantic_search_memories

    memory_id = save_memory_v2(
        "When a tool error happens, use the previous failure pattern before choosing a fix.",
        mem_type="workflow",
        tags="failure,tool",
        importance=4,
    )

    rebuild_semantic_index(force=True)
    results = semantic_search_memories("bug repair workflow", top_k=5, min_score=0.01)

    assert any(item["id"] == memory_id for item in results)
    found = next(item for item in results if item["id"] == memory_id)
    assert {"error", "fix"} & set(found["score_details"]["matched_terms"])


def test_chinese_synonym_bigram_recall(isolated_db):
    from arforge.memory import save_memory_v2
    from arforge.semantic_memory import rebuild_semantic_index, semantic_search_memories

    memory_id = save_memory_v2(
        "遇到工具错误时先分析失败模式，再给出修复方案。",
        mem_type="workflow",
        tags="错误,修复,流程",
        importance=4,
    )

    rebuild_semantic_index(force=True)
    results = semantic_search_memories("bug repair process", top_k=5, min_score=0.01)

    assert any(item["id"] == memory_id for item in results)
