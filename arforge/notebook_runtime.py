"""Structured Jupyter notebook reading and editing.

Notebook files are JSON documents, so cell edits must operate on the parsed
document instead of using text replacement.  This module keeps notebook
metadata intact, enforces optimistic concurrency, and writes through the
project's backup and atomic-replace layer.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterator

from arforge.core.file_state import get_file_state_tracker
from arforge.security.file_ops import safe_write
from arforge.ts_workspace import typescript_path_is_authorized


MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024
MAX_CELLS = 10_000
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_OUTPUTS_PER_CELL = 10_000
CELL_TYPES = frozenset({"code", "markdown", "raw"})
EDIT_MODES = frozenset({"replace", "insert", "delete"})
_LOCK_TIMEOUT_SECONDS = 5.0
_STALE_LOCK_SECONDS = 60.0


class NotebookError(ValueError):
    """Raised when a notebook operation violates the runtime contract."""


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _safe_write_bytes(content: str) -> bytes:
    """Return the bytes produced by safe_write's platform text translation."""
    return content.replace("\n", os.linesep).encode("utf-8")


def _source_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return "".join(value)
    raise NotebookError("cell source must be a string or a list of strings")


def _source_value(source: str, previous: Any | None = None) -> str | list[str]:
    if not isinstance(source, str):
        raise NotebookError("new_source must be a string")
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise NotebookError("cell source exceeds the 2 MB limit")
    if isinstance(previous, str):
        return source
    return source.splitlines(keepends=True)


def _cell_locator(cell: dict[str, Any], index: int) -> str:
    cell_id = cell.get("id")
    return cell_id if isinstance(cell_id, str) and cell_id else f"cell-{index}"


def _short_source(source: str, limit: int) -> tuple[str, bool]:
    if len(source) <= limit:
        return source, False
    return source[:limit] + "\n...[truncated]", True


def _language(notebook: dict[str, Any]) -> str:
    metadata = notebook.get("metadata")
    if not isinstance(metadata, dict):
        return "unknown"
    language_info = metadata.get("language_info")
    if isinstance(language_info, dict):
        name = language_info.get("name")
        if isinstance(name, str) and name:
            return name
    kernelspec = metadata.get("kernelspec")
    if isinstance(kernelspec, dict):
        language = kernelspec.get("language")
        if isinstance(language, str) and language:
            return language
    return "unknown"


def _validate_notebook(notebook: Any) -> dict[str, Any]:
    if not isinstance(notebook, dict):
        raise NotebookError("notebook root must be a JSON object")
    if notebook.get("nbformat") != 4:
        raise NotebookError("only nbformat 4 notebooks are supported")
    minor = notebook.get("nbformat_minor")
    if not isinstance(minor, int) or isinstance(minor, bool) or minor < 0:
        raise NotebookError("nbformat_minor must be a non-negative integer")
    if not isinstance(notebook.get("metadata"), dict):
        raise NotebookError("notebook metadata must be an object")
    cells = notebook.get("cells")
    if not isinstance(cells, list):
        raise NotebookError("notebook cells must be an array")
    if len(cells) > MAX_CELLS:
        raise NotebookError(f"notebook exceeds the {MAX_CELLS} cell limit")

    seen_ids: set[str] = set()
    for index, cell in enumerate(cells):
        if not isinstance(cell, dict):
            raise NotebookError(f"cell {index} must be an object")
        cell_type = cell.get("cell_type")
        if cell_type not in CELL_TYPES:
            raise NotebookError(f"cell {index} has unsupported type: {cell_type!r}")
        if not isinstance(cell.get("metadata"), dict):
            raise NotebookError(f"cell {index} metadata must be an object")
        source = _source_text(cell.get("source"))
        if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise NotebookError(f"cell {index} source exceeds the 2 MB limit")
        cell_id = cell.get("id")
        if cell_id is not None:
            if not isinstance(cell_id, str) or not cell_id:
                raise NotebookError(f"cell {index} id must be a non-empty string")
            if cell_id in seen_ids:
                raise NotebookError(f"duplicate cell id: {cell_id}")
            seen_ids.add(cell_id)
        if cell_type == "code":
            outputs = cell.get("outputs")
            if not isinstance(outputs, list):
                raise NotebookError(f"code cell {index} outputs must be an array")
            if len(outputs) > MAX_OUTPUTS_PER_CELL:
                raise NotebookError(
                    f"code cell {index} exceeds the {MAX_OUTPUTS_PER_CELL} output limit"
                )
    return notebook


