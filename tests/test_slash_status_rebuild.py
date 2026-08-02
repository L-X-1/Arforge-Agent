def test_status_and_slash_dispatch():
    from arforge.slash_commands import list_slash_commands, run_slash_command
    from arforge.status import get_status

    status = get_status()

    assert status["brand"] == "Arforge Agent"
    assert any(item["name"] == "status" for item in list_slash_commands())
    assert "brand" in run_slash_command("/status")


def test_feedback_and_config_helpers():
    from arforge.feedback import record_feedback
    from arforge.slash_system_config import show_system_config

    assert record_feedback(5)["success"]
    assert "model=" in show_system_config()


def test_memory_and_productivity_slash_helpers():
    from arforge.slash_memory_learning import learning_status, remember
    from arforge.slash_productivity import task_add

    assert "saved" in remember("slash memory test").lower()
    assert learning_status()
    assert task_add("slash task test").startswith("created")
