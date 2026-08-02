from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from arforge.notebook_runtime import MAX_NOTEBOOK_BYTES, NotebookError, NotebookService
from arforge.security.file_ops import confirmed_operation


def _notebook(*, minor: int = 5) -> dict:
    return {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": 7,
                "id": "code-a",
                "metadata": {"tag": "keep"},
                "outputs": [{"name": "stdout", "output_type": "stream", "text": ["old\n"]}],
                "source": ["value = 1\n"],
            },
            {
                "cell_type": "markdown",
                "id": "notes",
                "metadata": {"custom": {"keep": True}},
                "source": ["# Notes\n"],
            },
        ],
        "metadata": {
            "custom": {"project": "keep"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": minor,
    }


def _write(path: Path, notebook: dict) -> str:
    raw = json.dumps(notebook, ensure_ascii=False, indent=2).encode("utf-8")
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest()


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _edit(service: NotebookService, *args, **kwargs):
    with confirmed_operation():
        return service.edit(*args, **kwargs)


def test_read_returns_stable_locators_hash_and_structured_summary(tmp_path):
    path = tmp_path / "sample.ipynb"
    expected = _write(path, _notebook())
    service = NotebookService(tmp_path)

    result = service.read("sample.ipynb")

    assert result["sha256"] == expected
    assert result["language"] == "python"
    assert result["cell_count"] == 2
    assert result["cells"][0]["cell_id"] == "code-a"
    assert result["cells"][0]["output_count"] == 1
    assert "outputs" not in result["cells"][0]
    assert result["cells"][1]["metadata"]["custom"]["keep"] is True


def test_replace_clears_code_outputs_and_preserves_metadata(tmp_path):
    path = tmp_path / "sample.ipynb"
    expected = _write(path, _notebook())
    service = NotebookService(tmp_path)

    result = _edit(
        service,
        "sample.ipynb",
        expected_sha256=expected,
        cell_id="code-a",
        new_source="value = 2\n",
    )
    updated = _load(path)

    assert result["dry_run"] is False
    assert updated["cells"][0]["source"] == ["value = 2\n"]
    assert updated["cells"][0]["execution_count"] is None
    assert updated["cells"][0]["outputs"] == []
    assert updated["cells"][0]["metadata"] == {"tag": "keep"}
    assert updated["metadata"]["custom"] == {"project": "keep"}
    assert result["backup_path"]
    assert result["after_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()


def test_insert_after_id_and_at_beginning_generates_v45_ids(tmp_path):
    path = tmp_path / "sample.ipynb"
    expected = _write(path, _notebook())
    service = NotebookService(tmp_path)

    first = _edit(
        service,
        path,
        expected_sha256=expected,
        edit_mode="insert",
        cell_id="code-a",
        new_source="print(value)\n",
        cell_type="code",
    )
    second = _edit(
        service,
        path,
        expected_sha256=first["after_sha256"],
        edit_mode="insert",
        new_source="Intro\n",
        cell_type="markdown",
    )
    cells = _load(path)["cells"]

    assert cells[0]["source"] == ["Intro\n"]
    assert cells[0]["id"]
    assert cells[2]["source"] == ["print(value)\n"]
    assert cells[2]["execution_count"] is None
    assert cells[2]["outputs"] == []
    assert second["cell_count_after"] == 4


def test_legacy_notebook_insert_does_not_force_cell_ids(tmp_path):
    path = tmp_path / "legacy.ipynb"
    notebook = _notebook(minor=4)
    for cell in notebook["cells"]:
        cell.pop("id")
    expected = _write(path, notebook)
    service = NotebookService(tmp_path)

    _edit(
        service,
        path,
        expected_sha256=expected,
        edit_mode="insert",
        cell_id="cell-0",
        new_source="legacy\n",
        cell_type="raw",
    )

    assert "id" not in _load(path)["cells"][1]


def test_delete_and_type_conversion_keep_valid_cell_shapes(tmp_path):
    path = tmp_path / "sample.ipynb"
    expected = _write(path, _notebook())
    service = NotebookService(tmp_path)

    converted = _edit(
        service,
        path,
        expected_sha256=expected,
        cell_id="code-a",
        new_source="# converted\n",
        cell_type="markdown",
    )
    deleted = _edit(
        service,
        path,
        expected_sha256=converted["after_sha256"],
        edit_mode="delete",
        cell_id="notes",
    )
    cells = _load(path)["cells"]

    assert len(cells) == 1
    assert cells[0]["cell_type"] == "markdown"
    assert "outputs" not in cells[0]
    assert "execution_count" not in cells[0]
    assert deleted["cell_count_after"] == 1


def test_markdown_to_code_adds_execution_fields(tmp_path):
    path = tmp_path / "sample.ipynb"
    expected = _write(path, _notebook())
    service = NotebookService(tmp_path)

    _edit(
        service,
        path,
        expected_sha256=expected,
        cell_id="notes",
        new_source="print('ready')\n",
        cell_type="code",
    )
    cell = _load(path)["cells"][1]

    assert cell["cell_type"] == "code"
    assert cell["execution_count"] is None
    assert cell["outputs"] == []


def test_dry_run_returns_preview_without_changing_file(tmp_path):
    path = tmp_path / "sample.ipynb"
    expected = _write(path, _notebook())
    service = NotebookService(tmp_path)

    with confirmed_operation():
        result = service.edit(
            path,
            expected_sha256=expected,
            cell_id="code-a",
            new_source="value = 99\n",
            dry_run=True,
        )

    assert result["dry_run"] is True
    assert result["preview"]["after"] == "value = 99\n"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
    assert not list(tmp_path.glob("*.arforge.lock"))


def test_stale_hash_path_escape_and_invalid_selectors_fail_closed(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    path = root / "sample.ipynb"
    expected = _write(path, _notebook())
    outside = tmp_path / "outside.ipynb"
    _write(outside, _notebook())
    service = NotebookService(root)

    with pytest.raises(NotebookError, match="changed since"):
        _edit(
            service,
            path,
            expected_sha256="0" * 64,
            cell_id="code-a",
            new_source="value = 3\n",
        )
    with pytest.raises(NotebookError, match="escapes"):
        service.read(outside)
    with pytest.raises(NotebookError, match="not found"):
        _edit(
            service,
            path,
            expected_sha256=expected,
            cell_id="missing",
            new_source="value = 3\n",
        )


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ("{broken", "not valid JSON"),
        (json.dumps({"nbformat": 3, "worksheets": []}), "nbformat 4"),
        (
            json.dumps(
                {
                    "cells": [],
                    "metadata": [],
                    "nbformat": 4,
                    "nbformat_minor": 5,
                }
            ),
            "metadata",
        ),
    ],
)
def test_malformed_notebooks_are_rejected(tmp_path, payload, message):
    path = tmp_path / "bad.ipynb"
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(NotebookError, match=message):
        NotebookService(tmp_path).read(path)


def test_oversized_notebook_is_rejected_before_parsing(tmp_path):
    path = tmp_path / "large.ipynb"
    with path.open("wb") as handle:
        handle.truncate(MAX_NOTEBOOK_BYTES + 1)

    with pytest.raises(NotebookError, match="10 MB"):
        NotebookService(tmp_path).read(path)


def test_registered_tools_have_workspace_permissions_and_enum_schema(monkeypatch, tmp_path):
    from arforge.tool_executor import execute_tool_by_name
    from arforge.tool_registry import REGISTRY
    from arforge.tools import file_tools, load_builtin_tools

    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    original_workspace = file_tools.WORKSPACE
    file_tools.set_workspace(tmp_path)
    try:
        path = tmp_path / "sample.ipynb"
        _write(path, _notebook())
        load_builtin_tools()

        read_tool = REGISTRY.get("notebook_read")
        edit_tool = REGISTRY.get("notebook_edit")
        assert read_tool is not None and read_tool.schema.category == "read"
        assert edit_tool is not None and edit_tool.schema.category == "workspace_write"
        assert edit_tool.schema.requires_confirmation is True

        schema = next(
            item
            for item in REGISTRY.to_openai_tools()
            if item["function"]["name"] == "notebook_edit"
        )
        properties = schema["function"]["parameters"]["properties"]
        assert set(properties["edit_mode"]["enum"]) == {"delete", "insert", "replace"}
        assert "raw" in properties["cell_type"]["enum"]

        read_result = execute_tool_by_name(
            "notebook_read",
            {"notebook_path": "sample.ipynb"},
        )
        assert read_result.success
        payload = json.loads(read_result.output)
        edit_result = execute_tool_by_name(
            "notebook_edit",
            {
                "notebook_path": "sample.ipynb",
                "expected_sha256": payload["sha256"],
                "cell_id": "code-a",
                "new_source": "value = 4\n",
            },
        )
        assert edit_result.success
        assert _load(path)["cells"][0]["source"] == ["value = 4\n"]
    finally:
        file_tools.set_workspace(original_workspace)


def test_notebook_write_outside_workspace_is_dynamically_dangerous(tmp_path):
    from arforge.core.permission import classify_tool
    from arforge.tools import file_tools, load_builtin_tools

    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.ipynb"
    original_workspace = file_tools.WORKSPACE
    file_tools.set_workspace(root)
    try:
        load_builtin_tools()
        assert classify_tool(
            "notebook_edit",
            {"notebook_path": str(outside)},
        ) == "dangerous"
        assert classify_tool(
            "notebook_edit",
            {"notebook_path": "inside.ipynb"},
        ) == "workspace_write"
    finally:
        file_tools.set_workspace(original_workspace)
