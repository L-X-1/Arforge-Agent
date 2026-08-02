from __future__ import annotations

import io
import json
import shutil
import subprocess

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from arforge.bridge import dispatch, serve
from arforge.database.base import Base


@pytest.fixture
def isolated_learning_db(monkeypatch, tmp_path):
    db_url = f"sqlite:///{tmp_path / 'learning_status.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", db_url)

    engine = create_engine(db_url)
    Base.metadata.create_all(bind=engine)

    from arforge.database.engine import dispose_engines

    dispose_engines()
    monkeypatch.setattr("arforge.database.engine._engine", engine)
    monkeypatch.setattr(
        "arforge.database.engine._SessionLocal",
        sessionmaker(bind=engine, expire_on_commit=False),
    )

    import arforge.learning_system as learning_module

    previous_learning = learning_module._LEARNING
    learning_module._LEARNING = None
    yield
    learning_module._LEARNING = previous_learning
    dispose_engines()
    Base.metadata.drop_all(bind=engine)


def test_protocol_describe_is_versioned_and_read_only():
    response = dispatch({"id": "one", "method": "protocol.describe"})
    assert response["ok"] is True
    assert response["id"] == "one"
    assert response["data"]["version"] == "1.0"
    assert response["data"]["mutating_methods"] == []
    assert "tools.list" in response["data"]["methods"]
    assert "capabilities.list" in response["data"]["methods"]
    assert "git.status" in response["data"]["methods"]
    assert "git.diff" in response["data"]["methods"]
    assert "runtime.stats" in response["data"]["methods"]
    assert "runtime.metrics" in response["data"]["methods"]
    assert "learning.status" in response["data"]["methods"]
    assert "release.remediation_plan" in response["data"]["methods"]
    assert "multimodal.diagnose" in response["data"]["methods"]
    assert "skills.list" in response["data"]["methods"]
    assert "customizations.list" in response["data"]["methods"]
    assert "permissions.rules" in response["data"]["methods"]


def test_health_returns_canonical_brand_and_version():
    response = dispatch({"id": 2, "method": "health"})
    assert response["ok"] is True
    assert response["data"]["brand"] == "Arforge Agent"
    assert response["data"]["version"] == __import__("arforge").__version__


