"""P0-3 工具 Schema 化验收测试。

覆盖：to_openai_tools 导出合法 function-calling schema /
execute_by_name 按名执行 + 参数校验 + 类型强转 / execute_calls 并行。
"""

import arforge.tools.basic_tools  # noqa: F401  导入触发工具注册
import arforge.tools.file_tools  # noqa: F401
import arforge.tools.task_tools  # noqa: F401
from arforge.tool_registry import REGISTRY, adapt_docx_request


def test_to_openai_tools_valid_schema():
    tools = REGISTRY.to_openai_tools()
    assert len(tools) >= 12
    by_name = {t["function"]["name"]: t for t in tools}
    assert "calculate" in by_name

    fn = by_name["calculate"]["function"]
    assert fn["parameters"]["type"] == "object"
    assert "expression" in fn["parameters"]["properties"]
    assert fn["parameters"]["properties"]["expression"]["type"] == "string"
    assert "expression" in fn["parameters"]["required"]

    # 所有导出项结构合法（可直接喂给 DeepSeek/OpenAI）
    for t in tools:
        assert t["type"] == "function"
        assert t["function"]["name"]
        params = t["function"]["parameters"]
        assert params["type"] == "object"
        assert isinstance(params["properties"], dict)
        assert isinstance(params["required"], list)


def test_execute_by_name_success():
    result = REGISTRY.execute_by_name("calculate", {"expression": "2+2"})
    assert result.success, result.error
    assert "4" in result.output


def test_execute_by_name_missing_required():
    result = REGISTRY.execute_by_name("calculate", {})
    assert not result.success
    assert "缺少必填参数" in result.error


def test_direct_executor_validates_before_requesting_confirmation(monkeypatch):
    from arforge.tool_executor import execute_tool_by_name

    confirmations = []
    monkeypatch.setattr(
        "arforge.permission.request_confirmation",
        lambda *args, **kwargs: confirmations.append((args, kwargs)) or True,
    )

    result = execute_tool_by_name("write_docx", {})

    assert not result.success
    assert "缺少必填参数" in result.error
    assert confirmations == []


def test_docx_natural_language_adapter_extracts_screenshot_request(monkeypatch, tmp_path):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    args = adapt_docx_request(
        "在桌面生成一个word文档，命名为111，内容为宋体小四字体的你好，我是Arforge"
    )

    assert args == {
        "filename": str((tmp_path / "Desktop" / "111.docx").resolve()),
        "content": "你好，我是Arforge",
        "font_name": "宋体",
        "font_size_pt": 12.0,
    }


def test_natural_language_execute_validates_adapted_docx_args(monkeypatch, tmp_path):
    from arforge.tool_executor import run_tool_if_match

    tool = REGISTRY.get("write_docx")
    assert tool is not None
    captured = []
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setattr(tool, "execute_fn", lambda **kwargs: captured.append(kwargs) or "ok")
    monkeypatch.setattr("arforge.permission.request_confirmation", lambda *args, **kwargs: True)

    result = run_tool_if_match(
        "在桌面生成一个word文档，命名为111，内容为宋体小四字体的你好，我是Arforge"
    )

    assert result is not None
    assert result.success, result.error
    assert captured == [{
        "filename": str((tmp_path / "Desktop" / "111.docx").resolve()),
        "content": "你好，我是Arforge",
        "font_name": "宋体",
        "font_size_pt": 12.0,
    }]


def test_screenshot_docx_request_writes_desktop_file_in_full_access(monkeypatch, tmp_path):
    import zipfile

    from arforge.core.permission import permission_scope
    from arforge.tool_executor import run_tool_if_match

    desktop = tmp_path / "Desktop"
    desktop.mkdir()
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setattr("arforge.permission.request_confirmation", lambda *args, **kwargs: True)

    with permission_scope("fullAccess"):
        result = run_tool_if_match(
            "在桌面生成一个word文档，命名为111，内容为宋体小四字体的你好，我是Arforge"
        )

    target = desktop / "111.docx"
    assert result is not None and result.success, result.error if result else "no match"
    assert target.exists()
    with zipfile.ZipFile(target) as document:
        document_xml = document.read("word/document.xml").decode("utf-8")
    assert 'w:eastAsia="宋体"' in document_xml
    assert '<w:sz w:val="24"/>' in document_xml
    assert "你好，我是Arforge" in document_xml


def test_execute_by_name_unknown_tool():
    result = REGISTRY.execute_by_name("nonexistent_tool", {"x": 1})
    assert not result.success
    assert "not available" in result.error


def test_execute_by_name_type_coercion():
    # int 参数以字符串传入也能正确强转执行
    result = REGISTRY.execute_by_name("calculate", {"expression": "3*3"})
    assert result.success
    assert "9" in result.output


def test_execute_calls_parallel():
    calls = [
        ("calculate", {"expression": "1+1"}),
        ("calculate", {"expression": "5+5"}),
        ("time", {}),
    ]
    results = REGISTRY.execute_calls(calls, parallel=True)
    assert len(results) == 3
    assert results[0].success and "2" in results[0].output
    assert results[1].success and "10" in results[1].output
    assert results[2].success  # time 工具无需参数


def test_all_registered_tool_contracts_are_consistent():
    from arforge.tools import load_builtin_tools

    assert load_builtin_tools() == {}
    report = REGISTRY.audit_contracts()

    assert report["registered"] >= 98
    assert report["exported"] == report["registered"]
    assert report["passed"], report["issues"]
    assert report["duplicate_keywords"] == {}


def test_git_tool_optional_and_required_parameters_match_signatures():
    schemas = {
        item["function"]["name"]: item["function"]["parameters"]
        for item in REGISTRY.to_openai_tools(deferred=False)
    }

    assert schemas["git_diff"]["required"] == []
    assert schemas["git_log"]["required"] == []
    assert schemas["git_branch"]["required"] == []
    assert schemas["git_add"]["required"] == []
    assert schemas["git_commit"]["required"] == ["message"]
    assert schemas["git_checkout"]["required"] == ["branch"]
    assert not REGISTRY.execute_by_name("git_commit", {}).success
    assert not REGISTRY.execute_by_name("git_checkout", {}).success


def test_read_file_direct_match_requires_an_explicit_target():
    assert REGISTRY.match("你帮我打开") is None
    match = REGISTRY.match("打开 111.docx")
    assert match is not None
    assert match.tool_name == "read_file"
    assert match.args == {"filename": "111.docx"}
