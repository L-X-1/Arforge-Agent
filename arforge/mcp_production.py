"""MCP Server Framework — M2 (T31): Scheduler + Cache + CircuitBreaker + Graceful Shutdown.

Production-grade hardening for MCP servers:
  - ToolResultCache: TTL-based cache with LRU eviction
  - CircuitBreaker: fail-fast after threshold failures, auto-recovery
  - Scheduler: periodic cleanup tasks (session expiry, cache eviction)
  - GracefulShutdown: drain in-flight requests, close connections
"""

from __future__ import annotations

import logging
import signal
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


# ====================================================================
# Cache
# ====================================================================


@dataclass
class CacheEntry:
    value: object
    inserted_at: float
    ttl: float  # seconds


class ToolResultCache:
    """Thread-safe TTL cache with LRU eviction for MCP tool results."""

    def __init__(self, max_size: int = 256, default_ttl: float = 60.0) -> None:
        self._store: OrderedDict[str, CacheEntry] = OrderedDict()
        self._max_size = max_size
        self._default_ttl = default_ttl
        self._lock = threading.RLock()
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> object | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self._misses += 1
                return None
            if time.time() - entry.inserted_at > entry.ttl:
                del self._store[key]
                self._misses += 1
                return None
            # Move to end (LRU)
            self._store.move_to_end(key)
            self._hits += 1
            return entry.value

    def set(self, key: str, value: object, ttl: float | None = None) -> None:
        ttl = ttl if ttl is not None else self._default_ttl
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
            self._store[key] = CacheEntry(value, time.time(), ttl)
            while len(self._store) > self._max_size:
                self._store.popitem(last=False)  # Remove oldest

    def invalidate(self, key: str) -> bool:
        with self._lock:
            if key in self._store:
                del self._store[key]
                return True
            return False

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def evict_expired(self) -> int:
        with self._lock:
            now = time.time()
            expired = [
                k for k, e in self._store.items()
                if now - e.inserted_at > e.ttl
            ]
            for k in expired:
                del self._store[k]
            return len(expired)

    def stats(self) -> dict:
        with self._lock:
            total = self._hits + self._misses
            return {
                "size": len(self._store),
                "max_size": self._max_size,
                "hits": self._hits,
                "misses": self._misses,
                "hit_rate": round(self._hits / max(total, 1), 3),
            }


# ====================================================================
# Circuit Breaker
# ====================================================================


class CircuitState(str, Enum):
    CLOSED = "closed"          # Normal — requests pass through
    OPEN = "open"              # Failing — requests rejected immediately
    HALF_OPEN = "half_open"    # Testing recovery — limited requests allowed


@dataclass
class CircuitBreaker:
    """Fail-fast circuit breaker to prevent cascading failures.

    Transitions:
      CLOSED → OPEN after `failure_threshold` consecutive failures
      OPEN → HALF_OPEN after `recovery_timeout` seconds
      HALF_OPEN → CLOSED on first success
      HALF_OPEN → OPEN on first failure
    """

    name: str
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    half_open_max: int = 1

    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    last_failure_time: float = 0.0
    half_open_count: int = 0
    total_failures: int = 0
    total_successes: int = 0

    _lock: threading.RLock = field(default_factory=threading.RLock)

    def allow_request(self) -> bool:
        with self._lock:
            if self.state == CircuitState.CLOSED:
                return True
            if self.state == CircuitState.OPEN:
                if time.time() - self.last_failure_time >= self.recovery_timeout:
                    self.state = CircuitState.HALF_OPEN
                    self.half_open_count = 0
                    logger.info("circuit %s: OPEN -> HALF_OPEN", self.name)
                    return True
                return False
            # HALF_OPEN
            if self.half_open_count < self.half_open_max:
                self.half_open_count += 1
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            self.total_successes += 1
            if self.state == CircuitState.HALF_OPEN:
                self.state = CircuitState.CLOSED
                self.failure_count = 0
                logger.info("circuit %s: HALF_OPEN -> CLOSED", self.name)
            self.failure_count = 0

    def record_failure(self) -> None:
        with self._lock:
            self.total_failures += 1
            self.failure_count += 1
            self.last_failure_time = time.time()
            if self.state == CircuitState.HALF_OPEN:
                self.state = CircuitState.OPEN
                logger.warning("circuit %s: HALF_OPEN -> OPEN", self.name)
            elif self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN
                logger.warning(
                    "circuit %s: CLOSED -> OPEN (%d failures)",
                    self.name, self.failure_count,
                )

    def stats(self) -> dict:
        with self._lock:
            return {
                "name": self.name,
                "state": self.state.value,
                "failure_count": self.failure_count,
                "total_failures": self.total_failures,
                "total_successes": self.total_successes,
            }


# ====================================================================
# Scheduler
# ====================================================================


