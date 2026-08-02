"""P1 3.3: Agent-accessible test runner tool.

Registers `run_tests` as a tool so the agent can run test suites and
feed parsed failure data back into its self-correction loop.
"""

from __future__ import annotations

from arforge.core.test_runner import (
    RunnerKind,
    detect_runner,
    format_failures_for_model,
    parse_failures,
    run_tests,
)
from arforge.tool_registry import ParamSchema, register_tool
from arforge.tools.file_tools import get_workspace


@register_tool(
    "run_tests",
    "Detect and run the project's test suite. Returns parsed failure summary.",
    params=[
        ParamSchema("framework", "string", "Force a framework: pytest, node, jest, cargo, go (auto-detect if omitted)"),
        ParamSchema("single_test", "string", "Run a single test by name (optional)"),
    ],
    category="workspace_cmd",
    risk="low",
    priority=70,
)
def agent_run_tests(framework: str = "", single_test: str = "") -> str:
    workspace = get_workspace()

    # Resolve framework
    fw = None
    if framework:
        framework_lower = framework.lower()
        fw_map = {
            "pytest": RunnerKind.PYTEST,
            "node": RunnerKind.NODE,
            "jest": RunnerKind.JEST,
            "cargo": RunnerKind.CARGO,
            "go": RunnerKind.GO,
        }
        fw = fw_map.get(framework_lower)
        if fw is None:
            return f"ERROR: unknown framework '{framework}'. Supported: pytest, node, jest, cargo, go."

    if fw is None:
        fw = detect_runner(workspace)

    extra_args = []
    if single_test:
        if fw is RunnerKind.PYTEST:
            extra_args = ["-k", single_test]
        elif fw is RunnerKind.NODE:
            extra_args = ["--test-name-pattern", single_test]
        elif fw is RunnerKind.JEST:
            extra_args = ["-t", single_test]
        elif fw is RunnerKind.CARGO:
            extra_args = [single_test]
        elif fw is RunnerKind.GO:
            extra_args = ["-run", single_test]

    exit_code, output = run_tests(workspace, fw, extra_args=extra_args)

    failures = parse_failures(output, fw)
    summary = format_failures_for_model(failures)

    header = f"Framework: {fw.value} | Exit: {exit_code}"
    return f"{header}\n{summary}\n\n--- raw output (first 2000 chars) ---\n{output[:2000]}"
