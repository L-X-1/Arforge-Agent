from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import arforge.worktree_runtime as worktree_module
from arforge.product.session_runtime import SessionRuntime, SessionRuntimeError
from arforge.workspace_context import execution_scope
from arforge.worktree_runtime import WorktreeError, WorktreeManager


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    if check and result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return result


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _git(root, "config", "user.name", "Arforge Tests")
    _git(root, "config", "user.email", "tests@arforge.local")
    (root / "tracked.txt").write_text("base\n", encoding="utf-8")
    _git(root, "add", "tracked.txt")
    _git(root, "commit", "-m", "initial")
    return root


def _bind_manager(monkeypatch: pytest.MonkeyPatch, manager: WorktreeManager) -> None:
    monkeypatch.setattr(worktree_module, "get_worktree_manager", lambda state_path=None: manager)


def test_enter_binds_only_the_owning_session_and_file_tools_write_there(tmp_path, monkeypatch):
    from arforge.tools import file_tools

    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    _bind_manager(monkeypatch, manager)
    original_workspace = file_tools.WORKSPACE
    file_tools.set_workspace(root)
    try:
        created = manager.enter("session-a", root, "feature/demo")
        worktree = Path(created["worktree_path"])

        with execution_scope("session-a"):
            assert file_tools.get_workspace() == worktree
            assert file_tools.write_file("isolated.txt", "only here") == "wrote isolated.txt"
        with execution_scope("session-b"):
            assert file_tools.get_workspace() == root

        assert (worktree / "isolated.txt").read_text(encoding="utf-8") == "only here"
        assert not (root / "isolated.txt").exists()
        with pytest.raises(WorktreeError, match="belongs"):
            manager.exit("session-b", "keep")
    finally:
        with execution_scope("session-a"):
            manager.exit("session-a", "remove", discard_changes=True)
        file_tools.set_workspace(original_workspace)


def test_remove_refuses_dirty_or_committed_work_without_explicit_discard(tmp_path):
    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    created = manager.enter("session-a", root, "dirty")
    worktree = Path(created["worktree_path"])
    (worktree / "untracked.txt").write_text("important\n", encoding="utf-8")

    with pytest.raises(WorktreeError, match="uncommitted"):
        manager.exit("session-a", "remove")
    assert worktree.exists()

    removed = manager.exit("session-a", "remove", discard_changes=True)
    assert removed["status"] == "removed"
    assert removed["changed_files"] == 1
    assert not worktree.exists()
    branch = _git(root, "branch", "--list", created["worktree_branch"]).stdout.strip()
    assert branch == ""


def test_remove_counts_new_commits_and_requires_discard(tmp_path):
    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    created = manager.enter("session-a", root, "committed")
    worktree = Path(created["worktree_path"])
    (worktree / "tracked.txt").write_text("changed\n", encoding="utf-8")
    _git(worktree, "add", "tracked.txt")
    _git(worktree, "commit", "-m", "worktree change")

    with pytest.raises(WorktreeError, match="new commits"):
        manager.exit("session-a", "remove")
    removed = manager.exit("session-a", "remove", discard_changes=True)

    assert removed["commits"] == 1
    assert removed["status"] == "removed"


def test_unknown_change_state_fails_closed_before_remove(tmp_path, monkeypatch):
    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    created = manager.enter("session-a", root, "unknown")
    worktree = Path(created["worktree_path"])
    monkeypatch.setattr(manager, "_change_summary", lambda _record: None)

    with pytest.raises(WorktreeError, match="could not verify"):
        manager.exit("session-a", "remove")
    assert worktree.exists()

    result = manager.exit("session-a", "remove", discard_changes=True)
    assert result["status"] == "removed"


def test_keep_preserves_worktree_but_returns_session_to_base_workspace(tmp_path, monkeypatch):
    from arforge.tools import file_tools

    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    _bind_manager(monkeypatch, manager)
    original_workspace = file_tools.WORKSPACE
    file_tools.set_workspace(root)
    created = manager.enter("session-a", root, "keep-me")
    worktree = Path(created["worktree_path"])
    try:
        kept = manager.exit("session-a", "keep")
        assert kept["status"] == "kept"
        assert worktree.exists()
        with execution_scope("session-a"):
            assert file_tools.get_workspace() == root
        assert manager.status("session-a")["active"] is False
    finally:
        _git(root, "worktree", "remove", "--force", str(worktree), check=False)
        _git(root, "branch", "-D", created["worktree_branch"], check=False)
        file_tools.set_workspace(original_workspace)


def test_persisted_active_state_is_restored_by_a_new_manager(tmp_path):
    root = _repo(tmp_path)
    state_path = tmp_path / "state.json"
    first = WorktreeManager(state_path)
    created = first.enter("session-a", root, "resume")
    second = WorktreeManager(state_path)

    status = second.status("session-a")
    assert status["active"] is True
    assert second.active_workspace("session-a") == Path(created["worktree_path"])

    second.exit("session-a", "remove")


