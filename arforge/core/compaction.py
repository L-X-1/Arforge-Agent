"""上下文自动压缩（CC-2 压缩器 + CC-3 触发）。

策略：保留 system + 首个用户任务 + 最近若干完整"轮"；把中间较旧的完整轮用 LLM 摘要成一条
"【历史摘要】"消息。严守 function-calling 协议：assistant(tool_calls) 与其 tool 响应作为一个不可分割的
"轮"，压缩绝不切断配对。复用 memory_vector.compress_memories 做摘要。

接入：auto_compact_hook 挂 PRE_LLM_CALL —— 估算超阈值（或被 compact_context 工具强制）即压缩，
原地替换 messages 并发 PRE/POST_COMPACT 事件。压缩任何失败都返回原 messages（绝不破坏历史）。
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import hashlib
import json
import re

import config
from arforge.core.context import estimate_messages_tokens, resolve_context_budget
from arforge.core.hooks import HookContext, HookDecision, HookEvent, get_hook_manager

_SUMMARY_PREFIX = "【历史摘要】"
_KEY_FACTS_PREFIX = "【关键事实】"
_WRITE_TOOLS = {"write_file", "edit_file", "create_file", "delete_file", "apply_patch_batch", "write_docx"}

# Cache-preservation state must be local to one logical execution.  A module-global
# counter lets one session suppress compaction in another session whose loop has
# just started at step 1.
@dataclass
class _CompactionState:
    last_compact_step: int = 0
    last_seen_step: int = 0
    force_pending: bool = False
    count: int = 0
    last_stats: dict | None = None


_COMPACTION_STATE: ContextVar[_CompactionState | None] = ContextVar(
    "arforge_compaction_state",
    default=None,
)
_COMPACT_MIN_INTERVAL_STEPS: int = 10
_CONSTRAINT_MARKERS = (
    "必须",
    "不要",
    "不能",
    "禁止",
    "务必",
    "永远",
    "硬约束",
    "要求",
    "不得",
    "must",
    "must not",
    "never",
    "do not",
    "don't",
    "require",
)
_VERIFY_MARKERS = (
    "passed",
    "pass",
    "all checks passed",
    "tests passed",
    "通过",
    "成功",
    "验证",
    "pytest",
    "ruff",
    "npm run",
    "typecheck",
    "failed",
    "tests failed",
    "build failed",
)
_DECISION_MARKERS = (
    "架构决定", "技术决定", "决定采用", "决定使用", "选定", "选用", "采用",
    "architecture decision", "technical decision", "decided to", "decision:",
)
_PENDING_MARKERS = (
    "待办", "未完成", "下一步", "尚需", "仍需", "todo", "pending", "remaining work", "still need",
)
_PREFERENCE_MARKERS = (
    "偏好", "更喜欢", "习惯", "默认使用", "prefer", "preference", "always use", "by default",
)
_IDENTITY_MARKERS = (
    "联系人", "负责人", "项目负责人", "名字是", "叫做", "contact is", "owner is", "named ",
)
_CONFIG_MARKERS = (
    "关键配置", "运行配置", "端口", "超时", "版本", "配置为", "runtime config", "service port", "port:", "port=", "port is", "timeout", "version ",
)
_DURABLE_CONSTRAINT_SIGNALS = (
    "长期", "以后", "今后", "始终", "总是", "每次", "默认", "项目约定", "项目规范", "仓库约定",
    "remember", "from now on", "always", "every time", "by default", "project convention",
)
_MAX_KEY_FACTS = 120
_ERROR_MARKERS = (
    "traceback",
    "error:",
    "exception",
    "failed",
    "failure",
    "assertionerror",
    "syntaxerror",
    "nameerror",
    "importerror",
    "exit code",
    "报错",
    "失败",
)


def estimate_window(model_name: str, configured_tokens: int | None = None) -> int:
    from arforge.core.context import resolve_context_window

    return resolve_context_window(model_name, configured_tokens).tokens


def needs_compaction(messages: list, model_name: str, configured_tokens: int | None = None) -> bool:
    """估算消息总 token 是否超过 (窗口 - 输出预留) * 阈值。"""
    window = estimate_window(model_name, configured_tokens)
    budget = resolve_context_budget(window)
    return estimate_messages_tokens(messages) > budget["compact_at_tokens"]


def _rounds(messages: list, start: int) -> list[tuple[int, int]]:
    """把 messages[start:] 切成"轮"：assistant(tool_calls)+随后的 tool 消息为一个不可分割轮；
    其余每条消息各自成轮。保证压缩边界永远落在轮之间，不切断 tool_call/响应配对。"""
    rounds: list[tuple[int, int]] = []
    i, n = start, len(messages)
    while i < n:
        msg = messages[i] if isinstance(messages[i], dict) else {}
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            j = i + 1
            while j < n and isinstance(messages[j], dict) and messages[j].get("role") == "tool":
                j += 1
            rounds.append((i, j))
            i = j
        else:
            rounds.append((i, i + 1))
            i += 1
    return rounds


def _msg_to_text(msg: dict) -> str:
    if not isinstance(msg, dict):
        return str(msg)
    role = msg.get("role", "?")
    content = str(msg.get("content") or "")
    if msg.get("tool_calls"):
        names = ", ".join(
            (tc.get("function", {}) or {}).get("name", "?")
            for tc in msg["tool_calls"]
            if isinstance(tc, dict)
        )
        content = (content + f" [调用工具: {names}]").strip()
    if role == "tool":
        content = "工具结果: " + content[:500]
    return f"{role}: {content}"


def _shorten(value: str, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _add_fact(facts: list[str], seen: set[str], label: str, value: str) -> None:
    text = _shorten(value)
    if not text:
        return
    rendered = f"{label}: {text}"
    key = rendered.lower()
    if key not in seen:
        seen.add(key)
        facts.append(rendered)


def _matching_snippet(value: str, markers: tuple[str, ...], *, limit: int = 320) -> str:
    """Return the marker-bearing sentences instead of an arbitrary text prefix."""
    text = str(value or "")
    parts = [part.strip() for part in re.split(r"(?:\r?\n)+|(?<=[。！？.!?；;])\s*", text) if part.strip()]
    matched = [part for part in parts if any(marker in part.casefold() for marker in markers)]
    return _shorten(" ".join(matched[:3]) if matched else text, limit)


def _verification_evidence(value: str) -> str:
    """Keep test/check commands together with terminal pass/fail summaries.

    Tool output is commonly thousands of lines long and the verdict is usually
    at the end. Prefix truncation therefore destroys the one line that matters.
    """
    lines = [re.sub(r"\s+", " ", line).strip() for line in str(value or "").splitlines() if line.strip()]
    if not lines:
        return ""
    command = next(
        (line for line in lines if any(marker in line.casefold() for marker in ("pytest", "npm run", "ruff", "typecheck"))),
        "",
    )
    verdict_patterns = (
        re.compile(r"\b\d+\s+(?:passed|failed|errors?|skipped|warnings?)\b", re.IGNORECASE),
        re.compile(r"\b(?:all checks passed|build succeeded|tests? passed)\b", re.IGNORECASE),
        re.compile(r"(?:通过|失败|成功|错误)"),
    )
    verdict = next(
        (line for line in reversed(lines) if any(pattern.search(line) for pattern in verdict_patterns)),
        "",
    )
    # Verdict comes first so a very long command line cannot push it beyond the
    # final bounded fact length.
    selected = [item for item in (verdict, command) if item]
    if not selected:
        selected = [_matching_snippet(value, _VERIFY_MARKERS)]
    return _shorten(" | ".join(dict.fromkeys(selected)), 400)


def _existing_key_facts(value: str) -> list[str]:
    text = str(value or "")
    if not text.startswith(_KEY_FACTS_PREFIX):
        return []
    facts: list[str] = []
    for line in text[len(_KEY_FACTS_PREFIX):].splitlines():
        cleaned = line.strip()
        if cleaned.startswith("- "):
            cleaned = cleaned[2:].strip()
        if cleaned:
            facts.append(cleaned)
    return facts


def _tool_args(tool_call: dict) -> dict:
    raw = ((tool_call.get("function") or {}).get("arguments") or "{}")
    try:
        args = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return args if isinstance(args, dict) else {}


def _changed_files_from_tracker() -> list[str]:
    try:
        from arforge.core.change_tracker import get_change_tracker

        return get_change_tracker().changed()
    except Exception:  # noqa: BLE001 - compaction must never fail because tracking is unavailable
        return []


def _changed_files_from_messages(messages: list) -> list[str]:
    files: list[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        for tool_call in msg.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            fn = tool_call.get("function") or {}
            name = str(fn.get("name") or "")
            if name not in _WRITE_TOOLS:
                continue
            args = _tool_args(tool_call)
            filename = args.get("filename") or args.get("path") or args.get("file_path") or args.get("file")
            if filename:
                if name == "write_docx" and "." not in str(filename).rsplit("/", 1)[-1].rsplit("\\", 1)[-1]:
                    filename = f"{filename}.docx"
                files.append(str(filename))
    return files


def _error_fingerprint(text: str) -> str | None:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    marker_line = ""
    for line in reversed(lines):
        low = line.lower()
        if any(marker in low for marker in _ERROR_MARKERS):
            marker_line = line
            break
    if not marker_line and any(marker in str(text).lower() for marker in _ERROR_MARKERS):
        marker_line = _shorten(text, 180)
    if not marker_line:
        return None
    normalized = re.sub(r"\s+", " ", marker_line).strip()
    digest = hashlib.sha1(normalized.encode("utf-8", errors="replace")).hexdigest()[:10]
    return f"{digest} {normalized}"


def extract_key_facts(messages: list) -> list[str]:
    """Extract deterministic facts that must survive compaction outside the LLM summary.

    The returned lines are intentionally short and whitelist-based: constraints,
    decisions, preferences, configuration, TODOs, changed files, verified checks,
    and error fingerprints.
    """
    facts: list[str] = []
    seen: set[str] = set()

    # A prior compaction checkpoint is authoritative short-term state. Carry it
    # forward verbatim before extracting new facts so repeated compression can
    # never silently demote an old hard constraint back into probabilistic LLM
    # prose.
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        for fact in _existing_key_facts(str(msg.get("content") or "")):
            key = fact.casefold()
            if key not in seen:
                seen.add(key)
                facts.append(fact)

    changed = []
    changed.extend(_changed_files_from_tracker())
    changed.extend(_changed_files_from_messages(messages))
    if changed:
        ordered = []
        for filename in changed:
            if filename and filename not in ordered:
                ordered.append(filename)
        _add_fact(facts, seen, "改过的文件", ", ".join(ordered[:20]))

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = str(msg.get("content") or "")
        if not content:
            continue
        if content.startswith((_KEY_FACTS_PREFIX, _SUMMARY_PREFIX)):
            continue
        low = content.lower()
        role = msg.get("role")
        if role == "user" and any(marker in low for marker in _CONSTRAINT_MARKERS):
            _add_fact(facts, seen, "用户硬约束", _matching_snippet(content, _CONSTRAINT_MARKERS))
        if role in {"user", "assistant"} and any(marker in low for marker in _DECISION_MARKERS):
            _add_fact(facts, seen, "架构决定", _matching_snippet(content, _DECISION_MARKERS))
        if role == "user" and any(marker in low for marker in _PREFERENCE_MARKERS):
            _add_fact(facts, seen, "用户偏好", _matching_snippet(content, _PREFERENCE_MARKERS))
        if role == "user" and any(marker in low for marker in _IDENTITY_MARKERS):
            _add_fact(facts, seen, "身份信息", _matching_snippet(content, _IDENTITY_MARKERS))
        if role in {"user", "assistant"} and any(marker in low for marker in _CONFIG_MARKERS):
            _add_fact(facts, seen, "关键配置", _matching_snippet(content, _CONFIG_MARKERS))
        if role in {"user", "assistant"} and any(marker in low for marker in _PENDING_MARKERS):
            _add_fact(facts, seen, "待办事项", _matching_snippet(content, _PENDING_MARKERS))
        if role == "tool" and any(marker in low for marker in _VERIFY_MARKERS):
            _add_fact(facts, seen, "已验证测试", _verification_evidence(content))
        fingerprint = _error_fingerprint(content)
        if fingerprint:
            _add_fact(facts, seen, "错误指纹", fingerprint)

    return facts


def _key_facts_message(facts: list[str]) -> dict | None:
    if not facts:
        return None
    body = "\n".join(f"- {fact}" for fact in facts[:_MAX_KEY_FACTS])
    return {"role": "assistant", "content": f"{_KEY_FACTS_PREFIX}\n{body}"}


def classify_compaction_fact(fact: str) -> dict[str, object]:
    """Assign one extracted fact to the short-term or durable workspace tier."""
    label, separator, value = str(fact or "").partition(": ")
    durable_types = {
        "架构决定": ("convention", 4, "explicit_project_decision"),
        "用户偏好": ("preference", 4, "stable_workspace_preference"),
        "身份信息": ("identity", 4, "workspace_identity"),
        "关键配置": ("convention", 4, "explicit_runtime_configuration"),
    }
    memory_spec = durable_types.get(label)
    if label == "用户硬约束" and any(signal in value.casefold() for signal in _DURABLE_CONSTRAINT_SIGNALS):
        memory_spec = ("constraint", 5, "explicit_durable_constraint")
    if separator and value and memory_spec is not None:
        mem_type, importance, reason = memory_spec
        return {
            "tier": "long_term",
            "label": label,
            "content": value,
            "mem_type": mem_type,
            "importance": importance,
            "reason": reason,
        }
    return {
        "tier": "short_term",
        "label": label or "事实",
        "content": value if separator else str(fact or ""),
        "mem_type": "context",
        "importance": 3,
        "reason": "operational_or_transient",
    }


def _prioritize_key_facts(facts: list[str]) -> list[str]:
    priorities = {
        "用户硬约束": 0,
        "架构决定": 1,
        "用户偏好": 1,
        "身份信息": 1,
        "关键配置": 1,
        "待办事项": 2,
        "改过的文件": 3,
        "已验证测试": 3,
        "错误指纹": 3,
    }
    indexed = list(enumerate(facts))
    indexed.sort(key=lambda item: (priorities.get(item[1].partition(": ")[0], 4), item[0]))
    return [fact for _index, fact in indexed]


def _persist_durable_facts(facts: list[str]) -> int:
    """Persist only stable workspace knowledge; keep operational state short-term."""
    from pathlib import Path

    from arforge.auto_memory import workspace_memory_scope
    from arforge.database import init_db
    from arforge.memory import save_memory_v2
    from arforge.workspace_context import current_session_id, current_workspace

    project_id, workspace_path = workspace_memory_scope(current_workspace(Path.cwd()))
    init_db()
    saved = 0
    for fact in facts:
        policy = classify_compaction_fact(fact)
        if policy["tier"] != "long_term":
            # Changed files, test/error evidence and pending work are current-run
            # state. Persisting them globally creates stale or misleading recall.
            continue
        mem_type = str(policy["mem_type"])
        importance = int(policy["importance"])
        memory_id = save_memory_v2(
            content=str(policy["content"]),
            mem_type=mem_type,
            tags=f"compaction,durable,{mem_type},governed",
            importance=importance,
            source="compaction",
            related_to=current_session_id(),
            dedupe=True,
            project_id=project_id,
            workspace_path=workspace_path,
        )
        if memory_id is not None:
            saved += 1
    return saved


def compact(
    messages: list,
    adapter,
    model_name: str,
    *,
    keep_recent: int = 6,
    persist_durable: bool = False,
    custom_focus: str = "",
) -> tuple[list, dict]:
    """压缩 messages。返回 (新messages, stats)。失败/无可压缩时原样返回（绝不破坏历史）。"""
    before = estimate_messages_tokens(messages)
    stats = {
        "compacted": False,
        "before_tokens": before,
        "after_tokens": before,
        "summarized_msgs": 0,
        "key_facts": 0,
        "key_facts_dropped": 0,
        "protected_facts_preserved": 0,
        "quality_score": 0.0,
        "short_term_facts": 0,
        "long_term_candidates": 0,
        "long_term_memories_saved": 0,
    }
    if not messages:
        return messages, stats

    # head：前导 system + 首个 user 任务（始终保留）
    head_end = 0
    while head_end < len(messages) and isinstance(messages[head_end], dict) and messages[head_end].get("role") == "system":
        head_end += 1
    if head_end < len(messages) and isinstance(messages[head_end], dict) and messages[head_end].get("role") == "user":
        head_end += 1

    rounds = _rounds(messages, head_end)
    if len(rounds) <= 1:
        return messages, stats  # 没有可摘要的中段

    # 选尾部：覆盖 >= keep_recent 条消息的最少尾轮；确保中段至少留一轮可摘要
    tail_round_idx = len(rounds)
    count = 0
    for k in range(len(rounds) - 1, -1, -1):
        count += rounds[k][1] - rounds[k][0]
        tail_round_idx = k
        if count >= keep_recent:
            break
    if tail_round_idx <= 0:
        return messages, stats  # 全是尾部，无中段可压

    tail_start = rounds[tail_round_idx][0]
    head = messages[:head_end]
    middle = messages[head_end:tail_start]
    tail = messages[tail_start:]

    # 幂等：中段若仅由既有关键事实/摘要消息组成，不再二次摘要
    if middle and all(
        isinstance(item, dict)
        and str(item.get("content", "")).startswith((_KEY_FACTS_PREFIX, _SUMMARY_PREFIX))
        for item in middle
    ):
        return messages, stats

    from arforge.memory_vector import compress_memories

    summary_text = compress_memories(
        adapter,
        [_msg_to_text(m) for m in middle],
        max_input_chars=max(6_000, min(250_000, estimate_window(model_name) // 2)),
        focus=custom_focus,
    )
    if not summary_text or summary_text.startswith("[记忆压缩失败"):
        return messages, stats  # 压缩失败 → 不替换真实历史

    summary_msg = {"role": "assistant", "content": _SUMMARY_PREFIX + summary_text}
    all_key_facts = _prioritize_key_facts(extract_key_facts(middle))
    key_facts = all_key_facts[:_MAX_KEY_FACTS]
    tier_policies = [classify_compaction_fact(fact) for fact in key_facts]
    key_msg = _key_facts_message(key_facts)
    preserved = [key_msg] if key_msg is not None else []
    new_messages = head + preserved + [summary_msg] + tail
    after = estimate_messages_tokens(new_messages)
    if before >= 1_000 and after >= before:
        return messages, stats
    rendered_checkpoint = str(key_msg.get("content", "")) if key_msg is not None else ""
    protected = sum(fact in rendered_checkpoint for fact in key_facts)
    if protected != len(key_facts) or head != new_messages[:len(head)] or tail != new_messages[-len(tail):]:
        return messages, stats
    long_term_saved = 0
    if persist_durable and key_facts:
        try:
            long_term_saved = _persist_durable_facts(key_facts)
        except Exception:  # noqa: BLE001 - persistence must never corrupt short-term context
            long_term_saved = 0
    stats.update({
        "compacted": True,
        "after_tokens": after,
        "summarized_msgs": len(middle),
        "key_facts": len(key_facts),
        "key_facts_dropped": max(0, len(all_key_facts) - len(key_facts)),
        "protected_facts_preserved": protected,
        "quality_score": 1.0 if not key_facts else round(protected / len(key_facts), 3),
        "short_term_facts": sum(item["tier"] == "short_term" for item in tier_policies),
        "long_term_candidates": sum(item["tier"] == "long_term" for item in tier_policies),
        "long_term_memories_saved": long_term_saved,
    })
    return new_messages, stats


# ---------------------------------------------------------------------------
# 手动 / LLM 强制触发
# ---------------------------------------------------------------------------

@contextmanager
def compaction_scope():
    """Bind compaction bookkeeping to one logical agent execution.

    Desktop sessions enter this scope through ``execution_scope``. The
    ContextVar also keeps independently running CLI or worker threads isolated.
    Restoring the previous value makes nested scopes safe for sub-agent work.
    """
    token = _COMPACTION_STATE.set(_CompactionState())
    try:
        yield
    finally:
        _COMPACTION_STATE.reset(token)


def _step_from_context(ctx) -> int:
    raw_step = (getattr(ctx, "metadata", None) or {}).get("step", 0)
    if isinstance(raw_step, int) and not isinstance(raw_step, bool) and raw_step > 0:
        return raw_step
    return 0


def _state_for_context(ctx) -> _CompactionState:
    """Return current execution state and discard stale sequential run state.

    Tool loops start each fresh execution at step 1. This fallback protects
    callers that do not install an explicit scope while retaining state across
    turns of one loop.
    """
    state = _COMPACTION_STATE.get()
    step = _step_from_context(ctx)
    if state is None or (step == 1 and state.last_seen_step > 0):
        state = _CompactionState()
        _COMPACTION_STATE.set(state)
    if step:
        state.last_seen_step = max(state.last_seen_step, step)
    return state


def request_force_compact() -> None:
    """请求在下一次 PRE_LLM_CALL 时强制压缩（供 compact_context 工具 / 手动调用）。"""
    state = _COMPACTION_STATE.get()
    if state is None:
        state = _CompactionState()
        _COMPACTION_STATE.set(state)
    state.force_pending = True


def current_compaction_stats() -> dict:
    """Return compaction telemetry for the active execution scope."""
    state = _COMPACTION_STATE.get()
    if state is None:
        return {"count": 0, "last_compaction": {}}
    return {
        "count": state.count,
        "last_compaction": dict(state.last_stats or {}),
    }


def _consume_force_compact(state: _CompactionState) -> bool:
    forced = state.force_pending
    state.force_pending = False
    return forced


# ---------------------------------------------------------------------------
# CC-3 —— PRE_LLM_CALL 自动压缩 handler
# ---------------------------------------------------------------------------


def auto_compact_hook(ctx) -> HookDecision | None:
    """挂在 PRE_LLM_CALL：超阈值或被强制时压缩，原地替换 messages，并发 PRE/POST_COMPACT。"""
    if not getattr(config, "AUTO_COMPACT_ENABLED", True):
        return None
    messages = ctx.messages
    if not messages:
        return None
    adapter = (ctx.metadata or {}).get("adapter")
    model = getattr(adapter, "model_name", None) or getattr(config, "DEEPSEEK_MODEL", "deepseek-v4-flash")

    state = _state_for_context(ctx)
    forced = _consume_force_compact(state)
    configured_window = getattr(adapter, "context_window_tokens", None) if adapter is not None else None
    over_budget = (
        needs_compaction(messages, model, configured_window)
        if configured_window is not None
        else needs_compaction(messages, model)
    )
    if not forced and not over_budget:
        return None

    # Cache-preservation: don't compact too frequently — each compaction
    # restructures messages and breaks DeepSeek prompt cache prefix.
    step = _step_from_context(ctx)
    if not forced and step > 0 and state.last_compact_step > 0:
        if step - state.last_compact_step < _COMPACT_MIN_INTERVAL_STEPS:
            return None  # too soon, skip to preserve cache

    if adapter is None:
        return None  # 无 adapter 无法摘要

    mgr = get_hook_manager()
    mgr.fire(HookContext(HookEvent.PRE_COMPACT, messages=messages, tracer=ctx.tracer, metadata={"model": model}))
    new_messages, stats = compact(messages, adapter, model, persist_durable=True)
    if not stats.get("compacted"):
        return None
    compact_metadata = {
        **stats,
        "task": str((ctx.metadata or {}).get("task", "") or ""),
        "user_input": str((ctx.metadata or {}).get("user_input", "") or ""),
    }
    mgr.fire(
        HookContext(
            HookEvent.POST_COMPACT,
            messages=new_messages,
            tracer=ctx.tracer,
            metadata=compact_metadata,
        )
    )
    state.last_compact_step = step
    state.count += 1
    state.last_stats = dict(stats)
    return HookDecision.modify(new_messages=new_messages)


def install_compaction_hook():
    """把 auto_compact_hook 幂等注册到 PRE_LLM_CALL（priority=50）。"""
    mgr = get_hook_manager()
    mgr.unregister(HookEvent.PRE_LLM_CALL, auto_compact_hook)
    mgr.register(HookEvent.PRE_LLM_CALL, auto_compact_hook, priority=50, name="auto_compact")
    return mgr
