"""Deterministic local semantic memory search.

This is intentionally embedding-free: BM25 gives a stronger local relevance
baseline than substring matching, while synonym expansion covers common user
wording differences without sending memories to an external provider.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from math import log

from arforge.memory import query_memories

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]")

_SYNONYMS: dict[str, set[str]] = {
    "bug": {"bug", "error", "failure", "fail", "issue", "crash", "错误", "失败", "异常", "崩溃", "问题"},
    "error": {"bug", "error", "failure", "fail", "issue", "crash", "错误", "失败", "异常", "崩溃", "问题"},
    "failure": {"bug", "error", "failure", "fail", "issue", "crash", "错误", "失败", "异常", "崩溃", "问题"},
    "fix": {"fix", "repair", "resolve", "patch", "debug", "修复", "解决", "补丁", "调试"},
    "repair": {"fix", "repair", "resolve", "patch", "debug", "修复", "解决", "补丁", "调试"},
    "preference": {"preference", "prefer", "like", "style", "偏好", "喜欢", "习惯", "风格"},
    "convention": {"convention", "standard", "rule", "style", "约定", "规范", "规则", "风格"},
    "workflow": {"workflow", "process", "steps", "flow", "流程", "步骤", "工作流"},
    "security": {"security", "safe", "permission", "sandbox", "安全", "权限", "沙箱"},
}

for _values in list(_SYNONYMS.values()):
    for _token in _values:
        _SYNONYMS.setdefault(_token, set()).update(_values)


def tokenize(text: str) -> list[str]:
    raw_tokens = _TOKEN_RE.findall(text.lower())
    tokens: list[str] = []
    cjk_run: list[str] = []

    def flush_cjk() -> None:
        if not cjk_run:
            return
        tokens.extend(cjk_run)
        if len(cjk_run) > 1:
            tokens.extend("".join(cjk_run[i : i + 2]) for i in range(len(cjk_run) - 1))
        cjk_run.clear()

    for token in raw_tokens:
        if _CJK_RE.fullmatch(token):
            cjk_run.append(token)
            continue
        flush_cjk()
        tokens.append(token)
    flush_cjk()
    return tokens


def expand_query_tokens(tokens: list[str]) -> dict[str, float]:
    weighted: dict[str, float] = {}
    for token in tokens:
        weighted[token] = max(weighted.get(token, 0.0), 1.0)
        for synonym in _SYNONYMS.get(token, set()):
            weighted[synonym] = max(weighted.get(synonym, 0.0), 0.65)
    return weighted


class SemanticIndex:
    def __init__(self):
        self.inverted: dict[str, set[int]] = defaultdict(set)
        self.documents: dict[int, dict] = {}
        self.doc_tokens: dict[int, Counter[str]] = {}
        self.doc_lengths: dict[int, int] = {}
        self.doc_freq: dict[str, int] = defaultdict(int)
        self.avg_doc_len: float = 0.0

    def rebuild(self):
        return self.rebuild_from_items(query_memories(lifecycle_filter="active", limit=10000))

    def rebuild_from_items(self, items: list[dict]):
        self.inverted.clear()
        self.documents.clear()
        self.doc_tokens.clear()
        self.doc_lengths.clear()
        self.doc_freq.clear()
        for item in items:
            self.documents[item["id"]] = item
            content_tokens = tokenize(item["content"])
            tag_tokens = tokenize(item.get("tags", ""))
            type_tokens = tokenize(item.get("mem_type", ""))
            weighted_tokens = content_tokens + tag_tokens * 2 + type_tokens * 2
            counts = Counter(weighted_tokens)
            self.doc_tokens[item["id"]] = counts
            self.doc_lengths[item["id"]] = sum(counts.values())
            for token in counts:
                self.inverted[token].add(item["id"])
                self.doc_freq[token] += 1
        total_length = sum(self.doc_lengths.values())
        self.avg_doc_len = total_length / max(len(self.doc_lengths), 1)
        return self

    def search(self, query: str, top_k: int = 10, min_score: float = 0.05) -> list[dict]:
        tokens = tokenize(query)
        if not tokens:
            return []
        query_terms = expand_query_tokens(tokens)
        scores: dict[int, float] = defaultdict(float)
        matched_terms: dict[int, set[str]] = defaultdict(set)
        for token, query_weight in query_terms.items():
            doc_ids = self.inverted.get(token, set())
            if not doc_ids:
                continue
            idf = log(1 + (len(self.documents) - len(doc_ids) + 0.5) / (len(doc_ids) + 0.5))
            for doc_id in self.inverted.get(token, set()):
                freq = self.doc_tokens[doc_id][token]
                doc_len = self.doc_lengths.get(doc_id, 0)
                denom = freq + 1.5 * (1 - 0.75 + 0.75 * doc_len / max(self.avg_doc_len, 1.0))
                scores[doc_id] += query_weight * idf * (freq * 2.5 / max(denom, 0.0001))
                matched_terms[doc_id].add(token)

        results = []
        for doc_id, score in scores.items():
            item = dict(self.documents[doc_id])
            importance_boost = 1 + (min(max(int(item.get("importance", 1)), 1), 5) - 1) * 0.03
            normalized = score * importance_boost / max(len(tokens), 1)
            if normalized >= min_score:
                item["score"] = normalized
                item["score_details"] = {
                    "algorithm": "bm25",
                    "matched_terms": sorted(matched_terms[doc_id]),
                    "query_terms": sorted(query_terms),
                    "importance_boost": round(importance_boost, 3),
                }
                results.append(item)
        results.sort(key=lambda item: (item["score"], item.get("importance", 0), item["id"]), reverse=True)
        return results[:top_k]


_INDEX: SemanticIndex | None = None


def get_semantic_index() -> SemanticIndex:
    global _INDEX
    if _INDEX is None:
        _INDEX = SemanticIndex().rebuild()
    return _INDEX


def rebuild_semantic_index(force: bool = True):
    global _INDEX
    if force or _INDEX is None:
        _INDEX = SemanticIndex().rebuild()
    return _INDEX


def semantic_search_memories(
    query: str,
    top_k: int = 10,
    min_score: float = 0.05,
    *,
    project_id: str | None = None,
    workspace_path: str | None = None,
    limit: int | None = None,
) -> list[dict] | dict:
    """Search local memories, returning a scoped report when scope is requested.

    The legacy positional form still returns a list. Product surfaces pass
    explicit scope fields and receive metadata suitable for a desktop client.
    """
    if project_id is None and workspace_path is None and limit is None:
        return get_semantic_index().search(query, top_k, min_score)
    scope_project = project_id or ""
    scope_workspace = workspace_path or ""
    scope_limit = limit if limit is not None else 200
    from arforge.memory_os import MemoryOS

    return MemoryOS().recall(
        query,
        project_id=scope_project,
        workspace_path=scope_workspace,
        top_k=top_k,
        min_score=min_score,
        limit=scope_limit,
    )


def _quality_query(item: dict) -> str:
    tags = item.get("tags", "").replace(",", " ")
    mem_type = item.get("mem_type", "")
    content = item.get("content", "")
    tokens = tokenize(content)
    content_probe = " ".join(tokens[:12])
    return " ".join(part for part in (tags, mem_type, content_probe) if part).strip()


def recall_quality_report(
    *,
    limit: int = 50,
    project_id: str = "",
    workspace_path: str = "",
    min_score: float = 0.01,
) -> dict:
    """Return deterministic local recall quality telemetry for memory governance.

    This is an operational BM25 self-recall smoke test, not a causal quality
    proof and not an external embedding benchmark.
    """
    items = query_memories(
        project_id=project_id,
        workspace_path=workspace_path,
        lifecycle_filter="active",
        limit=limit,
    )
    index = SemanticIndex().rebuild_from_items(items)
    evaluated = 0
    top1_hits = 0
    reciprocal_rank_total = 0.0
    no_result = 0
    examples: list[dict] = []

    for item in items:
        query = _quality_query(item)
        if not query:
            continue
        evaluated += 1
        results = index.search(query, top_k=min(10, max(len(items), 1)), min_score=min_score)
        if not results:
            no_result += 1
            rank = None
        else:
            rank = next((position for position, result in enumerate(results, start=1) if result["id"] == item["id"]), None)
            if rank == 1:
                top1_hits += 1
            if rank is not None:
                reciprocal_rank_total += 1.0 / rank
        if len(examples) < 5:
            examples.append(
                {
                    "memory_id": item["id"],
                    "query": query[:240],
                    "rank": rank,
                    "top_score": round(float(results[0]["score"]), 4) if results else 0.0,
                    "matched_terms": results[0].get("score_details", {}).get("matched_terms", [])[:8] if results else [],
                }
            )

    return {
        "schema_version": 1,
        "algorithm": "bm25_self_recall",
        "scope": {
            "project_id": project_id,
            "workspace_path": workspace_path,
            "limit": limit,
            "min_score": min_score,
        },
        "indexed": len(items),
        "evaluated": evaluated,
        "top1_hits": top1_hits,
        "top1_hit_rate": round(top1_hits / evaluated, 4) if evaluated else 0.0,
        "mrr": round(reciprocal_rank_total / evaluated, 4) if evaluated else 0.0,
        "no_result": no_result,
        "examples": examples,
        "note": "Operational BM25 self-recall baseline; not an external embedding benchmark.",
    }
