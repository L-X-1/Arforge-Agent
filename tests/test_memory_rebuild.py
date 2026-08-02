def test_memory_save_query_and_dedupe():
    from arforge.memory import query_memories, save_memory_v2

    content = "remember Arforge module rebuild preference"
    first = save_memory_v2(content, tags="test", importance=3)
    second = save_memory_v2(content, tags="test", importance=3)
    rows = query_memories("Arforge module rebuild", limit=5)

    assert first == second
    assert any(row["id"] == first for row in rows)


def test_semantic_memory_search_finds_saved_memory():
    from arforge.memory import save_memory_v2
    from arforge.semantic_memory import rebuild_semantic_index, semantic_search_memories

    save_memory_v2("semantic search should find capability routing notes", tags="capability")
    rebuild_semantic_index(force=True)

    results = semantic_search_memories("capability routing", top_k=3)

    assert results
    assert results[0]["score"] > 0


def test_auto_memory_extracts_rule_based_memory():
    from arforge.auto_memory import extract_memories_from_turn

    memories = extract_memories_from_turn("请记住 Arforge 使用 arforge 作为正式命令", auto_save=False)

    assert memories
    assert memories[0]["importance"] >= 2
