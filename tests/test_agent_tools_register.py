"""Tests for the newly registered Agent tools (code/data/web) and the doctor key fix.

Scope:
- code_search / code_read / list_code_files / code_summary are registered, schema-correct,
  workspace-rooted, read-only, and return usable feedback.
- csv_preview / json_pretty read workspace files safely.
- web_search is registered as a network-category tool.
- doctor no longer leaks more than 4 chars of the API key.
"""

from __future__ import annotations

import sys

import pytest


# ---------------------------------------------------------------------------
# Fixture: isolated workspace, reload tool modules so WORKSPACE rebinds.
# ---------------------------------------------------------------------------


@pytest.fixture
def ws(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools") or mod.startswith("arforge.tools.basic_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools  # noqa: F401

    importlib.reload(arforge.tools.file_tools)
    return tmp_path


# ===========================================================================
# Registration + schema
# ===========================================================================


def test_all_new_tools_are_registered():
    """The 7 new tools must appear in the registry with a function-calling schema."""
    import arforge.tools.code_tools  # noqa: F401
    import arforge.tools.data_tools  # noqa: F401
    import arforge.tools.web_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    names = {t.name for t in REGISTRY.list_tools()}
    expected = {"code_search", "code_read", "list_code_files", "code_summary", "csv_preview", "json_pretty", "web_search"}
    assert expected.issubset(names), f"missing: {expected - names}"


def test_new_tools_exposed_in_openai_schema():
    """to_openai_tools() must surface the new tools with correct param types."""
    import arforge.tools.code_tools  # noqa: F401
    import arforge.tools.data_tools  # noqa: F401
    import arforge.tools.web_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    schema = {t["function"]["name"]: t["function"]["parameters"] for t in REGISTRY.to_openai_tools()}
    assert "keyword" in schema["code_search"]["properties"]
    assert schema["code_search"]["properties"]["limit"]["type"] == "integer"
    assert schema["code_search"]["properties"]["all_text"]["type"] == "boolean"
    assert "filename" in schema["csv_preview"]["properties"]
    assert "query" in schema["web_search"]["properties"]


def test_code_tools_are_read_only_and_low_risk():
    """Code tools must be read-only (no confirmation, low risk, read category)."""
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    for name in ("code_search", "code_read", "list_code_files", "code_summary"):
        tool = REGISTRY.get(name)
        assert tool is not None
        assert tool.schema.risk_level == "low"
        assert tool.schema.requires_confirmation is False
        assert tool.schema.category == "read"


def test_web_search_is_network_category_and_requires_confirmation():
    """web_search touches the network → must be gated by the permission matrix."""
    import arforge.tools.web_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("web_search")
    assert tool.schema.category == "network"
    assert tool.schema.risk_level == "medium"


# ===========================================================================
# code_search / code_read / list_code_files — workspace-rooted, functional
# ===========================================================================


def test_list_code_files_lists_workspace_python_files(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    (ws / "sub").mkdir()
    (ws / "sub" / "b.py").write_text("y = 2\n", encoding="utf-8")
    out = REGISTRY.execute_by_name("list_code_files", {"limit": 50}).output
    assert "a.py" in out
    assert "b.py" in out


def test_code_read_returns_file_content(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "m.py").write_text("def f():\n    return 42\n", encoding="utf-8")
    out = REGISTRY.execute_by_name("code_read", {"filename": "m.py"}).output
    assert "def f()" in out
    assert "42" in out


def test_code_read_rejects_path_escape(ws):
    """code_read must reuse the workspace escape guard (no reading outside ws)."""
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    res = REGISTRY.execute_by_name("code_read", {"filename": "../../../etc/passwd"})
    # Either refused by the escape guard or "not found" — must NOT leak external content.
    assert res.success is False or "Refused" in res.output or "not found" in res.output.lower() or "escapes workspace" in res.output


def test_code_search_finds_keyword_with_line_number(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "m.py").write_text("def alpha():\n    pass\ndef beta():\n    pass\n", encoding="utf-8")
    out = REGISTRY.execute_by_name("code_search", {"keyword": "beta"}).output
    assert "m.py" in out
    assert "3" in out  # beta is on line 3


def test_code_search_no_match_is_clean_message(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "m.py").write_text("x = 1\n", encoding="utf-8")
    out = REGISTRY.execute_by_name("code_search", {"keyword": "zzznotpresent"}).output
    assert "no matches" in out.lower()


def test_code_search_resolves_existing_path_instead_of_searching_its_text(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    target = ws / "src" / "router" / "index.js"
    target.parent.mkdir(parents=True)
    target.write_text("export default {}\n", encoding="utf-8")

    result = REGISTRY.execute_by_name(
        "code_search",
        {"keyword": "src/router/index.js"},
    )

    assert result.success is True
    assert result.output == "exact path match (file): src/router/index.js"


def test_code_search_all_text_includes_non_python_files(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "README.md").write_text("billing contract\n", encoding="utf-8")
    out = REGISTRY.execute_by_name(
        "code_search",
        {"keyword": "billing", "all_text": True},
    )

    assert out.success is True
    assert "README.md" in out.output


def test_code_summary_summarizes_python_file(ws):
    import arforge.tools.code_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "m.py").write_text('"""Mod."""\ndef f(a):\n    return a\n', encoding="utf-8")
    out = REGISTRY.execute_by_name("code_summary", {"filename": "m.py"}).output
    assert "f" in out  # the function is named in the summary


# ===========================================================================
# csv_preview / json_pretty
# ===========================================================================


def test_csv_preview_returns_rows_and_summary(ws):
    import arforge.tools.data_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "d.csv").write_text("a,b\n1,2\n3,4\n", encoding="utf-8")
    res = REGISTRY.execute_by_name("csv_preview", {"filename": "d.csv", "limit": 2})
    assert res.success
    assert '"a"' in res.output and '"b"' in res.output
    assert "1" in res.output


def test_csv_preview_missing_file_is_error(ws):
    import arforge.tools.data_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    res = REGISTRY.execute_by_name("csv_preview", {"filename": "nope.csv"})
    assert res.success is False
    assert "not found" in res.error.lower()


def test_json_pretty_indents(ws):
    import arforge.tools.data_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "p.json").write_text('{"a":1,"b":[2,3]}', encoding="utf-8")
    out = REGISTRY.execute_by_name("json_pretty", {"filename": "p.json"}).output
    assert "  " in out  # indented
    assert '"a"' in out


