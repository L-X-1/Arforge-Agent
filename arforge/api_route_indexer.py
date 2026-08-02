"""API route discovery for common Python web frameworks."""

from __future__ import annotations

import re
from pathlib import Path


ROUTE_RE = re.compile(r"@(?:app|router)\.(get|post|put|delete|patch)\(['\"]([^'\"]+)['\"]")


def index_api_routes(root: str = "arforge") -> dict:
    return {"success": True, "routes": len(list_api_routes(root=root))}


def list_api_routes(limit: int = 100, root: str = "arforge"):
    routes = []
    for path in Path(root).rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in ROUTE_RE.finditer(text):
            routes.append({"file": str(path), "method": match.group(1).upper(), "path": match.group(2)})
    return routes[:limit]


def find_route(route_keyword: str):
    return [route for route in list_api_routes(10000) if route_keyword in route["path"]]


def list_routes_by_file(file_path: str):
    return [route for route in list_api_routes(10000) if route["file"].endswith(file_path)]


def list_routes_by_framework(framework: str):
    return list_api_routes(10000) if framework.lower() in {"fastapi", "flask", "starlette"} else []


def api_route_status():
    return index_api_routes()
