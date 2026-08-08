"""任务状态恢复准确率统计管道。

跨会话聚合 ``SessionRuntime._restore_agent_context_state`` 的恢复判定结果：
每次恢复把判定状态（verified_checkpoint / rebuild_pending_stale /
rebuild_pending_missing / transcript_rebuild_pending）追加为一行 JSONL
（``{ARFORGE_HOME}/recovery_outcomes.jsonl``），并提供 verified 比例、
各状态分布与近 7 天趋势的聚合报告。落盘记录只保留 session_id 与
workspace 的 sha256 指纹，避免在磁盘上留下原始标识。
"""

from __future__ import annotations

import hashlib
import json as _json
import os
from datetime import datetime, timedelta, timezone

_RECOVERY_OUTCOMES_FILE = "recovery_outcomes.jsonl"

_PENDING_REBUILD_STATES = (
    "rebuild_pending_stale",
    "rebuild_pending_missing",
    "transcript_rebuild_pending",
)

_NOTE_MAX_LENGTH = 200

_TREND_DAYS = 7


def _metrics_file_path() -> str:
    """返回恢复结果文件路径（遵循 ARFORGE_HOME 数据目录约定）。"""
    base = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return os.path.join(base, _RECOVERY_OUTCOMES_FILE)


def _fingerprint(value: str, length: int) -> str:
    """对原始值取 sha256 前 length 位，用于隐私化存储。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def record_recovery_outcome(
    *,
    session_id: str,
    recovery_state: str,
    verified: bool,
    workspace_path: str = "",
    duration_ms: float = 0.0,
    note: str = "",
) -> None:
    """追加一条上下文恢复判定结果到 JSONL；写入失败静默忽略。

    verified 语义由调用方传入（verified_checkpoint 为 True，其余为 False）。
    落盘记录不含原始 session_id 与 workspace 明文，note 截断到 200 字符。
    """
    try:
        entry = {
            "ts": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "session_hash": _fingerprint(str(session_id), 24),
            "recovery_state": str(recovery_state),
            "verified": bool(verified),
            "workspace_scope": (
                _fingerprint(str(workspace_path), 16) if workspace_path else ""
            ),
            "duration_ms": float(duration_ms or 0.0),
            "note": str(note)[:_NOTE_MAX_LENGTH],
        }
        path = _metrics_file_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(_json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def recovery_accuracy_report() -> dict:
    """聚合恢复结果文件，返回各状态分布、成功率与近 7 天趋势。

    文件不存在时返回全 0 结构，不抛异常；损坏行跳过并计入
    ``corrupt_rows``。trend 日期取 UTC 日，与记录 ts 时区一致。
    """
    events_total = 0
    verified_count = 0
    corrupt_rows = 0
    state_counts: dict[str, int] = {}
    daily_totals: dict[str, int] = {}
    daily_verified: dict[str, int] = {}
    try:
        with open(_metrics_file_path(), "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    record = _json.loads(line)
                    state = record["recovery_state"]
                    verified = bool(record["verified"])
                    day = (
                        datetime.fromisoformat(record["ts"].replace("Z", "+00:00"))
                        .date()
                        .isoformat()
                    )
                except Exception:
                    corrupt_rows += 1
                    continue
                state_counts[state] = state_counts.get(state, 0) + 1
                events_total += 1
                daily_totals[day] = daily_totals.get(day, 0) + 1
                if verified:
                    verified_count += 1
                    daily_verified[day] = daily_verified.get(day, 0) + 1
    except FileNotFoundError:
        pass
    except OSError:
        pass

    states = {
        state: {
            "count": count,
            "ratio": count / events_total if events_total else 0.0,
        }
        for state, count in sorted(state_counts.items())
    }
    pending_count = sum(state_counts.get(state, 0) for state in _PENDING_REBUILD_STATES)
    trend_start = datetime.now(timezone.utc).date() - timedelta(days=_TREND_DAYS - 1)
    daily_trend = []
    for offset in range(_TREND_DAYS):
        day = (trend_start + timedelta(days=offset)).isoformat()
        total = daily_totals.get(day, 0)
        verified = daily_verified.get(day, 0)
        daily_trend.append(
            {
                "date": day,
                "verified": verified,
                "total": total,
                "rate": verified / total if total else 0.0,
            }
        )
    return {
        "events_total": events_total,
        "states": states,
        "verified_count": verified_count,
        "restore_success_rate": verified_count / events_total if events_total else 0.0,
        "pending_rebuild_rate": pending_count / events_total if events_total else 0.0,
        "daily_trend": daily_trend,
        "corrupt_rows": corrupt_rows,
    }


def clear_recovery_metrics() -> int:
    """删除恢复结果文件并返回已删除的非空行数；文件不存在返回 0。"""
    path = _metrics_file_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            line_count = sum(1 for line in f if line.strip())
        os.remove(path)
        return line_count
    except FileNotFoundError:
        return 0
    except OSError:
        return 0
