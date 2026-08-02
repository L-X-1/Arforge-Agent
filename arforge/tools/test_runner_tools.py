"""Canonical project test runner exposed to the agent."""

from __future__ import annotations

import importlib
from pathlib import Path

from arforge.core.test_runner import RunnerKind, detect_runner, run_tests
from arforge.tool_registry import ParamSchema, register_tool


_FRAMEWORKS = {
    "pytest": RunnerKind.PYTEST,
    "node": RunnerKind.NODE,
    "jest": RunnerKind.JEST,
    "cargo": RunnerKind.CARGO,
    "go": RunnerKind.GO,
    "ruby": RunnerKind.RUBY,
    "dotnet": RunnerKind.DOTNET,
    "php": RunnerKind.PHP,
}


def _validated_targets(workspace: Path, targets: list[str] | None) -> list[str]:
    resolved: list[str] = []
    root = workspace.resolve()
    for raw in targets or []:
        target = str(raw or "").strip()
        if not target:
            continue
        if len(target) > 500 or target.startswith("-") or "\x00" in target:
            raise ValueError(f"Invalid test target: {target[:120]!r}")
        # Pytest node IDs append ``::Class::test`` to a real relative path.
        path_part = target.split("::", 1)[0]
        candidate = (root / path_part).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError(f"Test target escapes the workspace: {target}") from exc
        if not candidate.exists():
            raise FileNotFoundError(f"Test target does not exist: {target}")
        normalized_path = candidate.relative_to(root).as_posix()
        suffix = target[len(path_part):]
        resolved.append(normalized_path + suffix)
    if len(resolved) > 50:
        raise ValueError("At most 50 test targets can be run at once.")
    return resolved


def _successful_test_report(
    *,
    framework: str,
    passed: int,
    selected: list[str],
) -> str:
    """Return stable, compact success evidence for the next model turn.

    Passing runner output is mostly one line per collected test and makes every
    subsequent prompt prefix larger without adding diagnostic value.  Failures
    still retain the bounded raw runner output below.
    """
    scope = (
        f"targets={','.join(selected)}"
        if selected
        else "scope=full-suite"
    )
    return (
        f"Tests passed | framework={framework} | passed={passed} | failed=0 | "
        f"exit=0 | {scope}"
    )


@register_tool(
    "run_tests",
    "Detect and execute the project's real test runner. With `targets`, run only the named "
    "workspace-relative test files or pytest node IDs; without targets, run the full suite. "
    "A failing test process is returned as a failed tool call so the agent must fix and rerun it.",
    params=[
        ParamSchema(
            "framework",
            "string",
            "Optional runner override: pytest, node, jest, cargo, go, ruby, dotnet, or php.",
            required=False,
            default="",
        ),
        ParamSchema(
            "targets",
            "array",
            "Optional workspace-relative test files or pytest node IDs to execute.",
            required=False,
            default=[],
            json_schema={"type": "array", "items": {"type": "string"}, "maxItems": 50},
        ),
        ParamSchema(
            "test_name",
            "string",
            "Optional test-name filter. Prefer targets when the user named test files.",
            required=False,
            default="",
        ),
    ],
    risk="medium",
    category="workspace_cmd",
    timeout=0,
    priority=110,
    source=__name__,
)
def run_tests_tool(
    framework: str = "",
    targets: list[str] | None = None,
    test_name: str = "",
) -> str:
    # Resolve the workspace provider at execution time.  Tool/plugin reloads can
    # replace ``arforge.tools.file_tools`` in ``sys.modules``; retaining a
    # function imported from the old module would then run tests in a stale
    # workspace even after the active project changed.
    file_tools = importlib.import_module("arforge.tools.file_tools")
    workspace = file_tools.get_workspace().resolve()
    requested_framework = str(framework or "").strip().casefold()
    if requested_framework:
        runner = _FRAMEWORKS.get(requested_framework)
        if runner is None:
            raise ValueError(
                f"Unknown test framework {framework!r}; expected one of {', '.join(_FRAMEWORKS)}."
            )
    else:
        runner = detect_runner(workspace)
    if runner is RunnerKind.UNKNOWN:
        raise RuntimeError("No supported test framework was detected in the workspace.")

    selected = _validated_targets(workspace, targets)
    extra_args = list(selected)
    filter_name = str(test_name or "").strip()
    if filter_name:
        if runner is RunnerKind.PYTEST:
            extra_args.extend(["-k", filter_name])
        elif runner is RunnerKind.NODE:
            extra_args.extend(["--test-name-pattern", filter_name])
        elif runner is RunnerKind.JEST:
            extra_args.extend(["-t", filter_name])
        elif runner is RunnerKind.CARGO:
            extra_args.append(filter_name)
        elif runner is RunnerKind.GO:
            extra_args.extend(["-run", filter_name])

    from arforge.tools.basic_tools import current_command_cancellation_event

    result = run_tests(
        workspace,
        runner,
        extra_args=extra_args,
        timeout=0,
        cancel_event=current_command_cancellation_event(),
    )
    header = (
        f"Framework: {result.framework or runner.value} | Exit: {result.returncode} | "
        f"{result.passed} passed, {result.failed} failed"
    )
    output = str(result.output or "").strip()
    report = f"{header}\n{output[:7000]}".strip()
    if result.returncode == 130:
        raise InterruptedError("test run cancelled by user")
    if not result.ran or result.returncode != 0 or result.failed:
        raise RuntimeError(report)
    return _successful_test_report(
        framework=result.framework or runner.value,
        passed=result.passed,
        selected=selected,
    )
