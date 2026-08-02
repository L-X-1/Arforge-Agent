from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

from arforge.core.patch_plan import analyze_patch_plan, apply_patch_batch, format_patch_plan


def test_patch_plan_counts_files_hunks_and_lines(tmp_path):
    patch = """diff --git a/a.py b/a.py
--- a/a.py
+++ b/a.py
@@ -1,2 +1,2 @@
 def a():
-    return 1
+    return 2
diff --git a/b.py b/b.py
--- a/b.py
+++ b/b.py
@@ -1,1 +1,2 @@
 x = 1
+y = 2
"""

    plan = analyze_patch_plan(patch, root=tmp_path)

    assert plan["summary"] == {
        "files": 2,
        "hunks": 2,
        "additions": 2,
        "deletions": 1,
        "batches": 2,
    }
    assert [file["path"] for file in plan["files"]] == ["a.py", "b.py"]


def test_patch_plan_splits_many_hunks_into_batches(tmp_path):
    hunks = "\n".join(
        [
            f"@@ -{line},1 +{line},1 @@\n-old_{line}\n+new_{line}"
            for line in range(1, 8)
        ]
    )
    patch = f"--- a/app.py\n+++ b/app.py\n{hunks}\n"

    plan = analyze_patch_plan(patch, root=tmp_path, max_hunks_per_batch=3)

    assert plan["summary"]["hunks"] == 7
    assert plan["summary"]["batches"] == 3
    assert plan["files"][0]["batches"][0] == {
        "first_hunk": 0,
        "last_hunk": 2,
        "hunks": 3,
        "additions": 3,
        "deletions": 3,
    }
    assert any("split into 3 batches" in warning for warning in plan["warnings"])


def test_patch_plan_warns_for_large_existing_file(tmp_path):
    target = tmp_path / "large.py"
    target.write_text("\n".join(f"line_{idx}" for idx in range(12)), encoding="utf-8")
    patch = """--- a/large.py
+++ b/large.py
@@ -1,1 +1,1 @@
-line_0
+line_zero
"""

    plan = analyze_patch_plan(patch, root=tmp_path, large_file_lines=10)

    assert plan["files"][0]["large_file"] is True
    assert plan["files"][0]["line_count"] == 12
    assert any("review/apply in small batches" in warning for warning in plan["warnings"])


def test_format_patch_plan_is_stable(tmp_path):
    patch = """--- a/app.py
+++ b/app.py
@@ -1,1 +1,1 @@
-old
+new
"""
    plan = analyze_patch_plan(patch, root=tmp_path)

    output = format_patch_plan(plan)

    assert "Patch plan" in output
    assert "files: 1" in output
    assert "app.py: hunks=1 +1 -1" in output


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools"):
            del sys.modules[mod]
    import arforge.tools.file_tools

    importlib.reload(arforge.tools.file_tools)
    return tmp_path


def test_patch_plan_tool_is_registered_read_only(workspace):
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("patch_plan")

    assert tool is not None
    assert tool.schema.risk_level == "low"
    assert tool.schema.requires_confirmation is False
    assert tool.schema.category == "read"


def test_patch_plan_tool_uses_workspace(workspace):
    from arforge.tool_registry import REGISTRY

    (workspace / "large.py").write_text(
        "\n".join(f"line_{idx}" for idx in range(900)),
        encoding="utf-8",
    )
    patch = """--- a/large.py
+++ b/large.py
@@ -1,1 +1,1 @@
-line_0
+line_zero
"""

    result = REGISTRY.execute_by_name("patch_plan", {"patch_text": patch})

    assert result.success, result.error
    assert "Patch plan" in result.output
    assert "large.py" in result.output
    assert "review/apply in small batches" in result.output


def test_apply_patch_batch_dry_run_does_not_write(tmp_path):
    target = tmp_path / "app.py"
    target.write_text("a = 1\nb = 2\nc = 3\n", encoding="utf-8")
    patch = """--- a/app.py
+++ b/app.py
@@ -1,1 +1,1 @@
-a = 1
+a = 10
@@ -3,1 +3,1 @@
-c = 3
+c = 30
"""

    result = apply_patch_batch(patch, root=tmp_path, batch_index=0, max_hunks_per_batch=1, dry_run=True)

    assert result["success"] is True
    assert result["applied"] is False
    assert result["hunks_applied"] == 1
    assert "a = 10" in result["preview"]
    assert target.read_text(encoding="utf-8") == "a = 1\nb = 2\nc = 3\n"


