"""Feedback recording helpers."""

from __future__ import annotations

from arforge.learning import update_learning_profile


def record_feedback(rating: int, response_type: str = "answer", user_input: str = "") -> dict:
    update_learning_profile(rating, response_type, user_input)
    return {"success": True, "rating": rating, "response_type": response_type}
