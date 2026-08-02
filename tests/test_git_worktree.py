from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import arforge.product.service as service_module
from arforge.bridge import dispatch
from arforge.product.service import ProductService


def _completed(args: list[str], *, stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["git", *args], returncode, stdout=stdout, stderr=stderr)


def _git_for(root: Path, calls: list[list[str]], *, dirty: bool = False):
    def fake(args: list[str], _cwd: Path, *, allow_error: bool = False) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args == ["rev-parse", "--show-toplevel"]:
            return _completed(args, stdout=f"{root}\n")
        if args == ["branch", "--show-current"]:
            return _completed(args, stdout="main\n")
        if args[:2] == ["for-each-ref", "--format=%(refname:short)"]:
            return _completed(args, stdout="main\n")
        if args == ["status", "--porcelain=v1"]:
            return _completed(args, stdout=" M app.py\n" if dirty else "")
        if args[:2] == ["worktree", "add"]:
            return _completed(args)
        raise AssertionError(f"unexpected git call: {args}")

    return fake


def test_worktree_creation_uses_controlled_sibling_path_and_new_branch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "repo"
    root.mkdir()
    calls: list[list[str]] = []
    monkeypatch.setattr(service_module, "_git", _git_for(root, calls))

    result = ProductService().git_worktree_create({"branch": "feature/demo"})

    expected = root.parent / ".arforge-worktrees" / "feature-demo"
    assert result == {"root": str(expected), "branch": "feature/demo", "name": "feature-demo", "created": True}
    assert ["worktree", "add", "-b", "feature/demo", str(expected)] in calls


def test_worktree_creation_requires_a_clean_repository(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "repo"
    root.mkdir()
    calls: list[list[str]] = []
    monkeypatch.setattr(service_module, "_git", _git_for(root, calls, dirty=True))

    with pytest.raises(ValueError, match="commit or stash"):
        ProductService().git_worktree_create({"branch": "feature/demo"})

    assert not any(call[:2] == ["worktree", "add"] for call in calls)


def test_bridge_exposes_worktree_creation_with_strict_parameters(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "repo"
    root.mkdir()
    monkeypatch.setattr(service_module, "_git", _git_for(root, []))

    response = dispatch(
        {
            "version": "1.2",
            "method": "git.worktree.create",
            "params": {"branch": "feature/demo", "name": "demo"},
        },
        service=ProductService(),
    )

    assert response["ok"] is True
    assert response["data"]["name"] == "demo"


def test_worktree_removal_returns_primary_root_and_uses_managed_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    root = tmp_path / "repo"
    target = tmp_path / ".arforge-worktrees" / "feature-demo"
    root.mkdir()
    target.mkdir(parents=True)
    calls: list[tuple[list[str], Path]] = []

    def fake(args: list[str], cwd: Path, *, allow_error: bool = False):
        calls.append((args, cwd))
        if args == ["rev-parse", "--show-toplevel"]:
            return _completed(args, stdout=f"{target if cwd == target else root}\n")
        if args == ["branch", "--show-current"]:
            return _completed(args, stdout="feature/demo\n")
        if args[:2] == ["for-each-ref", "--format=%(refname:short)"]:
            return _completed(args, stdout="feature/demo\n")
        if args == ["status", "--porcelain=v1"]:
            return _completed(args)
        if args == ["rev-parse", "--path-format=absolute", "--git-common-dir"]:
            return _completed(args, stdout=f"{root / '.git'}\n")
        if args == ["worktree", "remove", str(target)]:
            return _completed(args)
        raise AssertionError(f"unexpected git call: {args}")

    monkeypatch.setattr(service_module, "_git", fake)
    monkeypatch.chdir(target)

    service = ProductService()
    plan = service.git_worktree_prepare_remove({})
    monkeypatch.chdir(root)
    result = service.git_worktree_remove({"root": str(target)})

    assert plan == {
        "root": str(root),
        "removed_root": str(target),
        "branch": "feature/demo",
        "ready": True,
    }
    assert result == {
        "root": str(root),
        "removed_root": str(target),
        "branch": "feature/demo",
        "removed": True,
    }
    assert (["worktree", "remove", str(target)], root) in calls


def test_worktree_removal_refuses_primary_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    root = tmp_path / "repo"
    root.mkdir()
    calls: list[list[str]] = []

    def fake(args: list[str], _cwd: Path, *, allow_error: bool = False):
        calls.append(args)
        if args == ["rev-parse", "--show-toplevel"]:
            return _completed(args, stdout=f"{root}\n")
        if args == ["branch", "--show-current"]:
            return _completed(args, stdout="main\n")
        if args[:2] == ["for-each-ref", "--format=%(refname:short)"]:
            return _completed(args, stdout="main\n")
        if args == ["status", "--porcelain=v1"]:
            return _completed(args)
        if args == ["rev-parse", "--path-format=absolute", "--git-common-dir"]:
            return _completed(args, stdout=f"{root / '.git'}\n")
        raise AssertionError(f"unexpected git call: {args}")

    monkeypatch.setattr(service_module, "_git", fake)

    with pytest.raises(ValueError, match="primary worktree"):
        ProductService().git_worktree_prepare_remove({})

    assert not any(call[:2] == ["worktree", "remove"] for call in calls)
