def test_knowledge_graph_and_v2():
    from arforge.knowledge_graph import get_knowledge_graph
    from arforge.knowledge_v2 import add_knowledge, query_knowledge_graph

    graph = get_knowledge_graph()
    graph.add_edge("Arforge", "Agent", "is")
    add_knowledge("Agent", "has", "memory")

    assert graph.neighbors("Arforge")
    assert query_knowledge_graph("Agent")


def test_model_reasoning_extracts_json():
    from arforge.model_reasoning import extract_json, summarize_reasoning

    assert extract_json('prefix {"x": 1}') == {"x": 1}
    assert summarize_reasoning("abc", 2) == "ab"


def test_learning_facades():
    from arforge.learning_cli import learning_report, learning_status
    from arforge.learning_engine import get_learning_engine
    from arforge.learning_engine import learning_system_info

    assert get_learning_engine() is not None

    # consolidation returns a dict with patterns_found
    result = get_learning_engine().consolidate()  # was consolidate_learning)
    assert "patterns_found" in result

    # dreaming returns a dict with insights/suggestions
    dream_result = get_learning_engine().dream()  # was run_dreaming_once)
    assert isinstance(dream_result, dict)
    assert "insights" in dream_result

    # meta info: status is now "active" (was "rebuilt")
    info = learning_system_info()
    assert "status" in info
    assert "version" in info

    assert isinstance(learning_report(), dict)
    assert isinstance(learning_status(), str)
