"""Runtime interrupt support for agentic runs.

The hook keeps interruption outside the core loop:
- a stop request blocks the next LLM call so the run can end gracefully;
- queued instructions are injected as user messages before the next LLM call;
- an optional append-only control file lets another terminal or UI drive both.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Callable, Iterator

from arforge.core.hooks import HookDecision, HookEvent, get_hook_manager


class InterruptState:
    """Thread-safe run-scoped interrupt state."""

    def __init__(
        self,
        on_drain: Callable[[list[str]], None] | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._stop = False
        self._instructions: list[str] = []
        self._on_drain = on_drain

    def request_stop(self) -> None:
        with self._lock:
            self._stop = True

    def should_stop(self) -> bool:
        with self._lock:
            return self._stop

    def add_instruction(self, text: str) -> None:
        if not text or not text.strip():
            return
        with self._lock:
            self._instructions.append(text.strip())

    def drain_instructions(self, *, notify: bool = True) -> list[str]:
        with self._lock:
            items = list(self._instructions)
            self._instructions.clear()
        if notify and items and self._on_drain is not None:
            try:
                self._on_drain(items)
            except Exception:
                # Observability must never prevent the model from receiving an
                # already accepted runtime instruction.
                pass
        return items

    def has_instructions(self) -> bool:
        with self._lock:
            return bool(self._instructions)

    def pending_count(self) -> int:
        with self._lock:
            return len(self._instructions)


_state: InterruptState | None = None
_singleton_lock = threading.Lock()
_active_state: ContextVar[InterruptState | None] = ContextVar(
    "arforge_interrupt_state",
    default=None,
)


def get_interrupt_state() -> InterruptState:
    global _state
    if _state is None:
        with _singleton_lock:
            if _state is None:
                _state = InterruptState()
    return _state


def reset_interrupt_state() -> None:
    global _state
    with _singleton_lock:
        _state = InterruptState()


@contextmanager
def interrupt_scope(state: InterruptState) -> Iterator[InterruptState]:
    """Bind one interrupt queue to the current agent worker only."""
    token = _active_state.set(state)
    try:
        yield state
    finally:
        _active_state.reset(token)


def interrupt_hook(ctx) -> HookDecision:
    """Block on stop, or inject queued runtime instructions into messages."""
    state = _active_state.get() or get_interrupt_state()
    if state.should_stop():
        return HookDecision.block("User requested interrupt")
    instructions = state.drain_instructions()
    if instructions and ctx.messages is not None:
        for text in instructions:
            ctx.messages.append({"role": "user", "content": f"[Runtime instruction] {text}"})
        return HookDecision.modify(new_messages=ctx.messages)
    return HookDecision.proceed()


def install_interrupt_hook() -> None:
    """Install the PRE_LLM_CALL interrupt hook idempotently."""
    manager = get_hook_manager()
    manager.unregister(HookEvent.PRE_LLM_CALL, interrupt_hook)
    manager.register(HookEvent.PRE_LLM_CALL, interrupt_hook, priority=10, name="interrupt")


class InterruptControlFile:
    """Watch an append-only control file for live run commands.

    Each appended non-empty line is handled independently:
    - ``stop``, ``interrupt``, or ``cancel`` requests graceful termination.
    - ``instruction: <text>`` queues a runtime instruction for the next LLM call.
    - Any other non-empty line is treated as an instruction.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        state: InterruptState | None = None,
        poll_interval: float = 0.2,
    ) -> None:
        self.path = Path(path).expanduser()
        self.state = state or get_interrupt_state()
        self.poll_interval = max(0.05, float(poll_interval))
        self._offset = 0
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "InterruptControlFile":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.touch(exist_ok=True)
        self._offset = self.path.stat().st_size
        self._thread = threading.Thread(
            target=self._run,
            name="arforge-interrupt-control-file",
            daemon=True,
        )
        self._thread.start()
        return self

    def stop(self, timeout: float = 1.0) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def poll_once(self) -> None:
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size < self._offset:
            self._offset = 0
        if size == self._offset:
            return
        try:
            with self.path.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(self._offset)
                chunk = handle.read()
                self._offset = handle.tell()
        except OSError:
            return
        for raw_line in chunk.splitlines():
            self._handle_line(raw_line)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            self.poll_once()
            self._stop_event.wait(self.poll_interval)

    def _handle_line(self, raw_line: str) -> None:
        line = raw_line.strip()
        if not line:
            return
        command = line.lower()
        if command in {"stop", "interrupt", "cancel"}:
            self.state.request_stop()
            return
        for prefix in ("instruction:", "instruction=", "add:", "add="):
            if command.startswith(prefix):
                self.state.add_instruction(line[len(prefix):].strip())
                return
        self.state.add_instruction(line)


def start_interrupt_control_file(
    path: str | Path,
    *,
    state: InterruptState | None = None,
    poll_interval: float = 0.2,
) -> InterruptControlFile:
    """Start a control-file watcher and return a stoppable handle."""
    return InterruptControlFile(path, state=state, poll_interval=poll_interval).start()


__all__ = [
    "InterruptControlFile",
    "InterruptState",
    "get_interrupt_state",
    "interrupt_scope",
    "install_interrupt_hook",
    "interrupt_hook",
    "reset_interrupt_state",
    "start_interrupt_control_file",
]
