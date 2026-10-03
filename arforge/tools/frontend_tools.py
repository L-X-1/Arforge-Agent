"""Explicit Python compatibility seam for the retired frontend validator.

The canonical implementation is the local-only TypeScript/Core
``multimodal_diagnose`` tool with ``mode="frontend"``. This module is not
part of the default Python registry and remains importable only for callers
that have not migrated yet.
"""

from __future__ import annotations

import os
import re
import ssl
import urllib.error
import urllib.request

from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "validate_frontend",
    "Validate a frontend HTML page for common issues that cause blank pages or "
    "rendering failures. Checks: HTML closing tags, blocking scripts, CDN URL "
    "reachability, JavaScript bracket balancing, Vue mount target, Element Plus "
    "icon usage, router configuration. Use BEFORE and AFTER editing frontend files.",
    keywords=["validate frontend", "check html", "validate html", "check js"],
    params=[
        ParamSchema("source", "string",
                    "URL to fetch (http://...) or file path (file:path/to/index.html)"),
    ],
    risk="low",
    requires_confirmation=False,
    timeout=20,
    category="network",
    source=__name__,
)
def validate_frontend(source: str) -> str:
    """Validate a frontend page and return a diagnostic report."""
    source = source.strip()
    body = ""
    source_label = source

    if source.startswith("http://") or source.startswith("https://"):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            req = urllib.request.Request(
                source,
                headers={"User-Agent": "Mozilla/5.0 ArforgeValidator/1.0"},
            )
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                raw = resp.read()
                try:
                    body = raw.decode("utf-8")
                except UnicodeDecodeError:
                    body = raw.decode("latin-1", errors="replace")
                source_label = f"{source} (HTTP {resp.status})"
        except Exception as e:
            return f"Failed to fetch {source}: {e}"
    elif source.startswith("file:"):
        filepath = source[5:]
        if not os.path.isabs(filepath):
            from arforge.tools.file_tools import get_workspace
            filepath = str(get_workspace() / filepath)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                body = f.read()
            source_label = filepath
        except Exception as e:
            return f"Failed to read {filepath}: {e}"
    else:
        return "source must start with http://, https://, or file:"

    lines = []
    lines.append(f"=== Frontend Validation: {source_label} ===")
    lines.append(f"Total size: {len(body)} chars")
    lines.append("")

    issues = 0

    # 1. Missing closing tags
    lines.append("--- HTML Structure ---")
    for tag in ["</body>", "</html>"]:
        if tag.lower() not in body.lower():
            lines.append(f"  [FAIL] Missing: {tag}")
            issues += 1
    if issues == 0:
        lines.append("  [OK] All required closing tags present")

    # 2. Script analysis
    lines.append("")
    lines.append("--- Script Tags ---")
    SCR_TAG = re.compile(r'<script\b([^>]*)>', re.IGNORECASE)
    SCR_CONTENT = re.compile(r'<script\b[^>]*>(.*?)</script>', re.IGNORECASE | re.DOTALL)
    SRC_ATTR = re.compile(r'src=["\'"][^"\']+["\']')
    ASYNC_DEFER = re.compile(r'\b(?:async|defer)\b', re.IGNORECASE)

    script_tags = SCR_TAG.findall(body)
    inline_scripts = SCR_CONTENT.findall(body)

    external_count = 0
    blocking_count = 0
    cdn_urls = []

    for tag in script_tags:
        src_m = SRC_ATTR.search(tag)
        if src_m:
            external_count += 1
            src = src_m.group(0)[5:-1]  # strip src=" and "
            cdn_urls.append(src)
            if not ASYNC_DEFER.search(tag):
                blocking_count += 1
                lines.append(f"  [WARN] Blocking script: {src[:80]}")

    lines.append(f"  External scripts: {external_count}")
    lines.append(f"  Blocking scripts: {blocking_count}")
    non_empty = [s for s in inline_scripts if s.strip()]
    lines.append(f"  Inline scripts: {len(non_empty)}")

    # 3. CDN URL check
    lines.append("")
    lines.append("--- CDN URL Check ---")
    for url in cdn_urls[:10]:
        try:
            req2 = urllib.request.Request(
                url, method="HEAD",
                headers={"User-Agent": "ArforgeValidator/1.0"},
            )
            with urllib.request.urlopen(req2, timeout=5) as r2:
                ct = r2.headers.get("Content-Type", "?")
                lines.append(f"  [OK] HTTP {r2.status} | {ct[:30]} | {url[:60]}")
        except Exception as e:
            lines.append(f"  [FAIL] {url[:60]} -- {e}")
            issues += 1

    # 4. JavaScript bracket balancing
    lines.append("")
    lines.append("--- JavaScript Syntax ---")
    total_ob = total_cb = total_op = total_cp = total_osb = total_csb = 0
    for js in non_empty:
        total_ob += js.count("{")
        total_cb += js.count("}")
        total_op += js.count("(")
        total_cp += js.count(")")
        total_osb += js.count("[")
        total_csb += js.count("]")

    if total_ob != total_cb:
        lines.append(f"  [FAIL] Unbalanced braces: {{{total_ob}}} {{{total_cb}}} (diff={total_ob - total_cb})")
        issues += 1
    if total_op != total_cp:
        lines.append(f"  [FAIL] Unbalanced parens: ({total_op}) ({total_cp}) (diff={total_op - total_cp})")
        issues += 1
    if total_osb != total_csb:
        lines.append(f"  [FAIL] Unbalanced brackets: [{total_osb}] [{total_csb}] (diff={total_osb - total_csb})")
        issues += 1

    if total_ob == total_cb and total_op == total_cp and total_osb == total_csb:
        lines.append("  [OK] All brackets balanced")

    # 5. Vue checks
    lines.append("")
    lines.append("--- Vue / Framework Checks ---")
    has_vue = "createApp" in body or (".mount" in body and "createRouter" in body)

    if has_vue:
        lines.append("  Framework: Vue 3 detected")

        MOUNT_RE = re.compile(r'\.mount\s*\(\s*["\'"][^"\']+["\']')
        mount_m = MOUNT_RE.search(body)
        if mount_m:
            target = mount_m.group(0).split('"')[1] if '"' in mount_m.group(0) else mount_m.group(0).split("'")[1]
            if target in body:
                lines.append(f"  [OK] Mount target '#{target}' found in HTML")
            else:
                lines.append(f"  [FAIL] Mount target '#{target}' NOT found!")
                issues += 1

        ICON_RE = re.compile(r'prefix-icon=["\'"](\w+)["\'"]')
        icon_strings = ICON_RE.findall(body)
        if icon_strings:
            lines.append(f"  [WARN] {len(icon_strings)} prefix-icon string(s): {', '.join(icon_strings)}")
            lines.append("    Element Plus Vue 3: prefix-icon needs registered icon components.")

        if "createRouter" in body:
            if "createWebHashHistory" in body:
                lines.append("  [OK] Vue Router: hash history mode")
                lines.append("    Note: hash mode means page accessed at URL/#/path")
            elif "createWebHistory" in body:
                lines.append("  [OK] Vue Router: HTML5 history mode")
            else:
                lines.append("  [WARN] Router history mode unclear")
        # Check for missing var/let/const before app = createApp (negative lookbehind avoids false positives)
        APP_DECL_BAD = re.compile(r'(?<!var\s)(?<!let\s)(?<!const\s)\bapp\s*=\s*createApp')
        if APP_DECL_BAD.search(body):
            lines.append("  [WARN] 'app = createApp()' found without var/let/const declaration")
        else:
            lines.append("  [OK] Vue app declaration looks valid")

    lines.append("")
    lines.append(f"=== Summary: {issues} issue(s) found ===")
    if issues == 0:
        lines.append("No critical issues detected. If page is blank, check browser console (F12).")

    return "\n".join(lines)
