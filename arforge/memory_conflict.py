"""记忆矛盾自动检测器：与桌面端 memory.ts 同一套确定性规则，以及金标准评测。

检测器从记忆内容中提取"声明键值对"（claim），同 scope 同 key 不同 value 即
视为矛盾。规则与 ``packages/core/src/memory.ts`` 的 ``deriveClaim`` /
``detectConflicts`` 严格对齐，因此两端检测结果一致。

评测（``run_conflict_benchmark``）使用内建金标准矛盾集，给出确定性的
检出率 / 误报率 / 精确率，历史写入 ``{ARFORGE_HOME}/memory_conflict_benchmark.jsonl``。
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 与桌面端 memory.ts 完全一致的三段式声明提取。
_CHINESE_CLAIM_RE = re.compile(
    r"^(.{1,60}?(?:区域|语言|时区|端口|版本|分支|路径|目录|模型|名称|名字|邮箱|邮件|端点|环境|账号|账户|状态))"
    r"\s*(?:是|为|=|：|:)\s*(.{1,200}?)[。.!]?$",
    re.UNICODE,
)
_ENGLISH_CLAIM_RE = re.compile(
    r"^(?:the\s+)?"
    r"(.{1,80}?(?:deployment\s+region|region|language|time\s*zone|timezone|port|version|branch|path|"
    r"directory|model|name|email|endpoint|environment|account|status))"
    r"\s+(?:is|equals|=|uses?)\s+(.{1,200}?)[.!]?$",
    re.IGNORECASE | re.UNICODE,
)
_CONTROL_CHARS_RE = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
_KEY_WHITESPACE_UNDERSCORE_RE = re.compile(r"[\s_]+")
# 桌面端使用 \p{L}\p{N}；Python re 不支持 Unicode 属性，\w（UNICODE 模式）覆盖
# 字母、数字（含 Nl/No）与下划线；下划线已被上一步替换为 "-"，语义等价。
_KEY_JUNK_RE = re.compile(r"[^\w.:-]+", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")
_FACT_KEY_PREFIX = "fact-key:"
_SCOPE_SEPARATOR = "\x00"
_MAX_CONFLICT_RESULTS = 200
_BENCHMARK_FILE_NAME = "memory_conflict_benchmark.jsonl"


def sanitize(value: str) -> str:
    """去除控制字符并 trim，与桌面端 ``sanitize`` 一致。"""
    return _CONTROL_CHARS_RE.sub("", value).strip()


def canonical_path(value: str) -> str:
    """路径归一化：反斜杠转正斜杠、去尾部斜杠；win32 平台小写。空串兜底为 "/"。"""
    normalized = re.sub(r"/+$", "", value.replace("\\", "/"))
    if not normalized:
        normalized = "/"
    return normalized.lower() if sys.platform == "win32" else normalized


def normalize(value: str) -> str:
    """内容归一化：sanitize → NFKC → lower → 空白压成单空格。"""
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFKC", sanitize(value)).lower())


def normalize_claim_key(value: str) -> str:
    """key 归一化：sanitize → NFKC → lower → 空白/下划线变 "-" → 其余非字母数字变 "-"。"""
    key = _KEY_JUNK_RE.sub("-", _KEY_WHITESPACE_UNDERSCORE_RE.sub(
        "-",
        unicodedata.normalize("NFKC", sanitize(value)).lower(),
    ))
    return key.strip("-")[:160]


def scope_fingerprint(scope: str, project_id: str = "", workspace_path: str = "") -> str:
    """scope 指纹：global 恒为 "global"，workspace 为 workspace:project:path。"""
    if str(scope or "") == "global":
        return "global"
    return f"workspace:{str(project_id or '')}:{canonical_path(str(workspace_path or ''))}"


def _split_tags(tags: str) -> list[str]:
    """数据库 tags 为逗号分隔字符串，拆成标签列表。"""
    return [tag.strip() for tag in str(tags or "").split(",") if tag.strip()]


def derive_claim(content: str, tags: str = "") -> dict[str, str] | None:
    """从单条记忆提取"声明键值对"。

    规则（与桌面端 memory.ts 一致）：
    1. 显式标签：tags 中含 ``fact-key:<key>`` 前缀 → key 取标签值，value 取整段
       content 归一化文本；
    2. 中文模式：``<1..60 字符> <关键字> [是|为|=|：|:] <值>``；
    3. 英文模式：``[the ]<1..80 字符> <关键字> [is|equals|=|uses] <值>``。

    返回 ``{"key", "value", "basis"}``；无匹配返回 None。
    """
    for tag in _split_tags(tags):
        if tag.lower().startswith(_FACT_KEY_PREFIX):
            key = normalize_claim_key(tag[len(_FACT_KEY_PREFIX):])
            value = normalize(content)
            if key and value:
                return {"key": key, "value": value, "basis": "explicit-tag"}

    matched = _CHINESE_CLAIM_RE.match(unicodedata.normalize("NFKC", sanitize(content)))
    if matched is not None and matched.group(1) and matched.group(2):
        key = normalize_claim_key(matched.group(1))
        value = normalize(matched.group(2))
        if key and value:
            return {"key": key, "value": value, "basis": "deterministic-pattern-v1"}

    matched = _ENGLISH_CLAIM_RE.match(unicodedata.normalize("NFKC", sanitize(content)))
    if matched is not None and matched.group(1) and matched.group(2):
        key = normalize_claim_key(matched.group(1))
        value = normalize(matched.group(2))
        if key and value:
            return {"key": key, "value": value, "basis": "deterministic-pattern-v1"}

    return None


def _memory_scope(memory: dict[str, Any]) -> str:
    """输入记录缺省 scope 字段时，按 project_id/workspace_path 推导。"""
    explicit = memory.get("scope")
    if explicit in {"global", "workspace"}:
        return str(explicit)
    if not memory.get("project_id") and not memory.get("workspace_path"):
        return "global"
    return "workspace"


def detect_claim_conflicts(memories: list[dict[str, Any]]) -> dict[str, Any]:
    """自动检测同 scope 同 key 不同 value 的矛盾对。

    输入每项：``{"id", "content", "tags", "project_id", "workspace_path", "scope"}``；
    scope 缺省时按 project_id/workspace_path 推导（两者皆空 → global）。

    输出：``{"items": [{"left_id", "right_id", "key", "left_value", "right_value",
    "basis"}...], "truncated": bool}``；矛盾对按 id 升序且 left_id < right_id 去重。
    超出 ``_MAX_CONFLICT_RESULTS``（200）对即截断并标记 truncated。
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for memory in memories:
        claim = derive_claim(str(memory.get("content", "")), str(memory.get("tags", "")))
        if claim is None:
            continue
        group_key = (
            f"{scope_fingerprint(_memory_scope(memory), memory.get('project_id'), memory.get('workspace_path'))}"
            f"{_SCOPE_SEPARATOR}{claim['key']}"
        )
        groups.setdefault(group_key, []).append({"memory": memory, "claim": claim})

    result: list[dict[str, Any]] = []
    for group in groups.values():
        group.sort(key=lambda item: int(item["memory"]["id"]))
        for left_index, left in enumerate(group):
            for right in group[left_index + 1:]:
                if left["claim"]["value"] == right["claim"]["value"]:
                    continue
                basis = (
                    "explicit-tag"
                    if "explicit-tag" in {left["claim"]["basis"], right["claim"]["basis"]}
                    else "deterministic-pattern-v1"
                )
                if len(result) >= _MAX_CONFLICT_RESULTS:
                    return {"items": result, "truncated": True}
                result.append(
                    {
                        "left_id": int(left["memory"]["id"]),
                        "right_id": int(right["memory"]["id"]),
                        "key": left["claim"]["key"],
                        "left_value": left["claim"]["value"],
                        "right_value": right["claim"]["value"],
                        "basis": basis,
                    }
                )
    return {"items": result, "truncated": False}


