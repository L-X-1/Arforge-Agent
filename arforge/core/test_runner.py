"""P1 3.3: Unified test runner — detect, run, parse failures across frameworks.

Supports: pytest, Node's built-in test runner, Jest, cargo test, go test.
Returns structured failure data that the agentic loop can feed back to the model
for self-correction.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class RunnerKind(Enum):
    PYTEST = "pytest"
    NODE = "node"
    JEST = "jest"
    CARGO = "cargo"
    GO = "go"
    RUBY = "ruby"
    DOTNET = "dotnet"
    PHP = "php"
    UNKNOWN = "unknown"


# ---------- detection ----------

_FRAMEWORK_FILES: dict[str, RunnerKind] = {
    "pytest.ini": RunnerKind.PYTEST,
    "pyproject.toml": RunnerKind.PYTEST,  # checked further for pytest config
    "setup.cfg": RunnerKind.PYTEST,
    "tox.ini": RunnerKind.PYTEST,
    "jest.config.js": RunnerKind.JEST,
    "jest.config.ts": RunnerKind.JEST,
    "package.json": RunnerKind.JEST,  # checked for jest script
    "Cargo.toml": RunnerKind.CARGO,
    "go.mod": RunnerKind.GO,
    "Gemfile": RunnerKind.RUBY,
    "composer.json": RunnerKind.PHP,
}

_PYTEST_PATTERNS = ("def test_", "class Test", "import pytest")
_JEST_PATTERNS = ("test(", "it(", "describe(", "expect(")


def detect_runner(workspace: Path) -> RunnerKind:
    """Detect the primary test framework for a workspace."""
    if any(workspace.glob("*.csproj")) or any(workspace.glob("*.sln")):
        return RunnerKind.DOTNET
    # Check config files first
    for filename, framework in _FRAMEWORK_FILES.items():
        if (workspace / filename).exists():
            if framework is RunnerKind.PYTEST and filename == "pyproject.toml":
                # Verify it actually has pytest config
                try:
                    content = (workspace / filename).read_text(encoding="utf-8")
                    if "[tool.pytest" not in content and "pytest" not in content:
                        continue
                except (OSError, UnicodeDecodeError):
                    continue
            if framework is RunnerKind.JEST and filename == "package.json":
                try:
                    content = (workspace / filename).read_text(encoding="utf-8")
                    lowered = content.lower()
                    if "jest" in lowered:
                        return RunnerKind.JEST
                    if re.search(r'"test"\s*:\s*"[^"]*node\s+--test', lowered):
                        return RunnerKind.NODE
                    continue
                except (OSError, UnicodeDecodeError):
                    continue
            return framework

    # Look for test files
    test_dirs = list(workspace.glob("test*")) + list(workspace.glob("tests"))
    all_test_files = []
    for td in test_dirs:
        if td.is_dir():
            all_test_files.extend(td.rglob("*.py"))
            all_test_files.extend(td.rglob("*.test.*"))
            all_test_files.extend(td.rglob("*.spec.*"))
            all_test_files.extend(td.rglob("*_test.rb"))
            all_test_files.extend(td.rglob("*.php"))

    if not all_test_files:
        all_test_files = (
            list(workspace.rglob("test_*.py"))
            + list(workspace.rglob("*_test.py"))
            + list(workspace.rglob("*_test.rb"))
            + list(workspace.rglob("tests/*.php"))
        )
        for pattern in (
            "*.test.js",
            "*.test.mjs",
            "*.test.cjs",
            "*.test.ts",
            "*.spec.js",
            "*.spec.mjs",
            "*.spec.cjs",
            "*.spec.ts",
        ):
            all_test_files.extend(workspace.rglob(pattern))

    for tf in all_test_files[:20]:
        try:
            content = tf.read_text(encoding="utf-8")[:2000]
            if any(p in content for p in _PYTEST_PATTERNS):
                return RunnerKind.PYTEST
            if "node:test" in content:
                return RunnerKind.NODE
            if tf.suffix == ".rb" or "minitest" in content:
                return RunnerKind.RUBY
            if tf.suffix == ".php":
                return RunnerKind.PHP
            if any(p in content for p in _JEST_PATTERNS):
                return RunnerKind.JEST
        except (OSError, UnicodeDecodeError):
            continue

    return RunnerKind.UNKNOWN


# ---------- execution ----------

_RUNNER_COMMANDS: dict[RunnerKind, list[str]] = {
    RunnerKind.PYTEST: ["python", "-m", "pytest", "-v", "--tb=short"],
    RunnerKind.NODE: ["node", "--test"],
    RunnerKind.JEST: ["npx", "jest", "--verbose", "--no-coverage"],
    RunnerKind.CARGO: ["cargo", "test"],
    RunnerKind.GO: ["go", "test", "./..."],
    RunnerKind.RUBY: [
        "ruby",
        "-Ilib",
        "-e",
        "Dir['tests/*_test.rb'].sort.each { |file| require_relative file }",
    ],
    RunnerKind.DOTNET: ["dotnet", "test"],
    RunnerKind.PHP: ["php", "-v"],
}


def docker_runtime_available(*, timeout: float = 3.0) -> bool:
    """Return whether Docker's CLI and engine are both usable.

    A Docker Desktop installation leaves ``docker.exe`` on ``PATH`` even when
    its engine is stopped. Treating the executable alone as availability sends
    test runs into a misleading named-pipe failure instead of using a native
    runtime or reporting that no runtime is available.
    """
    docker = shutil.which("docker")
    if not docker:
        return False
    try:
        result = subprocess.run(
            [docker, "info", "--format", "{{.ServerVersion}}"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _bounded_runner_output(output: str, limit: int = 12000) -> str:
    """Keep diagnostics and the final test summary when runner output is large."""
    text = str(output or "").strip()
    if len(text) <= limit:
        return text
    marker = "\n...[test output truncated; final summary preserved]...\n"
    available = max(0, limit - len(marker))
    head = available * 2 // 3
    tail = available - head
    return text[:head] + marker + text[-tail:]


def _runner_command(workspace: Path, framework: RunnerKind) -> list[str]:
    """Resolve the project's Python before falling back to the host PATH."""
    if framework is RunnerKind.GO and not shutil.which("go"):
        docker = shutil.which("docker")
        if docker and docker_runtime_available():
            container_name = f"arforge-tests-{uuid.uuid4().hex[:12]}"
            return [
                docker,
                "run",
                "--name",
                container_name,
                "--rm",
                "-v",
                f"{workspace.resolve()}:/work",
                "-w",
                "/work",
                "golang:1.24-alpine",
                "go",
                "test",
                "./...",
            ]
    if framework is RunnerKind.RUBY and not shutil.which("ruby"):
        docker = shutil.which("docker")
        if docker and docker_runtime_available():
            container_name = f"arforge-tests-{uuid.uuid4().hex[:12]}"
            return [
                docker,
                "run",
                "--name",
                container_name,
                "--rm",
                "-v",
                f"{workspace.resolve()}:/work",
                "-w",
                "/work",
                "ruby:3.4-alpine",
                "ruby",
                "-Ilib",
                "-e",
                "Dir['tests/*_test.rb'].sort.each { |file| require_relative file }",
            ]
    if framework is RunnerKind.PHP and not shutil.which("php"):
        docker = shutil.which("docker")
        if docker and docker_runtime_available():
            container_name = f"arforge-tests-{uuid.uuid4().hex[:12]}"
            return [
                docker,
                "run",
                "--name",
                container_name,
                "--rm",
                "-v",
                f"{workspace.resolve()}:/work",
                "-w",
                "/work",
                "php:8.4-cli-alpine",
                "sh",
                "-lc",
                "set -e; for file in tests/*.php; do "
                'php -d zend.assertions=1 -d assert.exception=1 "$file"; done',
            ]
    if framework is RunnerKind.DOTNET:
        projects = sorted(workspace.glob("*.csproj"))
        if len(projects) == 1:
            content = projects[0].read_text(encoding="utf-8", errors="replace")
            action = "run" if "<OutputType>Exe</OutputType>" in content else "test"
            return ["dotnet", action, "--project", projects[0].name]
        solutions = sorted(workspace.glob("*.sln"))
        if len(solutions) == 1:
            return ["dotnet", "test", solutions[0].name]
    if framework is not RunnerKind.PYTEST:
        return list(_RUNNER_COMMANDS[framework])
    candidates = (
        workspace / ".venv" / "Scripts" / "python.exe",
        workspace / ".venv" / "bin" / "python",
        workspace / "venv" / "Scripts" / "python.exe",
        workspace / "venv" / "bin" / "python",
    )
    for candidate in candidates:
        if candidate.is_file():
            return [str(candidate), "-m", "pytest", "-v", "--tb=short"]
    if not getattr(sys, "frozen", False):
        return [sys.executable, "-m", "pytest", "-v", "--tb=short"]
    return list(_RUNNER_COMMANDS[framework])


