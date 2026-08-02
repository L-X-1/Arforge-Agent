def test_code_chunks_and_retrieval():
    from arforge.code_chunk_indexer import index_code_chunks, search_code_chunks
    from arforge.code_retriever import build_retrieved_context

    assert index_code_chunks()["chunks"] > 0
    assert search_code_chunks("Arforge", limit=3)
    assert build_retrieved_context("Arforge", top_k=3)


def test_code_summary_and_navigation():
    from arforge.code_navigation_agent import navigation_answer
    from arforge.code_summarizer import list_module_summaries, summarize_code_file

    assert "lines" in summarize_code_file("arforge/agent_core.py")
    assert list_module_summaries(limit=3)
    assert navigation_answer("ArforgeAgent")