def _find_cell(cells: list[dict[str, Any]], locator: str | None) -> int:
    if not locator:
        raise NotebookError("cell_id is required for replace and delete operations")
    for index, cell in enumerate(cells):
        if cell.get("id") == locator:
            return index
    if locator.startswith("cell-") and locator[5:].isdigit():
        index = int(locator[5:])
        if 0 <= index < len(cells):
            return index
        raise NotebookError(f"cell index {index} does not exist")
    raise NotebookError(f"cell id not found: {locator}")


def _new_cell_id(notebook: dict[str, Any]) -> str | None:
    if int(notebook.get("nbformat_minor", 0)) < 5:
        return None
    existing = {
        cell.get("id")
        for cell in notebook["cells"]
        if isinstance(cell.get("id"), str)
    }
    while True:
        candidate = uuid.uuid4().hex[:12]
        if candidate not in existing:
            return candidate


def _make_cell(
    notebook: dict[str, Any],
    cell_type: str,
    source: str,
) -> dict[str, Any]:
    cell: dict[str, Any] = {
        "cell_type": cell_type,
        "metadata": {},
        "source": _source_value(source),
    }
    cell_id = _new_cell_id(notebook)
    if cell_id:
        cell["id"] = cell_id
    if cell_type == "code":
        cell["execution_count"] = None
        cell["outputs"] = []
    return cell


def _convert_cell(cell: dict[str, Any], cell_type: str) -> None:
    old_type = cell["cell_type"]
    if old_type == cell_type:
        return
    cell["cell_type"] = cell_type
    if cell_type == "code":
        cell["execution_count"] = None
        cell["outputs"] = []
    else:
        cell.pop("execution_count", None)
        cell.pop("outputs", None)


