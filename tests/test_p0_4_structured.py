"""P0-4 结构化输出验收测试：extract_json 稳健抽取 + generate_structured。"""

from arforge.models.structured import extract_json, generate_structured


def test_extract_json_direct():
    assert extract_json('{"a": 1, "b": "x"}') == {"a": 1, "b": "x"}


def test_extract_json_from_markdown_fence():
    text = "好的，结果如下：\n```json\n{\"steps\": [1, 2, 3]}\n```\n完成。"
    assert extract_json(text) == {"steps": [1, 2, 3]}


def test_extract_json_embedded_in_prose():
    text = '这是计划：{"task": "build", "deps": ["a", "b"]} 就这样。'
    assert extract_json(text) == {"task": "build", "deps": ["a", "b"]}


def test_extract_json_handles_nested_and_braces_in_strings():
    text = 'prefix {"k": {"nested": "has } brace"}, "n": 2} suffix'
    assert extract_json(text) == {"k": {"nested": "has } brace"}, "n": 2}


def test_extract_json_array():
    assert extract_json("结果 [1, 2, 3] 完") == [1, 2, 3]


def test_extract_json_failure_returns_none():
    assert extract_json("没有任何 JSON 的纯文本") is None
    assert extract_json("") is None


class _FakeAdapter:
    def __init__(self, text, accept_response_format=True):
        self.text = text
        self.accept_response_format = accept_response_format
        self.used_response_format = None

    def generate(self, messages, max_tokens=None, temperature=None, response_format=None):
        if response_format is not None and not self.accept_response_format:
            raise TypeError("unexpected keyword 'response_format'")
        self.used_response_format = response_format
        return self.text


def test_generate_structured_parses_dict():
    adapter = _FakeAdapter('{"plan": "x", "n": 3}')
    out = generate_structured(adapter, [{"role": "user", "content": "hi"}])
    assert out == {"plan": "x", "n": 3}
    # 确认请求了 json_object 模式
    assert adapter.used_response_format == {"type": "json_object"}


def test_generate_structured_required_keys_missing_returns_none():
    adapter = _FakeAdapter('{"plan": "x"}')
    out = generate_structured(adapter, [{"role": "user", "content": "hi"}], required_keys=["plan", "steps"])
    assert out is None


def test_generate_structured_falls_back_without_response_format():
    # 适配器不支持 response_format → 自动退化为普通生成仍能解析
    adapter = _FakeAdapter('{"ok": true}', accept_response_format=False)
    out = generate_structured(adapter, [{"role": "user", "content": "hi"}])
    assert out == {"ok": True}