def run_tests(
    workspace: Path,
    framework: RunnerKind | None = None,
    *,
    extra_args: list[str] | None = None,
    timeout: int | None = 0,
    cancel_event: threading.Event | None = None,
) -> TestRunResult:
    """Run tests in workspace.

    The returned object supports both modern tuple-unpack
    ``exit_code, output = run_tests(...)`` and legacy dict-style access such as
    ``result["passed"]``.
    """
    if framework is None:
        framework = detect_runner(workspace)
    if framework is RunnerKind.UNKNOWN:
        return TestRunResult(
            framework=None,
            ran=False,
            returncode=0,
            output="No supported test framework detected.",
            passed=0,
            failed=0,
        )
    cmd = _runner_command(workspace, framework)
    if extra_args:
        cmd.extend(extra_args)
    if timeout is not None and timeout < 0:
        raise ValueError("timeout must be non-negative")
    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(workspace),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        deadline = (
            time.monotonic() + timeout
            if timeout is not None and timeout > 0
            else None
        )
        while True:
            if cancel_event is not None and cancel_event.is_set():
                process.kill()
                stdout, stderr = process.communicate()
                full_output = (stdout + "\n" + stderr).strip()
                output = _bounded_runner_output(
                    f"{full_output}\nTest run cancelled by user."
                )
                return TestRunResult(
                    framework=framework.value,
                    ran=True,
                    returncode=130,
                    output=output,
                    passed=0,
                    failed=0,
                )
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                process.kill()
                process.communicate()
                return TestRunResult(
                    framework=framework.value,
                    ran=True,
                    returncode=1,
                    output="Test run timed out.",
                    passed=0,
                    failed=1,
                )
            try:
                stdout, stderr = process.communicate(
                    timeout=0.1 if remaining is None else min(0.1, remaining)
                )
                break
            except subprocess.TimeoutExpired:
                continue
        full_output = (stdout + "\n" + stderr).strip()
        passed, failed = parse_output(framework, full_output)
        if process.returncode == 0 and passed == 0 and failed == 0:
            passed = 1
        elif process.returncode != 0 and failed == 0:
            failed = 1
        output = _bounded_runner_output(full_output)
        return TestRunResult(
            framework=framework.value,
            ran=True,
            returncode=process.returncode,
            output=output,
            passed=passed,
            failed=failed,
        )
    except FileNotFoundError as exc:
        return TestRunResult(framework=framework.value, ran=True, returncode=1, output=f"Test runner not available: {exc}", passed=0, failed=1)
    except Exception as exc:
        return TestRunResult(framework=framework.value, ran=True, returncode=1, output=f"Test run failed: {exc}", passed=0, failed=1)
    finally:
        if len(cmd) >= 4 and Path(cmd[0]).name.casefold() in {
            "docker",
            "docker.exe",
        }:
            try:
                name_index = cmd.index("--name") + 1
                container_name = cmd[name_index]
            except (ValueError, IndexError):
                container_name = ""
            if container_name:
                subprocess.run(
                    [cmd[0], "rm", "-f", container_name],
                    capture_output=True,
                    timeout=20,
                    check=False,
                )


