"""Tests for T31: MCP M2 — Cache + CircuitBreaker + Scheduler + Graceful Shutdown."""

from __future__ import annotations

import time


from arforge.mcp_production import (
    ToolResultCache,
    CircuitBreaker,
    CircuitState,
    Scheduler,
    GracefulShutdown,
)


class TestCache:
    def test_set_and_get(self):
        c = ToolResultCache(max_size=10, default_ttl=60)
        c.set("k1", "v1")
        assert c.get("k1") == "v1"

    def test_miss_returns_none(self):
        c = ToolResultCache()
        assert c.get("nonexistent") is None

    def test_expiry(self):
        c = ToolResultCache(default_ttl=0.01)
        c.set("k1", "v1")
        time.sleep(0.02)
        assert c.get("k1") is None

    def test_lru_eviction(self):
        c = ToolResultCache(max_size=2)
        c.set("a", 1)
        c.set("b", 2)
        c.set("c", 3)  # Should evict "a"
        assert c.get("a") is None
        assert c.get("b") == 2
        assert c.get("c") == 3

    def test_hit_refreshes_lru(self):
        c = ToolResultCache(max_size=2)
        c.set("a", 1)
        c.set("b", 2)
        c.get("a")  # Access "a" — moves to end
        c.set("c", 3)  # Should evict "b"
        assert c.get("a") == 1
        assert c.get("b") is None
        assert c.get("c") == 3

    def test_invalidate(self):
        c = ToolResultCache()
        c.set("k", "v")
        assert c.invalidate("k") is True
        assert c.get("k") is None
        assert c.invalidate("k") is False

    def test_clear(self):
        c = ToolResultCache()
        c.set("a", 1)
        c.set("b", 2)
        c.clear()
        assert c.get("a") is None

    def test_evict_expired(self):
        c = ToolResultCache(default_ttl=0.01)
        c.set("a", 1)
        time.sleep(0.02)
        removed = c.evict_expired()
        assert removed == 1
        assert c.get("a") is None

    def test_stats(self):
        c = ToolResultCache()
        c.set("k", "v")
        c.get("k")
        c.get("nonexistent")
        stats = c.stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 1
        assert stats["hit_rate"] == 0.5


class TestCircuitBreaker:
    def test_initial_state_closed(self):
        cb = CircuitBreaker("test")
        assert cb.state == CircuitState.CLOSED
        assert cb.allow_request() is True

    def test_opens_after_threshold(self):
        cb = CircuitBreaker("test", failure_threshold=3)
        for _ in range(3):
            assert cb.allow_request()
            cb.record_failure()
        assert cb.state == CircuitState.OPEN
        assert cb.allow_request() is False

    def test_half_open_after_timeout(self):
        cb = CircuitBreaker("test", failure_threshold=1, recovery_timeout=0.01)
        cb.record_failure()
        assert cb.state == CircuitState.OPEN
        time.sleep(0.02)
        assert cb.allow_request() is True  # Now HALF_OPEN
        assert cb.state == CircuitState.HALF_OPEN

    def test_half_open_closes_on_success(self):
        cb = CircuitBreaker("test", failure_threshold=1, recovery_timeout=0.01)
        cb.record_failure()
        time.sleep(0.02)
        cb.allow_request()
        cb.record_success()
        assert cb.state == CircuitState.CLOSED

    def test_half_open_opens_on_failure(self):
        cb = CircuitBreaker("test", failure_threshold=1, recovery_timeout=0.01)
        cb.record_failure()
        time.sleep(0.02)
        cb.allow_request()
        cb.record_failure()
        assert cb.state == CircuitState.OPEN


class TestScheduler:
    def test_add_and_start_stop(self):
        s = Scheduler()
        counter = [0]

        def inc():
            counter[0] += 1

        s.add("inc", 0.05, inc)
        s.start()
        # Wait for scheduler to run a few cycles
        deadline = time.time() + 1.5
        while time.time() < deadline and counter[0] < 3:
            time.sleep(0.05)
        s.stop()
        assert counter[0] >= 1  # At least one execution


class TestGracefulShutdown:
    def test_enter_and_leave(self):
        gs = GracefulShutdown()
        assert gs.enter() is True
        assert gs.shutting_down is False
        gs.leave()

    def test_rejects_after_shutdown(self):
        gs = GracefulShutdown()
        gs.shutdown()
        assert gs.shutting_down is True
        assert gs.enter() is False

    def test_drains_in_flight(self):
        gs = GracefulShutdown(drain_timeout=5.0)
        gs.enter()
        gs.shutdown()
        assert gs.shutting_down is True
        gs.leave()

    def test_shutdown_callbacks(self):
        gs = GracefulShutdown()
        called = []

        gs.on_shutdown(lambda: called.append(1))
        gs.shutdown()
        assert len(called) == 1
