"""General Ebbinghaus decay overview for standard retention intervals."""

from __future__ import annotations

from arforge.core.ebbinghaus import (
    next_review_interval,
    retention_at_elapsed,
    stability_for_level,
)

_HOURS = [1, 6, 24, 72, 168, 336, 720]
_LABELS = ["1h", "6h", "1d", "3d", "7d", "14d", "30d"]


def get_curve_overview() -> dict:
    """Return standard retention points and the review schedule."""
    retentions = [
        {
            "label": label,
            "hours": hours,
            "retention": round(retention_at_elapsed(float(hours)), 4),
        }
        for hours, label in zip(_HOURS, _LABELS, strict=True)
    ]

    schedule_lines = []
    for level in range(5):
        stability = stability_for_level(level)
        interval_hours = next_review_interval(level)
        schedule_lines.append(
            f"Level {level}: stability={stability:.0f}h, interval={interval_hours:.0f}h"
        )

    return {
        "retentions": retentions,
        "schedule": ", ".join(schedule_lines),
    }
