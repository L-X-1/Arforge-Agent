"""Tests for web_tools.py — web search and fetch."""
from arforge.tools.web_tools import (
    WebSearchResult,
    WebFetchResult,
    web_search,
    web_fetch,
    _html_to_text,
    _extract_title,
)


class TestHtmlToText:
    def test_strips_scripts(self):
        html = "<html><script>alert('xss')</script><p>Hello</p></html>"
        text = _html_to_text(html)
        assert "Hello" in text
        assert "alert" not in text

    def test_strips_styles(self):
        html = "<html><style>.foo{color:red}</style><p>Content</p></html>"
        text = _html_to_text(html)
        assert "Content" in text
        assert ".foo" not in text

    def test_collapses_whitespace(self):
        html = "<p>a   b\n\n\nc</p>"
        text = _html_to_text(html)
        # Multiple spaces/newlines collapsed
        assert "a" in text and "b" in text and "c" in text

    def test_empty_input(self):
        assert _html_to_text("") == ""


class TestExtractTitle:
    def test_extracts_simple_title(self):
        html = "<html><head><title>My Page</title></head><body></body></html>"
        assert _extract_title(html) == "My Page"

    def test_no_title(self):
        assert _extract_title("<html><body>No title</body></html>") == ""


class TestWebSearchResult:
    def test_creation(self):
        r = WebSearchResult(title="Test", url="https://example.com", snippet="A test result")
        assert r.title == "Test"
        assert r.url == "https://example.com"


class TestWebFetchResult:
    def test_creation(self):
        r = WebFetchResult(url="https://example.com", status=200, text="content")
        assert r.status == 200
        assert r.text == "content"

    def test_error_result(self):
        r = WebFetchResult(url="https://bad.url", status=0, error="Connection refused")
        assert r.error is not None


class TestWebSearch:
    def test_returns_list(self):
        results = web_search("python programming")
        assert isinstance(results, list)

    def test_respects_max_results(self):
        results = web_search("test", max_results=3)
        assert len(results) <= 3

    def test_empty_query(self):
        results = web_search("")
        assert isinstance(results, list)


class TestWebFetch:
    def test_fetch_invalid_url(self):
        result = web_fetch("http://not-a-valid-url-xyz123.invalid", timeout=5)
        assert result.status == 0
        assert result.error is not None

    def test_fetch_result_has_fields(self):
        result = web_fetch("https://example.com", timeout=10)
        assert hasattr(result, "url")
        assert hasattr(result, "status")
        assert hasattr(result, "text")
