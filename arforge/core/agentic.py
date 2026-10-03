"""可复用的 agentic 工具循环核心（P0-2 / P1-6 共用，单一实现避免重复）。

把"模型通过 function calling 自主决策 → 并行执行工具 → 观察回灌 → 迭代 →
自主停止 / 死循环熔断 / max_steps 收尾"抽成与具体 Agent 解耦的函数：
- 单 Agent 主循环 AgentLoopV2.run_agentic 复用它（全部工具）。
- 多 Agent 的子 Agent 复用它（按角色白名单过滤的工具子集）。
内置可观测埋点（Tracer），返回 trace 树与 token/成本汇总。
"""

from __future__ import annotations

import json
import inspect
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

from arforge.core.hooks import HookContext, HookEvent, get_hook_manager
from arforge.observability import Tracer, aggregate
from arforge.core.self_correct import SelfCorrectState
from arforge.core.grounding import build_evidence_feedback, validate_evidence
from arforge.core.task_complexity import (
    ComplexityTier,
    COMPLEXITY_STEPS,
    build_incomplete_report,
    render_incomplete_report,
)
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.reasoning import parse_reasoning
from arforge.security_guard import sanitize_log_message, sanitize_sensitive_data
from arforge.tool_registry import REGISTRY, ToolResult, adapt_docx_request


