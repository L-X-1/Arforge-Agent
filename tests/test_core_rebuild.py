def test_agent_event_helpers_match_public_shape():
    from arforge.agent_event import done, reasoning_delta, tool_call_start

    assert reasoning_delta("x") == {"type": "reasoning_delta", "data": {"content": "x"}}
    assert tool_call_start("read", {"path": "a.py"}, 1)["data"]["iteration"] == 1
    assert done("ok", [], 0.1)["data"]["answer"] == "ok"


def test_agent_response_and_trace_to_dict():
    from arforge.agent_response import AgentResponse
    from arforge.agent_trace import AgentTrace

    trace = AgentTrace()
    trace.add("step")
    trace.finish()
    response = AgentResponse("answer", trace.to_list(), trace.duration(), False, {"kind": "test"})

    data = response.to_dict()
    assert data["answer"] == "answer"
    assert data["trace"][0]["message"] == "step"
    assert data["collapsed"] is False


def test_arforge_agent_chat_and_safe_modify(tmp_path):
    from arforge.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    response = agent.chat("hello")

    assert response.answer and len(response.answer) > 0
    assert agent.conversation_history

    target = tmp_path / "agent_write.py"
    result = agent.safe_modify_file(str(target), "x = 1\n")

    assert result["success"]
    assert target.read_text(encoding="utf-8") == "x = 1\n"
