from __future__ import annotations


def test_model_context_resolution_precedence():
    from arforge.core.context import resolve_context_window

    assert resolve_context_window("gpt-4o").tokens == 128_000
    catalog = resolve_context_window("gpt-4o", 258_000)
    assert catalog.tokens == 128_000
    assert catalog.source == "catalog"
    assert resolve_context_window("deepseek-v4-flash").tokens == 1_000_000
    assert resolve_context_window("deepseek-v4-pro").tokens == 1_000_000
    inferred = resolve_context_window("v4-pro[1m]")
    assert inferred.tokens == 1_000_000
    assert inferred.source == "model_name"
    configured = resolve_context_window("v4-pro[1m]", 258_000)
    assert configured.tokens == 258_000
    assert configured.source == "configured"
    fallback = resolve_context_window("private-compatible-model")
    assert fallback.tokens == 65_536
    assert fallback.source == "fallback"


def test_context_meter_and_compactor_share_the_same_budget(monkeypatch):
    import config
    from arforge.core.compaction import needs_compaction
    from arforge.core.context import build_context_status, estimate_messages_tokens

    monkeypatch.setattr(config, "CHAT_MAX_TOKENS", 16_384)
    messages = [{"role": "user", "content": "测" * 5_200}]
    status = build_context_status(messages, "compatible[8k]", configured_tokens=8_000)

    assert status["reserved_output_tokens"] == 2_000
    assert status["compact_at_tokens"] == 5_100
    assert estimate_messages_tokens(messages) > status["compact_at_tokens"]
    assert needs_compaction(messages, "compatible[8k]", 8_000) is True


def test_context_status_calibrates_current_conversation_from_provider_usage():
    from arforge.core.context import build_context_status

    status = build_context_status(
        [{"role": "user", "content": "short local estimate"}],
        "v4-pro[1m]",
        usage={"prompt_tokens": 200_000, "completion_tokens": 500},
        memory_tokens=1_200,
        compaction_count=2,
        cumulative_prompt_tokens=540_000,
        cumulative_completion_tokens=12_000,
        provider_call_count=6,
        compacted_tokens_total=86_000,
        checkpoint_restored=True,
    )

    assert status["context_window_tokens"] == 1_000_000
    assert status["used_tokens"] == 200_000
    assert status["usage_percent"] == 20.0
    assert status["usage_kind"] == "conversation"
    assert status["conversation_usage_source"] == "provider_calibrated"
    assert status["memory_tokens"] == 1_200
    assert status["compaction_count"] == 2
    assert status["schema_version"] == 3
    assert status["cumulative_prompt_tokens"] == 540_000
    assert status["provider_call_count"] == 6
    assert status["compacted_tokens_total"] == 86_000
    assert status["checkpoint_restored"] is True
    assert status["compaction_history_complete"] is True


def test_context_status_does_not_mix_provider_usage_with_a_different_estimate():
    from arforge.core.context import build_context_status

    status = build_context_status(
        [{"role": "user", "content": "测" * 10_000}],
        "compatible[32k]",
        usage={"prompt_tokens": 4_000, "completion_tokens": 500},
    )

    assert status["estimated_tokens"] > 4_000
    assert status["used_tokens"] == 4_000
    assert status["current_input_tokens"] == 4_000
    assert status["usage_kind"] == "conversation"


def test_context_status_applies_live_message_delta_to_last_primary_prompt():
    from arforge.core.context import build_context_status, estimate_messages_tokens

    previous = [{"role": "user", "content": "旧窗口" * 200}]
    current = [*previous, {"role": "tool", "content": "新增工具结果" * 100}]
    previous_estimate = estimate_messages_tokens(previous)
    current_estimate = estimate_messages_tokens(current)
    status = build_context_status(
        current,
        "compatible[32k]",
        usage={"prompt_tokens": 4_000, "completion_tokens": 500},
        usage_message_tokens=previous_estimate,
    )

    assert status["used_tokens"] == 4_000 + current_estimate - previous_estimate
    assert status["last_prompt_tokens"] == 4_000
    assert status["conversation_tokens"] == status["used_tokens"]


def test_subagent_usage_counts_toward_cost_without_overwriting_primary_window():
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    agent._last_context_messages = [
        {"role": "user", "content": "primary conversation"}
    ]
    agent.record_context_usage(
        {"prompt_tokens": 4_000, "completion_tokens": 200},
        update_current=True,
    )
    primary_usage = dict(agent._last_usage)
    primary_baseline = agent._last_usage_message_tokens

    agent.record_context_usage(
        {"prompt_tokens": 900, "completion_tokens": 100},
        update_current=False,
    )

    assert agent._last_usage == primary_usage
    assert agent._last_usage_message_tokens == primary_baseline
    assert agent._provider_call_count == 2
    assert agent._cumulative_prompt_tokens == 4_900
    assert agent._cumulative_completion_tokens == 300


