from __future__ import annotations

from pathlib import Path

import pytest

from arforge.eval.multistack_formal_tasks import SCENARIOS, stack_runtime_available


def _write(root: Path, relative: str, content: str) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _solve_javascript(root: Path) -> None:
    _write(
        root,
        "src/policy.js",
        """export function classify(value, threshold, maximum) {
  if (value < 0 || value > maximum) return "invalid";
  return value >= threshold ? "pass" : "fail";
}
""",
    )
    _write(
        root,
        "tests/regression.test.js",
        """import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScore } from "../src/service.js";
test("range and custom threshold", () => {
  assert.equal(evaluateScore(-1, 70, 100), "invalid");
  assert.equal(evaluateScore(101, 70, 100), "invalid");
  assert.equal(evaluateScore(70, 70, 100), "pass");
  assert.equal(evaluateScore(69, 70, 100), "fail");
});
""",
    )


def _solve_java(root: Path) -> None:
    _write(
        root,
        "src/Policy.java",
        """public final class Policy {
    public static String classify(int value, int threshold, int maximum) {
        if (value < 0 || value > maximum) return "invalid";
        return value >= threshold ? "pass" : "fail";
    }
}
""",
    )
    _write(
        root,
        "tests/RegressionTest.java",
        """public final class RegressionTest {
    public static void main(String[] args) {
        ScoreService service = new ScoreService();
        if (!"invalid".equals(service.evaluate(-1, 70, 100))) throw new AssertionError();
        if (!"invalid".equals(service.evaluate(101, 70, 100))) throw new AssertionError();
        if (!"pass".equals(service.evaluate(70, 70, 100))) throw new AssertionError();
        if (!"fail".equals(service.evaluate(69, 70, 100))) throw new AssertionError();
    }
}
""",
    )


def _solve_go(root: Path) -> None:
    _write(
        root,
        "policy/policy.go",
        """package policy

func Classify(value, threshold, maximum int) string {
	if value < 0 || value > maximum { return "invalid" }
	if value >= threshold { return "pass" }
	return "fail"
}
""",
    )
    _write(
        root,
        "service/regression_test.go",
        """package service
import "testing"
func TestRangeAndCustomThreshold(t *testing.T) {
	cases := []struct{ value int; want string }{{-1, "invalid"}, {101, "invalid"}, {70, "pass"}, {69, "fail"}}
	for _, tc := range cases {
		if got := EvaluateScore(tc.value, 70, 100); got != tc.want { t.Fatalf("%d: %s", tc.value, got) }
	}
}
""",
    )


def _solve_rust(root: Path) -> None:
    _write(
        root,
        "src/lib.rs",
        """pub fn classify(value: i32, threshold: i32, maximum: i32) -> &'static str {
    if value < 0 || value > maximum { return "invalid"; }
    if value >= threshold { "pass" } else { "fail" }
}
pub fn evaluate_score(value: i32, threshold: i32, maximum: i32) -> &'static str {
    classify(value, threshold, maximum)
}
""",
    )
    _write(
        root,
        "tests/regression.rs",
        """use arforge_formal_rust::evaluate_score;
#[test]
fn range_and_custom_threshold() {
    assert_eq!(evaluate_score(-1, 70, 100), "invalid");
    assert_eq!(evaluate_score(101, 70, 100), "invalid");
    assert_eq!(evaluate_score(70, 70, 100), "pass");
    assert_eq!(evaluate_score(69, 70, 100), "fail");
}
""",
    )


def _solve_c(root: Path) -> None:
    _write(
        root,
        "src/policy.c",
        """#include "policy.h"
const char *classify_score(int value, int threshold, int maximum) {
    if (value < 0 || value > maximum) return "invalid";
    return value >= threshold ? "pass" : "fail";
}
const char *evaluate_score(int value, int threshold, int maximum) {
    return classify_score(value, threshold, maximum);
}
""",
    )
    _write(
        root,
        "tests/regression.c",
        """#include <assert.h>
#include <string.h>
#include "policy.h"
int main(void) {
    assert(strcmp(evaluate_score(-1, 70, 100), "invalid") == 0);
    assert(strcmp(evaluate_score(101, 70, 100), "invalid") == 0);
    assert(strcmp(evaluate_score(70, 70, 100), "pass") == 0);
    assert(strcmp(evaluate_score(69, 70, 100), "fail") == 0);
    return 0;
}
""",
    )


def _solve_cpp(root: Path) -> None:
    _write(
        root,
        "src/policy.cpp",
        """#include "policy.hpp"
std::string classify_score(int value, int threshold, int maximum) {
    if (value < 0 || value > maximum) return "invalid";
    return value >= threshold ? "pass" : "fail";
}
std::string evaluate_score(int value, int threshold, int maximum) {
    return classify_score(value, threshold, maximum);
}
""",
    )
    _write(
        root,
        "tests/regression.cpp",
        """#include <cassert>
#include "policy.hpp"
int main() {
    assert(evaluate_score(-1, 70, 100) == "invalid");
    assert(evaluate_score(101, 70, 100) == "invalid");
    assert(evaluate_score(70, 70, 100) == "pass");
    assert(evaluate_score(69, 70, 100) == "fail");
}
""",
    )


