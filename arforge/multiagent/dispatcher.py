"""TaskDispatcher — topological ordering and parallel/serial execution of Tasks.

The dispatcher takes a list of Tasks from the MasterAgent, topologically sorts
them by dependency order, executes independent tasks in parallel (up to
max_parallel), and retries failed tasks with configurable backoff.
"""

from __future__ import annotations

import concurrent.futures
import contextvars
import inspect
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable
from typing import TYPE_CHECKING

from arforge.multiagent.protocol import Task, TaskResult
from arforge.multiagent.router import DynamicTaskRouter, RouterConfig
from arforge.multiagent.metrics import DispatchMetricsCollector

if TYPE_CHECKING:
    from arforge.multiagent.sub_agent_pool import SubAgentPool

logger = logging.getLogger(__name__)



@dataclass
class DispatchConfig:
    """Tunable dispatch parameters."""
    max_parallel: int = 4
    max_retries: int = 2
    cooldown_ms: int = 250
    resource_aware: bool = True
    dynamic_dispatch: bool = True
    work_stealing: bool = True
    timeout_grace_ms: int = 250
    progress_callback: Callable[[str, dict], None] | None = None


class TaskDispatcher:
    """Executes tasks respecting dependency order and parallelism limits.

    Topological sort groups tasks into levels; tasks within a level have all
    their dependencies satisfied and may execute in parallel.
    """

    def __init__(
        self,
        max_parallel: int = 4,
        max_retries: int = 2,
        config: DispatchConfig | None = None,
        master=None,
    ):
        self.max_parallel = max_parallel
        self.max_retries = max_retries
        self.config = config or DispatchConfig(max_parallel=max_parallel, max_retries=max_retries)
        self.master = master
        self._pool: SubAgentPool | None = None
        self._router: DynamicTaskRouter | None = None
        self._no_escalate: set[str] = set()
        self._metrics: DispatchMetricsCollector | None = None  # task_ids that must not be escalated
        self._results_lock = __import__('threading').Lock()
        # D3: Per-role concurrency control (lazily populated via _acquire_role_slot)
        self._role_semaphores: dict[str, threading.Semaphore] = {}
        self._role_sem_lock = threading.Lock()
        self._max_per_role: int = 2  # max concurrent tasks per role

    @property
    def pool(self):
        if self._pool is None:
            from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

            self._pool = get_sub_agent_pool()
        return self._pool

    @property
    def router(self):
        if self._router is None:
            self._router = DynamicTaskRouter(RouterConfig(
                enable_debugger_escalation=True,
                enable_role_swap=True,
            ))
        return self._router

    @property
    def metrics(self):
        if self._metrics is None:
            self._metrics = DispatchMetricsCollector()
        return self._metrics

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------

    def dispatch(self, tasks: list[Task], conversation) -> list[TaskResult]:
        """Execute all tasks respecting topological order.

        Tasks are split into levels.  Tasks in the same level have no
        inter-dependencies and can run in parallel.

        Supports dynamic task injection via delegation queue (D1).
        """
        if not tasks:
            return []

        levels = self._topological_levels(tasks)
        all_results: list[TaskResult] = []
        self.metrics.start()

        consecutive_failures = 0
        circuit_breaker_threshold = max(3, len(levels) * 2)
        level_idx = 0

        while level_idx < len(levels):
            level = levels[level_idx]

            # Cancellation check
            if getattr(conversation, "expired", False) and hasattr(conversation, "cancel"):
                conversation.cancel("multi-agent runtime deadline exceeded")
            if getattr(conversation, 'cancelled', False):
                self.metrics.mark_cancelled()
                for lv in levels[level_idx:]:
                    for t in lv:
                        all_results.append(TaskResult(
                            task_id=t.task_id, role=t.role, success=False,
                            error="aborted: conversation cancelled",
                        ))
                break

            # Execute current level (serial or parallel)
            if len(level) <= 1:
                for task in level:
                    result = self._execute_one(task, conversation)
                    all_results.append(result)
                    conversation.append_result(result)
            else:
                results = self._parallel_execute(level, conversation)
                all_results.extend(results)
                for r in results:
                    conversation.append_result(r)

            # D1: Drain delegation queue — subagents may have spawned new tasks
            if hasattr(conversation, "drain_delegated_tasks"):
                delegated = conversation.drain_delegated_tasks()
                if delegated:
                    remaining_flat = []
                    for li in range(level_idx + 1, len(levels)):
                        remaining_flat.extend(levels[li])
                    remaining_flat.extend(delegated)
                    if remaining_flat:
                        new_remaining = self._topological_levels(remaining_flat)
                        levels = levels[:level_idx + 1] + new_remaining

            # Circuit breaker: track consecutive failures
            level_results = all_results[-len(level):]
            level_failures = sum(1 for r in level_results if not r.success)
            if level_failures == 0:
                consecutive_failures = 0
            else:
                consecutive_failures += level_failures

            # Catastrophic failure abort
            if all(not r.success for r in level_results):
                for lv in levels[level_idx + 1:]:
                    for t in lv:
                        all_results.append(TaskResult(
                            task_id=t.task_id, role=t.role, success=False,
                            error="aborted: previous level all failed",
                        ))
                break

            # Circuit breaker: too many consecutive failures
            if consecutive_failures >= circuit_breaker_threshold:
                for lv in levels[level_idx + 1:]:
                    for t in lv:
                        all_results.append(TaskResult(
                            task_id=t.task_id, role=t.role, success=False,
                            error=f"aborted: circuit breaker ({consecutive_failures} consecutive failures)",
                        ))
                if hasattr(conversation, 'cancel'):
                    conversation.cancel("circuit breaker threshold reached")
                self.metrics.mark_circuit_breaker()
                break

            level_idx += 1

            # Token budget gate
            max_total = getattr(conversation, "max_total_tokens", 0)
            used = sum(r.tokens_used for r in all_results)
            if max_total and used > max_total:
                from arforge.multiagent import security
                security.audit_log(
                    "dispatcher", "total_budget_exceeded",
                    f"used={used} max={max_total}", allowed=False,
                )
                for lv in levels[level_idx:]:
                    for t in lv:
                        all_results.append(TaskResult(
                            task_id=t.task_id, role=t.role, success=False,
                            error="aborted: total budget exceeded",
                        ))
                break

        return all_results

    def _execute_one(self, task: Task, conversation) -> TaskResult:
        """Execute a single task with retry logic."""
        self._report_progress(
            "task_start", {"task_id": task.task_id, "role": task.role}, conversation
        )
        agent = None
        borrow = getattr(self.pool, "borrow_agent", None)
        if borrow:
            agent = self._create_pool_agent(borrow, task.role)
        if agent is None:
            agent = self._create_pool_agent(self.pool.create_agent, task.role)
        if agent is None:
            result = TaskResult(
                task_id=task.task_id,
                role=task.role,
                success=False,
                error=f"unknown role: {task.role}",
            )
            self._report_progress(
                "task_end",
                {"task_id": task.task_id, "role": task.role, "success": False,
                 "error": result.error},
                conversation,
            )
            return result

        # D3: acquire per-role concurrency slot
        if not self._acquire_role_slot(task.role, conversation):
            result = TaskResult(
                task_id=task.task_id,
                role=task.role,
                success=False,
                error=f"role concurrency slot unavailable: {task.role}",
            )
            self._report_progress(
                "task_end",
                {"task_id": task.task_id, "role": task.role, "success": False,
                 "error": result.error},
                conversation,
            )
            return result

        slot_held = True

        def release_slot() -> None:
            nonlocal slot_held
            if slot_held:
                self._release_role_slot(task.role)
                slot_held = False

        reset_cancel = getattr(conversation, "reset_task_cancellation", None)
        if callable(reset_cancel):
            reset_cancel(task.task_id)

        started = time.monotonic()
        deadline = (
            started + task.deadline_ms / 1000.0
            if task.deadline_ms > 0
            else None
        )

        last_result: TaskResult | None = None
        task_timed_out = False
        task_cancelled = False
        for attempt in range(self.max_retries + 1):
            try:
                if getattr(conversation, "cancelled", False):
                    raise InterruptedError("conversation cancelled")
                is_task_cancelled = getattr(conversation, "task_cancelled", None)
                if callable(is_task_cancelled) and is_task_cancelled(task.task_id):
                    raise InterruptedError("task cancelled")
                task_remaining = (
                    max(0.0, deadline - time.monotonic())
                    if deadline is not None
                    else None
                )
                total_remaining = getattr(conversation, "deadline_remaining", None)
                limits = [
                    value
                    for value in (task_remaining, total_remaining)
                    if value is not None
                ]
                if limits and min(limits) <= 0:
                    raise TimeoutError(f"Task {task.task_id} timed out")
                remaining_ms = int(min(limits) * 1000) if limits else 0
                result = self._run_with_timeout(
                    agent, task, conversation, remaining_ms,
                    grace_ms=self.config.timeout_grace_ms,
                )
                if result.success:
                    ret = getattr(self.pool, "return_agent", None)
                    if ret:
                        ret(task.role, agent)
                    self._report_progress(
                        "task_end",
                        {"task_id": task.task_id, "role": task.role, "success": True,
                         "tokens": result.tokens_used, "elapsed_ms": result.elapsed_ms},
                        conversation,
                    )
                    self.metrics.record_task(task.role, success=True, tokens=result.tokens_used, elapsed_ms=result.elapsed_ms)
                    release_slot()
                    return result
                last_result = result
            except TimeoutError:
                task_timed_out = True
                last_result = TaskResult(
                    task_id=task.task_id,
                    role=task.role,
                    success=False,
                    error=f"timeout after {task.deadline_ms}ms",
                    elapsed_ms=int((time.monotonic() - started) * 1000),
                )
            except InterruptedError as exc:
                task_cancelled = True
                last_result = TaskResult(
                    task_id=task.task_id,
                    role=task.role,
                    success=False,
                    error=f"cancelled: {exc}",
                    elapsed_ms=int((time.monotonic() - started) * 1000),
                )
            except Exception as exc:
                last_result = TaskResult(
                    task_id=task.task_id,
                    role=task.role,
                    success=False,
                    error=f"{type(exc).__name__}: {exc}",
                )

            # Repeating the same timed-out or cancelled operation only turns a
            # bounded failure into a multi-minute hang. Other transient failures
            # may still use the configured retry budget within the same deadline.
            if task_timed_out or task_cancelled:
                break
            if attempt < self.max_retries and (
                deadline is None or time.monotonic() < deadline
            ):
                backoff = 0.1 * (2**attempt)  # 0.1, 0.2, 0.4
                time.sleep(
                    backoff
                    if deadline is None
                    else min(backoff, max(0.0, deadline - time.monotonic()))
                )

        ret2 = getattr(self.pool, "return_agent", None)
        # A timed-out worker may still be unwinding cooperatively. Never put its
        # mutable agent instance back into the shared pool.
        if ret2 and not task_timed_out and not task_cancelled:
            ret2(task.role, agent)

        release_slot()

        # Dynamic escalation: route failed task to DebuggerAgent
        failed_result = last_result or TaskResult(
            task_id=task.task_id, role=task.role,
            success=False, error="exhausted retries",
        )
        if (not task_timed_out
                and not task_cancelled
                and not getattr(conversation, "cancelled", False)
                and task.task_id not in self._no_escalate
                and self.router.should_escalate(task, conversation)):
            recovery_task = self.router.escalate(failed_result, task, conversation)
            if recovery_task:
                # Verify the pool can actually create an agent for the recovery role
                try:
                    recovery_agent = self._create_pool_agent(
                        self.pool.create_agent, recovery_task.role
                    )
                except Exception:
                    recovery_agent = None
                # Skip escalation if pool has no specialized recovery agent (generic SubAgent fallback)
                if recovery_agent is not None and type(recovery_agent).__name__ != 'SubAgent':
                    # Prevent recovery task from being escalated itself
                    self._no_escalate.add(recovery_task.task_id)
                    self.router.mark_escalated(task.task_id, depth=99)
                    recovery_result = self._execute_one(recovery_task, conversation)
                    if recovery_result.success:
                        recovered = TaskResult(
                            task_id=task.task_id,
                            role=task.role,
                            success=True,
                            output=recovery_result.output,
                            artifacts=recovery_result.artifacts,
                            evidence=[
                                *recovery_result.evidence,
                                {
                                    "type": "escalation",
                                    "recovery_task_id": recovery_task.task_id,
                                    "recovery_role": recovery_task.role,
                                },
                            ],
                            tool_calls=recovery_result.tool_calls,
                            elapsed_ms=recovery_result.elapsed_ms,
                            tokens_used=recovery_result.tokens_used,
                        )
                        self._report_progress(
                            "task_end",
                            {"task_id": task.task_id, "role": task.role,
                             "success": True, "escalated": True,
                             "tokens": recovery_result.tokens_used},
                            conversation,
                        )
                        self.metrics.record_task(task.role, success=True, tokens=recovery_result.tokens_used, elapsed_ms=recovery_result.elapsed_ms, escalated=True)
                        self.metrics.record_escalation()
                        return recovered

        self._report_progress(
            "task_end",
            {"task_id": task.task_id, "role": task.role, "success": False,
             "error": getattr(failed_result, "error", "exhausted retries"),
             "elapsed_ms": getattr(failed_result, "elapsed_ms", 0)},
            conversation,
        )
        self.metrics.record_task(task.role, success=False, tokens=getattr(failed_result, "tokens_used", 0), elapsed_ms=getattr(failed_result, "elapsed_ms", 0))
        self.metrics.record_error(getattr(failed_result, "error", "unknown"))
        return failed_result

    def _create_pool_agent(self, factory, role: str):
        """Create/borrow an agent while preserving legacy one-argument pools."""
        try:
            parameters = inspect.signature(factory).parameters.values()
            accepts_master = any(
                item.name == "master" or item.kind is inspect.Parameter.VAR_KEYWORD
                for item in parameters
            )
        except (TypeError, ValueError):
            accepts_master = False
        if accepts_master:
            return factory(role, master=self.master)
        return factory(role)

    @staticmethod
    def _run_with_timeout(
        agent, task, conversation, deadline_ms: int, *, grace_ms: int = 250
    ) -> TaskResult:
        """Run a task in a daemon worker with real, non-blocking timeout.

        ``ThreadPoolExecutor`` waits for workers during context-manager exit,
        which silently defeated the previous timeout. A daemon worker plus a
        cooperative task token lets the dispatcher return on time while model
        streams and tool loops unwind safely.
        """
        completed = threading.Event()
        result: list[TaskResult] = []
        failure: list[BaseException] = []
        # Thread-local workspace/session and permission state is part of the
        # request contract.  The daemon worker is an explicit thread boundary,
        # so carry that context rather than falling back to the process default.
        worker_context = contextvars.copy_context()

        def invoke() -> None:
            try:
                result.append(agent.execute(task, conversation))
            except BaseException as exc:  # re-raised on the dispatcher thread
                failure.append(exc)
            finally:
                completed.set()

        threading.Thread(
            target=worker_context.run,
            args=(invoke,),
            name=f"arforge-task-{task.task_id}",
            daemon=True,
        ).start()

        deadline = (
            time.monotonic() + deadline_ms / 1000.0
            if deadline_ms > 0
            else None
        )
        while True:
            remaining = (
                deadline - time.monotonic()
                if deadline is not None
                else None
            )
            if remaining is not None and remaining <= 0:
                cancel_task = getattr(conversation, "cancel_task", None)
                if callable(cancel_task):
                    cancel_task(task.task_id, f"deadline exceeded ({deadline_ms}ms)")
                completed.wait(max(0, grace_ms) / 1000.0)
                raise TimeoutError(f"Task {task.task_id} timed out")
            if completed.wait(0.1 if remaining is None else min(0.1, remaining)):
                break
            task_cancelled = getattr(conversation, "task_cancelled", None)
            if callable(task_cancelled) and task_cancelled(task.task_id):
                completed.wait(max(0, grace_ms) / 1000.0)
                raise InterruptedError("task cancelled")
            if getattr(conversation, "cancelled", False):
                cancel_task = getattr(conversation, "cancel_task", None)
                if callable(cancel_task):
                    cancel_task(task.task_id, "conversation cancelled")
                completed.wait(max(0, grace_ms) / 1000.0)
                raise InterruptedError("conversation cancelled")

        if failure:
            raise failure[0]
        if not result:
            raise RuntimeError(f"Task {task.task_id} returned no result")
        return result[0]

    # ------------------------------------------------------------------
    # Parallel execution
    # ------------------------------------------------------------------

    def _acquire_role_slot(self, role: str, conversation=None) -> bool:
        "Acquire a concurrency slot until it is available or work is cancelled."
        with self._role_sem_lock:
            sem = self._role_semaphores.get(role)
            if sem is None:
                sem = threading.Semaphore(self._max_per_role)
                self._role_semaphores[role] = sem
        while not sem.acquire(timeout=0.1):
            if conversation is not None and (
                getattr(conversation, "cancelled", False)
                or getattr(conversation, "expired", False)
            ):
                return False
        return True

    def _release_role_slot(self, role: str) -> None:
        "Release a concurrency slot for role."
        with self._role_sem_lock:
            sem = self._role_semaphores.get(role)
        if sem:
            sem.release()

    def _parallel_execute(self, tasks: list[Task], conversation) -> list[TaskResult]:
        """Execute multiple independent tasks in parallel."""
        # Early cancellation check
        if getattr(conversation, 'cancelled', False):
            return [TaskResult(
                task_id=t.task_id, role=t.role,
                success=False, error="aborted: conversation cancelled",
            ) for t in tasks]

        results = []
        executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=self._compute_max_workers(tasks)
        )
        futures = {}
        for task in tasks:
            # ThreadPoolExecutor does not automatically inherit ContextVars.
            # Capture an independent copy per task so parallel agents retain
            # their caller's workspace and permission/session boundary.
            task_context = contextvars.copy_context()
            futures[
                executor.submit(task_context.run, self._execute_one, task, conversation)
            ] = task
        interrupted = False
        try:
            for future in concurrent.futures.as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as exc:
                    task = futures[future]
                    results.append(
                        TaskResult(
                            task_id=task.task_id,
                            role=task.role,
                            success=False,
                            error=f"dispatch error: {exc}",
                        )
                    )
        except BaseException:
            interrupted = True
            cancel = getattr(conversation, "cancel", None)
            if callable(cancel):
                cancel("parallel dispatch interrupted")
            for future in futures:
                future.cancel()
            raise
        finally:
            # On interruption/cancellation, do not reintroduce the historical
            # context-manager wait. In-flight tasks own cooperative deadlines.
            executor.shutdown(
                wait=not interrupted and not getattr(conversation, "cancelled", False),
                cancel_futures=True,
            )
        return results

    # ------------------------------------------------------------------
    # Topological sort
    # ------------------------------------------------------------------

    def _report_progress(self, event, data, conversation=None):
        cb = self.config.progress_callback
        if cb:
            try:
                cb(event, data)
            except Exception:
                pass
        emit = getattr(conversation, "emit_progress", None)
        if callable(emit):
            emit(event, **data)

    def _compute_max_workers(self, tasks):
        mp = self.config.max_parallel
        if not self.config.resource_aware:
            return min(mp, len(tasks))
        dr = len({t.role for t in tasks})
        return min(mp, len(tasks), dr * 2)

    @staticmethod
    def _topological_levels(tasks: list[Task]) -> list[list[Task]]:
        """Group tasks into levels by dependency depth.

        Level 0: tasks with no dependencies.
        Level N: tasks whose dependencies are all in levels < N.
        """
        task_map = {t.task_id: t for t in tasks}
        in_degree: dict[str, int] = {}
        dependents: dict[str, list[str]] = {}

        for t in tasks:
            in_degree[t.task_id] = len([d for d in t.depends_on if d in task_map])
            for dep in t.depends_on:
                if dep in task_map:
                    dependents.setdefault(dep, []).append(t.task_id)

        # Kahn's algorithm
        queue = deque([tid for tid, deg in in_degree.items() if deg == 0])
        levels: list[list[Task]] = []
        processed: set[str] = set()

        while queue:
            level: list[Task] = []
            for _ in range(len(queue)):
                tid = queue.popleft()
                if tid in processed:
                    continue
                processed.add(tid)
                level.append(task_map[tid])

                for dep_tid in dependents.get(tid, []):
                    in_degree[dep_tid] -= 1
                    if in_degree[dep_tid] == 0:
                        queue.append(dep_tid)

            if level:
                levels.append(level)

        # Add any tasks not reachable (circular dependency — break cycle)
        remaining = [t for t in tasks if t.task_id not in processed]
        if remaining:
            levels.append(remaining)

        return levels


# ====================================================================
# Module-level convenience
# ====================================================================

_default_dispatcher: TaskDispatcher | None = None


def get_dispatcher() -> TaskDispatcher:
    global _default_dispatcher
    if _default_dispatcher is None:
        _default_dispatcher = TaskDispatcher(max_parallel=4)
    return _default_dispatcher
