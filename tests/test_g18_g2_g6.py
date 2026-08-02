"""Tests for sandbox enforcement (G18), large repo scaling (G2), and checkpoint/resume (G6)."""

import tempfile
from pathlib import Path


# ====================================================================
# G18: Sandbox enforcement
# ====================================================================


class TestSandboxEnforce:
    """Tests for sandbox enforcement module."""

    def test_classify_command_safe(self):
        from arforge.security.sandbox_enforce import classify_command
        assert classify_command("python test.py") == "safe"
        assert classify_command("echo hello") == "safe"
        assert classify_command("ls -la") == "safe"

    def test_classify_command_dangerous(self):
        from arforge.security.sandbox_enforce import classify_command
        assert classify_command("rm -rf /") in ("dangerous", "destructive")
        assert classify_command("sudo rm file") == "dangerous"
        assert classify_command("shutdown now") == "dangerous"

    def test_classify_command_network(self):
        from arforge.security.sandbox_enforce import classify_command
        assert classify_command("curl https://example.com") == "network"
        assert classify_command("wget file") == "network"

    def test_classify_command_traversal(self):
        from arforge.security.sandbox_enforce import classify_command
        assert classify_command("cat ../../etc/passwd") == "traversal"
        assert classify_command("cat /etc/passwd") == "traversal"

    def test_check_command_safety_blocks_dangerous(self):
        from arforge.security.sandbox_enforce import check_command_safety, SandboxDecision
        decision, reason = check_command_safety("rm -rf /")
        assert decision == SandboxDecision.BLOCKED_DANGEROUS
        assert decision != SandboxDecision.ALLOWED

    def test_check_command_safety_allows_safe(self):
        from arforge.security.sandbox_enforce import check_command_safety, SandboxDecision
        decision, reason = check_command_safety("echo hello")
        assert decision == SandboxDecision.ALLOWED

    def test_check_command_safety_blocks_network_readonly(self):
        from arforge.security.sandbox_enforce import check_command_safety, SandboxDecision
        decision, reason = check_command_safety("curl example.com", sandbox_mode="read-only")
        assert decision == SandboxDecision.BLOCKED_NETWORK

    def test_set_workspace_and_path_safety(self):
        from arforge.security.sandbox_enforce import set_workspace, is_path_safe, _SAFE_PREFIXES
        with tempfile.TemporaryDirectory() as tmp:
            set_workspace(tmp)
            assert is_path_safe(Path(tmp) / "subdir" / "file.py")
            assert not is_path_safe("/etc/passwd")
        _SAFE_PREFIXES.clear()

    def test_check_file_write_readonly_blocks(self):
        from arforge.security.sandbox_enforce import check_file_write, SandboxDecision
        decision, reason = check_file_write("test.py", sandbox_mode="read-only")
        assert decision == SandboxDecision.BLOCKED_WRITE_READONLY

    def test_check_file_write_allows_safe(self):
        from arforge.security.sandbox_enforce import check_file_write, set_workspace, SandboxDecision, _SAFE_PREFIXES
        _SAFE_PREFIXES.clear()
        set_workspace(".")
        decision, reason = check_file_write("test.py", sandbox_mode="workspace-write")
        assert decision == SandboxDecision.ALLOWED

    def test_enforce_blocks_dangerous_tool(self):
        from arforge.security.sandbox_enforce import enforce, SandboxDecision
        decision, reason = enforce("run_cmd", {"command": "rm -rf /"})
        assert decision == SandboxDecision.BLOCKED_DANGEROUS

    def test_enforce_allows_safe_tool(self):
        from arforge.security.sandbox_enforce import enforce, SandboxDecision
        decision, reason = enforce("run_cmd", {"command": "echo hi"})
        assert decision == SandboxDecision.ALLOWED

    def test_enforce_blocks_write_readonly(self):
        from arforge.security.sandbox_enforce import enforce, SandboxDecision
        decision, reason = enforce("write_file", {"path": "test.py"}, sandbox_mode="read-only")
        assert decision == SandboxDecision.BLOCKED_WRITE_READONLY

    def test_audit_trail(self):
        from arforge.security.sandbox_enforce import get_audit_trail, AuditEntry, SandboxDecision
        audit = get_audit_trail()
        audit.clear()

        audit.record(AuditEntry(tool="run_cmd", args="echo hi", decision=SandboxDecision.ALLOWED))
        audit.record(AuditEntry(tool="run_cmd", args="rm -rf /", decision=SandboxDecision.BLOCKED_DANGEROUS, reason="dangerous"))

        stats = audit.stats()
        assert stats["total"] == 2
        assert stats["allowed"] == 1
        assert stats["blocked"] == 1


