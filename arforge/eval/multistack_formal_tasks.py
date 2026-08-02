"""Cross-language, real-toolchain formal dogfood tasks.

The original formal suite deliberately exercises several coding behaviours in
Python. This companion suite holds the behaviour constant while changing the
language and toolchain. Failures therefore expose cross-language/tool-use
weaknesses instead of unrelated differences in task difficulty.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
import sqlite3
import subprocess
import uuid
from typing import Callable

from arforge.eval.runner import EvalTask
from arforge.core.test_runner import docker_runtime_available


@dataclass(frozen=True)
class StackScenario:
    stack_id: str
    language: str
    regression_path: str
    test_command: str
    setup: Callable[[Path, int, int], None]
    verify: Callable[[Path], bool]


def _write(root: Path, relative: str, content: str) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _run(command: list[str], workspace: Path, *, timeout: int = 180) -> bool:
    try:
        completed = subprocess.run(
            command,
            cwd=workspace,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _docker_run(
    workspace: Path,
    image: str,
    command: list[str],
    *,
    timeout: int = 180,
) -> bool:
    docker = shutil.which("docker")
    if not docker or not docker_runtime_available():
        return False
    name = f"arforge-formal-{uuid.uuid4().hex[:12]}"
    try:
        return _run(
            [
                docker,
                "run",
                "--name",
                name,
                "--rm",
                "-v",
                f"{workspace.resolve()}:/work",
                "-w",
                "/work",
                image,
                *command,
            ],
            workspace,
            timeout=timeout,
        )
    finally:
        subprocess.run(
            [docker, "rm", "-f", name],
            capture_output=True,
            timeout=20,
            check=False,
        )


def _prompt(scenario: StackScenario, threshold: int) -> str:
    if scenario.stack_id == "sql":
        return (
            "修复这个 SQL/SQLite 项目的 score_policy 数据完整性规则。"
            "threshold 必须大于等于 0，maximum 必须大于等于 threshold 且不能超过 1000。"
            "保持现有表名、列名和默认值，使用数据库自身约束拒绝非法数据，不能依赖应用层过滤。"
            f"新增 {scenario.regression_path}，写入多个合法边界样例并查询验证。"
            "最后用 SQLite 在全新内存数据库中依次执行 schema、contract 和 regression。"
        )
    verification_hint = ""
    if scenario.stack_id in {"c", "cpp"}:
        verification_hint = (
            "run_cmd 不支持 && 串联命令，请分别编译、分别运行；"
            "在 Windows PowerShell 上执行编译产物必须使用明确相对路径 "
            r"`.\contract.exe` 和 `.\regression.exe`（不能只写文件名，也不要用 `./`）。"
        )
    elif scenario.stack_id == "ruby":
        verification_hint = (
            "如果本机没有 ruby，不要尝试安装或搜索系统目录，"
            "直接调用 run_tests 并指定 framework=ruby；该工具会使用固定的安全容器回退。"
        )
    elif scenario.stack_id == "go":
        verification_hint = (
            "如果本机没有 go，不要安装或搜索系统目录，"
            "直接调用 run_tests 并指定 framework=go；该工具会使用固定 Go 容器验证。"
        )
    elif scenario.stack_id == "php":
        verification_hint = (
            "如果本机没有 php，直接调用 run_tests 并指定 framework=php；"
            "该工具会在固定 PHP 容器中依次运行所有测试文件。"
        )
    return (
        f"修复这个 {scenario.language} 项目的分数策略。"
        "classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 "
        '"invalid"，在 value 大于等于 threshold 时返回 "pass"，其余返回 "fail"。'
        "保持现有 Service/服务层 API 和项目结构，不要绕过策略层。"
        f"当前任务的主要阈值是 {threshold}，但实现不能把它写死。"
        f"新增 {scenario.regression_path}，覆盖负数、超过 maximum、阈值边界和自定义阈值。"
        f"最后运行 `{scenario.test_command}`，确认原有契约测试和新增回归测试全部通过。"
        f"{verification_hint}"
    )


def _setup_javascript(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "package.json",
        '{"name":"arforge-formal-js","private":true,"type":"module",'
        '"scripts":{"test":"node --test tests/*.test.js"}}\n',
    )
    _write(
        root,
        "src/policy.js",
        """export function classify(value, threshold, maximum) {
  // BUG: ignores range validation and the supplied threshold.
  return value >= 60 ? "pass" : "fail";
}
""",
    )
    _write(
        root,
        "src/service.js",
        """import { classify } from "./policy.js";
