"""Multi-agent collaboration data model — AgentRole, Task, TaskResult, Conversation.

Core data classes for the MasterAgent / SubAgent dispatch protocol, plus
SQLite persistence and JSON serialization for durability and inspection.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import threading
import time
from collections import deque
from typing import Any, Callable


# ====================================================================
# Data classes
# ====================================================================


@dataclass
class AgentRole:
    """Sub-agent role definition — used by MasterAgent to select workers.

    Each role declares a capability whitelist and tool whitelist so the
    security layer can enforce boundaries without inspecting every prompt.
    """

    name: str  # "CoderAgent", "ReviewerAgent", etc.
    description: str  # Human-readable, shown to MasterAgent for selection
    capabilities: list[str] = field(default_factory=list)  # Allowed capability names
    tools: list[str] = field(default_factory=list)  # Allowed tool names
    max_tokens: int = 4096
    timeout: int = 0  # seconds; 0 disables the Agent deadline
    system_prompt: str = ""  # Role-specific prompt prefix

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "capabilities": self.capabilities,
            "tools": self.tools,
            "max_tokens": self.max_tokens,
            "timeout": self.timeout,
            "system_prompt": self.system_prompt,
        }

    @classmethod
    def from_dict(cls, d: dict) -> AgentRole:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Task:
    """Unit of work dispatched by MasterAgent to a SubAgent.

    Supports dependency graphs (depends_on) for topological ordering,
    priority-based scheduling, and deadline-enforced timeouts.
    """

    task_id: str = ""  # Unique ID; auto-generated if empty
    parent_task_id: str = ""  # Parent task (supports nesting)
    role: str = ""  # Target SubAgent role name
    goal: str = ""  # Task goal (written by MasterAgent)
    inputs: dict = field(default_factory=dict)  # Input data
    constraints: list[str] = field(default_factory=list)  # E.g. "no file writes"
    depends_on: list[str] = field(default_factory=list)  # Dependency task IDs
    deadline_ms: int = 0  # 0 disables the task deadline
    priority: int = 100  # Lower = higher priority

    def __post_init__(self):
        if not self.task_id:
            self.task_id = f"task_{uuid.uuid4().hex[:12]}"

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "parent_task_id": self.parent_task_id,
            "role": self.role,
            "goal": self.goal,
            "inputs": self.inputs,
            "constraints": self.constraints,
            "depends_on": self.depends_on,
            "deadline_ms": self.deadline_ms,
            "priority": self.priority,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Task:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class TaskResult:
    """Result returned by a SubAgent after completing (or failing) a Task."""

    task_id: str
    role: str
    success: bool
    output: str = ""  # Primary answer
    artifacts: dict = field(default_factory=dict)  # File paths / data blobs
    evidence: list[dict] = field(default_factory=list)  # Evidence chain
    tool_calls: list[dict] = field(default_factory=list)  # Tool invocations
    elapsed_ms: int = 0
    tokens_used: int = 0
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "role": self.role,
            "success": self.success,
            "output": self.output,
            "artifacts": self.artifacts,
            "evidence": self.evidence,
            "tool_calls": self.tool_calls,
            "elapsed_ms": self.elapsed_ms,
            "tokens_used": self.tokens_used,
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, d: dict) -> TaskResult:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Conversation:
    """Multi-agent conversation context — shared state across MasterAgent ↔ SubAgents.

    Shared memory is read-visible to all SubAgents but writable only by
    MasterAgent.  Each SubAgent sees only its own Task.inputs plus the
    outputs of tasks it depends on (not raw internal prompts).
    """

    conversation_id: str = ""
    master_goal: str = ""  # Original user request
    tasks: list[Task] = field(default_factory=list)
    results: list[TaskResult] = field(default_factory=list)
    shared_memory: dict[str, Any] = field(default_factory=dict)  # Master-writable, all-readable
    created_at: str = ""
    updated_at: str = ""
    max_total_tokens: int = 50000
    _task_cancel_events: dict[str, threading.Event] = field(
        default_factory=dict, repr=False, compare=False
    )
    _progress_callback: Callable[[str, dict[str, Any]], None] | None = field(
        default=None, repr=False, compare=False
    )
    _deadline_monotonic: float | None = field(default=None, repr=False, compare=False)
    _lock: object = field(default_factory=threading.RLock, repr=False, compare=False)
    _cancelled: object = field(default_factory=threading.Event, repr=False, compare=False)
    _delegation_queue: object = field(default_factory=deque, repr=False, compare=False)  # dynamic tasks from subagents  # P2-7: 任务级总 token 预算（dispatcher 累计超限则熔断）

    def __post_init__(self):
        if not self.conversation_id:
            self.conversation_id = f"conv_{uuid.uuid4().hex[:16]}"
        now = datetime.now(timezone.utc).isoformat()
        if not self.created_at:
            self.created_at = now
        if not self.updated_at:
            self.updated_at = now

    # ------------------------------------------------------------------
    # Thread-safe shared_memory accessors
    # ------------------------------------------------------------------

    def get_shared(self, key: str, default: Any = None) -> Any:
        "Thread-safe shared_memory read."
        with self._lock:
            return self.shared_memory.get(key, default)

    def set_shared(self, key: str, value: Any) -> None:
        "Thread-safe shared_memory write."
        with self._lock:
            self.shared_memory[key] = value

    def update_shared(self, updates: dict[str, Any]) -> None:
        "Thread-safe batch shared_memory update."
        with self._lock:
            self.shared_memory.update(updates)

    def append_result(self, result):
        "Thread-safe result append."
        with self._lock:
            self.results.append(result)

    def get_results_snapshot(self):
        "Thread-safe snapshot of current results."
        with self._lock:
            return list(self.results)

    def enqueue_delegated_task(self, task) -> None:
        "Thread-safe: push a delegated task onto the queue."
        with self._lock:
            self._delegation_queue.append(task)

    def drain_delegated_tasks(self) -> list:
        "Thread-safe: drain all pending delegated tasks."
        with self._lock:
            tasks = list(self._delegation_queue)
            self._delegation_queue.clear()
            return tasks

    def set_progress_callback(
        self, callback: Callable[[str, dict[str, Any]], None] | None
    ) -> None:
        """Attach a process-local progress observer.

        The callback is deliberately excluded from persistence so restored
        conversations never contain non-serializable runtime state.
        """
        with self._lock:
            self._progress_callback = callback

    def emit_progress(self, event: str, **data: Any) -> None:
        """Emit one best-effort, thread-safe progress event."""
        with self._lock:
            callback = self._progress_callback
        if callback is None:
            return
        payload = {
            "conversation_id": self.conversation_id,
            "timestamp": time.time(),
            **data,
        }
        try:
            callback(event, payload)
        except Exception:
            # Rendering and telemetry failures must never break project work.
            pass

    def set_deadline(self, timeout_seconds: float | None) -> None:
        """Set or clear the total runtime deadline for this conversation."""
        with self._lock:
            self._deadline_monotonic = (
                None
                if timeout_seconds is None or timeout_seconds <= 0
                else time.monotonic() + float(timeout_seconds)
            )

    @property
    def deadline_remaining(self) -> float | None:
        with self._lock:
            deadline = self._deadline_monotonic
        if deadline is None:
            return None
        return max(0.0, deadline - time.monotonic())

    @property
    def expired(self) -> bool:
        remaining = self.deadline_remaining
        return remaining is not None and remaining <= 0

    def reset_task_cancellation(self, task_id: str) -> threading.Event:
        """Create a fresh cancellation token immediately before task start."""
        with self._lock:
            event = threading.Event()
            if self.cancelled:
                event.set()
            self._task_cancel_events[task_id] = event
            return event

    def task_cancel_event(self, task_id: str) -> threading.Event:
        """Return the stable cooperative cancellation token for a task."""
        with self._lock:
            event = self._task_cancel_events.get(task_id)
            if event is None:
                event = threading.Event()
                if self.cancelled:
                    event.set()
                self._task_cancel_events[task_id] = event
            return event

    def cancel_task(self, task_id: str, reason: str = "") -> None:
        """Request cooperative cancellation of one in-flight task."""
        self.task_cancel_event(task_id).set()
        if reason:
            self.set_shared(f"_cancel_reason_{task_id}", reason)
        self.emit_progress("task_cancel_requested", task_id=task_id, reason=reason)

    def task_cancelled(self, task_id: str) -> bool:
        return self.cancelled or self.expired or self.task_cancel_event(task_id).is_set()

    @property
    def cancelled(self) -> bool:
        "Check if this conversation has been cancelled."
        return self._cancelled.is_set()

    def cancel(self, reason: str = "") -> None:
        "Cancel all in-flight tasks for this conversation. Thread-safe."
        if not self._cancelled.is_set():
            self._cancelled.set()
            with self._lock:
                task_events = list(self._task_cancel_events.values())
            for event in task_events:
                event.set()
            if reason:
                self.set_shared("_cancel_reason", reason)
            self.emit_progress("conversation_cancelled", reason=reason)

    def to_dict(self) -> dict:
        return {
            "conversation_id": self.conversation_id,
            "master_goal": self.master_goal,
            "tasks": [t.to_dict() for t in self.tasks],
            "results": [r.to_dict() for r in self.results],
            "shared_memory": self.shared_memory,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Conversation:
        tasks = [Task.from_dict(t) for t in d.get("tasks", [])]
        results = [TaskResult.from_dict(r) for r in d.get("results", [])]
        return cls(
            conversation_id=d.get("conversation_id", ""),
            master_goal=d.get("master_goal", ""),
            tasks=tasks,
            results=results,
            shared_memory=d.get("shared_memory", {}),
            created_at=d.get("created_at", ""),
            updated_at=d.get("updated_at", ""),
        )

    def result_for(self, task_id: str) -> TaskResult | None:
        """Find the result for a given task_id."""
        for r in self.results:
            if r.task_id == task_id:
                return r
        return None

    def pending_tasks(self) -> list[Task]:
        """Tasks whose dependencies are satisfied but not yet executed."""
        completed = {r.task_id for r in self.results}
        pending = []
        for t in self.tasks:
            if t.task_id in completed:
                continue
            if all(dep in completed for dep in t.depends_on):
                pending.append(t)
        return pending

    def dependency_graph(self) -> dict[str, list[str]]:
        """Return {task_id: [dependent_task_ids]} adjacency."""
        g: dict[str, list[str]] = {}
        for t in self.tasks:
            g.setdefault(t.task_id, [])
            for dep in t.depends_on:
                g.setdefault(dep, []).append(t.task_id)
        return g


# ====================================================================
# Structured output helpers (C2 — protocol refinement)
# ====================================================================


# Standard output schemas for inter-agent communication.
# Each role's TaskResult.output should conform to one of these so
# downstream agents can parse them reliably.


def format_search_result(files: list[str], summary: str, confidence: float = 1.0) -> str:
    """Standard output format for SearcherAgent results."""
    parts = ["## 检索结果", ""]
    if files:
        parts.append("### 相关文件")
        for f in files[:10]:
            parts.append(f"- {f}")
        parts.append("")
    parts.append(f"### 摘要\n{summary}")
    if confidence < 1.0:
        parts.append(f"\n_置信度: {confidence:.0%}_")
    return "\n".join(parts)


def format_code_result(description: str, code: str, language: str = "python") -> str:
    """Standard output format for CoderAgent results."""
    return (
        f"## 代码实现\n\n{description}\n\n"
        f"```{language}\n{code}\n```\n"
    )


def format_review_result(issues: list[dict], verdict: str) -> str:
    """Standard output format for ReviewerAgent results.

    Args:
        issues: List of {severity, file, line, description} dicts
        verdict: "approved" / "changes_requested" / "blocked"
    """
    verdict_icon = {"approved": "✅", "changes_requested": "⚠️", "blocked": "🔴"}
    icon = verdict_icon.get(verdict, "❓")

    parts = [f"## 审查结果 {icon} {verdict}", ""]
    by_severity: dict[str, list] = {"critical": [], "high": [], "medium": [], "low": []}
    for issue in issues:
        sev = issue.get("severity", "low")
        by_severity.setdefault(sev, []).append(issue)

    for sev, label in [("critical", "严重"), ("high", "高"), ("medium", "中"), ("low", "低")]:
        items = by_severity.get(sev, [])
        if items:
            parts.append(f"### {label} ({len(items)})")
            for item in items:
                loc = f"{item.get('file', '')}:{item.get('line', '')}" if item.get("file") else ""
                parts.append(f"- {loc} {item.get('description', '')}")
            parts.append("")
    return "\n".join(parts)


def format_test_result(passed: int, failed: int, output: str) -> str:
    """Standard output format for TesterAgent results."""
    status = "✅ 全部通过" if failed == 0 else f"❌ {failed} 失败"
    return (
        f"## 测试结果 {status}\n\n"
        f"- 通过: {passed}\n"
        f"- 失败: {failed}\n"
        f"- 总计: {passed + failed}\n\n"
        f"```\n{output[:2000]}\n```\n"
    )


def validate_task_result(result) -> dict:
    """Validate a TaskResult's output against the expected role format.

    Returns {"valid": bool, "role": str, "issues": [str, ...]}.
    """
    issues = []
    role = result.role
    output = result.output if result.success else ""

    if not result.success:
        return {"valid": True, "role": role, "issues": [], "note": "failed task — no output validation"}

    if not output.strip():
        issues.append("output is empty")

    if role == "SearcherAgent" and "## 检索结果" not in output:
        issues.append("SearcherAgent output missing '## 检索结果' header")
    if role == "CoderAgent" and "```" not in output:
        issues.append("CoderAgent output missing code block")
    if role == "ReviewerAgent" and "## 审查结果" not in output:
        issues.append("ReviewerAgent output missing '## 审查结果' header")
    if role == "TesterAgent" and "测试结果" not in output:
        issues.append("TesterAgent output missing test result summary")

    return {"valid": len(issues) == 0, "role": role, "issues": issues}


# ====================================================================
# Persistence helpers — SQLAlchemy backend
# ====================================================================


def _get_db_path() -> Path:
    """兼容旧接口 — 返回多智能体数据库路径."""
    base = os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge"))
    return Path(base) / "multiagent.db"


def _ensure_db():
    """占位 — 表由 init_ma_db() 自动创建."""
    from arforge.database import init_ma_db
    init_ma_db()
    return None


def save_conversation(conv: Conversation) -> None:
    """Persist a Conversation (and its tasks/results) to database + JSON fallback."""
    from arforge.database import MultiagentConversation, MultiagentTask, get_ma_session, init_ma_db

    init_ma_db()
    now = datetime.now(timezone.utc).isoformat()
    conv.updated_at = now

    with get_ma_session() as session:
        # Upsert conversation
        mc = session.get(MultiagentConversation, conv.conversation_id)
        if mc is None:
            mc = MultiagentConversation(
                conversation_id=conv.conversation_id,
                master_goal=conv.master_goal,
                shared_memory=json.dumps(conv.shared_memory, ensure_ascii=False),
                created_at=conv.created_at or now,
                updated_at=now,
            )
            session.add(mc)
        else:
            mc.master_goal = conv.master_goal
            mc.shared_memory = json.dumps(conv.shared_memory, ensure_ascii=False)
            mc.updated_at = now

        # Upsert tasks
        for t in conv.tasks:
            result = conv.result_for(t.task_id)
            mt = session.get(MultiagentTask, t.task_id)
            if mt is None:
                mt = MultiagentTask(
                    task_id=t.task_id,
                    conversation_id=conv.conversation_id,
                    parent_task_id=t.parent_task_id,
                    role=t.role,
                    goal=t.goal,
                    inputs=json.dumps(t.inputs, ensure_ascii=False),
                    constraints=json.dumps(t.constraints, ensure_ascii=False),
                    depends_on=json.dumps(t.depends_on, ensure_ascii=False),
                    deadline_ms=t.deadline_ms,
                    priority=t.priority,
                    success=1 if (result and result.success) else 0,
                    output=result.output if result else "",
                    artifacts=json.dumps(result.artifacts if result else {}, ensure_ascii=False),
                    evidence=json.dumps(result.evidence if result else [], ensure_ascii=False),
                    tool_calls=json.dumps(result.tool_calls if result else [], ensure_ascii=False),
                    elapsed_ms=result.elapsed_ms if result else 0,
                    tokens_used=result.tokens_used if result else 0,
                    error=result.error if result else "",
                    created_at=now,
                    updated_at=now,
                )
                session.add(mt)
            else:
                mt.role = t.role
                mt.goal = t.goal
                mt.inputs = json.dumps(t.inputs, ensure_ascii=False)
                mt.constraints = json.dumps(t.constraints, ensure_ascii=False)
                mt.depends_on = json.dumps(t.depends_on, ensure_ascii=False)
                mt.deadline_ms = t.deadline_ms
                mt.priority = t.priority
                # 始终设置 result 字段（默认空值），与旧版 UPSERT 行为一致
                mt.success = 1 if (result and result.success) else 0
                mt.output = result.output if result else ""
                mt.artifacts = json.dumps(result.artifacts if result else {}, ensure_ascii=False)
                mt.evidence = json.dumps(result.evidence if result else [], ensure_ascii=False)
                mt.tool_calls = json.dumps(result.tool_calls if result else [], ensure_ascii=False)
                mt.elapsed_ms = result.elapsed_ms if result else 0
                mt.tokens_used = result.tokens_used if result else 0
                mt.error = result.error if result else ""
                mt.updated_at = now

    # Also write JSON backup
    _write_json_backup(conv)


def load_conversation(conversation_id: str) -> Conversation | None:
    """Load a Conversation from database (falls back to JSON)."""
    from arforge.database import MultiagentConversation, MultiagentTask, get_ma_session, init_ma_db

    init_ma_db()

    with get_ma_session() as session:
        mc = session.get(MultiagentConversation, conversation_id)
        if mc is None:
            return _load_json_backup(conversation_id)

        conv = Conversation(
            conversation_id=mc.conversation_id,
            master_goal=mc.master_goal,
            shared_memory=json.loads(mc.shared_memory) if mc.shared_memory else {},
            created_at=mc.created_at,
            updated_at=mc.updated_at,
        )

        tasks = (
            session.query(MultiagentTask)
            .filter(MultiagentTask.conversation_id == conversation_id)
            .all()
        )

        for mt in tasks:
            task = Task(
                task_id=mt.task_id,
                parent_task_id=mt.parent_task_id,
                role=mt.role,
                goal=mt.goal,
                inputs=json.loads(mt.inputs) if mt.inputs else {},
                constraints=json.loads(mt.constraints) if mt.constraints else [],
                depends_on=json.loads(mt.depends_on) if mt.depends_on else [],
                deadline_ms=mt.deadline_ms,
                priority=mt.priority,
            )
            conv.tasks.append(task)
            if mt.elapsed_ms > 0 or mt.output or mt.error:
                conv.results.append(
                    TaskResult(
                        task_id=mt.task_id,
                        role=mt.role,
                        success=bool(mt.success),
                        output=mt.output,
                        artifacts=json.loads(mt.artifacts) if mt.artifacts else {},
                        evidence=json.loads(mt.evidence) if mt.evidence else [],
                        tool_calls=json.loads(mt.tool_calls) if mt.tool_calls else [],
                        elapsed_ms=mt.elapsed_ms,
                        tokens_used=mt.tokens_used,
                        error=mt.error,
                    )
                )

        return conv


def list_conversations(limit: int = 20) -> list[dict]:
    """List recent conversation summaries."""
    from arforge.database import MultiagentConversation, get_ma_session, init_ma_db

    init_ma_db()

    with get_ma_session() as session:
        rows = (
            session.query(MultiagentConversation)
            .order_by(MultiagentConversation.updated_at.desc())
            .limit(limit)
            .all()
        )
    return [
        {
            "conversation_id": r.conversation_id,
            "master_goal": r.master_goal,
            "created_at": r.created_at,
            "updated_at": r.updated_at,
        }
        for r in rows
    ]


def _json_dir() -> Path:
    base = os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge"))
    return Path(base) / "conversations"


def _write_json_backup(conv: Conversation) -> None:
    d = _json_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{conv.conversation_id}.json"
    path.write_text(json.dumps(conv.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")


def _load_json_backup(conversation_id: str) -> Conversation | None:
    path = _json_dir() / f"{conversation_id}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return Conversation.from_dict(data)
    except (json.JSONDecodeError, KeyError):
        return None
