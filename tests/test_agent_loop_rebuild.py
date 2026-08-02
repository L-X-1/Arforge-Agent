from __future__ import annotations


class _Chunk:
    def __init__(self, text: str, kind: str = "content", reasoning_content: str = ""):
        self.text = text
        self.kind = kind
        self.reasoning_content = reasoning_content


class _Adapter:
    def __init__(self, chunks):
        self._chunks = chunks

    def stream_generate(self, _messages):
        yield from self._chunks


class _Agent:
    def __init__(self, chunks, reasoning_enabled: bool = False):
        self.adapter = _Adapter(chunks)
        self.reasoning_enabled = reasoning_enabled
        self.last_reasoning = None

    def build_messages(self, user_content: str, use_reasoning: bool = False):  # noqa: ARG002
        return [{"role": "user", "content": user_content}]


def test_agent_loop_runs_local_turn():
    from arforge.core.agent_loop import run_agent_turn

    result = run_agent_turn("please plan this work")

    assert result.intent == "planning"
    assert result.answer


def test_agent_loop_v2_streams_events():
    from arforge.core.agent_loop_v2 import AgentLoopV2

    events = list(AgentLoopV2(_Agent([_Chunk("hello")])).stream("hello"))

    assert events[0]["type"] == "reasoning_delta"
    assert events[-1]["type"] == "done"
    assert events[-1]["data"]["answer"] == "hello"


def test_agent_loop_v2_stream_strips_xml_reasoning_from_answer():
    from arforge.core.agent_loop_v2 import AgentLoopV2

    chunks = [
        _Chunk("<understanding>用户要修复问题</understanding>\n"),
        _Chunk("<thinking>内部分析步骤</thinking>\n"),
        _Chunk("<evidence>tests/test_agent_loop_rebuild.py</evidence>\n"),
        _Chunk("<reflection>检查是否泄露标签</reflection>\n"),
        _Chunk("<answer>最终答案</answer>"),
    ]

    events = list(AgentLoopV2(_Agent(chunks, reasoning_enabled=True)).stream("hello"))
    answer_text = "".join(
        event["data"]["content"] for event in events if event["type"] == "answer_delta"
    )

    assert answer_text == "最终答案"
    assert "<thinking>" not in answer_text
    assert "内部分析步骤" not in answer_text
    assert events[-1]["data"]["answer"] == "最终答案"
    assert any(
        event["type"] == "reasoning_delta" and "thinking: 内部分析步骤" in event["data"]["content"]
        for event in events
    )


def test_agent_loop_v2_stream_preserves_plain_chunking():
    from arforge.core.agent_loop_v2 import AgentLoopV2

    chunks = [_Chunk("Hello"), _Chunk(" world"), _Chunk("!")]

    events = list(AgentLoopV2(_Agent(chunks)).stream("hello"))
    answer_chunks = [
        event["data"]["content"] for event in events if event["type"] == "answer_delta"
    ]

    assert answer_chunks == ["Hello", " world", "!"]
    assert events[-1]["data"]["answer"] == "Hello world!"


def test_prompt_and_safe_math():
    from arforge.prompt import build_system_prompt, build_user_prompt
    from arforge.safe_math import calculate

    assert "Arforge Agent" in build_system_prompt()
    assert "User:" in build_user_prompt("hi", "ctx")
    assert calculate("2 + 2") == 4
