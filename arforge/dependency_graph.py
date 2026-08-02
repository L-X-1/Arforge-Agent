"""Import dependency graph."""

from __future__ import annotations

from arforge.analysis_index import get_analysis_index


def index_dependencies() -> dict:
    index = get_analysis_index()
    return {"success": True, "files": len(index), "dependencies": sum(len(item.imports) for item in index.values())}


def list_dependencies(file_path: str = ""):
    index = get_analysis_index()
    if file_path:
        item = index.get(file_path)
        return item.imports if item else []
    return [{"file": path, "imports": item.imports} for path, item in index.items()]


def list_dependency_graph(limit: int = 100):
    rows = []
    for path, item in get_analysis_index().items():
        for imp in item.imports:
            rows.append({"from": path, "to": imp["module"], "line": imp["line"]})
    return rows[:limit]


def list_reverse_dependencies(file_path: str):
    needle = file_path.replace("/", ".").replace("\\", ".").removesuffix(".py")
    return [row for row in list_dependency_graph(10000) if needle in row["to"]]
