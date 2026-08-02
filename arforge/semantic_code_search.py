"""Semantic code search — TF-IDF scoring + synonym expansion.

Replaces the old substring-based implementation with a real TF-IDF index that
understands code-domain synonyms, so queries like "user authentication" match
"auth/login" code even without literal keyword overlap.
"""

from __future__ import annotations

from arforge.code_tfidf_index import get_tfidf_index


def semantic_code_search(
    query: str,
    top_k: int = 10,
    expand_synonyms: bool = True,
) -> dict:
    """Search the codebase with TF-IDF scoring and optional synonym expansion.

    Returns:
        {"results": [{file, score, matched_tokens}, ...], "query": str, "total": int}
    """
    index = get_tfidf_index()
    if index.doc_count == 0:
        # Auto-build on first call
        index.build(".")

    results = index.search(query, top_k=top_k, expand_synonyms=expand_synonyms)

    # Fall back to legacy symbol+text search if index is empty
    if not results:
        return _legacy_search(query)

    return {
        "results": results,
        "query": query,
        "total": len(results),
        "index_docs": index.doc_count,
        "method": "tfidf",
    }


def semantic_code_search_brief(query: str, top_k: int = 5) -> str:
    """Return a human-readable summary of semantic code search."""
    result = semantic_code_search(query, top_k=top_k)
    if result.get("method") == "legacy":
        lines = []
        symbols = result.get("symbols", [])
        text_items = result.get("text", [])
        for item in symbols[:3]:
            lines.append(f"symbol {item.get('name', '?')} at {item.get('file', '?')}:{item.get('line', '?')}")
        for item in text_items[:3]:
            lines.append(f"text at {item.get('path', '?')}:{item.get('line', '?')}")
        return "\n".join(lines) if lines else "No matches."

    results = result.get("results", [])
    if not results:
        return "No matches."

    lines = [f"TF-IDF search results for '{query}' ({result.get('index_docs', 0)} docs indexed):"]
    for r in results:
        lines.append(f"  {r['file']} (score={r['score']:.3f}, tokens={', '.join(r['matched_tokens'][:5])})")
    return "\n".join(lines)


def _legacy_search(query: str) -> dict:
    """Fallback: substring symbol + text search (used when index is empty)."""
    try:
        from arforge.code_indexer import search_code
        from arforge.python_ast_indexer import search_symbol

        return {
            "symbols": search_symbol(query),
            "text": search_code(query),
            "query": query,
            "total": 0,
            "method": "legacy",
        }
    except ImportError:
        return {"results": [], "query": query, "total": 0, "method": "none"}