@dataclass
class ToolLoopResult:
    answer: str
    intent: str = "agentic"
    tool_calls: list = field(default_factory=list)
    trace: list = field(default_factory=list)
    steps: int = 0
    messages: list = field(default_factory=list)
    observability: dict | None = None
    self_correct: dict | None = None
    complexity_tier: str | None = None
    incomplete_report: dict | None = None
    verifications: list[dict] = field(default_factory=list)
    deliveries: list[dict] = field(default_factory=list)
    goal_mode: bool = False
    goal_cycles: int = 1
    subagents: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Return a stable mapping for legacy API and serialization callers."""

        return {
            "answer": self.answer,
            "intent": self.intent,
            "tool_calls": self.tool_calls,
            "trace": self.trace,
            "steps": self.steps,
            "messages": self.messages,
            "observability": self.observability,
            "self_correct": self.self_correct,
            "complexity_tier": self.complexity_tier,
            "incomplete_report": self.incomplete_report,
            "verifications": self.verifications,
            "deliveries": self.deliveries,
            "goal_mode": self.goal_mode,
            "goal_cycles": self.goal_cycles,
            "subagents": self.subagents,
        }

    def get(self, key: str, default=None):
        """Provide dict-like read compatibility without weakening typed access."""

        return self.to_dict().get(key, default)


def _finalize(adapter, messages, instruction: str = "") -> str:
    """Ask for a natural-language result without exposing another tool turn."""
    try:
        final_messages = list(messages)
        if instruction:
            final_messages.append({"role": "user", "content": instruction})
        final = adapter.generate_with_tools(final_messages, tools=None, tool_choice="none")
        return final.content or ""
    except Exception as exc:
        return f"[Arforge] 生成最终回答失败：{exc}"


def _is_explicit_read_only_task(task: str) -> bool:
    """Return true only when the user explicitly prohibited workspace edits."""
    text = " ".join(str(task or "").casefold().split())
    markers = (
        "read-only",
        "read only",
        "readonly",
        "do not edit",
        "do not modify",
        "without editing",
        "without modifying",
        "只读",
        "不要编辑",
        "不要修改",
        "不修改文件",
    )
    return any(marker in text for marker in markers)


def _browser_evidence_excerpt(output: str) -> str:
    """Keep the browser facts needed for final synthesis instead of its preamble."""
    text = str(output or "")
    selected: list[str] = []
    prefixes = (
        "Final URL:",
        "Viewport:",
        "Document:",
        "Actions completed:",
        "Action policy:",
        "Credential scope:",
        "Redirect policy:",
        "Page content trust:",
        "Prompt injection indicators:",
        "Screenshot observation:",
        "Runtime issues:",
        "Console errors:",
        "Page errors:",
        "Network failures:",
        "HTTP errors:",
        "Downloads:",
        "Final state verification:",
        "Final state verification failures:",
    )
    for line in text.splitlines():
        if line.startswith(prefixes):
            selected.append(line)
    visible = _browser_visible_text_sample(text)
    if visible:
        selected.append(f"Visible text sample: {visible[:900]}")
    return " | ".join(selected) or text


def _render_executed_evidence(tool_calls_log: list[dict], *, limit: int = 40) -> str:
    """Build a bounded, redacted digest that cannot request more operations."""
    rows: list[str] = []
    for call in tool_calls_log[-max(1, limit):]:
        tool = str(call.get("tool") or "tool")
        step = int(call.get("step") or 0)
        success = bool(call.get("success"))
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        subject = next(
            (
                str(args.get(key) or "")
                for key in ("filename", "path", "file_path", "command", "query", "url")
                if args.get(key)
            ),
            "",
        )
        detail = str(call.get("output") if success else call.get("error") or "")
        if tool in {"test_browser", "interact_browser"} and success:
            detail = _browser_evidence_excerpt(detail)
        subject = " ".join(sanitize_log_message(subject).split())[:240]
        detail = " ".join(sanitize_log_message(detail).split())[:1600]
        state = "passed" if success else "failed"
        row = f"- step {step}: {tool} [{state}]"
        if subject:
            row += f" target={subject}"
        if detail:
            row += f" result={detail}"
        rows.append(row)
    if not rows:
        return "- No tool execution evidence was recorded."
    return "\n".join(rows)


_INCOMPLETE_ANSWER_RE = re.compile(
    r"(?:task|acceptance|requirement|original task|cleanup|test)?\s*"
    r"(?:is|was|could|cannot|can not|was not|is not)?\s*"
    r"(?:not completed|not complete|incomplete|could not be completed|cannot be completed|"
    r"not proven complete|cleanup was not|cleanup is not|未完成|无法完成|不能完成|"
    r"尚未完成|未证明完成|未执行清理|清理未执行|没有完成)",
    re.IGNORECASE,
)

_UNRESOLVED_SECTION_RE = re.compile(
    r"(?:无法验证|尚未验证|未验证|未核实|剩余|遗留|待处理|未解决)"
    r"(?:的)?(?:事项|问题|工作|项目|项)?|"
    r"(?:unverified|not verified|remaining|unresolved|open)\s+"
    r"(?:items?|issues?|work|tasks?)|limitations?",
    re.IGNORECASE,
)
_EMPTY_UNRESOLVED_SECTION_RE = re.compile(
    r"^(?:[-*+]\s*)?(?:无|没有|暂无|无此类事项|none|nothing|n/?a|0(?:\s+items?)?)"
    r"[。.!\s]*$",
    re.IGNORECASE,
)


def _answer_declares_incomplete(answer: str) -> bool:
    """Recognize an explicit non-completion report so it cannot become success."""
    text = str(answer or "")
    if _INCOMPLETE_ANSWER_RE.search(text):
        return True

    # Long-task reports often avoid the word "incomplete" while still ending
    # with an explicit "unverified/remaining items" section.  Treat a non-empty
    # section as unfinished work; otherwise a polished report can bypass goal
    # continuation even though it lists work that still needs verification.
    lines = text.splitlines()
    for index, raw_line in enumerate(lines):
        heading = re.sub(r"^\s{0,3}#{1,6}\s*", "", raw_line).strip().rstrip(":：")
        if not _UNRESOLVED_SECTION_RE.fullmatch(heading):
            continue
        body: list[str] = []
        for candidate in lines[index + 1 :]:
            if re.match(r"^\s{0,3}#{1,6}\s+", candidate):
                break
            normalized = candidate.strip()
            if not normalized or re.fullmatch(r"[-|:\s]+", normalized):
                continue
            body.append(normalized)
        if body and not all(
            _EMPTY_UNRESOLVED_SECTION_RE.fullmatch(item) for item in body
        ):
            return True
    return False


def _task_requires_cleanup(task: str) -> bool:
    text = " ".join(str(task or "").casefold().split())
    return any(
        marker in text
        for marker in (
            "disposable",
            "cleanup",
            "clean up",
            "delete it",
            "leave no disposable",
            "leave no test data",
            "临时数据",
            "临时任务",
            "清理",
            "删除它",
            "不留测试数据",
        )
    )


def _task_requires_delivery(task: str) -> bool:
    if _task_requires_cleanup(task):
        return True
    text = " ".join(str(task or "").casefold().split())
    return any(
        marker in text
        for marker in (
            " implement ",
            " fix ",
            " create ",
            " delete ",
            " modify ",
            " build ",
            "complete the",
            "through the ui",
            "修复",
            "实现",
            "创建",
            "删除",
            "修改",
            "完善",
        )
    )


def _has_successful_browser_interaction(tool_calls_log: list[dict]) -> bool:
    return any(
        call.get("success") and str(call.get("tool") or "") == "interact_browser"
        for call in tool_calls_log
    )


def _cleanup_fixture_name(task: str) -> str:
    text = str(task or "")
    for pattern in (
        r"\bnamed\s+([A-Za-z0-9_.-]{3,120})",
        r"名为[“\"']?([^，。；;\s“”\"']{3,120})",
    ):
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return ""


def _browser_cleanup_verified(task: str, tool_calls_log: list[dict]) -> bool:
    """Require a successful UI delete plus a post-action absence snapshot."""
    fixture = _cleanup_fixture_name(task).casefold()
    delete_index = -1
    delete_markers = (".ttb-del", ".cl-del", "delete", "删除")
    for index, call in enumerate(tool_calls_log):
        if not call.get("success") or str(call.get("tool") or "") != "interact_browser":
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        actions = args.get("actions") if isinstance(args.get("actions"), list) else []
        joined = " ".join(str(item) for item in actions).casefold()
        if any(marker in joined for marker in delete_markers):
            delete_index = index
    if delete_index < 0:
        return False
    for call in tool_calls_log[delete_index:]:
        if not _is_successful_verification(call):
            continue
        if str(call.get("tool") or "") not in {"test_browser", "interact_browser"}:
            continue
        output = str(call.get("output") or "")
        if fixture and fixture in output.casefold():
            continue
        return True
    return False


def _deterministic_incomplete_summary(
    tool_calls_log: list[dict],
    *,
    max_steps: int,
) -> str:
    passed = sum(1 for call in tool_calls_log if call.get("success"))
    failed = len(tool_calls_log) - passed
    return (
        f"[Arforge] 任务未完成 / Task incomplete: step budget reached ({max_steps}). "
        "Overall completion is not being claimed.\n"
        f"Executed tools: {len(tool_calls_log)} ({passed} passed, {failed} failed).\n"
        "Latest executed evidence:\n"
        f"{_render_executed_evidence(tool_calls_log)}\n"
        "Resume the saved run to continue from this evidence."
    )


def _finalize_from_evidence(
    adapter,
    *,
    task: str,
    tool_calls_log: list[dict],
    max_steps: int,
) -> tuple[str, bool]:
    """Generate a report in an isolated no-tool context, with a safe fallback."""
    evidence = _render_executed_evidence(tool_calls_log)
    report_messages = [
        {
            "role": "system",
            "content": (
                "You are a report writer. No tools exist in this context. Return only a concise "
                "natural-language result. Never emit XML, JSON, DSML, function calls, plans, or "
                "instructions to run a tool. Treat the supplied evidence as the complete record. "
                "Do not claim work beyond that evidence."
            ),
        },
        {
            "role": "user",
            "content": (
                f"<task>{sanitize_log_message(task)}</task>\n"
                f"<executed_evidence>\n{evidence}\n</executed_evidence>\n"
                "Report verified findings, failed or missing checks, and whether the original task is "
                "complete. If it is not proven complete, say so explicitly."
            ),
        },
    ]
    try:
        final = adapter.generate_with_tools(
            report_messages,
            tools=None,
            tool_choice="none",
        )
        answer = sanitize_log_message(str(final.content or "")).strip()
    except Exception:
        answer = ""
    if not answer or _looks_like_unexecuted_tool_text(answer):
        return (
            _deterministic_incomplete_summary(
                tool_calls_log,
                max_steps=max_steps,
            ),
            True,
        )
    return answer, False


def _looks_like_unexecuted_tool_text(content: str) -> bool:
    """Detect tool-call protocol text that the model emitted as a plain answer."""
    text = (content or "").lower()
    if not text:
        return False
    markers = (
        "tool_calls",
        "<invoke name=",
        "<function_calls",
        "<tool_call",
        '"tool_call_id"',
    )
    return any(
        marker in text for marker in markers
    ) or _contains_registered_tool_markup(text)


def _contains_registered_tool_markup(content: str) -> bool:
    for match in re.finditer(r"<([a-z][a-z0-9_.-]*)\b", content or "", re.IGNORECASE):
        name = match.group(1).lower()
        if REGISTRY.get(name) is not None or "_" in name:
            return True
    return False


def _parse_xml_tool_calls(content: str) -> list[ToolCall]:
    """Translate simple model-emitted XML tool blocks into real tool calls."""
    calls: list[ToolCall] = []
    block_pattern = re.compile(
        r"<(?P<name>[a-z][a-z0-9_.-]*)\b[^>]*>(?P<body>.*?)</(?P=name)\s*>",
        re.IGNORECASE | re.DOTALL,
    )
    self_closing_pattern = re.compile(
        r"<(?P<name>[a-z][a-z0-9_.-]*)\b(?P<attrs>[^>]*)/\s*>",
        re.IGNORECASE | re.DOTALL,
    )

    def append_call(name: str, arguments: dict[str, str], body: str = "") -> None:
        recovered = _build_recovered_tool_call(
            name,
            arguments,
            call_id=f"xml-tool-{len(calls) + 1}",
            body=body,
        )
        if recovered is not None:
            calls.append(recovered)

    for match in block_pattern.finditer(content or ""):
        name = match.group("name").lower()
        body = match.group("body").strip()
        arguments: dict[str, str] = {}
        try:
            root = ET.fromstring(f"<tool>{body}</tool>")
            arguments = {
                child.tag: (child.text or "").strip()
                for child in root
                if isinstance(child.tag, str)
            }
        except ET.ParseError:
            arguments = {}
        append_call(name, arguments, body)

    for match in self_closing_pattern.finditer(content or ""):
        attributes = {
            item.group("name"): item.group("value")
            for item in re.finditer(
                r"(?P<name>[a-z_][a-z0-9_.-]*)\s*=\s*(['\"])(?P<value>.*?)\2",
                match.group("attrs"),
                re.IGNORECASE | re.DOTALL,
            )
        }
        append_call(match.group("name").lower(), attributes)
    return calls


def _build_recovered_tool_call(
    name: str,
    arguments: dict,
    *,
    call_id: str,
    body: str = "",
) -> ToolCall | None:
    normalized_name = str(name or "").strip().lower()
    definition = REGISTRY.get(normalized_name)
    if definition is None:
        return None
    normalized_arguments = dict(arguments or {})
    try:
        parameter_names = [item.name for item in definition.schema.params]
    except AttributeError:
        parameter_names = []
    if len(parameter_names) == 1 and parameter_names[0] not in normalized_arguments:
        if len(normalized_arguments) == 1:
            normalized_arguments = {
                parameter_names[0]: next(iter(normalized_arguments.values())),
            }
        elif body and not normalized_arguments:
            normalized_arguments = {parameter_names[0]: body}
    return ToolCall(
        call_id,
        normalized_name,
        json.dumps(normalized_arguments, ensure_ascii=False),
    )


def _parse_json_tool_calls(content: str) -> list[ToolCall]:
    """Translate provider-emitted JSON tool envelopes into real tool calls."""
    candidates = [str(content or "").strip()]
    candidates.extend(
        match.group("body").strip()
        for match in re.finditer(
            r"```(?:json)?\s*(?P<body>\{.*?\}|\[.*?\])\s*```",
            content or "",
            re.IGNORECASE | re.DOTALL,
        )
    )
    calls: list[ToolCall] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        envelopes = payload if isinstance(payload, list) else [payload]
        if isinstance(payload, dict) and isinstance(payload.get("tool_calls"), list):
            envelopes = payload["tool_calls"]
        for envelope in envelopes:
            if not isinstance(envelope, dict):
                continue
            function = envelope.get("function")
            if isinstance(function, dict):
                name = function.get("name")
                arguments = function.get("arguments", {})
            else:
                name = envelope.get("tool") or envelope.get("name")
                arguments = (
                    envelope.get("arguments")
                    if "arguments" in envelope
                    else envelope.get("args", envelope.get("input", {}))
                )
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {}
            if not isinstance(arguments, dict):
                arguments = {}
            recovered = _build_recovered_tool_call(
                str(name or ""),
                arguments,
                call_id=f"json-tool-{len(calls) + 1}",
            )
            if recovered is None:
                continue
            signature = (recovered.name, recovered.arguments)
            if signature not in seen:
                calls.append(recovered)
                seen.add(signature)
    return calls


def _test_targets_from_task(task: str) -> list[str]:
    matches = re.findall(
        r"(?<![\w.-])(?:tests?|test)[\\/][A-Za-z0-9_.\\/\-]+"
        r"\.(?:py|js|jsx|mjs|cjs|ts|tsx|rs|go)"
        r"(?:::[A-Za-z0-9_.\-]+)*",
        task or "",
        flags=re.IGNORECASE,
    )
    targets: list[str] = []
    for match in matches:
        normalized = match.replace("\\", "/").strip("`'\"“”。，、；;：:()[]{}")
        if normalized and normalized not in targets:
            targets.append(normalized)
    return targets


def _runnable_test_targets_from_task(task: str) -> list[str]:
    """Exclude test paths the task explicitly asks the agent to create first."""
    runnable: list[str] = []
    source = task or ""
    for target in _test_targets_from_task(source):
        creation = re.search(
            rf"(?:add|create|write|new|新增|创建|新建|添加)"
            rf"[^。\n.!?]{{0,32}}{re.escape(target)}",
            source,
            flags=re.IGNORECASE,
        )
        if creation is None:
            runnable.append(target)
    return runnable


def _explicit_tool_requests(task: str, tools: list[dict]) -> list[str]:
    """Return registered tools that the user explicitly instructed us to call."""
    requested: list[str] = []
    lowered = (task or "").lower()
    available_names = {
        str(tool.get("function", {}).get("name", "") or "").strip()
        for tool in tools or []
    }
    for tool in tools or []:
        name = str(tool.get("function", {}).get("name", "") or "").strip()
        if not name:
            continue
        escaped = re.escape(name.lower())
        patterns = (
            rf"(?:call|use|invoke|execute|run|调用|使用|执行)\s*[`'\"“”]*(?<![\w]){escaped}\b",
            rf"\b{escaped}\b\s*(?:工具|tool)\s*(?:来|去|以便|用于)?\s*(?:读取|检查|分析|执行|read|inspect|analy[sz]e|run)",
        )
        match = next(
            (item for pattern in patterns if (item := re.search(pattern, lowered))),
            None,
        )
        if match is None:
            continue
        prefix = lowered[max(0, match.start() - 12) : match.start()]
        if re.search(r"(?:不要|禁止|无需|避免|do not|don't|without)\s*$", prefix):
            continue
        requested.append(name)
    test_targets = _runnable_test_targets_from_task(task)
    test_intent = re.search(r"\b(?:run|execute|test)\b|运行|执行|测试", lowered)
    test_negation = re.search(
        r"(?:do not|don't|without|不要|禁止|无需|避免)\s*(?:run|execute|test|运行|执行|测试)",
        lowered,
    )
    if (
        test_targets
        and test_intent
        and not test_negation
        and "run_tests" in available_names
        and "run_tests" not in requested
    ):
        requested.append("run_tests")
    return requested


def _build_explicit_runtime_tool_call(
    task: str,
    tool_name: str,
    *,
    step: int,
) -> ToolCall | None:
    """Build a deterministic call only when explicit arguments are unambiguous."""
    definition = REGISTRY.get(tool_name)
    if definition is None:
        return None
    params = list(definition.schema.params)
    if tool_name == "run_tests":
        targets = _runnable_test_targets_from_task(task)
        if not targets:
            return None
        arguments = {"targets": targets}
        if all(target.split("::", 1)[0].casefold().endswith(".py") for target in targets):
            arguments["framework"] = "pytest"
    elif not params:
        arguments: dict = {}
    elif len(params) == 1 and params[0].type == "path":
        path_matches = re.findall(
            r"(?:[A-Za-z]:[\\/])?[\w.@+\-]+(?:[\\/][\w.@+\-]+)+"
            r"|(?<![\w.])[\w@+\-]+\.[A-Za-z0-9]{1,12}\b",
            task or "",
        )
        if not path_matches:
            return None
        arguments = {params[0].name: path_matches[0].strip("`'\"“”。，、；;：:()[]{}")}
    else:
        return None
    return ToolCall(
        f"explicit-tool-{step}",
        tool_name,
        json.dumps(arguments, ensure_ascii=False),
    )


def _repair_tool_arguments_from_task(
    task: str, tool_name: str, arguments: dict
) -> dict:
    """Recover unambiguous arguments for a malformed model tool call.

    This is deliberately narrow. Recovered values still pass through the
    normal schema, permission, sandbox, and confirmation layers.
    """
    repaired = dict(arguments or {})
    definition = REGISTRY.get(tool_name)
    parameter_names = (
        {item.name for item in definition.schema.params}
        if definition is not None
        else set()
    )

    # Models commonly emit equivalent SDK-style field names even when the
    # selected tool publishes a different JSON schema. Repair only aliases
    # whose destination exists in that exact schema; the call still passes
    # through normal validation, permissions, and sandbox enforcement.
    aliases: dict[str, tuple[str, ...]] = {
        "filename": ("filePath", "filepath", "file_path", "path", "file"),
        "content": ("text", "body"),
        "code": ("script", "source"),
        "command": ("cmd",),
        "keyword": ("query", "search_term", "term", "pattern"),
        "task_id": ("command_id", "job_id"),
        "language": ("lang",),
        "old_string": ("oldString", "old_text", "oldText"),
        "new_string": ("newString", "new_text", "newText", "replacement"),
        "viewport_width": ("viewportWidth", "width"),
        "viewport_height": ("viewportHeight", "height"),
    }
    viewport = repaired.get("viewport")
    if isinstance(viewport, dict):
        if "viewport_width" in parameter_names and repaired.get("viewport_width") is None:
            if viewport.get("width") is not None:
                repaired["viewport_width"] = viewport["width"]
        if "viewport_height" in parameter_names and repaired.get("viewport_height") is None:
            if viewport.get("height") is not None:
                repaired["viewport_height"] = viewport["height"]
        repaired.pop("viewport", None)

    for destination, sources in aliases.items():
        if destination not in parameter_names or repaired.get(destination) is not None:
            continue
        for source in sources:
            if repaired.get(source) is not None:
                repaired[destination] = repaired.pop(source)
                break

    if tool_name == "run_script" and not repaired.get("language"):
        code = str(repaired.get("code", "") or "")
        python_signal = re.search(
            r"(?m)^\s*(?:from\s+\w|import\s+\w|def\s+\w|class\s+\w)|\bassert\b|\bprint\s*\(",
            code,
        )
        javascript_signal = re.search(
            r"(?m)^\s*(?:const|let|var|function)\s+|=>|\bconsole\.log\s*\(|\brequire\s*\(",
            code,
        )
        if python_signal and not javascript_signal:
            repaired["language"] = "python"
        elif javascript_signal and not python_signal:
            repaired["language"] = "javascript"

    if tool_name == "run_tests" and not repaired.get("targets"):
        targets = _runnable_test_targets_from_task(task)
        if targets:
            repaired["targets"] = targets
            if (
                "framework" in parameter_names
                and not repaired.get("framework")
                and all(target.split("::", 1)[0].casefold().endswith(".py") for target in targets)
            ):
                repaired["framework"] = "pytest"

    if tool_name != "write_docx":
        return repaired

    if not repaired.get("filename"):
        for alias in ("path", "file", "name"):
            if repaired.get(alias):
                repaired["filename"] = repaired.pop(alias)
                break
    if not repaired.get("content"):
        for alias in ("text", "body"):
            if repaired.get(alias):
                repaired["content"] = repaired.pop(alias)
                break

    recovered = adapt_docx_request(task)
    for key, value in recovered.items():
        if not repaired.get(key):
            repaired[key] = value
    return repaired


def _context_injection_labels(messages: list) -> list[str]:
    labels: list[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = str(msg.get("content") or "")
        if content.startswith("## Relevant Memories"):
            labels.append("memory")
        elif "Learning" in content or "learned" in content.lower():
            labels.append("learning")
        elif content.startswith("【关键事实】"):
            labels.append("key_facts")
        elif content.startswith("【历史摘要】"):
            labels.append("summary")
        else:
            labels.append("context")
    return labels


def _unexecuted_tool_text_report(reason: str) -> str:
    return (
        "[Arforge] 任务未完成：模型在最终回答中输出了未执行的工具调用文本，"
        "因此没有把这些操作真正应用到文件系统。\n"
        f"原因: {reason}\n"
        "建议: 继续运行同一任务，或改用更小的步骤；系统已阻止把未执行工具文本当作成功结果。"
    )


WRITE_TOOLS = {
    "write_file",
    "edit_file",
    "create_file",
    "delete_file",
    "apply_patch_batch",
    "write_docx",
    "write_xlsx",
    "write_pptx",
    "write_pdf",
}
VERIFY_TOOLS = {"verify_work", "run_impacted_tests", "run_tests"}
CONTROL_TOOLS = {
    "update_plan",
    "deliver_user_message",
    "request_user_input",
    "cooperative_wait",
}
_MAX_CONSECUTIVE_READ_CALLS = 24
_VALIDATION_CONTEXT_LIMIT = 12
_MAX_TEMP_HELPER_WRITES = 2
_TEMP_HELPER_RE = re.compile(
    r"^(?:\.tmp-|_?(?:read|check|inspect|review|validate|verify|audit|probe|debug|ck|r)(?:[_-]|\.|\d|$)|final_audit(?:[_-]|\.)?)",
    re.IGNORECASE,
)
NON_CODE_FILE_SUFFIXES = {
    ".csv",
    ".docx",
    ".log",
    ".md",
    ".rst",
    ".rtf",
    ".text",
    ".tsv",
    ".txt",
}


_TEST_COMMAND_RE = re.compile(
    r"^(?:"
    r"(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+pytest\b|"
    r"(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+compileall\b|"
    r"(?:python(?:3)?|py)(?:\.exe)?\s+(?:[^\s]+[/\\])?(?:test_[^\s]+\.py|[^\s]+_test\.py)\b|"
    r"pytest(?:\.exe)?\b|"
    r"npm(?:\.cmd)?\s+(?:run\s+)?test\b|"
    r"(?:pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?test\b|"
    r"node(?:\.exe)?\s+--test\b|"
    r"node(?:\.exe)?\s+--check\b|"
    r"npx(?:\.cmd)?\s+(?:jest|vitest)\b|"
    r"(?:\.[/\\])?(?:contract|regression|tests?)(?:\.exe)?(?:\s|$)|"
    r"cargo(?:\.exe)?\s+test\b|"
    r"cargo(?:\.exe)?\s+check\b|"
    r"php(?:\.exe)?\s+-l\b|"
    r"go(?:\.exe)?\s+test\b"
    r")",
    re.IGNORECASE,
)

_NO_VERIFICATION_EVIDENCE_RE = re.compile(
    r"(?:no supported test framework detected|no tests? (?:were )?found|"
    r"0 tests? collected|nothing to verify)",
    re.IGNORECASE,
)
_VALIDATION_SCRIPT_RE = re.compile(
    r"(?:\bassert\b|\braise\s+(?:AssertionError|RuntimeError|SystemExit)\b|"
    r"\bsys\.exit\s*\(\s*[1-9]|\bunittest\b|\bpytest\b)",
    re.IGNORECASE,
)
_SOURCE_READ_SCRIPT_RE = re.compile(
    r"(?:\bopen\s*\(|\.read_text\s*\(|\.read_bytes\s*\(|"
    r"\.readlines\s*\(|\.read\s*\()",
    re.IGNORECASE,
)
_VALIDATION_COMMAND_SCRIPT_RE = re.compile(
    r"(?i)(?:^|[/\\])(?:tests?|checks?|verify|validate|audit|final_audit)"
    r"[^/\\]*\.(?:m?js|py)$"
)
_VALIDATION_SUCCESS_RE = re.compile(
    r"(?i)(?:\b(?:tests?\s+)?passed\b|\b0\s+failed\b|"
    r"\b\d+\s+passed\b|\ball\s+pass(?:ed)?\b|\ball\s+ok\s*:\s*true\b|"
    r"0\s*失败|\d+\s*通过)"
)

_OOXML_WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_OOXML_W = f"{{{_OOXML_WORD_NS}}}"
_DOCX_PATH_RE = re.compile(
    r"(?i)([A-Z]:[\\/][^\"'\r\n<>|?*]+?\.docx)(?=$|[\s,;)\]])"
)
_PDF_PATH_RE = re.compile(
    r"(?i)([A-Z]:[\\/][^\"'\r\n<>|?*]+?\.pdf)(?=$|[\s,;)\]])"
)
_A4_TWIPS = (11906, 16838)


def _task_requires_academic_artifact_validation(task: str) -> bool:
    """Return whether final DOCX output must meet Chinese academic conventions."""
    text = str(task or "").casefold()
    academic_markers = (
        "\u8bba\u6587",  # 论文
        "\u5f00\u9898\u62a5\u544a",  # 开题报告
        "thesis",
        "dissertation",
    )
    format_markers = (
        "\u6807\u51c6",  # 标准
        "\u683c\u5f0f",  # 格式
        "\u89c4\u8303",  # 规范
        "standard",
        "format",
    )
    return any(marker in text for marker in academic_markers) and any(
        marker in text for marker in format_markers
    )


def _successful_docx_paths(tool_calls_log: list[dict]) -> list[Path]:
    """Collect existing DOCX files actually touched by successful tool calls."""
    found: dict[str, Path] = {}
    for call in tool_calls_log:
        if not call.get("success"):
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        values = list(args.values()) + [call.get("output", "")]
        for value in values:
            if not isinstance(value, str):
                continue
            candidates: list[str] = []
            stripped = value.strip().strip("\"'")
            if stripped.casefold().endswith(".docx"):
                candidates.append(stripped)
            candidates.extend(match.group(1) for match in _DOCX_PATH_RE.finditer(value))
            for candidate in candidates:
                try:
                    path = Path(candidate)
                    if path.name.startswith("~$") or not path.is_file():
                        continue
                    found[str(path.resolve()).casefold()] = path.resolve()
                except (OSError, ValueError):
                    continue
    return list(found.values())


def _successful_pdf_paths(tool_calls_log: list[dict]) -> list[Path]:
    """Collect existing PDF files actually touched by successful tool calls."""
    found: dict[str, Path] = {}
    for call in tool_calls_log:
        if not call.get("success"):
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        values = list(args.values()) + [call.get("output", "")]
        for value in values:
            if not isinstance(value, str):
                continue
            candidates: list[str] = []
            stripped = value.strip().strip("\"'")
            if stripped.casefold().endswith(".pdf"):
                candidates.append(stripped)
            candidates.extend(match.group(1) for match in _PDF_PATH_RE.finditer(value))
            for candidate in candidates:
                try:
                    path = Path(candidate)
                    if not path.is_file():
                        continue
                    found[str(path.resolve()).casefold()] = path.resolve()
                except (OSError, ValueError):
                    continue
    return list(found.values())


def _latest_academic_docx(
    paths: list[Path], *, proposal: bool
) -> Path | None:
    """Pick the newest canonical proposal/thesis document, ignoring stale copies."""
    if proposal:
        matches = [path for path in paths if "\u5f00\u9898" in path.stem]
    else:
        matches = [
            path
            for path in paths
            if "\u8bba\u6587" in path.stem and "\u5f00\u9898" not in path.stem
        ]
    if not matches:
        return None
    return max(matches, key=lambda path: (path.stat().st_mtime_ns, path.stat().st_size))


def _latest_academic_pdf(
    paths: list[Path], *, proposal: bool
) -> Path | None:
    """Pick the newest canonical proposal/thesis PDF, ignoring stale copies."""
    if proposal:
        matches = [path for path in paths if "\u5f00\u9898" in path.stem]
    else:
        matches = [
            path
            for path in paths
            if "\u8bba\u6587" in path.stem and "\u5f00\u9898" not in path.stem
        ]
    if not matches:
        return None
    return max(matches, key=lambda path: (path.stat().st_mtime_ns, path.stat().st_size))


def _pdf_academic_quality_issues(path: Path, *, proposal: bool) -> list[str]:
    """Reject invalid or implausibly short rendered academic PDFs.

    The DOCX inspection verifies semantic structure, but it cannot prove that
    the derived PDF actually contains the same document.  Counting PDF page
    objects (with the page-tree Count as a fallback) catches stale/truncated
    exports without introducing a heavyweight renderer into the model loop.
    """
    try:
        payload = path.read_bytes()
    except OSError as exc:
        return [f"{path.name}: PDF cannot be opened ({exc})"]
    if not payload.startswith(b"%PDF-") or b"%%EOF" not in payload[-2048:]:
        return [f"{path.name}: invalid PDF header or EOF marker"]
    page_objects = len(re.findall(rb"/Type\s*/Page\b", payload))
    page_tree_counts = [
        int(value)
        for value in re.findall(rb"/Count\s+(\d+)\b", payload)
        if int(value) < 100_000
    ]
    pages = max([page_objects, *page_tree_counts], default=0)
    minimum = 3 if proposal else 10
    issues: list[str] = []
    if pages < minimum:
        kind = "proposal" if proposal else "thesis"
        issues.append(
            f"{path.name}: rendered {kind} PDF has only {pages} page(s); "
            f"a standard-format deliverable requires at least {minimum} pages "
            "with cover/front matter separated from the body"
        )

    # The built-in PDF writer emits uncompressed text streams. Inspect those
    # streams so page count alone cannot accept a document that exposes raw
    # Markdown/HTML source syntax. External compressed PDFs skip this extra
    # check while retaining header, EOF and page-count validation.
    visible_lines: list[str] = []
    for encoded in re.findall(rb"<([0-9A-Fa-f]+)>\s*Tj", payload):
        try:
            raw = bytes.fromhex(encoded.decode("ascii"))
            if raw.startswith(b"\xfe\xff"):
                visible_lines.append(raw[2:].decode("utf-16-be"))
        except (UnicodeDecodeError, ValueError):
            continue
    for encoded in re.findall(rb"\(((?:\\.|[^\\)])*)\)\s*Tj", payload):
        try:
            text = encoded.decode("latin-1")
            text = re.sub(r"\\([\\()])", r"\1", text)
            visible_lines.append(text)
        except UnicodeDecodeError:
            continue
    raw_markup = next(
        (
            line.strip()
            for line in visible_lines
            if line.strip() in {"---", "***", "___", "```"}
            or line.lstrip().startswith(">")
            or "<!--" in line
            or "-->" in line
            or re.fullmatch(
                r"\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?",
                line.strip(),
            )
        ),
        "",
    )
    if raw_markup:
        issues.append(
            f"{path.name}: rendered PDF contains raw Markdown/HTML source "
            f"markup ({raw_markup}); regenerate a clean PDF and inspect its pages"
        )
    return issues


def _docx_academic_quality_issues(path: Path, *, proposal: bool) -> list[str]:
    """Inspect visible OOXML content and page setup without launching Word."""
    issues: list[str] = []
    try:
        with zipfile.ZipFile(path) as archive:
            document_xml = archive.read("word/document.xml")
    except (OSError, KeyError, zipfile.BadZipFile) as exc:
        return [f"{path.name}: DOCX cannot be opened ({exc})"]

    try:
        root = ET.fromstring(document_xml)
    except ET.ParseError as exc:
        return [f"{path.name}: invalid document.xml ({exc})"]

    paragraphs: list[str] = []
    paragraph_styles: list[str] = []
    for paragraph in root.iter(f"{_OOXML_W}p"):
        text = "".join(
            node.text or "" for node in paragraph.iter(f"{_OOXML_W}t")
        ).strip()
        paragraphs.append(text)
        style_node = paragraph.find(
            f"./{_OOXML_W}pPr/{_OOXML_W}pStyle"
        )
        paragraph_styles.append(
            str(style_node.get(f"{_OOXML_W}val", "") if style_node is not None else "")
        )
    visible_text = "\n".join(paragraphs)

    page_sizes: list[tuple[int, int]] = []
    for page_size in root.iter(f"{_OOXML_W}pgSz"):
        try:
            page_sizes.append(
                (
                    int(page_size.get(f"{_OOXML_W}w", "0")),
                    int(page_size.get(f"{_OOXML_W}h", "0")),
                )
            )
        except ValueError:
            page_sizes.append((0, 0))
    if not page_sizes:
        issues.append(f"{path.name}: page size is not explicitly defined")
    else:
        expected = _A4_TWIPS
        for width, height in page_sizes:
            portrait = (
                abs(width - expected[0]) <= 160
                and abs(height - expected[1]) <= 160
            )
            landscape = (
                abs(width - expected[1]) <= 160
                and abs(height - expected[0]) <= 160
            )
            if not (portrait or landscape):
                issues.append(
                    f"{path.name}: page size {width}x{height} twips is not A4 "
                    f"({_A4_TWIPS[0]}x{_A4_TWIPS[1]})"
                )
                break

    placeholder_markers = (
        "\u53f3\u952e\u66f4\u65b0\u57df",  # 右键更新域
        "\u8bf7\u5728 word \u4e2d",  # 请在 Word 中
        "\u8bf7\u5728word\u4e2d",  # 请在Word中
        "\u66f4\u65b0\u76ee\u5f55\u57df",  # 更新目录域
        "\u76ee\u5f55\u5c06\u5728 word \u4e2d\u66f4\u65b0",  # 目录将在 Word 中更新
    )
    lowered_visible = visible_text.casefold()
    for marker in placeholder_markers:
        if marker in lowered_visible:
            issues.append(f"{path.name}: contains a manual-update placeholder ({marker})")
            break

    unfinished_markers = (
        "\u8bf7\u586b\u5199",  # 请填写
        "\u5f85\u586b\u5199",  # 待填写
        "\u5f85\u8865\u5145",  # 待补充
        "\u5f85\u5b8c\u5584",  # 待完善
        "\uff08\u4f5c\u8005\u59d3\u540d\uff09",  # （作者姓名）
        "\uff08\u4f5c\u8005\u5b66\u53f7\uff09",  # （作者学号）
        "\uff08\u6307\u5bfc\u6559\u5e08\u59d3\u540d\uff09",  # （指导教师姓名）
        "\uff08\u586b\u5199\u59d3\u540d\uff09",  # （填写姓名）
        "\uff08\u586b\u5199\u5b66\u53f7\uff09",  # （填写学号）
        "\uff08\u586b\u5199\u5bfc\u5e08\u59d3\u540d\uff09",  # （填写导师姓名）
        "todo",
        "tbd",
    )
    for marker in unfinished_markers:
        if marker in lowered_visible:
            issues.append(
                f"{path.name}: contains unfinished content placeholder "
                f"({marker}); replace it with final content or remove the field"
            )
            break

    raw_markup_paragraphs = {
        "---",
        "***",
        "___",
        "<!--pagebreak-->",
        "<!-- pagebreak -->",
        "```",
    }
    raw_markup = next(
        (
            paragraph.strip()
            for paragraph in paragraphs
            if paragraph.strip().casefold() in raw_markup_paragraphs
            or "<!--" in paragraph.casefold()
            or "-->" in paragraph.casefold()
        ),
        "",
    )
    if raw_markup:
        issues.append(
            f"{path.name}: contains raw Markdown/HTML source markup "
            f"({raw_markup}); render the intended formatting instead"
        )

    reference_index = next(
        (
            index
            for index, paragraph in enumerate(paragraphs)
            if "\u53c2\u8003\u6587\u732e" in paragraph.replace(" ", "")
        ),
        -1,
    )
    reference_text = "\n".join(paragraphs[reference_index + 1 :])
    reference_entries = re.findall(
        r"(?m)^\s*(?:[\[\uff3b]\s*\d+\s*[\]\uff3d]|\d+\s*[.\u3001])\s*\S+",
        reference_text,
    )
    if reference_index < 0 or len(reference_entries) < 5:
        issues.append(
            f"{path.name}: fewer than 5 embedded reference entries were found"
        )
    if "\u8be6\u89c1\u300a\u53c2\u8003\u6587\u732e.md\u300b" in visible_text:
        issues.append(
            f"{path.name}: references point to a companion Markdown file instead of being embedded"
        )

    if not proposal:
        if not any(paragraph.strip() == "\u6458\u8981" for paragraph in paragraphs):
            issues.append(
                f'{path.name}: missing the required visible heading "摘要"; '
                'the heading paragraph must be exactly "摘要" (not "中文摘要")'
            )
        if not any(
            paragraph.strip().casefold() == "abstract" for paragraph in paragraphs
        ):
            issues.append(f"{path.name}: missing a visible English Abstract heading")

        toc_index = next(
            (
                index
                for index, paragraph in enumerate(paragraphs)
                if paragraph.strip() == "\u76ee\u5f55"
            ),
            -1,
        )
        first_chapter_index = next(
            (
                index
                for index, (paragraph, style) in enumerate(
                    zip(paragraphs, paragraph_styles)
                )
                if index > toc_index
                and re.match(r"^\s*\u7b2c[0-9\u4e00-\u9fff]+\u7ae0", paragraph)
                and style.casefold().startswith(("heading", "\u6807\u9898"))
            ),
            len(paragraphs),
        )
        toc_slice = paragraphs[toc_index + 1 : first_chapter_index]
        toc_entries = [
            paragraph
            for paragraph in toc_slice
            if re.search(
                r"(?:\u7b2c[0-9\u4e00-\u9fff]+\u7ae0|\u6458\u8981|Abstract|\u53c2\u8003\u6587\u732e)",
                paragraph,
                re.IGNORECASE,
            )
        ]
        styled_toc_entries = sum(
            1
            for style in paragraph_styles
            if style.casefold().startswith("toc") and style.casefold() != "toctitle"
        )
        if toc_index < 0 or max(len(toc_entries), styled_toc_entries) < 5:
            issues.append(
                f"{path.name}: visible populated table of contents was not found; "
                "include at least 5 visible TOC entries in the generated document"
            )

    return issues


def _docx_unprovided_identity_issues(path: Path, task: str) -> list[str]:
    """Reject invented student/advisor identities in generated academic files.

    A missing cover value must not be "fixed" by fabricating a plausible name,
    student number, or advisor.  Anonymous/sample labels are acceptable, while
    a concrete value is accepted only when that value appeared in the user's
    request.
    """
    try:
        with zipfile.ZipFile(path) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
    except (OSError, KeyError, ET.ParseError, zipfile.BadZipFile):
        return []

    paragraphs = []
    for paragraph in root.iter(f"{_OOXML_W}p"):
        paragraphs.append(
            "".join(node.text or "" for node in paragraph.iter(f"{_OOXML_W}t")).strip()
        )
    task_compact = re.sub(r"\s+", "", str(task or "")).casefold()
    allowed_anonymous = ("匿名", "不适用", "非真实身份", "研究样稿")
    patterns = (
        ("student name", re.compile(r"^\s*(?:学生姓名|作者姓名)\s*[：:]\s*(.+?)\s*$")),
        ("student number", re.compile(r"^\s*学\s*号\s*[：:]\s*(.+?)\s*$")),
        ("advisor", re.compile(r"^\s*(?:指导教师|指导老师|导师)\s*[：:]\s*(.+?)\s*$")),
    )
    issues: list[str] = []
    for paragraph in paragraphs:
        for label, pattern in patterns:
            match = pattern.match(paragraph)
            if match is None:
                continue
            value = match.group(1).strip()
            value_compact = re.sub(r"\s+", "", value).casefold()
            omitted_value = not value_compact.strip("-—–_")
            if (
                not value_compact
                or omitted_value
                or value_compact in {"无", "n/a", "na"}
                or any(marker in value_compact for marker in allowed_anonymous)
            ):
                continue
            if value_compact not in task_compact:
                issues.append(
                    f"{path.name}: {label} value {value!r} was not provided by the user. "
                    "Do not invent personal identity data; mark the document as an "
                    "anonymous technical research sample or remove the field."
                )
    return issues


def _docx_markdown_source_coverage_issues(
    path: Path, *, proposal: bool, task: str
) -> list[str]:
    """Ensure a derived DOCX substantially covers its declared Markdown source."""
    task_text = str(task or "").casefold()
    if "markdown" not in task_text or not any(
        marker in task_text for marker in ("源稿", "source", "可追溯")
    ):
        return []
    source_root = path.parent / "src"
    if not source_root.is_dir():
        return []
    candidates = []
    for candidate in source_root.glob("*.md"):
        stem = candidate.stem
        is_proposal = "\u5f00\u9898" in stem
        is_thesis = "\u8bba\u6587" in stem and not is_proposal
        if (proposal and is_proposal) or (not proposal and is_thesis):
            candidates.append(candidate)
    if not candidates:
        return []
    source = max(candidates, key=lambda item: item.stat().st_size)
    try:
        source_text = source.read_text(encoding="utf-8", errors="replace")
        with zipfile.ZipFile(path) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
    except (OSError, KeyError, ET.ParseError, zipfile.BadZipFile):
        return []
    visible_text = "\n".join(
        "".join(node.text or "" for node in paragraph.iter(f"{_OOXML_W}t"))
        for paragraph in root.iter(f"{_OOXML_W}p")
    )
    source_text = re.sub(r"<!--.*?-->", "", source_text, flags=re.DOTALL)
    source_text = re.sub(r"```.*?```", "", source_text, flags=re.DOTALL)
    source_text = re.sub(r"[#*_`>|-]", "", source_text)
    source_chars = len(re.sub(r"\s+", "", source_text))
    visible_chars = len(re.sub(r"\s+", "", visible_text))
    if source_chars < 2_000:
        return []
    ratio = visible_chars / source_chars
    if ratio >= 0.65:
        return []
    return [
        f"{path.name}: derived DOCX contains only {ratio:.0%} of the largest "
        f"corresponding Markdown source ({source.name}). Regenerate the DOCX and "
        "PDF from the complete source instead of a shortened root copy."
    ]


def _academic_artifact_quality_issues(
    task: str, tool_calls_log: list[dict]
) -> list[str]:
    """Validate the newest proposal and thesis DOCX before a success answer."""
    if not _task_requires_academic_artifact_validation(task):
        return []
    paths = _successful_docx_paths(tool_calls_log)
    pdf_paths = _successful_pdf_paths(tool_calls_log)
    task_text = str(task or "").casefold()
    expects_proposal = "\u5f00\u9898\u62a5\u544a" in task_text
    expects_thesis = "\u8bba\u6587" in task_text or "thesis" in task_text
    expects_pdf = "pdf" in task_text
    issues: list[str] = []
    if expects_proposal:
        proposal = _latest_academic_docx(paths, proposal=True)
        if proposal is None:
            issues.append("required proposal DOCX was not found in successful tool evidence")
        else:
            issues.extend(_docx_academic_quality_issues(proposal, proposal=True))
            issues.extend(_docx_unprovided_identity_issues(proposal, task))
            issues.extend(
                _docx_markdown_source_coverage_issues(
                    proposal, proposal=True, task=task
                )
            )
        proposal_pdf = _latest_academic_pdf(pdf_paths, proposal=True)
        if proposal_pdf is None and proposal is not None:
            paired_pdf = proposal.with_suffix(".pdf")
            if paired_pdf.is_file():
                proposal_pdf = paired_pdf
        if proposal_pdf is not None:
            issues.extend(_pdf_academic_quality_issues(proposal_pdf, proposal=True))
        elif expects_pdf:
            issues.append("required proposal PDF was not found beside the validated DOCX")
    if expects_thesis:
        thesis = _latest_academic_docx(paths, proposal=False)
        if thesis is None:
            issues.append("required thesis DOCX was not found in successful tool evidence")
        else:
            issues.extend(_docx_academic_quality_issues(thesis, proposal=False))
            issues.extend(_docx_unprovided_identity_issues(thesis, task))
            issues.extend(
                _docx_markdown_source_coverage_issues(
                    thesis, proposal=False, task=task
                )
            )
        thesis_pdf = _latest_academic_pdf(pdf_paths, proposal=False)
        if thesis_pdf is None and thesis is not None:
            paired_pdf = thesis.with_suffix(".pdf")
            if paired_pdf.is_file():
                thesis_pdf = paired_pdf
        if thesis_pdf is not None:
            issues.extend(_pdf_academic_quality_issues(thesis_pdf, proposal=False))
        elif expects_pdf:
            issues.append("required thesis PDF was not found beside the validated DOCX")
    if _is_explicit_read_only_task(task):
        try:
            from arforge.tools.file_tools import get_workspace

            workspace = Path(get_workspace()).resolve()
            pending_workspace_writes: set[Path] = set()
            for call in tool_calls_log:
                if not call.get("success"):
                    continue
                tool = str(call.get("tool", "") or "")
                args = call.get("args") if isinstance(call.get("args"), dict) else {}
                target = str(
                    args.get("filename")
                    or args.get("path")
                    or args.get("file_path")
                    or args.get("file")
                    or ""
                ).strip()
                if not target:
                    continue
                candidate = Path(target)
                resolved = (
                    candidate.resolve()
                    if candidate.is_absolute()
                    else (workspace / candidate).resolve()
                )
                try:
                    resolved.relative_to(workspace)
                except ValueError:
                    continue
                if tool == "delete_file":
                    pending_workspace_writes.discard(resolved)
                elif tool in WRITE_TOOLS:
                    pending_workspace_writes.add(resolved)
            if pending_workspace_writes:
                names = ", ".join(
                    str(path.relative_to(workspace))
                    for path in sorted(pending_workspace_writes)
                )
                issues.append(
                    "Task explicitly prohibits modifying the active source workspace, "
                    f"but temporary writes remain there: {names}. Delete only those "
                    "turn-created helper files and verify the workspace is restored."
                )
        except Exception:
            pass
    return issues


def _task_requires_runtime_validation(task: str) -> bool:
    text = str(task or "").casefold()
    return any(
        marker in text
        for marker in (
            "run tests", "run the tests", "test the", "verify", "validate",
            "测试", "验证", "验收", "运行适用", "复测", "重新验证",
        )
    )


def _is_context_gathering_call(tool: str, args: dict, category: str) -> bool:
    """Detect reads disguised as disposable validation scripts.

    A real-world audit exhausted its step budget after the read-streak guard by
    repeatedly using ``run_script`` only to print slices of source files.  Such
    calls are still context gathering and must share the same bounded budget.
    """
    # Permission categories describe side effects, not task semantics.
    # Verification tools are intentionally read-only but still advance the
    # execution phase and must never be mistaken for more source gathering.
    if tool in VERIFY_TOOLS or tool in CONTROL_TOOLS:
        return False
    if category == "read":
        return True
    if tool != "run_script":
        return False
    code = str(args.get("code", "") or "")
    return bool(_SOURCE_READ_SCRIPT_RE.search(code)) and not bool(
        _VALIDATION_SCRIPT_RE.search(code)
    )


def _is_successful_verification(call: dict) -> bool:
    """Return whether a tool log entry is concrete successful test evidence."""
    if not call.get("success"):
        return False
    tool = str(call.get("tool", "") or "")
    if tool in VERIFY_TOOLS:
        output = str(call.get("output", "") or "")
        if _NO_VERIFICATION_EVIDENCE_RE.search(output):
            return False
        return True
    if tool in {"test_browser", "interact_browser"}:
        output = str(call.get("output", "") or "")
        if "Runtime issues: 0" not in output:
            return False
        # The browser can prove that it observed a page, but an interaction
        # proves completion only when an independent final-state check passed.
        # Keep old synthetic test fixtures compatible when they predate this
        # line; real browser output explicitly marks observation-only results.
        if "Final state verification: FAILED" in output:
            return False
        return True
    if tool == "read_office_document":
        # A successful round trip proves that the generated OOXML container is
        # readable and its user-visible text survived serialization.
        return True
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    if tool == "run_cmd":
        command = " ".join(str(args.get("command", "")).strip().split())
        if _TEST_COMMAND_RE.match(command):
            return True
        output = str(call.get("output", "") or "")
        validation_script = re.match(
            r'(?i)^(?:(?:node|python(?:3)?|py)(?:\.exe)?)\s+'
            r'["\']?([^"\']+\.(?:m?js|py))["\']?(?:\s|$)',
            command,
        )
        if (
            validation_script
            and _VALIDATION_COMMAND_SCRIPT_RE.search(validation_script.group(1))
            and _VALIDATION_SUCCESS_RE.search(output)
        ):
            return True
        # Inline audits are useful for one-off Desktop deliverables. Require
        # executable assertions plus an explicit pass marker so a command that
        # merely prints reassuring prose cannot satisfy the final gate.
        return bool(
            _VALIDATION_SUCCESS_RE.search(output)
            and _VALIDATION_SCRIPT_RE.search(command)
        )
    if tool == "get_background_output":
        output = str(call.get("output", "") or "")
        return bool(
            re.search(r"(?im)^status:\s*completed\s*$", output)
            and re.search(r"(?im)^exit_code:\s*0\s*$", output)
        )
    if tool == "run_script":
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        return bool(_VALIDATION_SCRIPT_RE.search(str(args.get("code", "") or "")))
    return False


def _task_requires_browser_runtime(task: str) -> bool:
    text = str(task or "").casefold()
    return any(
        marker in text
        for marker in (
            "real browser",
            "browser qa",
            "browser validation",
            "browser test",
            "真实浏览器",
            "浏览器 qa",
            "浏览器验证",
            "浏览器测试",
            "浏览器检查",
        )
    )


def _has_written_web_artifact(tool_calls_log: list[dict]) -> bool:
    for call in tool_calls_log:
        if not call.get("success") or call.get("tool") not in WRITE_TOOLS:
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        filename = str(
            args.get("filename") or args.get("path") or args.get("file") or ""
        ).casefold()
        if Path(filename).suffix in {".html", ".htm", ".css", ".js", ".mjs"}:
            return True
    return False


def _has_successful_browser_runtime(tool_calls_log: list[dict]) -> bool:
    return any(
        call.get("tool") in {"test_browser", "interact_browser"}
        and _is_successful_verification(call)
        for call in tool_calls_log
    )


def _claims_browser_validation(content: str) -> bool:
    """Detect concrete browser-test completion claims that require runtime evidence."""
    text = str(content or "").casefold()
    claims = (
        "tested in the browser",
        "browser test passed",
        "browser testing passed",
        "browser verified",
        "browser validation passed",
        "mobile responsive",
        "mobile layout works",
        "responsive layout works",
        "rendered correctly",
        "移动端适配",
        "响应式布局",
        "375px 设备",
        "375px设备",
        "页面渲染正确",
        "已在浏览器",
        "浏览器测试通过",
        "浏览器验收通过",
        "浏览器验证通过",
        "浏览器运行错误为 0",
        "浏览器运行错误为0",
    )
    if any(claim in text for claim in claims):
        return True
    browser_context = any(
        marker in text
        for marker in ("browser", "浏览器", "viewport", "视口", "移动端", "responsive")
    )
    completion_claim = bool(
        re.search(r"(?i)\b(?:passed|verified|successful|works?)\b|通过|完成|正常|✅", text)
    )
    return browser_context and completion_claim


_VIEWPORT_WIDTH_CLAIM_RE = re.compile(
    r"(?<!\d)(\d{3,4})(?:\s*px\b|\s*[x×]\s*\d{3,4}\b)",
    re.IGNORECASE,
)
_VIEWPORT_EVIDENCE_RE = re.compile(r"(?im)^Viewport:\s*(\d{3,4})x\d{3,4}\s*$")
_BROWSER_ZERO_ISSUES_RE = re.compile(r"(?im)^Runtime issues:\s*0\s*$")
_BROWSER_PROVISIONAL_TEXT_RE = re.compile(
    r"(?i)(?:正在加载|加载中|loading|please wait|长时间没有响应|npm run dev)"
)


def _claims_browser_error_path(content: str) -> bool:
    """Detect claims that a browser-hosted code runner's failure path was exercised."""
    text = str(content or "").casefold()
    runner_markers = ("pyodide", "coderunner", "code runner", "代码执行", "代码运行")
    failure_markers = (
        "错误路径", "异常路径", "异常代码", "失败路径",
        "error path", "failure path", "invalid code", "exception path",
    )
    return any(marker in text for marker in runner_markers) and any(
        marker in text for marker in failure_markers
    )


