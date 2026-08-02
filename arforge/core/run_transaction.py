"""v1-1.5：任务级回滚（run 事务）。

每个 agentic run 视为一个事务：run 内**首次**改动某文件前，快照其原始内容
（文件原本不存在则记 None=新建）。run 结束把快照落盘到 ~/.arforge/runs/<run_id>.json。
``arforge revert [run_id]`` 据此把工作区恢复到 run 前：
  - 原有文件 → 写回原始内容；
  - run 新建的文件 → 删除。

快照在 PRE_TOOL_USE（写文件之前）进行，与 change_tracker（POST 记文件名）互补。
门控事件里本 handler 返回 None（fire 视作 proceed），不影响权限裁决。
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import base64
import binascii
import json
import re
import threading
import uuid
from pathlib import Path
from typing import Iterator

from arforge.core.hooks import HookEvent, get_hook_manager
from arforge.paths import data_path
from arforge.security_guard import sanitize_for_storage

MAX_PORTABLE_TRACE_BYTES = 5 * 1024 * 1024
MAX_PORTABLE_TRACE_EVENTS = 5_000
MAX_REPORT_TRACE_EVENTS = 500
MAX_REPORT_TRACE_CHARS = 512 * 1024
_RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")

_OFFICE_SUFFIXES = {
    "write_docx": ".docx",
    "write_xlsx": ".xlsx",
    "write_pptx": ".pptx",
    "write_pdf": ".pdf",
}
_WRITE_TOOLS = {
    "write_file",
    "edit_file",
    "create_file",
    "delete_file",
    *_OFFICE_SUFFIXES,
}


class RunTransaction:
    """记录本 run 内每个文件首次改动前的原始内容。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._orig: dict[str, str | bytes | None] = {}  # abs_path -> 原内容（None=run 前不存在）

    def snapshot(self, abs_path: str, original: str | bytes | None) -> None:
        with self._lock:
            if abs_path not in self._orig:  # 仅记首次，保留 run 起点
                self._orig[abs_path] = original

    def entries(self) -> dict:
        with self._lock:
            return dict(self._orig)

    def is_empty(self) -> bool:
        with self._lock:
            return not self._orig

    def to_dict(self, run_id: str) -> dict:
        import time

        with self._lock:
            entries = []
            for path, original in self._orig.items():
                entry: dict[str, str | None] = {
                    "path": path,
                    "original": original if isinstance(original, str) else None,
                }
                if isinstance(original, bytes):
                    entry["original_b64"] = base64.b64encode(original).decode("ascii")
                entries.append(entry)
            return {
                "run_id": run_id,
                "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "entries": entries,
            }


# ---------------------------------------------------------------------------
# 会话级单例
# ---------------------------------------------------------------------------

_TXN: ContextVar[RunTransaction | None] = ContextVar(
    "arforge_run_transaction",
    default=None,
)


def get_run_transaction() -> RunTransaction:
    """Return the transaction bound to the current logical execution context."""
    transaction = _TXN.get()
    if transaction is None:
        transaction = RunTransaction()
        _TXN.set(transaction)
    return transaction


def reset_run_transaction() -> None:
    """Replace the current execution's transaction without affecting other sessions."""
    _TXN.set(RunTransaction())


@contextmanager
def run_transaction_scope() -> Iterator[None]:
    """Create a fresh transaction for nested execution and restore its parent."""
    token = _TXN.set(RunTransaction())
    try:
        yield
    finally:
        _TXN.reset(token)


# ---------------------------------------------------------------------------
# PRE_TOOL_USE hook：写文件前快照原始内容
# ---------------------------------------------------------------------------