def _solve_csharp(root: Path) -> None:
    _write(
        root,
        "Policy.cs",
        """public static class Policy {
    public static string Classify(int value, int threshold, int maximum) {
        if (value < 0 || value > maximum) return "invalid";
        return value >= threshold ? "pass" : "fail";
    }
}
public sealed class ScoreService {
    public string Evaluate(int value, int threshold, int maximum) =>
        Policy.Classify(value, threshold, maximum);
}
""",
    )
    _write(
        root,
        "RegressionChecks.cs",
        """public static class RegressionChecks {
    public static void Run() {
        var service = new ScoreService();
        if (service.Evaluate(-1, 70, 100) != "invalid") throw new Exception();
        if (service.Evaluate(101, 70, 100) != "invalid") throw new Exception();
        if (service.Evaluate(70, 70, 100) != "pass") throw new Exception();
        if (service.Evaluate(69, 70, 100) != "fail") throw new Exception();
    }
}
""",
    )


def _solve_php(root: Path) -> None:
    _write(
        root,
        "src/Policy.php",
        """<?php
function classify_score(int $value, int $threshold, int $maximum): string {
    if ($value < 0 || $value > $maximum) return "invalid";
    return $value >= $threshold ? "pass" : "fail";
}
function evaluate_score(int $value, int $threshold, int $maximum): string {
    return classify_score($value, $threshold, $maximum);
}
""",
    )
    _write(
        root,
        "tests/regression.php",
        """<?php
require __DIR__ . "/../src/Policy.php";
assert(evaluate_score(-1, 70, 100) === "invalid");
assert(evaluate_score(101, 70, 100) === "invalid");
assert(evaluate_score(70, 70, 100) === "pass");
assert(evaluate_score(69, 70, 100) === "fail");
""",
    )


def _solve_ruby(root: Path) -> None:
    _write(
        root,
        "lib/policy.rb",
        """def classify_score(value, threshold, maximum)
  return "invalid" if value.negative? || value > maximum
  value >= threshold ? "pass" : "fail"
end
def evaluate_score(value, threshold, maximum)
  classify_score(value, threshold, maximum)
end
""",
    )
    _write(
        root,
        "tests/regression_test.rb",
        """require "minitest/autorun"
require_relative "../lib/policy"
class RegressionTest < Minitest::Test
  def test_range_and_custom_threshold
    assert_equal "invalid", evaluate_score(-1, 70, 100)
    assert_equal "invalid", evaluate_score(101, 70, 100)
    assert_equal "pass", evaluate_score(70, 70, 100)
    assert_equal "fail", evaluate_score(69, 70, 100)
  end
end
""",
    )


def _solve_sql(root: Path) -> None:
    schema = (root / "src/schema.sql").read_text(encoding="utf-8")
    schema = schema.replace(
        "CHECK (maximum >= threshold)",
        "CHECK (maximum >= threshold),\n  CHECK (maximum <= 1000)",
    )
    _write(root, "src/schema.sql", schema)
    _write(
        root,
        "tests/regression.sql",
        """INSERT INTO score_policy(id, threshold, maximum) VALUES (2, 0, 0);
INSERT INTO score_policy(id, threshold, maximum) VALUES (3, 999, 1000);
SELECT id, threshold, maximum FROM score_policy ORDER BY id;
""",
    )


SOLVERS = {
    "javascript": _solve_javascript,
    "java": _solve_java,
    "go": _solve_go,
    "rust": _solve_rust,
    "c": _solve_c,
    "cpp": _solve_cpp,
    "csharp": _solve_csharp,
    "php": _solve_php,
    "ruby": _solve_ruby,
    "sql": _solve_sql,
}


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda item: item.stack_id)
def test_reference_solution_is_accepted_by_real_toolchain(tmp_path, scenario):
    if not stack_runtime_available(scenario.stack_id):
        pytest.skip(f"{scenario.stack_id} runtime is not available on this host")
    workspace = tmp_path / scenario.stack_id
    workspace.mkdir()
    scenario.setup(workspace, 57, 103)
    SOLVERS[scenario.stack_id](workspace)

    assert scenario.verify(workspace) is True


@pytest.mark.parametrize("stack_id", ["go", "ruby", "php", "csharp"])
def test_agent_run_tests_supports_missing_and_native_runtimes(tmp_path, stack_id):
    from arforge.tools.file_tools import get_workspace, set_workspace
    from arforge.tools.test_runner_tools import run_tests_tool

    if not stack_runtime_available(stack_id):
        pytest.skip(f"{stack_id} runtime is not available on this host")
    scenario = next(item for item in SCENARIOS if item.stack_id == stack_id)
    scenario.setup(tmp_path, 57, 103)
    SOLVERS[stack_id](tmp_path)
    original = get_workspace()
    try:
        set_workspace(tmp_path)
        result = run_tests_tool(framework=stack_id if stack_id != "csharp" else "dotnet")
    finally:
        set_workspace(original)

    expected = stack_id if stack_id != "csharp" else "dotnet"
    assert result.startswith(f"Tests passed | framework={expected}")