def test_apply_patch_batch_applies_one_batch_at_a_time(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    target = tmp_path / "app.py"
    target.write_text("a = 1\nb = 2\nc = 3\n", encoding="utf-8")
    patch = """--- a/app.py
+++ b/app.py
@@ -1,1 +1,1 @@
-a = 1
+a = 10
@@ -3,1 +3,1 @@
-c = 3
+c = 30
"""

    first = apply_patch_batch(patch, root=tmp_path, batch_index=0, max_hunks_per_batch=1, dry_run=False)
    second = apply_patch_batch(patch, root=tmp_path, batch_index=1, max_hunks_per_batch=1, dry_run=False)

    assert first["success"] is True
    assert first["applied"] is True
    assert second["success"] is True
    assert second["applied"] is True
    assert target.read_text(encoding="utf-8") == "a = 10\nb = 2\nc = 30\n"


def test_apply_patch_batch_rejects_invalid_python_without_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    target = tmp_path / "bad.py"
    target.write_text("def ok():\n    return 1\n", encoding="utf-8")
    patch = """--- a/bad.py
+++ b/bad.py
@@ -1,2 +1,2 @@
-def ok():
-    return 1
+def broken(:
+    return 2
"""

    result = apply_patch_batch(patch, root=tmp_path, batch_index=0, dry_run=False)

    assert result["success"] is False
    assert result["applied"] is False
    assert "Python syntax error" in result["error"]
    assert target.read_text(encoding="utf-8") == "def ok():\n    return 1\n"


def test_apply_patch_batch_handles_utf8_bom_files(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    target = tmp_path / "bom.py"
    target.write_text("x = 1\n", encoding="utf-8-sig")
    patch = """--- a/bom.py
+++ b/bom.py
@@ -1,1 +1,1 @@
-x = 1
+x = 2
"""

    result = apply_patch_batch(patch, root=tmp_path, batch_index=0, dry_run=False)

    assert result["success"] is True
    assert result["applied"] is True
    assert target.read_text(encoding="utf-8-sig") == "x = 2\n"


def test_apply_patch_batch_tool_is_registered_workspace_write(workspace, monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    from arforge.tool_registry import REGISTRY

    target = workspace / "tool.py"
    target.write_text("x = 1\n", encoding="utf-8")
    patch = """--- a/tool.py
+++ b/tool.py
@@ -1,1 +1,1 @@
-x = 1
+x = 2
"""
    tool = REGISTRY.get("apply_patch_batch")
    result = REGISTRY.execute_by_name(
        "apply_patch_batch",
        {"patch_text": patch, "batch_index": 0, "dry_run": False},
    )

    assert tool is not None
    assert tool.schema.category == "workspace_write"
    assert tool.schema.requires_confirmation is True
    assert result.success, result.error
    assert "success" in result.output
    assert target.read_text(encoding="utf-8") == "x = 2\n"


def test_cli_patch_batch_previews_patch_file(tmp_path, capsys):
    from arforge.cli import _run_patch_batch

    target = tmp_path / "cli.py"
    target.write_text("value = 1\n", encoding="utf-8")
    patch_file = tmp_path / "change.patch"
    patch_file.write_text(
        """--- a/cli.py
+++ b/cli.py
@@ -1,1 +1,1 @@
-value = 1
+value = 2
""",
        encoding="utf-8",
    )

    cwd = Path.cwd()
    try:
        import os

        os.chdir(tmp_path)
        assert _run_patch_batch([str(patch_file), "--batch", "0"]) == 0
    finally:
        os.chdir(cwd)

    out = capsys.readouterr().out
    assert "Patch Batch" in out
    assert "Dry run" in out
    assert target.read_text(encoding="utf-8") == "value = 1\n"
