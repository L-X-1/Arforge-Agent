"""Knowledge v2 helpers."""

from __future__ import annotations

from arforge.knowledge_graph import get_knowledge_graph


def add_knowledge(subject: str, relation: str, object_: str):
    return get_knowledge_graph().add_edge(subject, object_, relation)


def query_knowledge_graph(subject: str):
    return get_knowledge_graph().neighbors(subject)
