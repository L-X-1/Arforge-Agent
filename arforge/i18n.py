"""Internationalization system — Chinese-first, English switchable.

All UI strings live here keyed by namespace.key.  The active language is
persisted to ``~/.arforge/.arforge_lang`` and can be switched at runtime
with ``/lang zh`` or ``/lang en``.

Design principle (per project requirement #13):
    中文超强：中文理解和生成是核心优势，所有 UI、日志、错误提示优先中文化。
"""

from __future__ import annotations

import json
from pathlib import Path


# ========================================================================
# Language persistence
# ========================================================================

def _lang_file() -> Path:
    from arforge.paths import data_path

    return data_path(".arforge_lang")


def get_active_lang() -> str:
    """Return the active UI language: 'zh' or 'en'."""
    try:
        from arforge.paths import data_path
        from arforge.product.settings_runtime import SettingsRuntime

        configured = SettingsRuntime(data_path("settings.json"), _lang_file()).value("language")
        if configured in {"zh", "en"}:
            return configured
    except Exception:
        pass
    lf = _lang_file()
    if lf.exists():
        try:
            data = json.loads(lf.read_text(encoding="utf-8"))
            lang = data.get("lang", "zh")
            if lang in {"zh", "en"}:
                return lang
        except (json.JSONDecodeError, OSError):
            pass
    return "zh"  # Chinese-first default


def set_active_lang(lang: str) -> str:
    """Persist the active language and return it."""
    lang = lang if lang in {"zh", "en"} else "zh"
    from arforge.paths import data_path
    from arforge.product.settings_runtime import SettingsRuntime

    runtime = SettingsRuntime(data_path("settings.json"), _lang_file())
    current = runtime.get()
    if current["settings"]["language"] != lang or not runtime.path.exists():
        runtime.update({"language": lang}, current["revision"])
    return lang


# ========================================================================
# String store  (namespace.key → {zh, en})
# ========================================================================

