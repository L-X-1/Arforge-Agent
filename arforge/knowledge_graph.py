"""Small local knowledge graph."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class KnowledgeGraph:
    nodes: dict[str, dict] = field(default_factory=dict)
    edges: list[dict] = field(default_factory=list)

    def add_node(self, name: str, **metadata):
        self.nodes[name] = self.nodes.get(name, {}) | metadata
        return self.nodes[name]

    def add_edge(self, source: str, target: str, relation: str = "related"):
        self.add_node(source)
        self.add_node(target)
        edge = {"source": source, "target": target, "relation": relation}
        self.edges.append(edge)
        return edge

    def neighbors(self, name: str):
        return [edge for edge in self.edges if edge["source"] == name or edge["target"] == name]


_GRAPH = KnowledgeGraph()


def get_knowledge_graph() -> KnowledgeGraph:
    return _GRAPH
