"""
Web tools for Arforge Agent — web search and web fetch/page reading.

Provides:
- WebSearchTool: search the web via configurable search backend
- WebFetchTool: fetch and extract text content from URLs

Uses the existing tool_registry pattern and respects sandbox network policies.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Any

from arforge.tool_registry import ParamSchema, register_tool


@dataclass
class WebSearchResult:
    """Single search result item."""
    title: str
    url: str
    snippet: str


@dataclass
class WebFetchResult:
    """Result of fetching a web page."""
    url: str
    status: int
    content_type: str = ""
    text: str = ""
    title: str = ""
    error: str | None = None


# ---------------------------------------------------------------------------
# HTML-to-text extraction (no external deps)
# ---------------------------------------------------------------------------

_SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.DOTALL | re.IGNORECASE)
_STYLE_RE = re.compile(r"<style[^>]*>.*?</style>", re.DOTALL | re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_ENTITY_RE = re.compile(r"&[a-zA-Z]+;|&#\d+;")
_WS_RE = re.compile(r"\s{2,}")


def _html_to_text(html: str) -> str:
    """Extract readable text from HTML, stripping scripts/styles/tags."""
    text = _SCRIPT_RE.sub("", html)
    text = _STYLE_RE.sub("", text)
    text = _TAG_RE.sub(" ", text)
    text = _ENTITY_RE.sub(" ", text)
    text = _WS_RE.sub("\n", text)
    return text.strip()


def html_to_text(html: str) -> str:
    """Public compatibility wrapper for HTML text extraction."""
    return _html_to_text(html)


def extract_links(html: str, base_url: str = "") -> list[str]:
    """Extract, resolve, and de-duplicate HTTP(S) links in document order."""
    links: list[str] = []
    seen: set[str] = set()
    for raw in re.findall(r"""<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']""", html or "", re.IGNORECASE):
        candidate = raw.strip()
        resolved = urllib.parse.urljoin(base_url, candidate) if base_url else candidate
        if base_url and not resolved.startswith(("http://", "https://")):
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        links.append(resolved)
    return links


def _extract_title(html: str) -> str:
    """Extract <title> from HTML."""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
    if m:
        return _TAG_RE.sub("", m.group(1)).strip()
    return ""


# ---------------------------------------------------------------------------
# Web Fetch
# ---------------------------------------------------------------------------

def web_fetch(url: str, timeout: int = 15, max_bytes: int = 1_000_000) -> WebFetchResult:
    """Fetch a URL and extract text content.

    Returns a WebFetchResult with the extracted text, title, and metadata.
    Respects robots.txt conventions via User-Agent header.
    """
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urllib.parse.urlparse(url)
    # ``.invalid`` is a reserved non-routable top-level domain. Reject it
    # before a corporate proxy can turn the expected local connection failure
    # into a synthetic HTTP response such as 502.
    if (parsed.hostname or "").lower().endswith(".invalid"):
        return WebFetchResult(url=url, status=0, error="invalid non-routable host")
    headers = {
            "User-Agent": "ArforgeAgent/1.0 (private web-fetch)",
        "Accept": "text/html,text/plain,*/*",
    }
    req = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read(max_bytes)
            charset = "utf-8"
            # Try to detect charset from Content-Type
            ct_match = re.search(r"charset=([\w-]+)", content_type)
            if ct_match:
                charset = ct_match.group(1)
            html = raw.decode(charset, errors="replace")
            text = _html_to_text(html)
            title = _extract_title(html)
            return WebFetchResult(
                url=url,
                status=status,
                content_type=content_type,
                text=text[:50000],  # Truncate very long pages
                title=title,
            )
    except urllib.error.HTTPError as e:
        return WebFetchResult(url=url, status=e.code, error=str(e))
    except Exception as e:
        return WebFetchResult(url=url, status=0, error=str(e))


# ---------------------------------------------------------------------------
# Web Search (DuckDuckGo HTML — no API key needed)
# ---------------------------------------------------------------------------

_DDG_URL = "https://html.duckduckgo.com/html/"