# ---------- parsing ----------

@dataclass
class ParsedFailure:
    """One parsed test failure."""
    file: str
    line: int | None
    test_name: str
    error_type: str
    message: str
    raw: str  # original fragment


@dataclass
class TestRunResult:
    """Compatibility result for both tuple-unpack and dict-style callers."""

    framework: str | None
    ran: bool
    returncode: int
    output: str
    passed: int
    failed: int

    @property
    def summary(self) -> str:
        """Backward-compatible human-readable summary used by agent tools."""
        return self.output

    def __iter__(self):
        yield self.returncode
        yield self.output

    def __getitem__(self, key: str):
        return getattr(self, key)


# pytest pattern: FAILED tests/test_foo.py::test_bar - AssertionError: ...
_PYTEST_FAIL = re.compile(
    r"FAILED\s+(?P<file>[^\s:]+?)(?:::(?P<test>[^\s]+))?\s*[-–]\s*(?P<error>[^\n]+)"
)
# jest pattern: ● test name › file:line
_JEST_FAIL = re.compile(
    r"[●]\s+(?P<test>.+?)(?:\s*›\s*|\n.*?)(?P<file>[^\s:]+?):(?P<line>\d+)"
)
# Node TAP output: ``not ok 2 - test name``.
_NODE_FAIL = re.compile(r"(?m)^not ok\s+\d+\s+-\s+(?P<test>.+?)\s*$")
# Node 24 defaults to the spec reporter: ``✖ test name (1.23ms)``.
_NODE_SPEC_FAIL = re.compile(r"(?m)^\u2716\s+(?P<test>.+?)\s+\([^)]+\)\s*$")
# cargo pattern: test tests::test_name ... FAILED
_CARGO_FAIL = re.compile(
    r"test\s+(?P<test>[^\s]+)\s+\.\.\.\s+FAILED"
)
# go pattern: --- FAIL: TestName (0.00s)
_GO_FAIL = re.compile(
    r"---\s+FAIL:\s+(?P<test>[^\s(]+)"
)


