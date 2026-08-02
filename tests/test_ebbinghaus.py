# -*- coding: utf-8 -*-
"""Tests for Ebbinghaus forgetting curve and spaced repetition."""

from __future__ import annotations

import math
import pytest
from datetime import datetime, timedelta, timezone


class TestRetention:
    def test_retention_at_zero_elapsed(self):
        from arforge.core.ebbinghaus import retention_at_elapsed
        assert retention_at_elapsed(0) == pytest.approx(1.0)

    def test_retention_decays_over_time(self):
        from arforge.core.ebbinghaus import retention_at_elapsed
        r1 = retention_at_elapsed(24)
        r2 = retention_at_elapsed(168)
        assert r1 > r2
        assert 0 < r1 < 1.0

    def test_retention_at_stability(self):
        from arforge.core.ebbinghaus import retention_at_elapsed
        r = retention_at_elapsed(48, stability=48)
        assert r == pytest.approx(math.exp(-1), rel=1e-6)

    def test_higher_stability_slower_decay(self):
        from arforge.core.ebbinghaus import retention_at_elapsed
        r_low = retention_at_elapsed(100, stability=48)
        r_high = retention_at_elapsed(100, stability=480)
        assert r_high > r_low


class TestStability:
    def test_stability_increases_with_level(self):
        from arforge.core.ebbinghaus import stability_for_level
        s0 = stability_for_level(0)
        s3 = stability_for_level(3)
        assert s3 > s0

    def test_stability_caps_at_level_7(self):
        from arforge.core.ebbinghaus import stability_for_level
        s7 = stability_for_level(7)
        s10 = stability_for_level(10)
        assert s10 == s7


class TestReviewSchedule:
    def test_intervals_by_level(self):
        from arforge.core.ebbinghaus import next_review_interval
        assert next_review_interval(0) == 1.0
        assert next_review_interval(1) == 24.0
        assert next_review_interval(2) == 72.0

    def test_is_due_no_prior(self):
        from arforge.core.ebbinghaus import is_due_for_review
        assert is_due_for_review(None) is True

    def test_is_due_recently_reviewed(self):
        from arforge.core.ebbinghaus import is_due_for_review
        recent = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        assert is_due_for_review(recent, review_level=0) is False

    def test_is_due_long_ago(self):
        from arforge.core.ebbinghaus import is_due_for_review
        old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        assert is_due_for_review(old, review_level=0) is True


class TestStrengthCalculation:
    def test_fresh_memory_full_strength(self):
        from arforge.core.ebbinghaus import calculate_current_strength
        now = datetime.now(timezone.utc).isoformat()
        s = calculate_current_strength(created_at=now, review_level=0)
        assert s == pytest.approx(1.0)

    def test_old_memory_decayed(self):
        from arforge.core.ebbinghaus import calculate_current_strength
        old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        s = calculate_current_strength(created_at=old, review_level=0)
        assert s < 0.5


class TestBulkDecay:
    def test_bulk_decay_adds_fields(self):
        from arforge.core.ebbinghaus import bulk_decay
        mems = [
            {"created_at": None, "strength": 1.0, "review_level": 0},
            {"created_at": (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
             "strength": 1.0, "review_level": 0},
        ]
        result = bulk_decay(mems)
        assert len(result) == 2
        for m in result:
            assert "current_strength" in m
            assert "is_due" in m
            assert "retention" in m
        assert result[1]["is_due"] is True
