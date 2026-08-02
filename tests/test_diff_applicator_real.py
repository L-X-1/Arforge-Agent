"""Test A4: diff_applicator — real unified diff parsing and application.

Covers:
- Simple single-hunk apply
- Multi-hunk apply
- Context mismatch in strict mode
- Context match with offset in non-strict mode
- Selective hunk application
- Reverse diff application (restore original)
- New file creation patch (add lines to empty)
- File deletion patch (remove all lines)
"""

from __future__ import annotations

from pathlib import Path


from arforge.security._diff_parser import parse_unified_diff, hunk_to_text
from arforge.security.diff_applicator import (
    apply_patch,
    apply_patch_with_selection,
    apply_patch_text_direct,
)


# ====================================================================
# Diff parser tests
# ====================================================================


class TestParseUnifiedDiff:
    def test_parse_single_hunk(self):
        diff = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 1
        h = hunks[0]
        assert h.old_start == 1
        assert h.old_count == 3
        assert h.new_start == 1
        assert h.new_count == 3
        assert len(h.lines) == 4  # 2 context + 1 removal + 1 addition
        assert h.lines[0] == (" ", "line1")
        assert h.lines[1] == ("-", "line2")
        assert h.lines[2] == ("+", "lineX")
        assert h.lines[3] == (" ", "line3")

    def test_parse_multi_hunk(self):
        diff = """@@ -1,3 +1,3 @@
 a
 b
 c
@@ -10,2 +10,3 @@
 x
 y
+z"""
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 2
        assert hunks[0].old_start == 1
        assert hunks[1].old_start == 10
        assert hunks[1].new_count == 3

    def test_parse_empty_diff(self):
        assert parse_unified_diff("") == []
        assert parse_unified_diff("   ") == []

    def test_parse_with_header_text(self):
        diff = """@@ -5,4 +5,5 @@ def foo():
     return x"""
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 1
        assert hunks[0].header == "def foo():"

    def test_parse_default_counts(self):
        """Default count is 1 when omitted from header."""
        diff = """@@ -1 +1 @@
-old
+new"""
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 1
        assert hunks[0].old_count == 1
        assert hunks[0].new_count == 1

    def test_roundtrip_hunk(self):
        """hunk_to_text should produce parseable output."""
        original = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        hunks = parse_unified_diff(original)
        text = hunk_to_text(hunks[0])
        reparsed = parse_unified_diff(text)
        assert len(reparsed) == 1
        assert reparsed[0].old_start == hunks[0].old_start


# ====================================================================
# apply_patch tests
# ====================================================================