# ====================================================================
# G2: Large repo scaling
# ====================================================================


class TestLargeRepo:
    """Tests for large repo scaling module."""

    def test_gitignore_parse(self):
        from arforge.core.large_repo import _parse_gitignore
        patterns = _parse_gitignore([
            "*.pyc",
            "__pycache__/",
            "!important.pyc",
            "# comment",
        ])
        assert (False, "*.pyc") in patterns
        assert (False, "__pycache__") in patterns
        assert (True, "important.pyc") in patterns

    def test_is_ignored(self):
        from arforge.core.large_repo import is_ignored
        patterns = [
            (False, "*.pyc"),
            (False, "__pycache__"),
            (True, "important.pyc"),
        ]
        assert is_ignored("test.pyc", patterns)
        assert is_ignored("__pycache__/", patterns)
        assert not is_ignored("important.pyc", patterns)
        assert not is_ignored("main.py", patterns)

    def test_binary_detection_text(self):
        from arforge.core.large_repo import is_binary_file
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    return 1\n")
            path = f.name
        try:
            assert not is_binary_file(path)
        finally:
            Path(path).unlink(missing_ok=True)

    def test_binary_detection_null_byte(self):
        from arforge.core.large_repo import is_binary_file
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".bin", delete=False) as f:
            f.write(b"some text\x00binary")
            path = f.name
        try:
            assert is_binary_file(path)
        finally:
            Path(path).unlink(missing_ok=True)

    def test_binary_detection_by_extension(self):
        from arforge.core.large_repo import is_binary_file
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".png", delete=False) as f:
            f.write(b"fake png data")
            path = f.name
        try:
            assert is_binary_file(path)
        finally:
            Path(path).unlink(missing_ok=True)

    def test_too_large_detection(self):
        from arforge.core.large_repo import is_too_large
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".txt", delete=False) as f:
            f.write(b"x" * 100)
            path = f.name
        try:
            assert not is_too_large(path, max_bytes=1000)
            assert is_too_large(path, max_bytes=50)
        finally:
            Path(path).unlink(missing_ok=True)

    def test_smart_scan(self):
        from arforge.core.large_repo import smart_scan
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "main.py").write_text("print('hello')", encoding="utf-8")
            (d / "app.js").write_text("console.log('hi')", encoding="utf-8")
            (d / "data.bin").write_bytes(b"\x00\x01\x02")
            (d / "image.png").write_bytes(b"fake png")

            # Create .gitignore
            (d / ".gitignore").write_text("*.pyc\n", encoding="utf-8")

            results = smart_scan(d, suffixes=(".py", ".js"), respect_gitignore=True, skip_binary=True)
            paths = [r["path"] for r in results]
            assert "main.py" in paths or any("main.py" in p for p in paths)
            assert "app.js" in paths or any("app.js" in p for p in paths)
            # Binary files should be skipped
            assert not any("data.bin" in p for p in paths)
            assert not any("image.png" in p for p in paths)

    def test_index_cache(self):
        from arforge.core.large_repo import save_index_cache, load_index_cache, invalidate_index_cache
        test_data = {"symbols": 100, "files": 50}
        save_index_cache(test_data)

        loaded = load_index_cache(max_age_seconds=3600)
        assert loaded is not None
        assert loaded["symbols"] == 100

        # Should expire
        loaded_expired = load_index_cache(max_age_seconds=0)
        assert loaded_expired is None

        invalidate_index_cache()
        assert load_index_cache(max_age_seconds=3600) is None

    def test_scan_stats(self):
        from arforge.core.large_repo import scan_stats
        stats = scan_stats(".")
        assert "total_files_estimate" in stats
        assert "code_files_estimate" in stats
        assert stats["total_files_estimate"] > 0


