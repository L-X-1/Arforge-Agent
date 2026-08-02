"""Global test isolation for persistence-backed features."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_database(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Never let the unit suite touch an operator's configured data stores."""
    monkeypatch.setenv("ARFORGE_DB_URL", "sqlite:///:memory:")
    monkeypatch.setenv("ARFORGE_MULTIAGENT_DB_URL", "sqlite:///:memory:")
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / ".arforge"))

    from arforge.database.engine import dispose_engines

    dispose_engines()
    # Hook 总线隔离：每个测试从干净的全局管理器开始，避免 hook 注册跨测试泄漏。
    from arforge.core.hooks import reset_hook_manager

    reset_hook_manager()
    yield
    dispose_engines()
    reset_hook_manager()


@pytest.fixture(autouse=True)
def isolated_tool_workspace():
    """Restore the process-default tool workspace after every test.

    Production desktop operations bind a workspace through ``execution_scope``.
    A few direct tool tests intentionally exercise ``set_workspace`` instead;
    without restoring it they can make later tests depend on collection order.
    """
    from arforge.tools import file_tools
    from arforge.workspace_context import set_workspace_override
    from arforge.worktree_runtime import reset_worktree_managers

    previous = file_tools.WORKSPACE
    set_workspace_override(None)
    reset_worktree_managers()
    try:
        yield
    finally:
        set_workspace_override(None)
        reset_worktree_managers()
        file_tools.set_workspace(previous)
