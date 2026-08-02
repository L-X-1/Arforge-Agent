"""Local TF-IDF code index for semantic search without embeddings.

G2 large-repository support:
- honors simple ``.gitignore`` patterns;
- skips binary files before decoding;
- persists a path/mtime/size token cache;
- exposes health metadata for indexing status and dirty-file counts.
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from arforge.synonyms import SYNONYMS

_CAMEL_RE = re.compile(r"[A-Z]?[a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|\d|\b)|\d+")
_STOPWORDS: set[str] = {
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "not",
    "to", "be", "in", "of", "for", "with", "that", "this", "are", "was",
    "it", "from", "by", "as", "has", "its", "if", "else", "elif",
    "def", "class", "return", "import", "from", "pass", "none", "true", "false",
    "self", "cls", "args", "kwargs",
}

_SKIP_DIRS = {
    "__pycache__",
    ".arforge",
    ".arforge-run",
    ".eggs",
    ".git",
    ".pytest-tmp",
    ".tools",
    ".tox",
    ".turbo",
    ".venv",
    "artifacts",
    "build",
    "coverage",
    "dist",
    "egg-info",
    "node_modules",
    "target",
}
_BINARY_CHECK_BYTES = 2048


def _tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    for word in re.split(r"[^a-zA-Z0-9_]", text):
        for sub in _CAMEL_RE.findall(word):
            token = sub.lower()
            if len(token) > 1 and token not in _STOPWORDS and token not in seen:
                tokens.append(token)
                seen.add(token)
    return tokens


def _expand_tokens(tokens: list[str]) -> list[str]:
    expanded = list(tokens)
    for token in tokens:
        for synonym in SYNONYMS.get(token, []):
            if synonym not in expanded:
                expanded.append(synonym)
    return expanded


class TfidfIndex:
    """In-memory TF-IDF index over source files."""

    def __init__(self):
        self._documents: dict[str, list[str]] = {}
        self._df: dict[str, int] = defaultdict(int)
        self._N = 0
        self._metadata: dict = {}

    def build(self, root: str | Path = ".", suffixes: tuple[str, ...] = (".py",), *, use_cache: bool = True) -> dict:
        base = Path(root).resolve()
        self._documents.clear()
        self._df.clear()
        self._N = 0
        self._metadata = {
            "root": str(base),
            "documents": 0,
            "ignored_files": 0,
            "binary_files": 0,
            "failed_files": [],
            "cache_hits": 0,
            "cache_misses": 0,
            "dirty_files": 0,
            "removed_files": 0,
        }

        cache = _load_cache(base) if use_cache else {"files": {}}
        cached_files = cache.get("files", {})
        next_cache = {"version": 1, "root": str(base), "files": {}}
        tracked: set[str] = set()

        for path in iter_indexable_files(base, suffixes=suffixes):
            key = str(path)
            tracked.add(key)
            stat = path.stat()
            cached = cached_files.get(key)
            if cached and cached.get("mtime_ns") == stat.st_mtime_ns and cached.get("size") == stat.st_size:
                tokens = list(cached.get("tokens", []))
                self._metadata["cache_hits"] += 1
            else:
                tokens = self._tokenize_file(path)
                self._metadata["cache_misses"] += 1
                self._metadata["dirty_files"] += 1
            if tokens is None:
                self._metadata["failed_files"].append(key)
                continue
            self._add_document(key, tokens)
            next_cache["files"][key] = {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size, "tokens": tokens}

        if use_cache:
            _save_cache(base, next_cache)

        ignored, binary = scan_exclusions(base, suffixes=suffixes)
        self._metadata["ignored_files"] = ignored
        self._metadata["binary_files"] = binary
        self._metadata["removed_files"] = len(set(cached_files) - tracked)
        self._metadata["documents"] = self._N

        return {
            "documents": self._N,
            "vocabulary": len(self._df),
            "cache_hits": self._metadata["cache_hits"],
            "cache_misses": self._metadata["cache_misses"],
            "dirty_files": self._metadata["dirty_files"],
            "ignored_files": ignored,
            "binary_files": binary,
            "removed_files": self._metadata["removed_files"],
            "failed_files": len(self._metadata["failed_files"]),
        }

    def incremental_update(self, root: str | Path = ".", suffixes: tuple[str, ...] = (".py",)) -> dict:
        previous = self.doc_count
        result = self.build(root, suffixes=suffixes, use_cache=True)
        result["previous_documents"] = previous
        result["rebuilt"] = previous == 0 or result["dirty_files"] > 0 or result["removed_files"] > 0
        return result

    def add(self, file_path: Path) -> None:
        self.remove(file_path)
        self._index_file(file_path)

    def remove(self, file_path: Path) -> None:
        key = str(file_path)
        if key in self._documents:
            self._remove_from_df(key)
            del self._documents[key]
            self._N -= 1

    def search(self, query: str, top_k: int = 10, expand_synonyms: bool = True) -> list[dict]:
        if self._N == 0:
            return []
        query_tokens = _tokenize(query)
        if expand_synonyms:
            query_tokens = _expand_tokens(query_tokens)
        if not query_tokens:
            return []

        scores: dict[str, float] = defaultdict(float)
        matched: dict[str, set[str]] = defaultdict(set)
        for token in set(query_tokens):
            df = self._df.get(token, 0)
            if df == 0:
                continue
            idf = math.log((self._N + 1) / (df + 1)) + 1.0
            for doc, tokens in self._documents.items():
                tf = tokens.count(token) / max(len(tokens), 1)
                if tf:
                    scores[doc] += tf * idf
                    matched[doc].add(token)

        ranked = sorted(scores.items(), key=lambda item: -item[1])[:top_k]
        return [
            {"file": doc, "score": round(score, 4), "matched_tokens": sorted(matched[doc])}
            for doc, score in ranked
            if score > 0.01
        ]

    @property
    def doc_count(self) -> int:
        return self._N

    @property
    def vocab_size(self) -> int:
        return len(self._df)

    def health(self) -> dict:
        return {"documents": self._N, "vocabulary": len(self._df), **self._metadata}

    def _index_file(self, path: Path) -> None:
        tokens = self._tokenize_file(path)
        if tokens is not None:
            self._add_document(str(path), tokens)

    def _tokenize_file(self, path: Path) -> list[str] | None:
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        tokens: list[str] = []
        try:
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    tokens.extend(_tokenize(node.name))
                if isinstance(node, ast.Name):
                    tokens.extend(_tokenize(node.id))
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
                    doc = ast.get_docstring(node)
                    if doc:
                        tokens.extend(_tokenize(doc))
        except SyntaxError:
            tokens = _tokenize(source)
        for comment in re.findall(r"#\s*(.+)", source):
            tokens.extend(_tokenize(comment))
        return list(dict.fromkeys(tokens))

    def _add_document(self, key: str, tokens: list[str]) -> None:
        self._documents[key] = tokens
        for token in set(tokens):
            self._df[token] += 1
        self._N += 1

    def _remove_from_df(self, key: str) -> None:
        if key not in self._documents:
            return
        for token in set(self._documents[key]):
            self._df[token] = max(0, self._df[token] - 1)


_INDEX: TfidfIndex | None = None


def get_tfidf_index() -> TfidfIndex:
    global _INDEX
    if _INDEX is None:
        _INDEX = TfidfIndex()
    return _INDEX


def _cache_path(root: Path) -> Path:
    home = Path(os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge")))
    digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]
    return home / "cache" / "tfidf" / f"{digest}.json"


def _load_cache(root: Path) -> dict:
    path = _cache_path(root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"files": {}}
    if data.get("root") != str(root) or not isinstance(data.get("files"), dict):
        return {"files": {}}
    return data


def _save_cache(root: Path, data: dict) -> None:
    path = _cache_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _read_gitignore(root: Path) -> list[str]:
    path = root / ".gitignore"
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]


def _matches_gitignore(rel_path: str, patterns: Iterable[str]) -> bool:
    rel = rel_path.replace("\\", "/")
    parts = rel.split("/")
    ignored = False
    for raw in patterns:
        negated = raw.startswith("!")
        pattern = raw[1:] if negated else raw
        pattern = pattern.strip()
        if not pattern:
            continue
        dir_pattern = pattern.endswith("/")
        pattern = pattern.strip("/")
        matched = False
        if dir_pattern:
            matched = pattern in parts
        elif "/" in pattern:
            matched = Path(rel).match(pattern)
        elif pattern.startswith("*."):
            matched = Path(rel).match(pattern)
        else:
            matched = pattern in parts or rel == pattern or rel.endswith(f"/{pattern}")
        if matched:
            ignored = not negated
    return ignored


def is_binary_file(path: Path) -> bool:
    try:
        sample = path.read_bytes()[:_BINARY_CHECK_BYTES]
    except OSError:
        return True
    return b"\x00" in sample


def _prune_directories(root: Path, current: Path, directories: list[str], patterns: Iterable[str]) -> int:
    kept: list[str] = []
    ignored = 0
    for name in directories:
        candidate = current / name
        rel = candidate.relative_to(root).as_posix()
        if name in _SKIP_DIRS or _matches_gitignore(f"{rel}/", patterns):
            ignored += 1
            continue
        kept.append(name)
    directories[:] = kept
    return ignored


def iter_indexable_files(root: Path, suffixes: tuple[str, ...] = (".py",)):
    patterns = _read_gitignore(root)
    for current_raw, directories, filenames in os.walk(root):
        current = Path(current_raw)
        _prune_directories(root, current, directories, patterns)
        for name in filenames:
            candidate = current / name
            if candidate.suffix not in suffixes:
                continue
            rel = candidate.relative_to(root).as_posix()
            if _matches_gitignore(rel, patterns):
                continue
            if is_binary_file(candidate):
                continue
            yield candidate


def scan_exclusions(root: Path, suffixes: tuple[str, ...] = (".py",)) -> tuple[int, int]:
    patterns = _read_gitignore(root)
    ignored = 0
    binary = 0
    for current_raw, directories, filenames in os.walk(root):
        current = Path(current_raw)
        ignored += _prune_directories(root, current, directories, patterns)
        for name in filenames:
            candidate = current / name
            if candidate.suffix not in suffixes:
                continue
            rel = candidate.relative_to(root).as_posix()
            if _matches_gitignore(rel, patterns):
                ignored += 1
                continue
            if is_binary_file(candidate):
                binary += 1
    return ignored, binary
