from __future__ import annotations

import json
import re
import zipfile
from types import SimpleNamespace

import pytest

from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.product.session_runtime import SessionRuntime
from arforge.skills import read_skill
from arforge.tool_registry import REGISTRY
from arforge.tools import load_builtin_tools
from arforge.tools import file_tools


@pytest.fixture
def office_workspace(tmp_path):
    previous = file_tools.WORKSPACE
    file_tools.set_workspace(tmp_path)
    assert file_tools.get_workspace() == tmp_path.resolve()
    load_builtin_tools()
    try:
        yield tmp_path
    finally:
        file_tools.set_workspace(previous)


def _approved(actions: ActionRuntime, name: str, arguments: dict) -> dict:
    prepared = actions.prepare_tool("office-session", name, arguments)
    assert prepared["status"] == "prepared"
    assert prepared["approval"]["status"] == "pending"
    actions.respond_approval("office-session", prepared["approval_id"], "approve")
    executed = actions.execute_tool(
        "office-session",
        prepared["action_id"],
        prepared["approval_id"],
    )
    assert executed["status"] == "succeeded"
    assert executed["result"]["success"] is True
    return executed


def test_office_artifacts_require_approval(office_workspace):
    actions = ActionRuntime(office_workspace)
    prepared = actions.prepare_tool(
        "office-session",
        "write_xlsx",
        {"filename": "report.xlsx", "data_json": "[[\"month\", \"income\"], [\"July\", 128]]"},
    )

    with pytest.raises(ActionRuntimeError) as caught:
        actions.execute_tool("office-session", prepared["action_id"], prepared["approval_id"])

    assert caught.value.code == "APPROVAL_REQUIRED"
    assert not (office_workspace / "report.xlsx").exists()


def test_approved_office_tool_is_bound_to_action_runtime_workspace(tmp_path):
    stale = tmp_path / "stale-project"
    active = tmp_path / "active-project"
    stale.mkdir()
    active.mkdir()
    previous = file_tools.get_workspace()
    try:
        file_tools.set_workspace(stale)
        actions = ActionRuntime(active)

        _approved(
            actions,
            "write_xlsx",
            {"filename": "scoped.xlsx", "data_json": "[[\"value\"], [1]]"},
        )

        assert (active / "scoped.xlsx").is_file()
        assert not (stale / "scoped.xlsx").exists()
    finally:
        file_tools.set_workspace(previous)