def test_workspace_returns_the_canonical_process_root(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    response = dispatch({"id": 20, "method": "workspace.get"})

    assert response["ok"] is True
    assert response["data"] == {"root": str(tmp_path.resolve()), "exists": True, "writable": True}


def test_git_status_reports_non_git_workspaces(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    response = dispatch({"id": 21, "method": "git.status"})

    assert response["ok"] is True
    assert response["data"]["available"] is False
    assert response["data"]["branches"] == []
    assert response["data"]["issue"] == "workspace is not a git repository"


def test_git_status_reports_current_branch(monkeypatch, tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git executable is not available")
    subprocess.run(["git", "init", "-b", "main"], cwd=tmp_path, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    monkeypatch.chdir(tmp_path)

    response = dispatch({"id": 22, "method": "git.status"})

    assert response["ok"] is True
    assert response["data"]["available"] is True
    assert response["data"]["current_branch"] == "main"
    assert response["data"]["branches"] == [{"name": "main", "is_current": True}]


def test_git_diff_reports_tracked_and_untracked_worktree_changes(monkeypatch, tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git executable is not available")
    subprocess.run(["git", "init", "-b", "main"], cwd=tmp_path, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "config", "user.email", "test@arforge.local"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Arforge Test"], cwd=tmp_path, check=True)
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=tmp_path, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    tracked.write_text("before\nafter\n", encoding="utf-8")
    (tmp_path / "new.txt").write_text("untracked\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    response = dispatch({"id": 23, "method": "git.diff", "params": {"max_chars": 10_000}})

    assert response["ok"] is True
    data = response["data"]
    assert data["available"] is True
    assert data["branch"] == "main"
    assert "diff --git a/tracked.txt b/tracked.txt" in data["patch"]
    assert "diff --git a/new.txt b/new.txt" in data["patch"]
    assert "+untracked" in data["patch"]
    assert {item["path"] for item in data["files"]} == {"tracked.txt", "new.txt"}
    assert next(item for item in data["files"] if item["path"] == "tracked.txt")["additions"] == 1
    assert next(item for item in data["files"] if item["path"] == "new.txt")["untracked"] is True
    assert next(item for item in data["files"] if item["path"] == "new.txt")["additions"] == 1


def test_unknown_method_has_stable_error_contract():
    response = dispatch({"id": 3, "method": "does.not.exist"})
    assert response["error"]["code"] == "METHOD_NOT_FOUND"
    assert response["id"] == 3


def test_jsonl_transport_accepts_a_utf8_bom_on_the_first_record():
    source = io.StringIO('\ufeff{"id":"bom","version":"1.2","method":"health"}\n')
    output = io.StringIO()

    assert serve(source, output) == 0
    response = json.loads(output.getvalue())
    assert response["id"] == "bom"
    assert response["ok"] is True


def test_capability_bridge_mode_excludes_legacy_product_state(monkeypatch, tmp_path):
    home = tmp_path / "profile"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("ARFORGE_BRIDGE_MODE", "capability")
    monkeypatch.setenv("ARFORGE_HOME", str(home))
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(workspace))
    monkeypatch.chdir(workspace)
    source = io.StringIO(
        "\n".join(
            [
                '{"protocol":"arforge.bridge","version":"1.2","id":"describe","method":"protocol.describe","params":{}}',
                '{"protocol":"arforge.bridge","version":"1.2","id":"health","method":"health","params":{}}',
                '{"protocol":"arforge.bridge","version":"1.2","id":"legacy","method":"session.create","params":{"title":"no"}}',
            ]
        )
        + "\n"
    )
    output = io.StringIO()

    assert serve(source, output) == 0
    described, health, legacy = [json.loads(line) for line in output.getvalue().splitlines()]
    assert health["ok"] is True
    assert "session.create" not in described["data"]["methods"]
    assert "goal.create" not in described["data"]["methods"]
    assert "skills.enable" in described["data"]["methods"]
    assert legacy["ok"] is False
    assert legacy["error"]["code"] == "METHOD_NOT_ALLOWED"
    assert not list(home.rglob("*.db"))
    assert not list(home.rglob("*.sqlite3"))
    assert not (home / "state" / "sidecar.lock").exists()


def test_capability_bridge_reports_profile_contention(monkeypatch, tmp_path):
    from arforge.database.sqlite_runtime import ProfileWriterLock
    from arforge.skills import _skills_state_lock_path

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    request = {
        "protocol": "arforge.bridge",
        "version": "1.2",
        "id": "busy",
        "method": "skills.disable",
        "params": {"skill_id": "openspec"},
    }
    with ProfileWriterLock(_skills_state_lock_path()):
        response = dispatch(request, capability_only=True)

    assert response["ok"] is False
    assert response["error"] == {
        "code": "PROFILE_BUSY",
        "message": "another Arforge process is updating the private profile",
    }


def test_invalid_params_are_rejected():
    response = dispatch({"id": 4, "method": "health", "params": []})
    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_PARAMS"

    unexpected = dispatch({"id": 4, "method": "health", "params": {"extra": True}})
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_config_is_structured_and_never_exposes_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "top-secret-key")
    monkeypatch.setenv("ARFORGE_DB_URL", "postgresql://admin:db-secret@localhost:5432/arforge")
    response = dispatch({"id": 5, "method": "config.get"})
    rendered = json.dumps(response)
    database_rendered = json.dumps(response["data"]["database"])
    assert response["data"]["api_key_configured"] is True
    assert response["data"]["provider"] == "deepseek"
    assert response["data"]["key_source"] == "env"
    assert response["data"]["configuration_authority"] == "model_config_runtime"
    assert response["data"]["database"]["configured"] is True
    assert "admin" not in database_rendered
    assert "db-secret" not in database_rendered
    assert "top-secret-key" not in rendered


def test_runtime_stats_are_structured_and_read_only(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    response = dispatch({"id": 23, "method": "runtime.stats"})

    assert response["ok"] is True
    assert response["data"]["degraded"] is False
    assert response["data"]["issues"] == {"tokens": None, "dogfood": None}
    assert response["data"]["tokens"]["calls"] == 0
    assert response["data"]["tokens"]["total_tokens"] == 0
    assert response["data"]["dogfood"]["total"] == 0
    assert set(response["data"]) == {"tokens", "dogfood", "degraded", "issues"}


def test_self_correct_eval_is_structured_and_read_only(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

    described = dispatch({"id": 24, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 25, "version": "1.1", "method": "self_correct.eval"})
    rejected = dispatch({"id": 26, "version": "1.1", "method": "self_correct.eval", "params": {"limit": 1}})

    assert "self_correct.eval" in described["data"]["methods"]
    assert "self_correct.eval" not in described["data"]["mutating_methods"]
    assert "self_correct.eval" not in described["data"]["workspace_mutating_methods"]
    assert response["ok"] is True
    assert response["data"]["schema_version"] == 1
    assert response["data"]["suite"] == "self_correct"
    # sc5, sc6, sc7 added in self-correction hardening
    assert response["data"]["passed"] == response["data"]["total"] >= 4
    task_ids = {case["task_id"] for case in response["data"]["cases"]}
    assert task_ids >= {
        "sc1-failure-feedback",
        "sc2-repeat-call-block",
        "sc3-syntax-reflection",
        "sc4-tool-message-order",
    }
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "INVALID_PARAMS"


def test_runtime_metrics_accepts_dashboard_params(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    response = dispatch(
        {
            "id": 24,
            "method": "runtime.metrics",
            "params": {"window_hours": 12, "bucket": "day", "limit": 20},
        }
    )

    assert response["ok"] is True
    assert response["data"]["window"]["hours"] == 12
    assert response["data"]["window"]["bucket"] == "day"
    assert set(response["data"]) == {
        "window",
        "tokens",
        "dogfood",
        "by_model",
        "series",
        "alerts",
        "degraded",
        "issues",
    }
    assert response["data"]["tokens"]["estimated_cost_cny"] is None
    assert response["data"]["tokens"]["cost_status"] == "unavailable"


def test_runtime_metrics_rejects_unexpected_params():
    response = dispatch({"id": 25, "method": "runtime.metrics", "params": {"leak": True}})

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_PARAMS"


def test_learning_status_is_structured_read_only_bridge_method(isolated_learning_db):
    from arforge.learning_system import Outcome, get_learning_system

    learning = get_learning_system()
    row_id = learning.record_outcome(Outcome(
        user_input="fix failing import",
        model_answer="use absolute import",
        success=True,
        tags=["imports"],
        injected_context_size=42,
    ))
    pattern_id = learning.add_pattern(
        "fix",
        "When imports fail, inspect package root before editing.",
        tags=["imports"],
        confidence=0.83,
    )

    described = dispatch({"id": 25, "method": "protocol.describe"})
    response = dispatch({"id": 26, "method": "learning.status"})
    rejected = dispatch({"id": 27, "method": "learning.status", "params": {"limit": 5}})

    assert "learning.status" in described["data"]["methods"]
    assert "learning.status" not in described["data"]["mutating_methods"]
    assert response["ok"] is True
    assert response["data"]["degraded"] is False
    assert response["data"]["stats"]["total_turns"] == 1
    assert response["data"]["recent_learnings"][0]["id"] == row_id
    assert response["data"]["recent_learnings"][0]["injected"] is True
    assert response["data"]["patterns"][0]["id"] == pattern_id
    assert response["data"]["patterns"][0]["confidence"] == 0.83
    assert response["data"]["injection"]["participates"] is True
    assert response["data"]["injection"]["impact"]["status"] == "insufficient_data"
    assert response["data"]["injection"]["impact"]["injected_turns"] == 1
    assert response["data"]["injection"]["impact"]["baseline_turns"] == 0
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "INVALID_PARAMS"


def test_learning_status_reports_injection_impact_observation(isolated_learning_db):
    from arforge.learning_system import Outcome, get_learning_system

    learning = get_learning_system()
    for index in range(3):
        learning.record_outcome(Outcome(
            user_input=f"injected success {index}",
            model_answer="ok",
            success=True,
            injected_context_size=50,
        ))
    for index in range(3):
        learning.record_outcome(Outcome(
            user_input=f"baseline failure {index}",
            model_answer="bad",
            success=False,
            injected_context_size=0,
        ))

    response = dispatch({"id": 27, "method": "learning.status"})
    impact = response["data"]["injection"]["impact"]

    assert response["ok"] is True
    assert impact == {
        "status": "measured",
        "min_sample": 3,
        "injected_turns": 3,
        "injected_successes": 3,
        "injected_success_rate": 1.0,
        "baseline_turns": 3,
        "baseline_successes": 0,
        "baseline_success_rate": 0.0,
        "uplift": 1.0,
    }


def test_memory_status_and_delete_are_structured_bridge_methods(isolated_learning_db):
    from arforge.memory import query_memories, save_memory_v2

    memory_id = save_memory_v2(
        "prefer black formatting",
        mem_type="preference",
        tags="python,formatting",
        importance=4,
        source="user",
    )

    described = dispatch({"id": 35, "version": "1.1", "method": "protocol.describe"})
    status = dispatch({"id": 36, "method": "memory.status"})
    deleted = dispatch(
        {"id": 37, "version": "1.1", "method": "memory.delete", "params": {"memory_id": memory_id}}
    )
    missing = dispatch(
        {"id": 38, "version": "1.1", "method": "memory.delete", "params": {"memory_id": memory_id}}
    )
    invalid = dispatch(
        {"id": 39, "version": "1.1", "method": "memory.delete", "params": {"memory_id": "nope"}}
    )
    unexpected = dispatch(
        {"id": 40, "version": "1.1", "method": "memory.delete", "params": {"memory_id": memory_id, "force": True}}
    )

    assert "memory.status" in described["data"]["methods"]
    assert "memory.status" not in described["data"]["mutating_methods"]
    assert "memory.delete" in described["data"]["methods"]
    assert "memory.delete" in described["data"]["mutating_methods"]
    assert "memory.delete" in described["data"]["stateful_methods"]
    assert "memory.delete" not in described["data"]["workspace_mutating_methods"]
    assert status["ok"] is True
    assert status["data"]["degraded"] is False
    assert status["data"]["stats"] == {"count": 1, "important": 1}
    assert status["data"]["items"][0]["id"] == memory_id
    assert status["data"]["items"][0]["content"] == "prefer black formatting"
    assert deleted["ok"] is True
    assert deleted["data"] == {
        "schema_version": 1,
        "memory_id": memory_id,
        "deleted": True,
        "status": "deleted",
    }
    assert all(item["id"] != memory_id for item in query_memories(limit=20))
    assert missing["ok"] is True
    assert missing["data"]["status"] == "not_found"
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_memory_search_is_read_only_and_filterable(isolated_learning_db):
    from arforge.memory import save_memory_v2

    keep_id = save_memory_v2(
        "prefer black formatting for python files",
        mem_type="preference",
        tags="python,formatting",
        importance=4,
        source="user",
    )
    save_memory_v2(
        "use pnpm for frontend packages",
        mem_type="convention",
        tags="frontend,packages",
        importance=2,
        source="imported",
    )

    described = dispatch({"id": 41, "version": "1.1", "method": "protocol.describe"})
    searched = dispatch(
        {
            "id": 42,
            "version": "1.1",
            "method": "memory.search",
            "params": {
                "query": "black",
                "mem_type": "preference",
                "tag": "python",
                "source": "user",
                "importance_min": 3,
                "limit": 5,
            },
        }
    )
    invalid = dispatch(
        {"id": 43, "version": "1.1", "method": "memory.search", "params": {"importance_min": 8}}
    )
    unexpected = dispatch(
        {"id": 44, "version": "1.1", "method": "memory.search", "params": {"project": "demo"}}
    )

    assert "memory.search" in described["data"]["methods"]
    assert "memory.search" not in described["data"]["mutating_methods"]
    assert searched["ok"] is True
    assert searched["data"]["filters"] == {
        "query": "black",
        "mem_type": "preference",
        "tag": "python",
        "source": "user",
        "project_id": "",
        "workspace_path": "",
        "importance_min": 3,
        "limit": 5,
    }
    assert [item["id"] for item in searched["data"]["items"]] == [keep_id]
    assert searched["data"]["items"][0]["source"] == "user"
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_memory_project_scope_filters_and_dedupe_are_isolated(isolated_learning_db):
    from arforge.memory import query_memories, save_memory_v2

    alpha_id = save_memory_v2(
        "use ruff for this repository",
        mem_type="convention",
        tags="python,lint",
        importance=4,
        source="user",
        project_id="project-alpha",
        workspace_path="C:/work/alpha",
    )
    beta_id = save_memory_v2(
        "use ruff for this repository",
        mem_type="convention",
        tags="python,lint",
        importance=4,
        source="user",
        project_id="project-beta",
        workspace_path="C:/work/beta",
    )
    duplicate_alpha_id = save_memory_v2(
        "use ruff for this repository",
        mem_type="convention",
        tags="python,lint",
        importance=4,
        source="user",
        project_id="project-alpha",
        workspace_path="C:/work/alpha",
    )

    searched = dispatch(
        {
            "id": 45,
            "version": "1.1",
            "method": "memory.search",
            "params": {
                "query": "ruff",
                "project_id": "project-alpha",
                "workspace_path": "C:/work/alpha",
                "limit": 10,
            },
        }
    )

    assert alpha_id is not None
    assert beta_id is not None
    assert alpha_id != beta_id
    assert duplicate_alpha_id == alpha_id
    assert searched["ok"] is True
    assert searched["data"]["filters"]["project_id"] == "project-alpha"
    assert searched["data"]["filters"]["workspace_path"] == "C:/work/alpha"
    assert [item["id"] for item in searched["data"]["items"]] == [alpha_id]
    assert query_memories(project_id="project-beta", workspace_path="C:/work/beta", limit=5)[0]["id"] == beta_id


def test_memory_recall_quality_is_read_only_and_scoped(isolated_learning_db):
    from arforge.memory import save_memory_v2

    save_memory_v2(
        "User prefers black formatting for Python files.",
        mem_type="preference",
        tags="python,formatting,black",
        importance=4,
        project_id="project-alpha",
        workspace_path="C:/work/alpha",
    )
    save_memory_v2(
        "When tool errors happen, inspect failure patterns first.",
        mem_type="workflow",
        tags="failure,tool,repair",
        importance=3,
        project_id="project-alpha",
        workspace_path="C:/work/alpha",
    )
    save_memory_v2(
        "Frontend packages use pnpm in another project.",
        mem_type="convention",
        tags="frontend,packages",
        importance=2,
        project_id="project-beta",
        workspace_path="C:/work/beta",
    )

    described = dispatch({"id": 55, "version": "1.1", "method": "protocol.describe"})
    response = dispatch(
        {
            "id": 56,
            "version": "1.1",
            "method": "memory.recall_quality",
            "params": {
                "project_id": "project-alpha",
                "workspace_path": "C:/work/alpha",
                "limit": 20,
                "min_score": 0.01,
            },
        }
    )
    invalid = dispatch(
        {"id": 57, "version": "1.1", "method": "memory.recall_quality", "params": {"min_score": 2}}
    )
    unexpected = dispatch(
        {"id": 58, "version": "1.1", "method": "memory.recall_quality", "params": {"query": "black"}}
    )

    assert "memory.recall_quality" in described["data"]["methods"]
    assert "memory.recall_quality" not in described["data"]["mutating_methods"]
    assert response["ok"] is True
    assert response["data"]["enabled"] is True
    assert response["data"]["algorithm"] == "bm25_self_recall"
    assert response["data"]["scope"]["project_id"] == "project-alpha"
    assert response["data"]["indexed"] == 2
    assert response["data"]["evaluated"] == 2
    assert response["data"]["top1_hit_rate"] >= 0.5
    assert response["data"]["mrr"] >= 0.5
    assert response["data"]["examples"]
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_memory_facets_and_semantic_search_are_read_only_and_scoped(isolated_learning_db):
    from arforge.memory import save_memory_v2

    alpha_id = save_memory_v2(
        "Python services prefer ruff formatting and pytest checks.",
        mem_type="preference",
        tags="python,formatting,tests",
        source="user",
        importance=4,
        project_id="project-alpha",
        workspace_path="C:/work/alpha",
    )
    save_memory_v2(
        "Frontend packages use pnpm in the beta workspace.",
        mem_type="convention",
        tags="frontend,packages",
        source="imported",
        importance=3,
        project_id="project-beta",
        workspace_path="C:/work/beta",
    )

    described = dispatch({"id": 59, "version": "1.1", "method": "protocol.describe"})
    facets = dispatch({"id": 60, "version": "1.1", "method": "memory.facets", "params": {"limit": 100}})
    semantic = dispatch(
        {
            "id": 61,
            "version": "1.1",
            "method": "memory.semantic_search",
            "params": {
                "query": "python formatting checks",
                "project_id": "project-alpha",
                "workspace_path": "C:/work/alpha",
                "top_k": 3,
                "limit": 100,
            },
        }
    )
    invalid = dispatch(
        {
            "id": 62,
            "version": "1.1",
            "method": "memory.semantic_search",
            "params": {"query": "x", "top_k": 0},
        }
    )

    assert "memory.facets" in described["data"]["methods"]
    assert "memory.semantic_search" in described["data"]["methods"]
    assert "memory.semantic_search" not in described["data"]["mutating_methods"]
    assert facets["ok"] is True
    assert {"value": "project-alpha", "count": 1} in facets["data"]["projects"]
    assert {"value": "C:/work/alpha", "count": 1} in facets["data"]["workspaces"]
    assert semantic["ok"] is True
    assert semantic["data"]["algorithm"] == "hybrid_bm25_hashing_vector"
    assert semantic["data"]["scope"]["project_id"] == "project-alpha"
    assert semantic["data"]["indexed"] == 1
    assert semantic["data"]["items"]
    assert semantic["data"]["items"][0]["id"] == str(alpha_id)
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"


def test_learning_dogfood_sync_is_explicit_stateful_and_idempotent(isolated_learning_db, monkeypatch, tmp_path):
    from arforge.core.dogfood import RunOutcome, record_outcome
    from arforge.learning_system import get_learning_system

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    record_outcome(RunOutcome(task="fix a failing import", success=False, steps=3, tool_calls=2, tokens=123))
    record_outcome(RunOutcome(task="add a small test", success=True, steps=2, tool_calls=1, tokens=80))

    described = dispatch({"id": 63, "version": "1.1", "method": "protocol.describe"})
    first = dispatch({"id": 64, "version": "1.1", "method": "learning.dogfood_sync", "params": {"limit": 50}})
    second = dispatch({"id": 65, "version": "1.1", "method": "learning.dogfood_sync", "params": {"limit": 50}})
    invalid = dispatch({"id": 66, "version": "1.1", "method": "learning.dogfood_sync", "params": {"limit": 0}})

    stats = get_learning_system().get_stats()
    assert "learning.dogfood_sync" in described["data"]["methods"]
    assert "learning.dogfood_sync" in described["data"]["stateful_methods"]
    assert "learning.dogfood_sync" not in described["data"]["workspace_mutating_methods"]
    assert first["ok"] is True
    assert first["data"]["imported"] == 2
    assert first["data"]["failed_candidates"] == 1
    assert second["data"]["imported"] == 0
    assert second["data"]["skipped"] == 2
    assert stats.total_turns == 2
    assert stats.failed_turns == 1
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"


def test_run_reports_are_readable_and_revert_is_workspace_mutating(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    from arforge.core.run_transaction import (
        get_run_transaction,
        persist_run_transaction,
        reset_run_transaction,
        save_run_messages,
        save_run_trace,
    )

    target = tmp_path / "work.txt"
    target.write_text("before", encoding="utf-8")
    reset_run_transaction()
    get_run_transaction().snapshot(str(target), "before")
    target.write_text("after", encoding="utf-8")
    persist_run_transaction("run-001")
    save_run_messages("run-001", [{"role": "user", "content": "change file"}])
    save_run_trace(
        "run-001",
        [{"event": "run_cmd", "command": "pytest", "returncode": 0}],
        observability={"total_tokens": 10},
        answer="done",
    )

    described = dispatch({"id": 70, "version": "1.1", "method": "protocol.describe"})
    listed = dispatch({"id": 71, "version": "1.1", "method": "run.list", "params": {"limit": 5}})
    latest = dispatch({"id": 72, "version": "1.1", "method": "run.report", "params": {}})
    report = dispatch({"id": 73, "version": "1.1", "method": "run.report", "params": {"run_id": "run-001"}})
    reverted = dispatch({"id": 74, "version": "1.1", "method": "run.revert", "params": {"run_id": "run-001"}})
    invalid = dispatch({"id": 75, "version": "1.1", "method": "run.list", "params": {"limit": 0}})

    assert "run.list" in described["data"]["methods"]
    assert "run.report" in described["data"]["methods"]
    assert "run.revert" in described["data"]["methods"]
    assert "run.list" not in described["data"]["mutating_methods"]
    assert "run.report" not in described["data"]["mutating_methods"]
    assert "run.revert" in described["data"]["mutating_methods"]
    assert "run.revert" in described["data"]["workspace_mutating_methods"]
    assert listed["ok"] is True
    assert listed["data"]["items"][0]["run_id"] == "run-001"
    assert latest["data"]["found"] is True
    assert latest["data"]["run_id"] == "run-001"
    assert report["data"]["report"]["changed_files"] == [str(target)]
    assert report["data"]["report"]["commands_run"][0]["command"] == "pytest"
    assert reverted["data"]["reverted"] is True
    assert target.read_text(encoding="utf-8") == "before"
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"


def test_plan_preview_is_structured_and_read_only():
    described = dispatch({"id": 76, "version": "1.1", "method": "protocol.describe"})
    preview = dispatch(
        {
            "id": 77,
            "version": "1.1",
            "method": "plan.preview",
            "params": {
                "task": "Add Plan Mode Desktop card",
                "plan_text": (
                    "# Plan\n"
                    "1. Inspect desktop/src/App.tsx and arforge/bridge.py.\n"
                    "2. Add read-only Bridge contract.\n"
                    "Risk: stale UI contract.\n"
                    "Rollback: revert touched files.\n"
                ),
                "explored_files": ["docs/FEATURE_CONTRACT.md"],
                "estimated_steps": 2,
            },
        }
    )
    invalid = dispatch({"id": 78, "version": "1.1", "method": "plan.preview", "params": {"task": ""}})
    unexpected = dispatch(
        {"id": 79, "version": "1.1", "method": "plan.preview", "params": {"task": "x", "plan_text": "y", "execute": True}}
    )

    assert "plan.preview" in described["data"]["methods"]
    assert "plan.preview" not in described["data"]["mutating_methods"]
    assert "plan.preview" not in described["data"]["workspace_mutating_methods"]
    assert preview["ok"] is True
    assert preview["data"]["mode"] == "plan"
    assert preview["data"]["approval_required"] is True
    assert preview["data"]["execution_mode_after_approval"] == "acceptEdits"
    assert "desktop/src/App.tsx" in preview["data"]["affected_files"]
    assert preview["data"]["steps"][0]["content"] == "Inspect desktop/src/App.tsx and arforge/bridge.py."
    assert preview["data"]["estimated_steps"] == 2
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_memory_update_is_stateful_but_not_workspace_mutating(isolated_learning_db):
    from arforge.memory import query_memories, save_memory_v2

    memory_id = save_memory_v2(
        "prefer autopep8 formatting",
        mem_type="preference",
        tags="python",
        importance=2,
        source="user",
    )

    described = dispatch({"id": 45, "version": "1.1", "method": "protocol.describe"})
    updated = dispatch(
        {
            "id": 46,
            "version": "1.1",
            "method": "memory.update",
            "params": {
                "memory_id": memory_id,
                "content": "prefer black formatting",
                "mem_type": "convention",
                "tags": "python,formatting",
                "importance": 4,
                "source": "user-corrected",
            },
        }
    )
    missing = dispatch(
        {"id": 47, "version": "1.1", "method": "memory.update", "params": {"memory_id": 9999, "content": "noop"}}
    )
    invalid = dispatch(
        {"id": 48, "version": "1.1", "method": "memory.update", "params": {"memory_id": memory_id, "content": ""}}
    )
    unexpected = dispatch(
        {"id": 49, "version": "1.1", "method": "memory.update", "params": {"memory_id": memory_id, "strength": 0.4}}
    )

    assert "memory.update" in described["data"]["methods"]
    assert "memory.update" in described["data"]["mutating_methods"]
    assert "memory.update" in described["data"]["stateful_methods"]
    assert "memory.update" not in described["data"]["workspace_mutating_methods"]
    assert updated["ok"] is True
    assert updated["data"]["updated"] is True
    assert updated["data"]["status"] == "updated"
    assert updated["data"]["item"]["content"] == "prefer black formatting"
    assert updated["data"]["item"]["mem_type"] == "convention"
    assert updated["data"]["item"]["tags"] == "python,formatting"
    assert updated["data"]["item"]["importance"] == 4
    assert updated["data"]["item"]["source"] == "user-corrected"
    [stored] = query_memories(query_text="black", limit=5)
    assert stored["id"] == memory_id
    assert stored["mem_type"] == "convention"
    assert missing["ok"] is True
    assert missing["data"]["status"] == "not_found"
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_memory_bulk_delete_requires_explicit_ids_and_reports_each_result(isolated_learning_db):
    from arforge.memory import query_memories, save_memory_v2

    first_id = save_memory_v2("bad imported convention", mem_type="convention", tags="python", importance=2, source="imported")
    second_id = save_memory_v2("stale package preference", mem_type="preference", tags="frontend", importance=3, source="user")
    keep_id = save_memory_v2("keep this memory", mem_type="knowledge", tags="safe", importance=4, source="user")

    described = dispatch({"id": 50, "version": "1.1", "method": "protocol.describe"})
    deleted = dispatch(
        {
            "id": 51,
            "version": "1.1",
            "method": "memory.bulk_delete",
            "params": {"memory_ids": [first_id, second_id, second_id, 9999]},
        }
    )
    invalid_empty = dispatch(
        {"id": 52, "version": "1.1", "method": "memory.bulk_delete", "params": {"memory_ids": []}}
    )
    invalid_entry = dispatch(
        {"id": 53, "version": "1.1", "method": "memory.bulk_delete", "params": {"memory_ids": [True]}}
    )
    unexpected = dispatch(
        {
            "id": 54,
            "version": "1.1",
            "method": "memory.bulk_delete",
            "params": {"memory_ids": [keep_id], "force": True},
        }
    )

    assert "memory.bulk_delete" in described["data"]["methods"]
    assert "memory.bulk_delete" in described["data"]["mutating_methods"]
    assert "memory.bulk_delete" in described["data"]["stateful_methods"]
    assert "memory.bulk_delete" not in described["data"]["workspace_mutating_methods"]
    assert deleted["ok"] is True
    assert deleted["data"] == {
        "schema_version": 1,
        "requested": 3,
        "deleted": 2,
        "not_found": 1,
        "deleted_ids": [first_id, second_id],
        "not_found_ids": [9999],
        "status": "deleted",
    }
    remaining_ids = {item["id"] for item in query_memories(limit=20)}
    assert keep_id in remaining_ids
    assert first_id not in remaining_ids
    assert second_id not in remaining_ids
    assert invalid_empty["ok"] is False
    assert invalid_empty["error"]["code"] == "INVALID_PARAMS"
    assert invalid_entry["ok"] is False
    assert invalid_entry["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_learning_undo_is_explicit_mutating_bridge_method(isolated_learning_db):
    from arforge.learning_system import Outcome, get_learning_system

    learning = get_learning_system()
    row_id = learning.record_outcome(Outcome(
        user_input="wrong import advice",
        model_answer="delete the package root",
        success=False,
        tags=["correction"],
        injected_context_size=0,
    ))

    described = dispatch({"id": 28, "version": "1.1", "method": "protocol.describe"})
    response = dispatch(
        {"id": 29, "version": "1.1", "method": "learning.undo", "params": {"learning_id": row_id}}
    )
    missing = dispatch(
        {"id": 30, "version": "1.1", "method": "learning.undo", "params": {"learning_id": row_id}}
    )
    invalid = dispatch(
        {"id": 31, "version": "1.1", "method": "learning.undo", "params": {"learning_id": "nope"}}
    )
    unexpected = dispatch(
        {"id": 32, "version": "1.1", "method": "learning.undo", "params": {"learning_id": row_id, "force": True}}
    )

    assert "learning.undo" in described["data"]["methods"]
    assert "learning.undo" in described["data"]["mutating_methods"]
    assert "learning.undo" in described["data"]["stateful_methods"]
    assert "learning.undo" not in described["data"]["workspace_mutating_methods"]
    assert response["ok"] is True
    assert response["data"] == {
        "schema_version": 1,
        "learning_id": row_id,
        "deleted": True,
        "status": "deleted",
        "linked_patterns": [],
    }
    assert all(item.outcome_id != row_id for item in learning.get_outcomes(limit=10))
    assert missing["ok"] is True
    assert missing["data"]["status"] == "not_found"
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    assert unexpected["ok"] is False
    assert unexpected["error"]["code"] == "INVALID_PARAMS"


def test_learning_undo_cleans_linked_auto_failure_pattern(isolated_learning_db):
    from arforge.learning_system import Outcome, get_learning_system

    learning = get_learning_system()
    row_id = learning.record_outcome(Outcome(
        user_input="fix broken import",
        model_answer="bad answer",
        success=False,
        error_type="ImportError",
        error_message="No module named arforge.missing",
        tags=["imports"],
    ))
    patterns_before = learning.get_patterns(pattern_type="failure", limit=10)

    response = dispatch(
        {"id": 33, "version": "1.1", "method": "learning.undo", "params": {"learning_id": row_id}}
    )

    assert response["ok"] is True
    assert response["data"]["deleted"] is True
    assert response["data"]["linked_patterns"] == [
        {
            "id": patterns_before[0]["id"],
            "pattern_type": "failure",
            "action": "deleted",
        }
    ]
    assert learning.get_patterns(pattern_type="failure", limit=10) == []
    assert "No module named arforge.missing" not in learning.build_injection_context("fix import")


def test_release_remediation_plan_is_read_only_bridge_method(monkeypatch, tmp_path):
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "release-manifest.json").write_text(
        json.dumps({"schema_version": 1, "source": {"commit": "a" * 40, "dirty": True}, "files": []}),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    described = dispatch({"id": 26, "method": "protocol.describe"})
    response = dispatch({"id": 27, "method": "release.remediation_plan"})
    rejected = dispatch({"id": 28, "method": "release.remediation_plan", "params": {"write": True}})

    assert "release.remediation_plan" in described["data"]["methods"]
    assert "release.remediation_plan" not in described["data"]["mutating_methods"]
    assert response["ok"] is True
    assert response["data"]["verdict"] == "DO_NOT_SHIP"
    assert response["data"]["remaining"] == 9
    assert response["data"]["items"][0]["gate"] == "INSTALLER-01"
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "INVALID_PARAMS"


def test_multimodal_diagnose_is_structured_read_only_bridge_method(monkeypatch, tmp_path):
    (tmp_path / "orders.py").write_text(
        "def process_order(payload):\n"
        "    return payload\n",
        encoding="utf-8",
    )
    (tmp_path / "error.txt").write_text(
        'Traceback (most recent call last):\n  File "app.py", line 3\nNameError: name \'process_order\' is not defined\n',
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    described = dispatch({"id": 29, "method": "protocol.describe"})
    response = dispatch({"id": 30, "method": "multimodal.diagnose", "params": {"filename": "error.txt", "limit": 4}})
    rejected_path = dispatch({"id": 31, "method": "multimodal.diagnose", "params": {"filename": "../error.txt"}})
    rejected_param = dispatch({"id": 32, "method": "multimodal.diagnose", "params": {"filename": "error.txt", "limit": 0}})

    assert "multimodal.diagnose" in described["data"]["methods"]
    assert "multimodal.diagnose" not in described["data"]["mutating_methods"]
    assert response["ok"] is True
    assert response["data"]["source"]["type"] == "document"
    assert response["data"]["summary"]["signals"] >= 1
    assert any(match["file"] == "orders.py" for match in response["data"]["matches"])
    assert any("missing symbol" in suggestion for suggestion in response["data"]["suggestions"])
    assert rejected_path["ok"] is False
    assert rejected_path["error"]["code"] == "INVALID_PARAMS"
    assert rejected_param["ok"] is False
    assert rejected_param["error"]["code"] == "INVALID_PARAMS"


def test_jsonl_server_recovers_after_malformed_request(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    incoming = io.StringIO('{broken\n{"id":6,"method":"health"}\n')
    outgoing = io.StringIO()
    assert serve(incoming, outgoing) == 0
    lines = [json.loads(line) for line in outgoing.getvalue().splitlines()]
    assert lines[0]["error"]["code"] == "PARSE_ERROR"
    assert lines[1]["id"] == 6
    assert lines[1]["ok"] is True


def test_jsonl_server_rejects_invalid_unicode_without_exiting(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    incoming = io.StringIO(
        '{"id":5,"method":"history.search","params":{"query":"\udcff"}}\n'
        '{"id":6,"method":"health"}\n'
    )
    outgoing = io.StringIO()

    assert serve(incoming, outgoing) == 0
    lines = [json.loads(line) for line in outgoing.getvalue().splitlines()]
    assert lines[0]["error"]["code"] == "INVALID_UNICODE"
    assert lines[1]["id"] == 6
    assert lines[1]["ok"] is True


def test_jsonl_wire_is_ascii_safe_for_windows_pipes(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_MODEL", "中文模型")
    incoming = io.StringIO('{"id":1,"version":"1.1","method":"config.get"}\n')
    outgoing = io.StringIO()

    assert serve(incoming, outgoing) == 0
    encoded = outgoing.getvalue().encode("ascii")
    payload = json.loads(encoded.decode("ascii"))
    assert payload["ok"] is True
    assert payload["data"]["model"] == "中文模型"


def test_jsonl_server_installs_agentic_runtime_hooks(monkeypatch, tmp_path):
    from arforge.core.hooks import HookEvent, get_hook_manager, reset_hook_manager

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    reset_hook_manager()
    incoming = io.StringIO('{"id":1,"version":"1.1","method":"health"}\n')
    outgoing = io.StringIO()

    assert serve(incoming, outgoing) == 0

    mgr = get_hook_manager()
    pre_names = mgr.handler_names(HookEvent.PRE_LLM_CALL)
    post_names = mgr.handler_names(HookEvent.POST_TOOL_USE)
    assert {"auto_compact", "learning_inject", "memory_inject"} <= pre_names
    assert {"change_tracker", "edit_verify", "self_correct"} <= post_names


def test_capabilities_are_structured_backend_facts():
    response = dispatch({"id": 7, "method": "capabilities.list"})
    assert response["ok"] is True
    assert response["data"]["count"] == len(response["data"]["items"])
    assert response["data"]["count"] > 0
    assert {"name", "kind", "enabled"} <= response["data"]["items"][0].keys()


def test_malformed_database_url_is_reported_without_echo(monkeypatch):
    malformed = "postgresql://admin:super-secret@[invalid"
    monkeypatch.setenv("ARFORGE_DB_URL", malformed)
    response = dispatch({"id": 8, "method": "config.get"})
    database_rendered = json.dumps(response["data"]["database"])
    assert response["ok"] is True
    assert response["data"]["database"]["valid"] is False
    assert "admin" not in database_rendered
    assert "super-secret" not in database_rendered


def test_protocol_and_version_mismatch_are_rejected():
    wrong_protocol = dispatch({"method": "health", "protocol": "other"})
    wrong_version = dispatch({"method": "health", "version": "2.0"})
    assert wrong_protocol["error"]["code"] == "UNSUPPORTED_PROTOCOL"
    assert wrong_version["error"]["code"] == "UNSUPPORTED_VERSION"
