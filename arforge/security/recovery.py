"""Checkpoint and retry helpers for recoverable operations."""

from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from arforge.logger import write_log


class ErrorCategory(Enum):
    UNKNOWN = "unknown"
    VALIDATION = "validation"
    IO = "io"
    RUNTIME = "runtime"


class RecoveryAction(Enum):
    RETRY = "retry"
    ROLLBACK = "rollback"
    ALTERNATIVE = "alternative"
    NONE = "none"


class ValidationError(Exception):
    def __init__(self, message: str, result: Any = None):
        super().__init__(message)
        self.result = result


@dataclass
class RetryPolicy:
    max_retries: int = 3
    backoff_base: float = 0.5
    backoff_multiplier: float = 2.0
    max_backoff: float = 30.0
    jitter: bool = True


@dataclass
class Checkpoint:
    id: str
    created_at: str
    label: str
    files: Dict[str, str] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    _restored: bool = False


@dataclass
class RecoveryResult:
    success: bool
    result: Any = None
    error: Optional[Exception] = None
    error_category: ErrorCategory = ErrorCategory.UNKNOWN
    action_taken: Optional[RecoveryAction] = None
    attempts: int = 1
    checkpoints_used: List[str] = field(default_factory=list)
    total_duration: float = 0.0
    recovery_log: List[str] = field(default_factory=list)


class ErrorClassifier:
    def classify(self, error: Exception) -> ErrorCategory:
        if isinstance(error, ValidationError):
            return ErrorCategory.VALIDATION
        if isinstance(error, OSError):
            return ErrorCategory.IO
        if isinstance(error, RuntimeError):
            return ErrorCategory.RUNTIME
        return ErrorCategory.UNKNOWN


class CheckpointManager:
    def __init__(self, checkpoint_dir: str = ".arforge/checkpoints"):
        self.checkpoint_dir = Path(checkpoint_dir)
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)

    def create(self, label: str, files: List[str] = None, metadata: Dict[str, Any] = None) -> Checkpoint:
        checkpoint_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        checkpoint = Checkpoint(checkpoint_id, datetime.now().isoformat(timespec="seconds"), label, {}, metadata or {})
        for file_name in files or []:
            path = Path(file_name)
            if path.exists() and path.is_file():
                checkpoint.files[str(path)] = path.read_text(encoding="utf-8")
        target = self.checkpoint_dir / f"{checkpoint_id}.json"
        target.write_text(json.dumps(checkpoint.__dict__, ensure_ascii=False, indent=2), encoding="utf-8")
        return checkpoint

    def restore(self, checkpoint: Checkpoint) -> None:
        for file_name, content in checkpoint.files.items():
            Path(file_name).write_text(content, encoding="utf-8")
        checkpoint._restored = True


class RecoveryEngine:
    def __init__(self, max_retries: int = 3):
        self.policy = RetryPolicy(max_retries=max_retries)
        self.classifier = ErrorClassifier()
        self.checkpoints = CheckpointManager()

    def safe_execute(
        self,
        operation: Callable[[], Any],
        label: str = "safe_op",
        files: List[str] = None,
        alternatives: List[Callable] = None,
        **kwargs,
    ) -> RecoveryResult:
        started = time.perf_counter()
        checkpoint = self.checkpoints.create(label, files or {})
        log: list[str] = []
        last_error: Exception | None = None
        for attempt in range(1, self.policy.max_retries + 1):
            try:
                value = operation()
                return RecoveryResult(True, value, attempts=attempt, checkpoints_used=[checkpoint.id], total_duration=time.perf_counter() - started, recovery_log=log)
            except Exception as exc:
                last_error = exc
                log.append(f"attempt {attempt} failed: {exc}")
                write_log("warning", log[-1])
                if attempt < self.policy.max_retries:
                    delay = self.policy.backoff_base * (self.policy.backoff_multiplier ** (attempt - 1))
                    delay = min(delay, self.policy.max_backoff)
                    if self.policy.jitter:
                        delay *= random.uniform(0.5, 1.5)
                    log.append(f"backoff {delay:.3f}s before retry {attempt + 1}")
                    time.sleep(delay)
        for alternative in alternatives or []:
            try:
                value = alternative()
                return RecoveryResult(True, value, last_error, self.classifier.classify(last_error), RecoveryAction.ALTERNATIVE, self.policy.max_retries, [checkpoint.id], time.perf_counter() - started, log)
            except Exception as exc:
                last_error = exc
                log.append(f"alternative failed: {exc}")
        return RecoveryResult(False, None, last_error, self.classifier.classify(last_error), RecoveryAction.NONE, self.policy.max_retries, [checkpoint.id], time.perf_counter() - started, log)


_ENGINE: RecoveryEngine | None = None


def get_recovery_engine() -> RecoveryEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = RecoveryEngine()
    return _ENGINE


def safe_execute(operation: Callable[[], Any], label: str = "safe_op", files: List[str] = None, alternatives: List[Callable] = None, **kwargs) -> RecoveryResult:
    return get_recovery_engine().safe_execute(operation, label, files, alternatives, **kwargs)
