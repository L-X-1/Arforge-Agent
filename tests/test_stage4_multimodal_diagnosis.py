from __future__ import annotations

import importlib
import sys

import pytest

from arforge.core.multimodal_diagnosis import (
    diagnose_multimodal_file,
    extract_error_signals,
    format_multimodal_diagnosis,
)


TRACEBACK_TEXT = """Traceback (most recent call last):
  File "app.py", line 3, in <module>
    result = process_order(payload)
NameError: name 'process_order' is not defined
"""


def test_extract_error_signals_from_traceback():
    signals = extract_error_signals(TRACEBACK_TEXT)

    assert {"kind": "file_line", "value": "app.py", "line": 3, "raw": 'File "app.py", line 3'} in signals
    assert any(signal["kind"] == "exception" and signal["value"] == "NameError" for signal in signals)
    assert any(signal["kind"] == "missing_name" and signal["value"] == "process_order" for signal in signals)


def test_document_log_to_code_search_to_suggestions(tmp_path):
    (tmp_path / "app.py").write_text(
        "def run(payload):\n"
        "    return process_order(payload)\n",
        encoding="utf-8",
    )
    (tmp_path / "orders.py").write_text(
        "def process_order(payload):\n"
        "    return payload\n",
        encoding="utf-8",
    )
    log = tmp_path / "error.txt"
    log.write_text(TRACEBACK_TEXT, encoding="utf-8")

    result = diagnose_multimodal_file(log, root=tmp_path)

    assert result["success"] is True
    assert result["source"]["type"] == "document"
    assert "process_order" in result["search_terms"]
    assert any(match["file"] == "app.py" for match in result["matches"])
    assert any(match["file"] == "orders.py" for match in result["matches"])
    assert any("missing symbol" in suggestion for suggestion in result["suggestions"])


def test_rst_document_to_code_search_to_suggestions(tmp_path):
    (tmp_path / "profiles.py").write_text(
        "def load_profile(user_id):\n"
        "    return {'id': user_id}\n",
        encoding="utf-8",
    )
    doc = tmp_path / "error.rst"
    doc.write_text("AttributeError: object has no attribute 'load_profile'\n", encoding="utf-8")

    result = diagnose_multimodal_file(doc, root=tmp_path)

    assert result["success"] is True
    assert result["source"]["type"] == "document"
    assert result["source"]["text"].strip()
    assert any(match["file"] == "profiles.py" for match in result["matches"])


def test_image_ocr_to_code_search_chain(tmp_path, monkeypatch):
    (tmp_path / "service.py").write_text(
        "def load_profile(user_id):\n"
        "    return {'id': user_id}\n",
        encoding="utf-8",
    )
    image = tmp_path / "error.png"
    image.write_bytes(b"not a real image but enough for the test")

    monkeypatch.setattr(
        "arforge.multimodal.inspect_image",
        lambda path: {"success": True, "path": str(path), "width": 10, "height": 10},
    )
    monkeypatch.setattr(
        "arforge.multimodal.extract_ocr",
        lambda path: {
            "success": True,
            "text": "AttributeError: object has no attribute 'load_profile'",
            "engine": "test-ocr",
        },
    )

    result = diagnose_multimodal_file(image, root=tmp_path)

    assert result["success"] is True
    assert result["source"]["type"] == "image_ocr"
    assert result["source"]["engine"] == "test-ocr"
    assert any(signal["kind"] == "exception" and signal["value"] == "AttributeError" for signal in result["signals"])
    assert any(match["file"] == "service.py" for match in result["matches"])


def test_format_multimodal_diagnosis_is_stable(tmp_path):
    log = tmp_path / "error.txt"
    log.write_text(TRACEBACK_TEXT, encoding="utf-8")
    result = diagnose_multimodal_file(log, root=tmp_path)

    output = format_multimodal_diagnosis(result)

    assert "Multimodal diagnosis" in output
    assert "source_type: document" in output
    assert "Suggestions:" in output


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools") or mod.startswith("arforge.tools.code_tools"):
            del sys.modules[mod]
    import arforge.tools.file_tools
    import arforge.tools.code_tools

    importlib.reload(arforge.tools.file_tools)
    importlib.reload(arforge.tools.code_tools)
    return tmp_path


def test_multimodal_diagnose_tool_is_registered_read_only(workspace):
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("multimodal_diagnose")

    assert tool is not None
    assert tool.schema.risk_level == "low"
    assert tool.schema.requires_confirmation is False
    assert tool.schema.category == "read"


def test_multimodal_diagnose_tool_uses_workspace(workspace):
    from arforge.tool_registry import REGISTRY

    (workspace / "orders.py").write_text(
        "def process_order(payload):\n"
        "    return payload\n",
        encoding="utf-8",
    )
    (workspace / "error.md").write_text(TRACEBACK_TEXT, encoding="utf-8")

    result = REGISTRY.execute_by_name("multimodal_diagnose", {"filename": "error.md"})

    assert result.success, result.error
    assert "Multimodal diagnosis" in result.output
    assert "process_order" in result.output
    assert "orders.py" in result.output


def test_cli_multimodal_diagnose_real_document(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    (tmp_path / "orders.py").write_text(
        "def process_order(payload):\n"
        "    return payload\n",
        encoding="utf-8",
    )
    (tmp_path / "error.md").write_text(TRACEBACK_TEXT, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["multimodal-diagnose", "error.md", "--limit", "4"]) == 0
    output = capsys.readouterr().out

    assert "Multimodal diagnosis" in output
    assert "process_order" in output
    assert "orders.py" in output


def test_cli_multimodal_diagnose_text_override(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    (tmp_path / "profiles.py").write_text(
        "def load_profile(user_id):\n"
        "    return {'id': user_id}\n",
        encoding="utf-8",
    )
    (tmp_path / "error.png").write_bytes(b"not actually an image")
    monkeypatch.chdir(tmp_path)

    assert main([
        "multimodal-diagnose",
        "error.png",
        "--text",
        "AttributeError: object has no attribute 'load_profile'",
    ]) == 0
    output = capsys.readouterr().out

    assert "provided_text" in output
    assert "load_profile" in output
    assert "profiles.py" in output


def test_cli_multimodal_diagnose_rejects_path_escape(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    outside = tmp_path.parent / "outside-error.txt"
    outside.write_text(TRACEBACK_TEXT, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["multimodal-diagnose", str(outside)]) == 2
    assert "escapes workspace" in capsys.readouterr().err
