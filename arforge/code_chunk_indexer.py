"""Code chunk indexer."""

from __future__ import annotations

from pathlib import Path


def index_code_chunks(root: str = "arforge") -> dict:
    return {"success": True, "chunks": len(list_code_chunks(100000, root=root))}


def list_code_chunks(limit: int = 100, root: str = "arforge"):
    chunks = []
    for path in Path(root).rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="replace")
        for i, start in enumerate(range(0, len(text), 2000), 1):
            chunks.append({"file": str(path), "chunk": i, "text": text[start : start + 2000]})
            if len(chunks) >= limit:
                return chunks
    return chunks


def list_file_code_chunks(file_path: str):
    return [item for item in list_code_chunks(100000, root=".") if item["file"].endswith(file_path)]


def search_code_chunks(keyword: str, limit: int = 30):
    return [item for item in list_code_chunks(100000) if keyword.lower() in item["text"].lower()][:limit]


def list_code_chunks_by_role(role: str, limit: int = 50):
    return [item for item in list_code_chunks(limit) if role.lower() in item["file"].lower()]
