"""Automatic memory extraction from conversation turns — 8 heuristic rules
+ LLM-driven extraction with keyword fallback.
"""

from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path

from arforge.memory import auto_extract_tags, save_memory_v2


_AUTO_PERSISTENT_TYPES = {"preference", "identity", "convention", "workflow", "constraint"}
_NEVER_AUTO_PERSIST_TYPES = {"error", "project"}
_DURABLE_SIGNALS = (
    "记住", "长期", "以后都", "今后都", "从现在起", "始终", "总是", "一直",
    "每次", "默认", "习惯", "偏好", "项目约定", "项目规范", "仓库约定",
    "remember", "from now on", "always", "every time", "by default", "prefer",
)
_TRANSIENT_SIGNALS = (
    "这次", "本次", "当前任务", "这一轮", "现在只", "先不要", "暂时", "临时",
    "继续完成", "继续并", "收尾", "最终验收", "接下来只", "for this task",
    "for now", "temporarily", "this time", "current task",
)


def workspace_memory_scope(workspace_path: str | Path) -> tuple[str, str]:
    """Return the stable project id and canonical path used by memory isolation."""
    resolved = Path(workspace_path).expanduser().resolve()
    canonical = str(resolved)
    identity = canonical.casefold() if __import__("os").name == "nt" else canonical
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"workspace:{digest}", canonical


def assess_auto_memory_candidate(content: str, mem_type: str) -> tuple[bool, str]:
    """Decide whether a candidate is durable enough for automatic persistence.

    Extraction remains permissive so the UI can explain candidates. Persistence
    is deliberately conservative: one-turn instructions, unverified errors and
    simple project mentions must never silently become long-term behavior.
    """
    normalized = " ".join(str(content).split()).casefold()
    kind = str(mem_type or "knowledge").strip().casefold()
    if not normalized:
        return False, "empty"
    if len(normalized) > 800:
        return False, "task_sized_content"
    if kind in _NEVER_AUTO_PERSIST_TYPES:
        return False, f"review_required_{kind}"
    if any(signal.casefold() in normalized for signal in _TRANSIENT_SIGNALS):
        return False, "transient_instruction"
    if kind not in _AUTO_PERSISTENT_TYPES:
        return False, "unsupported_auto_type"
    if kind == "identity":
        return True, "durable_identity"
    if any(signal.casefold() in normalized for signal in _DURABLE_SIGNALS):
        return True, "explicit_durable_signal"
    return False, "missing_durable_signal"


# ---------------------------------------------------------------------------
# Rule-based extraction (8 rules)
# ---------------------------------------------------------------------------


def _rule_preference(text: str) -> dict | None:
    """偏好关键词：总是.*用|prefer.*for|约定.*采用 → preference"""
    if any(kw in text for kw in ["总是", "一直", "偏好", "更喜欢", "prefer", "always", "习惯"]):
        return {"content": text, "mem_type": "preference", "tags": auto_extract_tags(text), "importance": 3}
    return None


def _rule_project_convention(text: str) -> dict | None:
    """项目约定：命名规范、目录结构等"""
    convention_kw = ["约定", "规范", "convention", "style", "命名", "naming", "目录结构", "项目结构"]
    if any(kw in text.lower() for kw in convention_kw):
        return {"content": text, "mem_type": "convention", "tags": auto_extract_tags(text) + ",convention", "importance": 3}
    return None


def _rule_error_pattern(text: str, response: str) -> dict | None:
    """错误模式：用户反馈 wrong/错了/不对 → 上一轮记为 error_pattern"""
    if response and any(kw in text.lower() for kw in ["wrong", "错了", "不对", "错误", "失败", "error", "bug"]):
        return {"content": response[:1200], "mem_type": "error", "tags": "bug,error_pattern", "importance": 4}
    return None


def _rule_user_identity(text: str) -> dict | None:
    """用户身份：我是.*|I am .*|my name is → identity"""
    identity_kw = ["我是", "我叫", "我是做", "我的角色", "I am", "my name is", "my role is"]
    if any(kw in text for kw in identity_kw):
        return {"content": text, "mem_type": "identity", "tags": "user,identity", "importance": 2}
    return None


def _rule_workflow(text: str) -> dict | None:
    """工作流：先.*再.*最后|首先.*然后 → workflow"""
    workflow_patterns = [r"先.*再.*最后", r"首先.*然后", r"第一步.*第二步", r"step\s*1.*step\s*2"]
    for pat in workflow_patterns:
        if re.search(pat, text, re.IGNORECASE):
            return {"content": text, "mem_type": "workflow", "tags": "workflow,process", "importance": 3}
    return None


def _rule_constraint(text: str) -> dict | None:
    """约束：不要.*|don't.*|不能 → constraint"""
    constraint_kw = ["不要", "不能", "禁止", "don't", "do not", "never", "avoid", "避免"]
    if any(kw in text.lower() for kw in constraint_kw):
        return {"content": text, "mem_type": "constraint", "tags": "constraint,rule", "importance": 4}
    return None


def _rule_fact(text: str) -> dict | None:
    """事实陈述：包含数字/版本/日期等客观信息"""
    if re.search(r"(?:version|v\d+\.\d+|发布于|release|Python\s*\d+\.\d+)", text, re.IGNORECASE):
        return {"content": text, "mem_type": "fact", "tags": "fact,version", "importance": 2}
    return None


def _rule_brand_project(text: str) -> dict | None:
    """品牌/项目提及"""
    if any(kw in text for kw in ["Arforge", "arforge", "Arforge Agent"]):
        return {"content": text, "mem_type": "project", "tags": "brand,project", "importance": 2}
    return None


