"""Project architecture summary."""

from __future__ import annotations

from pathlib import Path


def analyze_project_architecture() -> dict:
    components = list_architecture_components()
    return {"components": components, "count": len(components)}


def list_architecture_components(limit: int = 100):
    rows = []
    for path in Path("arforge").iterdir():
        if path.is_dir():
            rows.append({"name": path.name, "type": "package"})
        elif path.suffix == ".py":
            rows.append({"name": path.stem, "type": "module"})
    return rows[:limit]


def list_architecture_components_by_type(component_type: str):
    return [item for item in list_architecture_components(10000) if item["type"] == component_type]


def show_project_architecture() -> str:
    return "\n".join(f"{item['type']}: {item['name']}" for item in list_architecture_components())
