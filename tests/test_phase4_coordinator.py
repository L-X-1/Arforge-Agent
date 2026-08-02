"""Tests for CoordinatorAgent and worker role contracts (Phase 4 / WP-14)."""

import pytest
from arforge.core.agent_run import RunState
from arforge.core.coordinator import (
    CoordinatorAgent,
    WORKER_ROLES,
    get_role,
    list_roles,
)


class TestWorkerRoles:
    """WP-14: Role contracts and capabilities."""

    def test_all_roles_have_required_fields(self):
        for role_id, role in WORKER_ROLES.items():
            assert role.role_id == role_id
            assert role.display_name
            assert role.description
            assert len(role.tools) > 0
            assert len(role.capabilities) > 0

    def test_get_role_existing(self):
        explorer = get_role("explorer")
        assert explorer is not None
        assert explorer.role_id == "explorer"
        assert explorer.read_only is True

    def test_get_role_missing(self):
        assert get_role("nonexistent") is None

    def test_list_roles(self):
        roles = list_roles()
        assert len(roles) == 5
        role_ids = {r.role_id for r in roles}
        assert role_ids == {"explorer", "planner", "implementer", "reviewer", "tester"}

    def test_explorer_is_readonly(self):
        explorer = get_role("explorer")
        assert explorer.read_only is True
        assert "edit_file" not in explorer.tools
        assert "write_file" not in explorer.tools

    def test_implementer_can_write(self):
        impl = get_role("implementer")
        assert impl.read_only is False
        assert "edit_file" in impl.tools
        assert "write_file" in impl.tools

    def test_role_max_steps(self):
        """Each role has a sensible max_steps budget."""
        for role in WORKER_ROLES.values():
            assert 5 <= role.max_steps <= 30, f"{role.role_id}: max_steps={role.max_steps} out of range"

    def test_immutable_role(self):
        explorer = get_role("explorer")
        with pytest.raises(Exception):
            explorer._replace(role_id="hacked")  # type: ignore


class TestCoordinatorCreation:
    """CoordinatorAgent initialization."""

    def test_default_creation(self):
        c = CoordinatorAgent()
        assert not c.force_single
        assert not c.force_multi
        assert c.max_iterations == 3
        assert c.file_tracker is not None

    def test_force_single(self):
        c = CoordinatorAgent(force_single=True)
        assert not c._should_use_multi("refactor the entire multi-file authentication system")
        # Actually, force_single=True should make _should_use_multi return False
        assert c.force_single is True

    def test_force_multi(self):
        c = CoordinatorAgent(force_multi=True)
        assert c._should_use_multi("hello")
        assert c.force_multi is True

    def test_short_input_is_single(self):
        c = CoordinatorAgent()
        assert not c._should_use_multi("fix a typo")
        assert not c._should_use_multi("add a comment")

    def test_long_input_is_multi(self):
        c = CoordinatorAgent()
        long_task = "refactor the entire authentication module to support OAuth2 with multi-file changes across the codebase"
        assert c._should_use_multi(long_task)

    def test_complexity_markers_trigger_multi(self):
        c = CoordinatorAgent()
        assert c._should_use_multi("refactor the login flow")
        assert c._should_use_multi("migrate database schema")
        assert c._should_use_multi("restructure the project layout")

    def test_file_tracker_available(self):
        c = CoordinatorAgent()
        stats = c.file_stats()
        assert isinstance(stats, dict)
        assert "files_tracked" in stats

    def test_spawn_worker_missing_role(self):
        c = CoordinatorAgent()
        result = c.spawn_worker("nonexistent", "do something")
        assert result is None


class TestCoordinatorOutcomeMapping:
    class StubMaster:
        def __init__(self, payload):
            self.payload = payload
            self.max_iterations = 0

        def handle(self, _user_input):
            return self.payload

    @pytest.mark.parametrize(
        ("payload", "expected_state", "expected_error"),
        [
            (
                {"answer": "done", "success": True, "conversation_id": "ok-1"},
                RunState.COMPLETED,
                None,
            ),
            (
                {"answer": "partial", "success": False, "failed_count": 0, "conversation_id": "partial-1"},
                RunState.INCOMPLETE,
                "multi-agent run stopped before all delegated tasks completed",
            ),
            (
                {"answer": "failed", "success": False, "failed_count": 2, "conversation_id": "failed-1"},
                RunState.FAILED,
                "2 delegated task(s) failed",
            ),
            (
                {"answer": "cancelled", "cancelled": True, "cancel_reason": "user request", "conversation_id": "cancel-1"},
                RunState.INTERRUPTED,
                "user request",
            ),
        ],
    )
    def test_multiagent_outcome_is_not_reported_as_false_success(
        self, payload, expected_state, expected_error
    ):
        coordinator = CoordinatorAgent(force_multi=True)
        coordinator._master_agent = self.StubMaster(payload)

        result = coordinator.execute("perform a coordinated task")

        assert result.state is expected_state
        assert result.error == expected_error
        if expected_state is RunState.INCOMPLETE:
            assert result.incomplete_report == {
                "stop_reason": "multiagent_incomplete",
                "iterations": 0,
                "task_count": 0,
            }
        else:
            assert result.incomplete_report is None