_RULES = [
    _rule_preference,
    _rule_project_convention,
    _rule_error_pattern,
    _rule_user_identity,
    _rule_workflow,
    _rule_constraint,
    _rule_fact,
    _rule_brand_project,
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def extract_memories_from_turn(
    user_input: str,
    assistant_response: str = "",
    auto_save: bool = True,
    *,
    project_id: str = "",
    workspace_path: str = "",
) -> list[dict]:
    """Apply all 8 rules to a conversation turn and optionally save."""
    candidates: list[dict] = []
    seen: set[str] = set()

    for rule in _RULES:
        try:
            # Error pattern rule needs both user_input and response
            if rule is _rule_error_pattern:
                result = rule(user_input, assistant_response)
            else:
                result = rule(user_input)
        except Exception:
            continue

        if result is None:
            continue

        # Deduplicate by content fingerprint
        fingerprint = result["content"][:80]
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        eligible, reason = assess_auto_memory_candidate(result["content"], result.get("mem_type", "knowledge"))
        result["auto_save_eligible"] = eligible
        result["governance_reason"] = reason
        candidates.append(result)

    if auto_save:
        if workspace_path:
            scoped_project, scoped_workspace = workspace_memory_scope(workspace_path)
        else:
            from arforge.workspace_context import current_workspace

            scoped_project, scoped_workspace = workspace_memory_scope(current_workspace(Path.cwd()))
        scoped_project = project_id or scoped_project
        for item in candidates:
            if not item["auto_save_eligible"]:
                continue
            try:
                item["id"] = save_memory_v2(
                    content=item["content"],
                    mem_type=item.get("mem_type", "knowledge"),
                    tags=",".join(filter(None, [item.get("tags", ""), "governed"])),
                    importance=item.get("importance", 1),
                    source="auto",
                    dedupe=True,
                    project_id=scoped_project,
                    workspace_path=scoped_workspace,
                )
            except Exception:
                pass

    return candidates


def extract_memories_with_model(
    user_input: str,
    assistant_response: str,
    model=None,
    auto_save: bool = True,
    *,
    project_id: str = "",
    workspace_path: str = "",
) -> list[dict]:
    """Extract memories using LLM; falls back to rule-based on failure.

    When *model* is provided (a ModelAdapter instance), the LLM is prompted to
    identify valuable long-term memories from the conversation and return JSON.
    On failure, the 8 rule-based extractor is used instead.
    """
    if model is not None:
        try:
            prompt = (
                "从以下对话中提取值得长期记住的事实。\n"
                "输出 JSON 数组，每个元素包含：content（内容）、type（类型：preference/identity/fact/workflow/convention/constraint/error/project）、"
                "importance（1-5）。\n\n"
                "类型说明：\n"
                "- preference: 用户偏好或习惯\n"
                "- identity: 用户身份信息\n"
                "- fact: 客观事实（版本号、日期等）\n"
                "- workflow: 工作流或流程\n"
                "- convention: 项目约定或规范\n"
                "- constraint: 约束或禁止事项\n"
                "- error: 错误模式\n"
                "- project: 项目相关\n\n"
                f"用户输入：{user_input[:500]}\n\n"
                f"助手回复（摘要）：{assistant_response[:500] if assistant_response else '（无）'}\n\n"
                "只输出 JSON 数组，不要其他内容。"
            )
            raw = model.generate(
                [{"role": "user", "content": prompt}],
                max_tokens=512,
                temperature=0.2,
            )
            # Parse JSON
            start = raw.find("[")
            end = raw.rfind("]")
            if start != -1 and end != -1 and end > start:
                items = json.loads(raw[start : end + 1])
                if isinstance(items, list):
                    candidates = []
                    for item in items:
                        if not isinstance(item, dict) or "content" not in item:
                            continue
                        candidate = {
                            "content": item["content"],
                            "mem_type": item.get("type", "knowledge"),
                            "tags": item.get("type", "knowledge"),
                            "importance": min(max(int(item.get("importance", 2)), 1), 5),
                        }
                        eligible, reason = assess_auto_memory_candidate(candidate["content"], candidate["mem_type"])
                        candidate["auto_save_eligible"] = eligible
                        candidate["governance_reason"] = reason
                        candidates.append(candidate)
                    if candidates and auto_save:
                        if workspace_path:
                            scoped_project, scoped_workspace = workspace_memory_scope(workspace_path)
                        else:
                            from arforge.workspace_context import current_workspace

                            scoped_project, scoped_workspace = workspace_memory_scope(current_workspace(Path.cwd()))
                        scoped_project = project_id or scoped_project
                        for item in candidates:
                            if not item["auto_save_eligible"]:
                                continue
                            try:
                                item["id"] = save_memory_v2(
                                    content=item["content"],
                                    mem_type=item.get("mem_type", "knowledge"),
                                    tags=",".join(filter(None, [item.get("tags", ""), "governed"])),
                                    importance=item.get("importance", 2),
                                    source="model",
                                    dedupe=True,
                                    project_id=scoped_project,
                                    workspace_path=scoped_workspace,
                                )
                            except Exception:
                                pass
                    return candidates
        except Exception:
            pass

    # Fallback to rules
    return extract_memories_from_turn(
        user_input,
        assistant_response,
        auto_save=auto_save,
        project_id=project_id,
        workspace_path=workspace_path,
    )


def get_auto_memory_stats() -> dict:
    """Return statistics about the auto-memory system."""
    return {
        "extractor": "8-rule + model-driven",
        "rules_count": len(_RULES),
        "rule_names": [r.__name__ for r in _RULES],
        "model_driven": True,
        "deduplication": True,
        "governance": {
            "policy": "explicit-durable-signal",
            "workspace_scoped": True,
            "transient_instructions_persisted": False,
            "errors_require_review": True,
        },
    }