class Scheduler:
    """Lightweight periodic task scheduler (no external deps)."""

    def __init__(self) -> None:
        self._tasks: list[dict] = []
        self._running = False
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()

    def add(self, name: str, interval: float, func: callable) -> None:
        """Add a periodic task. interval in seconds."""
        with self._lock:
            self._tasks.append({
                "name": name,
                "interval": interval,
                "last_run": time.time(),
                "func": func,
            })

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="mcp-scheduler")
        self._thread.start()
        logger.info("scheduler started with %d tasks", len(self._tasks))

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=5.0)
        logger.info("scheduler stopped")

    def _run_loop(self) -> None:
        while self._running:
            now = time.time()
            with self._lock:
                for task in self._tasks:
                    if now - task["last_run"] >= task["interval"]:
                        try:
                            task["func"]()
                        except Exception as exc:
                            logger.warning("scheduler task %s failed: %s", task["name"], exc)
                        task["last_run"] = now
            time.sleep(1.0)


# ====================================================================
# Graceful Shutdown
# ====================================================================


class GracefulShutdown:
    """Signal-aware graceful shutdown with in-flight request draining."""

    def __init__(self, drain_timeout: float = 30.0) -> None:
        self._drain_timeout = drain_timeout
        self._shutting_down = False
        self._in_flight = 0
        self._lock = threading.RLock()
        self._shutdown_callbacks: list[callable] = []

    @property
    def shutting_down(self) -> bool:
        return self._shutting_down

    def on_shutdown(self, callback: callable) -> None:
        self._shutdown_callbacks.append(callback)

    def enter(self) -> bool:
        """Called at request start. Returns False if shutting down."""
        with self._lock:
            if self._shutting_down:
                return False
            self._in_flight += 1
            return True

    def leave(self) -> None:
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)

    def shutdown(self) -> None:
        """Initiate graceful shutdown."""
        with self._lock:
            if self._shutting_down:
                return
            self._shutting_down = True
        logger.info("graceful shutdown initiated (in-flight: %d)", self._in_flight)

        # Wait for in-flight requests to drain
        deadline = time.time() + self._drain_timeout
        while time.time() < deadline:
            with self._lock:
                if self._in_flight == 0:
                    break
            time.sleep(0.1)

        with self._lock:
            remaining = self._in_flight
        if remaining:
            logger.warning("shutdown with %d requests still in-flight", remaining)

        # Run shutdown callbacks
        for cb in self._shutdown_callbacks:
            try:
                cb()
            except Exception as exc:
                logger.warning("shutdown callback failed: %s", exc)

        logger.info("graceful shutdown complete")

    def install_signal_handlers(self) -> None:
        """Install SIGINT/SIGTERM handlers for graceful shutdown."""
        def _handler(signum, frame):
            logger.info("received signal %d, initiating shutdown", signum)
            self.shutdown()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):
                pass  # Not available in all environments

    def stats(self) -> dict:
        with self._lock:
            return {
                "shutting_down": self._shutting_down,
                "in_flight": self._in_flight,
            }


# ====================================================================
# Production Server Builder
# ====================================================================


class ProductionMCPServer:
    """Production-grade MCP server with all M2 hardening.

    Bundles: MCPServer + HTTPTransport + Cache + CircuitBreaker +
    Scheduler + GracefulShutdown.
    """

    def __init__(
        self,
        name: str,
        version: str,
        host: str = "127.0.0.1",
        port: int = 8800,
    ) -> None:
        from arforge.mcp_server import MCPServer
        from arforge.mcp_http import HTTPTransport

        self.server = MCPServer(name, version)
        self.transport = HTTPTransport(self.server, host, port)
        self.transport.setup_defaults()

        self.cache = ToolResultCache()
        self.circuit_breaker = CircuitBreaker(f"{name}-tools")
        self.scheduler = Scheduler()
        self.shutdown = GracefulShutdown()

        # Schedule periodic tasks
        self.scheduler.add("cache-evict", 30.0, self.cache.evict_expired)
        self.scheduler.add("session-cleanup", 300.0, self.transport.sessions.cleanup_expired)

        # Install signal handlers
        self.shutdown.install_signal_handlers()
        self.shutdown.on_shutdown(self.scheduler.stop)
        self.shutdown.on_shutdown(self.transport.stop)

    def tool(self, description: str = "", input_schema: dict | None = None):
        """Decorator — wraps tools with circuit breaker + cache."""
        def decorator(func):
            name = func.__name__

            def safe_handler(**kwargs):
                if not self.shutdown.enter():
                    return "Server is shutting down"
                try:
                    cache_key = f"{name}:{str(sorted(kwargs.items()))}"
                    # Check cache first
                    cached = self.cache.get(cache_key)
                    if cached is not None:
                        return str(cached)

                    if not self.circuit_breaker.allow_request():
                        return "Circuit breaker is open — try again later"

                    result = func(**kwargs)
                    self.circuit_breaker.record_success()
                    self.cache.set(cache_key, result)
                    return result
                except Exception:
                    self.circuit_breaker.record_failure()
                    raise
                finally:
                    self.shutdown.leave()

            safe_handler.__name__ = name
            self.server.registry.register(name, safe_handler, description, input_schema)
            return safe_handler

        return decorator

    def run(self) -> None:
        self.scheduler.start()
        try:
            self.transport.run()
        finally:
            self.shutdown.shutdown()
