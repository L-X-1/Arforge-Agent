"""可观测层 — Span 树 + token/成本/延迟（P1-8）。

为 Agent 的每一步（LLM 调用 / 工具调用 / 子任务）生成带层级的 span，汇总
token、成本(￥)、延迟，可导出 JSON（字段命名对齐 OpenTelemetry/Langfuse 习惯）。
提供两种埋点 API：上下文管理器 `with tracer.span(...)` 与显式 `start_span/end_span`，
后者便于在已有循环里低侵入埋点。线程安全（thread-local 当前 span 栈）。
"""

from __future__ import annotations

import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field


@dataclass
class Span:
    name: str
    span_id: str
    parent_id: str | None
    start: float
    end: float | None = None
    attributes: dict = field(default_factory=dict)
    status: str = "ok"  # ok | error
    children: list = field(default_factory=list)  # list[Span]

    @property
    def duration_ms(self) -> float:
        return round((self.end - self.start) * 1000, 3) if self.end is not None else 0.0

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "span_id": self.span_id,
            "parent_id": self.parent_id,
            "duration_ms": self.duration_ms,
            "status": self.status,
            "attributes": self.attributes,
            "children": [c.to_dict() for c in self.children],
        }


# 模型单价（￥ / 1k tokens）。缓存命中价远低于普通输入，体现 DeepSeek 缓存收益。
_PRICING = {
    "deepseek-chat": {"prompt": 0.002, "completion": 0.008, "cache_hit": 0.0005},
    "deepseek-reasoner": {"prompt": 0.004, "completion": 0.016, "cache_hit": 0.001},
    "deepseek-v4-flash": {"prompt": 0.001, "completion": 0.004, "cache_hit": 0.00025},
}


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int, cache_hit_tokens: int = 0) -> float:
    """按模型单价估算单次调用成本(￥)；未知模型返回 0。"""
    price = _PRICING.get(model)
    if not price:
        return 0.0
    non_cached = max(0, prompt_tokens - cache_hit_tokens)
    cost = (
        non_cached / 1000 * price["prompt"]
        + cache_hit_tokens / 1000 * price.get("cache_hit", price["prompt"])
        + completion_tokens / 1000 * price["completion"]
    )
    return round(cost, 6)


class Tracer:
    """单次运行的追踪器（建议每次 agent 运行新建一个，避免跨运行污染）。"""

    def __init__(self):
        self._local = threading.local()
        self.root: Span | None = None

    @property
    def _stack(self) -> list:
        if not hasattr(self._local, "stack"):
            self._local.stack = []
        return self._local.stack

    @property
    def current(self) -> Span | None:
        return self._stack[-1] if self._stack else None

    def start_span(self, name: str, **attributes) -> Span:
        parent = self.current
        sp = Span(
            name=name,
            span_id=uuid.uuid4().hex[:12],
            parent_id=parent.span_id if parent else None,
            start=time.perf_counter(),
            attributes=dict(attributes),
        )
        if parent is not None:
            parent.children.append(sp)
        else:
            self.root = sp
        self._stack.append(sp)
        return sp

    def end_span(self, span: Span, status: str | None = None) -> None:
        span.end = time.perf_counter()
        if status:
            span.status = status
        # 容错：仅当 span 在栈顶时弹出（防嵌套错配导致栈错乱）
        if self._stack and self._stack[-1] is span:
            self._stack.pop()

    @contextmanager
    def span(self, name: str, **attributes):
        sp = self.start_span(name, **attributes)
        try:
            yield sp
        except Exception as exc:
            sp.status = "error"
            sp.attributes["error"] = str(exc)
            self.end_span(sp)
            raise
        else:
            self.end_span(sp)

    @staticmethod
    def record_llm(span: Span, *, model: str, prompt_tokens: int, completion_tokens: int, cache_hit_tokens: int = 0) -> None:
        """在 span 上记录一次 LLM 调用的 token/成本。"""
        span.attributes.update(
            {
                "kind": "llm",
                "model": model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
                "cache_hit_tokens": cache_hit_tokens,
                "cost_cny": estimate_cost(model, prompt_tokens, completion_tokens, cache_hit_tokens),
            }
        )


def aggregate(span: Span) -> dict:
    """递归汇总 span 树：token、成本、延迟、各类计数、缓存命中率。"""
    agg = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cache_hit_tokens": 0,
        "cost_cny": 0.0,
        "llm_calls": 0,
        "tool_calls": 0,
        "errors": 0,
    }

    def walk(s: Span) -> None:
        attr = s.attributes
        if attr.get("kind") == "llm" or "model" in attr:
            agg["llm_calls"] += 1
            agg["prompt_tokens"] += attr.get("prompt_tokens", 0)
            agg["completion_tokens"] += attr.get("completion_tokens", 0)
            agg["total_tokens"] += attr.get("total_tokens", 0)
            agg["cache_hit_tokens"] += attr.get("cache_hit_tokens", 0)
            agg["cost_cny"] += attr.get("cost_cny", 0.0)
        if s.name.startswith("tool."):
            agg["tool_calls"] += 1
        if s.status == "error":
            agg["errors"] += 1
        for child in s.children:
            walk(child)

    walk(span)
    agg["cost_cny"] = round(agg["cost_cny"], 6)
    agg["duration_ms"] = span.duration_ms
    agg["cache_hit_rate"] = (
        round(agg["cache_hit_tokens"] / agg["prompt_tokens"], 4) if agg["prompt_tokens"] else 0.0
    )
    return agg
