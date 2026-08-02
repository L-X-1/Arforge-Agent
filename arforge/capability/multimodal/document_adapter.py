"""Document text adapter."""

from __future__ import annotations

from pathlib import Path


def read_document_text(path: str | Path, max_chars: int = 20000) -> str:
    doc = Path(path)
    if not doc.exists():
        return "Document not found."
    if doc.suffix.lower() in {".txt", ".md", ".rst", ".py", ".json", ".toml"}:
        return doc.read_text(encoding="utf-8", errors="replace")[:max_chars]
    return f"Unsupported document type: {doc.suffix}"


def document_metadata(path: str | Path) -> dict:
    doc = Path(path)
    return {"path": str(doc), "exists": doc.exists(), "suffix": doc.suffix, "bytes": doc.stat().st_size if doc.exists() else 0}
