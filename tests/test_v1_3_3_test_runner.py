"""v1-3.3 统一 test runner（test_runner）测试。"""

from __future__ import annotations

import threading

import pytest

from arforge.core.test_runner import (
    RunnerKind,
    _bounded_runner_output,
    detect_test_framework,
    parse_failures,
    parse_output,
    run_tests,
)


# -- detect_test_framework ----------------------------------------------------


def test_detect_pytest_pyproject(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    assert detect_test_framework(tmp_path) == "pytest"


def test_detect_pytest_tests_dir(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_x.py").write_text("def test_a(): pass\n", encoding="utf-8")
    assert detect_test_framework(tmp_path) == "pytest"


def test_detect_jest(tmp_path):
    (tmp_path / "package.json").write_text('{"devDependencies": {"jest": "^29"}}', encoding="utf-8")
    assert detect_test_framework(tmp_path) == "jest"


def test_detect_jest_via_test_script(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts": {"test": "jest --ci"}}', encoding="utf-8")
    assert detect_test_framework(tmp_path) == "jest"


def test_detect_node_via_test_script(tmp_path):
    (tmp_path / "package.json").write_text(
        '{"scripts": {"test": "node --test"}}', encoding="utf-8"
    )
    assert detect_test_framework(tmp_path) == "node"


def test_detect_node_via_typescript_test(tmp_path):
    (tmp_path / "math.test.ts").write_text(
        "import test from 'node:test';\n", encoding="utf-8"
    )
    assert detect_test_framework(tmp_path) == "node"


def test_detect_cargo(tmp_path):
    (tmp_path / "Cargo.toml").write_text("[package]\nname='x'\n", encoding="utf-8")
    assert detect_test_framework(tmp_path) == "cargo"


def test_detect_go(tmp_path):
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
    assert detect_test_framework(tmp_path) == "go"


def test_detect_ruby_minitest(tmp_path):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "policy_test.rb").write_text(
        'require "minitest/autorun"\n', encoding="utf-8"
    )

    assert detect_test_framework(tmp_path) == "ruby"


def test_detect_dotnet_project(tmp_path):
    (tmp_path / "Acceptance.csproj").write_text(
        "<Project Sdk=\"Microsoft.NET.Sdk\" />\n", encoding="utf-8"
    )

    assert detect_test_framework(tmp_path) == "dotnet"


def test_detect_php_tests(tmp_path):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "contract.php").write_text("<?php assert(true);\n", encoding="utf-8")

    assert detect_test_framework(tmp_path) == "php"


def test_detect_none(tmp_path):
    assert detect_test_framework(tmp_path) is None


def test_detect_priority_cargo_over_pytest(tmp_path):
    (tmp_path / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("[tool.x]\n", encoding="utf-8")
    assert detect_test_framework(tmp_path) == "cargo"


# -- parse_output（真实样例输出）---------------------------------------------


def test_parse_pytest():
    assert parse_output("pytest", "... 12 passed, 1 failed in 0.3s") == (12, 1)


def test_large_runner_output_preserves_final_summary():
    output = "diagnostic line\n" * 2000 + "2735 passed, 1 skipped in 400.0s"

    bounded = _bounded_runner_output(output)

    assert len(bounded) == 12000
    assert "test output truncated" in bounded
    assert bounded.endswith("2735 passed, 1 skipped in 400.0s")
    assert parse_output("pytest", output) == (2735, 0)


def test_parse_jest():
    out = "Tests:       1 failed, 9 passed, 10 total"
    assert parse_output("jest", out) == (9, 1)


def test_parse_node_tap_counts_and_failure():
    out = "not ok 2 - rejects invalid input\n# tests 3\n# pass 2\n# fail 1\n"
    assert parse_output("node", out) == (2, 1)
    failures = parse_failures(out, RunnerKind.NODE)
    assert len(failures) == 1
    assert failures[0].test_name == "rejects invalid input"


def test_parse_node_24_spec_output_deduplicates_failures():
    out = (
        "✖ rejects invalid input (0.8ms)\n"
        "✔ accepts valid input (0.1ms)\n"
        "ℹ pass 1\n"
        "ℹ fail 1\n"
        "✖ failing tests:\n\n"
        "✖ rejects invalid input (0.8ms)\n"
    )
    assert parse_output("node", out) == (1, 1)
    failures = parse_failures(out, RunnerKind.NODE)
    assert [failure.test_name for failure in failures] == ["rejects invalid input"]


def test_parse_cargo():
    out = "test result: ok. 5 passed; 0 failed; 0 ignored"
    assert parse_output("cargo", out) == (5, 0)


def test_parse_go_pass_fail_lines():
    out = "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- PASS: TestC (0.00s)\nFAIL"
    assert parse_output("go", out) == (2, 1)


def test_parse_go_package_level():
    assert parse_output("go", "ok   example.com/x   0.012s") == (1, 0)


def test_parse_ruby_minitest_counts():
    output = "14 runs, 18 assertions, 1 failures, 1 errors, 0 skips"

    assert parse_output("ruby", output) == (12, 2)
    failures = parse_failures(output, RunnerKind.RUBY)
    assert len(failures) == 1
    assert failures[0].error_type == "ruby_test_failure"


# -- run_tests（pytest 真跑）-------------------------------------------------


def test_run_tests_no_framework(tmp_path):
    r = run_tests(tmp_path)
    assert r["ran"] is False
    assert r["framework"] is None
    assert r["summary"] == r["output"]


def test_run_tests_pytest_real(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    (tmp_path / "test_sample.py").write_text(
        "def test_pass():\n    assert 1 == 1\n", encoding="utf-8"
    )
    r = run_tests(tmp_path)
    assert r["framework"] == "pytest"
    assert r["ran"] is True
    assert r["passed"] == 1
    assert r["failed"] == 0


def test_run_tests_pytest_failure(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    (tmp_path / "test_bad.py").write_text(
        "def test_fail():\n    assert False\n", encoding="utf-8"
    )
    r = run_tests(tmp_path)
    assert r["failed"] == 1
    assert r["returncode"] != 0


def test_run_tests_defaults_to_no_timeout_and_supports_cancellation(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    (tmp_path / "test_slow.py").write_text(
        "import time\ndef test_slow():\n    time.sleep(0.2)\n    assert True\n",
        encoding="utf-8",
    )

    completed = run_tests(tmp_path)
    assert completed.returncode == 0
    assert completed.passed == 1

    cancel_event = threading.Event()
    cancel_event.set()
    cancelled = run_tests(tmp_path, cancel_event=cancel_event)
    assert cancelled.returncode == 130
    assert "cancelled by user" in cancelled.output


def test_run_tests_node_real(tmp_path):
    (tmp_path / "package.json").write_text(
        '{"scripts": {"test": "node --test"}, "type": "module"}',
        encoding="utf-8",
    )
    (tmp_path / "math.test.js").write_text(
        "import test from 'node:test';\n"
        "import assert from 'node:assert/strict';\n"
        "test('adds', () => assert.equal(1 + 1, 2));\n",
        encoding="utf-8",
    )
    r = run_tests(tmp_path)
    assert r["framework"] == "node"
    assert r["ran"] is True
    assert r["passed"] == 1
    assert r["failed"] == 0


def test_agent_run_tests_supports_exact_safe_targets(tmp_path):
    from arforge.tools.file_tools import get_workspace, set_workspace
    from arforge.tools.test_runner_tools import run_tests_tool

    old_workspace = get_workspace()
    tests_dir = tmp_path / "tests"
    tests_dir.mkdir()
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    (tests_dir / "test_selected.py").write_text(
        "def test_selected():\n    assert True\n",
        encoding="utf-8",
    )
    (tests_dir / "test_unselected.py").write_text(
        "def test_unselected():\n    assert False\n",
        encoding="utf-8",
    )
    try:
        set_workspace(tmp_path)
        output = run_tests_tool(
            framework="pytest",
            targets=["tests/test_selected.py"],
        )
        assert output == (
            "Tests passed | framework=pytest | passed=1 | failed=0 | exit=0 | "
            "targets=tests/test_selected.py"
        )
        assert "test_unselected" not in output
        with pytest.raises(ValueError, match="escapes the workspace"):
            run_tests_tool(framework="pytest", targets=["../outside.py"])
        with pytest.raises(FileNotFoundError, match="does not exist"):
            run_tests_tool(framework="pytest", targets=["tests/missing.py"])
    finally:
        set_workspace(old_workspace)


def test_agent_run_tests_keeps_failure_diagnostics(tmp_path):
    from arforge.tools.file_tools import get_workspace, set_workspace
    from arforge.tools.test_runner_tools import run_tests_tool

    old_workspace = get_workspace()
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    bad = tmp_path / "test_diagnostic.py"
    bad.write_text(
        "def test_diagnostic():\n"
        "    assert 'actual-value' == 'expected-value'\n",
        encoding="utf-8",
    )
    try:
        set_workspace(tmp_path)
        with pytest.raises(RuntimeError) as raised:
            run_tests_tool(framework="pytest", targets=["test_diagnostic.py"])
        message = str(raised.value)
        assert "1 failed" in message
        assert "actual-value" in message
        assert "expected-value" in message
    finally:
        set_workspace(old_workspace)


def test_agent_run_tests_surfaces_failed_process_as_tool_failure(tmp_path):
    from arforge.tools.file_tools import get_workspace, set_workspace
    from arforge.tools.test_runner_tools import run_tests_tool

    old_workspace = get_workspace()
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    bad = tmp_path / "test_bad.py"
    bad.write_text("def test_bad():\n    assert False\n", encoding="utf-8")
    try:
        set_workspace(tmp_path)
        with pytest.raises(RuntimeError, match="1 failed"):
            run_tests_tool(framework="pytest", targets=["test_bad.py"])
    finally:
        set_workspace(old_workspace)


def test_agent_run_tests_without_deadline_honors_operation_cancellation(tmp_path):
    from arforge.tools.basic_tools import command_cancellation_scope
    from arforge.tools.file_tools import get_workspace, set_workspace
    from arforge.tools.test_runner_tools import run_tests_tool

    old_workspace = get_workspace()
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    (tmp_path / "test_slow.py").write_text(
        "import time\ndef test_slow():\n    time.sleep(5)\n",
        encoding="utf-8",
    )
    cancel_event = threading.Event()
    cancel_event.set()
    try:
        set_workspace(tmp_path)
        with command_cancellation_scope(cancel_event):
            with pytest.raises(InterruptedError, match="cancelled by user"):
                run_tests_tool(framework="pytest")
    finally:
        set_workspace(old_workspace)
