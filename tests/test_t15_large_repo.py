"""Tests for core/large_repo.py — large repository scaling (T15)."""

import time



class TestBinaryDetection:
    """Binary file detection accuracy."""

    def test_known_binary_extension(self):
        from arforge.core.large_repo import is_binary_file

        assert is_binary_file("image.png") is True
        assert is_binary_file("archive.zip") is True
        assert is_binary_file("program.exe") is True
        assert is_binary_file("font.ttf") is True
        assert is_binary_file("compiled.pyc") is True

    def test_text_file_not_binary(self, tmp_path):
        from arforge.core.large_repo import is_binary_file

        for name in ("script.py", "README.md", "config.json"):
            f = tmp_path / name
            f.write_text("content")
            assert is_binary_file(f) is False

    def test_real_text_file(self, tmp_path):
        from arforge.core.large_repo import is_binary_file

        f = tmp_path / "test.py"
        f.write_text("def hello(): return 'world'\n")
        assert is_binary_file(f) is False

    def test_null_byte_detected_as_binary(self, tmp_path):
        from arforge.core.large_repo import is_binary_file

        f = tmp_path / "data.bin"
        f.write_bytes(b"text\x00binary")
        assert is_binary_file(f) is True


class TestFileSizeGuard:
    """File size limits."""

    def test_small_file_not_too_large(self, tmp_path):
        from arforge.core.large_repo import is_too_large

        f = tmp_path / "small.py"
        f.write_text("x = 1\n")
        assert is_too_large(f, max_bytes=1024) is False

    def test_large_file_detected(self, tmp_path):
        from arforge.core.large_repo import is_too_large

        f = tmp_path / "big.py"
        f.write_text("x" * 5000)
        assert is_too_large(f, max_bytes=100) is True


class TestGitignoreParser:
    """.gitignore pattern matching."""

    def test_parse_basic_patterns(self):
        from arforge.core.large_repo import _parse_gitignore

        patterns = _parse_gitignore(["*.pyc", "__pycache__/", "!important.pyc"])
        assert len(patterns) == 3
        assert patterns[0] == (False, "*.pyc")
        assert patterns[2] == (True, "important.pyc")

    def test_ignore_comments_and_blanks(self):
        from arforge.core.large_repo import _parse_gitignore

        patterns = _parse_gitignore(["# comment", "", "  *.log  "])
        assert len(patterns) == 1
        assert patterns[0] == (False, "*.log")

    def test_is_ignored_match(self):
        from arforge.core.large_repo import _parse_gitignore, is_ignored

        patterns = _parse_gitignore(["*.pyc", "__pycache__/"])
        assert is_ignored("test.pyc", patterns) is True
        assert is_ignored("src/test.pyc", patterns) is True
        assert is_ignored("test.py", patterns) is False

    def test_is_ignored_negation(self):
        from arforge.core.large_repo import _parse_gitignore, is_ignored

        patterns = _parse_gitignore(["*.log", "!important.log"])
        assert is_ignored("error.log", patterns) is True
        assert is_ignored("important.log", patterns) is False

    def test_load_gitignore_from_disk(self, tmp_path):
        from arforge.core.large_repo import load_gitignore_patterns

        gf = tmp_path / ".gitignore"
        gf.write_text("*.pyc\n__pycache__/\n")
        patterns = load_gitignore_patterns(tmp_path)
        assert len(patterns) == 2