STRINGS: dict[str, dict[str, str]] = {
    # ── Banner ────────────────────────────────────────────────────────
    "banner.title": {
        "zh": "Arforge Agent — 本地智能开发代理",
        "en": "Arforge Agent — Local Model Capability Enhancement Agent",
    },
    "banner.welcome": {
        "zh": "欢迎使用 Arforge Agent",
        "en": "Welcome to Arforge Agent",
    },
    "banner.tip_help": {
        "zh": "输入 /help 查看所有命令",
        "en": "Type /help to see all commands",
    },
    "banner.tip_chat": {
        "zh": "直接输入问题即可开始对话",
        "en": "Type your question directly to start chatting",
    },
    "banner.tip_lang": {
        "zh": "输入 /lang en 切换英文界面",
        "en": "Type /lang zh to switch to Chinese",
    },
    "banner.model": {
        "zh": "模型",
        "en": "Model",
    },
    "banner.multiagent": {
        "zh": "多智能体",
        "en": "Multi-agent",
    },
    "banner.enabled": {
        "zh": "已启用",
        "en": "enabled",
    },
    "banner.disabled": {
        "zh": "已禁用",
        "en": "disabled",
    },

    # ── CLI help ──────────────────────────────────────────────────────
    "help.usage": {
        "zh": "用法",
        "en": "Usage",
    },
    "help.options": {
        "zh": "选项",
        "en": "Options",
    },
    "help.repl_commands": {
        "zh": "交互命令",
        "en": "REPL commands",
    },
    "help.environment": {
        "zh": "环境变量",
        "en": "Environment",
    },
    "help.start_chat": {
        "zh": "启动交互对话（默认）",
        "en": "Start interactive chat (default)",
    },
    "help.ask_question": {
        "zh": "一次性问答（流式输出）",
        "en": "One-shot question with streaming output",
    },
    "help.run_doctor": {
        "zh": "运行环境诊断",
        "en": "Run environment diagnostics",
    },
    "help.show_privacy": {
        "zh": "显示隐私摘要与同意状态",
        "en": "Show privacy summary and consent status",
    },
    "help.export_data": {
        "zh": "导出用户数据（记忆、Token 用量）",
        "en": "Export user data (memories, token usage)",
    },
    "help.system_status": {
        "zh": "系统状态仪表盘",
        "en": "System status dashboard",
    },
    "help.list_tools": {
        "zh": "列出已注册工具及参数",
        "en": "List registered tools with schemas",
    },
    "help.list_agents": {
        "zh": "列出多智能体编排角色",
        "en": "List multi-agent orchestration roles",
    },
    "help.capabilities": {
        "zh": "能力检查与测试",
        "en": "Capability inspection and testing",
    },
    "help.memory_stats": {
        "zh": "记忆库统计",
        "en": "Memory store statistics",
    },
    "help.learning_stats": {
        "zh": "学习系统统计",
        "en": "Learning system statistics",
    },
    "help.show_config": {
        "zh": "显示当前配置",
        "en": "Show current configuration",
    },
    "help.no_stream": {
        "zh": "禁用流式输出（批处理模式）",
        "en": "Disable streaming output (batch mode)",
    },
    "help.and_n_more": {
        "zh": "… 还有 {n} 个（在交互界面输入 /help 查看完整列表）",
        "en": "… and {n} more (type /help in REPL for full list)",
    },
    "help.repl_note": {
        "zh": "交互界面命令:",
        "en": "REPL commands:",
    },

    # ── REPL ──────────────────────────────────────────────────────────
    "repl.starting": {
        "zh": "正在启动交互对话（输入 /help 查看命令，/exit 退出）",
        "en": "Starting interactive chat (type /help for commands, /exit to quit)",
    },
    "repl.one_shot_hint": {
        "zh": "使用 `arforge ask \"...\"` 进行一次性问答",
        "en": "Use `arforge ask \"...\"` for one-shot questions",
    },
    "repl.goodbye": {
        "zh": "再见",
        "en": "Goodbye",
    },
    "repl.thinking": {
        "zh": "思考中…",
        "en": "Thinking…",
    },
    "repl.interrupted": {
        "zh": "已中断",
        "en": "Interrupted",
    },
    "repl.elapsed": {
        "zh": "耗时",
        "en": "elapsed",
    },
    "repl.unknown_cmd": {
        "zh": "未知命令",
        "en": "Unknown command",
    },
    "repl.type_help": {
        "zh": "输入 /help 查看可用命令",
        "en": "Type /help for available commands",
    },
    "repl.history_cleared": {
        "zh": "对话历史已清除",
        "en": "Conversation history cleared",
    },
    "repl.tool_separator": {
        "zh": "工具",
        "en": "Tool",
    },

    # ── Slash commands ────────────────────────────────────────────────
    "slash.cmd_failed": {
        "zh": "命令执行失败",
        "en": "Command failed",
    },
    "slash.usage_prefix": {
        "zh": "用法",
        "en": "Usage",
    },
    "slash.available_commands": {
        "zh": "可用命令",
        "en": "Available commands",
    },
    "slash.category.system": {
        "zh": "系统",
        "en": "System",
    },
    "slash.category.code": {
        "zh": "代码智能",
        "en": "Code Intelligence",
    },
    "slash.category.memory": {
        "zh": "记忆与学习",
        "en": "Memory & Learning",
    },
    "slash.category.agent": {
        "zh": "智能体与工具",
        "en": "Agent & Tools",
    },
    "slash.category.general": {
        "zh": "通用",
        "en": "General",
    },
    "slash.help_header": {
        "zh": "可用斜杠命令",
        "en": "Available slash commands",
    },

    # ── Slash command descriptions ───────────────────────────────────
    "slash.desc.help": {"zh": "列出所有斜杠命令", "en": "List all slash commands"},
    "slash.desc.status": {"zh": "显示 Arforge 系统状态", "en": "Show Arforge system status"},
    "slash.desc.doctor": {"zh": "运行环境诊断", "en": "Run environment diagnostics"},
    "slash.desc.clear": {"zh": "清除对话历史", "en": "Clear conversation history"},
    "slash.desc.review": {"zh": "审查代码的 bug、安全问题和改进点", "en": "Review code for bugs, security, and improvements"},
    "slash.desc.explain": {"zh": "详细解释代码或概念", "en": "Explain code or concepts in detail"},
    "slash.desc.fix": {"zh": "修复 bug 或问题并给出具体改动", "en": "Fix a bug or issue with concrete code changes"},
    "slash.desc.plan": {"zh": "为任务生成结构化计划", "en": "Generate a structured plan for a task"},
    "slash.desc.search": {"zh": "用语义 TF-IDF 搜索代码库", "en": "Search codebase with semantic TF-IDF search"},
    "slash.desc.symbol": {"zh": "在代码库中搜索符号（函数、类）", "en": "Search for symbols (functions, classes) in the codebase"},
    "slash.desc.impact": {"zh": "分析改动某个文件或符号的影响", "en": "Analyze the impact of changing a file or symbol"},
    "slash.desc.learn": {"zh": "显示学习系统统计", "en": "Show learning system statistics"},
    "slash.desc.remember": {"zh": "保存一条记忆供后续会话使用", "en": "Save a memory for future sessions"},
    "slash.desc.memories": {"zh": "列出已保存的记忆", "en": "List saved memories"},
    "slash.desc.tools": {"zh": "列出已注册工具", "en": "List registered tools"},
    "slash.desc.agents": {"zh": "列出多智能体角色", "en": "List multi-agent roles"},
    "slash.desc.capability": {"zh": "显示能力状态或用输入测试", "en": "Show capability status or test with input"},
    "slash.desc.tokens": {"zh": "显示 token 用量统计", "en": "Show token usage statistics"},
    "slash.desc.ask": {"zh": "一次性提问（等同于 arforge ask）", "en": "One-shot question (same as arforge ask)"},
    "slash.desc.multi": {"zh": "用多智能体编排处理复杂任务", "en": "Use multi-agent orchestration for complex tasks"},

    # ── Slash command inline messages ───────────────────────────────
    "slash.usage_review": {"zh": "用法: /review <文件路径或代码片段>", "en": "Usage: /review <file path or code snippet>"},
    "slash.usage_explain": {"zh": "用法: /explain <代码或概念>", "en": "Usage: /explain <code or concept>"},
    "slash.usage_fix": {"zh": "用法: /fix <bug 描述或文件路径>", "en": "Usage: /fix <bug description or file path>"},
    "slash.usage_plan": {"zh": "用法: /plan <任务描述>", "en": "Usage: /plan <task description>"},
    "slash.usage_search": {"zh": "用法: /search <查询>", "en": "Usage: /search <query>"},
    "slash.usage_symbol": {"zh": "用法: /symbol <名称>（支持精确/前缀/子串匹配）", "en": "Usage: /symbol <name>  (supports exact/prefix/substring matching)"},
    "slash.usage_impact": {"zh": "用法: /impact <文件路径或符号>", "en": "Usage: /impact <file_path or symbol>"},
    "slash.usage_remember": {"zh": "用法: /remember <要保存的内容>", "en": "Usage: /remember <content to save>"},
    "slash.usage_ask": {"zh": "用法: /ask <问题>", "en": "Usage: /ask <question>"},
    "slash.usage_multi": {"zh": "用法: /multi <复杂任务描述>", "en": "Usage: /multi <complex task description>"},
    "slash.usage_help": {"zh": "输入 /help 查看可用命令", "en": "Type /help for available commands"},
    "slash.not_slash": {"zh": "不是斜杠命令。", "en": "Not a slash command."},
    "slash.unknown": {"zh": "未知斜杠命令: {name}", "en": "Unknown slash command: {name}"},
    "slash.failed": {"zh": "命令 /{name} 失败: {error}", "en": "Command /{name} failed: {error}"},

    # ── Doctor ────────────────────────────────────────────────────────
    "doctor.title": {
        "zh": "环境诊断",
        "en": "Environment Diagnostics",
    },
    "doctor.env": {
        "zh": "环境",
        "en": "Environment",
    },
    "doctor.modules": {
        "zh": "模块",
        "en": "Modules",
    },
    "doctor.paths": {
        "zh": "路径",
        "en": "Paths",
    },
    "doctor.all_ok": {
        "zh": "所有检查通过 — Arforge 已就绪",
        "en": "All checks passed — Arforge is ready",
    },
    "doctor.warn_nonblocking": {
        "zh": "所有必要检查已通过（警告不影响使用）",
        "en": "All essential checks passed (warnings are non-blocking)",
    },
    "doctor.fail_items": {
        "zh": "项检查未通过 — 请查看上方详情",
        "en": "check(s) failed — review the items above",
    },
    "doctor.completed_in": {
        "zh": "检查完成",
        "en": "Completed in",
    },
    "doctor.ready": {
        "zh": "就绪",
        "en": "Ready",
    },
    "doctor.action_required": {
        "zh": "需要处理",
        "en": "Action required",
    },

    # ── Privacy ───────────────────────────────────────────────────────
    "privacy.title": {
        "zh": "隐私",
        "en": "Privacy",
    },
    "privacy.local_first": {
        "zh": "本地优先 — 所有数据存储于 ~/.arforge/",
        "en": "Local-first — all data stored in ~/.arforge/",
    },
    "privacy.network": {
        "zh": "仅在配置后调用模型 API",
        "en": "model API calls only when configured",
    },
    "privacy.consent_not_recorded": {
        "zh": "隐私同意尚未记录",
        "en": "Privacy consent not yet recorded",
    },
    "privacy.consent_explain": {
        "zh": "Arforge 将所有数据存储在本地，仅在您明确提问时调用模型 API。不会向任何服务器发送遥测数据。",
        "en": "Arforge stores all data locally and only calls the model API when you explicitly ask a question. No telemetry is sent to any server.",
    },
    "privacy.ask_consent": {
        "zh": "是否记录隐私同意？",
        "en": "Record consent?",
    },
    "privacy.consent_recorded": {
        "zh": "隐私同意：已记录",
        "en": "Privacy consent: recorded",
    },
    "privacy.consent_skipped": {
        "zh": "已跳过隐私同意。部分功能可能受限。",
        "en": "Consent skipped. Some features may be limited.",
    },

    # ── Config ────────────────────────────────────────────────────────
    "config.title": {
        "zh": "配置",
        "en": "Configuration",
    },
    "config.api_key_set": {
        "zh": "已配置",
        "en": "configured",
    },
    "config.api_key_missing": {
        "zh": "未设置",
        "en": "not set",
    },
    "config.files_loaded": {
        "zh": "配置文件（按加载顺序）",
        "en": "Config files (loaded in order)",
    },

    # ── Status ────────────────────────────────────────────────────────
    "status.title": {
        "zh": "系统状态",
        "en": "System Status",
    },
    "status.memory": {
        "zh": "记忆",
        "en": "Memory",
    },
    "status.total_entries": {
        "zh": "总条目数",
        "en": "Total entries",
    },
    "status.important": {
        "zh": "重要条目",
        "en": "Important",
    },
    "status.recent_tokens": {
        "zh": "近期 Token 用量",
        "en": "Recent token usage",
    },
    "status.no_tokens": {
        "zh": "暂无 Token 用量记录",
        "en": "No token usage recorded yet",
    },
    "status.all_real": {
        "zh": "所有模块：真实实现（无占位代码）",
        "en": "All modules: real implementations (no stubs)",
    },
    "status.skeletons_remain": {
        "zh": "个占位模块残留",
        "en": "source skeleton modules remaining",
    },
    "status.agent_roles": {
        "zh": "多智能体角色",
        "en": "Multi-agent roles",
    },
    "status.roles_registered": {
        "zh": "个已注册",
        "en": "registered",
    },

    # ── Tools ─────────────────────────────────────────────────────────
    "tools.title": {
        "zh": "已注册工具",
        "en": "Registered Tools",
    },
    "tools.count": {
        "zh": "个工具可用",
        "en": "tools available",
    },
    "tools.verbose_hint": {
        "zh": "使用 --verbose 查看完整参数详情",
        "en": "Use --verbose for full parameter details",
    },

    # ── Memory ────────────────────────────────────────────────────────
    "memory.title": {
        "zh": "记忆库",
        "en": "Memory Store",
    },
    "memory.storage": {
        "zh": "存储",
        "en": "Storage",
    },
    "memory.sqlite": {
        "zh": "SQLite 数据库 ~/.arforge/arforge.db",
        "en": "SQLite at ~/.arforge/arforge.db",
    },
    "memory.recent": {
        "zh": "最近记忆",
        "en": "Recent memories",
    },
    "memory.empty": {
        "zh": "暂无记忆",
        "en": "No memories stored yet",
    },

    # ── Learning ──────────────────────────────────────────────────────
    "learning.title": {
        "zh": "学习系统",
        "en": "Learning System",
    },

    # ── Capabilities ──────────────────────────────────────────────────
    "capabilities.title": {
        "zh": "能力",
        "en": "Capabilities",
    },
    "capabilities.registered": {
        "zh": "个能力已注册",
        "en": "capabilities registered",
    },
    "capabilities.test_usage": {
        "zh": "用法: arforge capabilities test <输入>",
        "en": "Usage: arforge capabilities test <input>",
    },

    # ── Agents ────────────────────────────────────────────────────────
    "agents.title": {
        "zh": "多智能体角色",
        "en": "Multi-Agent Roles",
    },
    "agents.unavailable": {
        "zh": "多智能体系统不可用或没有已注册角色",
        "en": "Multi-agent system not available or no roles registered",
    },
    "agents.hint": {
        "zh": "使用 arforge chat 启用多智能体编排（默认启用）",
        "en": "Use arforge chat for multi-agent orchestration (enabled by default)",
    },

    # ── Export ────────────────────────────────────────────────────────
    "export.exporting": {
        "zh": "正在导出到",
        "en": "Exporting to",
    },
    "export.success": {
        "zh": "已导出",
        "en": "Exported",
    },
    "export.memories": {
        "zh": "条记忆",
        "en": "memories",
    },
    "export.failed": {
        "zh": "导出失败",
        "en": "Export failed",
    },

    # ── Errors ────────────────────────────────────────────────────────
    "error.model_call_failed": {
        "zh": "模型调用失败",
        "en": "Model call failed",
    },
    "error.check_doctor": {
        "zh": "请运行 `arforge doctor` 检查配置",
        "en": "Check `arforge doctor` for diagnostics",
    },
    "error.unknown_command": {
        "zh": "未知命令",
        "en": "Unknown command",
    },
    "error.run_help": {
        "zh": "运行 `arforge --help` 查看用法",
        "en": "Run `arforge --help` for usage",
    },
    "error.usage_prefix": {
        "zh": "用法",
        "en": "Usage",
    },

    # ── Onboarding ────────────────────────────────────────────────────
    "onboarding.welcome_title": {
        "zh": "🎉 欢迎使用 Arforge Agent",
        "en": "🎉 Welcome to Arforge Agent",
    },
    "onboarding.welcome_subtitle": {
        "zh": "看起来这是您第一次运行 Arforge Agent。让我们花一分钟完成初始配置。",
        "en": "It looks like this is your first time running Arforge Agent. Let's take a minute to set things up.",
    },
    "onboarding.what_is_arforge": {
        "zh": "Arforge Agent 是一个本地优先的 CLI 智能体，它可以：",
        "en": "Arforge Agent is a local-first CLI agent that can:",
    },
    "onboarding.feature_chat": {
        "zh": "💬 自然语言对话 — 编程问答、代码审查、问题诊断",
        "en": "💬 Natural language chat — coding Q&A, code review, debugging",
    },
    "onboarding.feature_tools": {
        "zh": "🔧 工具执行 — 文件操作、命令运行、代码搜索",
        "en": "🔧 Tool execution — file ops, command execution, code search",
    },
    "onboarding.feature_memory": {
        "zh": "🧠 持久记忆 — 记住您的偏好、习惯和工作流",
        "en": "🧠 Persistent memory — remembers your preferences and workflow",
    },
    "onboarding.feature_privacy": {
        "zh": "🔒 隐私优先 — 所有数据本地存储，不上传任何遥测数据",
        "en": "🔒 Privacy-first — all data stored locally, zero telemetry",
    },
    "onboarding.step_api_key": {
        "zh": "第一步：配置 DeepSeek API Key",
        "en": "Step 1: Configure your DeepSeek API Key",
    },
    "onboarding.api_key_guide": {
        "zh": "Arforge 使用 DeepSeek 模型提供推理能力。\n"
             "  1. 访问 https://platform.deepseek.com/api_keys\n"
             "  2. 注册账号并创建一个 API Key\n"
             "  3. 将 API Key 粘贴到下方",
        "en": "Arforge uses DeepSeek models for reasoning.\n"
              "  1. Visit https://platform.deepseek.com/api_keys\n"
              "  2. Sign up and create an API Key\n"
              "  3. Paste your API Key below",
    },
    "onboarding.enter_api_key": {
        "zh": "请输入您的 DeepSeek API Key",
        "en": "Enter your DeepSeek API Key",
    },
    "onboarding.api_key_empty": {
        "zh": "API Key 不能为空。请粘贴完整的 API Key（以 sk- 开头）。",
        "en": "API Key cannot be empty. Please paste your full API Key (starts with sk-).",
    },
    "onboarding.api_key_saved": {
        "zh": "API Key 已保存",
        "en": "API Key saved",
    },
    "onboarding.step_model": {
        "zh": "第二步：选择默认模型",
        "en": "Step 2: Choose your default model",
    },
    "onboarding.model_description": {
        "zh": "DeepSeek 提供多种模型。请选择最适合您需求的默认模型（稍后可在 .env 中修改）：",
        "en": "DeepSeek offers several models. Choose a default (you can change this later in .env):",
    },
    "onboarding.model_chat": {
        "zh": "通用对话（便宜快速，推荐）",
        "en": "General chat (cheap & fast, recommended)",
    },
    "onboarding.model_reasoner": {
        "zh": "深度推理（适合复杂分析，较贵较慢）",
        "en": "Deep reasoning (best for complex analysis, slower & pricier)",
    },
    "onboarding.model_coder": {
        "zh": "代码专用（编程任务优化）",
        "en": "Code specialist (optimized for programming)",
    },
    "onboarding.select_model": {
        "zh": "请选择模型 [1/2/3]",
        "en": "Select model [1/2/3]",
    },
    "onboarding.model_selected": {
        "zh": "已选择模型",
        "en": "Model selected",
    },
    "onboarding.step_test": {
        "zh": "第三步：测试连接",
        "en": "Step 3: Test connection",
    },
    "onboarding.testing": {
        "zh": "正在测试 API 连接…",
        "en": "Testing API connection…",
    },
    "onboarding.test_success": {
        "zh": "✓ 连接成功！模型响应正常",
        "en": "✓ Connection successful! Model is responding",
    },
    "onboarding.test_failed": {
        "zh": "✗ 连接失败",
        "en": "✗ Connection failed",
    },
    "onboarding.test_failed_detail": {
        "zh": "请检查：1) API Key 是否正确 2) 网络是否可以访问 api.deepseek.com\n"
             "您可以之后运行 `arforge doctor` 排查问题",
        "en": "Check: 1) Is your API Key correct? 2) Can you reach api.deepseek.com?\n"
              "You can run `arforge doctor` later to troubleshoot",
    },
    "onboarding.ready_title": {
        "zh": "✅ 配置完成！",
        "en": "✅ Setup complete!",
    },
    "onboarding.ready_message": {
        "zh": "Arforge Agent 已就绪。配置已保存到 .env 文件。\n\n"
             "  快速开始：\n"
             "  • 直接输入问题开始对话\n"
             "  • 输入 /help 查看所有命令\n"
             "  • 输入 /lang en 切换到英文界面\n"
             "  • 运行 arforge doctor 查看系统状态\n",
        "en": "Arforge Agent is ready. Configuration saved to .env file.\n\n"
              "  Quick start:\n"
              "  • Type your question to start chatting\n"
              "  • Type /help to see all commands\n"
              "  • Type /lang zh to switch to Chinese UI\n"
              "  • Run arforge doctor to check system status\n",
    },
    "onboarding.skip_hint": {
        "zh": "（随时按 Ctrl+C 跳过引导，之后可运行 arforge doctor 完成配置）",
        "en": "(Press Ctrl+C anytime to skip setup; run arforge doctor later to configure)",
    },

    # ── Language switch ───────────────────────────────────────────────
    "lang.switch_zh": {
        "zh": "界面语言已切换为：中文 🇨🇳\n"
              "Language switched to: Chinese 🇨🇳",
        "en": "界面语言已切换为：中文 🇨🇳\n"
              "Language switched to: Chinese 🇨🇳",
    },
    "lang.switch_en": {
        "zh": "界面语言已切换为：English 🇺🇸\n"
              "Language switched to: English 🇺🇸",
        "en": "界面语言已切换为：English 🇺🇸\n"
              "Language switched to: English 🇺🇸",
    },
    "lang.switch_hint": {
        "zh": "随时输入 /lang zh 或 /lang en 切换语言",
        "en": "Type /lang zh or /lang en anytime to switch language",
    },
    "lang.usage": {
        "zh": "用法: /lang zh | /lang en",
        "en": "Usage: /lang zh | /lang en",
    },
    "lang.current": {
        "zh": "当前语言",
        "en": "Current language",
    },

    # ── Reasoning section titles (chat_stream collapsible panel) ──────
    "reasoning.understanding": {"zh": "理解", "en": "Understanding"},
    "reasoning.thinking": {"zh": "推理", "en": "Reasoning"},
    "reasoning.evidence": {"zh": "证据", "en": "Evidence"},
    "reasoning.reflection": {"zh": "自检", "en": "Reflection"},
    "reasoning.panel_done": {
        "zh": "已完成思考 · {n} 项",
        "en": "Thinking done · {n} sections",
    },
    "reasoning.panel_empty": {
        "zh": "此回答未生成推理详情。",
        "en": "No reasoning detail for this answer.",
    },
    "reasoning.streaming": {"zh": "正在思考…", "en": "Thinking…"},

    # ── Thinking depth tiers (status line + /thinking command) ────────
    "thinking.low": {"zh": "低深度思考", "en": "Low-depth think"},
    "thinking.medium": {"zh": "中等深度思考", "en": "Medium-depth think"},
    "thinking.high": {"zh": "高深度思考", "en": "High-depth think"},
    "thinking.ultra": {"zh": "超高深度思考", "en": "Ultra-depth think"},
    "thinking.low_mode": {"zh": "低深度模式", "en": "Low-depth mode"},
    "thinking.medium_mode": {"zh": "中等深度模式", "en": "Medium-depth mode"},
    "thinking.high_mode": {"zh": "高深度模式", "en": "High-depth mode"},
    "thinking.ultra_mode": {"zh": "超高深度模式", "en": "Ultra-depth mode"},
    "thinking.switched": {"zh": "已切换", "en": "Switched to"},
    "thinking.usage": {
        "zh": "用法：/thinking low | medium | high | ultra",
        "en": "Usage: /thinking low | medium | high | ultra",
    },

    # ── Trust screen (trust_screen.py) ───────────────────────────────
    "trust.title": {"zh": "Arforge Agent", "en": "Arforge Agent"},
    "trust.accessing": {"zh": "工作区访问", "en": "Accessing workspace"},
    "trust.safety": {"zh": "安全检查", "en": "Quick safety check"},
    "trust.question": {
        "zh": "这是您创建或信任的项目吗？（例如您自己的代码、知名开源项目、或团队项目）",
        "en": "Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).",
    },
    "trust.hint": {
        "zh": "如不确定，请先检查此文件夹的内容。",
        "en": "If not, take a moment to review what's in this folder first.",
    },
    "trust.notice": {
        "zh": "Arforge Agent 将能够在此目录中读取、编辑和执行文件。",
        "en": "Arforge Agent will be able to read, edit, and execute files here.",
    },
    "trust.guide": {"zh": "安全指南", "en": "Security guide"},
    "trust.option_yes": {"zh": "1. 是，我信任此文件夹", "en": "1. Yes, I trust this folder"},
    "trust.option_no": {"zh": "2. 否，退出", "en": "2. No, exit"},
    "trust.confirm_hint": {"zh": "Enter 确认  ·  Esc 取消", "en": "Enter to confirm  ·  Esc to cancel"},
    "trust.footer": {
        "zh": "信任状态保存在本地，同一工作区下次不再提示",
        "en": "Trust is stored locally and remembered for this workspace",
    },
    "trust.exited": {
        "zh": "已退出。如需重新授权，请删除 ~/.arforge/trusted_workspaces.json",
        "en": "Exited. Delete ~/.arforge/trusted_workspaces.json to re-authorize.",
    },
    "trust.cancelled": {"zh": "已取消。", "en": "Cancelled."},
    "trust.workspace_trusted": {"zh": "（已信任）", "en": "(trusted)"},
    "trust.workspace_label": {"zh": "工作区:", "en": "Workspace:"},
    "trust.non_tty_closed": {
        "zh": "Arforge 在非交互模式下需要工作区信任。仅对你信任的工作区设置 ARFORGE_TRUST_WORKSPACE=1。",
        "en": "Arforge requires workspace trust in non-interactive mode. Set ARFORGE_TRUST_WORKSPACE=1 only for a workspace you trust.",
    },

    # ── Agentic code command (cli.py _run_code) ──────────────────────
    "code.task_header": {"zh": "智能体任务", "en": "Agentic Task"},
    "code.workspace": {"zh": "工作区", "en": "workspace"},
    "code.model": {"zh": "模型", "en": "model"},
    "code.mode": {"zh": "模式", "en": "mode"},
    "code.task": {"zh": "任务", "en": "task"},
    "code.classifier": {"zh": "分类器", "en": "classifier"},
    "code.blocked": {"zh": "输入被权限分类器拦截：", "en": "Blocked by classifier: "},
    "code.working": {"zh": "执行中…", "en": "Working…"},
    "code.compact": {
        "zh": "压缩历史 {summarized} 条 ({before}→{after} tok)",
        "en": "Compacted {summarized} msgs ({before}→{after} tok)",
    },
    "code.plan_exploring": {"zh": "  [plan] 只读探索并制定方案…", "en": "  [plan] read-only exploration and planning…"},
    "code.plan_not_approved": {
        "zh": "  未批准。如需执行，请用 --mode acceptEdits 重新运行。",
        "en": "  Not approved. Re-run with --mode acceptEdits to execute.",
    },
    "code.plan_approved": {"zh": "  方案已批准，切换到 acceptEdits 执行…", "en": "  Plan approved, switching to acceptEdits…"},
    "code.interrupted": {"zh": "  [中断] 收到停止请求，将在当前步骤后优雅停止…", "en": "  [interrupt] stop requested, will halt after the current step…"},
    "code.resume_load": {"zh": "  从 {run_id} 续跑（载入 {n} 条对话）…", "en": "  Resuming {run_id} (loaded {n} messages)…"},
    "code.resume_not_found": {"zh": "找不到可续跑的 run: {run_id}", "en": "No resumable run found: {run_id}"},
    "code.report_written": {"zh": "  报告已写入 {path}", "en": "  Report written to {path}"},
    "code.report_write_failed": {"zh": "写报告失败: {error}", "en": "Failed to write report: {error}"},
    "code.max_steps_warn": {
        "zh": "  ⚠ 任务用满 {steps} 步仍未自然结束，可能未完成。建议把任务拆小后分步执行；上面的『任务报告』已列出本次完成的部分。",
        "en": "  ⚠ Task hit the {steps}-step cap without finishing; it may be incomplete. Break it into smaller steps; the task report above lists what was completed.",
    },
    "code.conversation_saved": {"zh": "  对话已保存，可用  arforge code --resume {run_id}  继续", "en": "  Conversation saved; resume with  arforge code --resume {run_id}"},
    "code.changes_recorded": {"zh": "  本轮改动已记录，可用  arforge revert {run_id}  撤销本轮", "en": "  Changes recorded; undo with  arforge revert {run_id}"},
    "code.no_api_key": {
        "zh": "未配置 DEEPSEEK_API_KEY，无法运行 agentic 任务。",
        "en": "DEEPSEEK_API_KEY is not set; cannot run an agentic task.",
    },
    "code.usage": {"zh": "用法: arforge code \"<任务>\"", "en": "Usage: arforge code \"<task>\""},
    "code.resume_placeholder": {"zh": "（继续上次未完成的任务）", "en": "(continue the previous unfinished task)"},
    "code.report_title": {"zh": "任务报告", "en": "Task Report"},
    "code.report_label": {"zh": "任务报告:", "en": "Task report:"},
    "code.report_explored": {"zh": "探索文件({n})", "en": "Explored files ({n})"},
    "code.report_modified": {"zh": "修改文件({n})", "en": "Modified files ({n})"},
    "code.report_commands": {"zh": "执行命令({n})", "en": "Commands run ({n})"},
    "code.report_verify": {"zh": "交付校验", "en": "Delivery checks"},
    "code.report_empty": {"zh": "  (本次无文件/命令活动)", "en": "  (no file/command activity this run)"},
    "code.obs_llm_calls": {"zh": "LLM 调用", "en": "LLM calls"},
    "code.obs_tool_calls": {"zh": "工具调用", "en": "Tool calls"},
    "code.obs_total_tokens": {"zh": "总 token", "en": "Total tokens"},
    "code.obs_cost": {"zh": "成本 (CNY)", "en": "Cost (CNY)"},
    "code.plan_run_failed": {"zh": "Plan run failed", "en": "Plan run failed"},
    "code.agentic_run_failed": {"zh": "Agentic run failed", "en": "Agentic run failed"},

    # ── Dogfood command ──────────────────────────────────────────────
    "dogfood.title": {"zh": "Dogfood 统计", "en": "Dogfood Stats"},
    "dogfood.empty": {
        "zh": "暂无 dogfood 记录（跑过 arforge code 任务后这里会有累计统计）。",
        "en": "No dogfood records yet (run arforge code tasks to accumulate stats).",
    },
    "dogfood.summary": {
        "zh": "dogfood 累计 {total} 次任务：成功 {passed} / 失败 {failed} （成功率 {rate}%）",
        "en": "dogfood across {total} tasks: {passed} passed / {failed} failed ({rate}% success)",
    },
    "dogfood.detail": {
        "zh": "平均步数 {steps} | 累计 token {tokens} | 累计成本 ¥{cost}",
        "en": "avg steps {steps} | total tokens {tokens} | total cost ¥{cost}",
    },

    # ── Revert command ───────────────────────────────────────────────
    "revert.no_runs": {"zh": "没有可回滚的运行记录", "en": "No run available to revert"},
    "revert.not_found": {"zh": "找不到运行记录: {run_id}", "en": "Run not found: {run_id}"},
    "revert.done": {
        "zh": "已回滚 {run_id}：恢复 {restored} 个文件、删除 {deleted} 个新建文件",
        "en": "Reverted {run_id}: restored {restored} files, deleted {deleted} new files",
    },
    "revert.skipped": {"zh": "、跳过 {n} 个", "en": ", skipped {n}"},

    # ── Eval command ────────────────────────────────────────────────
    "eval.title": {"zh": "评测", "en": "Eval"},
    "eval.no_api_key": {"zh": "未配置 DEEPSEEK_API_KEY，无法运行 eval。", "en": "DEEPSEEK_API_KEY is not set; cannot run eval."},
    "eval.mode_auto": {"zh": "自动批准·非交互", "en": "auto-approved, non-interactive"},
    "eval.evaluating": {"zh": "评测中…", "en": "Evaluating…"},
    "eval.baseline_updated": {"zh": "  已更新评估基线 (eval_baseline.json)", "en": "  Eval baseline updated (eval_baseline.json)"},
    "eval.success_rate": {"zh": "成功率", "en": "Success rate"},
    "eval.avg_score": {"zh": "平均分", "en": "Avg score"},
    "eval.total_tokens": {"zh": "总 token", "en": "Total tokens"},
    "eval.total_cost": {"zh": "总成本 (CNY)", "en": "Total cost (CNY)"},

    # ── Retrieval eval command ──────────────────────────────────────
    "retrieval_eval.title": {"zh": "检索评测", "en": "Retrieval Eval"},
    "retrieval_eval.hit_rate": {"zh": "命中率", "en": "Hit rate"},
    "retrieval_eval.no_recall": {"zh": "(无召回)", "en": "(no recall)"},

    # ── REPL labels (were hardcoded; consolidating the few remaining) ─
    "repl.send_placeholder": {"zh": "随心输入", "en": "Type anything"},
    "repl.send_label": {"zh": "向 Arforge 发送任务", "en": "Send a task to Arforge"},
}


# ========================================================================
# Public API
# ========================================================================

def t(key: str, lang: str | None = None, **kwargs) -> str:
    """Look up a UI string by key for the active language.

    Usage::

        t("banner.welcome")          # → "欢迎使用 Arforge Agent"
        t("banner.welcome", "en")    # → "Welcome to Arforge Agent"
        t("help.and_n_more", n=5)    # → "… 还有 5 个（…）"
    """
    lang = lang or get_active_lang()
    entry = STRINGS.get(key, {})
    text = entry.get(lang) or entry.get("zh") or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, ValueError):
            return text
    return text


def all_strings_for_lang(lang: str) -> dict[str, str]:
    """Return {key: text} for the given language (for bulk preloading)."""
    return {k: v.get(lang, v.get("zh", k)) for k, v in STRINGS.items()}
