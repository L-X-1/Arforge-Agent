"""CC-2 压缩器 验收测试。

重点：保 system+首任务、摘要中段、tool_call/响应配对完整、幂等、摘要失败回退、过短不压。
"""

from arforge.core.compaction import _KEY_FACTS_PREFIX, _SUMMARY_PREFIX, _rounds, compact


class StubAdapter:
    model_name = "deepseek-v4-flash"

    def generate(self, messages, max_tokens=None, temperature=None, response_format=None):
        return "SUMMARY"  # compress_memories 调用 adapter.generate


class FailAdapter:
    model_name = "x"

    def generate(self, *a, **k):
        raise RuntimeError("model down")


def _msgs():
    return [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "file A"},
        {"role": "assistant", "content": "thinking 1"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "t2", "type": "function", "function": {"name": "write_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t2", "content": "wrote"},
        {"role": "assistant", "content": "thinking 2"},
        {"role": "user", "content": "follow up"},
        {"role": "assistant", "content": "final"},
    ]


def _assert_tool_pairs_valid(messages):
    i = 0
    while i < len(messages):
        m = messages[i]
        if m.get("role") == "assistant" and m.get("tool_calls"):
            ids = {tc["id"] for tc in m["tool_calls"]}
            j, seen = i + 1, set()
            while j < len(messages) and messages[j].get("role") == "tool":
                seen.add(messages[j].get("tool_call_id"))
                j += 1
            assert ids <= seen, f"orphan tool_calls at {i}: {ids - seen}"
            i = j
        else:
            assert m.get("role") != "tool", f"orphan tool message at {i}"
            i += 1


def test_rounds_keep_tool_pairs_together():
    rounds = _rounds(_msgs(), 2)
    assert (2, 4) in rounds  # assistant(t1)+tool 一个轮
    assert (5, 7) in rounds  # assistant(t2)+tool 一个轮


def test_compact_preserves_head_tail_and_pairs():
    msgs = _msgs()
    new, stats = compact(msgs, StubAdapter(), "deepseek-v4-flash", keep_recent=4)
    assert stats["compacted"] is True
    assert new[0]["role"] == "system" and new[1]["role"] == "user"  # 保头
    assert any(str(m.get("content", "")).startswith(_SUMMARY_PREFIX) for m in new)  # 有摘要
    assert new[-1]["content"] == "final"  # 保尾
    _assert_tool_pairs_valid(new)  # 协议合法：无孤儿 tool / tool_calls
    assert len(new) < len(msgs)


def test_compact_preserves_key_facts_outside_llm_summary():
    from arforge.core.change_tracker import get_change_tracker, reset_change_tracker

    reset_change_tracker()
    get_change_tracker().record("tracked.py")
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "w1",
                    "type": "function",
                    "function": {"name": "write_file", "arguments": '{"filename":"changed.py","content":"x"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "w1", "content": "wrote changed.py"},
        {"role": "user", "content": "必须保留这个用户硬约束：不要删除桌面文件。"},
        {"role": "tool", "tool_call_id": "v1", "content": "pytest tests/test_demo.py -q\n3 passed"},
        {"role": "tool", "tool_call_id": "e1", "content": "Traceback\nNameError: name 'missing_value' is not defined"},
        {"role": "assistant", "content": "recent"},
    ]

    try:
        new, stats = compact(msgs, StubAdapter(), "deepseek-v4-flash", keep_recent=1)
    finally:
        reset_change_tracker()

    assert stats["compacted"] is True
    assert stats["key_facts"] >= 4
    key_msg = next(item for item in new if str(item.get("content", "")).startswith(_KEY_FACTS_PREFIX))
    content = key_msg["content"]
    assert "tracked.py" in content
    assert "changed.py" in content
    assert "用户硬约束" in content
    assert "3 passed" in content
    assert "错误指纹" in content


