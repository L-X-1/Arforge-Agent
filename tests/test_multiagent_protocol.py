"""Test B1: Multi-agent collaboration data model — AgentRole, Task, TaskResult, Conversation.

Verifies:
- Serialization/deserialization round-trips (to_dict / from_dict)
- Task dependency graph (depends_on, topological ordering)
- Conversation pending_tasks() filtering
- SQLite persistence (save_conversation / load_conversation / list_conversations)
- JSON backup fallback
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from arforge.multiagent.protocol import (
    AgentRole,
    Conversation,
    Task,
    TaskResult,
    _ensure_db,
    _get_db_path,
    list_conversations,
    load_conversation,
    save_conversation,
)


# ====================================================================
# AgentRole tests
# ====================================================================


class TestAgentRole:
    def test_default_construction(self):
        role = AgentRole(name="TestAgent", description="A test agent")
        assert role.name == "TestAgent"
        assert role.description == "A test agent"
        assert role.capabilities == []
        assert role.tools == []
        assert role.max_tokens == 4096
        assert role.timeout == 0
        assert role.system_prompt == ""

    def test_full_construction(self):
        role = AgentRole(
            name="CoderAgent",
            description="Writes code",
            capabilities=["safe_modify", "code_search"],
            tools=["read_file", "write_file"],
            max_tokens=8192,
            timeout=120,
            system_prompt="You are a software engineer.",
        )
        assert len(role.capabilities) == 2
        assert "safe_modify" in role.capabilities
        assert len(role.tools) == 2
        assert role.max_tokens == 8192
        assert role.timeout == 120

    def test_to_dict_roundtrip(self):
        role = AgentRole(
            name="ReviewerAgent",
            description="Reviews code",
            capabilities=["code_review", "security_review"],
            tools=["read_file"],
            system_prompt="You are a senior reviewer.",
        )
        d = role.to_dict()
        restored = AgentRole.from_dict(d)
        assert restored.name == role.name
        assert restored.description == role.description
        assert restored.capabilities == role.capabilities
        assert restored.tools == role.tools
        assert restored.system_prompt == role.system_prompt

    def test_from_dict_ignores_extra_keys(self):
        d = {"name": "X", "description": "Y", "extra_field": "ignored"}
        role = AgentRole.from_dict(d)
        assert role.name == "X"
        assert not hasattr(role, "extra_field")

    def test_json_serializable(self):
        role = AgentRole(name="TesterAgent", description="Writes tests", capabilities=["test_generation"])
        encoded = json.dumps(role.to_dict(), ensure_ascii=False)
        decoded = json.loads(encoded)
        assert decoded["name"] == "TesterAgent"
        assert decoded["capabilities"] == ["test_generation"]


# ====================================================================
# Task tests
# ====================================================================


class TestTask:
    def test_auto_task_id(self):
        t = Task(role="CoderAgent", goal="Fix a bug")
        assert t.task_id.startswith("task_")
        assert len(t.task_id) > 8

    def test_explicit_task_id(self):
        t = Task(task_id="my_id", role="X", goal="Y")
        assert t.task_id == "my_id"

    def test_default_values(self):
        t = Task(role="R", goal="G")
        assert t.parent_task_id == ""
        assert t.inputs == {}
        assert t.constraints == []
        assert t.depends_on == []
        assert t.deadline_ms == 0
        assert t.priority == 100

    def test_to_dict_roundtrip(self):
        t = Task(
            task_id="t1",
            role="PlannerAgent",
            goal="Plan architecture",
            inputs={"file": "main.py"},
            constraints=["no file writes"],
            depends_on=["t0"],
            priority=50,
        )
        d = t.to_dict()
        restored = Task.from_dict(d)
        assert restored.task_id == "t1"
        assert restored.role == "PlannerAgent"
        assert restored.goal == "Plan architecture"
        assert restored.inputs == {"file": "main.py"}
        assert restored.constraints == ["no file writes"]
        assert restored.depends_on == ["t0"]
        assert restored.priority == 50

    def test_unique_ids(self):
        t1 = Task(role="A", goal="X")
        t2 = Task(role="B", goal="Y")
        assert t1.task_id != t2.task_id

    def test_json_serializable(self):
        t = Task(task_id="t1", role="R", goal="G", inputs={"key": "value"}, depends_on=["dep1"])
        encoded = json.dumps(t.to_dict(), ensure_ascii=False)
        decoded = json.loads(encoded)
        assert decoded["task_id"] == "t1"
        assert decoded["depends_on"] == ["dep1"]


# ====================================================================
# TaskResult tests
# ====================================================================


class TestTaskResult:
    def test_success_result(self):
        r = TaskResult(
            task_id="t1",
            role="CoderAgent",
            success=True,
            output="Code written",
            artifacts={"file": "/tmp/out.py"},
            elapsed_ms=1500,
            tokens_used=3200,
        )
        assert r.success is True
        assert r.output == "Code written"
        assert r.error == ""
        assert r.elapsed_ms == 1500

    def test_failure_result(self):
        r = TaskResult(
            task_id="t2",
            role="DebuggerAgent",
            success=False,
            error="Could not reproduce",
            elapsed_ms=5000,
        )
        assert r.success is False
        assert r.error == "Could not reproduce"

    def test_to_dict_roundtrip(self):
        r = TaskResult(
            task_id="t3",
            role="TesterAgent",
            success=True,
            output="All tests passed",
            evidence=[{"test": "test_x", "status": "pass"}],
            tool_calls=[{"tool": "run_cmd", "args": {"cmd": "pytest"}}],
            elapsed_ms=3000,
            tokens_used=1500,
        )
        d = r.to_dict()
        restored = TaskResult.from_dict(d)
        assert restored.task_id == "t3"
        assert restored.success is True
        assert len(restored.evidence) == 1
        assert len(restored.tool_calls) == 1

    def test_default_values(self):
        r = TaskResult(task_id="t", role="R", success=True)
        assert r.output == ""
        assert r.artifacts == {}
        assert r.evidence == []
        assert r.tool_calls == []
        assert r.elapsed_ms == 0
        assert r.tokens_used == 0


# ====================================================================
# Conversation tests
# ====================================================================


class TestConversation:
    def test_auto_conversation_id(self):
        c = Conversation(master_goal="Test")
        assert c.conversation_id.startswith("conv_")
        assert len(c.conversation_id) > 8

    def test_default_values(self):
        c = Conversation(master_goal="Goal")
        assert c.tasks == []
        assert c.results == []
        assert c.shared_memory == {}

    def test_result_for_existing(self):
        r = TaskResult(task_id="t1", role="R", success=True, output="ok")
        c = Conversation(
            master_goal="G",
            tasks=[Task(task_id="t1", role="R", goal="G")],
            results=[r],
        )
        assert c.result_for("t1") is r
        assert c.result_for("t2") is None

    def test_pending_tasks_all_pending(self):
        c = Conversation(
            master_goal="G",
            tasks=[
                Task(task_id="t1", role="A", goal="Step 1"),
                Task(task_id="t2", role="B", goal="Step 2"),
            ],
        )
        pending = c.pending_tasks()
        assert len(pending) == 2

    def test_pending_tasks_some_done(self):
        c = Conversation(
            master_goal="G",
            tasks=[
                Task(task_id="t1", role="A", goal="Step 1"),
                Task(task_id="t2", role="B", goal="Step 2"),
            ],
            results=[TaskResult(task_id="t1", role="A", success=True)],
        )
        pending = c.pending_tasks()
        assert len(pending) == 1
        assert pending[0].task_id == "t2"

    def test_pending_tasks_dependency_blocked(self):
        c = Conversation(
            master_goal="G",
            tasks=[
                Task(task_id="t1", role="A", goal="Step 1"),
                Task(task_id="t2", role="B", goal="Step 2", depends_on=["t1"]),
            ],
        )
        pending = c.pending_tasks()
        # Only t1 should be pending since t2 depends on t1 (not yet done)
        assert len(pending) == 1
        assert pending[0].task_id == "t1"

    def test_pending_tasks_dependency_satisfied(self):
        c = Conversation(
            master_goal="G",
            tasks=[
                Task(task_id="t1", role="A", goal="Step 1"),
                Task(task_id="t2", role="B", goal="Step 2", depends_on=["t1"]),
            ],
            results=[TaskResult(task_id="t1", role="A", success=True)],
        )
        pending = c.pending_tasks()
        assert len(pending) == 1
        assert pending[0].task_id == "t2"

    def test_dependency_graph(self):
        c = Conversation(
            master_goal="Pipeline",
            tasks=[
                Task(task_id="t1", role="A", goal="S1"),
                Task(task_id="t2", role="B", goal="S2", depends_on=["t1"]),
                Task(task_id="t3", role="C", goal="S3", depends_on=["t1", "t2"]),
            ],
        )
        g = c.dependency_graph()
        assert "t1" in g
        assert "t2" in g
        assert "t3" in g
        assert "t2" in g["t1"]  # t2 depends on t1
        assert "t3" in g["t2"]  # t3 depends on t2

    def test_to_dict_roundtrip(self):
        c = Conversation(
            master_goal="Fix bug and test",
            tasks=[
                Task(task_id="t1", role="CoderAgent", goal="Fix", depends_on=[]),
                Task(task_id="t2", role="TesterAgent", goal="Test", depends_on=["t1"]),
            ],
            results=[TaskResult(task_id="t1", role="CoderAgent", success=True, output="Fixed")],
            shared_memory={"bug_type": "null-pointer"},
        )
        d = c.to_dict()
        restored = Conversation.from_dict(d)
        assert restored.conversation_id == c.conversation_id
        assert restored.master_goal == "Fix bug and test"
        assert len(restored.tasks) == 2
        assert len(restored.results) == 1
        assert restored.shared_memory["bug_type"] == "null-pointer"

    def test_json_roundtrip(self):
        c = Conversation(
            master_goal="Test JSON",
            tasks=[Task(task_id="t1", role="R", goal="G")],
        )
        encoded = json.dumps(c.to_dict(), ensure_ascii=False)
        decoded = json.loads(encoded)
        restored = Conversation.from_dict(decoded)
        assert restored.master_goal == "Test JSON"
        assert restored.tasks[0].task_id == "t1"


# ====================================================================
# Persistence tests
# ====================================================================


class TestPersistence:
    @pytest.fixture(autouse=True)
    def setup_teardown(self):
        """隔离的 SQLite 测试数据库，不影响真实 PG 数据库."""
        from arforge.database.engine import dispose_engines
        dispose_engines()

        self._tmpdir = tempfile.mkdtemp(prefix="arforge_test_multiagent_")
        self._orig_home = os.environ.get("ARFORGE_HOME")
        self._orig_ma_url = os.environ.get("ARFORGE_MULTIAGENT_DB_URL")
        os.environ["ARFORGE_HOME"] = self._tmpdir
        # 强制用 SQLite 隔离测试
        os.environ["ARFORGE_MULTIAGENT_DB_URL"] = f"sqlite:///{self._tmpdir}/multiagent.db"
        yield
        if self._orig_home is not None:
            os.environ["ARFORGE_HOME"] = self._orig_home
        else:
            os.environ.pop("ARFORGE_HOME", None)
        if self._orig_ma_url is not None:
            os.environ["ARFORGE_MULTIAGENT_DB_URL"] = self._orig_ma_url
        else:
            os.environ.pop("ARFORGE_MULTIAGENT_DB_URL", None)
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        dispose_engines()

    def test_db_path_uses_env(self):
        path = _get_db_path()
        assert self._tmpdir in str(path)
        assert path.name == "multiagent.db"

    def test_ensure_db_creates_tables(self):
        _ensure_db()
        from arforge.database import get_ma_engine
        from sqlalchemy import inspect as sa_inspect
        insp = sa_inspect(get_ma_engine())
        table_names = insp.get_table_names()
        assert "multiagent_tasks" in table_names
        assert "multiagent_conversations" in table_names

    def test_save_and_load_conversation(self):
        c = Conversation(
            master_goal="Save/Load test",
            tasks=[
                Task(task_id="t1", role="CoderAgent", goal="Write code"),
                Task(task_id="t2", role="ReviewerAgent", goal="Review", depends_on=["t1"]),
            ],
            results=[
                TaskResult(task_id="t1", role="CoderAgent", success=True, output="print('hello')"),
            ],
        )
        save_conversation(c)

        loaded = load_conversation(c.conversation_id)
        assert loaded is not None
        assert loaded.master_goal == "Save/Load test"
        assert len(loaded.tasks) == 2
        assert len(loaded.results) == 1
        assert loaded.results[0].output == "print('hello')"

    def test_load_nonexistent_conversation(self):
        result = load_conversation("nonexistent_id")
        assert result is None

    def test_list_conversations(self):
        c1 = Conversation(master_goal="First")
        c2 = Conversation(master_goal="Second")
        save_conversation(c1)
        save_conversation(c2)

        convs = list_conversations(limit=10)
        assert len(convs) >= 2
        goals = {c["master_goal"] for c in convs}
        assert "First" in goals
        assert "Second" in goals

    def test_save_updates_existing(self):
        c = Conversation(master_goal="Original", tasks=[Task(task_id="t1", role="R", goal="G")])
        save_conversation(c)

        # Add a result and save again
        c.results.append(TaskResult(task_id="t1", role="R", success=True, output="Done"))
        save_conversation(c)

        loaded = load_conversation(c.conversation_id)
        assert loaded is not None
        assert len(loaded.results) == 1
        assert loaded.results[0].output == "Done"

    def test_json_backup_written(self):
        c = Conversation(master_goal="JSON backup test")
        save_conversation(c)

        json_path = Path(self._tmpdir) / "conversations" / f"{c.conversation_id}.json"
        assert json_path.exists()

        content = json.loads(json_path.read_text(encoding="utf-8"))
        assert content["master_goal"] == "JSON backup test"

    def test_load_from_json_fallback(self):
        c = Conversation(master_goal="JSON only", tasks=[Task(task_id="tx", role="R", goal="G")])
        # Write JSON directly without database
        json_dir = Path(self._tmpdir) / "conversations"
        json_dir.mkdir(parents=True, exist_ok=True)
        json_path = json_dir / f"{c.conversation_id}.json"
        json_path.write_text(json.dumps(c.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

        # Clear database rows — use SQLAlchemy
        from arforge.database import MultiagentConversation, MultiagentTask, get_ma_session, init_ma_db
        init_ma_db()
        with get_ma_session() as session:
            session.query(MultiagentTask).filter(
                MultiagentTask.conversation_id == c.conversation_id
            ).delete()
            session.query(MultiagentConversation).filter(
                MultiagentConversation.conversation_id == c.conversation_id
            ).delete()

        loaded = load_conversation(c.conversation_id)
        assert loaded is not None
        assert loaded.master_goal == "JSON only"
        assert len(loaded.tasks) == 1
