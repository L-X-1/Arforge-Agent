"""记忆写入率指标统计管道.

记录自动记忆写入门禁决策（仅存内容哈希，不存原文），
聚合 JSONL 事件与真实库治理指标，衡量写入防护是否在起作用。
"""

from __future__ import annotations

import hashlib
import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

_METRICS_FILENAME = "memory_writes.jsonl"


def _home_dir() -> Path:
    base = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return Path(base)


def _metrics_path() -> Path:
    return _home_dir() / _METRICS_FILENAME


def _normalize_content(content: str) -> str:
    """归一化内容：strip + 空白压单空格 + 小写，用于哈希与信号匹配。"""
    return " ".join(str(content).split()).casefold()


def _content_hash(content: str) -> str:
    normalized = _normalize_content(content)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return "sha256:" + digest[:32]


def _workspace_scope(workspace_path: str) -> str:
    """工作区的最小化标识：路径哈希前 16 位，空路径返回空串。"""
    path = str(workspace_path or "")
    if not path:
        return ""
    return hashlib.sha256(path.encode("utf-8")).hexdigest()[:16]


def record_write_decision(
    *,
    content: str,
    mem_type: str,
    eligible: bool,
    reason: str,
    source: str,
    saved: bool,
    workspace_path: str = "",
) -> None:
    """追加一次写入门禁决策到 JSONL 事件文件.

    隐私约束：只写内容哈希，绝不写原文。任何 IO 失败都静默忽略，
    统计不能影响主流程。
    """
    try:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "content_hash": _content_hash(content),
            "mem_type": str(mem_type or "knowledge"),
            "eligible": bool(eligible),
            "reason": str(reason or ""),
            "source": str(source or "rule"),
            "saved": bool(saved),
            "workspace_scope": _workspace_scope(workspace_path),
        }
        path = _metrics_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _aggregate_log() -> dict:
    """聚合 JSONL 事件文件；文件缺失时返回全零统计。"""
    path = _metrics_path()
    records: list[dict] = []
    if path.is_file():
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        records.append(json.loads(stripped))
                    except Exception:
                        continue
        except Exception:
            pass

    decisions_total = len(records)
    saved_total = sum(1 for record in records if record.get("saved"))
    rejected_total = sum(1 for record in records if not record.get("eligible"))
    transient_rejected = sum(
        1 for record in records if record.get("reason") == "transient_instruction"
    )
    rejected_reasons = Counter(
        record.get("reason", "") for record in records if not record.get("eligible")
    )
    return {
        "decisions_total": decisions_total,
        "saved_total": saved_total,
        "saved_rate": round(saved_total / decisions_total, 4) if decisions_total else 0.0,
        "rejected_total": rejected_total,
        "rejection_rate": round(rejected_total / decisions_total, 4) if decisions_total else 0.0,
        "rejection_reasons_top": dict(rejected_reasons.most_common(5)),
        "by_source": dict(Counter(record.get("source", "rule") for record in records)),
        "by_mem_type": dict(Counter(record.get("mem_type", "knowledge") for record in records)),
        "transient_rejected": transient_rejected,
        "write_rejection_effectiveness": (
            round(rejected_total / (saved_total + rejected_total), 4)
            if (saved_total + rejected_total)
            else 0.0
        ),
    }


def _aggregate_database() -> dict:
    """从真实库聚合治理指标（lifecycle / provenance 统计）。"""
    from arforge.database import Memory, get_session

    with get_session() as session:
        total = session.query(Memory).count()
        quarantined = (
            session.query(Memory).filter(Memory.lifecycle == "quarantined").count()
        )
        rejected = session.query(Memory).filter(Memory.lifecycle == "rejected").count()
        candidates = session.query(Memory).filter(Memory.lifecycle == "candidate").count()
        corrections = sum(
            1
            for memory in session.query(Memory).filter(Memory.lifecycle == "active").all()
            if isinstance(memory.provenance, dict) and "corrects_memory_uid" in memory.provenance
        )
        return {
            "quarantined_count": quarantined,
            "correction_count": corrections,
            "correction_rate": round(corrections / total, 4) if total else 0.0,
            "rejected_candidate_count": rejected,
            "candidate_count": candidates,
        }


def memory_write_stats() -> dict:
    """聚合写入门禁事件与真实库治理指标.

    事件文件缺失时事件部分返回零值，库部分照常统计；
    真实库查询失败时保留文件侧统计，库部分标记为 ``{"database": {"error": ...}}``，
    不整体报错。
    """
    stats = _aggregate_log()
    try:
        stats["database"] = _aggregate_database()
    except Exception as exc:
        stats["database"] = {"error": str(exc)}
    return stats


def clear_write_metrics() -> int:
    """删除写入门禁事件文件并返回被删除的行数（用于测试与重置）。"""
    path = _metrics_path()
    count = 0
    if path.is_file():
        try:
            with path.open("r", encoding="utf-8") as handle:
                count = sum(1 for _ in handle)
        except Exception:
            pass
    try:
        if path.is_file():
            path.unlink()
    except Exception:
        pass
    return count
