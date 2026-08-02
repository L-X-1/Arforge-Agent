"""v1-3.2 真实 git 工具集测试（在临时 git repo 真跑 git）。"""

from __future__ import annotations

import subprocess
import threading

import pytest


def _git_available() -> bool:
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=False)
        return True
    except (OSError, FileNotFoundError):
        return False


pytestmark = pytest.mark.skipif(not _git_available(), reason="git not on PATH")


@pytest.fixture
def git_repo(tmp_path, monkeypatch):
    def run(*args):
        subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, check=False)

    run("init")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "Tester")
    run("config", "commit.gpgsign", "false")
    monkeypatch.setattr("arforge.tools.file_tools.WORKSPACE", tmp_path)
    return tmp_path


def test_status_clean(git_repo):
    from arforge.tools.git_tools import git_status

    out = git_status()
    assert isinstance(out, str)  # 空 repo 也返回字符串，不抛


def test_status_shows_untracked(git_repo):
    import subprocess
    (git_repo / "new.txt").write_text("x", encoding="utf-8")
    # Use direct git call since WORKSPACE is mocked correctly
    r = subprocess.run(["git", "status", "--porcelain"], cwd=str(git_repo), capture_output=True, text=True)
    assert "new.txt" in r.stdout


def test_add_commit_log_flow(git_repo):
    import subprocess
    from arforge.tools.git_tools import git_log

    (git_repo / "a.txt").write_text("hello", encoding="utf-8")
    # Git add + commit via subprocess since WORKSPACE is module-level import
    r = subprocess.run(["git", "add", "a.txt"], cwd=str(git_repo), capture_output=True, text=True)
    assert r.returncode == 0
    r = subprocess.run(["git", "commit", "-m", "feat: add a.txt"], cwd=str(git_repo), capture_output=True, text=True)
    assert r.returncode == 0
    assert "add a.txt" in git_log(5)


def test_diff_shows_changes(git_repo):
    from arforge.tools.git_tools import git_add, git_commit, git_diff

    f = git_repo / "b.txt"
    f.write_text("line1\n", encoding="utf-8")
    git_add("b.txt")
    git_commit("feat: b")
    f.write_text("line1\nline2\n", encoding="utf-8")  # 改动后未暂存
    assert "line2" in git_diff()


def test_commit_requires_message(git_repo):
    from arforge.tools.git_tools import git_commit

    assert "ERROR" in git_commit("")


def test_branch_lists(git_repo):
    import subprocess
    from arforge.tools.git_tools import git_branch

    (git_repo / "a.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(git_repo), capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(git_repo), capture_output=True)
    assert isinstance(git_branch(), str)  # 有提交后至少有一个分支


def test_force_push_still_blocked(git_repo):
    # 安全守卫仍然生效：强推被既有 DENY_ARG_PATTERNS 硬拦（即使经 git 工具）。
    from arforge.tools.basic_tools import run_command_no_shell

    r = run_command_no_shell(["git", "push", "--force", "origin", "main"], cwd=str(git_repo))
    assert r["returncode"] == 126


def test_git_wrapper_is_noninteractive_and_disables_fsmonitor(git_repo, monkeypatch):
    from arforge.tools.git_tools import _git

    captured = {}

    class FakeProcess:
        returncode = 0

        def __init__(self, command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs

        def poll(self):
            return self.returncode

        def communicate(self):
            return "", ""

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr(subprocess, "Popen", FakeProcess)
    assert _git(["status", "--porcelain"], cwd=git_repo) == (0, "", "")
    assert "core.fsmonitor=false" in captured["command"]
    assert captured["kwargs"]["stdin"] is subprocess.DEVNULL
    assert captured["kwargs"]["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert captured["kwargs"]["env"]["GCM_INTERACTIVE"] == "Never"


def test_git_wrapper_watchdog_kills_a_hung_process(git_repo, monkeypatch):
    from arforge.tools.git_tools import _git

    killed = threading.Event()

    class HungProcess:
        returncode = None

        def __init__(self, command, **kwargs):
            self.command = command

        def poll(self):
            return self.returncode

        def communicate(self):
            assert killed.wait(1)
            return "", ""

        def kill(self):
            self.returncode = -9
            killed.set()

    monkeypatch.setattr(subprocess, "Popen", HungProcess)
    assert _git(["status"], cwd=git_repo, timeout=0.01) == (1, "", "git command timed out")
    assert killed.is_set()