def _snapshot_hook(ctx) -> None:
    if ctx.tool_name not in _WRITE_TOOLS:
        return
    filename = (ctx.tool_args or {}).get("filename")
    if not filename:
        return
    suffix = _OFFICE_SUFFIXES.get(ctx.tool_name)
    if suffix and Path(str(filename)).suffix == "":
        filename = f"{filename}{suffix}"
    try:
        from arforge.tools.file_tools import _resolve

        path = _resolve(filename)
    except Exception:  # noqa: BLE001  路径越界等 → 交给既有守卫
        return
    if not path.is_file():
        get_run_transaction().snapshot(str(path), None)
        return
    try:
        if path.suffix.lower() in {".docx", ".xlsx", ".pptx", ".pdf"}:
            original: str | bytes = path.read_bytes()
        else:
            try:
                original = path.read_text(encoding="utf-8")
            except UnicodeError:
                # delete_file accepts any file type.  Treat undecodable existing
                # files as bytes rather than as a newly created file, otherwise a
                # later revert could delete the original data.
                original = path.read_bytes()
    except OSError:
        # Do not record an unreadable existing path as ``None``: that sentinel
        # means "created by this run" and would make reverting destructive.
        return
    get_run_transaction().snapshot(str(path), original)


def install_run_transaction_hook() -> None:
    """安装快照 hook（PRE_TOOL_USE，priority=85：权限裁决之后、执行之前）。"""
    manager = get_hook_manager()
    if "run_transaction" in manager.handler_names(HookEvent.PRE_TOOL_USE):
        return
    manager.register(HookEvent.PRE_TOOL_USE, _snapshot_hook, priority=85, name="run_transaction")


# ---------------------------------------------------------------------------
# 持久化 + 回滚
# ---------------------------------------------------------------------------


def _runs_dir() -> Path:
    return data_path("runs")


def _validated_run_id(run_id: str) -> str:
    if (
        not isinstance(run_id, str)
        or not _RUN_ID_PATTERN.fullmatch(run_id)
        or ".." in run_id
    ):
        raise ValueError("run_id must be a safe identifier up to 120 characters")
    return run_id