export const evaluateScore = (value, threshold, maximum) =>
  classify(value, threshold, maximum);
""",
    )
    _write(
        root,
        "tests/contract.test.js",
        f"""import test from "node:test";
import assert from "node:assert/strict";
import {{ evaluateScore }} from "../src/service.js";
test("public service honours the configured threshold", () => {{
  assert.equal(evaluateScore({threshold}, {threshold}, {maximum}), "pass");
  assert.equal(evaluateScore({threshold - 1}, {threshold}, {maximum}), "fail");
}});
""",
    )


def _verify_javascript(root: Path) -> bool:
    tests = sorted(str(path.relative_to(root)) for path in (root / "tests").glob("*.test.js"))
    return (root / "tests/regression.test.js").is_file() and _run(
        ["node", "--test", *tests], root
    )


def _setup_java(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "src/Policy.java",
        """public final class Policy {
    public static String classify(int value, int threshold, int maximum) {
        // BUG: ignores range validation and the supplied threshold.
        return value >= 60 ? "pass" : "fail";
    }
}
""",
    )
    _write(
        root,
        "src/ScoreService.java",
        """public final class ScoreService {
    public String evaluate(int value, int threshold, int maximum) {
        return Policy.classify(value, threshold, maximum);
    }
}
""",
    )
    _write(
        root,
        "tests/ContractTest.java",
        f"""public final class ContractTest {{
    public static void main(String[] args) {{
        ScoreService service = new ScoreService();
        if (!"pass".equals(service.evaluate({threshold}, {threshold}, {maximum}))) throw new AssertionError();
        if (!"fail".equals(service.evaluate({threshold - 1}, {threshold}, {maximum}))) throw new AssertionError();
    }}
}}
""",
    )


def _verify_java(root: Path) -> bool:
    regression = root / "tests/RegressionTest.java"
    javac = shutil.which("javac")
    java = shutil.which("java")
    if not regression.is_file() or not javac or not java:
        return False
    output = root / "out"
    output.mkdir(exist_ok=True)
    sources = sorted(str(path) for path in (root / "src").glob("*.java"))
    tests = sorted(str(path) for path in (root / "tests").glob("*.java"))
    return (
        _run([javac, "-d", str(output), *sources, *tests], root)
        and _run([java, "-cp", str(output), "ContractTest"], root)
        and _run([java, "-cp", str(output), "RegressionTest"], root)
    )


def _setup_go(root: Path, threshold: int, maximum: int) -> None:
    _write(root, "go.mod", "module example.com/arforge/formal\n\ngo 1.23\n")
    _write(
        root,
        "policy/policy.go",
        """package policy

func Classify(value, threshold, maximum int) string {
	// BUG: ignores range validation and the supplied threshold.
	if value >= 60 {
		return "pass"
	}
	return "fail"
}
""",
    )
    _write(
        root,
        "service/service.go",
        """package service

import "example.com/arforge/formal/policy"

func EvaluateScore(value, threshold, maximum int) string {
	return policy.Classify(value, threshold, maximum)
}
""",
    )
    _write(
        root,
        "service/contract_test.go",
        f"""package service

import "testing"

func TestConfiguredThreshold(t *testing.T) {{
	if EvaluateScore({threshold}, {threshold}, {maximum}) != "pass" {{ t.Fatal("threshold") }}
	if EvaluateScore({threshold - 1}, {threshold}, {maximum}) != "fail" {{ t.Fatal("below") }}
}}
""",
    )


def _verify_go(root: Path) -> bool:
    if not (root / "service/regression_test.go").is_file():
        return False
    go = shutil.which("go")
    if go:
        return _run([go, "test", "./..."], root)
    return _docker_run(root, "golang:1.24-alpine", ["go", "test", "./..."])


def _setup_rust(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "Cargo.toml",
        '[package]\nname="arforge-formal-rust"\nversion="0.1.0"\nedition="2021"\n',
    )
    _write(
        root,
        "src/lib.rs",
        """pub fn classify(value: i32, threshold: i32, maximum: i32) -> &'static str {
    // BUG: ignores range validation and the supplied threshold.
    if value >= 60 { "pass" } else { "fail" }
}