def test_xlsx_create_extract_and_artifact_flow(office_workspace):
    actions = ActionRuntime(office_workspace)
    data = [
        {"月份": "六月", "收入": 96.5, "达标": False},
        {"月份": "七月", "收入": 128, "达标": True},
    ]
    executed = _approved(
        actions,
        "write_xlsx",
        {
            "filename": "月度经营数据.xlsx",
            "data_json": json.dumps(data, ensure_ascii=False),
            "sheet_name": "经营数据",
        },
    )
    path = office_workspace / "月度经营数据.xlsx"

    with zipfile.ZipFile(path) as package:
        assert "xl/workbook.xml" in package.namelist()
        assert "xl/worksheets/sheet1.xml" in package.namelist()
        assert "经营数据" in package.read("xl/workbook.xml").decode("utf-8")
    extracted = REGISTRY.execute_by_name("read_office_document", {"filename": path.name})
    assert extracted.success is True, extracted.error
    payload = json.loads(extracted.output)

    assert executed["result"]["output"].startswith("wrote ")
    assert all(value in payload["text"] for value in ("月份", "收入", "六月", "七月", "128"))
    artifact = SessionRuntime._extract_artifact("write_xlsx", executed["result"]["output"])
    assert artifact is not None
    assert artifact["path"].endswith("月度经营数据.xlsx")
    assert artifact["display_name"] == "月度经营数据.xlsx"
    assert artifact["mime"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert artifact["size_bytes"] == path.stat().st_size
    assert len(artifact["sha256"]) == 64
    repeated = SessionRuntime._extract_artifact("write_xlsx", executed["result"]["output"])
    assert repeated is not None
    assert repeated["artifact_id"] == artifact["artifact_id"]


def test_pptx_create_extract_and_artifact_flow(office_workspace):
    actions = ActionRuntime(office_workspace)
    slides = [
        {"title": "季度复盘", "body": "收入增长 18%\n交付准时率 97%"},
        {"title": "下季度计划", "body": "优化客户响应\n完善风险台账"},
    ]
    executed = _approved(
        actions,
        "write_pptx",
        {"filename": "季度复盘.pptx", "slides_json": json.dumps(slides, ensure_ascii=False)},
    )
    path = office_workspace / "季度复盘.pptx"

    with zipfile.ZipFile(path) as package:
        names = package.namelist()
        assert "ppt/presentation.xml" in names
        assert "ppt/slides/slide1.xml" in names
        assert "ppt/slides/slide2.xml" in names
        assert "ppt/theme/theme1.xml" in names
    extracted = REGISTRY.execute_by_name("read_office_document", {"filename": path.name})
    assert extracted.success is True, extracted.error
    payload = json.loads(extracted.output)

    assert all(value in payload["text"] for value in ("季度复盘", "收入增长 18%", "下季度计划", "风险台账"))
    assert SessionRuntime._extract_artifact("write_pptx", executed["result"]["output"]) is not None


def test_pdf_create_has_valid_cross_reference_and_unicode(office_workspace):
    actions = ActionRuntime(office_workspace)
    content = "经营简报\n收入：128 万元\n结论：保持增长"
    executed = _approved(
        actions,
        "write_pdf",
        {"filename": "经营简报.pdf", "content": content},
    )
    path = office_workspace / "经营简报.pdf"
    payload = path.read_bytes()

    assert payload.startswith(b"%PDF-1.4")
    assert b"xref\n" in payload
    assert payload.rstrip().endswith(b"%%EOF")
    assert b"/FontDescriptor" in payload
    assert b"/W [1 [207 270" in payload
    assert ("\ufeff经营简报".encode("utf-16-be").hex().upper().encode("ascii")) in payload
    assert SessionRuntime._extract_artifact("write_pdf", executed["result"]["output"]) is not None


def test_pdf_wraps_long_prose_and_paginates(office_workspace):
    actions = ActionRuntime(office_workspace)
    long_paragraph = "这是用于验证中文自动换行和分页的完整段落。" * 280
    _approved(
        actions,
        "write_pdf",
        {"filename": "长文.pdf", "content": "# 长文标题\n" + long_paragraph},
    )

    payload = (office_workspace / "长文.pdf").read_bytes()
    count_match = re.search(rb"/Type /Pages /Count (\d+)", payload)

    assert count_match is not None
    assert int(count_match.group(1)) >= 2
    assert b"/F1 20 Tf" in payload
    assert b"/F1 12 Tf" in payload


def test_pdf_uses_helvetica_for_latin_and_removes_markdown_rules(office_workspace):
    actions = ActionRuntime(office_workspace)
    _approved(
        actions,
        "write_pdf",
        {
            "filename": "论文.pdf",
            "content": "# Arforge Agent 的开发与实现\n\n---\n\n正文 **内容**",
        },
    )

    payload = (office_workspace / "论文.pdf").read_bytes()

    assert b"/BaseFont /Helvetica" in payload
    assert b"(Arforge Agent) Tj" in payload
    assert ("\ufeff---".encode("utf-16-be").hex().upper().encode("ascii")) not in payload
    assert b"(>) Tj" not in payload


def test_pdf_starts_numbered_proposal_sections_on_a_new_page(office_workspace):
    actions = ActionRuntime(office_workspace)
    _approved(
        actions,
        "write_pdf",
        {
            "filename": "开题报告.pdf",
            "content": "# 课题名称\n\n## 开题报告\n\n封面信息\n\n## 一、课题背景与意义\n\n正文",
        },
    )

    payload = (office_workspace / "开题报告.pdf").read_bytes()
    count_match = re.search(rb"/Type /Pages /Count (\d+)", payload)

    assert count_match is not None
    assert int(count_match.group(1)) == 2


def test_docx_can_be_read_back_without_optional_dependencies(office_workspace):
    actions = ActionRuntime(office_workspace)
    _approved(
        actions,
        "write_docx",
        {"filename": "会议纪要.docx", "content": "会议纪要\n负责人：小林\n截止：周五"},
    )

    result = REGISTRY.execute_by_name("read_office_document", {"filename": "会议纪要.docx"})
    assert result.success is True, result.error
    payload = json.loads(result.output)

    assert payload["format"] == ".docx"
    assert "负责人：小林" in payload["text"]


@pytest.mark.parametrize(
    "tool_name,arguments,error_text",
    [
        ("write_xlsx", {"filename": "bad.xlsx", "data_json": "{}"}, "array"),
        ("write_xlsx", {"filename": "bad.xlsx", "data_json": "not-json"}, "valid JSON"),
        ("write_pptx", {"filename": "bad.pptx", "slides_json": "[]"}, "non-empty"),
        ("write_pdf", {"filename": "bad.txt", "content": "x"}, ".pdf"),
    ],
)
def test_office_inputs_fail_closed(office_workspace, tool_name, arguments, error_text):
    actions = ActionRuntime(office_workspace)
    prepared = actions.prepare_tool("office-session", tool_name, arguments)
    actions.respond_approval("office-session", prepared["approval_id"], "approve")
    executed = actions.execute_tool("office-session", prepared["action_id"], prepared["approval_id"])

    assert executed["status"] == "failed"
    assert executed["result"]["success"] is False
    assert error_text.lower() in executed["result"]["error"].lower()


def test_office_tools_are_part_of_the_shared_builtin_registry():
    failures = load_builtin_tools()

    assert "arforge.tools.office_tools" not in failures
    for name in ("write_docx", "write_xlsx", "write_pptx", "write_pdf", "read_office_document"):
        assert REGISTRY.get(name) is not None


@pytest.mark.parametrize(
    "skill_id,tool_name",
    [
        ("documents", "write_docx"),
        ("spreadsheets", "write_xlsx"),
        ("presentations", "write_pptx"),
        ("pdf", "write_pdf"),
    ],
)
def test_bundled_office_skills_route_the_agent_to_real_tools(skill_id, tool_name):
    skill = read_skill(skill_id)

    assert skill["ok"] is True
    assert tool_name in skill["content"]
    assert "verify" in skill["content"].lower() or "Confirm" in skill["content"]


@pytest.mark.parametrize(
    "tool_name,filename,expected",
    [
        ("write_xlsx", "report", "report.xlsx"),
        ("write_pptx", "review", "review.pptx"),
        ("write_pdf", "brief", "brief.pdf"),
    ],
)
def test_office_artifacts_participate_in_change_tracking_and_run_rollback(
    office_workspace,
    tool_name,
    filename,
    expected,
):
    from arforge.core.change_tracker import get_change_tracker, record_change_hook, reset_change_tracker
    from arforge.core.run_transaction import get_run_transaction, reset_run_transaction, _snapshot_hook
    from arforge.workspace_context import execution_scope

    reset_change_tracker()
    reset_run_transaction()
    context = SimpleNamespace(
        tool_name=tool_name,
        tool_args={"filename": filename},
        tool_result=SimpleNamespace(success=True),
    )

    with execution_scope("office-session", workspace=office_workspace):
        _snapshot_hook(context)
        record_change_hook(context)

        resolved = str((office_workspace / expected).resolve())
        assert get_run_transaction().entries() == {resolved: None}
        assert get_change_tracker().changed() == [expected]


def test_overwritten_office_artifact_is_snapshotted_as_binary(office_workspace):
    from arforge.core.run_transaction import get_run_transaction, reset_run_transaction, _snapshot_hook
    from arforge.workspace_context import execution_scope

    original = b"existing-binary-artifact"
    (office_workspace / "report.xlsx").write_bytes(original)
    reset_run_transaction()

    with execution_scope("office-session", workspace=office_workspace):
        _snapshot_hook(SimpleNamespace(tool_name="write_xlsx", tool_args={"filename": "report.xlsx"}))

        assert get_run_transaction().entries()[str((office_workspace / "report.xlsx").resolve())] == original