def test_completed_agentic_turn_meters_only_the_history_retained_for_next_turn():
    from arforge.product.session_runtime import SessionRuntime

    class Agent:
        def __init__(self):
            self.conversation_history = []
            self._last_context_messages = [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "build it"},
                {"role": "assistant", "content": "tool call"},
                {"role": "tool", "content": "large temporary result"},
            ]
            self._last_usage = {"prompt_tokens": 8_000}
            self._last_usage_message_tokens = 2_000
            self._context_checkpoint_active = False

    agent = Agent()
    SessionRuntime._remember_turn(agent, "build it", "done")

    assert agent.conversation_history == [
        {"role": "user", "content": "build it"},
        {"role": "assistant", "content": "done"},
    ]
    assert agent._last_context_messages == agent.conversation_history
    assert agent._last_usage == {}
    assert agent._last_usage_message_tokens == 0


def test_bridge_state_persists_context_meter_and_compacted_checkpoint(tmp_path):
    from arforge.product.state_store import BridgeStateStore

    store = BridgeStateStore(tmp_path / "bridge.db")
    store.save_session({
        "session_id": "session-context",
        "status": "active",
        "created_at": "now",
        "updated_at": "now",
        "project_id": "project",
        "title": "Context",
        "context_status": {
            "schema_version": 2,
            "compaction_count": 3,
            "cumulative_prompt_tokens": 123_000,
            "last_compaction": {"before_tokens": 90_000, "after_tokens": 30_000},
        },
        "context_checkpoint": [
            {"role": "assistant", "content": "【关键事实】保留约束"},
            {"role": "assistant", "content": "【历史摘要】旧轮次"},
        ],
    })

    restored = store.load_sessions()[0]

    assert restored["context_status"]["compaction_count"] == 3
    assert restored["context_status"]["cumulative_prompt_tokens"] == 123_000
    assert restored["context_checkpoint"][0]["content"].startswith("【关键事实】")


def test_recovered_agent_uses_compacted_checkpoint_and_keeps_counters():
    from arforge.product.session_runtime import SessionRecord, SessionRuntime

    class Agent:
        def __init__(self):
            self.conversation_history = []
            self._last_context_messages = []
            self._last_usage = {"prompt_tokens": 999}
            self._compaction_count = 0
            self._cumulative_prompt_tokens = 0
            self._cumulative_completion_tokens = 0
            self._provider_call_count = 0
            self._compacted_tokens_total = 0
            self._last_compaction = {}
            self._context_checkpoint_active = False
            self._checkpoint_restored = False
            self._compaction_history_complete = True

    session = SessionRecord(
        session_id="session",
        created_at="now",
        updated_at="now",
        context_status={
            "schema_version": 2,
            "compaction_count": 4,
            "cumulative_prompt_tokens": 220_000,
            "cumulative_completion_tokens": 8_000,
            "provider_call_count": 9,
            "compacted_tokens_total": 140_000,
            "compaction_history_complete": False,
            "last_compaction": {"before_tokens": 100_000, "after_tokens": 40_000},
        },
        context_checkpoint=[
            {"role": "assistant", "content": "【关键事实】必须保留"},
            {"role": "assistant", "content": "【历史摘要】已完成旧工作"},
        ],
    )
    agent = Agent()

    SessionRuntime._restore_agent_context_state(
        session,
        agent,
        [{"role": "user", "content": "uncompressed fallback"}],
    )

    assert agent.conversation_history == session.context_checkpoint
    assert agent._compaction_count == 4
    assert agent._provider_call_count == 9
    assert agent._compacted_tokens_total == 140_000
    assert agent._last_usage == {}
    assert agent._context_checkpoint_active is True
    assert agent._checkpoint_restored is True
    assert agent._compaction_history_complete is False


def test_live_provider_meter_is_persisted_before_operation_completion(tmp_path):
    from arforge.product.session_runtime import OperationRecord, SessionRuntime
    from arforge.product.state_store import BridgeStateStore

    class Agent:
        conversation_history = []

        @staticmethod
        def context_status():
            return {
                "schema_version": 2,
                "model": "test-model",
                "used_tokens": 8_600,
                "usage_kind": "provider",
                "provider_call_count": 2,
                "cumulative_prompt_tokens": 12_300,
                "compaction_count": 1,
                "compaction_history_complete": True,
            }

    events: list[dict] = []
    store = BridgeStateStore(tmp_path / "bridge.db")
    runtime = SessionRuntime(events.append, agent_factory=Agent, store=store)
    session = runtime.create_session()
    operation = OperationRecord(
        operation_id="operation-live-context",
        session_id=session["session_id"],
        created_at="now",
        timeout_ms=120_000,
    )

    runtime._publish_live_context_status(
        operation,
        runtime._sessions[session["session_id"]].agent,
        checkpoint_messages=None,
    )

    restored = store.load_sessions()[0]
    assert restored["context_status"]["used_tokens"] == 8_600
    assert restored["context_status"]["provider_call_count"] == 2
    assert events[-1]["type"] == "context.updated"
    assert events[-1]["data"]["reason"] == "provider_usage"