class TestSmartScan:
    """Smart project scanning."""

    def test_scan_small_directory(self, tmp_path):
        from arforge.core.large_repo import smart_scan

        (tmp_path / "main.py").write_text("print('hello')")
        (tmp_path / "utils.py").write_text("def helper(): pass")
        (tmp_path / "README.md").write_text("# Project")

        results = smart_scan(root=tmp_path, suffixes=(".py", ".md"))
        paths = {r["path"] for r in results}
        assert "main.py" in paths
        assert "utils.py" in paths
        assert "README.md" in paths

    def test_scan_skips_binary(self, tmp_path):
        from arforge.core.large_repo import smart_scan

        (tmp_path / "main.py").write_text("code")
        (tmp_path / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        results = smart_scan(root=tmp_path, suffixes=(".py", ".png"), skip_binary=True)
        paths = {r["path"] for r in results}
        assert "main.py" in paths
        assert "image.png" not in paths

    def test_scan_respects_gitignore(self, tmp_path):
        from arforge.core.large_repo import smart_scan

        (tmp_path / ".gitignore").write_text("*.log\n")
        (tmp_path / "main.py").write_text("code")
        (tmp_path / "debug.log").write_text("log")

        results = smart_scan(root=tmp_path, suffixes=(".py", ".log"), respect_gitignore=True)
        paths = {r["path"] for r in results}
        assert "main.py" in paths
        assert "debug.log" not in paths

    def test_scan_skips_standard_dirs(self, tmp_path):
        from arforge.core.large_repo import smart_scan

        (tmp_path / "main.py").write_text("code")
        ng = tmp_path / "node_modules"
        ng.mkdir()
        (ng / "lib.js").write_text("js")

        results = smart_scan(root=tmp_path, suffixes=(".py", ".js"))
        paths = {r["path"] for r in results}
        assert "main.py" in paths
        assert "node_modules/lib.js" not in paths

    def test_scan_respects_max_files(self, tmp_path):
        from arforge.core.large_repo import smart_scan

        for i in range(10):
            (tmp_path / f"file_{i}.py").write_text("code")

        results = smart_scan(root=tmp_path, suffixes=(".py",), max_files=5)
        assert len(results) <= 5

    def test_scan_stats_returns_metadata(self, tmp_path):
        from arforge.core.large_repo import scan_stats

        (tmp_path / "main.py").write_text("code")
        stats = scan_stats(root=tmp_path)
        assert stats["total_files_estimate"] >= 1
        assert stats["code_files_estimate"] >= 1


class TestIncrementalScan:
    """T15: Incremental scanning for fast re-scans."""

    def test_first_scan_no_previous_state(self, tmp_path):
        from arforge.core.large_repo import incremental_smart_scan, invalidate_incremental_state

        invalidate_incremental_state()

        (tmp_path / "a.py").write_text("a")
        (tmp_path / "b.py").write_text("b")

        result = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=False)
        assert result["total"] == 2
        assert result["added"] == 2
        assert result["incremental"] is False

    def test_second_scan_unchanged(self, tmp_path):
        from arforge.core.large_repo import incremental_smart_scan, invalidate_incremental_state

        invalidate_incremental_state()

        (tmp_path / "a.py").write_text("a")
        (tmp_path / "b.py").write_text("b")

        # First scan
        r1 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r1["total"] == 2
        assert r1["added"] == 2

        # Second scan — nothing changed
        r2 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r2["total"] == 2
        assert r2["unchanged"] == 2
        assert r2["changed"] == 0
        assert r2["added"] == 0
        assert r2["incremental"] is True

    def test_detect_changed_file(self, tmp_path):
        from arforge.core.large_repo import incremental_smart_scan, invalidate_incremental_state

        invalidate_incremental_state()

        (tmp_path / "a.py").write_text("original")

        r1 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r1["added"] == 1

        # Modify file
        time.sleep(0.01)  # Ensure mtime changes
        (tmp_path / "a.py").write_text("modified")

        r2 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r2["changed"] == 1
        assert r2["total"] == 1

    def test_detect_added_file(self, tmp_path):
        from arforge.core.large_repo import incremental_smart_scan, invalidate_incremental_state

        invalidate_incremental_state()

        (tmp_path / "a.py").write_text("a")

        r1 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r1["total"] == 1

        (tmp_path / "b.py").write_text("b")

        r2 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r2["total"] == 2
        assert r2["added"] == 1
        assert r2["unchanged"] == 1

    def test_detect_removed_file(self, tmp_path):
        from arforge.core.large_repo import incremental_smart_scan, invalidate_incremental_state

        invalidate_incremental_state()

        f = tmp_path / "a.py"
        f.write_text("a")

        r1 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r1["total"] == 1

        f.unlink()

        r2 = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)
        assert r2["total"] == 0
        assert r2["removed"] == 1

    def test_invalidate_clears_state(self, tmp_path):
        from arforge.core.large_repo import (
            incremental_smart_scan,
            invalidate_incremental_state,
            get_incremental_delta,
        )

        invalidate_incremental_state()

        (tmp_path / "a.py").write_text("a")
        incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=True)

        assert get_incremental_delta()["has_state"] is True

        invalidate_incremental_state()
        assert get_incremental_delta()["has_state"] is False

    def test_scan_time_recorded(self, tmp_path):
        from arforge.core.large_repo import incremental_smart_scan, invalidate_incremental_state

        invalidate_incremental_state()

        (tmp_path / "a.py").write_text("a")
        result = incremental_smart_scan(root=tmp_path, suffixes=(".py",), use_incremental=False)
        assert "scan_time_ms" in result
        assert result["scan_time_ms"] >= 0


