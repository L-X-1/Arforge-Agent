def test_permission_sandbox_and_verifier(tmp_path):
    from arforge.permission import check_command_permission
    from arforge.sandbox import run_command_no_shell
    from arforge.verifier import verify_python_file

    target = tmp_path / "ok.py"
    target.write_text("x = 1\n", encoding="utf-8")

    assert not check_command_permission("rm -rf /").allowed
    assert run_command_no_shell(["python", "--version"]).returncode == 0
    assert verify_python_file(target)["success"]


def test_legacy_sandbox_closes_child_stdin(monkeypatch):
    """The compatibility command runner must not inherit protocol stdin either."""
    from types import SimpleNamespace

    from arforge import sandbox

    captured = {}

    def fake_run(*args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(sandbox.subprocess, "run", fake_run)

    result = sandbox.run_command_no_shell(["python", "--version"])

    assert result.success is True
    assert captured["stdin"] is sandbox.subprocess.DEVNULL


def test_privacy_export_and_mcp(tmp_path):
    from arforge.export_cli import export_data
    from arforge.mcp_client import make_request
    from arforge.mcp_test_server import call_tool, initialize_response
    from arforge.privacy_cli import privacy_audit

    output = tmp_path / "export.json"
    data = export_data(output)

    assert output.exists()
    assert "memories" in data
    assert privacy_audit()["local_first"]
    assert make_request("tools/list")["jsonrpc"] == "2.0"
    assert initialize_response()["serverInfo"]["name"] == "arforge-test-server"
    # 3.4：call_tool 升级为 MCP 标准返回格式（content 为 [{type,text}] 列表）。
    assert call_tool("echo", {"text": "hi"})["content"][0]["text"] == "hi"


def test_multimodal_document_and_image_adapters(tmp_path):
    from arforge.capability.multimodal.document_adapter import document_metadata, read_document_text
    from arforge.capability.multimodal.image_adapter import is_image_file
    from arforge.capability.multimodal.ocr_adapter import ocr_available

    doc = tmp_path / "note.md"
    doc.write_text("# hello", encoding="utf-8")

    assert read_document_text(doc) == "# hello"
    assert document_metadata(doc)["exists"]
    assert is_image_file("x.png")
    assert isinstance(ocr_available(), bool)
