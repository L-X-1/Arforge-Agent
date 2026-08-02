def test_tool_registry_and_calculate():
    from arforge.tool_executor import execute_tool_by_name, list_tools

    result = execute_tool_by_name("calculate", {"expression": "2 + 3 * 4"})
    assert result.success
    assert result.output == "14"
    assert any(tool["name"] == "calculate" for tool in list_tools())


def test_file_tools_are_workspace_scoped(monkeypatch):
    from arforge.tools.file_tools import read_file, write_file

    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    result = write_file("tool_test.txt", "hello")
    assert "wrote" in result
    assert read_file("tool_test.txt") == "hello"


def test_source_read_tools_preserve_complete_single_file_apps():
    import arforge.tools.code_tools  # noqa: F401 - registers the tool surface
    import arforge.tools.file_tools  # noqa: F401 - registers the tool surface
    from arforge.tool_registry import REGISTRY

    assert REGISTRY.get("read_file").schema.output_limit == 60_000
    assert REGISTRY.get("code_read").schema.output_limit == 60_000


def test_task_tools_create_and_complete():
    from arforge.tools.task_tools import complete_task, create_task, delete_task

    task = create_task("rebuild tool layer", priority="high", tag="test")

    assert task["id"]
    assert complete_task(task["id"])["status"] == "completed"
    assert delete_task(task["id"])


def test_tool_executor_match():
    from arforge.tool_executor import run_tool_if_match

    result = run_tool_if_match("calculate 1+1")

    assert result is not None
    assert result.success