# ====================================================================
# G6: Task checkpoint/resume
# ====================================================================


class TestCheckpoint:
    """Tests for checkpoint/resume module."""

    def test_save_and_load_checkpoint(self):
        from arforge.core.checkpoint import save_checkpoint, load_checkpoint, generate_run_id
        rid = generate_run_id()
        messages = [
            {"role": "system", "content": "You are a code agent."},
            {"role": "user", "content": "Fix the bug."},
            {"role": "assistant", "content": "Looking at the code..."},
        ]

        cp = save_checkpoint(
            run_id=rid,
            task="fix bug in auth.py",
            messages=messages,
            steps_completed=3,
            max_steps=25,
            tool_calls_made=5,
            tokens_used=1500,
        )
        assert cp.run_id == rid
        assert cp.task == "fix bug in auth.py"
        assert cp.steps_completed == 3

        loaded = load_checkpoint(rid)
        assert loaded is not None
        assert loaded.run_id == rid
        assert loaded.task == "fix bug in auth.py"
        assert loaded.messages == messages
        assert loaded.steps_completed == 3

    def test_list_checkpoints(self):
        from arforge.core.checkpoint import save_checkpoint, list_checkpoints, generate_run_id
        rid1 = generate_run_id()
        rid2 = generate_run_id()

        save_checkpoint(rid1, "task A", [{"role": "user", "content": "hi"}])
        save_checkpoint(rid2, "task B", [{"role": "user", "content": "hello"}])

        cps = list_checkpoints()
        rids = [c["run_id"] for c in cps]
        assert rid2 in rids  # Most recent first
        assert rid1 in rids

    def test_update_checkpoint_status(self):
        from arforge.core.checkpoint import save_checkpoint, update_checkpoint_status, load_checkpoint, generate_run_id
        rid = generate_run_id()
        save_checkpoint(rid, "task", [{"role": "user", "content": "x"}])
        assert update_checkpoint_status(rid, "completed")
        cp = load_checkpoint(rid)
        assert cp is not None
        assert cp.status == "completed"

    def test_delete_checkpoint(self):
        from arforge.core.checkpoint import save_checkpoint, delete_checkpoint, load_checkpoint, generate_run_id
        rid = generate_run_id()
        save_checkpoint(rid, "task", [{"role": "user", "content": "x"}])
        assert delete_checkpoint(rid)
        assert load_checkpoint(rid) is None

    def test_load_nonexistent(self):
        from arforge.core.checkpoint import load_checkpoint
        assert load_checkpoint("nonexistent_run_id") is None

    def test_generate_run_id(self):
        from arforge.core.checkpoint import generate_run_id
        rid1 = generate_run_id()
        rid2 = generate_run_id()
        assert rid1 != rid2
        assert rid1.startswith("run_")
        assert rid2.startswith("run_")

    def test_checkpoint_with_metadata(self):
        from arforge.core.checkpoint import save_checkpoint, load_checkpoint, generate_run_id
        rid = generate_run_id()
        save_checkpoint(
            rid, "task", [{"role": "user", "content": "x"}],
            complexity="medium", branch="feature/fix",
        )
        cp = load_checkpoint(rid)
        assert cp is not None
        assert cp.metadata.get("complexity") == "medium"
        assert cp.metadata.get("branch") == "feature/fix"
