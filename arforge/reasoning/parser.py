"""Parse structured reasoning output from model responses.

Handles XML-tagged reasoning blocks with robust fallback for malformed output.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class ReasoningResult:
    """Parsed reasoning output from a model response."""

    understanding: str = ""
    thinking: str = ""
    evidence: str = ""
    reflection: str = ""
    answer: str = ""

    # Metadata
    raw_response: str = ""
    parse_success: bool = False
    missing_tags: list[str] = field(default_factory=list)
    reasoning_mode: str = "full"  # "full" | "quick" | "fallback"

    @property
    def has_full_reasoning(self) -> bool:
        return bool(self.thinking and self.answer)

    @property
    def reasoning_summary(self) -> str:
        """One-line summary of the reasoning for trace/debug."""
        if self.thinking:
            return self.thinking.split("\n")[0][:120]
        return "(no reasoning)"

    def to_dict(self) -> dict:
        return {
            "understanding": self.understanding,
            "thinking": self.thinking,
            "evidence": self.evidence,
            "reflection": self.reflection,
            "answer": self.answer,
            "parse_success": self.parse_success,
            "missing_tags": self.missing_tags,
            "reasoning_mode": self.reasoning_mode,
        }


# ---------------------------------------------------------------------------
# Tag extraction
# ---------------------------------------------------------------------------

# Regex patterns for each reasoning tag
_TAG_PATTERNS = {
    "understanding": re.compile(
        r"<understanding>\s*(.*?)\s*</understanding>", re.DOTALL | re.IGNORECASE
    ),
    "thinking": re.compile(
        r"<thinking>\s*(.*?)\s*</thinking>", re.DOTALL | re.IGNORECASE
    ),
    "evidence": re.compile(
        r"<evidence>\s*(.*?)\s*</evidence>", re.DOTALL | re.IGNORECASE
    ),
    "reflection": re.compile(
        r"<reflection>\s*(.*?)\s*</reflection>", re.DOTALL | re.IGNORECASE
    ),
    "answer": re.compile(
        r"<answer>\s*(.*?)\s*</answer>", re.DOTALL | re.IGNORECASE
    ),
}

# Fallback: try markdown-style headers
_MD_PATTERNS = {
    "understanding": re.compile(r"#+\s*Understanding\s*\n+(.*?)(?=#+\s*|\Z)", re.DOTALL | re.IGNORECASE),
    "thinking": re.compile(r"#+\s*Thinking\s*\n+(.*?)(?=#+\s*|\Z)", re.DOTALL | re.IGNORECASE),
    "evidence": re.compile(r"#+\s*Evidence\s*\n+(.*?)(?=#+\s*|\Z)", re.DOTALL | re.IGNORECASE),
    "reflection": re.compile(r"#+\s*Reflection\s*\n+(.*?)(?=#+\s*|\Z)", re.DOTALL | re.IGNORECASE),
    "answer": re.compile(r"#+\s*Answer\s*\n+(.*?)(?=#+\s*|\Z)", re.DOTALL | re.IGNORECASE),
}


def _extract_tag(text: str, tag_name: str) -> tuple[str, bool]:
    """Extract content from an XML tag. Returns (content, found)."""
    pattern = _TAG_PATTERNS.get(tag_name)
    if pattern:
        match = pattern.search(text)
        if match:
            return match.group(1).strip(), True
    return "", False


def _extract_tag_markdown(text: str, tag_name: str) -> tuple[str, bool]:
    """Fallback: extract content from markdown-style headers."""
    pattern = _MD_PATTERNS.get(tag_name)
    if pattern:
        match = pattern.search(text)
        if match:
            return match.group(1).strip(), True
    return "", False


# ---------------------------------------------------------------------------
# Main parse function
# ---------------------------------------------------------------------------


def parse_reasoning(raw_response: str) -> ReasoningResult:
    """Parse a model response into structured reasoning blocks.

    Tries XML tags first, falls back to markdown headers,
    and finally treats the whole response as the answer.
    """
    if not raw_response or not raw_response.strip():
        return ReasoningResult(
            answer="(empty response)",
            raw_response=raw_response,
            parse_success=False,
            missing_tags=["answer"],
            reasoning_mode="fallback",
        )

    result = ReasoningResult(raw_response=raw_response)
    missing: list[str] = []

    # Try XML extraction first
    for tag_name in ("understanding", "thinking", "evidence", "reflection", "answer"):
        content, found = _extract_tag(raw_response, tag_name)
        if found:
            setattr(result, tag_name, content)
        else:
            missing.append(tag_name)

    # If answer tag is missing, try markdown fallback
    if not result.answer:
        answer_md, found_md = _extract_tag_markdown(raw_response, "answer")
        if found_md:
            result.answer = answer_md
            if "answer" in missing:
                missing.remove("answer")

    # Determine parse success
    has_answer = bool(result.answer)
    has_reasoning = bool(result.thinking) or bool(result.understanding)

    if has_answer and has_reasoning:
        result.parse_success = True
        result.reasoning_mode = "full"
    elif has_answer:
        # Model gave an answer but skipped some reasoning tags — partial success
        result.parse_success = True
        result.reasoning_mode = "quick"
    else:
        # Complete parse failure — treat entire response as answer
        result.parse_success = False
        result.reasoning_mode = "fallback"
        result.answer = raw_response.strip()

    result.missing_tags = missing
    return result


def strip_reasoning_tags(text: str) -> str:
    """Remove reasoning XML tags, leaving only the answer content.

    Useful when you want to show only the answer to the user.
    """
    # If there's an <answer> tag, extract just that
    answer, found = _extract_tag(text, "answer")
    if found:
        return answer

    # Otherwise strip all reasoning tags but keep their content
    for tag_name in _TAG_PATTERNS:
        text = re.sub(rf"<\s*{tag_name}\s*>", "", text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(rf"<\s*/\s*{tag_name}\s*>", "", text, flags=re.DOTALL | re.IGNORECASE)

    return text.strip()


def extract_answer_only(raw_response: str) -> str:
    """Convenience: extract just the answer from a reasoning response."""
    result = parse_reasoning(raw_response)
    return result.answer
