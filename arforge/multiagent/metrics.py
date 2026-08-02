"""DispatchMetrics and DispatchReport — structured observability for multi-agent dispatch.

Provides per-agent counters, timing, escalation tracking, and a
human-readable dispatch report. Designed for multi-agent coordination workflows
observability standards: every dispatch produces a structured report.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class AgentMetrics:
    """Per-agent statistics collected during dispatch."""
    role: str
    tasks_total: int = 0
    tasks_succeeded: int = 0
    tasks_failed: int = 0
    tokens_used: int = 0
    total_elapsed_ms: int = 0
    escalations: int = 0
    retries: int = 0

    @property
    def success_rate(self) -> float:
        if self.tasks_total == 0:
            return 1.0
        return self.tasks_succeeded / self.tasks_total


@dataclass
class DispatchReport:
    """Structured report produced after a multi-agent dispatch completes."""
    conversation_id: str = ""
    total_tasks: int = 0
    total_results: int = 0
    tasks_succeeded: int = 0
    tasks_failed: int = 0
    tokens_used: int = 0
    total_elapsed_ms: int = 0
    levels_executed: int = 0
    circuit_breaker_triggered: bool = False
    cancellation_triggered: bool = False
    escalations_performed: int = 0
    agent_metrics: dict[str, AgentMetrics] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        if self.total_tasks == 0:
            return 1.0
        return self.tasks_succeeded / self.total_tasks


class DispatchMetricsCollector:
    """Collects and aggregates dispatch metrics across task executions.

    Thread-safe: all methods acquire a lock to protect counters.
    """

    def __init__(self):
        import threading
        self._lock = threading.Lock()
        self._metrics: dict[str, AgentMetrics] = {}
        self._errors: list[str] = []
        self._escalations: int = 0
        self._circuit_breaker: bool = False
        self._cancelled: bool = False
        self._start_time: float = time.perf_counter()

    def start(self) -> None:
        """Reset start time."""
        self._start_time = time.perf_counter()

    def record_task(self, role: str, success: bool, tokens: int = 0,
                    elapsed_ms: int = 0, retries: int = 0,
                    escalated: bool = False) -> None:
        """Record a single task execution result."""
        with self._lock:
            m = self._metrics.get(role)
            if m is None:
                m = AgentMetrics(role=role)
                self._metrics[role] = m
            m.tasks_total += 1
            if success:
                m.tasks_succeeded += 1
            else:
                m.tasks_failed += 1
            m.tokens_used += tokens
            m.total_elapsed_ms += elapsed_ms
            m.retries += retries
            if escalated:
                m.escalations += 1

    def record_error(self, error: str) -> None:
        """Record an error that occurred during dispatch."""
        with self._lock:
            self._errors.append(error)

    def record_escalation(self) -> None:
        with self._lock:
            self._escalations += 1

    def mark_circuit_breaker(self) -> None:
        with self._lock:
            self._circuit_breaker = True

    def mark_cancelled(self) -> None:
        with self._lock:
            self._cancelled = True

    def build_report(self, conversation_id: str = "",
                     total_tasks: int = 0) -> DispatchReport:
        """Build a final DispatchReport from collected metrics."""
        with self._lock:
            succeeded = sum(m.tasks_succeeded for m in self._metrics.values())
            failed = sum(m.tasks_failed for m in self._metrics.values())
            tokens = sum(m.tokens_used for m in self._metrics.values())
            elapsed = int((time.perf_counter() - self._start_time) * 1000)

            return DispatchReport(
                conversation_id=conversation_id,
                total_tasks=total_tasks,
                total_results=succeeded + failed,
                tasks_succeeded=succeeded,
                tasks_failed=failed,
                tokens_used=tokens,
                total_elapsed_ms=elapsed,
                circuit_breaker_triggered=self._circuit_breaker,
                cancellation_triggered=self._cancelled,
                escalations_performed=self._escalations,
                agent_metrics=dict(self._metrics),
                errors=list(self._errors),
            )


def format_dispatch_report(report: DispatchReport) -> str:
    """Format a DispatchReport as a human-readable string.

    Suitable for CLI output, log summarization, and observability dashboards.
    """
    bar_width = 30
    lines = [
        "=" * 60,
        "  Multi-Agent Dispatch Report",
        "=" * 60,
        f"  Conversation: {report.conversation_id[:20]}",
        f"  Success Rate:  {report.success_rate:.0%} ({report.tasks_succeeded}/{report.total_tasks})",
        f"  Tokens Used:   {report.tokens_used:,}",
        f"  Elapsed:       {report.total_elapsed_ms:,}ms",
        f"  Levels:        {report.levels_executed}",
    ]

    if report.circuit_breaker_triggered:
        lines.append("  CIRCUIT BREAKER: TRIGGERED")
    if report.cancellation_triggered:
        lines.append("  CANCELLATION:   TRIGGERED")
    if report.escalations_performed:
        lines.append(f"  Escalations:    {report.escalations_performed}")

    if report.agent_metrics:
        lines.append("")
        lines.append("  Per-Agent Metrics:")
        lines.append(f"  {'Role':<20} {'Success':>8} {'Total':>6} {'Tokens':>8} {'Rate':>7}")
        lines.append("  " + "-" * 55)
        for role, m in sorted(report.agent_metrics.items()):
            bar = "#" * int(m.success_rate * bar_width)
            lines.append(
                f"  {role:<20} {m.tasks_succeeded:>4}/{m.tasks_total:<4} "
                f"{m.tokens_used:>7,}  {bar:<{bar_width}} {m.success_rate:.0%}"
            )

    if report.errors:
        lines.append("")
        lines.append(f"  Errors ({len(report.errors)}):")
        for err in report.errors[-5:]:
            lines.append(f"    - {err[:80]}")

    lines.append("=" * 60)
    return "\n".join(lines)


# Module-level default
_default_collector: DispatchMetricsCollector | None = None


def get_collector() -> DispatchMetricsCollector:
    global _default_collector
    if _default_collector is None:
        _default_collector = DispatchMetricsCollector()
    return _default_collector
