"""P1 3.3: Test runner tests — detection, parsing, formatting."""

from __future__ import annotations

from pathlib import Path

from arforge.core.test_runner import (
    ParsedFailure,
    RunnerKind,
    detect_runner,
    format_failures_for_model,
    parse_failures,
)


class TestDetectRunner:
    def test_detects_pytest_by_config(self, tmp_path: Path):
        (tmp_path / "pytest.ini").write_text("[pytest]\n")
        (tmp_path / "test_foo.py").write_text("def test_ok(): pass\n")
        assert detect_runner(tmp_path) is RunnerKind.PYTEST

    def test_detects_jest_by_config(self, tmp_path: Path):
        (tmp_path / "package.json").write_text('{"scripts":{"test":"jest"}}')
        (tmp_path / "jest.config.js").write_text("module.exports = {};")
        assert detect_runner(tmp_path) is RunnerKind.JEST

    def test_detects_cargo(self, tmp_path: Path):
        (tmp_path / "Cargo.toml").write_text("[package]\nname = 'demo'\n")
        assert detect_runner(tmp_path) is RunnerKind.CARGO

    def test_detects_go(self, tmp_path: Path):
        (tmp_path / "go.mod").write_text("module example\n")
        assert detect_runner(tmp_path) is RunnerKind.GO

    def test_detects_pytest_from_test_file(self, tmp_path: Path):
        td = tmp_path / "tests"
        td.mkdir()
        (td / "test_stuff.py").write_text("import pytest\ndef test_one(): assert True\n")
        assert detect_runner(tmp_path) is RunnerKind.PYTEST

    def test_unknown_when_no_tests(self, tmp_path: Path):
        (tmp_path / "readme.md").write_text("# hello\n")
        assert detect_runner(tmp_path) is RunnerKind.UNKNOWN


class TestParseFailures:
    def test_parses_pytest_failure(self):
        output = """FAILED tests/test_calc.py::test_add - AssertionError: assert 5 == 6"""
        failures = parse_failures(output, RunnerKind.PYTEST)
        assert len(failures) == 1
        assert failures[0].file == "tests/test_calc.py"
        assert failures[0].test_name == "test_add"
        assert "AssertionError" in failures[0].message

    def test_parses_jest_failure(self):
        output = "● should return 42 › src/calc.test.ts:15\n  Expected: 42\n  Received: 0"
        failures = parse_failures(output, RunnerKind.JEST)
        assert len(failures) == 1
        assert failures[0].file == "src/calc.test.ts"
        assert failures[0].line == 15

    def test_parses_cargo_failure(self):
        output = "test tests::it_works ... FAILED"
        failures = parse_failures(output, RunnerKind.CARGO)
        assert len(failures) == 1
        assert failures[0].test_name == "tests::it_works"

    def test_parses_go_failure(self):
        output = "--- FAIL: TestAdd (0.00s)\n    calc_test.go:10: expected 5, got 4"
        failures = parse_failures(output, RunnerKind.GO)
        assert len(failures) == 1
        assert failures[0].test_name == "TestAdd"

    def test_parses_multiple_failures(self):
        output = """FAILED tests/a.py::test_x - ValueError: bad
FAILED tests/b.py::test_y - TypeError: wrong type"""
        failures = parse_failures(output, RunnerKind.PYTEST)
        assert len(failures) == 2

    def test_empty_on_all_pass(self):
        failures = parse_failures("all tests passed!", RunnerKind.PYTEST)
        assert failures == []


class TestFormatFailures:
    def test_formats_for_model_readability(self):
        failures = [
            ParsedFailure("tests/x.py", 10, "test_x", "ValueError", "bad value", "raw"),
            ParsedFailure("tests/y.py", None, "test_y", "TypeError", "bad type", "raw"),
        ]
        text = format_failures_for_model(failures)
        assert "2 test(s) failed" in text
        assert "tests/x.py:10" in text
        assert "tests/y.py" in text
        assert "ValueError" in text

    def test_all_pass_message(self):
        assert "All tests passed" in format_failures_for_model([])
