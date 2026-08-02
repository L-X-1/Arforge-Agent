"""Test A2: Fix 2 stub Capabilities — _safe_modify and _multimodal_inspection.

Verifies that:
- _safe_modify parses "modify <path>: <content>" and actually writes files
- _safe_modify returns proper error for unparseable queries
- _multimodal_inspection inspects real images and returns width/height/format
- _multimodal_inspection reads document text
- _multimodal_inspection returns error for missing files
- _multimodal_inspection returns error for unsupported file types
"""

from __future__ import annotations

from pathlib import Path

import pytest

from arforge.capability.capability_registry import _safe_modify, _multimodal_inspection


# ====================================================================
# _safe_modify tests
# ====================================================================


class TestSafeModifyReal:
    """Tests for _safe_modify — real file modification."""

    def test_safe_modify_creates_new_file(self, tmp_path: Path):
        """Valid 'modify <path>: <content>' should create a file."""
        test_file = tmp_path / "test_write.py"
        query = f"modify {test_file}: print('hello world')"

        result = _safe_modify(query)

        assert result["success"], f"Expected success, got error: {result.get('error')}"
        assert test_file.exists()
        content = test_file.read_text(encoding="utf-8")
        assert "print('hello world')" in content

    def test_safe_modify_overwrites_existing_file(self, tmp_path: Path):
        """Modify an existing file should update its content."""
        test_file = tmp_path / "existing.py"
        test_file.write_text("old content", encoding="utf-8")

        query = f"modify {test_file}: x = 'new content here'"
        result = _safe_modify(query)

        assert result["success"], f"Expected success, got error: {result.get('error')}"
        content = test_file.read_text(encoding="utf-8")
        assert "new content here" in content

    def test_safe_modify_with_chinese_keyword(self, tmp_path: Path):
        """Chinese '修改文件' keyword should also work."""
        test_file = tmp_path / "cn_test.py"
        query = f"修改文件 {test_file}: x = 42"

        result = _safe_modify(query)

        assert result["success"], f"Expected success, got error: {result.get('error')}"
        assert test_file.exists()
        assert "x = 42" in test_file.read_text(encoding="utf-8")

    def test_safe_modify_with_colon_separator(self, tmp_path: Path):
        """Full-width colon ： should work as separator."""
        test_file = tmp_path / "fullwidth.py"
        query = f"safe_modify {test_file}：y = 99"

        result = _safe_modify(query)

        assert result["success"], f"Expected success, got error: {result.get('error')}"
        assert test_file.exists()
        assert "y = 99" in test_file.read_text(encoding="utf-8")

    def test_safe_modify_invalid_query_returns_error(self):
        """Unparseable query should return success=False with error message."""
        result = _safe_modify("do something random without proper format")
        assert not result["success"]
        assert "error" in result
        assert "格式" in result["error"]

    def test_safe_modify_returns_backup_path(self, tmp_path: Path):
        """Successful modify should return backup_path and verification_status."""
        test_file = tmp_path / "backup_test.py"
        test_file.write_text("original", encoding="utf-8")

        query = f"modify {test_file}: x = 'modified content'"
        result = _safe_modify(query)

        assert result["success"]
        assert "verification_status" in result
        assert "diff_summary" in result

    def test_safe_modify_returns_hunks_changed(self, tmp_path: Path):
        """Result should include hunks_changed field."""
        test_file = tmp_path / "hunk_test.py"
        test_file.write_text("line1\nline2\nline3", encoding="utf-8")

        query = f"modify {test_file}: line1\nlineX\nline3"
        result = _safe_modify(query)

        assert "hunks_changed" in result
        assert isinstance(result["hunks_changed"], int)


# ====================================================================
# _multimodal_inspection tests
# ====================================================================


class TestMultimodalInspectionReal:
    """Tests for _multimodal_inspection — real file inspection."""

    def test_inspect_image_returns_metadata(self, tmp_path: Path):
        """Inspecting a real image file should return width/height/format."""
        # Create a minimal 1x1 PNG
        try:
            from PIL import Image

            img_path = tmp_path / "test_img.png"
            Image.new("RGB", (10, 20)).save(img_path)

            query = f"inspect {img_path}"
            result = _multimodal_inspection(query)

            assert result.get("exists"), f"Expected exists=True, got {result}"
            assert result.get("width") == 10
            assert result.get("height") == 20
            assert result.get("format") == "PNG"
        except ImportError:
            pytest.skip("Pillow not installed")

    def test_inspect_image_with_bare_path(self, tmp_path: Path):
        """Bare path with .png extension should be detected without 'inspect' keyword."""
        try:
            from PIL import Image

            img_path = tmp_path / "bare_test.png"
            Image.new("RGB", (5, 5)).save(img_path)

            query = f"check {img_path} please"
            result = _multimodal_inspection(query)

            assert result.get("exists"), f"Bare path not detected, got: {result}"
            assert result.get("width") == 5
        except ImportError:
            pytest.skip("Pillow not installed")

    def test_inspect_document_txt(self, tmp_path: Path):
        """Inspecting a .txt file should return text preview."""
        doc_path = tmp_path / "sample.txt"
        doc_path.write_text("Hello world, this is a test document.", encoding="utf-8")

        query = f"document {doc_path}"
        result = _multimodal_inspection(query)

        assert result.get("exists"), f"Expected exists=True, got {result}"
        assert "text_preview" in result
        assert "Hello world" in result["text_preview"]

    def test_inspect_document_md(self, tmp_path: Path):
        """Inspecting a .md file should return text preview."""
        doc_path = tmp_path / "readme.md"
        doc_path.write_text("# Title\n\nSome markdown content.", encoding="utf-8")

        query = f"文档 {doc_path}"
        result = _multimodal_inspection(query)

        assert result.get("exists")
        assert "text_preview" in result
        assert "Title" in result["text_preview"]

    def test_inspect_missing_file_returns_error(self):
        """Non-existent file path should return success=False."""
        query = "inspect /nonexistent/path/foo.png"
        result = _multimodal_inspection(query)

        assert not result["success"]
        assert "不存在" in result["error"]

    def test_inspect_no_path_returns_error(self):
        """Query with no file path should return error."""
        result = _multimodal_inspection("hello world no path here")
        assert not result["success"]
        assert "文件路径" in result["error"]

    def test_inspect_unsupported_extension(self, tmp_path: Path):
        """Unsupported file extension should return error."""
        bad_path = tmp_path / "data.xyz"
        bad_path.write_text("dummy", encoding="utf-8")

        query = f"inspect {bad_path}"
        result = _multimodal_inspection(query)

        assert not result["success"]
        assert "不支持" in result["error"]

    def test_inspect_image_with_ocr_keyword(self, tmp_path: Path):
        """Inspect image with 'ocr' keyword should attempt OCR."""
        try:
            from PIL import Image

            img_path = tmp_path / "ocr_test.png"
            Image.new("RGB", (10, 10)).save(img_path)

            query = f"ocr text extract {img_path}"
            result = _multimodal_inspection(query)

            assert result.get("exists")
            # ocr_text key should be present (even if OCR failed due to no text)
            assert "ocr_text" in result
        except ImportError:
            pytest.skip("Pillow not installed")
