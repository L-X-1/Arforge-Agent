"""上下文 token 估算（CC-1）—— 共享工具。

供自动压缩触发判断（compaction）与子 Agent 预算检查（sub_agent）复用，消除重复实现。
近似估算：CJK ≈ 1 token/字，其余 ≈ 1 token/4 字符（保守上界即可）；后续若接入真实
tokenizer 只需替换本模块。
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

_CJK = re.compile(r"[一-鿿]")
_BRACKET_WINDOW = re.compile(r"\[(\d+(?:\.\d+)?)\s*([kKmM])\]")


@dataclass(frozen=True)
class ContextWindow:
    """Resolved model context capacity with a user-visible provenance."""

    tokens: int
    source: str


def resolve_context_window(model_name: str, configured_tokens: int | None = None) -> ContextWindow:
    """Resolve the active model's context window without provider calls.

    Known models use the verified product catalog, so switching models always
    updates to that model's actual capacity. Explicit values are reserved for
    custom compatible models. Such models may also declare their capacity in
    the model id (for example ``model[1m]``). Unknown models fall back
    conservatively.
    """
    normalized = str(model_name or "").strip()
    try:
        import config

        known = int(getattr(config, "MODEL_CONTEXT_WINDOW", {}).get(normalized, 0) or 0)
    except Exception:
        known = 0
    if known >= 4096:
        return ContextWindow(known, "catalog")
    if isinstance(configured_tokens, int) and not isinstance(configured_tokens, bool) and configured_tokens >= 4096:
        return ContextWindow(configured_tokens, "configured")
    match = _BRACKET_WINDOW.search(normalized)
    if match:
        multiplier = 1_000 if match.group(2).casefold() == "k" else 1_000_000
        inferred = int(float(match.group(1)) * multiplier)
        if 4_096 <= inferred <= 10_000_000:
            return ContextWindow(inferred, "model_name")
    return ContextWindow(65_536, "fallback")


def estimate_text_tokens(text: str) -> int:
    """估算单段文本的 token 数。"""
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    rest = len(_CJK.sub("", text))
    return cjk + max(0, rest // 4)


def estimate_messages_tokens(messages: list) -> int:
    """估算整个消息数组的 token 数（含 role 结构开销与 tool_calls 参数）。"""
    total = 0
    for m in messages or []:
        if not isinstance(m, dict):
            total += estimate_text_tokens(str(m))
            continue
        total += 4  # 每条消息的结构/角色开销近似
        total += estimate_text_tokens(str(m.get("content") or ""))
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
            total += estimate_text_tokens(str(fn.get("name", "")) + str(fn.get("arguments", "")))
    return total


def normalize_usage(usage: Any) -> dict[str, int]:
    """Normalize provider usage objects/dicts into non-negative token counts."""
    result: dict[str, int] = {}
    for name in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(name, 0) if isinstance(usage, dict) else getattr(usage, name, 0)
        try:
            result[name] = max(0, int(value or 0))
        except (TypeError, ValueError):
            result[name] = 0
    if not result["total_tokens"]:
        result["total_tokens"] = result["prompt_tokens"] + result["completion_tokens"]
    return result


def resolve_context_budget(
    window_tokens: int,
    *,
    requested_reserve: int | None = None,
    threshold: float | None = None,
) -> dict[str, int]:
    """Return one canonical input/output budget for meters and compaction.

    A configured output limit can exceed a small custom model's whole context
    window. Capping the reserve proportionally avoids the previous behavior
    where any non-empty conversation triggered compaction immediately.
    """
    window = max(4_096, int(window_tokens or 0))
    if requested_reserve is None or threshold is None:
        try:
            import config

            if requested_reserve is None:
                requested_reserve = int(getattr(config, "CHAT_MAX_TOKENS", 16_384))
            if threshold is None:
                threshold = float(getattr(config, "COMPACT_THRESHOLD", 0.85))
        except Exception:
            requested_reserve = 16_384 if requested_reserve is None else requested_reserve
            threshold = 0.85 if threshold is None else threshold
    reserve = min(max(1_024, int(requested_reserve)), max(1_024, window // 4))
    usable = max(1, window - reserve)
    compact_at = max(1, int(usable * min(0.98, max(0.5, float(threshold)))))
    return {
        "reserved_output_tokens": reserve,
        "usable_input_tokens": usable,
        "compact_at_tokens": compact_at,
    }


def build_context_status(
    messages: list,
    model_name: str,
    *,
    configured_tokens: int | None = None,
    usage: Any = None,
    usage_message_tokens: int | None = None,
    memory_tokens: int = 0,
    compaction_count: int = 0,
    last_compaction: dict[str, Any] | None = None,
    cumulative_prompt_tokens: int = 0,
    cumulative_completion_tokens: int = 0,
    provider_call_count: int = 0,
    compacted_tokens_total: int = 0,
    checkpoint_restored: bool = False,
    compaction_history_complete: bool = True,
) -> dict[str, Any]:
    """Build the canonical current-conversation meter shared by Bridge/Desktop.

    Provider usage describes one completed request. The desktop meter instead
    represents the active primary conversation window. Anchor that window to
    the provider's exact prompt count at the last primary call, then apply the
    locally estimated token delta for tool results/messages added afterwards.
    """
    window = resolve_context_window(model_name, configured_tokens)
    estimated = estimate_messages_tokens(messages)
    normalized = normalize_usage(usage)
    exact_prompt = normalized["prompt_tokens"]
    baseline_estimate = (
        max(0, int(usage_message_tokens))
        if usage_message_tokens is not None
        else estimated
    )
    if exact_prompt > 0:
        used = max(0, exact_prompt + estimated - baseline_estimate)
        count_source = "provider_calibrated"
    else:
        used = estimated
        count_source = "estimated"
    # Keep output headroom proportional on small windows but never report a
    # negative usable budget on custom configurations.
    budget = resolve_context_budget(window.tokens)
    reserve = budget["reserved_output_tokens"]
    usable = budget["usable_input_tokens"]
    percent = min(100.0, max(0.0, used * 100.0 / window.tokens))
    compact_at = budget["compact_at_tokens"]
    payload = {
        "schema_version": 3,
        "model": str(model_name or ""),
        "context_window_tokens": window.tokens,
        "window_source": window.source,
        "used_tokens": used,
        "usage_percent": round(percent, 1),
        "usage_kind": "conversation",
        "conversation_usage_source": count_source,
        "conversation_tokens": used,
        "estimated_tokens": estimated,
        "last_prompt_tokens": exact_prompt,
        "current_input_tokens": used,
        "remaining_input_tokens": max(0, usable - used),
        "tokens_until_compaction": max(0, compact_at - used),
        "reserved_output_tokens": reserve,
        "usable_input_tokens": usable,
        "compact_at_tokens": compact_at,
        "memory_tokens": max(0, int(memory_tokens or 0)),
        "message_count": len(messages or []),
        "compaction_count": max(0, int(compaction_count or 0)),
        "cumulative_prompt_tokens": max(0, int(cumulative_prompt_tokens or 0)),
        "cumulative_completion_tokens": max(
            0, int(cumulative_completion_tokens or 0)
        ),
        "provider_call_count": max(0, int(provider_call_count or 0)),
        "compacted_tokens_total": max(0, int(compacted_tokens_total or 0)),
        "checkpoint_restored": bool(checkpoint_restored),
        "compaction_history_complete": bool(compaction_history_complete),
        "auto_compact_enabled": True,
        "last_compaction": dict(last_compaction or {}),
    }
    return payload
