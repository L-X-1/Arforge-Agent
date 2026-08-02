from __future__ import annotations

import os
import time

from arforge.code_tfidf_index import TfidfIndex


def test_build_honors_gitignore_and_skips_binary(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".gitignore").write_text("ignored.py\n", encoding="utf-8")
    (root / "keep.py").write_text(
        "def auth_login():\n    return 'session token'\n",
        encoding="utf-8",
    )
    (root / "ignored.py").write_text(
        "def forbidden_marker():\n    return True\n",
        encoding="utf-8",
    )
    (root / "binary.py").write_bytes(b"\x00\x01\x02")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "skip.py").write_text(
        "def bundled_marker():\n    return True\n",
        encoding="utf-8",
    )

    index = TfidfIndex()
    result = index.build(root)

    assert result["documents"] == 1
    assert result["ignored_files"] >= 2
    assert result["binary_files"] == 1
    assert index.search("auth login")
    assert index.search("forbidden marker") == []
    assert index.search("bundled marker") == []


def test_build_reuses_cache_on_second_pass(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    root = tmp_path / "repo"
    root.mkdir()
    (root / "service.py").write_text(
        "def payment_gateway():\n    return 'ok'\n",
        encoding="utf-8",
    )

    first = TfidfIndex().build(root)
    second_index = TfidfIndex()
    second = second_index.build(root)

    assert first["cache_misses"] == 1
    assert second["cache_hits"] == 1
    assert second["cache_misses"] == 0
    assert second["dirty_files"] == 0
    assert second_index.search("payment gateway")


def test_incremental_update_marks_modified_file_dirty(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    root = tmp_path / "repo"
    root.mkdir()
    target = root / "service.py"
    target.write_text("def legacy_only():\n    return True\n", encoding="utf-8")

    index = TfidfIndex()
    index.build(root)
    time.sleep(0.01)
    target.write_text("def modern_only():\n    return True\n", encoding="utf-8")
    os.utime(target, None)

    result = index.incremental_update(root)

    assert result["previous_documents"] == 1
    assert result["dirty_files"] == 1
    assert result["rebuilt"] is True
    assert index.search("modern")
    assert index.search("legacy") == []


def test_gitignore_negation_reincludes_file(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".gitignore").write_text("*.py\n!keep.py\n", encoding="utf-8")
    (root / "keep.py").write_text(
        "def public_marker():\n    return True\n",
        encoding="utf-8",
    )
    (root / "drop.py").write_text(
        "def private_marker():\n    return True\n",
        encoding="utf-8",
    )

    index = TfidfIndex()
    result = index.build(root)

    assert result["documents"] == 1
    assert index.search("public marker")
    assert index.search("private") == []


def test_health_reports_cache_and_exclusion_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".gitignore").write_text("ignored.py\n", encoding="utf-8")
    (root / "keep.py").write_text(
        "def searchable_marker():\n    return True\n",
        encoding="utf-8",
    )
    (root / "ignored.py").write_text(
        "def ignored_marker():\n    return True\n",
        encoding="utf-8",
    )

    index = TfidfIndex()
    index.build(root)
    health = index.health()

    assert health["documents"] == 1
    assert health["vocabulary"] > 0
    assert health["ignored_files"] == 1
    assert health["cache_misses"] == 1