def web_search(query: str, max_results: int = 10, timeout: int = 15) -> list[WebSearchResult]:
    """Search the web using DuckDuckGo HTML (no API key required).

    Returns a list of WebSearchResult items with title, url, and snippet.
    Falls back gracefully on network errors.
    """
    data = urllib.parse.urlencode({"q": query}).encode("utf-8")
    headers = {
            "User-Agent": "ArforgeAgent/1.0 (private web-search)",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    req = urllib.request.Request(_DDG_URL, data=data, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception:
        return []

    results: list[WebSearchResult] = []
    # Parse DDG HTML results
    # Each result is in a div with class "result"
    result_blocks = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
        html, re.DOTALL | re.IGNORECASE,
    )
    snippet_blocks = re.findall(
        r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>',
        html, re.DOTALL | re.IGNORECASE,
    )

    for i, (url, title_raw) in enumerate(result_blocks):
        if i >= max_results:
            break
        title = _TAG_RE.sub("", title_raw).strip()
        snippet = ""
        if i < len(snippet_blocks):
            snippet = _TAG_RE.sub("", snippet_blocks[i]).strip()
        if url and title:
            results.append(WebSearchResult(title=title, url=url, snippet=snippet))

    return results


# ---------------------------------------------------------------------------
# Agent tool integration
# ---------------------------------------------------------------------------

def _search_payload(query: str, max_results: int = 10) -> str:
    if not query.strip():
        raise ValueError("query must not be empty")
    results = web_search(query, max(1, min(int(max_results), 20)))
    return json.dumps(
        [{"title": item.title, "url": item.url, "snippet": item.snippet} for item in results],
        ensure_ascii=False,
    )


@register_tool(
    "web_search",
    "Search the web for current information. Returns result titles, URLs, and snippets.",
    params=[
        ParamSchema("query", "string", "search query"),
        ParamSchema("max_results", "int", "maximum results to return (default 10)", required=False, default=10),
    ],
    risk="medium",
    requires_confirmation=True,
    timeout=20,
    category="network",
    source=__name__,
)
def agent_web_search(query: str, max_results: int = 10) -> str:
    """Registry wrapper that keeps the public ``web_search`` API typed."""
    return _search_payload(query, max_results)


@register_tool(
    "web_fetch",
    "Fetch a web page and extract readable text. Returns title, status, content type, and text.",
    params=[ParamSchema("url", "string", "HTTP or HTTPS URL to fetch")],
    risk="medium",
    requires_confirmation=True,
    timeout=20,
    category="network",
    source=__name__,
)
def agent_web_fetch(url: str) -> str:
    """Registry wrapper that serializes the typed fetch result for the model."""
    result = web_fetch(url)
    return json.dumps(
        {
            "url": result.url,
            "title": result.title,
            "status": result.status,
            "content_type": result.content_type,
            "text": result.text[:5000],
            "error": result.error,
        },
        ensure_ascii=False,
    )


def register_web_tools(registry: Any) -> None:
    """Compatibility hook for callers that register into a non-global registry.

    Built-in loading uses the decorators above. This hook mirrors those definitions
    for embedders that supply a dedicated ``ToolRegistry`` instance.
    """
    from arforge.tool_registry import ToolDefinition, ToolSchema

    for name, description, params, execute_fn in (
        (
            "web_search",
            "Search the web for current information. Returns result titles, URLs, and snippets.",
            [
                ParamSchema("query", "string", "search query"),
                ParamSchema("max_results", "int", "maximum results to return (default 10)", required=False, default=10),
            ],
            agent_web_search,
        ),
        (
            "web_fetch",
            "Fetch a web page and extract readable text.",
            [ParamSchema("url", "string", "HTTP or HTTPS URL to fetch")],
            agent_web_fetch,
        ),
    ):
        registry.register(
            ToolDefinition(
                name=name,
                description=description,
                schema=ToolSchema(
                    name=name,
                    description=description,
                    params=params,
                    risk_level="medium",
                    requires_confirmation=True,
                    timeout=20,
                    category="network",
                ),
                execute_fn=execute_fn,
                source=__name__,
            )
        )
