"""Web search adapter — DuckDuckGo instant answers and HTML search.

Provides a unified `web_search(query)` function that returns structured results
without any external API key requirement.
"""

from __future__ import annotations

import json
import re
import urllib.request
import urllib.parse
import urllib.error


def web_search(query: str, max_results: int = 5, timeout: int = 10) -> dict:
    """Search the web and return structured results.

    Uses DuckDuckGo's HTML search (no API key needed).  Falls back to
    instant answers API for definition-style queries.

    Returns:
        {"success": bool, "query": str, "results_count": int,
         "results": [str, ...], "source": str}
    """
    query = query.strip()[:300]
    if not query:
        return {"success": False, "error": "empty query", "query": ""}

    # Try instant answer API first (good for definitions, calculations, etc.)
    instant = _instant_answer(query, timeout)
    if instant and instant.get("answer"):
        return {
            "success": True,
            "query": query,
            "results_count": 1,
            "results": [instant["answer"]],
            "source": "duckduckgo_instant",
            "url": instant.get("url", ""),
        }

    # HTML search
    return _html_search(query, max_results, timeout)


def _instant_answer(query: str, timeout: int) -> dict | None:
    """DuckDuckGo Instant Answer API (no key needed)."""
    try:
        q = urllib.parse.quote(query)
        url = f"https://api.duckduckgo.com/?q={q}&format=json&no_html=1&skip_disambig=1"
        req = urllib.request.Request(url, headers={"User-Agent": "ArforgeAgent/0.7"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        answer = data.get("AbstractText") or data.get("Answer") or ""
        if answer:
            return {
                "answer": answer,
                "url": data.get("AbstractURL", ""),
                "source": data.get("AbstractSource", ""),
            }
        return None
    except Exception:
        return None


def _html_search(query: str, max_results: int, timeout: int) -> dict:
    """DuckDuckGo HTML search scraping."""
    try:
        q = urllib.parse.quote(query)
        url = f"https://html.duckduckgo.com/html/?q={q}"
        req = urllib.request.Request(url, headers={"User-Agent": "ArforgeAgent/0.7"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # Extract result snippets
        snippets = re.findall(
            r'class="result__snippet"[^>]*>(.*?)</a>',
            html,
            re.DOTALL,
        )
        results = []
        for s in snippets[:max_results]:
            text = re.sub(r"<[^>]+>", "", s).strip()
            if text and len(text) > 5:
                results.append(text[:500])

        if not results:
            # Fallback: broader extraction
            all_text = re.sub(r"<[^>]+>", " ", html)
            all_text = re.sub(r"\s+", " ", all_text).strip()
            results = [all_text[:500]]

        return {
            "success": True,
            "query": query,
            "results_count": len(results),
            "results": results,
            "source": "duckduckgo_html",
        }
    except urllib.error.URLError as e:
        return {
            "success": False,
            "error": f"网络连接失败: {e.reason}",
            "query": query,
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"搜索失败: {e}",
            "query": query,
        }