def _browser_visible_text_sample(output: str) -> str:
    """Return only rendered body text, excluding diagnostic field labels."""

    match = re.search(
        r"(?ims)^Visible text sample:\s*(.*?)"
        r"(?=^(?:Buttons|Interactive elements|Selects|Inputs|Runtime issues|"
        r"Console errors|Page errors|Network failures|HTTP errors):|\Z)",
        str(output or ""),
    )
    return match.group(1).strip() if match else ""


def _browser_result_is_meaningful(item: dict) -> bool:
    """Exclude a short loading shell from product-rendering evidence."""

    visible_text = _browser_visible_text_sample(item.get("output", ""))
    if not visible_text:
        return False
    return not (
        len(visible_text) < 200
        and _BROWSER_PROVISIONAL_TEXT_RE.search(visible_text)
    )


def _claimed_browser_output_markers(content: str) -> set[str]:
    """Extract explicit sentinel-style output tokens claimed as browser-visible."""

    text = str(content or "")
    markers = set(re.findall(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b", text))
    markers.update(
        re.findall(
            r"\b(?:ValueError|SyntaxError|TypeError|NameError|RuntimeError|"
            r"PythonError|Traceback)\b",
            text,
        )
    )
    if "❌" in text:
        markers.add("❌")
    return markers


_DIAGNOSTIC_BROWSER_PATH_RE = re.compile(
    r"(?i)(?:^|[-_/])(?:test(?:-runner)?|fixture|mock|harness|sandbox|"
    r"pyodide-test|pyodite-test)(?:[-_.?/#]|$)"
)


def _browser_targets_diagnostic_fixture(item: dict) -> bool:
    """Reject ad-hoc fixture pages as evidence for product UI claims."""

    args = item.get("args") if isinstance(item.get("args"), dict) else {}
    candidates = [str(args.get("url", "") or "")]
    final_url = re.search(r"(?im)^Final URL:\s*(\S+)", str(item.get("output", "") or ""))
    if final_url:
        candidates.append(final_url.group(1))
    return any(_DIAGNOSTIC_BROWSER_PATH_RE.search(candidate) for candidate in candidates)


def _browser_interaction_filled_and_clicked(item: dict) -> bool:
    args = item.get("args") if isinstance(item.get("args"), dict) else {}
    actions = args.get("actions") if isinstance(args.get("actions"), list) else []
    rendered_actions = [
        str(action if not isinstance(action, dict) else action.get("type", ""))
        .strip()
        .casefold()
        for action in actions
    ]
    filled = any(action.startswith("fill:") or action == "fill" for action in rendered_actions)
    clicked = any(action.startswith("click:") or action == "click" for action in rendered_actions)
    return filled and clicked


def _has_browser_error_path_evidence(tool_calls_log: list[dict]) -> bool:
    """Require an actual edit-and-run interaction plus visible handled-error output."""
    for item in tool_calls_log:
        if item.get("tool") != "interact_browser" or not item.get("success"):
            continue
        if _browser_targets_diagnostic_fixture(item):
            continue
        visible_text = _browser_visible_text_sample(item.get("output", ""))
        visible_error = bool(
            re.search(
                r"(?i)(?:❌|valueerror|syntaxerror|typeerror|traceback|\berror\b|错误|异常)",
                visible_text,
            )
        )
        if _browser_interaction_filled_and_clicked(item) and visible_error:
            return True
    return False


def _claims_missing_npm_package_version(content: str) -> bool:
    """Detect npm availability assertions that must be checked against the registry."""
    text = str(content or "").casefold()
    markers = (
        "npm 不存在", "npm不存在", "版本不存在", "包不存在",
        "does not exist on npm", "not available on npm", "missing from npm",
    )
    return any(marker in text for marker in markers)


def _has_npm_registry_evidence(tool_calls_log: list[dict]) -> bool:
    for item in tool_calls_log:
        if item.get("tool") != "run_cmd" or not item.get("success"):
            continue
        args = item.get("args") if isinstance(item.get("args"), dict) else {}
        command = " ".join(str(args.get("command", "") or "").split()).casefold()
        if re.match(r"^(?:npm|npm\.cmd)\s+(?:view|info|show)\b", command):
            return True
    return False


def _browser_evidence_matches_claims(content: str, tool_calls_log: list[dict]) -> bool:
    """Require successful browser evidence for every concrete claimed viewport width."""
    successful = [
        item
        for item in tool_calls_log
        if item.get("tool") in {"test_browser", "interact_browser"}
        and item.get("success")
        and _BROWSER_ZERO_ISSUES_RE.search(str(item.get("output", "") or ""))
    ]
    if not successful:
        return False
    if _claims_browser_error_path(content) and not _has_browser_error_path_evidence(
        tool_calls_log
    ):
        return False
    claimed_output_markers = _claimed_browser_output_markers(content)
    if claimed_output_markers:
        observed_output_markers: set[str] = set()
        runner_claim = _claims_browser_error_path(content) or any(
            marker in str(content or "").casefold()
            for marker in ("pyodide", "coderunner", "code runner", "代码执行", "代码运行")
        )
        marker_evidence = successful
        if runner_claim:
            marker_evidence = [
                item
                for item in successful
                if item.get("tool") == "interact_browser"
                and _browser_interaction_filled_and_clicked(item)
                and not _browser_targets_diagnostic_fixture(item)
            ]
        for item in marker_evidence:
            visible_text = _browser_visible_text_sample(item.get("output", ""))
            observed_output_markers.update(
                marker for marker in claimed_output_markers if marker in visible_text
            )
        if not claimed_output_markers.issubset(observed_output_markers):
            return False
    claimed_widths = {
        int(match.group(1))
        for match in _VIEWPORT_WIDTH_CLAIM_RE.finditer(str(content or ""))
        if 320 <= int(match.group(1)) <= 3840
    }
    if not claimed_widths:
        return True
    observed_widths: set[int] = set()
    for item in successful:
        if not _browser_result_is_meaningful(item):
            continue
        output = str(item.get("output", "") or "")
        observed_widths.update(
            int(match.group(1)) for match in _VIEWPORT_EVIDENCE_RE.finditer(output)
        )
    return claimed_widths.issubset(observed_widths)


def _is_disposable_helper_cleanup(call: dict) -> bool:
    if str(call.get("tool", "") or "") != "delete_file" or not call.get("success"):
        return False
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    target = str(
        args.get("filename") or args.get("path") or args.get("file") or ""
    )
    return bool(target and _TEMP_HELPER_RE.search(Path(target.replace("\\", "/")).name))


def _is_generated_build_cleanup(call: dict) -> bool:
    """Return whether a successful deletion only removes compiler output."""
    if str(call.get("tool", "") or "") != "delete_file" or not call.get("success"):
        return False
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    target = str(
        args.get("filename") or args.get("path") or args.get("file") or ""
    )
    if not target:
        return False
    path = Path(target.replace("\\", "/"))
    generated_directories = {
        "build",
        "build2",
        "out",
        "target",
        "bin",
        "obj",
        "__pycache__",
    }
    generated_suffixes = {
        ".class",
        ".pyc",
        ".o",
        ".obj",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
    }
    parents = {part.casefold() for part in path.parts[:-1]}
    return bool(
        parents.intersection(generated_directories)
        and path.suffix.casefold() in generated_suffixes
    )


def _cleanup_after_failed_validation_needs_verification(
    tool_calls_log: list[dict],
) -> bool:
    """Require recovery evidence when cleanup follows a failed validation.

    Removing a disposable audit helper after a successful validation is only
    housekeeping and should not trigger an unrelated project-wide test run.
    After a failed command or validation, however, accepting the cleanup as the
    final action would leave the failure unresolved.  In that case a later
    successful verification is required before the agent may report completion.
    """
    cleanup_seen = False
    validation_tools = VERIFY_TOOLS | {
        "run_cmd",
        "run_script",
        "test_browser",
        "interact_browser",
    }
    for call in reversed(tool_calls_log):
        if _is_successful_verification(call):
            return False
        if _is_disposable_helper_cleanup(call):
            cleanup_seen = True
            continue
        if (
            cleanup_seen
            and str(call.get("tool", "") or "") in validation_tools
            and not call.get("success")
        ):
            return True
    return False


def _has_verified_writes(tool_calls_log: list[dict]) -> bool:
    """Return whether the latest successful code write has later verification."""
    verified = False
    for call in reversed(tool_calls_log):
        if _is_successful_verification(call):
            verified = True
            continue
        if _is_disposable_helper_cleanup(call):
            continue
        if str(call.get("tool", "") or "") in WRITE_TOOLS and call.get("success"):
            return verified
    return False


def _has_grounding_tool_evidence(answer: str, tool_calls_log: list[dict]) -> bool:
    """Match file claims to successful tool evidence from this run.

    Read evidence is sufficient for inspection claims.  Non-code document
    writes are self-verifying at the file-tool boundary.  Code writes require
    a later successful verification before their claims are grounded.
    """
    normalized_answer = str(answer or "").replace("\\", "/").casefold()
    verified_writes = _has_verified_writes(tool_calls_log)
    file_read_tools = {
        "read_file", "code_read", "list_files", "list_code_files",
        "code_search", "search_code", "grep", "find_files",
    }
    for call in tool_calls_log:
        if not call.get("success"):
            continue
        tool = str(call.get("tool", "") or "")
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        if tool in {"test_browser", "interact_browser"} and _is_successful_verification(call):
            output = str(call.get("output", "") or "")
            browser_targets = [str(args.get("url") or "")]
            final_url = re.search(r"(?im)^Final URL:\s*(\S+)", output)
            if final_url:
                browser_targets.append(final_url.group(1))
            if any(
                target and target.casefold() in normalized_answer
                for target in browser_targets
            ):
                return True
        if _is_successful_verification(call):
            raw_targets = args.get("targets")
            verification_targets = (
                [str(item) for item in raw_targets if item]
                if isinstance(raw_targets, list)
                else []
            )
            for key in ("single_test", "test_name"):
                if args.get(key):
                    verification_targets.append(str(args[key]))
            if any(
                target.replace("\\", "/").casefold() in normalized_answer
                or Path(target.split("::", 1)[0]).name.casefold() in normalized_answer
                for target in verification_targets
            ):
                return True
        if tool not in file_read_tools and tool not in WRITE_TOOLS:
            continue
        target = str(
            args.get("filename") or args.get("path") or args.get("file") or ""
        ).replace("\\", "/")
        if not target:
            continue
        target_folded = target.casefold()
        basename_folded = Path(target).name.casefold()
        if target_folded not in normalized_answer and basename_folded not in normalized_answer:
            continue
        if tool in file_read_tools:
            return True
        suffix = Path(target).suffix.casefold()
        if suffix in NON_CODE_FILE_SUFFIXES or verified_writes:
            return True
    return False


def _count_writes_since_last_verify(tool_calls_log: list[dict]) -> int:
    """Return code-oriented writes that still require engineering verification.

    Plain user documents are verified by the file tool itself and, when
    requested, a read-back. Sending a .txt creation through syntax checks and
    impacted tests adds latency without increasing confidence.
    """
    count = 0
    for call in reversed(tool_calls_log):
        tool = str(call.get("tool", "") or "")
        if _is_successful_verification(call):
            break  # verification found, stop counting
        if tool in WRITE_TOOLS and call.get("success"):
            args = call.get("args") if isinstance(call.get("args"), dict) else {}
            target = str(
                args.get("filename") or args.get("path") or args.get("file") or ""
            )
            if _is_disposable_helper_cleanup(call) or _is_generated_build_cleanup(call):
                # Deleting a disposable audit/check helper after it has run is
                # cleanup, not a product mutation requiring project-wide tests.
                continue
            if target and Path(target).suffix.casefold() in NON_CODE_FILE_SUFFIXES:
                continue
            count += 1
    return count


def _verified_budget_completion(tool_calls_log: list[dict]) -> str | None:
    """Reuse an already delivered, verified result instead of another LLM call."""
    if not _has_verified_writes(tool_calls_log):
        return None
    if _count_writes_since_last_verify(tool_calls_log) > 0:
        return None
    for call in reversed(tool_calls_log):
        if call.get("tool") != "deliver_user_message" or not call.get("success"):
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        message = str(args.get("message") or "").strip()
        if message:
            return message
    return "[Arforge] Task completed and verification passed within the token budget."


def _unverified_writes_require_native_project_tests(
    tool_calls_log: list[dict],
) -> bool:
    """Return whether pending writes belong to the active source workspace.

    Desktop deliverables can live outside the repository. Their verification
    should use document/browser/targeted audit tools, never the unrelated
    repository's full native suite.
    """
    try:
        from arforge.tools.file_tools import get_workspace

        workspace = get_workspace().resolve()
    except Exception:
        return True

    for call in reversed(tool_calls_log):
        if _is_successful_verification(call):
            break
        tool = str(call.get("tool", "") or "")
        if tool not in WRITE_TOOLS or not call.get("success"):
            continue
        if _is_disposable_helper_cleanup(call):
            continue
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        target = str(
            args.get("filename") or args.get("path") or args.get("file") or ""
        )
        if target and Path(target).suffix.casefold() in NON_CODE_FILE_SUFFIXES:
            continue
        if not target:
            return True
        path = Path(target)
        if not path.is_absolute() and PureWindowsPath(target).is_absolute():
            # A Windows absolute path remains external when evidence is replayed
            # or validated on a non-Windows CI host.
            continue
        if not path.is_absolute():
            return True
        try:
            path.resolve().relative_to(workspace)
        except ValueError:
            continue
        return True
    return False


def _hooks():
    """返回"已启用且有注册 handler"的全局 HookManager；否则 None。

    None 时 run_tool_loop 完全旁路所有 fire 调用 —— 零开销、与无钩子时行为逐字节一致
    （HK-2 的 0 回归保证：默认未注册任何 handler）。
    """
    try:
        import config

        if not getattr(config, "HOOKS_ENABLED", True):
            return None
        mgr = get_hook_manager()
        return mgr if mgr.handler_count() else None
    except Exception:  # noqa: BLE001 - 钩子基础设施异常绝不能影响主循环
        return None


def _accepts_keyword(callable_obj, name: str) -> bool:
    try:
        parameters = inspect.signature(callable_obj).parameters
    except (TypeError, ValueError):
        return False
    return name in parameters or any(
        item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values()
    )


def _stream_call_with_deadline(
    stream_method,
    messages,
    stream_kwargs: dict,
    timeout_seconds: float | None,
):
    """Bound a provider stream even when its SDK timeout is inactivity-based."""
    deadline = None if timeout_seconds is None else max(0.01, float(timeout_seconds))
    expired = threading.Event()
    completed = threading.Event()
    result: list = []
    failure: list[BaseException] = []
    guarded_kwargs = dict(stream_kwargs)
    should_stop = guarded_kwargs.get("should_stop")

    content_callback = guarded_kwargs.get("on_content")
    content_buffer: list[str] = []
    content_mode = "pending"
    reasoning_markers = (
        "<understanding",
        "<thinking",
        "<evidence",
        "<reflection",
        "<answer",
    )

    if content_callback is not None:

        def guarded_content(piece):
            nonlocal content_mode
            if expired.is_set() or not piece:
                return
            if content_mode == "normal":
                content_callback(piece)
                return
            content_buffer.append(piece)
            probe = "".join(content_buffer).lstrip().lower()
            if any(marker in probe for marker in reasoning_markers):
                content_mode = "reasoning"
                return
            if _contains_registered_tool_markup(probe):
                content_mode = "tool"
                return
            if probe.startswith("<") and any(
                marker.startswith(probe) for marker in reasoning_markers
            ):
                return
            if len(probe) < 32:
                return
            content_mode = "normal"
            content_callback("".join(content_buffer))
            content_buffer.clear()

        guarded_kwargs["on_content"] = guarded_content

    reasoning_callback = guarded_kwargs.get("on_reasoning")
    if reasoning_callback is not None:

        def guarded_reasoning(piece):
            if not expired.is_set():
                reasoning_callback(piece)

        guarded_kwargs["on_reasoning"] = guarded_reasoning

    def invoke() -> None:
        try:
            result.append(stream_method(messages, **guarded_kwargs))
        except BaseException as exc:  # noqa: BLE001 - re-raised on the owner thread
            failure.append(exc)
        finally:
            completed.set()

    threading.Thread(
        target=invoke,
        name="arforge-model-stream",
        daemon=True,
    ).start()
    # Provider SDK calls can block before yielding their first stream chunk.
    # Poll the operation guard while waiting for the worker so a desktop
    # cancellation does not have to wait for the provider timeout to expire.
    wait_started = time.monotonic()
    while not completed.wait(0.05):
        if callable(should_stop) and should_stop():
            expired.set()
            raise InterruptedError("operation cancelled or timed out")
        if deadline is not None and time.monotonic() - wait_started >= deadline:
            expired.set()
            raise TimeoutError(f"model stream exceeded {deadline:g} seconds")
    if failure:
        raise failure[0]
    if content_callback is not None and content_mode == "pending" and content_buffer:
        content_callback("".join(content_buffer))
    return result[0]


def _call_with_deadline(
    call,
    timeout_seconds: float | None,
    should_stop=None,
):
    """Bound a non-streaming provider call and keep desktop cancellation responsive."""
    deadline = None if timeout_seconds is None else max(0.01, float(timeout_seconds))
    completed = threading.Event()
    result: list = []
    failure: list[BaseException] = []

    def invoke() -> None:
        try:
            result.append(call())
        except BaseException as exc:  # noqa: BLE001 - re-raised on the owner thread
            failure.append(exc)
        finally:
            completed.set()

    threading.Thread(
        target=invoke,
        name="arforge-model-call",
        daemon=True,
    ).start()
    wait_started = time.monotonic()
    while not completed.wait(0.05):
        if callable(should_stop) and should_stop():
            raise InterruptedError("operation cancelled or timed out")
        if deadline is not None and time.monotonic() - wait_started >= deadline:
            raise TimeoutError(f"model call exceeded {deadline:g} seconds")
    if failure:
        raise failure[0]
    return result[0]


def _is_transient_model_error(exc: BaseException) -> bool:
    """Classify provider failures that are safe to retry without changing state."""
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return True
    text = str(exc or "").casefold()
    if any(marker in text for marker in ("401", "403", "invalid api key", "authentication")):
        return False
    return any(
        marker in text
        for marker in (
            "timeout",
            "timed out",
            "rate limit",
            "too many requests",
            "too busy",
            "connection reset",
            "connection aborted",
            "connection refused",
            "temporarily unavailable",
            "service unavailable",
            "service_unavailable",
            "bad gateway",
            "gateway timeout",
            "http 429",
            "http 500",
            "http 502",
            "http 503",
            "http 504",
        )
    )


_REASONING_MARKUP = re.compile(
    r"</?(?:understanding|thinking|evidence|reflection|answer)\b",
    re.IGNORECASE,
)
_ANSWER_MARKUP = re.compile(r"<answer\b", re.IGNORECASE)


def _split_reasoning_markup(content: str) -> tuple[dict[str, str], str] | None:
    if not _REASONING_MARKUP.search(content or ""):
        return None
    parsed = parse_reasoning(content)
    sections = {
        key: str(getattr(parsed, key, "") or "")
        for key in ("understanding", "thinking", "evidence", "reflection")
    }
    answer = parsed.answer if _ANSWER_MARKUP.search(content) else ""
    return sections, answer


def run_tool_loop(
    adapter,
    messages,
    *,
    tools,
    max_steps: int | None = None,
    task: str = "",
    span_name: str = "agent.run",
    executor=None,
    on_token=None,
    on_answer_reset=None,
    on_intermediate=None,
    on_reasoning=None,
    on_tool_start=None,
    on_tool_complete=None,
    on_checkpoint=None,
    should_stop=None,
    model_timeout_seconds: float | None = None,
) -> ToolLoopResult:
    """运行 agentic 工具循环。

    adapter   : 需有 generate_with_tools(messages, tools, tool_choice) -> ToolCallResponse
                与 model_name 属性。
    messages  : 初始消息(含 system+user)；循环中原地追加 assistant/tool 消息。
    tools     : function-calling tools schema（调用方按需过滤白名单后传入）。
    max_steps : 最大迭代步数，防失控。
    executor  : 可选 callable(name, args) -> 含 .output/.success/.error/.elapsed_ms 的结果；
                用于绑定实例工具(如 Agentic RAG 的知识库检索)。None 时走全局 REGISTRY。

    事件钩子(HK-2)：在固定时点 fire PRE/POST_LLM_CALL、PRE/POST_TOOL_USE、STOP；
    PRE_LLM_CALL 可改写 messages(供自动压缩)、PRE_TOOL_USE 可 block/modify 工具调用。
    未注册任何 handler 时全部旁路，行为与原实现一致。
    """
    from arforge.core.task_complexity import estimate_complexity
    from arforge.core.change_tracker import install_change_tracker_hook

    # Every execution surface (CLI, desktop bridge, AgentRun, and sub-agents)
    # eventually enters this loop. Install tracking here so direct CLI/desktop
    # paths cannot bypass delivery verification infrastructure.
    install_change_tracker_hook()

    tier = estimate_complexity(task) if task else ComplexityTier.UNKNOWN
    _sanity_cap = max_steps if max_steps is not None else COMPLEXITY_STEPS[tier]
    tracer = Tracer()
    root = tracer.start_span(span_name, max_steps=_sanity_cap)
    hooks = _hooks()

    # 权限激活时(PM-3)：中央 decider 已在 PRE_TOOL_USE 裁决，工具执行包进 confirmed_operation
    # 以抑制 REGISTRY 层的二次确认（让"模式"成为唯一确认权威）。未激活则零影响。
    permission_active = False
    if hooks:
        try:
            from arforge.core.permission import get_permission_manager

            permission_active = get_permission_manager().is_active()
        except Exception:  # noqa: BLE001
            permission_active = False

    trace: list[dict] = []
    tool_calls_log: list[dict] = []
    seen_signatures: set = set()
    signature_outcomes: dict[tuple, bool] = {}
    workspace_revision = 0
    consecutive_read_calls = 0
    successful_verifications = 0
    validation_required = _task_requires_runtime_validation(task)
    temporary_helper_writes: dict[str, int] = {}
    sc_state = SelfCorrectState()
    answer = ""
    last_step = 0
    stop_reason = "final"
    final_answer_verifications_requested = 0
    browser_evidence_retries = 0
    academic_artifact_retries = 0
    registry_evidence_retries = 0
    evidence_retries = 0  # 3.1: evidence/grounding enforcement
    explicit_tool_requests: list[str] | None = None
    read_only_task = _is_explicit_read_only_task(task)
    cleanup_required = _task_requires_cleanup(task)
    cleanup_deadline_injected = False
    budget_evidence_fallback_used = False
    # sc12: auto test-fix loop — track test failures and auto re-run tests
    _test_fix_active: bool = False
    _test_fix_rerun_count: int = 0
    _MAX_TEST_RERUN = 8

    for step in range(1, _sanity_cap + 1):
        last_step = step

        if (
            cleanup_required
            and not cleanup_deadline_injected
            and _has_successful_browser_interaction(tool_calls_log)
            and not _browser_cleanup_verified(task, tool_calls_log)
            and step >= max(1, _sanity_cap - 7)
        ):
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "[CleanupDeadline] The task requires disposable-data cleanup and the run is "
                        "approaching its execution limit. Stop optional inspection. Use the existing "
                        "browser evidence to complete the required UI cleanup now, then perform one "
                        "post-delete browser check proving the fixture is absent before reporting."
                    ),
                }
            )
            cleanup_deadline_injected = True
            trace.append({"step": step, "event": "cleanup_deadline_injected"})

        # ---- 1.2 self-correct: inject reflection before LLM call ----
        reflection = sc_state.reflection_needed(step)
        if reflection:
            messages.append({"role": "user", "content": reflection})
            trace.append(
                {
                    "step": step,
                    "event": "self_correct_injected",
                    "reason": "repeated_same_class_error",
                }
            )
        if sc_state.is_hopeless():
            # is_hopeless() removed — agent never aborts due to error counts.
            pass  # Dead path: is_hopeless() always returns False.

        # PRE_LLM_CALL：观察 + 允许 handler 改写 messages（压缩 CC-3）或中止 run（预算守卫 HK-4）。
        if hooks:
            before_hook_count = len(messages)
            llm_ctx = HookContext(
                HookEvent.PRE_LLM_CALL,
                messages=messages,
                tracer=tracer,
                metadata={"step": step, "adapter": adapter, "task": task, "user_input": task},
            )
            pre_dec = hooks.fire(llm_ctx)
            if llm_ctx.messages is not None:
                messages = llm_ctx.messages
                if len(messages) > before_hook_count:
                    trace.append(
                        {
                            "step": step,
                            "event": "pre_llm_context_injected",
                            "added_messages": len(messages) - before_hook_count,
                            "labels": _context_injection_labels(
                                messages[before_hook_count:]
                            ),
                        }
                    )
            if pre_dec.action == "block":
                answer = f"[Arforge] 运行中止：{pre_dec.reason}"
                trace.append(
                    {"step": step, "event": "run_aborted", "reason": pre_dec.reason}
                )
                stop_reason = "aborted"
                break

        active_tools = tools() if callable(tools) else tools
        if explicit_tool_requests is None:
            explicit_tool_requests = _explicit_tool_requests(task, active_tools)
        completed_tool_names = {
            str(item.get("tool") or "")
            for item in tool_calls_log
            if item.get("success")
        }
        attempted_tool_names = {
            str(item.get("tool") or "") for item in tool_calls_log
        }
        pending_explicit_tools = [
            name
            for name in explicit_tool_requests
            if name not in completed_tool_names and name not in attempted_tool_names
        ]
        request_tools = active_tools
        tool_choice: str | dict = "auto"
        if pending_explicit_tools:
            required_name = pending_explicit_tools[0]
            narrowed = [
                item
                for item in active_tools
                if item.get("function", {}).get("name") == required_name
            ]
            if narrowed:
                request_tools = narrowed
                forced_choice_supported = bool(
                    getattr(adapter, "supports_forced_tool_choice", True)
                )
                if forced_choice_supported:
                    tool_choice = {
                        "type": "function",
                        "function": {"name": required_name},
                    }
                trace.append(
                    {
                        "step": step,
                        "event": (
                            "explicit_tool_required"
                            if forced_choice_supported
                            else "explicit_tool_narrowed_auto"
                        ),
                        "tool": required_name,
                    }
                )
        budget_synthesis_only = (
            step == _sanity_cap
            and not pending_explicit_tools
            and bool(tool_calls_log)
        )
        model_messages = messages
        if budget_synthesis_only:
            request_tools = None
            tool_choice = "none"
            model_messages = [
                *messages,
                {
                    "role": "user",
                    "content": (
                        "The execution step budget is now exhausted. Do not call any more tools. "
                        "Give the user a concise, evidence-based result from the tool outputs already present. "
                        "For an explicitly read-only audit, deliver the requested audit now. For a task that "
                        "requires changes, clearly separate verified work from unfinished or unverified work; "
                        "do not claim the overall task is complete unless the existing evidence proves it."
                    ),
                },
            ]
            trace.append({"step": step, "event": "budget_synthesis_reserved"})
        runtime_call = (
            _build_explicit_runtime_tool_call(
                task,
                pending_explicit_tools[0],
                step=step,
            )
            if pending_explicit_tools
            and not getattr(adapter, "requires_signed_tool_transcript", False)
            else None
        )
        if runtime_call is not None:
            resp = ToolCallResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[runtime_call],
                usage={},
            )
            usage = {}
            trace.append(
                {
                    "step": step,
                    "event": "explicit_tool_planned_locally",
                    "tool": runtime_call.name,
                }
            )
        else:
            llm_span = tracer.start_span("llm.call", step=step)
            from arforge.core.budget import TokenBudgetPreflightExceeded

            try:
                use_bounded_stream = hasattr(
                    adapter, "stream_generate_with_tools"
                ) and (
                    on_token is not None
                    or should_stop is not None
                    or model_timeout_seconds is not None
                )
                def invoke_model_once():
                    from arforge.core.budget import safe_completion_allowance

                    if should_stop is not None and should_stop():
                        raise InterruptedError("operation cancelled or timed out")
                    completion_allowance = safe_completion_allowance(
                        model_messages,
                        request_tools,
                    )
                    if completion_allowance == 0:
                        raise TokenBudgetPreflightExceeded(
                            "run token budget cannot fit the next prompt"
                        )
                    if use_bounded_stream:
                        stream_method = adapter.stream_generate_with_tools
                        stream_kwargs = {
                            "tools": request_tools,
                            "tool_choice": tool_choice,
                        }
                        if completion_allowance is not None and _accepts_keyword(
                            stream_method, "max_tokens"
                        ):
                            stream_kwargs["max_tokens"] = completion_allowance
                        if on_token is not None and _accepts_keyword(
                            stream_method, "on_content"
                        ):
                            stream_kwargs["on_content"] = on_token
                        if on_reasoning is not None and _accepts_keyword(
                            stream_method, "on_reasoning"
                        ):
                            stream_kwargs["on_reasoning"] = on_reasoning
                        if should_stop is not None and _accepts_keyword(
                            stream_method, "should_stop"
                        ):
                            stream_kwargs["should_stop"] = should_stop
                        if model_timeout_seconds is not None and _accepts_keyword(
                            stream_method, "timeout"
                        ):
                            stream_kwargs["timeout"] = model_timeout_seconds
                        return _stream_call_with_deadline(
                            stream_method,
                            model_messages,
                            stream_kwargs,
                            model_timeout_seconds,
                        )

                    def call():
                        generate_method = adapter.generate_with_tools
                        budget_kwargs = {}
                        if completion_allowance is not None and _accepts_keyword(
                            generate_method, "max_tokens"
                        ):
                            budget_kwargs["max_tokens"] = completion_allowance
                        return adapter.generate_with_tools(
                            model_messages,
                            tools=request_tools,
                            tool_choice=tool_choice,
                            **budget_kwargs,
                        )

                    if should_stop is not None or model_timeout_seconds is not None:
                        return _call_with_deadline(
                            call,
                            model_timeout_seconds,
                            should_stop,
                        )
                    return call()

                for model_attempt in range(1, 3):
                    try:
                        resp = invoke_model_once()
                        break
                    except InterruptedError:
                        raise
                    except Exception as exc:
                        retry_window_available = (
                            model_timeout_seconds is None
                            or float(model_timeout_seconds) >= 1.0
                        )
                        if (
                            model_attempt >= 2
                            or not retry_window_available
                            or not _is_transient_model_error(exc)
                        ):
                            raise
                        trace.append(
                            {
                                "step": step,
                                "event": "model_retry",
                                "attempt": model_attempt,
                                "error": str(exc)[:300],
                            }
                        )
                        if on_answer_reset is not None:
                            on_answer_reset()
            except TokenBudgetPreflightExceeded as exc:
                verified_answer = _verified_budget_completion(tool_calls_log)
                if verified_answer:
                    tracer.end_span(llm_span, status="ok")
                    trace.append(
                        {
                            "step": step,
                            "event": "budget_completion_reused",
                            "reason": str(exc),
                        }
                    )
                    answer = verified_answer
                    stop_reason = "final"
                else:
                    tracer.end_span(llm_span, status="error")
                    trace.append(
                        {"step": step, "event": "run_aborted", "reason": str(exc)}
                    )
                    answer = f"[Arforge] 运行中止：{exc}"
                    stop_reason = "token_budget_exceeded"
                break
            except Exception as exc:
                tracer.end_span(llm_span, status="error")
                trace.append({"step": step, "event": "model_error", "error": str(exc)})
                answer = f"[Arforge] 模型调用失败：{exc}"
                stop_reason = "model_error"
                break
            usage = getattr(resp, "usage", None) or {}
            tracer.record_llm(
                llm_span,
                model=getattr(adapter, "model_name", "unknown"),
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                cache_hit_tokens=usage.get("prompt_cache_hit_tokens", 0),
            )
            tracer.end_span(llm_span)

        if budget_synthesis_only and (
            resp.tool_calls or _looks_like_unexecuted_tool_text(resp.content or "")
        ):
            # Some compatible providers ignore ``tool_choice=none`` or emit a
            # text imitation of a tool call. Never execute either after the
            # delivery turn was reserved; report from isolated evidence instead.
            trace.append(
                {
                    "step": step,
                    "event": "budget_tool_call_blocked",
                    "tools": [call.name for call in resp.tool_calls],
                }
            )
            if not resp.tool_calls:
                trace.append(
                    {
                        "step": step,
                        "event": "unexecuted_tool_text_blocked",
                        "phase": "max_steps",
                    }
                )
            answer, used_fallback = _finalize_from_evidence(
                adapter,
                task=task,
                tool_calls_log=tool_calls_log,
                max_steps=_sanity_cap,
            )
            budget_evidence_fallback_used = (
                budget_evidence_fallback_used or used_fallback
            )
            if used_fallback and not any(
                item.get("event") == "unexecuted_tool_text_blocked"
                and item.get("phase") == "max_steps"
                and item.get("step") == step
                for item in trace
            ):
                trace.append(
                    {
                        "step": step,
                        "event": "unexecuted_tool_text_blocked",
                        "phase": "max_steps",
                    }
                )
            resp = ToolCallResponse(
                content=answer,
                finish_reason="stop",
                tool_calls=[],
                usage={},
            )

        if not resp.tool_calls:
            recovered_tool_calls = _parse_xml_tool_calls(
                resp.content or ""
            ) or _parse_json_tool_calls(resp.content or "")
            if recovered_tool_calls:
                if on_answer_reset is not None and resp.content:
                    on_answer_reset()
                resp.tool_calls = recovered_tool_calls
                resp.content = ""
                trace.append(
                    {
                        "step": step,
                        "event": "text_tool_call_recovered",
                        "tools": [item.name for item in recovered_tool_calls],
                    }
                )

        if hooks:
            hooks.fire(
                HookContext(
                    HookEvent.POST_LLM_CALL,
                    messages=messages,
                    tracer=tracer,
                    metadata={
                        "step": step,
                        "usage": usage,
                        "task": task,
                        "user_input": task,
                        "assistant_response": resp.content or "",
                        "is_final_candidate": not bool(resp.tool_calls),
                    },
                )
            )

        if not resp.tool_calls:
            answer = resp.content or ""
            reasoning_markup = _split_reasoning_markup(answer)
            if reasoning_markup is not None:
                sections, clean_answer = reasoning_markup
                if on_answer_reset is not None and answer:
                    on_answer_reset()
                if on_reasoning is not None:
                    for section in (
                        "understanding",
                        "thinking",
                        "evidence",
                        "reflection",
                    ):
                        content = sections[section]
                        if content:
                            on_reasoning(content)
                if clean_answer:
                    answer = clean_answer
                    if on_token is not None:
                        on_token(clean_answer)
                else:
                    trace.append(
                        {
                            "step": step,
                            "event": "reasoning_only_response_blocked",
                            "chars": len(answer),
                        }
                    )
                    messages.append({"role": "assistant", "content": answer})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "That response contained reasoning but no final answer or tool call. "
                                "Continue now: use the available tool API when the task requires evidence, "
                                "then return a concise final answer without XML reasoning tags."
                            ),
                        }
                    )
                    answer = ""
                    continue
            if _looks_like_unexecuted_tool_text(answer):
                if on_answer_reset is not None and answer:
                    on_answer_reset()
                trace.append(
                    {
                        "step": step,
                        "event": "unexecuted_tool_text_blocked",
                        "chars": len(answer),
                    }
                )
                messages.append(
                    {
                        "role": "assistant",
                        "content": answer,
                    }
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "You emitted a tool call as plain text, so it was not executed. "
                            "Continue the task by making a real tool call through the tool API, "
                            "or give a final natural-language answer only if the requested work "
                            "has already been verified by executed tools."
                        ),
                    }
                )
                answer = ""
                continue
            completed_tool_names = {
                str(item.get("tool") or "")
                for item in tool_calls_log
                if item.get("success")
            }
            pending_explicit_tools = [
                name
                for name in (explicit_tool_requests or [])
                if name not in completed_tool_names
            ]
            if pending_explicit_tools:
                if on_answer_reset is not None and answer:
                    on_answer_reset()
                required_name = pending_explicit_tools[0]
                trace.append(
                    {
                        "step": step,
                        "event": "explicit_tool_completion_blocked",
                        "tool": required_name,
                    }
                )
                messages.append({"role": "assistant", "content": answer})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"The requested `{required_name}` tool has not been executed successfully. "
                            "Call it through the provided function API now. Do not describe or print "
                            "the call as text, and do not claim completion before its result is available."
                        ),
                    }
                )
                answer = ""
                continue
            # When the user explicitly requires real-browser QA, merely opening
            # an HTML file or honestly admitting that QA was skipped is not a
            # completed delivery.  Require runtime evidence after a web
            # artifact write even if the final prose makes no success claim.
            if (
                _task_requires_browser_runtime(task)
                and _has_written_web_artifact(tool_calls_log)
                and not _has_successful_browser_runtime(tool_calls_log)
            ):
                browser_evidence_retries += 1
                trace.append(
                    {
                        "step": step,
                        "event": "required_browser_evidence_missing",
                        "retry": browser_evidence_retries,
                    }
                )
                if browser_evidence_retries <= 1:
                    messages.append({"role": "assistant", "content": answer})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "The original task explicitly requires real-browser QA for the "
                                "web deliverable. open_file, static scripts, and a launch-only "
                                "preview are not sufficient. Call test_browser at the required "
                                "desktop and mobile viewports and use interact_browser for the "
                                "required controls. Fix any runtime, network, overflow, or "
                                "interaction failures before declaring completion."
                            ),
                        }
                    )
                    if on_answer_reset is not None and answer:
                        on_answer_reset()
                    answer = ""
                    continue
                answer = (
                    "[Arforge] Task incomplete: the original request required real-browser "
                    "QA, but no successful test_browser/interact_browser evidence was "
                    "produced after the web artifact was written."
                )
                stop_reason = "browser_verification_missing"
                break
            academic_issues = _academic_artifact_quality_issues(task, tool_calls_log)
            if academic_issues:
                academic_artifact_retries += 1
                trace.append(
                    {
                        "step": step,
                        "event": "academic_artifact_quality_failed",
                        "retry": academic_artifact_retries,
                        "issues": academic_issues,
                    }
                )
                if academic_artifact_retries <= 2:
                    messages.append({"role": "assistant", "content": answer})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "The academic DOCX deliverables do not yet meet the original "
                                "standard-format requirement. Correct every issue below, regenerate "
                                "the derived PDFs, inspect all rendered pages, and run an assertion-"
                                "based audit before declaring completion:\n- "
                                + "\n- ".join(academic_issues)
                            ),
                        }
                    )
                    if on_answer_reset is not None and answer:
                        on_answer_reset()
                    answer = ""
                    continue
                answer = (
                    "[Arforge] Task incomplete: the academic deliverables still fail the "
                    "required format/content gate after correction attempts:\n- "
                    + "\n- ".join(academic_issues)
                )
                stop_reason = "academic_artifact_quality_failed"
                break
            # Final answer gate: if files were written but never verified, require verification
            writes_since_last_verify = _count_writes_since_last_verify(tool_calls_log)
            cleanup_recovery_unverified = (
                _cleanup_after_failed_validation_needs_verification(tool_calls_log)
            )
            if writes_since_last_verify > 0 or cleanup_recovery_unverified:
                trace.append(
                    {
                        "step": step,
                        "event": "final_answer_verification_required",
                        "unverified_writes": writes_since_last_verify,
                        "cleanup_recovery_unverified": cleanup_recovery_unverified,
                    }
                )
                final_answer_verifications_requested += 1
                if final_answer_verifications_requested > 1:
                    # The model ignored the verification request twice.  A prose
                    # claim is not evidence: terminate honestly instead of
                    # reporting the task as completed.
                    answer = (
                        "[Arforge] Task incomplete: file changes were made, but no "
                        "successful verification was executed after the final write. "
                        "Continue the task, run the project's tests or an applicable "
                        "verification tool, then report the verified result."
                    )
                    trace.append(
                        {
                            "step": step,
                            "event": "verification_missing_terminal",
                            "chars": len(answer),
                        }
                    )
                    stop_reason = "verification_missing"
                    break

                # sc8+sc10: run programmatic consistency check on modified files
                consistency_feedback = ""
                try:
                    from arforge.core.self_correct import (
                        verify_edited_files,
                        build_consistency_feedback,
                        verify_all_imports,
                        build_import_feedback,
                    )

                    modified = []
                    for entry in tool_calls_log:
                        tool = str(entry.get("tool", "") or "")
                        if tool in WRITE_TOOLS and entry.get("success"):
                            filename = (
                                entry.get("args", {}).get("filename")
                                or entry.get("args", {}).get("path")
                                or entry.get("args", {}).get("file")
                                or ""
                            )
                            if filename:
                                try:
                                    from arforge.tools.file_tools import (
                                        WORKSPACE as _ws,
                                    )
                                    from pathlib import Path as _P

                                    p = _P(filename)
                                    if not p.is_absolute():
                                        p = _ws / p
                                    modified.append(str(p.resolve()))
                                except Exception:
                                    modified.append(filename)
                    if modified:
                        # sc8: syntax check
                        ok_syntax, syntax_issues = verify_edited_files(modified)
                        # sc10: import resolution
                        ok_imports, import_issues = verify_all_imports(modified)
                        all_issues = syntax_issues + import_issues
                        if all_issues:
                            consistency_feedback = (
                                build_consistency_feedback(syntax_issues)
                                if syntax_issues
                                else ""
                            )
                            if import_issues:
                                if consistency_feedback:
                                    consistency_feedback += "\n\n"
                                consistency_feedback += build_import_feedback(
                                    import_issues
                                )
                            trace.append(
                                {
                                    "step": step,
                                    "event": "consistency_check_failed",
                                    "syntax_issues": len(syntax_issues),
                                    "import_issues": len(import_issues),
                                }
                            )
                except Exception:
                    pass  # consistency check is best-effort, never block the loop

                messages.append(
                    {
                        "role": "assistant",
                        "content": answer,
                    }
                )
                if _unverified_writes_require_native_project_tests(tool_calls_log):
                    verify_msg = (
                        "You declared the task complete without verifying the source changes you made. "
                        "Call run_tests to detect and run the project's native full test suite. "
                        "Use verify_work for additional static checks only when it applies to this project. "
                        "Do not call a language-specific verification tool that does not match the project. "
                        "Only declare completion after verification passes. If verification reveals issues, "
                        "fix them and re-verify."
                    )
                else:
                    verify_msg = (
                        "You declared the task complete without verification after the final external "
                        "artifact write. Do not run the active repository's unrelated full test suite. "
                        "Use the applicable targeted evidence instead: read_office_document for Office "
                        "files, test_browser/interact_browser for web UI, or an assertion-based audit "
                        "script for the delivered files. Fix failures, clean up disposable helpers, and "
                        "only then declare completion."
                    )
                if consistency_feedback:
                    verify_msg += "\n\n" + consistency_feedback
                messages.append(
                    {
                        "role": "user",
                        "content": verify_msg,
                    }
                )
                if on_answer_reset is not None and answer:
                    on_answer_reset()
                answer = ""
                continue

            # A launched file is not browser evidence. Refuse concrete browser
            # completion claims unless the real runtime tool succeeded in this
            # turn. One retry lets the model perform the missing validation;
            # a second unsupported claim is converted to an honest incomplete
            # result rather than being shown to the user as a success.
            if (
                _claims_browser_validation(answer) or _claims_browser_error_path(answer)
            ) and not _browser_evidence_matches_claims(answer, tool_calls_log):
                browser_evidence_retries += 1
                trace.append({
                    "step": step,
                    "event": "browser_evidence_required",
                    "retry": browser_evidence_retries,
                })
                if browser_evidence_retries <= 1:
                    messages.append({"role": "assistant", "content": answer})
                    messages.append({
                        "role": "user",
                        "content": (
                            "You claimed browser validation, but this turn has no successful "
                              "test_browser or interact_browser result. open_file and check_page are not runtime evidence. "
                              "Call test_browser for read-only diagnostics or interact_browser for approved actions, "
                              "then report the concrete viewport, interactions, "
                            "and runtime issues, or explicitly state that browser validation was not performed."
                            " Every claimed Npx viewport width must appear exactly as Viewport: NxH "
                              "in a successful browser result."
                        ),
                    })
                    if on_answer_reset is not None and answer:
                        on_answer_reset()
                    answer = ""
                    continue
                answer = (
                    "[Arforge] Task incomplete: the generated answer claimed browser validation, "
                      "but no successful test_browser/interact_browser evidence exists in this turn. No browser-test "
                    "success is being reported. Continue the task and run real browser validation."
                )
                trace.append({
                    "step": step,
                    "event": "browser_verification_missing_terminal",
                })
                stop_reason = "browser_verification_missing"
                break

            # Package availability is temporally unstable and cannot be inferred
            # from a local install failure. Require a successful npm registry query
            # before a final answer declares a package/version nonexistent.
            if _claims_missing_npm_package_version(answer) and not _has_npm_registry_evidence(
                tool_calls_log
            ):
                registry_evidence_retries += 1
                trace.append({
                    "step": step,
                    "event": "registry_evidence_required",
                    "retry": registry_evidence_retries,
                })
                if registry_evidence_retries <= 1:
                    messages.append({"role": "assistant", "content": answer})
                    messages.append({
                        "role": "user",
                        "content": (
                            "You claimed that an npm package or version does not exist, but this turn "
                            "has no successful `npm view`, `npm info`, or `npm show` result. Query the "
                            "registry for the exact package and version before making availability "
                            "claims, or remove the unsupported claim."
                        ),
                    })
                    if on_answer_reset is not None and answer:
                        on_answer_reset()
                    answer = ""
                    continue
                answer = (
                    "[Arforge] Task incomplete: the answer declares an npm package or version "
                    "unavailable without successful registry evidence. Continue the task and query "
                    "the exact package/version before reporting completion."
                )
                trace.append({
                    "step": step,
                    "event": "registry_evidence_missing_terminal",
                })
                stop_reason = "registry_evidence_missing"
                break

            # 3.1: Evidence/grounding enforcement — require <evidence> tags for file-related answers
            evidence_check = validate_evidence(answer, tool_calls_log)
            if (
                evidence_check["needs_evidence"]
                and not evidence_check["valid"]
                and _has_grounding_tool_evidence(answer, tool_calls_log)
            ):
                evidence_check = {
                    "valid": True,
                    "needs_evidence": True,
                    "missing_citations": [],
                }
                trace.append(
                    {
                        "step": step,
                        "event": "evidence_grounded_by_execution",
                    }
                )
            if evidence_check["needs_evidence"] and not evidence_check["valid"]:
                evidence_retries += 1
                trace.append(
                    {
                        "step": step,
                        "event": "evidence_required",
                        "missing": evidence_check["missing_citations"],
                    }
                )
                if evidence_retries <= 1:
                    # Inject evidence feedback and continue (max 1 retry)
                    messages.append({"role": "assistant", "content": answer})
                    messages.append(
                        {
                            "role": "user",
                            "content": build_evidence_feedback(
                                evidence_check["missing_citations"]
                            ),
                        }
                    )
                    if on_answer_reset is not None and answer:
                        on_answer_reset()
                    answer = ""
                    continue
                # Evidence retries exhausted.  Do not turn an unsupported file
                # claim into a successful task result.
                trace.append(
                    {
                        "step": step,
                        "event": "evidence_missing_terminal",
                        "retries": evidence_retries,
                    }
                )
                answer = (
                    "[Arforge] Task incomplete: the answer contains file or code claims "
                    "that are not grounded in executed tool evidence. Continue the task "
                    "and inspect or verify the referenced files before reporting completion."
                )
                stop_reason = "evidence_missing"
                break

            budget_delivery_is_final = (
                not budget_evidence_fallback_used
                and (read_only_task or successful_verifications > 0)
                and (not cleanup_required or _browser_cleanup_verified(task, tool_calls_log))
                and not _answer_declares_incomplete(answer)
            )
            if budget_synthesis_only and not budget_delivery_is_final:
                trace.append(
                    {
                        "step": step,
                        "event": "max_steps_reached",
                        "chars": len(answer),
                        "delivery_reserved": True,
                    }
                )
                stop_reason = "max_steps"
            elif (
                not read_only_task
                and _task_requires_delivery(task)
                and _answer_declares_incomplete(answer)
            ):
                trace.append(
                    {
                        "step": step,
                        "event": "task_incomplete_declared",
                        "chars": len(answer),
                    }
                )
                stop_reason = "task_incomplete"
            else:
                trace.append({"step": step, "event": "final", "chars": len(answer)})
                stop_reason = "final"
            break

        if on_intermediate is not None and resp.content and resp.content.strip():
            # Preserve the model's user-facing progress note before the tool call.
            # It is not part of the final answer, but desktop clients use it to
            # build an ordered work transcript instead of a detached tool log.
            on_intermediate(resp.content.strip())
        if on_answer_reset is not None and resp.content:
            # Content emitted alongside tool calls is an intermediate preamble,
            # not the final user-visible answer.
            on_answer_reset()

        parsed = []
        for tc in resp.tool_calls:
            try:
                args = json.loads(tc.arguments) if tc.arguments else {}
                if not isinstance(args, dict):
                    args = {}
            except (json.JSONDecodeError, TypeError):
                args = {}
            original_args = dict(args)
            args = _repair_tool_arguments_from_task(task, tc.name, args)
            if args != original_args:
                tc.arguments = json.dumps(args, ensure_ascii=False)
                trace.append(
                    {
                        "step": step,
                        "event": "tool_arguments_recovered",
                        "tool": tc.name,
                        "arguments": sorted(args),
                    }
                )
            parsed.append((tc, args))

        assistant_tool_message = {
            "role": "assistant",
            "content": resp.content or "",
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": tc.arguments or "{}"},
                }
                for tc, _ in parsed
            ],
        }
        provider_content = getattr(resp, "provider_content", None)
        if isinstance(provider_content, list) and provider_content:
            repaired_by_id = {tc.id: args for tc, args in parsed}
            assistant_tool_message["provider_content"] = [
                {
                    **dict(block),
                    **(
                        {"input": repaired_by_id[str(block.get("id", ""))]}
                        if block.get("type") == "tool_use"
                        and str(block.get("id", "")) in repaired_by_id
                        else {}
                    ),
                }
                for block in provider_content
                if isinstance(block, dict)
            ]
        if hasattr(adapter, "last_reasoning_content"):
            reasoning_content = str(
                getattr(resp, "reasoning_content", "")
                or getattr(adapter, "last_reasoning_content", "")
                or "The runtime planned the explicitly requested tool call."
            )
            assistant_tool_message["reasoning_content"] = reasoning_content
        messages.append(assistant_tool_message)

        raw_signature = tuple(
            sorted(
                f"{tc.name}:{json.dumps(a, sort_keys=True, ensure_ascii=False)}"
                for tc, a in parsed
            )
        )
        contains_write = any(tc.name in WRITE_TOOLS for tc, _ in parsed)
        # Reads and commands are state-sensitive: after a successful write the
        # same test/read is a new observation and must be allowed.  Writes stay
        # globally scoped so an identical edit cannot be replayed indefinitely.
        signature = (
            "write" if contains_write else f"workspace:{workspace_revision}",
            raw_signature,
        )
        if signature in seen_signatures:
            previous_success = signature_outcomes.get(signature)
            trace_event = (
                "repeat_success_blocked"
                if previous_success
                else "self_correct_repeat_blocked"
            )
            trace.append(
                {
                    "step": step,
                    "event": trace_event,
                    "tools": [tc.name for tc, _ in parsed],
                }
            )
            trace.append(
                {
                    "step": step,
                    "event": "loop_detected",
                    "tools": [tc.name for tc, _ in parsed],
                }
            )
            for tc, _ in parsed:
                msg = (
                    "ERROR: repeated identical failed tool call blocked. Analyze the previous "
                    "error and change the tool, command, arguments, or file context before trying again."
                    if previous_success is False
                    else "ERROR: repeated identical call aborted to avoid an infinite loop."
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": msg,
                    }
                )
                if previous_success is False:
                    sc_state.record(error_text=msg, tool_name=tc.name, step=step)
                    messages.append(
                        {
                            "role": "user",
                            "content": sc_state.failure_feedback(
                                error_text=msg, tool_name=tc.name, step=step
                            ),
                        }
                    )
                    tool_calls_log.append(
                        {
                            "tool": tc.name,
                            "args": {},
                            "success": False,
                            "step": step,
                            "blocked_repeat": True,
                        }
                    )
            if previous_success is False:
                continue
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "The exact same tool call already succeeded. Do not repeat it. "
                        "Use the existing executed result to decide the next distinct step, "
                        "or provide a final natural-language answer if the task is complete. "
                        "Do not print tool-call markup as plain text."
                    ),
                }
            )
            continue
        seen_signatures.add(signature)

        # PRE_TOOL_USE：逐工具门控(block/modify)。无注册 handler 时 effective 与 parsed 等价、零改变。
        if hooks:
            effective = []  # (tc, eff_args, blocked_reason | None)
            for tc, args in parsed:
                tool_ctx = HookContext(
                    HookEvent.PRE_TOOL_USE,
                    tool_name=tc.name,
                    tool_args=dict(args),
                    messages=messages,
                    tracer=tracer,
                    metadata={"step": step, "task": task, "user_input": task},
                )
                dec = hooks.fire(tool_ctx)
                eff_args = (
                    tool_ctx.tool_args if tool_ctx.tool_args is not None else args
                )
                blocked = (
                    dec.reason or f"blocked by hook ({dec.action})"
                    if dec.action in ("block", "ask")
                    else None
                )
                effective.append((tc, eff_args, blocked))
        else:
            effective = [(tc, args, None) for tc, args in parsed]

        # Progress guards catch changing-argument loops that exact-signature
        # detection cannot see. They return actionable tool feedback instead
        # of letting a task spend its entire budget reading or rewriting
        # disposable helper files inside the user's project.
        for index, (tc, eff_args, blocked) in enumerate(effective):
            if blocked is not None:
                continue
            definition = REGISTRY.get(tc.name)
            category = definition.schema.category if definition is not None else "read"
            context_gathering = _is_context_gathering_call(
                tc.name, eff_args, category
            )
            context_limit = (
                _VALIDATION_CONTEXT_LIMIT
                if validation_required and successful_verifications == 0
                else _MAX_CONSECUTIVE_READ_CALLS
            )
            if (
                cleanup_required
                and _has_successful_browser_interaction(tool_calls_log)
                and not _browser_cleanup_verified(task, tool_calls_log)
            ):
                context_limit = min(context_limit, 5)
            if context_gathering and consecutive_read_calls >= context_limit:
                if validation_required and successful_verifications == 0:
                    reason = (
                        "[ExecutionProtocol] Baseline validation is overdue after "
                        f"{consecutive_read_calls} context-gathering calls. Stop reading source, "
                        "including through run_script. Run one applicable direct project test, "
                        "syntax check, verify_work, or browser validation now. If the toolchain "
                        "is unavailable, report that concrete blocker instead of continuing to read."
                    )
                    event = "validation_overdue_blocked"
                else:
                    reason = (
                        "[ProgressGuard] Too many consecutive context-gathering calls without a "
                        "successful write, command, or runtime validation. Stop reading source, "
                        "including through run_script: synthesize the evidence already collected, "
                        "take the next justified action, or return an explicit incomplete report."
                    )
                    event = "read_streak_blocked"
                effective[index] = (tc, eff_args, reason)
                trace.append({
                    "step": step,
                    "event": event,
                    "tool": tc.name,
                    "count": consecutive_read_calls,
                })
                continue
            if tc.name not in {"write_file", "create_file", "edit_file"}:
                continue
            raw_path = next(
                (
                    eff_args.get(key)
                    for key in ("filename", "path", "file")
                    if isinstance(eff_args.get(key), str) and eff_args.get(key)
                ),
                None,
            )
            if raw_path is None:
                continue
            helper_name = Path(raw_path).name
            helper_key = str(Path(raw_path)).replace("\\", "/").casefold()
            if (
                _TEMP_HELPER_RE.search(helper_name)
                and temporary_helper_writes.get(helper_key, 0) >= _MAX_TEMP_HELPER_WRITES
            ):
                reason = (
                    "[ProgressGuard] Repeated temporary helper-file rewrites are blocked. "
                    "Use run_script(language, code) for disposable validation; it executes from "
                    "the workspace and always removes its operating-system temporary file."
                )
                effective[index] = (tc, eff_args, reason)
                trace.append({
                    "step": step,
                    "event": "temporary_helper_churn_blocked",
                    "tool": tc.name,
                    "path": str(raw_path),
                })

        # T19: Sandbox enforcement — check all non-blocked tools for safety.
        # Sandbox-blocked tools get a block reason in effective, same as hook-blocked.
        try:
            from arforge.security.sandbox_enforce import enforce as sandbox_enforce
            from arforge.security.sandbox_enforce import SandboxDecision
            from arforge.core.runtime_sandbox import normalize_mode

            sandbox_mode = "workspace-write"
            try:
                from arforge.core.permission import (
                    PermissionMode,
                    get_permission_manager,
                )

                current_mode = get_permission_manager().get_mode()
                if isinstance(current_mode, PermissionMode):
                    sandbox_mode = normalize_mode(current_mode.value).value
                elif current_mode:
                    sandbox_mode = normalize_mode(str(current_mode)).value
            except Exception:  # noqa: BLE001
                pass
            workspace = None
            try:
                from arforge.tools.file_tools import WORKSPACE

                workspace = str(WORKSPACE.resolve())
            except Exception:  # noqa: BLE001
                pass

            for i in range(len(effective)):
                tc, eff_args, blk = effective[i]
                if blk is not None:
                    continue  # Already blocked by hook — skip
                decision, reason = sandbox_enforce(
                    tc.name,
                    eff_args,
                    sandbox_mode=sandbox_mode,
                    workspace=workspace,
                )
                if decision != SandboxDecision.ALLOWED:
                    effective[i] = (
                        tc,
                        eff_args,
                        f"[Sandbox] {decision.value}: {reason}",
                    )
        except ImportError:
            pass  # Sandbox module not available — skip enforcement

        exec_list = [(tc.name, a) for tc, a, blk in effective if blk is None]
        if should_stop is not None and should_stop():
            raise InterruptedError("operation cancelled or timed out")
        if on_tool_start is not None:
            for tc, args, _blocked in effective:
                try:
                    on_tool_start(
                        tc.name,
                        sanitize_sensitive_data(dict(args)),
                        step,
                    )
                except Exception:
                    pass

        if permission_active:
            from arforge.security.file_ops import confirmed_operation

            exec_cm = confirmed_operation()
        else:
            exec_cm = nullcontext()
        # Child agents must observe cancellation of the desktop operation that
        # spawned them. ContextVars are copied by ToolRegistry's parallel
        # executor, keeping this guard isolated per chat operation.
        try:
            from arforge.core.subagent import subagent_stop_scope

            subagent_stop_cm = subagent_stop_scope(should_stop)
        except ImportError:
            subagent_stop_cm = nullcontext()
        with exec_cm, subagent_stop_cm:
            if executor is not None:
                exec_results = [executor(name, args) for name, args in exec_list]
            else:
                all_low_risk = all(
                    (
                        REGISTRY.get(name) is not None
                        and REGISTRY.get(name).schema.risk_level == "low"
                    )
                    for name, _ in exec_list
                )
                exec_results = REGISTRY.execute_calls(
                    exec_list, parallel=(all_low_risk and len(exec_list) > 1)
                )

        # sc11: transient error retry with exponential backoff
        try:
            from arforge.core.self_correct import is_transient, retry_config

            rc = retry_config()
            import time as _time

            for idx, (name, args) in enumerate(exec_list):
                result = exec_results[idx]
                if result.success:
                    continue
                error_text = str(result.error or "") or str(result.output or "")
                if not is_transient(error_text):
                    continue
                delay = rc["base_delay_sec"]
                for attempt in range(1, rc["max_retries"] + 1):
                    if should_stop is not None and should_stop():
                        raise InterruptedError("operation cancelled or timed out")
                    trace.append(
                        {
                            "step": step,
                            "event": "transient_retry",
                            "tool": name,
                            "attempt": attempt,
                        }
                    )
                    _time.sleep(min(delay, rc["max_delay_sec"]))
                    retry_results = REGISTRY.execute_calls(
                        [(name, args)], parallel=False
                    )
                    retry_result = retry_results[0]
                    if retry_result.success:
                        exec_results[idx] = retry_result
                        trace.append(
                            {
                                "step": step,
                                "event": "transient_retry_success",
                                "tool": name,
                                "attempt": attempt,
                            }
                        )
                        break
                    delay *= rc["backoff_factor"]
        except Exception:
            pass  # best-effort, never block the loop

        # 按原顺序回填结果；被拦截的工具用合成失败结果回灌模型（让其换方案）。
        results = []
        ridx = 0
        for tc, args, blk in effective:
            if blk is None:
                results.append(exec_results[ridx])
                ridx += 1
            else:
                results.append(
                    ToolResult(
                        tc.name,
                        False,
                        "",
                        blk,
                        meta={"outcome": "blocked", "protocol_blocked": True},
                    )
                )

        pending_feedback: list[dict] = []
        for (tc, args, blk), result in zip(effective, results):
            tspan = tracer.start_span(
                f"tool.{tc.name}", kind="tool", success=result.success
            )
            tspan.attributes["elapsed_ms"] = result.elapsed_ms
            tracer.end_span(tspan, status="ok" if result.success else "error")
            safe_output = sanitize_log_message(str(result.output or ""))
            safe_error = sanitize_log_message(str(result.error or ""))
            safe_args = sanitize_sensitive_data(dict(args))
            safe_result = ToolResult(
                result.tool_name,
                result.success,
                safe_output,
                safe_error,
                elapsed_ms=result.elapsed_ms,
                truncated=result.truncated,
                meta=sanitize_sensitive_data(result.meta),
            )
            controlled_block = (
                not result.success
                and str(result.meta.get("outcome", "")) == "blocked"
            )
            content = (
                safe_output
                if result.success
                else f"BLOCKED: {safe_error}"
                if controlled_block
                else f"ERROR: {safe_error}"
            )
            recovery_feedback = None
            if not result.success and not controlled_block:
                sc_state.record(
                    error_text=safe_error, tool_name=tc.name, step=step
                )
                recovery_feedback = sc_state.failure_feedback(
                    error_text=safe_error, tool_name=tc.name, step=step
                )
                if (
                    tc.name == "run_cmd"
                    and "shell metacharacters" in safe_error.casefold()
                ):
                    if os.name == "nt":
                        platform_hint = (
                            "The host is Windows and run_cmd is no-shell. Use one direct command; "
                            "for executable discovery use `where <name>`. Do not use `which`, "
                            "redirection, `/dev/null`, `&&`, or `||`."
                        )
                    else:
                        platform_hint = (
                            "The host is POSIX and run_cmd is no-shell. Use one direct command; "
                            "for executable discovery use `which <name>`. Do not use redirection, "
                            "`&&`, or `||`."
                        )
                    recovery_feedback = (
                        f"{recovery_feedback or ''}\n\n[CommandContract] {platform_hint}"
                    ).strip()
                trace.append(
                    {"step": step, "event": "self_correct_feedback", "tool": tc.name}
                )

                # sc9: if this was a test runner and it produced structured failures,
                # inject parsed test-failure feedback for precise fix guidance.
                if tc.name in ("run_cmd", "run_tests"):
                    raw_output = safe_error or safe_output
                    if "FAILED" in raw_output or "assert" in raw_output.lower():
                        try:
                            from arforge.core.self_correct import (
                                parse_test_failures,
                                build_test_fix_feedback,
                            )

                            tf = parse_test_failures(raw_output)
                            if tf:
                                test_fb = build_test_fix_feedback(tf)
                                recovery_feedback = (
                                    (recovery_feedback or "") + "\n\n" + test_fb
                                )
                                trace.append(
                                    {
                                        "step": step,
                                        "event": "test_fix_feedback",
                                        "failures": len(tf),
                                    }
                                )
                                _test_fix_active = True
                        except Exception:
                            pass  # best-effort, never block the loop
            elif result.success:
                sc_state.record_success(tool_name=tc.name, step=step)
                definition = REGISTRY.get(tc.name)
                category = definition.schema.category if definition is not None else "read"
                if _is_context_gathering_call(tc.name, args, category):
                    consecutive_read_calls += 1
                else:
                    consecutive_read_calls = 0
                verification_entry = {
                    "tool": tc.name,
                    "args": safe_args,
                    "success": result.success,
                    "output": safe_output,
                    "error": safe_error,
                }
                if _is_successful_verification(verification_entry):
                    successful_verifications += 1
                if tc.name in {"write_file", "create_file", "edit_file"}:
                    raw_path = next(
                        (
                            args.get(key)
                            for key in ("filename", "path", "file")
                            if isinstance(args.get(key), str) and args.get(key)
                        ),
                        None,
                    )
                    if raw_path is not None and _TEMP_HELPER_RE.search(Path(raw_path).name):
                        helper_key = str(Path(raw_path)).replace("\\", "/").casefold()
                        temporary_helper_writes[helper_key] = temporary_helper_writes.get(helper_key, 0) + 1
                # sc12: auto test-fix loop — after a write succeeds, auto re-run tests
                if _test_fix_active and _test_fix_rerun_count < _MAX_TEST_RERUN:
                    if tc.name in WRITE_TOOLS:
                        _test_fix_rerun_count += 1
                        rerun_prompt = (
                            "\n[SelfCorrect] Code changes applied. Re-run the tests now "
                            f"to verify the fix (auto re-run {_test_fix_rerun_count}/{_MAX_TEST_RERUN})."
                        )
                        pending_feedback.append(
                            {"role": "user", "content": rerun_prompt}
                        )
                        trace.append(
                            {
                                "step": step,
                                "event": "auto_test_rerun_prompt",
                                "rerun": _test_fix_rerun_count,
                            }
                        )
                # Clear test-fix state when tests pass
                if tc.name in ("run_cmd", "run_tests") and _test_fix_active:
                    _test_fix_active = False
                    _test_fix_rerun_count = 0
                    trace.append({"step": step, "event": "test_fix_resolved"})
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": (content or "")[:4000],
                }
            )
            if recovery_feedback:
                pending_feedback.append({"role": "user", "content": recovery_feedback})
            tool_calls_log.append(
                {
                    "tool": tc.name,
                    "args": safe_args,
                    "success": result.success,
                    "step": step,
                    "output": safe_output[:2000],
                    "error": safe_error[:2000],
                    "meta": sanitize_sensitive_data(result.meta),
                }
            )
            trace.append(
                {
                    "step": step,
                    "event": "tool",
                    "tool": tc.name,
                    "success": result.success,
                    "outcome": str(result.meta.get("outcome", "") or ""),
                    "elapsed_ms": result.elapsed_ms,
                }
            )
            if on_tool_complete is not None:
                try:
                    on_tool_complete(tc.name, safe_args, safe_result, step)
                except Exception:
                    pass

            if hooks:
                post_ctx = HookContext(
                    HookEvent.POST_TOOL_USE,
                    tool_name=tc.name,
                    tool_args=safe_args,
                    tool_result=safe_result,
                    messages=messages,
                    tracer=tracer,
                    metadata={"step": step, "task": task, "user_input": task},
                )
                hooks.fire(post_ctx)
                for fb in post_ctx.feedback:
                    pending_feedback.append(fb)
        messages.extend(pending_feedback)
        signature_outcomes[signature] = all(result.success for result in results)
        permission_denied_by_user = any(
            not result.success
            and "permission denied by user" in str(result.error or "").lower()
            for result in results
        )
        if permission_denied_by_user:
            # A user rejection is terminal for this turn. Otherwise a model can
            # switch to a synonymous command and immediately reprompt, which
            # contradicts the desktop's "reject current operation" promise.
            messages.append({
                "role": "user",
                "content": (
                    "The user explicitly rejected the requested permission. "
                    "Do not retry this action or an alternative that has the same effect. "
                    "Return a concise final answer explaining that nothing was executed."
                ),
            })
            answer = _finalize(adapter, messages)
            stop_reason = "permission_denied"
            trace.append({
                "step": step,
                "event": "permission_denied_terminal",
                "chars": len(answer),
            })
            break
        if any(
            tc.name in WRITE_TOOLS and result.success
            for (tc, _args, _blocked), result in zip(effective, results)
        ):
            workspace_revision += 1
            trace.append(
                {
                    "step": step,
                    "event": "workspace_revision_advanced",
                    "revision": workspace_revision,
                }
            )
        if on_checkpoint is not None:
            try:
                on_checkpoint(list(messages), step, list(tool_calls_log))
                trace.append(
                    {"step": step, "event": "checkpoint_persisted"}
                )
            except Exception as exc:  # checkpoint failure must not corrupt the task
                trace.append(
                    {
                        "step": step,
                        "event": "checkpoint_persist_failed",
                        "error": str(exc)[:300],
                    }
                )
    else:
        # ---- 1.3: incomplete report on max_steps ----
        answer, used_fallback = _finalize_from_evidence(
            adapter,
            task=task,
            tool_calls_log=tool_calls_log,
            max_steps=_sanity_cap,
        )
        if used_fallback or _looks_like_unexecuted_tool_text(answer):
            trace.append(
                {
                    "step": _sanity_cap,
                    "event": "unexecuted_tool_text_blocked",
                    "phase": "max_steps",
                }
            )
            answer = _unexecuted_tool_text_report("max steps finalization")
        report = build_incomplete_report(
            task=task or "(unknown)",
            tier=tier,
            max_steps=_sanity_cap,
            steps_used=_sanity_cap,
            tool_calls_log=tool_calls_log,
            answer=answer,
        )
        trace.append(
            {
                "step": _sanity_cap,
                "event": "max_steps_reached",
                "chars": len(answer),
                "incomplete_report": render_incomplete_report(report),
            }
        )
        stop_reason = "max_steps"

    if answer:
        safe_answer = sanitize_log_message(str(answer))
        last_message = messages[-1] if messages else {}
        if not (
            last_message.get("role") == "assistant"
            and str(last_message.get("content") or "") == safe_answer
        ):
            messages.append({"role": "assistant", "content": safe_answer})
        answer = safe_answer

    if hooks:
        hooks.fire(
            HookContext(
                HookEvent.STOP,
                messages=messages,
                tracer=tracer,
                metadata={
                    "reason": stop_reason,
                    "steps": last_step,
                    "task": task,
                    "user_input": task,
                    "assistant_response": answer,
                    "answer": answer,
                    "route_type": "agentic",
                    "intent": "agentic",
                    "tools_used": [
                        str(item.get("tool", ""))
                        for item in tool_calls_log
                        if item.get("tool")
                    ],
                    "has_error": stop_reason != "final",
                    "error_type": stop_reason
                    if stop_reason != "final"
                    else "",
                    "error_message": next(
                        (
                            str(item.get("error") or item.get("reason") or "")
                            for item in reversed(trace)
                            if item.get("error") or item.get("reason")
                        ),
                        "",
                    ),
                    "tool_calls": tool_calls_log,
                },
            )
        )

    tracer.end_span(root)
    self_correct_events = {
        "feedback": sum(
            1 for item in trace if item.get("event") == "self_correct_feedback"
        ),
        "repeat_blocked": sum(
            1 for item in trace if item.get("event") == "self_correct_repeat_blocked"
        ),
        "reflections": sum(
            1 for item in trace if item.get("event") == "self_correct_injected"
        ),
        "abort_injected": sum(
            1 for item in trace if item.get("event") == "self_correct_abort_injected"
        ),
        "consistency_checks": sum(
            1 for item in trace if item.get("event") == "consistency_check_failed"
        ),
        "test_fix_feedback": sum(
            1 for item in trace if item.get("event") == "test_fix_feedback"
        ),
        "unexecuted_tool_text": sum(
            1 for item in trace if item.get("event") == "unexecuted_tool_text_blocked"
        ),
        "verification_required": sum(
            1
            for item in trace
            if item.get("event") == "final_answer_verification_required"
        ),
    }
    verification_records: list[dict] = []
    for call in tool_calls_log:
        tool_name = str(call.get("tool", "") or "")
        arguments = call.get("args") if isinstance(call.get("args"), dict) else {}
        command = " ".join(str(arguments.get("command", "")).strip().split())
        is_test_command = tool_name == "run_cmd" and bool(_TEST_COMMAND_RE.match(command))
        if (
            tool_name not in VERIFY_TOOLS
            and tool_name not in {"test_browser", "interact_browser"}
            and not is_test_command
        ):
            continue
        verification_records.append(
            {
                "tool": tool_name,
                "step": call.get("step"),
                "passed": _is_successful_verification(call),
                "command": command[:500],
            }
        )
    return ToolLoopResult(
        answer=answer,
        tool_calls=tool_calls_log,
        trace=trace,
        steps=last_step,
        messages=messages,
        complexity_tier=tier.value,
        incomplete_report={
            "task": task,
            "tier": tier.value,
            "max_steps": _sanity_cap,
            "steps_used": last_step,
            "tools_called": len(tool_calls_log),
            "failures": sum(1 for tc in tool_calls_log if not tc.get("success", True)),
            "stop_reason": stop_reason,
        }
        if stop_reason != "final"
        else None,
        verifications=verification_records,
        observability={"trace": root.to_dict(), "summary": aggregate(root)},
        self_correct={
            "total_failures": len(sc_state.failures),
            "aborted": sc_state.is_hopeless(),
            "events": self_correct_events,
            "stop_reason": stop_reason,
            "failure_classes": sorted(
                {item.error_class.name for item in sc_state.failures}
            ),
            "failed_tools": sorted({item.tool_name for item in sc_state.failures}),
            "per_class": {
                k: sum(1 for f in sc_state.failures if f.error_class.name == k)
                for k in sorted({f.error_class.name for f in sc_state.failures})
            },
            "successes": sum(1 for tc in tool_calls_log if tc.get("success", False)),
            "total_tool_calls": len(tool_calls_log),
        }
        if sc_state
        else None,
    )
