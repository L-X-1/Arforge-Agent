"""Slash command dispatcher for the Arforge interactive REPL.

All slash commands follow the signature:  handler(args: str) -> str
Register new commands with the @register_slash decorator.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass
class SlashCommand:
    name: str
    description: str
    handler: Callable[[str], str]
    category: str = "general"  # general / code / memory / system
    desc_key: str = ""  # i18n key for the localized description (fallback to description)


COMMANDS: dict[str, SlashCommand] = {}


def register_slash(name: str, description: str, category: str = "general", desc_key: str = ""):
    """Decorator to register a slash command handler.

    ``desc_key`` is an optional i18n key resolving to a localized description;
    when absent the English ``description`` is shown as-is.
    """

    def decorator(fn: Callable[[str], str]):
        COMMANDS[name] = SlashCommand(name, description, fn, category, desc_key=desc_key)
        return fn

    return decorator


def _t(key: str, **kwargs) -> str:
    """Resolve a localized slash-command string for the active language."""
    from arforge.i18n import t
    return t(key, **kwargs)


def _localized_desc(cmd: SlashCommand) -> str:
    """Return the command description in the active language."""
    if cmd.desc_key:
        return _t(cmd.desc_key)
    return cmd.description


def list_slash_commands() -> list[dict]:
    """Return metadata for all registered slash commands."""
    rows = [
        {
            "name": item.name,
            "description": item.description,
            "category": item.category,
        }
        for item in COMMANDS.values()
    ]
    try:
        from arforge.customization import list_customizations

        for item in list_customizations().get("commands", {}).get("items", []):
            if item.get("problems"):
                continue
            rows.append(
                {
                    "name": item.get("name", ""),
                    "description": item.get("description", ""),
                    "category": item.get("category", "custom"),
                }
            )
    except Exception:
        pass
    return rows


def run_slash_command(text: str) -> str:
    """Dispatch a slash command by name.  Returns the handler result."""
    if not text.startswith("/"):
        return _t("slash.not_slash")
    name, _, args = text[1:].partition(" ")
    command = COMMANDS.get(name)
    if not command:
        try:
            from arforge.customization import render_custom_command

            rendered = render_custom_command(name, args.strip())
            if rendered is not None:
                return rendered
        except Exception:
            pass
        return f"{_t('slash.unknown', name=name)}\n{_t('slash.usage_help')}"
    try:
        return command.handler(args.strip())
    except Exception as exc:
        return _t("slash.failed", name=name, error=str(exc))


# ========================================================================
# System commands
# ========================================================================


@register_slash("help", "List all slash commands", category="system", desc_key="slash.desc.help")
def _help(args: str) -> str:
    lines = [f"{_t('slash.help_header')}:\n"]
    # Group by category
    cats: dict[str, list[SlashCommand]] = {}
    for cmd in COMMANDS.values():
        cats.setdefault(cmd.category, []).append(cmd)

    cat_keys = {
        "system": "slash.category.system",
        "code": "slash.category.code",
        "memory": "slash.category.memory",
        "agent": "slash.category.agent",
        "general": "slash.category.general",
    }
    for cat_key in ["system", "code", "memory", "agent", "general"]:
        items = cats.get(cat_key, [])
        if not items:
            continue
        label = _t(cat_keys.get(cat_key, cat_key))
        lines.append(f"  [{label}]")
        for cmd in items:
            lines.append(f"    /{cmd.name:20s} — {_localized_desc(cmd)}")
        lines.append("")
    try:
        from arforge.customization import list_customizations

        custom = [
            item for item in list_customizations().get("commands", {}).get("items", [])
            if not item.get("problems")
        ]
        if custom:
            lines.append("  [Custom]")
            for item in custom:
                lines.append(f"    /{item.get('name', ''):20s} - {item.get('description', '')}")
            lines.append("")
    except Exception:
        pass
    return "\n".join(lines)


@register_slash("status", "Show Arforge system status", category="system", desc_key="slash.desc.status")
def _status(args: str) -> str:
    from arforge.status import status_text
    return status_text()


@register_slash("doctor", "Run environment diagnostics", category="system", desc_key="slash.desc.doctor")
def _doctor(args: str) -> str:
    from arforge.product.doctor import doctor_main
    doctor_main()
    return ""


@register_slash("clear", "Clear conversation history", category="system", desc_key="slash.desc.clear")
def _clear(args: str) -> str:
    return _t("repl.history_cleared") + "（在 REPL 中用 Ctrl+C；/clear 由 REPL 直接处理）"


# ========================================================================
# Code intelligence commands
# ========================================================================


@register_slash("review", "Review code for bugs, security, and improvements", category="code", desc_key="slash.desc.review")
def _review(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_review")
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    prompt = (
        f"Review the following code for bugs, security issues, performance problems, "
        f"and style improvements. Be specific and actionable:\n\n{args.strip()}"
    )
    return agent.chat(prompt).answer


@register_slash("explain", "Explain code or concepts in detail", category="code", desc_key="slash.desc.explain")
def _explain(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_explain")
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    return agent.chat(
        f"Explain the following code or concept in detail. Break down how it works:\n\n{args.strip()}"
    ).answer


@register_slash("fix", "Fix a bug or issue with concrete code changes", category="code", desc_key="slash.desc.fix")
def _fix(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_fix")
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    return agent.chat(
        f"Fix the following bug or issue. Provide a concrete solution with specific code changes:\n\n{args.strip()}"
    ).answer


@register_slash("plan", "Generate a structured plan for a task", category="code", desc_key="slash.desc.plan")
def _plan(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_plan")
    from arforge.core.agent_core import ArforgeAgent

    return ArforgeAgent().quick_plan(args.strip())


@register_slash("search", "Search codebase with semantic TF-IDF search", category="code", desc_key="slash.desc.search")
def _search(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_search")
    try:
        from arforge.semantic_code_search import semantic_search

        results = semantic_search(args.strip(), top_k=8)
        if not results:
            return f"没有找到匹配 \"{args.strip()}\" 的结果"
        lines = [f"\"{args.strip()}\" 的搜索结果：\n"]
        for r in results:
            score = r.get("score", 0)
            lines.append(f"  [{score:.2f}] {r['file']}  (line {r.get('line', '?')})")
        return "\n".join(lines)
    except Exception as exc:
        return f"搜索失败: {exc}"


@register_slash("symbol", "Search for symbols (functions, classes) in the codebase", category="code", desc_key="slash.desc.symbol")
def _symbol(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_symbol")
    try:
        from arforge.code_intelligence import search_symbol

        results = search_symbol(args.strip(), match_mode="substring")
        if not results:
            return f"没有匹配 \"{args.strip()}\" 的符号"
        lines = [f"匹配 \"{args.strip()}\" 的符号：\n"]
        for r in results[:12]:
            lines.append(f"  [{r.get('kind', '?')}] {r['name']} — {r.get('file', '?')}:{r.get('line', '?')}")
        if len(results) > 12:
            lines.append(f"  … 还有 {len(results) - 12} 个")
        return "\n".join(lines)
    except Exception as exc:
        return f"符号搜索失败: {exc}"


@register_slash("impact", "Analyze the impact of changing a file or symbol", category="code", desc_key="slash.desc.impact")
def _impact(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_impact")
    try:
        from arforge.impact_analyzer import analyze_change_impact

        result = analyze_change_impact(args.strip())
        lines = [
            f"影响分析: {args.strip()}",
            f"  风险: {result.get('risk', '?').upper()}  (评分: {result.get('risk_score', '?')})",
        ]
        deps = result.get("reverse_dependencies", [])[:8]
        if deps:
            lines.append(f"  依赖项 ({len(deps)}): {', '.join(deps)}")
        factors = result.get("risk_factors", {})
        if factors:
            lines.append(
                f"  深度: {factors.get('reverse_dependency_depth', '?')}  "
                f"引用: {factors.get('reference_count', '?')}  "
                f"有测试: {'是' if factors.get('has_tests') else '否'}"
            )
        return "\n".join(lines)
    except Exception as exc:
        return f"影响分析失败: {exc}"


# ========================================================================
# Memory & learning commands
# ========================================================================


@register_slash("learn", "Show learning system statistics", category="memory", desc_key="slash.desc.learn")
def _learn(args: str) -> str:
    """Show learning status with patterns, confidence, and injection impact."""
    from arforge.slash_memory_learning import learning_command
    from arforge.learning_cli import learning_status as rich_learning_status

    cmd, _, rest = args.strip().partition(" ")
    if cmd == "undo":
        return learning_command(args)
    if cmd in ("", "status"):
        try:
            return rich_learning_status()
        except Exception:
            return learning_command(args)
    return learning_command(args)
@register_slash("remember", "Save a memory for future sessions", category="memory", desc_key="slash.desc.remember")
def _remember(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_remember")
    from arforge.memory import save_memory_v2

    mem_id = save_memory_v2(args.strip(), mem_type="knowledge", importance=2)
    return f"已保存记忆 #{mem_id}: {args.strip()[:100]}"


@register_slash("memory", "List or delete saved memories", category="memory", desc_key="slash.desc.memory")
def _memory(args: str) -> str:
    from arforge.slash_memory_learning import memory_command

    return memory_command(args)


@register_slash("memories", "List saved memories", category="memory", desc_key="slash.desc.memories")
def _memories(args: str) -> str:
    if args.strip().startswith("delete"):
        from arforge.slash_memory_learning import memory_command

        return memory_command(args)
    from arforge.memory import query_memories

    rows = query_memories(limit=12)
    if not rows:
        return "暂无记忆"
    lines = [f"{len(rows)} 条记忆：\n"]
    for m in rows:
        imp = "★" * min(m.get("importance", 0), 5)
        lines.append(f"  #{m['id']} {imp}  {m['content'][:120]}")
    return "\n".join(lines)


# ========================================================================
# Agent & tool commands
# ========================================================================


@register_slash("tools", "List registered tools", category="agent", desc_key="slash.desc.tools")
def _tools(args: str) -> str:
    from arforge.tool_executor import list_tools

    tools = list_tools()
    if not tools:
        return "没有已注册的工具"
    lines = [f"已注册 {len(tools)} 个工具：\n"]
    for t in tools:
        risk = t.get("risk", "low")
        lines.append(f"  [{risk:8s}] {t['name']:20s} — {t.get('description', '')}")
    return "\n".join(lines)


@register_slash("agents", "List multi-agent roles", category="agent", desc_key="slash.desc.agents")
def _agents(args: str) -> str:
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    agents = agent.list_agents()
    if not agents:
        return "没有已注册的多智能体角色。多智能体可能已禁用。"
    lines = [f"{len(agents)} 个智能体角色：\n"]
    for a in agents:
        lines.append(f"  {a.get('name', '?'):20s} — {a.get('description', '?')}")
    return "\n".join(lines)


@register_slash("capability", "Show capability status or test with input", category="agent", desc_key="slash.desc.capability")
def _capability(args: str) -> str:
    if not args.strip():
        from arforge.capability.capability_cli import capability_status
        return capability_status()
    from arforge.capability.capability_cli import capability_test
    return capability_test(args.strip())


@register_slash("tokens", "Show token usage statistics", category="agent", desc_key="slash.desc.tokens")
def _tokens(args: str) -> str:
    from arforge.models.token_tracker import list_token_usage

    rows = list_token_usage(limit=10)
    if not rows:
        return "暂无 token 用量记录"
    lines = ["Token 用量：\n"]
    for r in rows:
        lines.append(f"  {r.get('model_name', '?'):24s} {r.get('total_tokens', 0)} tokens")
    return "\n".join(lines)


# ========================================================================
# General commands
# ========================================================================


@register_slash("ask", "One-shot question (same as arforge ask)", category="general", desc_key="slash.desc.ask")
def _ask(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_ask")
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    return agent.chat(args.strip()).answer


@register_slash("multi", "Use multi-agent orchestration for complex tasks", category="general", desc_key="slash.desc.multi")
def _multi(args: str) -> str:
    if not args.strip():
        return _t("slash.usage_multi")
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    result = agent.chat_multiagent(args.strip())
    mode = result.get("mode", "single")
    agents_used = result.get("agents_used", 0)
    conv_id = result.get("conversation_id", "")
    prefix = f"[{mode} 模式"
    if agents_used:
        prefix += f", {agents_used} 个智能体"
    if conv_id:
        prefix += f", id={conv_id[:12]}"
    prefix += "]\n\n"
    return prefix + result.get("answer", "")
