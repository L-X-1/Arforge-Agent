"""Tool registration, matching, and execution with schema validation."""

from __future__ import annotations

import inspect
import json
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Optional


_DEFERRED_SOURCE_MODULES = frozenset(
    {
        "arforge.tools.asset_tools",
        "arforge.tools.browser_tools",
        "arforge.tools.computer_tools",
        "arforge.tools.frontend_tools",
        "arforge.tools.infra_tools",
        "arforge.tools.js_tools",
        "arforge.tools.notebook_tools",
        "arforge.tools.perception_tools",
        "arforge.tools.regression_tools",
        "arforge.tools.schedule_tools",
        "arforge.tools.web_tools",
        "arforge.tools.workflow_tools",
        "arforge.tools.worktree_tools",
    }
)


@dataclass(frozen=True)
class DeferredToolState:
    """Deferred tool selections isolated to one agent run."""

    enabled: bool
    selected: frozenset[str] = frozenset()


_DEFERRED_TOOL_STATE: ContextVar[DeferredToolState | None] = ContextVar(
    "arforge_deferred_tool_state",
    default=None,
)


@contextmanager
def deferred_tool_scope(*, enabled: bool = True) -> Iterator[DeferredToolState]:
    """Create an isolated deferred-tool selection scope for one agent run."""

    state = DeferredToolState(enabled=bool(enabled))
    token = _DEFERRED_TOOL_STATE.set(state)
    try:
        yield state
    finally:
        _DEFERRED_TOOL_STATE.reset(token)


def select_deferred_tools(names: list[str] | set[str] | tuple[str, ...]) -> frozenset[str]:
    """Activate deferred tools in the current run and return the full selection."""

    state = _DEFERRED_TOOL_STATE.get()
    if state is None or not state.enabled:
        return frozenset()
    selected = state.selected | frozenset(str(name).strip() for name in names if str(name).strip())
    _DEFERRED_TOOL_STATE.set(DeferredToolState(enabled=True, selected=selected))
    return selected


def selected_deferred_tools() -> frozenset[str]:
    """Return deferred tool names selected in the current run."""

    state = _DEFERRED_TOOL_STATE.get()
    if state is None or not state.enabled:
        return frozenset()
    return state.selected


def _source_should_defer(source: str) -> bool:
    return source in _DEFERRED_SOURCE_MODULES or source.startswith("mcp:")


def _full_access_confirmation_bypass() -> bool:
    """Return whether the current operation explicitly runs in Full Access.

    The permission hook already applies the mode matrix before a tool reaches
    the registry.  Requiring a second schema-level confirmation in Full Access
    breaks unattended desktop runs, while all other modes (and calls outside a
    permission scope) must keep the existing fail-closed confirmation path.
    """

    try:
        from arforge.core.permission import PermissionMode, get_permission_manager

        return get_permission_manager().get_mode() is PermissionMode.FULL_ACCESS
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


@dataclass
class ParamSchema:
    """Describes a single tool parameter."""

    name: str
    type: str = "string"  # string / int / float / bool / path / array / object
    description: str = ""
    required: bool = True
    default: Any = None
    json_schema: dict[str, Any] | None = None


@dataclass
class ToolSchema:
    """Complete interface contract for a tool."""

    name: str
    description: str
    params: list[ParamSchema] = field(default_factory=list)
    output_type: str = "text"  # text / json / stream
    risk_level: str = "low"  # low / medium / high / critical
    requires_confirmation: bool = False
    timeout: int = 10
    output_limit: int = 8000
    # PM-1 权限分类：read / workspace_write / workspace_cmd / network / system / dangerous
    # 三模式权限矩阵(PM-2)按 category 裁决。默认 read（只读/无副作用，最安全的缺省）。
    category: str = "read"
    should_defer: bool = False
    always_load: bool = False


# ---------------------------------------------------------------------------
# Match / Result value objects
# ---------------------------------------------------------------------------


@dataclass
class ToolMatch:
    tool_name: str
    args: dict = field(default_factory=dict)


@dataclass
class ToolResult:
    """Structured result from a tool execution."""

    tool_name: str
    success: bool
    output: str
    error: str = ""
    elapsed_ms: int = 0
    truncated: bool = False
    meta: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Definition
# ---------------------------------------------------------------------------


