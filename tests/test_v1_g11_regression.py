"""v1-G11 回归保护（regression）测试。"""

from __future__ import annotations

from arforge.core.regression import locate_impacted_tests, run_pytest


# -- locate_impacted_tests ----------------------------------------------------


def test_locate_test_file_itself(tmp_path):
    (tmp_path / "test_foo.py").write_text("", encoding="utf-8")
    found = locate_impacted_tests(["test_foo.py"], tmp_path)
    assert str(tmp_path / "test_foo.py") in found


def test_locate_sibling_test(tmp_path):
    (tmp_path / "foo.py").write_text("", encoding="utf-8")
    (tmp_path / "test_foo.py").write_text("", encoding="utf-8")
    found = locate_impacted_tests(["foo.py"], tmp_path)
    assert str(tmp_path / "test_foo.py") in found


def test_locate_tests_dir(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_bar.py").write_text("", encoding="utf-8")
    found = locate_impacted_tests(["bar.py"], tmp_path)
    assert str(tmp_path / "tests" / "test_bar.py") in found


def test_locate_none_when_no_test(tmp_path):
    (tmp_path / "baz.py").write_text("", encoding="utf-8")
    assert locate_impacted_tests(["baz.py"], tmp_path) == []


def test_locate_skips_non_py(tmp_path):
    assert locate_impacted_tests(["readme.md", "data.json"], tmp_path) == []


def test_locate_dedup(tmp_path):
    (tmp_path / "test_foo.py").write_text("", encoding="utf-8")
    found = locate_impacted_tests(["test_foo.py", "test_foo.py"], tmp_path)
    assert found.count(str(tmp_path / "test_foo.py")) == 1


# -- run_pytest ---------------------------------------------------------------


def test_run_pytest_empty():
    res = run_pytest([], ".")
    assert res["ran"] is False


def test_run_pytest_passing(tmp_path):
    t = tmp_path / "test_ok.py"
    t.write_text("def test_one():\n    assert 1 + 1 == 2\n", encoding="utf-8")
    res = run_pytest([str(t)], tmp_path)
    assert res["ran"] is True
    assert res["passed"] == 1
    assert res["failed"] == 0
    assert res["returncode"] == 0


def test_run_pytest_failing(tmp_path):
    t = tmp_path / "test_bad.py"
    t.write_text("def test_one():\n    assert False\n", encoding="utf-8")
    res = run_pytest([str(t)], tmp_path)
    assert res["ran"] is True
    assert res["failed"] == 1
    assert res["returncode"] != 0


# -- run_impacted_tests 工具 --------------------------------------------------


def test_tool_reports_no_impacted_tests():
    import arforge.tools.regression_tools  # noqa: F401  触发注册
    from arforge.core.change_tracker import reset_change_tracker
    from arforge.tool_registry import REGISTRY

    reset_change_tracker()  # 无改动 → 无关联测试
    res = REGISTRY.execute_by_name("run_impacted_tests", {})
    assert res.success
    assert "未找到" in res.output


def test_tool_registered_workspace_cmd():
    import arforge.tools.regression_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("run_impacted_tests")
    assert tool is not None
    assert tool.schema.category == "workspace_cmd"