pub fn evaluate_score(value: i32, threshold: i32, maximum: i32) -> &'static str {
    classify(value, threshold, maximum)
}
""",
    )
    _write(
        root,
        "tests/contract.rs",
        f"""use arforge_formal_rust::evaluate_score;
#[test]
fn configured_threshold() {{
    assert_eq!(evaluate_score({threshold}, {threshold}, {maximum}), "pass");
    assert_eq!(evaluate_score({threshold - 1}, {threshold}, {maximum}), "fail");
}}
""",
    )


def _verify_rust(root: Path) -> bool:
    cargo = shutil.which("cargo")
    return bool(
        (root / "tests/regression.rs").is_file()
        and cargo
        and _run([cargo, "test", "--quiet"], root)
    )


def _setup_c(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "include/policy.h",
        """#ifndef POLICY_H
#define POLICY_H
const char *classify_score(int value, int threshold, int maximum);
const char *evaluate_score(int value, int threshold, int maximum);
#endif
""",
    )
    _write(
        root,
        "src/policy.c",
        """#include "policy.h"
const char *classify_score(int value, int threshold, int maximum) {
    /* BUG: ignores range validation and the supplied threshold. */
    return value >= 60 ? "pass" : "fail";
}
const char *evaluate_score(int value, int threshold, int maximum) {
    return classify_score(value, threshold, maximum);
}
""",
    )
    _write(
        root,
        "tests/contract.c",
        f"""#include <assert.h>
#include <string.h>
#include "policy.h"
int main(void) {{
    assert(strcmp(evaluate_score({threshold}, {threshold}, {maximum}), "pass") == 0);
    assert(strcmp(evaluate_score({threshold - 1}, {threshold}, {maximum}), "fail") == 0);
    return 0;
}}
""",
    )


def _verify_c(root: Path) -> bool:
    regression = root / "tests/regression.c"
    compiler = shutil.which("gcc") or shutil.which("clang")
    if not regression.is_file() or not compiler:
        return False
    common = [
        compiler,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Iinclude",
        "src/policy.c",
    ]
    return (
        _run([*common, "tests/contract.c", "-o", "contract.exe"], root)
        and _run([str(root / "contract.exe")], root)
        and _run([*common, "tests/regression.c", "-o", "regression.exe"], root)
        and _run([str(root / "regression.exe")], root)
    )


def _setup_cpp(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "include/policy.hpp",
        """#pragma once
#include <string>
std::string classify_score(int value, int threshold, int maximum);
std::string evaluate_score(int value, int threshold, int maximum);
""",
    )
    _write(
        root,
        "src/policy.cpp",
        """#include "policy.hpp"
std::string classify_score(int value, int threshold, int maximum) {
    // BUG: ignores range validation and the supplied threshold.
    return value >= 60 ? "pass" : "fail";
}
std::string evaluate_score(int value, int threshold, int maximum) {
    return classify_score(value, threshold, maximum);
}
""",
    )
    _write(
        root,
        "tests/contract.cpp",
        f"""#include <cassert>
