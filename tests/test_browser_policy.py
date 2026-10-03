from __future__ import annotations

from pathlib import Path

import pytest

import arforge.tools.browser_tools  # noqa: F401
from arforge.browser_policy import (
    BrowserPolicyError,
    classify_browser_action,
    validate_browser_target_url,
    validate_redirect,
    verify_browser_state,
)
from arforge.tools import browser_tools


def _fake_result(body: str = "Saved", *, url: str = "http://127.0.0.1:8200/done") -> dict:
    return {
        "engine": "fake-chromium",
        "target": "http://127.0.0.1:8200/",
        "snapshot": {
            "url": url,
            "title": "fixture",
            "readyState": "complete",
            "bodyTextLength": len(body),
            "bodyText": body,
            "viewport": {"width": 1280, "height": 720},
            "document": {
                "scrollWidth": 1280,
                "scrollHeight": 720,
                "clientWidth": 1280,
                "clientHeight": 720,
                "horizontalOverflow": False,
            },
            "canvases": [],
            "buttons": [],
            "interactives": [],
            "selects": [],
            "inputs": [],
        },
        "actions": ["clicked #save"],
        "action_plans": [
            {
                "action": "click:#save",
                "kind": "click",
                "risk_level": "medium",
                "requires_confirmation": True,
                "destructive": False,
            }
        ],
        "downloads": [],
        "credential_scope": "ephemeral-empty-profile",
        "allowed_origins": [],
        "prompt_injection": {"clean": True, "count": 0, "severity": "none"},
        "console_errors": [],
        "page_errors": [],
        "network_failures": [],
        "http_errors": [],
    }


def test_browser_action_policy_distinguishes_read_form_download_and_destructive():
    assert classify_browser_action("wait:250").risk_level == "low"
    assert classify_browser_action("fill:#title:hello").kind == "form"
    assert classify_browser_action("click:#download").kind == "download"
    delete = classify_browser_action("click:text=Delete")
    assert delete.kind == "destructive_click"
    assert delete.risk_level == "high"
    assert delete.destructive is True


def test_browser_url_policy_rejects_inline_and_query_credentials():
    with pytest.raises(BrowserPolicyError, match="inline credentials"):
        validate_browser_target_url("https://user:pass@example.com/")
    with pytest.raises(BrowserPolicyError, match="credentials in its query"):
        validate_browser_target_url("https://example.com/callback?access_token=secret")


def test_browser_redirect_policy_is_same_origin_by_default(tmp_path: Path):
    assert validate_redirect(
        "http://example.test/start",
        "http://example.test/finished",
        workspace=tmp_path,
    ) == "http://example.test/finished"
    with pytest.raises(BrowserPolicyError, match="origin boundary"):
        validate_redirect(
            "http://example.test/start",
            "https://evil.test/finished",
            workspace=tmp_path,
        )
    assert validate_redirect(
        "http://example.test/start",
        "https://auth.example.test/finished",
        workspace=tmp_path,
        allowed_origins=["https://auth.example.test"],
    ) == "https://auth.example.test/finished"


def test_browser_final_state_verifier_is_independent_of_action_text():
    snapshot = {"url": "http://example.test/done", "bodyText": "Saved", "readyState": "complete"}
    assert verify_browser_state(
        snapshot,
        {"url_prefix": "http://example.test/", "text": ["Saved"], "absent_text": ["Error"]},
    ) == {"status": "PASSED", "passed": True, "failures": []}
    failed = verify_browser_state(snapshot, {"text": ["Not saved"]})
    assert failed["status"] == "FAILED"
    assert verify_browser_state(snapshot)["status"] == "OBSERVATION_ONLY"


def test_browser_output_marks_page_content_untrusted_and_observation_only(monkeypatch, tmp_path: Path):
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)
    monkeypatch.setattr(browser_tools, "run_browser_diagnostics", lambda *_args, **_kwargs: _fake_result("page text"))

    output = browser_tools.test_browser("http://127.0.0.1:8200/")

    assert "Page content trust: UNTRUSTED_PAGE_CONTENT" in output
    assert "Visible text sample: [UNTRUSTED_PAGE_CONTENT_BEGIN]" in output
    assert "Final state verification: OBSERVATION_ONLY" in output


def test_destructive_browser_action_requires_fresh_approval(monkeypatch):
    launched = False

    def fake_run(*_args, **_kwargs):
        nonlocal launched
        launched = True
        return _fake_result()

    monkeypatch.setattr(browser_tools, "run_browser_diagnostics", fake_run)
    monkeypatch.setattr("arforge.permission.request_confirmation", lambda *_args, **_kwargs: False)

    with pytest.raises(PermissionError, match="fresh approval"):
        browser_tools.interact_browser("http://127.0.0.1:8200/", ["click:text=Delete"])
    assert launched is False
