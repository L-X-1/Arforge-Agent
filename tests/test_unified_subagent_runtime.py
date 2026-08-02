from __future__ import annotations

from types import SimpleNamespace

from arforge.core import subagent
from arforge.multiagent.agents import CoderAgent
from arforge.multiagent.protocol import Conversation, Task
from arforge.multiagent.sub_agent_pool import SubAgentPool


ROLE_ALIASES = {
    "PlannerAgent": "planner",
    "CoderAgent": "coder",
    "ReviewerAgent": "reviewer",
    "TesterAgent": "tester",
    "SearcherAgent": "searcher",
    "DocAgent": "doc",
    "DebuggerAgent": "debugger",
    "DataAgent": "data",
}


def test_lightweight_and_orchestrator_names_resolve_one_role_spec():
    for orchestrator_role, lightweight_role in ROLE_ALIASES.items():
        lightweight = subagent.get_subagent_role_spec(lightweight_role)
        orchestrator = subagent.get_subagent_role_spec(orchestrator_role)

        assert orchestrator is lightweight
        assert lightweight.name == lightweight_role
        assert lightweight.orchestrator_role == orchestrator_role
        assert subagent.normalize_subagent_role(orchestrator_role) == lightweight_role


def test_pool_and_lightweight_api_expose_the_same_builtin_role_contracts():
    pool = SubAgentPool.instance()
    pool_roles = {item.name: item for item in pool.list_roles()}
    lightweight_roles = {
        item["role"]: item for item in subagent.list_subagent_roles()
    }

    for orchestrator_role, lightweight_role in ROLE_ALIASES.items():
        spec = subagent.get_subagent_role_spec(lightweight_role)
        pooled = pool_roles[orchestrator_role]
        agent = pool.create_agent(orchestrator_role)

        assert tuple(pooled.tools) == spec.tools
        assert tuple(pooled.capabilities) == spec.capabilities
        assert pooled.system_prompt == spec.system_prompt
        assert agent is not None
        assert tuple(agent.tools) == spec.tools
        assert tuple(agent.capabilities) == spec.capabilities
        assert agent.system_prompt == spec.system_prompt
        assert agent.max_steps == spec.max_steps
        assert lightweight_roles[lightweight_role]["tools"] == list(spec.tools)
        assert lightweight_roles[lightweight_role]["category"] == spec.category


def test_multiagent_worker_uses_shared_execution_kernel(monkeypatch):
    captured = {}

    def fake_execute(adapter, messages, **kwargs):
        captured["adapter"] = adapter
        captured["messages"] = messages
        captured.update(kwargs)
        return SimpleNamespace(answer="done", tool_calls=[], trace=[], observability={})

    monkeypatch.setattr(subagent, "execute_subagent_loop", fake_execute)
    adapter = object()
    master = SimpleNamespace(agent=SimpleNamespace(adapter=adapter))
    agent = CoderAgent(master=master)
    conversation = Conversation(master_goal="merge runtimes")
    task = Task(task_id="unified-1", role="CoderAgent", goal="inspect code")

    result = agent.run_agentic_task(task, conversation, max_steps=3)

    spec = subagent.get_subagent_role_spec("coder")
    assert result.answer == "done"
    assert captured["adapter"] is adapter
    assert captured["role"] == "coder"
    assert set(captured["allowed_tool_names"]) >= set(spec.tools)
    assert captured["span_name"] == "subagent.CoderAgent"


def test_multiagent_worker_inherits_shared_adapter_and_parent_cancel(monkeypatch):
    captured = {}

    def fake_execute(adapter, messages, **kwargs):
        captured["adapter"] = adapter
        captured["stopped"] = kwargs["should_stop"]()
        return SimpleNamespace(answer="stopped", tool_calls=[], trace=[], observability={})

    monkeypatch.setattr(subagent, "execute_subagent_loop", fake_execute)
    adapter = object()
    agent = CoderAgent()
    conversation = Conversation(master_goal="cancel")
    task = Task(task_id="unified-cancel", role="CoderAgent", goal="inspect")

    with subagent.subagent_adapter_scope(adapter), subagent.subagent_stop_scope(
        lambda: True
    ):
        result = agent.run_agentic_task(task, conversation, max_steps=2)

    assert result.answer == "stopped"
    assert captured["adapter"] is adapter
    assert captured["stopped"] is True


def test_lightweight_worker_uses_shared_execution_kernel(monkeypatch):
    captured = {}

    def fake_execute(adapter, messages, **kwargs):
        captured["adapter"] = adapter
        captured["messages"] = messages
        captured.update(kwargs)
        return SimpleNamespace(answer="shared result")

    monkeypatch.setattr(subagent, "execute_subagent_loop", fake_execute)
    adapter = object()
    subagent.set_subagent_adapter(adapter)
    try:
        output = subagent.run_subagent("inspect", role="CoderAgent", max_steps=2)
    finally:
        subagent.clear_subagent_adapter()

    assert output == "shared result"
    assert captured["adapter"] is adapter
    assert captured["role"] == "coder"
    assert captured["max_steps"] == 2