class TestIndexCache:
    """Index cache persistence."""

    def test_save_and_load_cache(self):
        from arforge.core.large_repo import save_index_cache, load_index_cache, invalidate_index_cache

        invalidate_index_cache()
        save_index_cache({"test": 123})
        loaded = load_index_cache(max_age_seconds=3600)
        assert loaded is not None
        assert loaded["test"] == 123

    def test_expired_cache_returns_none(self):
        from arforge.core.large_repo import save_index_cache, load_index_cache, invalidate_index_cache

        invalidate_index_cache()
        save_index_cache({"test": 456})
        loaded = load_index_cache(max_age_seconds=0)
        assert loaded is None

    def test_invalidate_removes_cache(self):
        from arforge.core.large_repo import save_index_cache, load_index_cache, invalidate_index_cache

        save_index_cache({"test": 789})
        invalidate_index_cache()
        loaded = load_index_cache(max_age_seconds=3600)
        assert loaded is None


class TestRepoScaleProductPath:
    """T15 product path for bounded large-repo scan/search."""

    def test_smart_scan_budget_is_deterministic_across_filesystems(
        self,
        tmp_path,
        monkeypatch,
    ):
        from arforge.core import large_repo

        for name in ("module_000.py", "module_001.py", "module_002.py"):
            (tmp_path / name).write_text("value = 1\n", encoding="utf-8")

        monkeypatch.setattr(
            large_repo.os,
            "walk",
            lambda _root: [
                (
                    str(tmp_path),
                    [],
                    ["module_002.py", "module_000.py", "module_001.py"],
                )
            ],
        )

        scanned = large_repo.smart_scan(tmp_path, max_files=2)

        assert [item["path"] for item in scanned] == [
            "module_000.py",
            "module_001.py",
        ]

    def test_repo_scale_report_is_budgeted_and_searchable(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
        from arforge.core.large_repo import build_repo_scale_report, invalidate_incremental_state

        invalidate_incremental_state()
        repo = tmp_path / "repo"
        repo.mkdir()
        for index in range(60):
            marker = "needle_target" if index == 42 else "regular"
            (repo / f"module_{index:03}.py").write_text(
                f"def {marker}_{index}():\n    return {index}\n",
                encoding="utf-8",
            )
        (repo / "node_modules").mkdir()
        (repo / "node_modules" / "ignored.py").write_text("def needle_target_ignored(): pass", encoding="utf-8")
        (repo / "asset.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        report = build_repo_scale_report(repo, query="needle target", max_files=50, limit=5)

        assert report["schema_version"] == 1
        assert report["budget"]["max_files"] == 50
        assert report["scan"]["total"] == 50
        assert report["scan"]["truncated"] is True
        assert report["suffix_counts"][".py"] == 50
        assert report["search"]["searched_files"] == 50
        assert any(item["path"] == "module_042.py" for item in report["search"]["items"])
        assert all("node_modules" not in item["path"] for item in report["search"]["items"])

        second = build_repo_scale_report(repo, query="needle target", max_files=50, limit=5)
        assert second["scan"]["incremental"] is True
        assert second["scan"]["unchanged"] == 50

    def test_bridge_repo_scale_is_retired(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
        monkeypatch.chdir(tmp_path)
        from arforge.product.direct_dispatch import dispatch

        described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
        response = dispatch({"id": 2, "version": "1.1", "method": "repo.scale", "params": {"path": "repo"}})

        assert "repo.scale" not in described["data"]["methods"]
        assert response["ok"] is False
        assert response["error"]["code"] == "METHOD_NOT_FOUND"

    def test_cli_repo_scale_renders_search_hits(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
        from arforge.cli import _run_repo_scale
        from arforge.core.large_repo import invalidate_incremental_state

        invalidate_incremental_state()
        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / "api.py").write_text("def invoice_api():\n    return 'ok'\n", encoding="utf-8")

        assert _run_repo_scale([str(repo), "--query", "invoice api", "--max-files", "20"]) == 0
        out = capsys.readouterr().out

        assert "Repository Scale" in out
        assert "invoice api" in out
        assert "api.py" in out
        assert "Scanned files" in out