def test_dirty_source_repository_is_rejected_before_creation(tmp_path):
    root = _repo(tmp_path)
    (root / "local.txt").write_text("not committed\n", encoding="utf-8")
    manager = WorktreeManager(tmp_path / "state.json")

    with pytest.raises(WorktreeError, match="commit or stash"):
        manager.enter("session-a", root, "blocked")

    assert not (root.parent / ".arforge-worktrees" / "blocked").exists()


def test_corrupt_state_fails_closed_in_workspace_resolution(tmp_path, monkeypatch):
    from arforge.tools import file_tools

    root = _repo(tmp_path)
    state_path = tmp_path / "state.json"
    state_path.write_text("{broken", encoding="utf-8")
    manager = WorktreeManager(state_path)
    _bind_manager(monkeypatch, manager)
    original_workspace = file_tools.WORKSPACE
    file_tools.set_workspace(root)
    try:
        with execution_scope("session-a"), pytest.raises(
            WorktreeError,
            match="unreadable",
        ):
            file_tools.get_workspace()
    finally:
        file_tools.set_workspace(original_workspace)


def test_tampered_ownership_record_cannot_redirect_or_delete(tmp_path):
    root = _repo(tmp_path)
    state_path = tmp_path / "state.json"
    manager = WorktreeManager(state_path)
    created = manager.enter("session-a", root, "owned")
    worktree = Path(created["worktree_path"])
    payload = json.loads(state_path.read_text(encoding="utf-8"))
    payload["sessions"]["session-a"]["worktree_path"] = str(root)
    payload["sessions"]["session-a"]["worktree_branch"] = (
        created["original_branch"] or "master"
    )
    state_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(WorktreeError, match="controlled directory|ownership"):
        manager.active_workspace("session-a")
    with pytest.raises(WorktreeError, match="controlled directory|ownership"):
        manager.exit("session-a", "remove", discard_changes=True)

    assert root.exists()
    assert worktree.exists()
    _git(root, "worktree", "remove", "--force", str(worktree), check=False)
    _git(root, "branch", "-D", created["worktree_branch"], check=False)


def test_remove_is_dangerous_but_keep_is_workspace_command():
    from arforge.core.permission import classify_tool
    from arforge.tools import load_builtin_tools

    load_builtin_tools()
    assert classify_tool("worktree_exit", {"action": "keep"}) == "workspace_cmd"
    assert classify_tool("worktree_exit", {"action": "remove"}) == "dangerous"


def test_session_close_is_blocked_until_managed_worktree_is_exited(tmp_path, monkeypatch):
    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    _bind_manager(monkeypatch, manager)
    runtime = SessionRuntime(lambda _event: None, agent_factory=lambda: object())
    session = runtime.create_session()
    manager.enter(session["session_id"], root, "session-bound")

    with pytest.raises(SessionRuntimeError, match="worktree"):
        runtime.close_session(session["session_id"])

    manager.exit(session["session_id"], "remove")
    assert runtime.close_session(session["session_id"])["status"] == "closed"


def test_bridge_operation_thread_receives_its_session_context():
    from arforge.workspace_context import current_session_id

    observed: list[str] = []

    class ScopeAgent:
        def should_use_multiagent(self, _input: str) -> bool:
            return False

        def chat_stream(self, _input: str):
            observed.append(current_session_id())
            yield {"type": "answer_delta", "data": {"content": "ok"}}
            yield {"type": "done", "data": {}}

    runtime = SessionRuntime(lambda _event: None, agent_factory=ScopeAgent)
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "hello", 10_000)
    runtime.release_operation(operation["operation_id"])

    assert runtime._operations[operation["operation_id"]].finished.wait(2)
    assert observed == [session["session_id"]]


def test_registered_worktree_tools_export_strict_schema(monkeypatch, tmp_path):
    from arforge.tool_registry import REGISTRY
    from arforge.tools import load_builtin_tools
    from arforge.tools import file_tools

    root = _repo(tmp_path)
    manager = WorktreeManager(tmp_path / "state.json")
    _bind_manager(monkeypatch, manager)
    original_workspace = file_tools.WORKSPACE
    file_tools.set_workspace(root)
    try:
        load_builtin_tools()
        enter = REGISTRY.get("worktree_enter")
        status = REGISTRY.get("worktree_status")
        exit_tool = REGISTRY.get("worktree_exit")
        assert enter is not None and enter.schema.category == "workspace_cmd"
        assert status is not None and status.schema.category == "read"
        assert exit_tool is not None and exit_tool.schema.risk_level == "high"
        schema = next(
            item
            for item in REGISTRY.to_openai_tools()
            if item["function"]["name"] == "worktree_exit"
        )
        action = schema["function"]["parameters"]["properties"]["action"]
        assert action["enum"] == ["keep", "remove"]

        with execution_scope("tool-session"):
            created = manager.enter("tool-session", root, "tool")
            payload = json.loads(json.dumps(manager.status("tool-session")))
            assert payload["worktree_path"] == created["worktree_path"]
            manager.exit("tool-session", "remove")
    finally:
        file_tools.set_workspace(original_workspace)
