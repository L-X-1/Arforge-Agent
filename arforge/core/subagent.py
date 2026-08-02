"""G5：code 流程内的轻量子代理编排。

让主 agent 通过 spawn_subagent 工具派生"子代理"去做独立子任务（探索某模块、
调研某主题），子代理有：
  - 独立上下文（全新 messages，不共享主对话）→ 主上下文不被探索细节撑爆
  - 受限工具集（按角色权限）+ executor 硬拦截 → 安全（纵深防御）
  - 复用 core.agentic.run_tool_loop（与主循环、multiagent 同源）
子代理只把最终结论摘要返回主 agent。对标业界 Task/Explore 式子代理。

adapter 传递：由主循环在当前执行上下文内绑定，子代理继承同一上下文；
不同桌面会话使用 ContextVar 隔离，运行结束自动恢复先前值。

T8: 子代理类型库 — 5 种角色：
  explore    (只读探索，6步)
  reviewer   (代码审查，8步，只读)
  researcher (深度研究，12步，只读)
  test-writer(测试编写，15步，可写测试文件)
  debugger   (诊断调试，10步，只读+运行诊断命令)
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import time

# ── Role-based tool permissions ──────────────────────────────────────

_READ_ONLY_TOOLS = (
    "code_search", "code_read", "read_file", "list_files",
    "list_code_files", "code_summary", "csv_preview", "json_pretty",
    "file_state", "read_file_if_changed",
)
_REVIEWER_TOOLS = _READ_ONLY_TOOLS
_RESEARCHER_TOOLS = _READ_ONLY_TOOLS
_DEBUGGER_TOOLS = _READ_ONLY_TOOLS + ("run_cmd",)
_TEST_WRITER_TOOLS = _READ_ONLY_TOOLS + ("write_file", "edit_file", "run_cmd")
_EXPLORE_TOOLS = _READ_ONLY_TOOLS  # backwards compat

# ── Extended role library: every built-in subagent is dispatchable via
#    the Task tool (spawn_subagent / spawn_write_subagent). The roles below
#    mirror the multi-agent orchestration pool (multiagent.agents) and the
#    agent-type registry (multiagent.agent_types) so the Task tool and the
#    chat orchestrator share one role set. ──────────────────────────────

_GENERAL_TOOLS = _READ_ONLY_TOOLS + ("write_file", "edit_file", "run_cmd", "run_tests")
_PLANNER_TOOLS = _READ_ONLY_TOOLS
_CODER_TOOLS = _READ_ONLY_TOOLS + ("write_file", "edit_file", "run_cmd")
_TESTER_TOOLS = _READ_ONLY_TOOLS + ("write_file", "edit_file", "run_cmd", "run_tests")
_SEARCHER_TOOLS = _READ_ONLY_TOOLS + ("web_search",)
_DOC_TOOLS = _READ_ONLY_TOOLS + ("write_file", "edit_file")
_DATA_TOOLS = _READ_ONLY_TOOLS + ("run_cmd",)
_VERIFIER_TOOLS = _READ_ONLY_TOOLS + ("run_cmd", "run_tests", "git_diff")
_STATUSLINE_TOOLS = _READ_ONLY_TOOLS + ("git_status", "git_diff", "git_log", "run_tests")

# ── Role system prompts ──────────────────────────────────────────────

_SUB_SYSTEM = {
    "explore": (
        "你是一个探索型子代理，运行在隔离的上下文里。任务：只读地调查代码/资料，"
        "用只读工具（搜索/读取/列文件/摘要）收集证据，然后给出简洁、结构化的发现摘要"
        "（关键文件:行号 + 关键结论）。绝不修改任何文件，也不要请求写操作。"
        "信息足够后直接用自然语言给出结论。"
    ),
    "reviewer": (
        "你是一个代码审查子代理，运行在隔离的上下文里。任务：只读地审查代码质量，"
        "识别以下问题并给出结构化报告：\n"
        "1. 潜在 bug 和逻辑错误（附文件名:行号）\n"
        "2. 安全漏洞（SQL注入/XSS/命令注入/硬编码密钥）\n"
        "3. 性能问题（N+1查询/不必要循环/大内存分配）\n"
        "4. 代码异味（过长函数/重复代码/神秘命名/过度耦合）\n"
        "5. 测试缺口（关键路径未覆盖）\n"
        "每项给严重程度（critical/high/medium/low）和简短修复建议。绝不修改任何文件。"
    ),
    "researcher": (
        "你是一个深度研究子代理，运行在隔离的上下文里。任务：针对给定主题深入调查代码库，"
        "追踪依赖链、调用关系和架构模式。输出：\n"
        "1. 核心发现摘要（3-5条）\n"
        "2. 关键文件与行号列表\n"
        "3. 依赖关系图（文本描述）\n"
        "4. 架构建议或风险提示\n"
        "允许更多探索步数，但绝不修改文件。信息收集足够后给出综合结论。"
    ),
    "test-writer": (
        "你是一个测试编写子代理，运行在隔离的上下文里。任务：为指定代码编写测试。\n"
        "流程：\n"
        "1. 先读取目标源文件了解接口和逻辑\n"
        "2. 确定测试策略（单元/集成/边界/异常）\n"
        "3. 编写完整测试文件\n"
        "4. 运行测试验证通过\n"
        "5. 若失败则分析并修复\n"
        "输出最终测试文件和运行结果。只修改测试文件，不改源码。"
    ),
    "debugger": (
        "你是一个诊断调试子代理，运行在隔离的上下文里。任务：诊断并定位问题根因。\n"
        "流程：\n"
        "1. 读取错误信息和相关源代码\n"
        "2. 追踪调用链和数据流\n"
        "3. 必要时运行诊断命令（只读，不修改）\n"
        "4. 给出根因分析 + 具体修复建议（不直接修改代码）\n"
        "输出：根因（文件:行号）+ 证据链 + 修复方案（含代码diff）。"
    ),
    "general": (
        "你是一个通用型编码子代理，运行在隔离的上下文里。任务：修复 bug、新增功能、"
        "重构或编写测试。先探索代码库再动手，改完用测试验证。你可以读写文件、执行命令。"
        "输出：完成摘要（改了哪些文件）+ 验证结果。"
    ),
    "planner": (
        "你是一个规划子代理，运行在隔离的上下文里。任务：动手前先探索代码库，产出结构化方案：\n"
        "1. 需要修改的文件列表\n"
        "2. 每个文件的改动描述\n"
        "3. 风险评估\n"
        "4. 预估步骤数\n"
        "5. 回滚策略\n"
        "绝不修改任何文件，只做规划。"
    ),
    "coder": (
        "你是一个编码子代理，运行在隔离的上下文里。任务：实现需求，产出可运行代码。\n"
        "流程：\n"
        "1. 读取相关源码理解现有结构与约定\n"
        "2. 按需写入/编辑文件\n"
        "3. 运行命令或测试验证\n"
        "4. 修复失败直至通过\n"
        "输出：改动文件清单 + 运行结果说明。"
    ),
    "tester": (
        "你是一个测试子代理，运行在隔离的上下文里。任务：编写高覆盖率测试。\n"
        "覆盖：正常路径、边界条件、错误处理。\n"
        "流程：读取源码 → 确定测试策略 → 编写测试文件 → 运行测试 → 失败则修复。\n"
        "只修改测试文件，不改源码。输出：测试文件清单 + 运行结果。"
    ),
    "searcher": (
        "你是一个检索子代理，运行在隔离的上下文里。任务：根据查询返回最相关的文件、"
        "记忆或资源。使用代码搜索、文件浏览与网页检索收集证据，给出：\n"
        "1. 最相关的文件/资源列表（附路径与一句话说明）\n"
        "2. 关键结论摘要\n"
        "绝不修改任何文件。"
    ),
    "doc": (
        "你是一个文档子代理，运行在隔离的上下文里。任务：阅读多模态资料与代码，"
        "生成或更新结构化文档。适合整理接口文档、模块说明、变更说明。\n"
        "先读取证据，再仅修改任务明确要求的文档文件；不修改业务源码。"
        "输出：文档文件清单、关键引用和验证结果。"
    ),
    "data": (
        "你是一个数据分析子代理，运行在隔离的上下文里。任务：加载数据 → 计算统计量 → "
        "（如适用）生成可视化。你可以运行只读命令与数据预览工具。\n"
        "输出：统计结论 + 关键发现。不修改业务代码。"
    ),
    "verifier": (
        "你是一个验证子代理，运行在隔离的上下文里。任务：代码改动完成后验证正确性。\n"
        "流程：\n"
        "1. 运行相关测试检查回归\n"
        "2. 审查 diff 找问题\n"
        "3. 确认改动符合原始需求\n"
        "只验证已有改动，不产生新编辑。输出：验证结论 + 问题清单。"
    ),
    "statusline": (
        "你是一个快速状态检查子代理，运行在隔离的上下文里。任务：快速给出项目健康摘要：\n"
        "git 分支与状态、最近提交、改动文件、测试结果。\n"
        "保持简洁——这是速览，不是深度分析。"
    ),
    "explorer": (
        "你是一个探索型子代理，运行在隔离的上下文里。任务：只读地调查代码/资料，"
        "用只读工具（搜索/读取/列文件/摘要）收集证据，然后给出简洁、结构化的发现摘要"
        "（关键文件:行号 + 关键结论）。绝不修改任何文件，也不要请求写操作。"
    ),
}

_ROLE_TOOLS = {
    "explore": _READ_ONLY_TOOLS,
    "explorer": _EXPLORE_TOOLS,
    "reviewer": _REVIEWER_TOOLS,
    "researcher": _RESEARCHER_TOOLS,
    "test-writer": _TEST_WRITER_TOOLS,
    "debugger": _DEBUGGER_TOOLS,
    "general": _GENERAL_TOOLS,
    "planner": _PLANNER_TOOLS,
    "coder": _CODER_TOOLS,
    "tester": _TESTER_TOOLS,
    "searcher": _SEARCHER_TOOLS,
    "doc": _DOC_TOOLS,
    "data": _DATA_TOOLS,
    "verifier": _VERIFIER_TOOLS,
    "statusline": _STATUSLINE_TOOLS,
}

_ROLE_MAX_STEPS = {
    "explore": 6,
    "explorer": 10,
    "reviewer": 8,
    "researcher": 12,
    "test-writer": 15,
    "debugger": 10,
    "general": 25,
    "planner": 8,
    "coder": 10,
    "tester": 10,
    "searcher": 8,
    "doc": 6,
    "data": 6,
    "verifier": 12,
    "statusline": 5,
}

_ROLE_CATEGORIES = {
    "explore": "read",
    "explorer": "read",
    "reviewer": "read",
    "researcher": "read",
    "debugger": "workspace_cmd",
    "test-writer": "workspace_write",
    "general": "workspace_write",
    "planner": "read",
    "coder": "workspace_write",
    "tester": "workspace_write",
    "searcher": "read",
    "doc": "workspace_write",
    "data": "workspace_cmd",
    "verifier": "workspace_cmd",
    # Status inspection may invoke run_tests; classify it as command-capable
    # so permission checks cannot treat execution as a pure read.
    "statusline": "workspace_cmd",
}

_ROLE_CAPABILITIES = {
    "explore": ("context_search", "code_search"),
    "explorer": ("context_search", "code_search"),
    "reviewer": ("code_review", "security_review", "code_search"),
    "researcher": ("context_search", "code_search"),
    "test-writer": ("test_generation", "command_execution", "code_search"),
    "debugger": ("code_search", "safe_modify", "command_execution"),
    "general": ("safe_modify", "code_search", "code_review", "command_execution"),
    "planner": ("planning", "context_search", "code_search"),
    "coder": ("safe_modify", "code_search", "code_review", "command_execution"),
    "tester": ("test_generation", "command_execution", "code_search"),
    "searcher": ("code_search", "memory_search", "web_search"),
    "doc": ("multimodal_inspection", "code_search"),
    "data": ("data_analysis", "code_search"),
    "verifier": ("code_review", "test_execution"),
    "statusline": ("repository_status", "command_execution"),
}

_ORCHESTRATOR_ROLE_MAP = {
    "planner": "PlannerAgent",
    "coder": "CoderAgent",
    "reviewer": "ReviewerAgent",
    "tester": "TesterAgent",
    "searcher": "SearcherAgent",
    "doc": "DocAgent",
    "debugger": "DebuggerAgent",
    "data": "DataAgent",
}

_REQUIRED_TOOL_EVIDENCE = {
    "planner": frozenset({"list_code_files", "code_search", "code_read", "read_file"}),
    "reviewer": frozenset({"list_code_files", "code_search", "code_read", "read_file"}),
    "searcher": frozenset({"list_files", "list_code_files", "code_search", "code_read", "read_file"}),
    "tester": frozenset({"run_cmd", "run_tests"}),
}


@dataclass(frozen=True)
class SubagentRoleSpec:
    """Canonical immutable contract shared by every subagent entry point."""

    name: str
    description: str
    system_prompt: str
    tools: tuple[str, ...]
    capabilities: tuple[str, ...]
    category: str
    max_steps: int
    max_tokens: int = 4096
    timeout: int = 0
    orchestrator_role: str | None = None
    required_tool_evidence: frozenset[str] = frozenset()


def _role_description(role: str) -> str:
    return _SUB_SYSTEM[role].replace("你是一个", "").split("。")[0].strip()


_ROLE_SPECS = {
    role: SubagentRoleSpec(
        name=role,
        description=_role_description(role),
        system_prompt=_SUB_SYSTEM[role],
        tools=tuple(_ROLE_TOOLS[role]),
        capabilities=tuple(_ROLE_CAPABILITIES.get(role, ())),
        category=_ROLE_CATEGORIES[role],
        max_steps=_ROLE_MAX_STEPS[role],
        orchestrator_role=_ORCHESTRATOR_ROLE_MAP.get(role),
        required_tool_evidence=_REQUIRED_TOOL_EVIDENCE.get(role, frozenset()),
    )
    for role in _SUB_SYSTEM
}

_ROLE_ALIASES = {
    alias.casefold(): canonical
    for canonical, alias in _ORCHESTRATOR_ROLE_MAP.items()
}
_ROLE_ALIASES.update({name.casefold(): name for name in _ROLE_SPECS})


def get_subagent_role_spec(role: str | None) -> SubagentRoleSpec:
    """Resolve lightweight or orchestrator role names to one role contract."""

    requested = (role or "explore").strip()
    canonical = _ROLE_ALIASES.get(requested.casefold())
    if canonical is None:
        allowed = sorted(
            list(_ROLE_SPECS)
            + [name for name in _ORCHESTRATOR_ROLE_MAP.values()]
        )
        raise ValueError(
            f"unknown subagent role: {requested}; allowed roles: {', '.join(allowed)}"
        )
    return _ROLE_SPECS[canonical]


def orchestrator_subagent_role_specs() -> tuple[SubagentRoleSpec, ...]:
    """Return the canonical contracts exposed by the DAG orchestrator."""

    return tuple(
        spec for spec in _ROLE_SPECS.values() if spec.orchestrator_role is not None
    )

_READ_ONLY_ROLES = frozenset(
    role for role, category in _ROLE_CATEGORIES.items() if category == "read"
)
_WRITE_CAPABLE_ROLES = frozenset(
    role for role, category in _ROLE_CATEGORIES.items() if category != "read"
)

# ── Adapter management ───────────────────────────────────────────────

_adapter: ContextVar[object | None] = ContextVar("arforge_subagent_adapter", default=None)
_parent_should_stop: ContextVar[object | None] = ContextVar(
    "arforge_subagent_parent_should_stop",
    default=None,
)


def set_subagent_adapter(adapter) -> None:
    _adapter.set(adapter)


def get_subagent_adapter():
    return _adapter.get()


def clear_subagent_adapter() -> None:
    _adapter.set(None)


@contextmanager
def subagent_adapter_scope(adapter):
    """Bind an adapter to this execution context and restore it afterwards."""
    token = _adapter.set(adapter)
    try:
        yield
    finally:
        _adapter.reset(token)


@contextmanager
def subagent_stop_scope(should_stop):
    """Propagate the owning tool loop's cancellation guard into child agents.

    ``ToolRegistry.execute_calls`` copies context variables into parallel worker
    threads, so this remains operation-local even when several subagents run at
    once.
    """
    token = _parent_should_stop.set(should_stop)
    try:
        yield
    finally:
        _parent_should_stop.reset(token)


def get_subagent_parent_should_stop():
    return _parent_should_stop.get()

# ── Role-aware executor ──────────────────────────────────────────────

_current_role = "explore"


def _set_current_role(role: str) -> None:
    global _current_role
    _current_role = role


def _execute_restricted(role: str, name: str, args):
    """Execute a subagent tool call against a role-bound allowlist."""
    from arforge.tool_registry import REGISTRY, ToolResult

    allowed = _ROLE_TOOLS.get(role, _READ_ONLY_TOOLS)
    if name not in allowed:
        return ToolResult(
            name,
            False,
            "",
            f"subagent role={role} is not allowed to call {name}",
        )
    return REGISTRY.execute_by_name(name, args)


def _executor_for_role(role: str):
    """Return an executor closure so concurrent subagents cannot share role state."""

    def executor(name, args):
        return _execute_restricted(role, name, args)

    return executor


def normalize_subagent_role(role: str | None) -> str:
    return get_subagent_role_spec(role).name


def subagent_role_category(role: str | None) -> str:
    return _ROLE_CATEGORIES[normalize_subagent_role(role)]


def read_only_subagent_roles() -> list[str]:
    return sorted(_READ_ONLY_ROLES)


def write_capable_subagent_roles() -> list[str]:
    return sorted(_WRITE_CAPABLE_ROLES)


def _restricted_executor(name, args):
    """子代理工具执行器：按角色权限硬拦截（纵深防御）。"""
    from arforge.tool_registry import REGISTRY, ToolResult

    allowed = _ROLE_TOOLS.get(_current_role, _READ_ONLY_TOOLS)
    if name not in allowed:
        return ToolResult(
            name, False, "",
            f"子代理(role={_current_role})无权调用 {name}"
        )
    return REGISTRY.execute_by_name(name, args)


def _executor_for_allowed_tools(role: str, allowed_tool_names):
    allowed = frozenset(str(name) for name in allowed_tool_names)

    def executor(name, args):
        from arforge.tool_registry import REGISTRY, ToolResult

        if name not in allowed:
            return ToolResult(
                name,
                False,
                "",
                f"subagent role={role} is not allowed to call {name}",
            )
        return REGISTRY.execute_by_name(name, args)

    return executor


def execute_subagent_loop(
    adapter,
    messages: list[dict],
    *,
    role: str,
    allowed_tool_names=None,
    tool_schemas: list[dict] | None = None,
    max_steps: int,
    span_name: str,
    should_stop=None,
    model_timeout_seconds: float | None = None,
    on_intermediate=None,
    on_tool_start=None,
    on_tool_complete=None,
    token_budget: int | None = None,
):
    """Run the one canonical worker loop used by both subagent front doors."""

    from arforge.core.agentic import run_tool_loop
    from arforge.core.budget import budget_scope, install_budget_hooks
    from arforge.tool_registry import REGISTRY
    import config

    try:
        spec = get_subagent_role_spec(role)
    except ValueError:
        if allowed_tool_names is None:
            raise
        canonical_role = str(role)
        default_tools: tuple[str, ...] = ()
    else:
        canonical_role = spec.name
        default_tools = spec.tools
    allowed = tuple(allowed_tool_names or default_tools)
    allowed_set = frozenset(allowed)
    available_tools = (
        tool_schemas if tool_schemas is not None else REGISTRY.to_openai_tools()
    )
    tools = [
        item
        for item in available_tools
        if item["function"]["name"] in allowed_set
    ]
    run_budget = int(
        getattr(config, "SUBAGENT_RUN_TOKEN_BUDGET", 0)
        if token_budget is None
        else token_budget
    )
    if run_budget > 0:
        install_budget_hooks()
    with budget_scope(run_budget):
        return run_tool_loop(
            adapter,
            messages,
            tools=tools,
            max_steps=max_steps,
            span_name=span_name,
            executor=_executor_for_allowed_tools(canonical_role, allowed_set),
            should_stop=should_stop,
            model_timeout_seconds=model_timeout_seconds,
            on_intermediate=on_intermediate,
            on_tool_start=on_tool_start,
            on_tool_complete=on_tool_complete,
        )


# ── Public API ───────────────────────────────────────────────────────

def run_subagent(
    task: str,
    role: str = "explore",
    max_steps: int | None = None,
    *,
    should_stop=None,
    model_timeout_seconds: float | None = None,
    timeout_seconds: float | None = None,
) -> str:
    """派生子代理执行子任务，返回其结论摘要（隔离上下文）。

    Supported roles:
      - explore    : 只读探索（6步默认）
      - reviewer   : 代码审查（8步默认，只读）
      - researcher : 深度研究（12步默认，只读）
      - test-writer: 编写测试（15步默认，可写测试文件）
      - debugger   : 诊断调试（10步默认，只读+运行诊断命令）
    """
    try:
        role = normalize_subagent_role(role)
    except ValueError as exc:
        return f"[subagent] {exc}"

    adapter = get_subagent_adapter()
    if adapter is None:
        return "[子代理] 不可用：未绑定模型适配器。"
    if not task or not task.strip():
        return "[子代理] 任务为空。"

    import config

    if max_steps is None:
        max_steps = _ROLE_MAX_STEPS[role]
    allowed_tools = _ROLE_TOOLS[role]
    system = _SUB_SYSTEM[role]

    _set_current_role(role)

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": task.strip()},
    ]
    started = time.monotonic()
    parent_should_stop = get_subagent_parent_should_stop()
    total_timeout = max(0.0, float(
        timeout_seconds
        if timeout_seconds is not None
        else getattr(config, "SUBAGENT_TIMEOUT_SECONDS", 0.0)
    ))

    def subagent_should_stop() -> bool:
        if callable(parent_should_stop) and parent_should_stop():
            return True
        if callable(should_stop) and should_stop():
            return True
        return total_timeout > 0 and time.monotonic() - started >= total_timeout

    requested_model_timeout = (
        max(0.0, float(model_timeout_seconds))
        if model_timeout_seconds is not None
        else 0.0
    )
    positive_limits = [
        value for value in (total_timeout, requested_model_timeout) if value > 0
    ]
    per_call_timeout = min(positive_limits) if positive_limits else None
    result = execute_subagent_loop(
        adapter,
        messages,
        role=role,
        allowed_tool_names=allowed_tools,
        max_steps=max_steps,
        span_name="subagent.run",
        should_stop=subagent_should_stop,
        model_timeout_seconds=per_call_timeout,
    )
    return result.answer or "(子代理无结论)"


def list_subagent_roles() -> list[dict]:
    """Return metadata for all available subagent roles."""
    return [
        {
            "role": role,
            "description": spec.description,
            "max_steps": spec.max_steps,
            "writable": "write_file" in spec.tools,
            "category": spec.category,
            "tools": list(spec.tools),
        }
        for role, spec in _ROLE_SPECS.items()
    ]