def test_compact_idempotent_on_summary_only_middle():
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
        {"role": "assistant", "content": _SUMMARY_PREFIX + "old"},
        {"role": "assistant", "content": "recent"},
    ]
    new, stats = compact(msgs, StubAdapter(), "deepseek-v4-flash", keep_recent=1)
    assert stats["compacted"] is False
    assert new == msgs


def test_compact_fallback_on_summary_failure():
    msgs = _msgs()
    new, stats = compact(msgs, FailAdapter(), "deepseek-v4-flash", keep_recent=4)
    assert stats["compacted"] is False  # 摘要失败 → 原样返回
    assert new == msgs


def test_compact_too_short_noop():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}, {"role": "assistant", "content": "a"}]
    new, stats = compact(msgs, StubAdapter(), "deepseek-v4-flash", keep_recent=6)
    assert stats["compacted"] is False
    assert new == msgs


def test_repeated_compaction_preserves_existing_key_facts():
    first_input = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
        {"role": "user", "content": "MUST preserve tenant isolation; DO NOT share credentials."},
        *({"role": "assistant", "content": f"old progress {index}"} for index in range(12)),
    ]

    first, first_stats = compact(first_input, StubAdapter(), "compatible[8k]", keep_recent=3)
    second_input = first + [
        {"role": "assistant", "content": f"new progress {index}"}
        for index in range(12)
    ]
    second, second_stats = compact(second_input, StubAdapter(), "compatible[8k]", keep_recent=3)

    assert first_stats["compacted"] is True
    assert second_stats["compacted"] is True
    assert "DO NOT share credentials" in "\n".join(str(item.get("content", "")) for item in second)
    assert second_stats["protected_facts_preserved"] == second_stats["key_facts"]
    assert second_stats["quality_score"] == 1.0


def test_long_test_output_preserves_terminal_result():
    from arforge.core.compaction import extract_key_facts

    output = ("pytest " + ("very-long-selector " * 40) + "\n") + ("ordinary log line\n" * 80) + "17 passed in 2.4s"
    facts = extract_key_facts([{"role": "tool", "tool_call_id": "tests", "content": output}])

    assert any("17 passed in 2.4s" in fact for fact in facts)


def test_structured_operational_facts_survive_a_bad_summary():
    class PoorAdapter:
        model_name = "compatible[8k]"

        def generate(self, *_args, **_kwargs):
            return "generic progress"

    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
        {"role": "assistant", "content": "Architecture decision: use event sourcing."},
        {"role": "user", "content": "I prefer the UI color #0F172A."},
        {"role": "assistant", "content": "Runtime config: port 4317 and timeout 45 seconds."},
        {"role": "assistant", "content": "Pending: add rate-limit documentation."},
        *({"role": "assistant", "content": f"progress {index}"} for index in range(10)),
    ]

    compacted, stats = compact(messages, PoorAdapter(), "compatible[8k]", keep_recent=3)
    text = "\n".join(str(item.get("content", "")) for item in compacted)

    assert stats["compacted"] is True
    assert "event sourcing" in text
    assert "#0F172A" in text
    assert "4317" in text and "45 seconds" in text
    assert "rate-limit documentation" in text


def test_key_fact_limit_prioritizes_late_hard_constraints_over_routine_todos():
    class PoorAdapter:
        model_name = "compatible[8k]"

        def generate(self, *_args, **_kwargs):
            return "generic progress"

    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
    for index in range(130):
        messages.extend([
            {"role": "assistant", "content": f"Pending: routine item {index}"},
            {"role": "assistant", "content": "ordinary detail " + ("x" * 500)},
        ])
    messages.extend([
        {"role": "user", "content": "MUST preserve the final security boundary."},
        *({"role": "assistant", "content": f"recent {index}"} for index in range(3)),
    ])

    compacted, stats = compact(messages, PoorAdapter(), "compatible[8k]", keep_recent=3)
    text = "\n".join(str(item.get("content", "")) for item in compacted)

    assert stats["key_facts"] == 120
    assert stats["key_facts_dropped"] >= 11
    assert "MUST preserve the final security boundary" in text