class TestApplyPatch:
    """Tests for apply_patch with real unified diffs."""

    # -- simple single hunk --

    def test_simple_single_hunk_apply(self):
        original = "line1\nline2\nline3\n"
        diff = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        new_content, results = apply_patch(original, diff)
        assert "lineX" in new_content
        assert "line2" not in new_content
        assert "line1" in new_content
        assert "line3" in new_content
        assert results[0].applied

    # -- multi hunk --

    def test_multi_hunk_apply(self):
        original = "a\nb\nc\nd\ne\nf\n"
        diff = """@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -4,3 +4,3 @@
 d
-e
+E
 f"""
        new_content, results = apply_patch(original, diff)
        assert "B" in new_content
        assert "b" not in new_content
        assert "E" in new_content
        assert "e" not in new_content
        assert len(results) == 2
        assert all(r.applied for r in results)

    # -- strict context mismatch --

    def test_strict_context_mismatch_fails(self):
        original = "line1\nWRONG\nline3\n"
        diff = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        new_content, results = apply_patch(original, diff, strict=True)
        assert not results[0].applied
        assert "context mismatch" in results[0].error
        # Original should be unchanged
        assert new_content == original

    # -- non-strict offset search --

    def test_non_strict_offset_search_succeeds(self):
        """With non-strict mode, should find context within ±3 lines."""
        # Original has an extra line at the top, shifting content by +1
        original = "# header\nline1\nline2\nline3\n"
        diff = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        new_content, results = apply_patch(original, diff, strict=False)
        assert results[0].applied
        assert results[0].offset_shift == 1  # shifted by 1 line
        assert "lineX" in new_content

    # -- selective apply --

    def test_selective_hunk_application(self):
        original = "a\nb\nc\nd\ne\nf\n"
        diff = """@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -4,3 +4,3 @@
 d
-e
+E
 f"""
        # Only apply the second hunk (index 1)
        new_content, results = apply_patch_with_selection(original, diff, {1})
        assert "b" in new_content  # First hunk NOT applied
        assert "B" not in new_content
        assert "E" in new_content  # Second hunk applied
        assert "e" not in new_content
        assert not results[0].applied  # Skipped
        assert results[1].applied

    # -- reverse (restore) --

    def test_reverse_diff_restores_original(self):
        original = "line1\nline2\nline3\n"
        # Forward patch
        forward = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        modified, _ = apply_patch(original, forward)
        assert "lineX" in modified

        # Reverse patch
        reverse = """@@ -1,3 +1,3 @@
 line1
-lineX
+line2
 line3"""
        restored, _ = apply_patch(modified, reverse)
        assert restored == original

    # -- new file creation (add to empty) --

    def test_add_to_empty_file(self):
        original = ""
        diff = """@@ -0,0 +1,3 @@
+line1
+line2
+line3"""
        new_content, results = apply_patch(original, diff, strict=False)
        assert results[0].applied
        assert "line1" in new_content
        assert "line2" in new_content
        assert "line3" in new_content

    # -- delete all lines --

    def test_delete_all_lines(self):
        original = "line1\nline2\nline3\n"
        diff = """@@ -1,3 +0,0 @@
-line1
-line2
-line3"""
        new_content, results = apply_patch(original, diff, strict=False)
        assert results[0].applied
        assert new_content.strip() == ""

    # -- add line in middle --

    def test_add_line_middle(self):
        original = "line1\nline3\n"
        diff = """@@ -1,2 +1,3 @@
 line1
+line2
 line3"""
        new_content, results = apply_patch(original, diff)
        assert results[0].applied
        assert "line2" in new_content
        lines = new_content.strip().split("\n")
        assert lines == ["line1", "line2", "line3"]


# ====================================================================
# apply_patch_text_direct tests
# ====================================================================


class TestApplyPatchTextDirect:
    def test_apply_to_real_file(self, tmp_path: Path):
        """apply_patch_text_direct should read, patch, and write a real file."""
        test_file = tmp_path / "test_apply.py"
        test_file.write_text("line1\nline2\nline3\n", encoding="utf-8")

        patch = """@@ -1,3 +1,3 @@
 line1
-line2
+lineX
 line3"""
        result = apply_patch_text_direct(test_file, patch)

        assert result.success
        assert result.hunks_applied == 1
        content = test_file.read_text(encoding="utf-8")
        assert "lineX" in content

    def test_apply_to_nonexistent_file(self, tmp_path: Path):
        """Applying patch to missing file should fail gracefully."""
        test_file = tmp_path / "nonexistent.py"
        patch = "@@ -1,1 +1,1 @@\n-old\n+new\n"
        result = apply_patch_text_direct(test_file, patch)

        assert not result.success
        assert "no hunks applied" in result.error

    def test_apply_with_bad_patch_returns_error(self, tmp_path: Path):
        """Unparseable patch should return error on strict mode."""
        test_file = tmp_path / "bad_patch_test.py"
        test_file.write_text("original\n", encoding="utf-8")

        # Patch with context that doesn't match anything
        bad_diff = """@@ -1,3 +1,3 @@
 completely
-different
+content
 here"""
        new_content, results = apply_patch("original\n", bad_diff, strict=True)
        assert not results[0].applied


# ====================================================================
# Edge cases
# ====================================================================


def test_empty_hunk_list_returns_original():
    """No hunks found should return original content."""
    original = "hello\nworld\n"
    new_content, results = apply_patch(original, "just some text\nno hunks\n")
    assert new_content == original
    assert len(results) == 1
    assert not results[0].applied


def test_hunk_result_fields_consistent():
    """Each HunkResult should have consistent fields."""
    original = "a\nb\nc\n"
    diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"
    _new, results = apply_patch(original, diff)
    for r in results:
        assert r.hunk_index >= 0
        assert isinstance(r.applied, bool)
        assert isinstance(r.accepted, bool)
        if not r.applied:
            assert r.error or not r.accepted
