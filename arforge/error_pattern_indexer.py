"""Error log pattern index."""

from __future__ import annotations

from pathlib import Path


ERROR_LOG = Path(".arforge") / "error_logs.txt"


def record_error_log(error_text: str):
    ERROR_LOG.parent.mkdir(parents=True, exist_ok=True)
    with ERROR_LOG.open("a", encoding="utf-8") as handle:
        handle.write(error_text + "\n---\n")
    return {"success": True}


def list_error_logs(limit: int = 20):
    if not ERROR_LOG.exists():
        return []
    chunks = ERROR_LOG.read_text(encoding="utf-8").split("\n---\n")
    return [{"id": i + 1, "text": text} for i, text in enumerate(chunks) if text.strip()][:limit]


def analyze_error_text(error_text: str):
    lowered = error_text.lower()
    kind = "syntax" if "syntaxerror" in lowered else "import" if "importerror" in lowered or "modulenotfound" in lowered else "runtime"
    return {"type": kind, "text": error_text}


def index_error_patterns():
    return {"success": True, "errors": len(list_error_logs(10000))}


def list_error_patterns(limit: int = 100):
    return [analyze_error_text(item["text"]) for item in list_error_logs(limit)]


def list_error_patterns_by_type(error_type: str):
    return [item for item in list_error_patterns(10000) if item["type"] == error_type]


def show_error_log(error_id_text: str):
    rows = list_error_logs(10000)
    idx = int(error_id_text) - 1
    return rows[idx] if 0 <= idx < len(rows) else None


def error_pattern_status():
    return index_error_patterns()
