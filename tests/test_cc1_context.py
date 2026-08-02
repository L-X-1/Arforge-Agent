"""CC-1 token 估算 验收测试。"""

from arforge.core.context import estimate_messages_tokens, estimate_text_tokens


def test_empty():
    assert estimate_text_tokens("") == 0
    assert estimate_messages_tokens([]) == 0


def test_cjk_one_per_char():
    assert estimate_text_tokens("你好世界") == 4


def test_ascii_quarter():
    assert estimate_text_tokens("a" * 40) == 10


def test_mixed():
    assert estimate_text_tokens("你好世界" + "a" * 8) == 6  # 4 CJK + 8//4


def test_messages_includes_tool_calls():
    msgs = [
        {"role": "system", "content": "xxxx"},
        {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "f", "arguments": "a" * 8}}]},
    ]
    assert estimate_messages_tokens(msgs) >= 4 + 1 + 4 + 2


def test_messages_handles_non_dict():
    assert estimate_messages_tokens(["plain"]) >= 0