def test_inactive_session_estimate_preserves_durable_context_counters():
    from arforge.product.session_runtime import SessionRuntime

    class Agent:
        conversation_history = []

        @staticmethod
        def context_status():
            return {}

    runtime = SessionRuntime(lambda _event: None, agent_factory=Agent)
    session = runtime.create_session()
    record = runtime._sessions[session["session_id"]]
    record.agent = None
    record.context_status = {
        "schema_version": 2,
        "provider_call_count": 25,
        "cumulative_prompt_tokens": 456_727,
        "cumulative_completion_tokens": 5_841,
        "compaction_count": 3,
        "compacted_tokens_total": 90_000,
        "compaction_history_complete": False,
    }

    refreshed = runtime.get_session(session["session_id"])["context_status"]

    assert refreshed["usage_kind"] == "conversation"
    assert refreshed["provider_call_count"] == 25
    assert refreshed["cumulative_prompt_tokens"] == 456_727
    assert refreshed["compaction_count"] == 3
    assert refreshed["compacted_tokens_total"] == 90_000
    assert refreshed["compaction_history_complete"] is False


def test_normal_chat_history_is_budget_driven_not_fixed_to_twenty(monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query="": "")
    agent.conversation_history = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": f"turn-{index}"}
        for index in range(30)
    ]

    messages = agent._build_messages("next")

    assert len(messages) == 32
    assert any(item.get("content") == "turn-0" for item in messages)
    assert any(item.get("content") == "turn-29" for item in messages)


def test_long_term_memory_recall_is_workspace_scoped(tmp_path):
    from arforge.auto_memory import workspace_memory_scope
    from arforge.core.agent_core import ArforgeAgent
    from arforge.database import init_db
    from arforge.memory import save_memory_v2
    from arforge.workspace_context import execution_scope

    init_db()
    workspace_a = tmp_path / "project-a"
    workspace_b = tmp_path / "project-b"
    workspace_a.mkdir()
    workspace_b.mkdir()
    project_a, path_a = workspace_memory_scope(workspace_a)
    project_b, path_b = workspace_memory_scope(workspace_b)
    save_memory_v2("项目 A 始终使用蓝色按钮", mem_type="convention", source="auto", project_id=project_a, workspace_path=path_a)
    save_memory_v2("项目 B 始终使用红色按钮", mem_type="convention", source="auto", project_id=project_b, workspace_path=path_b)

    agent = ArforgeAgent()
    with execution_scope("memory-test", workspace=workspace_a):
        recalled = agent.refresh_memory_text("按钮颜色")

    assert "蓝色按钮" in recalled
    assert "红色按钮" not in recalled
    assert "<memory_data>" in recalled


def test_long_conversation_compacts_and_preserves_constraints(monkeypatch):
    from arforge.core.agent_core import ArforgeAgent
    from arforge.core.context import estimate_messages_tokens

    class Adapter:
        model_name = "compatible[8k]"
        context_window_tokens = 8_000

        def generate(self, _messages, **_kwargs):
            return "已完成旧轮次摘要；保留用户目标、决定和验证状态。"

    agent = ArforgeAgent()
    agent._adapter = Adapter()
    agent._adapter_identity = None
    history = []
    for index in range(18):
        history.extend([
            {"role": "user", "content": ("必须保留项目约束：不得删除文件。" if index == 4 else f"第 {index} 轮问题") + "测" * 450},
            {"role": "assistant", "content": f"第 {index} 轮结论" + "答" * 450},
        ])
    messages = [{"role": "system", "content": "system"}, *history, {"role": "user", "content": "继续完成"}]
    before = estimate_messages_tokens(messages)

    compacted = agent.prepare_context_messages(messages)

    assert estimate_messages_tokens(compacted) < before
    assert any("【历史摘要】" in str(item.get("content", "")) for item in compacted)
    assert any("用户硬约束" in str(item.get("content", "")) for item in compacted)
    assert compacted[-1]["content"] == "继续完成"
    status = agent.context_status()
    assert status["compaction_count"] == 1
    assert status["last_compaction"]["before_tokens"] == before


def test_completed_turn_keeps_compacted_checkpoint_as_live_short_term_history():
    from arforge.product.session_runtime import SessionRuntime

    class Agent:
        conversation_history = [
            {"role": "user", "content": "old raw turn"},
            {"role": "assistant", "content": "old raw answer"},
        ]
        _context_checkpoint_active = True
        _last_context_messages = [
            {"role": "system", "content": "system"},
            {"role": "assistant", "content": "【关键事实】\n- 用户硬约束: keep this"},
            {"role": "assistant", "content": "【历史摘要】old turns"},
            {"role": "user", "content": "current task"},
        ]

    agent = Agent()
    SessionRuntime._remember_turn(agent, "current task", "completed answer")

    assert agent.conversation_history == [
        {"role": "assistant", "content": "【关键事实】\n- 用户硬约束: keep this"},
        {"role": "assistant", "content": "【历史摘要】old turns"},
        {"role": "user", "content": "current task"},
        {"role": "assistant", "content": "completed answer"},
    ]
    assert agent._last_context_messages == agent.conversation_history
