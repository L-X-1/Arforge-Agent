def test_model_adapter_value_objects():
    from arforge.models.model_adapter import ToolCall, ToolCallResponse

    call = ToolCall("1", "read_file", '{"path":"a.py"}')
    response = ToolCallResponse("ok", "tool_calls", [call], {"total_tokens": 3})

    assert response.tool_calls[0].name == "read_file"
    assert response.usage["total_tokens"] == 3


def test_model_factory_creates_deepseek_adapter():
    from arforge.models.model_factory import create_model_adapter
    from arforge.models.model_adapter import RateLimitedAdapter

    adapter = create_model_adapter("deepseek")

    assert isinstance(adapter, RateLimitedAdapter)
    assert adapter.model_name


def test_token_tracker_records_usage():
    from arforge.models.token_tracker import list_token_usage, record_token_usage

    record_token_usage("test-model", prompt_tokens=1, completion_tokens=2)
    rows = list_token_usage(limit=1)

    assert rows[0]["model_name"] == "test-model"
    assert rows[0]["total_tokens"] == 3
