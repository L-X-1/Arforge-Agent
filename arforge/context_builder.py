"""Compatibility helpers that produce source fragments, not final model input.

Provider-bound context is authorized, budgeted and verified by
``arforge.core.context_os`` at ``ArforgeAgent.prepare_context_messages``.
"""

from __future__ import annotations

from arforge.code_indexer import search_code
from arforge.memory import query_memories
from arforge.project_scanner import build_project_tree
from arforge.semantic_code_search import semantic_code_search_brief


def build_context(system_prompt: str, memory_text: str, conversation_history: list, current_user_input: str = None):
    parts = [system_prompt, memory_text]
    if current_user_input:
        parts.append(f"Current request: {current_user_input}")
    if conversation_history:
        parts.append("Recent conversation:")
        parts.extend(f"{item.get('role')}: {item.get('content')}" for item in conversation_history[-5:])
    return "\n\n".join(part for part in parts if part)


def build_retrieved_context(keyword: str, top_k: int = 5):
    code = search_code(keyword, limit=top_k)
    memories = query_memories(keyword, limit=top_k)
    lines = ["Code:"]
    lines.extend(f"- {item['path']}:{item['line']}" for item in code)
    lines.append("Memories:")
    lines.extend(f"- {item['content']}" for item in memories)
    return "\n".join(lines)


def build_coding_context(keyword: str):
    return f"Project tree:\n{build_project_tree(max_files=80)}\n\nSearch:\n{semantic_code_search_brief(keyword)}"
