"""Planning result evaluators."""

from __future__ import annotations


def evaluate_answer(answer: str, expected_keywords: list[str] = None) -> dict:
    expected_keywords = expected_keywords or []
    missing = [word for word in expected_keywords if word.lower() not in answer.lower()]
    return {"score": 1.0 if not missing else max(0.0, 1.0 - len(missing) / len(expected_keywords)), "missing": missing}