def _memory(
    memory_id: int,
    content: str,
    *,
    tags: str = "",
    project_id: str = "",
    workspace_path: str = "",
    scope: str = "global",
) -> dict[str, Any]:
    """构造单条检测器输入记录。"""
    return {
        "id": memory_id,
        "content": content,
        "tags": tags,
        "project_id": project_id,
        "workspace_path": workspace_path,
        "scope": scope,
    }


def builtin_conflict_suite() -> list[dict[str, Any]]:
    """金标准矛盾集：确定性规则评测（非模型评测）。

    注意：中文/英文模式的关键字不能位于内容开头（捕获组至少需 1 个前缀字符），
    因此示例统一使用带前缀的写法，如"服务器端口是 8080"。
    """
    return [
        {
            "memories": [
                _memory(1, "服务器端口是 8080", project_id="p1", workspace_path="/work", scope="workspace"),
                _memory(2, "服务器端口是 9090", project_id="p1", workspace_path="/work", scope="workspace"),
            ],
            "expect_conflict": True,
            "description": "中文模式真冲突：端口 8080 vs 9090",
        },
        {
            "memories": [
                _memory(1, "The deployment region is us-east-1", scope="global"),
                _memory(2, "deployment region is eu-west-1", scope="global"),
            ],
            "expect_conflict": True,
            "description": "英文模式真冲突：deployment region us-east-1 vs eu-west-1",
        },
        {
            "memories": [
                _memory(1, "默认模型是 gpt-4", tags="fact-key:model", scope="global"),
                _memory(2, "默认模型是 gpt-4o", tags="fact-key:model", scope="global"),
            ],
            "expect_conflict": True,
            "description": "显式 fact-key 标签同 key 不同值：model gpt-4 vs gpt-4o",
        },
        {
            "memories": [
                _memory(1, "开发语言是 Python", scope="global"),
                _memory(2, "开发语言是 JavaScript", scope="global"),
            ],
            "expect_conflict": True,
            "description": "中文模式真冲突：语言 Python vs JavaScript",
        },
        {
            "memories": [
                _memory(1, "当前版本是 1.2.0", scope="global"),
                _memory(2, "当前版本是 1.2.1", scope="global"),
            ],
            "expect_conflict": True,
            "description": "中文模式真冲突：版本 1.2.0 vs 1.2.1",
        },
        {
            "memories": [
                _memory(1, "项目时区是 Asia/Shanghai", scope="global"),
                _memory(2, "项目时区是 UTC", scope="global"),
            ],
            "expect_conflict": True,
            "description": "中文模式真冲突：时区 Asia/Shanghai vs UTC",
        },
        {
            "memories": [
                _memory(1, "服务器端口是 8080", project_id="p1", workspace_path="/work", scope="workspace"),
                _memory(2, "服务器端口是  8080", project_id="p1", workspace_path="/work", scope="workspace"),
            ],
            "expect_conflict": False,
            "description": "同值非冲突：端口值相同（含空白差异，验证归一化）",
        },
        {
            "memories": [
                _memory(1, "The deployment region is us-east-1", scope="global"),
                _memory(2, "deployment region is us-east-1", scope="global"),
            ],
            "expect_conflict": False,
            "description": "同值非冲突：deployment region 值相同",
        },
        {
            "memories": [
                _memory(1, "今天天气不错", scope="global"),
                _memory(2, "晚饭记得买菜", scope="global"),
            ],
            "expect_conflict": False,
            "description": "无关内容：两条均提取不到 claim",
        },
        {
            "memories": [
                _memory(1, "服务器端口是 8080", scope="global"),
                _memory(2, "请记得提交代码", scope="global"),
            ],
            "expect_conflict": False,
            "description": "无关内容：仅一条能提取 claim，无成对比较",
        },
        {
            "memories": [
                _memory(1, "服务器端口是 8080", project_id="p1", workspace_path="/work", scope="workspace"),
                _memory(2, "服务器端口是 9090", scope="global"),
            ],
            "expect_conflict": False,
            "description": "跨 scope 非冲突：workspace 与 global 指纹不同",
        },
        {
            "memories": [
                _memory(1, "项目时区是 UTC", scope="global"),
                _memory(2, "项目时区是 UTC", scope="global"),
            ],
            "expect_conflict": False,
            "description": "同 key 同 scope 但值相同的边界：不冲突",
        },
    ]