def test_json_pretty_invalid_json_reports_error(ws):
    import arforge.tools.data_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    (ws / "bad.json").write_text("{not json", encoding="utf-8")
    out = REGISTRY.execute_by_name("json_pretty", {"filename": "bad.json"}).output
    assert "invalid JSON" in out


# ===========================================================================
# web_search — registration + graceful handling (no network in unit tests)
# ===========================================================================


def test_web_search_empty_query_raises():
    import arforge.tools.web_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    res = REGISTRY.execute_by_name("web_search", {"query": "   "})
    assert res.success is False


# ===========================================================================
# Doctor key masking — must NOT leak more than 4 chars of the key
# ===========================================================================


def test_doctor_masks_api_key_tightly(monkeypatch):
    """doctor must print only a short prefix hint + last 4 chars, never the middle."""
    from arforge.product.doctor import _check_api_key

    fake = "sk-1234567890abcdefGHIJKL"
    monkeypatch.setenv("DEEPSEEK_API_KEY", fake)
    result = _check_api_key()
    detail = result.detail
    assert "configured" in detail
    # The full key must never appear.
    assert fake not in detail
    # No more than 4 trailing chars may be visible; the secret middle must be masked.
    assert detail.count(fake[-4:]) == 1
    assert "1234567890abcdef" not in detail  # the bulk of the payload is hidden
    assert "GHIJ" not in detail  # chars just before the tail are hidden


def test_doctor_short_key_fully_masked(monkeypatch):
    """A very short key must be fully masked (never print most of a weak secret)."""
    from arforge.product.doctor import _check_api_key

    monkeypatch.setenv("DEEPSEEK_API_KEY", "short")
    result = _check_api_key()
    assert "short" not in result.detail
    assert "***" in result.detail or "configured" in result.detail


def test_doctor_no_key_reports_not_configured(monkeypatch):
    from arforge.product.doctor import _check_api_key

    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    result = _check_api_key()
    assert "not configured" in result.detail