class NotebookService:
    """Workspace-authorized notebook operations."""

    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()

    def _resolve(self, filename: str | Path) -> Path:
        raw = str(filename)
        if raw.startswith("\\\\") or raw.startswith("//"):
            raise NotebookError("UNC notebook paths are not allowed")
        path = Path(os.path.expandvars(os.path.expanduser(raw)))
        if not path.is_absolute():
            path = self.workspace / path
        resolved = path.resolve()
        if resolved.suffix.lower() != ".ipynb":
            raise NotebookError("notebook path must end with .ipynb")
        if not typescript_path_is_authorized(resolved, primary=self.workspace):
            raise NotebookError("notebook path escapes authorized workspaces")
        return resolved

    def _load(
        self,
        filename: str | Path,
    ) -> tuple[Path, bytes, dict[str, Any]]:
        path = self._resolve(filename)
        if not path.is_file():
            raise NotebookError("notebook file does not exist")
        size = path.stat().st_size
        if size > MAX_NOTEBOOK_BYTES:
            raise NotebookError("notebook exceeds the 10 MB file limit")
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise NotebookError("notebook must use UTF-8 encoding") from exc
        try:
            notebook = json.loads(text)
        except json.JSONDecodeError as exc:
            raise NotebookError(
                f"notebook is not valid JSON at line {exc.lineno}, column {exc.colno}"
            ) from exc
        return path, raw, _validate_notebook(notebook)

    def read(
        self,
        filename: str | Path,
        *,
        start: int = 0,
        limit: int = 20,
        include_outputs: bool = False,
        source_limit: int = 4_000,
    ) -> dict[str, Any]:
        if start < 0:
            raise NotebookError("start must be non-negative")
        if not 1 <= limit <= 100:
            raise NotebookError("limit must be between 1 and 100")
        if not 100 <= source_limit <= 20_000:
            raise NotebookError("source_limit must be between 100 and 20000")

        path, raw, notebook = self._load(filename)
        cells = notebook["cells"]
        selected = cells[start : start + limit]
        summaries: list[dict[str, Any]] = []
        for index, cell in enumerate(selected, start=start):
            source, truncated = _short_source(_source_text(cell["source"]), source_limit)
            item: dict[str, Any] = {
                "index": index,
                "cell_id": _cell_locator(cell, index),
                "cell_type": cell["cell_type"],
                "source": source,
                "source_truncated": truncated,
                "metadata": deepcopy(cell["metadata"]),
            }
            if cell["cell_type"] == "code":
                item["execution_count"] = cell.get("execution_count")
                item["output_count"] = len(cell["outputs"])
                if include_outputs:
                    item["outputs"] = deepcopy(cell["outputs"])
            summaries.append(item)

        get_file_state_tracker().observe(path, raw.decode("utf-8-sig"))
        return {
            "path": str(path),
            "sha256": _sha256(raw),
            "nbformat": notebook["nbformat"],
            "nbformat_minor": notebook["nbformat_minor"],
            "language": _language(notebook),
            "cell_count": len(cells),
            "range": {"start": start, "count": len(summaries)},
            "cells": summaries,
        }

    @contextmanager
    def _file_lock(self, path: Path) -> Iterator[None]:
        lock_path = path.with_name(path.name + ".arforge.lock")
        deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
        fd: int | None = None
        while fd is None:
            try:
                fd = os.open(
                    lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(fd, f"{os.getpid()} {time.time()}\n".encode("ascii"))
                os.fsync(fd)
            except FileExistsError:
                try:
                    if time.time() - lock_path.stat().st_mtime > _STALE_LOCK_SECONDS:
                        lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise NotebookError("timed out waiting for notebook edit lock")
                time.sleep(0.05)
        try:
            yield
        finally:
            if fd is not None:
                os.close(fd)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass

    def edit(
        self,
        filename: str | Path,
        *,
        expected_sha256: str,
        edit_mode: str = "replace",
        cell_id: str | None = None,
        new_source: str = "",
        cell_type: str | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        if edit_mode not in EDIT_MODES:
            raise NotebookError("edit_mode must be replace, insert, or delete")
        if cell_type is not None and cell_type not in CELL_TYPES:
            raise NotebookError("cell_type must be code, markdown, or raw")
        if edit_mode == "insert" and cell_type is None:
            raise NotebookError("cell_type is required for insert operations")
        if edit_mode != "insert" and not cell_id:
            raise NotebookError("cell_id is required for replace and delete operations")
        if edit_mode != "delete":
            _source_value(new_source)
        expected = expected_sha256.strip().lower()
        if len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
            raise NotebookError("expected_sha256 must be a 64-character hexadecimal digest")

        path = self._resolve(filename)
        with self._file_lock(path):
            path, raw, notebook = self._load(path)
            current_sha = _sha256(raw)
            if current_sha != expected:
                raise NotebookError(
                    "notebook changed since it was read; read it again before editing"
                )

            cells: list[dict[str, Any]] = notebook["cells"]
            before_count = len(cells)
            before_source = ""
            target_index = 0
            result_cell_id: str | None = cell_id

            if edit_mode == "insert":
                if cell_id:
                    target_index = _find_cell(cells, cell_id) + 1
                new_cell = _make_cell(notebook, cell_type or "code", new_source)
                cells.insert(target_index, new_cell)
                result_cell_id = _cell_locator(new_cell, target_index)
                after_source = new_source
            else:
                target_index = _find_cell(cells, cell_id)
                target = cells[target_index]
                result_cell_id = _cell_locator(target, target_index)
                before_source = _source_text(target["source"])
                if edit_mode == "delete":
                    cells.pop(target_index)
                    after_source = ""
                else:
                    target["source"] = _source_value(new_source, target["source"])
                    if cell_type is not None:
                        _convert_cell(target, cell_type)
                    if target["cell_type"] == "code":
                        target["execution_count"] = None
                        target["outputs"] = []
                    after_source = new_source

            updated_text = json.dumps(
                notebook,
                ensure_ascii=False,
                indent=1,
            ) + "\n"
            updated_bytes = _safe_write_bytes(updated_text)
            if len(updated_bytes) > MAX_NOTEBOOK_BYTES:
                raise NotebookError("edited notebook would exceed the 10 MB file limit")
            updated_sha = _sha256(updated_bytes)

            result = {
                "path": str(path),
                "edit_mode": edit_mode,
                "cell_id": result_cell_id,
                "cell_index": target_index,
                "cell_type": cell_type,
                "language": _language(notebook),
                "before_sha256": current_sha,
                "after_sha256": updated_sha,
                "cell_count_before": before_count,
                "cell_count_after": len(cells),
                "dry_run": bool(dry_run),
                "preview": {
                    "before": _short_source(before_source, 2_000)[0],
                    "after": _short_source(after_source, 2_000)[0],
                },
            }
            if dry_run:
                return result

            write_result = safe_write(
                path,
                updated_text,
                auto_backup=True,
                require_confirm=True,
            )
            if not write_result.get("success"):
                raise NotebookError(
                    f"notebook write failed: {write_result.get('error', 'unknown error')}"
                )
            actual_sha = _sha256(path.read_bytes())
            if actual_sha != updated_sha:
                raise NotebookError("notebook write verification failed")
            get_file_state_tracker().observe(path, updated_text)
            result["backup_path"] = write_result.get("backup_path", "")
            return result


__all__ = [
    "CELL_TYPES",
    "EDIT_MODES",
    "MAX_CELLS",
    "MAX_NOTEBOOK_BYTES",
    "NotebookError",
    "NotebookService",
]
