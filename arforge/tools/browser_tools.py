"""Evidence-backed browser diagnostics for URLs and workspace-local web files."""

from __future__ import annotations

import json

from arforge.browser_runtime import resolve_browser_target, run_browser_diagnostics
from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "test_browser",
    "Launch a real installed Chromium browser and inspect a URL or workspace-local HTML file. "
    "Returns runtime errors, real viewport and document dimensions, canvas sizes, visible text, "
    "buttons, interactive elements, selects, and inputs with reusable selectors. This tool is "
    "read-only; use interact_browser for actions. "
    "Use it before claiming that a web page was tested in a browser.",
    keywords=[
        "test browser",
        "browser test",
        "runtime validation",
        "local html",
        "responsive test",
        "canvas test",
        "console error",
    ],
    params=[
        ParamSchema("url", "string", "http(s) URL, file URL, or path inside the active workspace"),
        ParamSchema("wait_ms", "int", "post-load wait from 0 to 10000ms", required=False, default=1500),
        ParamSchema("viewport_width", "int", "viewport width from 320 to 3840", required=False, default=1280),
        ParamSchema("viewport_height", "int", "viewport height from 320 to 2160", required=False, default=720),
        ParamSchema(
            "actions",
            "array",
            "actions are rejected by this read-only tool; use interact_browser instead",
            required=False,
            default=[],
        ),
    ],
    risk="low",
    requires_confirmation=False,
    timeout=45,
    output_limit=20000,
    category="workspace_cmd",
    always_load=True,
    source=__name__,
)
def test_browser(
    url: str,
    wait_ms: int = 1500,
    viewport_width: int = 1280,
    viewport_height: int = 720,
    actions: list[str] | None = None,
    _allow_actions: bool = False,
) -> str:
    """Run real browser diagnostics and return stable, reviewable evidence."""
    from arforge.tools.file_tools import get_workspace

    if actions and not _allow_actions:
        raise PermissionError(
            "test_browser is read-only; use interact_browser for click, fill, select, "
            "check, touch, or key actions so state-changing interaction requires approval"
        )
    result = run_browser_diagnostics(
        url,
        workspace=get_workspace(),
        wait_ms=wait_ms,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        actions=actions or [],
    )
    snapshot = result["snapshot"]
    visible_text = str(snapshot.get("bodyText", "") or "").lstrip()
    if visible_text.startswith(("<?php", "<%")):
        raise RuntimeError(
            "browser received server-side source code instead of a rendered page; "
            "fix or start the application server and validate an http(s) URL"
        )
    issues = (
        len(result["console_errors"])
        + len(result["page_errors"])
        + len(result["network_failures"])
        + len(result["http_errors"])
    )
    lines = [
        "=== Real Browser Validation ===",
        f"Engine: {result['engine']}",
        f"Final URL: {snapshot['url']}",
        f"Title: {snapshot['title'] or '(empty)'}",
        f"Ready state: {snapshot['readyState']}",
        f"Visible body text: {snapshot['bodyTextLength']} chars",
        f"Viewport: {snapshot['viewport']['width']}x{snapshot['viewport']['height']}",
        (
            "Document: "
            f"{snapshot['document']['scrollWidth']}x{snapshot['document']['scrollHeight']}; "
            f"horizontal_overflow={str(snapshot['document']['horizontalOverflow']).lower()}"
        ),
        f"Actions completed: {json.dumps(result['actions'], ensure_ascii=False)}",
        f"Canvases: {json.dumps(snapshot['canvases'], ensure_ascii=False)}",
        # Put the verdict before all potentially large evidence sections. Both the
        # model-facing message and persisted traces may be length-limited.
        f"Runtime issues: {issues}",
        f"Console errors: {json.dumps(result['console_errors'], ensure_ascii=False)}",
        f"Page errors: {json.dumps(result['page_errors'], ensure_ascii=False)}",
        f"Network failures: {json.dumps(result['network_failures'], ensure_ascii=False)}",
        f"HTTP errors: {json.dumps(result['http_errors'], ensure_ascii=False)}",
        # Keep rendered body evidence ahead of potentially huge element inventories.
        # ToolRegistry may truncate the tail at output_limit, and completion guards
        # must still be able to verify exact user-visible sentinel text.
        f"Visible text sample: {snapshot['bodyText']}",
        f"Buttons: {json.dumps(snapshot['buttons'], ensure_ascii=False)}",
        f"Interactive elements: {json.dumps(snapshot.get('interactives', []), ensure_ascii=False)}",
        f"Selects: {json.dumps(snapshot.get('selects', []), ensure_ascii=False)}",
        f"Inputs: {json.dumps(snapshot.get('inputs', []), ensure_ascii=False)}",
    ]
    return "\n".join(lines)


@register_tool(
    "interact_browser",
    "Run approved, bounded interactions in a real installed Chromium browser and return "
    "the same runtime evidence as test_browser. Use this for clicks, form filling, selection, "
    "touch, or key input because those actions may change application or backend state.",
    keywords=[
        "interact browser",
        "browser click",
        "browser form",
        "end to end browser",
        "e2e browser",
    ],
    params=[
        ParamSchema("url", "string", "http(s) URL, file URL, or path inside the active workspace"),
        ParamSchema(
            "actions",
            "array",
            "bounded actions: press:Enter, click:#id, click:text=Button text, "
            "click:button:Button text, touch:#id, fill:#id:text, "
            "fill:placeholder=Title:text, select:#id:value, check:#id, "
            "uncheck:#id, wait:500",
        ),
        ParamSchema("wait_ms", "int", "post-load wait from 0 to 10000ms", required=False, default=1500),
        ParamSchema("viewport_width", "int", "viewport width from 320 to 3840", required=False, default=1280),
        ParamSchema("viewport_height", "int", "viewport height from 320 to 2160", required=False, default=720),
    ],
    risk="medium",
    requires_confirmation=True,
    timeout=45,
    output_limit=20000,
    category="workspace_cmd",
    always_load=True,
    source=__name__,
)
def interact_browser(
    url: str,
    actions: list[str],
    wait_ms: int = 1500,
    viewport_width: int = 1280,
    viewport_height: int = 720,
) -> str:
    if not actions:
        raise ValueError("interact_browser requires at least one bounded action")
    return test_browser(
        url,
        wait_ms=wait_ms,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        actions=actions,
        _allow_actions=True,
    )


@register_tool(
    "check_page",
    "Quickly validate that a URL or workspace-local HTML target resolves safely. "
    "This does not execute JavaScript; use test_browser for runtime or visual claims.",
    keywords=["check page", "page target", "page path"],
    params=[ParamSchema("url", "string", "URL or workspace-local file path")],
    risk="low",
    requires_confirmation=False,
    timeout=5,
    category="read",
    source=__name__,
)
def check_page(url: str) -> str:
    from arforge.tools.file_tools import get_workspace

    resolved = resolve_browser_target(url, get_workspace())
    return (
        f"resolved browser target: {resolved}\n"
        "runtime_validated=false; call test_browser before making browser-runtime or visual claims"
    )