@dataclass
class ToolDefinition:
    name: str
    description: str
    schema: ToolSchema = field(default_factory=lambda: ToolSchema("", ""))
    keywords: list = field(default_factory=list)
    priority: int = 100
    match_fn: Optional[Callable] = None
    execute_fn: Optional[Callable] = None
    input_adapter: Optional[Callable[[str], dict]] = None
    source: str = ""
    search_hint: str = ""


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


class ToolRegistry:
    def __init__(self):
        self.tools: dict[str, ToolDefinition] = {}
        self._filter_stack: list[set | None] = []

    def register(self, definition: ToolDefinition):
        self.tools[definition.name] = definition
        return definition

    def get(self, name: str) -> Optional[ToolDefinition]:
        return self.tools.get(name)

    def list_tools(self) -> list[ToolDefinition]:
        return sorted(self.tools.values(), key=lambda item: (item.priority, item.name))

    def push_filter(self, allowed: set[str] | None) -> None:
        """Activate a tool allowlist filter (e.g., for subagent role scoping)."""
        self._filter_stack.append(allowed)

    def pop_filter(self) -> None:
        """Restore the previous tool filter."""
        if self._filter_stack:
            self._filter_stack.pop()

    def _active_filter(self) -> set[str] | None:
        """Return the currently active tool allowlist, if any."""
        for f in reversed(self._filter_stack):
            if f is not None:
                return f
        return None

    def _filtered_tools(self) -> list[ToolDefinition]:
        """Return tools visible under the current filter."""
        allowed = self._active_filter()
        if allowed is None:
            return sorted(self.tools.values(), key=lambda item: (item.priority, item.name))
        return sorted(
            (t for t in self.tools.values() if t.name in allowed),
            key=lambda item: (item.priority, item.name),
        )

    # -- matching -----------------------------------------------------------

    def match(self, user_input: str) -> Optional[ToolMatch]:
        text = user_input.lower()
        for tool in self.list_tools():
            if tool.match_fn:
                result = tool.match_fn(user_input)
                if result:
                    if isinstance(result, ToolMatch):
                        return result
                    return ToolMatch(tool.name, {"input": user_input})
            if tool.keywords and any(str(k).lower() in text for k in tool.keywords):
                return ToolMatch(tool.name, {"input": user_input})
        return None

    # -- execution ----------------------------------------------------------

    def execute(self, match: ToolMatch) -> ToolResult:
        tool = self.tools.get(match.tool_name)
        if not tool or not tool.execute_fn:
            return ToolResult(match.tool_name, False, "", f"tool not available: {match.tool_name}")

        # Merge keyword-match input with input_adapter
        args = dict(match.args)
        if tool.input_adapter and "input" in args:
            adapted = tool.input_adapter(args.pop("input"))
            adapted.update(args)
            args = adapted
        elif "input" in args:
            # Preserve the legacy convenience for one-argument keyword tools.
            try:
                params = [
                    name
                    for name, param in inspect.signature(tool.execute_fn).parameters.items()
                    if param.kind not in {
                        inspect.Parameter.VAR_POSITIONAL,
                        inspect.Parameter.VAR_KEYWORD,
                    }
                ]
            except (ValueError, TypeError):
                params = []
            if len(params) == 1:
                args = {params[0]: args["input"]}

        # Natural-language and structured calls share one validation path so
        # malformed matches fail before confirmation or tool invocation.
        return self.execute_by_name(match.tool_name, args)

    def _call(self, tool: ToolDefinition, tool_name: str, args: dict) -> ToolResult:
        started = time.perf_counter()
        try:
            if tool.schema.requires_confirmation:
                from arforge.security.file_ops import confirmed_operation

                if not _full_access_confirmation_bypass():
                    from arforge.permission import request_confirmation

                    if not request_confirmation(tool.schema.risk_level, f"run tool '{tool_name}'"):
                        elapsed = int((time.perf_counter() - started) * 1000)
                        return ToolResult(
                            tool_name,
                            False,
                            "",
                            "confirmation denied",
                            elapsed_ms=elapsed,
                            meta={
                                "confirmation_required": True,
                                "outcome": "blocked",
                            },
                        )
                with confirmed_operation():
                    raw = tool.execute_fn(**args)
            else:
                raw = tool.execute_fn(**args)
        except Exception as exc:
            from arforge.security_guard import sanitize_log_message

            elapsed = int((time.perf_counter() - started) * 1000)
            message = sanitize_log_message(str(exc))
            controlled_markers = (
                "protected path:",
                "confirmation denied",
                "shell metacharacters",
                "blocked by policy",
                "not permitted in",
            )
            meta = (
                {"outcome": "blocked"}
                if any(marker in message.casefold() for marker in controlled_markers)
                else {}
            )
            return ToolResult(
                tool_name,
                False,
                "",
                message,
                elapsed_ms=elapsed,
                meta=meta,
            )

        elapsed = int((time.perf_counter() - started) * 1000)
        output = str(raw) if not isinstance(raw, str) else raw
        truncated = len(output) > tool.schema.output_limit
        if truncated:
            output = output[: tool.schema.output_limit] + "\n…[truncated]"
        return ToolResult(tool_name, True, output, elapsed_ms=elapsed, truncated=truncated)

    # -- schema export for LLM function calling -----------------------------

    _JSON_TYPES = {
        "string": "string",
        "int": "integer",
        "float": "number",
        "bool": "boolean",
        "path": "string",
        "array": "array",
        "object": "object",
    }

    def _to_openai_tool(self, tool: ToolDefinition) -> dict:
        properties = {}
        required = []
        for param in tool.schema.params:
            property_schema = {
                "type": self._JSON_TYPES.get(param.type, "string"),
                "description": param.description or "",
            }
            if param.json_schema:
                property_schema.update(param.json_schema)
            properties[param.name] = property_schema
            if param.required and param.default is None:
                required.append(param.name)
        return {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or tool.schema.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        }

    def to_openai_tools(self, *, deferred: bool | None = None) -> list[dict]:
        """Export function-calling schemas, optionally hiding deferred tools."""

        state = _DEFERRED_TOOL_STATE.get()
        use_deferred = bool(state and state.enabled) if deferred is None else bool(deferred)
        selected = state.selected if state and state.enabled else frozenset()
        tools: list[dict] = []
        for tool in self._filtered_tools():
            if tool.execute_fn is None:
                continue
            if (
                use_deferred
                and tool.schema.should_defer
                and not tool.schema.always_load
                and tool.name not in selected
            ):
                continue
            tools.append(self._to_openai_tool(tool))
        return tools

    def search_deferred_tools(self, query: str, *, max_results: int = 8) -> dict[str, Any]:
        """Search visible deferred tools and return complete callable schemas."""

        normalized = str(query or "").strip()
        if not normalized:
            raise ValueError("query must not be empty")
        if isinstance(max_results, bool):
            raise ValueError("max_results must be between 1 and 20")
        try:
            limit = int(max_results)
        except (TypeError, ValueError):
            raise ValueError("max_results must be between 1 and 20") from None
        if not 1 <= limit <= 20:
            raise ValueError("max_results must be between 1 and 20")
        candidates = [
            tool
            for tool in self._filtered_tools()
            if tool.execute_fn is not None and tool.schema.should_defer and not tool.schema.always_load
        ]
        by_name = {tool.name.casefold(): tool for tool in candidates}

        if normalized.casefold().startswith("select:"):
            raw_names = re.split(r"[\s,]+", normalized.split(":", 1)[1].strip())
            requested: list[ToolDefinition] = []
            seen: set[str] = set()
            for raw_name in raw_names:
                key = raw_name.casefold()
                tool = by_name.get(key)
                if tool is not None and key not in seen:
                    requested.append(tool)
                    seen.add(key)
            scored = [(1000 - index, tool) for index, tool in enumerate(requested)]
        elif normalized.casefold() in by_name:
            scored = [(1000, by_name[normalized.casefold()])]
        else:
            raw_terms = [term for term in re.split(r"\s+", normalized.casefold()) if term]
            required_terms = [term[1:] for term in raw_terms if term.startswith("+") and len(term) > 1]
            optional_terms = [term for term in raw_terms if not term.startswith("+")]
            terms = required_terms + optional_terms
            scored = []
            for tool in candidates:
                name = tool.name.casefold()
                keywords = [str(item).casefold() for item in tool.keywords]
                haystack = " ".join(
                    (
                        name,
                        tool.description.casefold(),
                        tool.schema.description.casefold(),
                        tool.search_hint.casefold(),
                        " ".join(keywords),
                        tool.source.casefold(),
                    )
                )
                if required_terms and not all(term in haystack for term in required_terms):
                    continue
                score = 0
                for term in terms:
                    if term == name:
                        score += 120
                    elif name.startswith(term):
                        score += 50
                    elif term in name:
                        score += 30
                    elif term in keywords:
                        score += 20
                    elif term in haystack:
                        score += 8
                if score:
                    scored.append((score, tool))
            scored.sort(key=lambda item: (-item[0], item[1].priority, item[1].name))

        matches = [
            {
                "name": tool.name,
                "description": tool.description or tool.schema.description,
                "score": score,
                "source": tool.source,
                "schema": self._to_openai_tool(tool),
            }
            for score, tool in scored[:limit]
        ]
        return {
            "query": normalized,
            "matches": matches,
            "count": len(matches),
            "total_deferred_tools": len(candidates),
        }

    # -- execute by explicit name + structured args (LLM-driven path) -------

    @staticmethod
    def _coerce(value, ptype: str):
        if ptype == "int":
            return int(value)
        if ptype == "float":
            return float(value)
        if ptype == "bool":
            if isinstance(value, bool):
                return value
            return str(value).strip().lower() in ("true", "1", "yes", "y", "on")
        if ptype == "array":
            if isinstance(value, list):
                return value
            parsed = json.loads(value)
            if not isinstance(parsed, list):
                raise TypeError("value is not an array")
            return parsed
        if ptype == "object":
            if isinstance(value, dict):
                return value
            parsed = json.loads(value)
            if not isinstance(parsed, dict):
                raise TypeError("value is not an object")
            return parsed
        return str(value)

    def execute_by_name(self, name: str, args: dict | None = None) -> ToolResult:
        """按工具名 + 结构化参数执行（LLM function-calling 路径）。

        基于 ParamSchema 做类型强转、基于函数签名做必填校验；缺参或类型非法时
        返回失败的 ToolResult（不抛异常），便于把错误回灌模型纠错。
        """
        tool = self.tools.get(name)
        if tool is None or tool.execute_fn is None:
            return ToolResult(name, False, "", f"tool not available: {name}")

        raw = dict(args or {})
        schema_params = {p.name: p for p in tool.schema.params}

        # 1) 按 schema 类型强转
        coerced: dict = {}
        for key, value in raw.items():
            if key in schema_params and value is not None:
                try:
                    coerced[key] = self._coerce(value, schema_params[key].type)
                except (ValueError, TypeError) as exc:
                    return ToolResult(name, False, "", f"参数 '{key}' 需要 {schema_params[key].type}: {exc}")
            else:
                coerced[key] = value

        # 2) 按函数签名补默认值并校验必填
        try:
            sig = inspect.signature(tool.execute_fn)
        except (ValueError, TypeError):
            return self._call(tool, name, coerced)

        final: dict = {}
        missing: list[str] = []
        accepts_var_kw = any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
        )
        for pname, param in sig.parameters.items():
            if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
                continue
            if pname in coerced:
                final[pname] = coerced[pname]
            elif param.default is not inspect.Parameter.empty:
                final[pname] = param.default
            else:
                missing.append(pname)
        if missing:
            return ToolResult(name, False, "", f"缺少必填参数: {', '.join(missing)}")
        # 接受 **kwargs 的工具（如 MCP 动态工具）：把其余已按 schema 强转的参数透传进去。
        if accepts_var_kw:
            for key, value in coerced.items():
                if key not in final:
                    final[key] = value

        return self._call(tool, name, final)

    def execute_calls(self, calls: list, parallel: bool = True, max_workers: int = 4) -> list:
        """批量执行 [(name, args), ...]。parallel=True 时线程池并行（加速 I/O 密集工具）。

        注意：需交互式确认的高风险工具并行时确认会交错；Agent loop 对高风险工具
        应改用 parallel=False 串行。
        """
        if not calls:
            return []
        if not parallel or len(calls) == 1:
            return [self.execute_by_name(name, args) for name, args in calls]
        from concurrent.futures import ThreadPoolExecutor
        from contextvars import copy_context

        with ThreadPoolExecutor(max_workers=min(max_workers, len(calls))) as pool:
            futures = [
                pool.submit(copy_context().run, self.execute_by_name, name, args)
                for name, args in calls
            ]
            return [f.result() for f in futures]

    # -- list as dicts for API consumers ------------------------------------

    def list_tool_dicts(self) -> list[dict]:
        return [
            {
                "name": t.name,
                "description": t.description,
                "keywords": t.keywords,
                "priority": t.priority,
                "risk": t.schema.risk_level,
                "source": t.source,
                "should_defer": t.schema.should_defer,
                "always_load": t.schema.always_load,
                "search_hint": t.search_hint,
                "params": [
                    {"name": p.name, "type": p.type, "description": p.description, "required": p.required}
                    for p in t.schema.params
                ],
            }
            for t in self._filtered_tools()
        ]

    def audit_contracts(self) -> dict[str, Any]:
        """Validate every registered tool without executing side effects."""
        issues: list[dict[str, str]] = []
        keyword_owners: dict[str, list[str]] = {}
        valid_risks = {"low", "medium", "high", "critical"}
        valid_categories = {"read", "workspace_write", "workspace_cmd", "network", "system", "dangerous"}

        for tool in self.list_tools():
            def report(code: str, detail: str) -> None:
                issues.append({"tool": tool.name, "code": code, "detail": detail})

            if tool.schema.name != tool.name:
                report("SCHEMA_NAME_MISMATCH", f"schema name is {tool.schema.name!r}")
            if not tool.description.strip():
                report("MISSING_DESCRIPTION", "tool description is empty")
            if tool.execute_fn is None or not callable(tool.execute_fn):
                report("MISSING_EXECUTOR", "execute_fn is not callable")
                continue
            if tool.input_adapter is not None and not callable(tool.input_adapter):
                report("INVALID_INPUT_ADAPTER", "input_adapter is not callable")
            if tool.schema.risk_level not in valid_risks:
                report("INVALID_RISK", f"unsupported risk {tool.schema.risk_level!r}")
            if tool.schema.category not in valid_categories:
                report("INVALID_CATEGORY", f"unsupported category {tool.schema.category!r}")

            schema_params = {param.name: param for param in tool.schema.params}
            if len(schema_params) != len(tool.schema.params):
                report("DUPLICATE_PARAMETER", "schema contains duplicate parameter names")
            try:
                signature = inspect.signature(tool.execute_fn)
            except (TypeError, ValueError):
                signature = None
            if signature is not None:
                accepts_kwargs = any(
                    param.kind is inspect.Parameter.VAR_KEYWORD
                    for param in signature.parameters.values()
                )
                callable_params = {
                    name: param
                    for name, param in signature.parameters.items()
                    if param.kind not in {
                        inspect.Parameter.VAR_POSITIONAL,
                        inspect.Parameter.VAR_KEYWORD,
                    }
                }
                for name, param in callable_params.items():
                    schema_param = schema_params.get(name)
                    if schema_param is None:
                        if param.default is inspect.Parameter.empty:
                            report("SIGNATURE_PARAM_MISSING_SCHEMA", name)
                        continue
                    signature_required = param.default is inspect.Parameter.empty
                    if schema_param.required != signature_required:
                        report(
                            "REQUIRED_MISMATCH",
                            f"{name}: schema={schema_param.required}, signature={signature_required}",
                        )
                if not accepts_kwargs:
                    for name in schema_params:
                        if name not in callable_params:
                            report("SCHEMA_PARAM_MISSING_SIGNATURE", name)

            for keyword in tool.keywords:
                normalized = str(keyword).strip().casefold()
                if normalized:
                    keyword_owners.setdefault(normalized, []).append(tool.name)

        try:
            exported = self.to_openai_tools(deferred=False)
            json.dumps(exported, ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            issues.append({"tool": "*", "code": "SCHEMA_EXPORT_FAILED", "detail": str(exc)})
            exported = []

        duplicate_keywords = {
            keyword: owners
            for keyword, owners in keyword_owners.items()
            if len(owners) > 1
        }
        return {
            "registered": len(self.list_tools()),
            "exported": len(exported),
            "passed": not issues,
            "issues": issues,
            "duplicate_keywords": duplicate_keywords,
            "deferred": sum(tool.schema.should_defer for tool in self.list_tools()),
        }


REGISTRY = ToolRegistry()


# ---------------------------------------------------------------------------
# Registration helpers
# ---------------------------------------------------------------------------


def register_tool(
    name: str,
    description: str,
    keywords: list[str] | None = None,
    params: list[ParamSchema] | None = None,
    match_fn: Callable | None = None,
    input_adapter: Callable[[str], dict] | None = None,
    priority: int = 100,
    risk: str = "low",
    requires_confirmation: bool = False,
    timeout: int = 10,
    output_limit: int = 8000,
    source: str = "",
    category: str = "read",
    should_defer: bool | None = None,
    always_load: bool = False,
    search_hint: str = "",
):
    resolved_defer = _source_should_defer(source) if should_defer is None else bool(should_defer)
    schema = ToolSchema(
        name=name,
        description=description,
        params=params or [],
        risk_level=risk,
        requires_confirmation=requires_confirmation,
        timeout=timeout,
        output_limit=max(1, int(output_limit)),
        category=category,
        should_defer=resolved_defer,
        always_load=bool(always_load),
    )

    def decorator(fn: Callable):
        REGISTRY.register(
            ToolDefinition(
                name=name,
                description=description,
                schema=schema,
                keywords=keywords or [],
                priority=priority,
                match_fn=match_fn,
                execute_fn=fn,
                input_adapter=input_adapter,
                source=source,
                search_hint=search_hint,
            )
        )
        return fn

    return decorator


# ---------------------------------------------------------------------------
# Built-in input adapters
# ---------------------------------------------------------------------------


def adapt_first_arg(input_text: str) -> dict:
    """Take the first whitespace-delimited token after stripping common prefixes."""
    # Strip common leading phrases
    text = re.sub(r"^(calculate|comput|计算)\s*", "", input_text, flags=re.IGNORECASE).strip()
    return {"expression": text}


def adapt_filename(input_text: str) -> dict:
    """Extract a filename from natural language input."""
    text = input_text.strip()
    # Try to find a path-like token
    parts = text.split()
    for part in reversed(parts):
        if "." in part or "/" in part or "\\" in part:
            return {"filename": part}
    return {"filename": parts[-1] if parts else ""}


def match_read_file_request(input_text: str) -> ToolMatch | None:
    """Match only explicit read commands that include a concrete file target."""
    match = re.match(
        r"^\s*(?:read\s+file|cat|读取(?:文件)?|查看(?:文件)?|打开(?:文件)?)\s+(.+?)\s*$",
        str(input_text or ""),
        re.IGNORECASE,
    )
    if match is None:
        return None
    filename = match.group(1).strip().strip("`'\"“”")
    if not filename or filename.casefold() in {"it", "this", "that", "它", "这个", "那个"}:
        return None
    return ToolMatch("read_file", {"filename": filename})


def adapt_filename_content(input_text: str) -> dict:
    """Extract filename and content from input like 'write file x.py with ...'."""
    text = input_text.strip()
    parts = text.split()
    # Look for filename
    filename = ""
    for i, part in enumerate(parts):
        if "." in part or "/" in part or "\\" in part:
            filename = part
            content_start = i + 1
            break
    else:
        return {"filename": parts[-1] if parts else "", "content": ""}

    content = " ".join(parts[content_start:]).lstrip("with ").strip()
    return {"filename": filename, "content": content}


_CHINESE_FONT_NAMES = ("微软雅黑", "仿宋", "楷体", "黑体", "宋体")
_CHINESE_FONT_SIZES = {
    "初号": 42.0,
    "小初": 36.0,
    "一号": 26.0,
    "小一": 24.0,
    "二号": 22.0,
    "小二": 18.0,
    "三号": 16.0,
    "小三": 15.0,
    "四号": 14.0,
    "小四": 12.0,
    "五号": 10.5,
    "小五": 9.0,
}


def _extract_docx_style(content: str) -> tuple[str, str | None, float | None]:
    """Split a leading Chinese font instruction from document content."""
    fonts = "|".join(map(re.escape, _CHINESE_FONT_NAMES))
    sizes = "|".join(map(re.escape, _CHINESE_FONT_SIZES))
    match = re.match(
        rf"^\s*(?:(?P<font>{fonts})\s*)?(?:(?P<size>{sizes})\s*)?"
        rf"(?:字体|字形|字号)\s*(?:的|[:：])\s*",
        content,
    )
    if match is None or not (match.group("font") or match.group("size")):
        return content.strip(), None, None
    size_name = match.group("size")
    return (
        content[match.end():].strip(),
        match.group("font"),
        _CHINESE_FONT_SIZES.get(size_name) if size_name else None,
    )


def adapt_docx_request(input_text: str) -> dict:
    """Extract Word filename, content, location, and basic Chinese typography."""
    source = str(input_text or "").strip()
    args: dict[str, Any] = {}
    filename_match = re.search(
        r"(?:命名(?:为|成)|文件名\s*(?:为|是|叫)|名称\s*(?:为|是|叫)|"
        r"named?\s+(?:it\s+)?|filename\s*(?:is|[:=]))\s*"
        r"[\"'“”]?([^,，;；。\r\n]+?)[\"'“”]?"
        r"(?=\s*(?:[,，;；。]|内容|content|$))",
        source,
        re.IGNORECASE,
    )
    if filename_match:
        filename = filename_match.group(1).strip().strip("`'\"“”")
        if filename and not Path(filename).suffix:
            filename += ".docx"
        if filename and re.search(r"(?:桌面|desktop)", source, re.IGNORECASE):
            filename = str((Path.home() / "Desktop" / filename).resolve())
        if filename:
            args["filename"] = filename

    content_match = re.search(
        r"(?:内容\s*(?:为|是|[:：=])|写入内容\s*(?:为|是|[:：=])?|"
        r"content\s*(?:is|[:=])|with\s+content)\s*(.+)$",
        source,
        re.IGNORECASE | re.DOTALL,
    )
    if content_match:
        content = content_match.group(1).strip().strip("'\"“”")
        body, font_name, font_size_pt = _extract_docx_style(content)
        if body:
            args["content"] = body
        if font_name:
            args["font_name"] = font_name
        if font_size_pt is not None:
            args["font_size_pt"] = font_size_pt
    return args


def adapt_task_title(input_text: str) -> dict:
    """Extract task title from input. Handles 'create task X', 'add a task X', etc."""
    text = input_text.strip()
    # Strip common prefixes: "create (a) task", "add (a) todo", etc.
    text = re.sub(
        r"^(create|add|new|make)\s+(a\s+)?(task|todo)\s*",
        "", text, flags=re.IGNORECASE,
    ).strip()
    priority = "medium"
    if any(w in text.lower() for w in ["urgent", "high", "高", "紧急"]):
        priority = "high"
    elif any(w in text.lower() for w in ["low", "低"]):
        priority = "low"
    return {"title": text, "priority": priority}


def adapt_command(input_text: str) -> dict:
    """Extract command from input."""
    text = input_text.strip()
    text = re.sub(r"^(run|execute|exec|cmd|运行|执行)\s*", "", text, flags=re.IGNORECASE).strip()
    return {"command": text}


# ---------------------------------------------------------------------------
# Matcher helpers (unchanged public API)
# ---------------------------------------------------------------------------


def contains_any(*keywords: str):
    lowered = [k.lower() for k in keywords]

    def matcher(text: str):
        haystack = text.lower()
        return any(k in haystack for k in lowered)

    return matcher


def contains_all(*keywords: str):
    lowered = [k.lower() for k in keywords]

    def matcher(text: str):
        haystack = text.lower()
        return all(k in haystack for k in lowered)

    return matcher


def exact(*phrases: str):
    normalized = {p.lower().strip() for p in phrases}
    return lambda text: text.lower().strip() in normalized


def prefix(prefix_str: str, arg_name: str = None):
    def matcher(text: str):
        if not text.startswith(prefix_str):
            return None
        value = text[len(prefix_str) :].strip()
        return ToolMatch("", {arg_name or "text": value})

    return matcher


def prefix_with_validation(prefix_str: str, arg_name: str, min_len: int = 1):
    def matcher(text: str):
        if not text.startswith(prefix_str):
            return None
        value = text[len(prefix_str) :].strip()
        if len(value) < min_len:
            return None
        return ToolMatch("", {arg_name: value})

    return matcher