def persist_run_transaction(run_id: str) -> Path:
    """把当前事务落盘到 ~/.arforge/runs/<run_id>.json，返回路径。"""
    run_id = _validated_run_id(run_id)
    d = _runs_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = d / f"{run_id}.json"
    target.write_text(
        json.dumps(get_run_transaction().to_dict(run_id), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target


def list_run_ids() -> list[str]:
    """已落盘的 run_id（按文件名升序，时间戳命名即时间序）。"""
    d = _runs_dir()
    if not d.is_dir():
        return []
    ids: list[str] = []
    for p in d.glob("*.json"):
        if p.name.endswith(".messages.json") or p.name.endswith(".trace.json"):
            continue
        ids.append(p.stem)
    return sorted(ids)


def list_replay_run_ids() -> list[str]:
    """有可诊断产物的 run_id（事务 / messages / trace 任一存在即可）。"""
    d = _runs_dir()
    if not d.is_dir():
        return []
    ids: set[str] = set()
    for p in d.glob("*.json"):
        name = p.name
        if name.endswith(".messages.json"):
            ids.add(name[:-len(".messages.json")])
        elif name.endswith(".trace.json"):
            ids.add(name[:-len(".trace.json")])
        else:
            ids.add(p.stem)
    return sorted(ids)


def load_run(run_id: str) -> dict:
    run_id = _validated_run_id(run_id)
    target = _runs_dir() / f"{run_id}.json"
    if not target.is_file():
        raise FileNotFoundError(run_id)
    return json.loads(target.read_text(encoding="utf-8"))


def revert_run(run_id: str) -> tuple[int, int, int]:
    """回滚一个 run：返回 (restored, deleted, skipped)。

    restored=写回原内容的文件数；deleted=删除的新建文件数；skipped=出错跳过数。
    """
    data = load_run(run_id)
    restored = deleted = skipped = 0
    for e in data.get("entries", []):
        path = Path(e.get("path", ""))
        original = e.get("original")
        try:
            encoded = e.get("original_b64")
            if isinstance(encoded, str):
                restored_bytes = base64.b64decode(encoded, validate=True)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(restored_bytes)
                restored += 1
            elif original is None:
                if path.is_file():
                    path.unlink()
                    deleted += 1
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(original, encoding="utf-8")
                restored += 1
        except (OSError, TypeError, ValueError, binascii.Error):
            skipped += 1
    return restored, deleted, skipped


# ---------------------------------------------------------------------------
# G6：对话 messages 落盘 / 加载（任务级 resume）
# ---------------------------------------------------------------------------


def save_run_messages(run_id: str, messages) -> Path:
    """把本 run 的对话 messages 落盘到 ~/.arforge/runs/<run_id>.messages.json。"""
    run_id = _validated_run_id(run_id)
    d = _runs_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = d / f"{run_id}.messages.json"
    target.write_text(
        json.dumps(sanitize_for_storage(messages), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target


def load_run_messages(run_id: str) -> list:
    """加载某 run 的对话 messages（用于 --resume 续跑）。缺失抛 FileNotFoundError。"""
    run_id = _validated_run_id(run_id)
    target = _runs_dir() / f"{run_id}.messages.json"
    if not target.is_file():
        raise FileNotFoundError(run_id)
    return json.loads(target.read_text(encoding="utf-8"))


def build_run_report(run_id: str) -> dict:
    """Build a read-only structured report from persisted run artifacts."""
    transaction = None
    trace_doc = None
    messages = None
    try:
        transaction = load_run(run_id)
    except FileNotFoundError:
        pass
    try:
        trace_doc = load_run_trace(run_id)
    except FileNotFoundError:
        pass
    try:
        messages = load_run_messages(run_id)
    except FileNotFoundError:
        pass
    if transaction is None and trace_doc is None and messages is None:
        raise FileNotFoundError(run_id)

    entries = transaction.get("entries", []) if transaction else []
    trace = trace_doc.get("trace", []) if trace_doc else []
    commands = [
        {
            "command": event.get("command") or event.get("args", {}).get("command", ""),
            "success": bool(event.get("success", event.get("returncode", 1) == 0)),
            "returncode": event.get("returncode"),
        }
        for event in trace
        if event.get("event") in {"command", "run_cmd"} or event.get("tool") == "run_cmd"
    ]
    report_trace: list[dict] = []
    trace_chars = 0
    trace_truncated = len(trace) > MAX_REPORT_TRACE_EVENTS
    for event in trace[:MAX_REPORT_TRACE_EVENTS]:
        if not isinstance(event, dict):
            continue
        safe_event = sanitize_for_storage(event)
        encoded = json.dumps(safe_event, ensure_ascii=False, separators=(",", ":"), default=str)
        if trace_chars + len(encoded) > MAX_REPORT_TRACE_CHARS:
            trace_truncated = True
            break
        report_trace.append(json.loads(encoded))
        trace_chars += len(encoded)
    return {
        "schema_version": 1,
        "run_id": run_id,
        "created": (trace_doc or transaction or {}).get("created", ""),
        "has_transaction": transaction is not None,
        "has_trace": trace_doc is not None,
        "has_messages": messages is not None,
        "changed_files": [entry.get("path", "") for entry in entries if entry.get("path")],
        "commands_run": commands,
        "trace_events": len(trace),
        "messages_count": len(messages or []),
        "answer": (trace_doc or {}).get("answer", ""),
        "observability": (trace_doc or {}).get("observability", {}),
        "self_correct": (trace_doc or {}).get("self_correct", {}),
        "trace": report_trace,
        "trace_truncated": trace_truncated,
    }


def list_run_reports(limit: int = 20) -> list[dict]:
    """Return latest persisted run report summaries."""
    summaries: list[dict] = []
    for run_id in reversed(list_replay_run_ids()[-limit:]):
        try:
            report = build_run_report(run_id)
        except FileNotFoundError:
            continue
        summaries.append(
            {
                "run_id": run_id,
                "created": report["created"],
                "has_transaction": report["has_transaction"],
                "has_trace": report["has_trace"],
                "has_messages": report["has_messages"],
                "changed_files": len(report["changed_files"]),
                "trace_events": report["trace_events"],
                "messages_count": report["messages_count"],
                "answer_preview": report["answer"][:240],
            }
        )
    return summaries


# ---------------------------------------------------------------------------
# G20：trace 落盘 / replay 诊断（只读）
# ---------------------------------------------------------------------------


def save_run_trace(
    run_id: str,
    trace: list,
    observability: dict | None = None,
    answer: str = "",
    self_correct: dict | None = None,
) -> Path:
    """把本 run 的 trace/observability 落盘到 ~/.arforge/runs/<run_id>.trace.json。"""
    import time

    run_id = _validated_run_id(run_id)
    d = _runs_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = d / f"{run_id}.trace.json"
    payload = {
        "run_id": run_id,
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "trace": trace or [],
        "observability": observability or {},
        "answer": answer or "",
        "self_correct": self_correct or {},
    }
    target.write_text(
        json.dumps(sanitize_for_storage(payload), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target


def load_run_trace(run_id: str) -> dict:
    """加载某 run 的 trace 诊断产物。缺失抛 FileNotFoundError。"""
    run_id = _validated_run_id(run_id)
    target = _runs_dir() / f"{run_id}.trace.json"
    if not target.is_file():
        raise FileNotFoundError(run_id)
    return json.loads(target.read_text(encoding="utf-8"))


def export_run_trace(run_id: str) -> dict:
    """Return one persisted trace as a bounded, versioned portable document."""

    document = load_run_trace(run_id)
    trace = document.get("trace")
    if not isinstance(trace, list) or len(trace) > MAX_PORTABLE_TRACE_EVENTS:
        raise ValueError("trace event count exceeds the portable export limit")
    portable = {
        "schema": "arforge.run.trace",
        "schema_version": 1,
        "run_id": run_id,
        "created": str(document.get("created", ""))[:64],
        "trace": sanitize_for_storage(trace),
        "observability": sanitize_for_storage(document.get("observability", {})),
        "answer": str(sanitize_for_storage(document.get("answer", "")))[:100_000],
        "self_correct": sanitize_for_storage(document.get("self_correct", {})),
    }
    content = json.dumps(portable, ensure_ascii=False, indent=2, default=str)
    if len(content.encode("utf-8")) > MAX_PORTABLE_TRACE_BYTES:
        raise ValueError("trace export exceeds the portable size limit")
    return {
        "format": "json",
        "mime_type": "application/json",
        "filename": f"run-trace-{run_id}.json",
        "content": content,
        "trace_events": len(trace),
    }


def import_run_trace(content: str) -> dict:
    """Validate and persist a portable trace under an isolated new run identity."""

    if not isinstance(content, str) or not content.strip():
        raise ValueError("content must be a non-empty JSON string")
    if len(content.encode("utf-8")) > MAX_PORTABLE_TRACE_BYTES:
        raise ValueError("trace import exceeds the portable size limit")
    try:
        document = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"trace import is invalid JSON at line {exc.lineno}") from None
    allowed = {
        "schema",
        "schema_version",
        "run_id",
        "created",
        "trace",
        "observability",
        "answer",
        "self_correct",
    }
    if not isinstance(document, dict) or set(document) - allowed:
        raise ValueError("trace import has unsupported top-level fields")
    if document.get("schema") != "arforge.run.trace" or document.get("schema_version") != 1:
        raise ValueError("trace import schema is not supported")
    trace = document.get("trace")
    if not isinstance(trace, list) or len(trace) > MAX_PORTABLE_TRACE_EVENTS:
        raise ValueError(f"trace must contain at most {MAX_PORTABLE_TRACE_EVENTS} events")
    clean_trace: list[dict] = []
    for index, event in enumerate(trace, start=1):
        if not isinstance(event, dict):
            raise ValueError(f"trace event {index} must be an object")
        encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":"), default=str)
        if len(encoded) > 32_000:
            raise ValueError(f"trace event {index} exceeds 32,000 characters")
        clean_trace.append(sanitize_for_storage(event))
    imported_run_id = f"imported-{uuid.uuid4().hex}"
    target = save_run_trace(
        imported_run_id,
        clean_trace,
        document.get("observability") if isinstance(document.get("observability"), dict) else {},
        str(document.get("answer", ""))[:100_000],
        document.get("self_correct") if isinstance(document.get("self_correct"), dict) else {},
    )
    return {
        "schema_version": 1,
        "imported": True,
        "run_id": imported_run_id,
        "source_run_id": str(document.get("run_id", ""))[:120],
        "trace_events": len(clean_trace),
        "path": str(target),
    }