#include "policy.hpp"
int main() {{
    assert(evaluate_score({threshold}, {threshold}, {maximum}) == "pass");
    assert(evaluate_score({threshold - 1}, {threshold}, {maximum}) == "fail");
}}
""",
    )


def _verify_cpp(root: Path) -> bool:
    regression = root / "tests/regression.cpp"
    compiler = shutil.which("g++") or shutil.which("clang++")
    if not regression.is_file() or not compiler:
        return False
    common = [
        compiler,
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Iinclude",
        "src/policy.cpp",
    ]
    return (
        _run([*common, "tests/contract.cpp", "-o", "contract.exe"], root)
        and _run([str(root / "contract.exe")], root)
        and _run([*common, "tests/regression.cpp", "-o", "regression.exe"], root)
        and _run([str(root / "regression.exe")], root)
    )


def _setup_csharp(root: Path, threshold: int, maximum: int) -> None:
    target_framework = "net8.0"
    dotnet = shutil.which("dotnet")
    if dotnet:
        try:
            version = subprocess.run(
                [dotnet, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            ).stdout.strip()
            major = version.split(".", 1)[0]
            if major.isdigit():
                target_framework = f"net{major}.0"
        except (OSError, subprocess.TimeoutExpired):
            pass
    _write(
        root,
        "Acceptance.csproj",
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>'
        f"<TargetFramework>{target_framework}</TargetFramework>"
        "<ImplicitUsings>enable</ImplicitUsings>"
        "<Nullable>enable</Nullable></PropertyGroup></Project>\n",
    )
    _write(
        root,
        "Policy.cs",
        """public static class Policy {
    public static string Classify(int value, int threshold, int maximum) {
        // BUG: ignores range validation and the supplied threshold.
        return value >= 60 ? "pass" : "fail";
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
        "Program.cs",
        f"""var service = new ScoreService();
if (service.Evaluate({threshold}, {threshold}, {maximum}) != "pass") throw new Exception("threshold");
if (service.Evaluate({threshold - 1}, {threshold}, {maximum}) != "fail") throw new Exception("below");
var regression = Type.GetType("RegressionChecks") ?? throw new Exception("RegressionChecks missing");
regression.GetMethod("Run")?.Invoke(null, null);
Console.WriteLine("PASS");
""",
    )


def _verify_csharp(root: Path) -> bool:
    dotnet = shutil.which("dotnet")
    return bool(
        (root / "RegressionChecks.cs").is_file()
        and dotnet
        and _run([dotnet, "run", "--project", "Acceptance.csproj"], root)
    )


def _setup_php(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "src/Policy.php",
        """<?php
function classify_score(int $value, int $threshold, int $maximum): string {
    // BUG: ignores range validation and the supplied threshold.
    return $value >= 60 ? "pass" : "fail";
}
function evaluate_score(int $value, int $threshold, int $maximum): string {
    return classify_score($value, $threshold, $maximum);
}
""",
    )
    _write(
        root,
        "tests/contract.php",
        f"""<?php
require __DIR__ . "/../src/Policy.php";
assert(evaluate_score({threshold}, {threshold}, {maximum}) === "pass");
assert(evaluate_score({threshold - 1}, {threshold}, {maximum}) === "fail");
""",
    )


def _verify_php(root: Path) -> bool:
    regression = root / "tests/regression.php"
    php = shutil.which("php")
    if regression.is_file() and php:
        flags = ["-d", "zend.assertions=1", "-d", "assert.exception=1"]
        return _run([php, *flags, "tests/contract.php"], root) and _run(
            [php, *flags, "tests/regression.php"], root
        )
    return (
        regression.is_file()
        and _docker_run(
            root,
            "php:8.4-cli-alpine",
            [
                "php",
                "-d",
                "zend.assertions=1",
                "-d",
                "assert.exception=1",
                "tests/contract.php",
            ],
        )
        and _docker_run(
            root,
            "php:8.4-cli-alpine",
            [
                "php",
                "-d",
                "zend.assertions=1",
                "-d",
                "assert.exception=1",
                "tests/regression.php",
            ],
        )
    )


def _setup_ruby(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "lib/policy.rb",
        """def classify_score(value, threshold, maximum)
  # BUG: ignores range validation and the supplied threshold.
  value >= 60 ? "pass" : "fail"
end

def evaluate_score(value, threshold, maximum)
  classify_score(value, threshold, maximum)
end
""",
    )
    _write(
        root,
        "tests/contract_test.rb",
        f"""require "minitest/autorun"
require_relative "../lib/policy"
class ContractTest < Minitest::Test
  def test_configured_threshold
    assert_equal "pass", evaluate_score({threshold}, {threshold}, {maximum})
    assert_equal "fail", evaluate_score({threshold - 1}, {threshold}, {maximum})
  end
end
""",
    )


def _verify_ruby(root: Path) -> bool:
    if not (root / "tests/regression_test.rb").is_file():
        return False
    command = [
        "ruby",
        "-Ilib",
        "-e",
        "Dir['tests/*_test.rb'].sort.each { |file| require_relative file }",
    ]
    ruby = shutil.which("ruby")
    if ruby:
        return _run([ruby, *command[1:]], root)
    return _docker_run(root, "ruby:3.4-alpine", command)


def stack_runtime_available(stack_id: str) -> bool:
    """Report whether a formal stack can be verified on this host."""
    executable = {
        "javascript": "node",
        "java": "javac",
        "go": "go",
        "rust": "cargo",
        "c": "gcc",
        "cpp": "g++",
        "csharp": "dotnet",
        "php": "php",
        "ruby": "ruby",
    }.get(stack_id)
    if stack_id == "sql":
        return True
    if executable and shutil.which(executable):
        return True
    return stack_id in {"go", "php", "ruby"} and docker_runtime_available()


def _setup_sql(root: Path, threshold: int, maximum: int) -> None:
    _write(
        root,
        "src/schema.sql",
        f"""CREATE TABLE score_policy (
  id INTEGER PRIMARY KEY,
  threshold INTEGER NOT NULL DEFAULT {threshold},
  maximum INTEGER NOT NULL DEFAULT {maximum},
  CHECK (threshold >= 0),
  CHECK (maximum >= threshold)
);
-- BUG: the required upper bound for maximum is missing.
""",
    )
    _write(
        root,
        "tests/contract.sql",
        f"""INSERT INTO score_policy(id, threshold, maximum) VALUES (1, {threshold}, {maximum});
SELECT threshold, maximum FROM score_policy WHERE id = 1;
""",
    )


def _verify_sql(root: Path) -> bool:
    regression = root / "tests/regression.sql"
    if not regression.is_file():
        return False
    try:
        connection = sqlite3.connect(":memory:")
        connection.executescript((root / "src/schema.sql").read_text(encoding="utf-8"))
        connection.executescript(
            (root / "tests/contract.sql").read_text(encoding="utf-8")
        )
        regression_sql = "\n".join(
            line
            for line in regression.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith(".")
        )
        connection.executescript(regression_sql)
        for values in ((-1, 100), (80, 70), (50, 1001)):
            try:
                connection.execute(
                    "INSERT INTO score_policy(threshold, maximum) VALUES (?, ?)",
                    values,
                )
            except sqlite3.IntegrityError:
                continue
            return False
    except (OSError, sqlite3.DatabaseError):
        return False
    finally:
        if "connection" in locals():
            connection.close()
    return True


SCENARIOS: tuple[StackScenario, ...] = (
    StackScenario(
        "javascript",
        "JavaScript/Node.js",
        "tests/regression.test.js",
        "npm test",
        _setup_javascript,
        _verify_javascript,
    ),
    StackScenario(
        "java",
        "Java",
        "tests/RegressionTest.java",
        "javac + java ContractTest/RegressionTest",
        _setup_java,
        _verify_java,
    ),
    StackScenario(
        "go",
        "Go",
        "service/regression_test.go",
        "go test ./...",
        _setup_go,
        _verify_go,
    ),
    StackScenario(
        "rust",
        "Rust",
        "tests/regression.rs",
        "cargo test",
        _setup_rust,
        _verify_rust,
    ),
    StackScenario(
        "c",
        "C",
        "tests/regression.c",
        "gcc 编译并运行 contract/regression",
        _setup_c,
        _verify_c,
    ),
    StackScenario(
        "cpp",
        "C++",
        "tests/regression.cpp",
        "g++ 编译并运行 contract/regression",
        _setup_cpp,
        _verify_cpp,
    ),
    StackScenario(
        "csharp",
        "C#/.NET",
        "RegressionChecks.cs",
        "dotnet run --project Acceptance.csproj",
        _setup_csharp,
        _verify_csharp,
    ),
    StackScenario(
        "php",
        "PHP",
        "tests/regression.php",
        "php tests/contract.php && php tests/regression.php",
        _setup_php,
        _verify_php,
    ),
    StackScenario(
        "ruby",
        "Ruby",
        "tests/regression_test.rb",
        "运行 tests/*_test.rb",
        _setup_ruby,
        _verify_ruby,
    ),
    StackScenario(
        "sql",
        "SQL/SQLite",
        "tests/regression.sql",
        "sqlite3 分别执行 contract.sql 和 regression.sql",
        _setup_sql,
        _verify_sql,
    ),
)


def builtin_multistack_formal_tasks() -> list[EvalTask]:
    """Return 50 model-driven tasks covering ten real language toolchains."""
    tasks: list[EvalTask] = []
    for scenario in SCENARIOS:
        for index in range(1, 6):
            threshold = 48 + index * 3
            maximum = 100 + index
            tasks.append(
                EvalTask(
                    task_id=f"multistack-{scenario.stack_id}-{index:02d}",
                    category=f"cross_language_{scenario.stack_id}",
                    prompt=_prompt(scenario, threshold),
                    setup=lambda workspace, s=scenario, t=threshold, m=maximum: s.setup(
                        workspace, t, m
                    ),
                    verify=lambda workspace, s=scenario: s.verify(workspace),
                    expected_files=[scenario.regression_path],
                    timeout_steps=40,
                )
            )
    return tasks
