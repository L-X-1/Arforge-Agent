from __future__ import annotations

from pathlib import Path

from arforge.bridge import dispatch
from arforge.cli import main
from arforge.core.quality_gate import (
    assess_changed_files,
    assess_quality_change,
    format_quality_report,
    parse_unified_diff_stats,
)


def _resolver(root: Path):
    return lambda filename: root / filename


def test_quality_gate_passes_small_clean_change(tmp_path):
    (tmp_path / "module.py").write_text("def f() -> int:\n    return 1\n", encoding="utf-8")

    report = assess_changed_files(["module.py"], resolver=_resolver(tmp_path))

    assert report["passed"]
    assert report["score"] == 100
    assert report["files_checked"] == 1


def test_quality_gate_flags_trailing_whitespace_as_error(tmp_path):
    (tmp_path / "module.py").write_text("x = 1  \n", encoding="utf-8")

    report = assess_changed_files(["module.py"], resolver=_resolver(tmp_path))

    assert not report["passed"]
    assert any(issue["code"] == "trailing-whitespace" and issue["level"] == "error" for issue in report["issues"])


def test_quality_gate_warns_when_public_surface_lacks_docs(tmp_path):
    target = tmp_path / "arforge" / "cli.py"
    target.parent.mkdir(parents=True)
    target.write_text("COMMANDS = []\n", encoding="utf-8")

    report = assess_changed_files(["arforge/cli.py"], resolver=_resolver(tmp_path))

    assert report["passed"]
    assert any(issue["code"] == "docs-sync" for issue in report["issues"])


def test_quality_gate_docs_sync_warning_clears_when_docs_touched(tmp_path):
    cli = tmp_path / "arforge" / "cli.py"
    cli.parent.mkdir(parents=True)
    cli.write_text("COMMANDS = []\n", encoding="utf-8")
    readme = tmp_path / "README.md"
    readme.write_text("# docs\n", encoding="utf-8")

    report = assess_changed_files(["arforge/cli.py", "README.md"], resolver=_resolver(tmp_path))

    assert all(issue["code"] != "docs-sync" for issue in report["issues"])


def test_quality_gate_warns_on_generated_and_broad_changes(tmp_path):
    files = [f"pkg/file_{idx}.py" for idx in range(21)] + ["build/generated.py"]
    for filename in files:
        path = tmp_path / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x = 1\n", encoding="utf-8")

    report = assess_changed_files(files, resolver=_resolver(tmp_path))
    codes = {issue["code"] for issue in report["issues"]}

    assert "broad-change" in codes
    assert "generated-file" in codes


def test_format_quality_report_is_human_readable(tmp_path):
    (tmp_path / "module.py").write_text("x = 1\n", encoding="utf-8")
    report = assess_changed_files(["module.py"], resolver=_resolver(tmp_path))

    text = format_quality_report(report)

    assert "G12 quality gate: PASS" in text
    assert "score 100/100" in text


def test_parse_unified_diff_stats_counts_shape():
    patch = """diff --git a/module.py b/module.py
--- a/module.py
+++ b/module.py
@@ -1 +1,2 @@
-x = 1
+x = 2
+y = 3
"""

    stats = parse_unified_diff_stats(patch)

    assert stats["files"] == ["module.py"]
    assert stats["additions"] == 2
    assert stats["deletions"] == 1
    assert stats["changed_lines"] == 3
    assert stats["hunks"] == 1


def test_quality_gate_reports_diff_stats_and_large_diff_warning(tmp_path):
    target = tmp_path / "module.py"
    target.write_text("\n".join(f"x_{idx} = {idx}" for idx in range(600)) + "\n", encoding="utf-8")
    additions = "\n".join(f"+x_{idx} = {idx}" for idx in range(501))
    patch = f"""diff --git a/module.py b/module.py
--- a/module.py
+++ b/module.py
@@ -1 +1,501 @@
-x = 0
{additions}
"""

    report = assess_quality_change(patch_text=patch, root=tmp_path)
    codes = {issue["code"] for issue in report["issues"]}

    assert report["diff_stats"]["changed_lines"] == 502
    assert "large-diff" in codes
    assert "over-engineering-risk" in codes


def test_quality_gate_patch_public_surface_requires_docs(tmp_path):
    target = tmp_path / "arforge" / "cli.py"
    target.parent.mkdir(parents=True)
    target.write_text("COMMANDS = ['quality']\n", encoding="utf-8")
    patch = """diff --git a/arforge/cli.py b/arforge/cli.py
--- a/arforge/cli.py
+++ b/arforge/cli.py
@@ -1 +1 @@
-COMMANDS = []
+COMMANDS = ['quality']
"""

    report = assess_quality_change(patch_text=patch, root=tmp_path)

    assert any(issue["code"] == "docs-sync" for issue in report["issues"])


def test_quality_gate_patch_docs_clear_public_surface_warning(tmp_path):
    cli = tmp_path / "arforge" / "cli.py"
    cli.parent.mkdir(parents=True)
    cli.write_text("COMMANDS = ['quality']\n", encoding="utf-8")
    readme = tmp_path / "README.md"
    readme.write_text("# docs\n", encoding="utf-8")
    patch = """diff --git a/arforge/cli.py b/arforge/cli.py
--- a/arforge/cli.py
+++ b/arforge/cli.py
@@ -1 +1 @@
-COMMANDS = []
+COMMANDS = ['quality']
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# old
+# docs
"""

    report = assess_quality_change(patch_text=patch, root=tmp_path)

    assert all(issue["code"] != "docs-sync" for issue in report["issues"])


def test_quality_cli_reads_patch_file(tmp_path, monkeypatch, capsys):
    target = tmp_path / "module.py"
    target.write_text("x = 2\n", encoding="utf-8")
    patch = tmp_path / "change.diff"
    patch.write_text(
        """diff --git a/module.py b/module.py
--- a/module.py
+++ b/module.py
@@ -1 +1 @@
-x = 1
+x = 2
""",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    exit_code = main(["quality", str(patch)])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "Delivery Quality" in output
    assert "Diff: 1 files, +1/-1, 1 hunks" in output


def test_bridge_quality_assess_is_read_only(tmp_path, monkeypatch):
    target = tmp_path / "module.py"
    target.write_text("x = 2\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch(
        {
            "id": 2,
            "version": "1.1",
            "method": "quality.assess",
            "params": {
                "patch_text": """diff --git a/module.py b/module.py
--- a/module.py
+++ b/module.py
@@ -1 +1 @@
-x = 1
+x = 2
""",
            },
        }
    )

    assert "quality.assess" in described["data"]["methods"]
    assert "quality.assess" not in described["data"]["mutating_methods"]
    assert response["ok"]
    assert response["data"]["passed"]
    assert response["data"]["diff_stats"]["files_changed"] == 1


def test_bridge_quality_assess_confines_files_to_workspace(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("secret = True  \n", encoding="utf-8")
    monkeypatch.chdir(workspace)

    response = dispatch(
        {
            "id": 1,
            "version": "1.2",
            "method": "quality.assess",
            "params": {"files": ["../outside.py"]},
        }
    )

    assert response["ok"]
    assert response["data"]["files_checked"] == 0
    assert [issue["code"] for issue in response["data"]["issues"]] == ["unresolved-path"]