def parse_failures(output: str, framework: RunnerKind | None = None) -> list[ParsedFailure]:
    """Parse test output into structured failure records."""
    failures: list[ParsedFailure] = []

    if framework is None:
        # Try all parsers
        for fw in (
            RunnerKind.PYTEST,
            RunnerKind.NODE,
            RunnerKind.JEST,
            RunnerKind.CARGO,
            RunnerKind.GO,
            RunnerKind.RUBY,
            RunnerKind.DOTNET,
            RunnerKind.PHP,
        ):
            failures = _parse_with(output, fw)
            if failures:
                return failures
        return failures

    return _parse_with(output, framework)


def _parse_with(output: str, framework: RunnerKind) -> list[ParsedFailure]:
    failures: list[ParsedFailure] = []

    if framework is RunnerKind.PYTEST:
        for match in _PYTEST_FAIL.finditer(output):
            failures.append(ParsedFailure(
                file=match.group("file") or "",
                line=None,
                test_name=match.group("test") or match.group("file") or "",
                error_type="pytest_failure",
                message=match.group("error") or "",
                raw=match.group(0)[:500],
            ))

    elif framework is RunnerKind.NODE:
        seen: set[str] = set()
        matches = list(_NODE_FAIL.finditer(output)) + list(_NODE_SPEC_FAIL.finditer(output))
        for match in matches:
            name = (match.group("test") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            failures.append(ParsedFailure(
                file="",
                line=None,
                test_name=name,
                error_type="node_test_failure",
                message=name,
                raw=match.group(0)[:500],
            ))

    elif framework is RunnerKind.JEST:
        for match in _JEST_FAIL.finditer(output):
            failures.append(ParsedFailure(
                file=match.group("file") or "",
                line=int(match.group("line")) if match.group("line") else None,
                test_name=match.group("test") or "",
                error_type="jest_failure",
                message=match.group(0)[:400],
                raw=match.group(0)[:500],
            ))

    elif framework is RunnerKind.CARGO:
        for match in _CARGO_FAIL.finditer(output):
            failures.append(ParsedFailure(
                file="",
                line=None,
                test_name=match.group("test") or "",
                error_type="cargo_test_failure",
                message=match.group(0)[:300],
                raw=match.group(0)[:500],
            ))

    elif framework is RunnerKind.GO:
        for match in _GO_FAIL.finditer(output):
            failures.append(ParsedFailure(
                file="",
                line=None,
                test_name=match.group("test") or "",
                error_type="go_test_failure",
                message=match.group(0)[:300],
                raw=match.group(0)[:500],
            ))

    elif framework is RunnerKind.RUBY:
        for match in re.finditer(
            r"(?m)^(?P<runs>\d+)\s+runs,\s+(?P<assertions>\d+)\s+assertions,"
            r"\s+(?P<failures>\d+)\s+failures,\s+(?P<errors>\d+)\s+errors",
            output,
        ):
            failures_count = int(match.group("failures")) + int(match.group("errors"))
            if failures_count:
                failures.append(
                    ParsedFailure(
                        file="",
                        line=None,
                        test_name="ruby suite",
                        error_type="ruby_test_failure",
                        message=f"{failures_count} Ruby test failure(s)",
                        raw=match.group(0),
                    )
                )

    elif framework in {RunnerKind.DOTNET, RunnerKind.PHP}:
        # These runners have no universal text failure format across console
        # projects and test frameworks. Non-zero exit status is still handled
        # fail-closed by run_tests; preserve a concise generic failure here.
        if re.search(r"(?im)\b(fail(?:ed|ure)?|error)\b", output):
            failures.append(
                ParsedFailure(
                    file="",
                    line=None,
                    test_name=f"{framework.value} suite",
                    error_type=f"{framework.value}_test_failure",
                    message="runner reported a failure",
                    raw=output[:500],
                )
            )

    return failures


def format_failures_for_model(failures: list[ParsedFailure]) -> str:
    """Format parsed failures as a concise model-ready summary."""
    if not failures:
        return "All tests passed."

    lines = [f"{len(failures)} test(s) failed:"]
    for f in failures:
        loc = f"{f.file}:{f.line}" if f.file else f.test_name
        lines.append(f"  {loc} — {f.error_type}: {f.message[:160]}")
    return "\n".join(lines)


def detect_test_framework(workspace: Path) -> str | None:
    """Backward-compatible framework detector returning legacy string names."""
    kind = detect_runner(workspace)
    return None if kind is RunnerKind.UNKNOWN else kind.value


def parse_output(framework: str | RunnerKind | None, output: str) -> tuple[int, int]:
    """Backward-compatible pass/fail count parser."""
    kind = _coerce_runner(framework)
    text = output or ""
    if kind is RunnerKind.PYTEST:
        return _parse_count_patterns(
            text,
            pass_patterns=(r"(\d+)\s+passed",),
            fail_patterns=(r"(\d+)\s+failed", r"FAILED\s+"),
        )
    if kind is RunnerKind.NODE:
        return _parse_count_patterns(
            text,
            pass_patterns=(r"(?m)^(?:#|\u2139)\s+pass\s+(\d+)\s*$",),
            fail_patterns=(r"(?m)^(?:#|\u2139)\s+fail\s+(\d+)\s*$",),
        )
    if kind is RunnerKind.JEST:
        passed, failed = _parse_count_patterns(
            text,
            pass_patterns=(r"(\d+)\s+passed",),
            fail_patterns=(r"(\d+)\s+failed",),
        )
        return passed, failed
    if kind is RunnerKind.CARGO:
        return _parse_count_patterns(
            text,
            pass_patterns=(r"(\d+)\s+passed",),
            fail_patterns=(r"(\d+)\s+failed",),
        )
    if kind is RunnerKind.GO:
        passed = len(re.findall(r"---\s+PASS:", text))
        failed = len(re.findall(r"---\s+FAIL:", text))
        if passed == 0 and failed == 0 and re.search(r"(?m)^ok\s+", text):
            passed = 1
        return passed, failed
    if kind is RunnerKind.RUBY:
        match = re.search(
            r"(?m)^(\d+)\s+runs,\s+\d+\s+assertions,"
            r"\s+(\d+)\s+failures,\s+(\d+)\s+errors",
            text,
        )
        if match:
            runs = int(match.group(1))
            failed = int(match.group(2)) + int(match.group(3))
            return max(0, runs - failed), failed
    return 0, 0


def _coerce_runner(value: str | RunnerKind | None) -> RunnerKind:
    if isinstance(value, RunnerKind):
        return value
    if isinstance(value, str):
        normalized = value.lower().strip()
        for kind in RunnerKind:
            if kind.value == normalized:
                return kind
    return RunnerKind.UNKNOWN


def _parse_count_patterns(
    output: str,
    *,
    pass_patterns: tuple[str, ...],
    fail_patterns: tuple[str, ...],
) -> tuple[int, int]:
    passed = _first_int(output, pass_patterns)
    failed = _first_int(output, fail_patterns)
    if failed == 0 and any(pattern.endswith(r"\s+") for pattern in fail_patterns):
        failed = len(re.findall(r"FAILED\s+", output))
    return passed, failed


def _first_int(output: str, patterns: tuple[str, ...]) -> int:
    for pattern in patterns:
        match = re.search(pattern, output)
        if match and match.groups():
            return int(match.group(1))
    return 0


__all__ = [
    "RunnerKind",
    "ParsedFailure",
    "TestRunResult",
    "detect_runner",
    "detect_test_framework",
    "run_tests",
    "parse_output",
    "parse_failures",
    "format_failures_for_model",
]
