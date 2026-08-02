# -*- coding: utf-8 -*-
"""Tests for evidence/grounding enforcement (3.1)."""

from __future__ import annotations


from arforge.core.grounding import (
    answer_has_file_claims,
    build_evidence_feedback,
    has_evidence_tag,
    has_file_references,
    validate_evidence,
    get_modified_files,
    get_read_files,
)


class TestHasEvidenceTag:
    def test_empty_string(self):
        assert not has_evidence_tag("")

    def test_none(self):
        assert not has_evidence_tag(None)

    def test_wrapping_tag(self):
        assert has_evidence_tag("<evidence>found something</evidence>")

    def test_self_closing_tag(self):
        assert has_evidence_tag('<evidence file="foo.py" line="42" />')

    def test_multiline_wrapping(self):
        text = "Answer:\n<evidence>\nFile foo.py line 42: bug found\n</evidence>\nDone."
        assert has_evidence_tag(text)

    def test_no_evidence_tag(self):
        assert not has_evidence_tag("I modified several files and fixed the issue.")

    def test_similar_but_not_evidence_tag(self):
        assert not has_evidence_tag("<code>print('hello')</code>")


class TestHasFileReferences:
    def test_file_path_in_answer(self):
        log = []
        assert has_file_references("The issue is in main.py at line 10", log)

    def test_in_pattern(self):
        log = []
        assert has_file_references("in src/utils.py we see the bug", log)

    def test_tool_log_signal(self):
        log = [{"tool": "read_file", "success": True}]
        assert has_file_references("The function works correctly", log)

    def test_tool_log_write_signal(self):
        log = [{"tool": "write_file", "success": True}]
        assert has_file_references("All changes applied", log)

    def test_no_file_reference(self):
        log = [{"tool": "run_cmd", "success": True}]
        assert not has_file_references("The tests passed", log)

    def test_tool_use_alone_is_not_a_final_answer_claim(self):
        assert not answer_has_file_claims("done")
        assert not answer_has_file_claims("wrote and verified")
        assert answer_has_file_claims("I modified src/main.py")

    def test_browser_urls_and_dom_selectors_are_not_file_claims(self):
        answer = (
            "Verified http://127.0.0.1:8200/?p=tasks with div.wk-block, "
            "button.ttb-del, and li.tl-item; runtime issues were zero."
        )
        assert not answer_has_file_claims(answer)
        assert not has_file_references(answer, [{"tool": "test_browser", "success": True}])

    def test_real_file_inside_web_url_is_not_a_workspace_file_claim(self):
        assert not answer_has_file_claims("Loaded https://example.com/assets/app.js successfully")
        assert answer_has_file_claims("Inspected assets/app.js successfully")


class TestValidateEvidence:
    def test_needs_and_has_evidence(self):
        log = [{"tool": "read_file", "success": True}]
        answer = "<evidence>main.py:10</evidence> Fixed the import."
        result = validate_evidence(answer, log)
        assert result["valid"]
        assert result["needs_evidence"]

    def test_needs_but_missing_evidence(self):
        log = [{"tool": "write_file", "args": {"filename": "main.py"}, "success": True}]
        answer = "I modified main.py to fix the bug."
        result = validate_evidence(answer, log)
        assert not result["valid"]
        assert result["needs_evidence"]
        assert "main.py" in result["missing_citations"]

    def test_no_file_context(self):
        log = [{"tool": "run_cmd", "success": True}]
        answer = "The tests passed with 5/5 green."
        result = validate_evidence(answer, log)
        assert result["valid"]
        assert not result["needs_evidence"]

    def test_empty_answer(self):
        result = validate_evidence("", [{"tool": "read_file", "success": True}])
        assert result["valid"]

    def test_browser_acceptance_report_does_not_require_file_citations(self):
        result = validate_evidence(
            "http://127.0.0.1:8200/?p=tasks rendered div.wk-block with no errors",
            [{"tool": "test_browser", "success": True}],
        )
        assert result == {"valid": True, "needs_evidence": False, "missing_citations": []}


class TestBuildEvidenceFeedback:
    def test_includes_missing_files(self):
        msg = build_evidence_feedback(["src/main.py", "tests/test_main.py"])
        assert "src/main.py" in msg
        assert "tests/test_main.py" in msg
        assert "<evidence" in msg
        assert "[Grounding]" in msg

    def test_truncates_long_list(self):
        msg = build_evidence_feedback([f"file{i}.py" for i in range(10)])
        assert "file0.py" in msg
        assert "file4.py" in msg


class TestGetFiles:
    def test_get_modified_files(self):
        log = [
            {"tool": "write_file", "args": {"filename": "a.py"}, "success": True},
            {"tool": "read_file", "args": {"filename": "b.py"}, "success": True},
            {"tool": "write_file", "args": {"filename": "c.py"}, "success": False},
        ]
        mod = get_modified_files(log)
        assert mod == ["a.py"]

    def test_get_read_files(self):
        log = [
            {"tool": "read_file", "args": {"filename": "x.py"}, "success": True},
            {"tool": "code_search", "args": {}, "success": True},
            {"tool": "write_file", "args": {"filename": "y.py"}, "success": True},
        ]
        read = get_read_files(log)
        assert "x.py" in read
