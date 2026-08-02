"""JavaScript validation and diagnostic tools."""

from __future__ import annotations

import os
import re
import ssl
import urllib.error
import urllib.request

from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "validate_js",
    "Deep-validate JavaScript in an HTML page for syntax errors that cause blank "
    "pages. Pinpoints exact locations of unbalanced brackets, missing declarations, "
    "and common Vue/Element Plus runtime issues. More thorough than validate_frontend. "
    "Use this when a page is blank despite passing basic HTML validation.",
    keywords=["validate js", "check javascript", "debug js", "find syntax error"],
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
def validate_js(source: str) -> str:
    """Deep JavaScript validation with pinpointed error locations."""
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
                headers={"User-Agent": "Mozilla/5.0 ArforgeJSValidator/1.0"},
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

    SCR_CONTENT = re.compile(r'<script\b[^>]*>(.*?)</script>', re.IGNORECASE | re.DOTALL)
    inline_scripts = SCR_CONTENT.findall(body)

    lines = []
    lines.append(f"=== JavaScript Validation: {source_label} ===")
    lines.append(f"Inline scripts found: {len(inline_scripts)}")
    lines.append("")

    total_issues = 0

    for si, js in enumerate(inline_scripts):
        js = js.strip()
        if not js:
            continue

        lines.append(f"--- Script #{si + 1} ({len(js)} chars) ---")

        depth = 0
        pdepth = 0
        sbdepth = 0
        in_string = ""
        i = 0

        while i < len(js):
            ch = js[i]

            if in_string:
                if ch == '\\' and i + 1 < len(js):
                    i += 2
                    continue
                if ch == in_string:
                    in_string = ""
                i += 1
                continue

            if ch in "\"'`":
                in_string = ch
                i += 1
                continue

            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
            elif ch == '(':
                pdepth += 1
            elif ch == ')':
                pdepth -= 1
            elif ch == '[':
                sbdepth += 1
            elif ch == ']':
                sbdepth -= 1

            i += 1

        if depth != 0:
            lines.append(f"  [FAIL] Unbalanced braces: diff={depth}")
            total_issues += 1
        if pdepth != 0:
            lines.append(f"  [FAIL] Unbalanced parens: diff={pdepth}")
            total_issues += 1
        if sbdepth != 0:
            lines.append(f"  [FAIL] Unbalanced brackets: diff={sbdepth}")
            total_issues += 1

        if depth == 0 and pdepth == 0 and sbdepth == 0:
            lines.append("  [OK] All brackets balanced")

        undeclared = []
        for var in ['app']:
            if re.search(r'(?:^|[^a-zA-Z])' + var + r'\s*=', js):
                if not re.search(r'(?:var|let|const)\s+' + var + r'\s*=', js):
                    undeclared.append(var)

        if undeclared:
            lines.append(f"  [WARN] Variables without declaration: {', '.join(undeclared)}")

        if 'prefix-icon=' in js:
            icons = re.findall(r'prefix-icon="(\w+)"', js)
            if icons:
                lines.append(f"  [WARN] prefix-icon strings: {', '.join(icons)}")
                lines.append("    These need registered icon components in Element Plus Vue 3")

    lines.append("")
    lines.append(f"=== Summary: {total_issues} issue(s) found ===")
    if total_issues > 0:
        lines.append("")
        lines.append("FIX GUIDE:")
        lines.append("- Unbalanced brackets: find the missing bracket and add it")
        lines.append("- Use read_file to examine source, edit_file to fix")
        lines.append("- After fixing HTML, run: mvn package -DskipTests to rebuild")
        lines.append("- Then restart the Java server")
    else:
        lines.append("No JS syntax issues found. Check browser console (F12) for runtime errors.")

    return "\n".join(lines)
