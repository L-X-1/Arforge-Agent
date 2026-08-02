"""Data utility tools.

Read-only helpers that let the agent peek at structured data files (CSV/JSON) in the
workspace without writing a script and shelling out. Paths resolve against the
workspace root, identical to the file/code tools, so the agent can read the same
files it can edit.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from arforge.tool_registry import ParamSchema, register_tool


def read_csv_preview(path: str, limit: int = 5) -> list[dict]:
    with Path(path).open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))[:limit]


def summarize_rows(rows: list[dict]) -> dict:
    return {"rows": len(rows), "columns": list(rows[0]) if rows else []}


# ---------------------------------------------------------------------------
# Registered Agent tools
# ---------------------------------------------------------------------------


def _resolve_ws(filename: str) -> Path:
    """Resolve a workspace-relative path with the same escape guard as file_tools."""
    from arforge.tools.file_tools import _resolve

    return _resolve(filename)


@register_tool(
    "csv_preview",
    "Preview the first rows of a CSV file in the workspace as JSON objects. Use this to "
    "inspect a dataset's columns and sample values before analysing it. Paths resolve "
    "against the workspace root.",
    keywords=["csv preview", "read csv", "preview csv", "读取csv", "预览数据"],
    params=[
        ParamSchema("filename", "path", "path to a CSV file inside the workspace"),
        ParamSchema("limit", "int", "number of rows to return (default 5)", required=False, default=5),
    ],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def csv_preview(filename: str, limit: int = 5) -> str:
    path = _resolve_ws(filename)
    if not path.exists():
        raise OSError(f"file not found: {filename}")
    try:
        rows = read_csv_preview(str(path), limit=max(1, int(limit)))
    except Exception as exc:  # noqa: BLE001
        return f"ERROR reading {filename}: {exc}"
    if not rows:
        return f"(empty CSV: {filename})"
    summary = summarize_rows(read_csv_preview(str(path), limit=10000))
    return json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2)


@register_tool(
    "json_pretty",
    "Pretty-print a JSON file in the workspace (compact → 2-space indented). Useful to "
    "inspect package.json, config files, or data dumps. Returns the formatted JSON.",
    keywords=["json pretty", "format json", "查看json", "格式化json"],
    params=[
        ParamSchema("filename", "path", "path to a JSON file inside the workspace"),
    ],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def json_pretty(filename: str) -> str:
    path = _resolve_ws(filename)
    if not path.exists():
        raise OSError(f"file not found: {filename}")
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        return f"ERROR: invalid JSON in {filename}: {exc}"
    return json.dumps(data, ensure_ascii=False, indent=2)