def _benchmark_path() -> Path:
    home = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return Path(home) / _BENCHMARK_FILE_NAME


def _append_benchmark_record(metrics: dict[str, Any]) -> None:
    """历史记录追加失败不影响评测返回值。"""
    try:
        path = _benchmark_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"timestamp": datetime.now(timezone.utc).isoformat(), **metrics}
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def run_conflict_benchmark(suite: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """对金标准矛盾集逐条评测检测器。

    输出 detection_rate / false_positive_rate / precision / recall / case_results /
    truncated；结果追加写入 ``{ARFORGE_HOME}/memory_conflict_benchmark.jsonl``
    （写入失败不影响返回）。
    """
    cases = builtin_conflict_suite() if suite is None else suite
    case_results: list[dict[str, Any]] = []
    true_conflicts = 0
    detected_true = 0
    non_conflicts = 0
    detected_false = 0
    detected_total = 0
    truncated = False
    for case in cases:
        outcome = detect_claim_conflicts(list(case["memories"]))
        truncated = truncated or bool(outcome["truncated"])
        detected = bool(outcome["items"])
        expect = bool(case["expect_conflict"])
        conflict_keys = sorted({item["key"] for item in outcome["items"]})
        if expect:
            true_conflicts += 1
            if detected:
                detected_true += 1
                detected_total += 1
        else:
            non_conflicts += 1
            if detected:
                detected_false += 1
                detected_total += 1
        verdict = "tp" if expect and detected else "fn" if expect else "fp" if detected else "tn"
        case_results.append(
            {
                "description": str(case["description"]),
                "expect": expect,
                "actual": detected,
                "conflict_keys": conflict_keys,
                "verdict": verdict,
            }
        )
    detection_rate = detected_true / true_conflicts if true_conflicts else 0.0
    false_positive_rate = detected_false / non_conflicts if non_conflicts else 0.0
    precision = detected_true / detected_total if detected_total else 0.0
    metrics: dict[str, Any] = {
        "detection_rate": round(detection_rate, 4),
        "false_positive_rate": round(false_positive_rate, 4),
        "precision": round(precision, 4),
        "recall": round(detection_rate, 4),
        "case_results": case_results,
        "truncated": truncated,
    }
    _append_benchmark_record(metrics)
    return metrics


def conflict_benchmark_history(limit: int = 50) -> list[dict[str, Any]]:
    """读取最近 ``limit``（默认 50）条评测历史；无历史或读取失败返回空列表。"""
    path = _benchmark_path()
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return records[-max(1, int(limit)):]


def conflict_relation_coverage(project_id: str = "", workspace_path: str = "") -> dict[str, Any]:
    """只读查询真实库：自动检出矛盾对 vs 人工/LLM 标注的 contradicts 关系。

    - project_id 与 workspace_path 皆空 → 全局 scope（project_id/workspace_path
      均为空的 active 记忆）；否则为 workspace scope（精确匹配两者）。
    - ``coverage_rate`` = 自动检出且已被 contradicts 标注（proposed/confirmed）的对 /
      自动检出对总数；
    - ``manual_only`` = contradicts 关系中未被自动检出的对（可能需 LLM 才能发现）。

    查询异常返回 ``{"error": ...}``。
    """
    try:
        from arforge.database import Memory, MemoryRelation, get_session
    except Exception as exc:
        return {"error": f"database import failed: {exc}"}

    if not project_id and not workspace_path:
        scope = "global"
        scope_label = "global"
    else:
        scope = "workspace"
        scope_label = scope_fingerprint("workspace", project_id, workspace_path)
    try:
        with get_session() as session:
            query = session.query(Memory).filter(Memory.lifecycle == "active")
            if scope == "global":
                query = query.filter(Memory.project_id == "", Memory.workspace_path == "")
            else:
                query = query.filter(
                    Memory.project_id == str(project_id or ""),
                    Memory.workspace_path == str(workspace_path or ""),
                )
            rows = query.order_by(Memory.id.asc()).all()
            active = [
                {
                    "id": int(memory.id),
                    "content": str(memory.content),
                    "tags": str(memory.tags),
                    "project_id": str(memory.project_id or ""),
                    "workspace_path": str(memory.workspace_path or ""),
                    "scope": scope,
                }
                for memory in rows
            ]
            annotated_pairs: set[frozenset[int]] = set()
            for relation in (
                session.query(MemoryRelation)
                .filter(MemoryRelation.relation_type == "contradicts")
                .filter(MemoryRelation.status.in_(("proposed", "confirmed")))
                .all()
            ):
                annotated_pairs.add(
                    frozenset((int(relation.source_memory_id), int(relation.target_memory_id)))
                )
    except Exception as exc:
        return {"error": f"query failed: {exc}"}

    outcome = detect_claim_conflicts(active)
    auto_pairs = {frozenset((item["left_id"], item["right_id"])) for item in outcome["items"]}
    covered = auto_pairs & annotated_pairs
    manual_only = annotated_pairs - auto_pairs
    return {
        "scope": scope_label,
        "active_memories": len(active),
        "auto_detected_pairs": len(auto_pairs),
        "auto_detected": outcome["items"],
        "truncated": outcome["truncated"],
        "annotated_pairs": len(annotated_pairs),
        "covered_auto_pairs": len(covered),
        "coverage_rate": round(len(covered) / len(auto_pairs), 4) if auto_pairs else 0.0,
        "manual_only_pairs": len(manual_only),
        "manual_only": [
            {"left_id": min(pair), "right_id": max(pair)} for pair in sorted(manual_only, key=sorted)
        ],
    }
