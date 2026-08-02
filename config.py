"""Runtime configuration.

Loads exactly one explicit, profile, or workspace environment file.

Default model is `deepseek-v4-flash` for the current product test baseline. Operators can
override via the DEEPSEEK_MODEL environment variable when they have access to a
different model on their account.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

def _absolute_env_path(path: str) -> str:
    """Return a stable, display-safe absolute path for a configuration candidate."""
    return os.path.abspath(os.path.expanduser(path))


_project_env = _absolute_env_path(".env")
_configured_home = os.getenv("ARFORGE_HOME")
_user_env = _absolute_env_path(
    os.path.join(_configured_home, ".env") if _configured_home else "~/.arforge/.env"
)
_configured_env = os.getenv("ARFORGE_ENV_FILE", "").strip()
_explicit_env = _absolute_env_path(_configured_env) if _configured_env else None
# Keep this precedence identical to packages/core/src/config/product-env.ts:
# an inherited process environment wins, followed by an explicit file, the
# private profile file, and finally the workspace development file.
_config_file_candidates = tuple(
    dict.fromkeys(
        candidate
        for candidate in (_explicit_env, _user_env, _project_env)
        if candidate is not None
    )
)
_loaded_config_file: str | None = None
if _explicit_env is not None and not os.path.isfile(_explicit_env):
    raise RuntimeError(f"ARFORGE_ENV_FILE does not exist: {_explicit_env}")
for _candidate in _config_file_candidates:
    if os.path.isfile(_candidate):
        load_dotenv(_candidate, override=False)
        _loaded_config_file = _candidate
        break

_env_loaded = _loaded_config_file is not None


def get_config_file_status() -> tuple[dict[str, object], ...]:
    """Describe configuration candidates without exposing any configuration values."""
    return tuple(
        {
            "path": path,
            "exists": os.path.isfile(path),
            "loaded": path == _loaded_config_file,
        }
        for path in _config_file_candidates
    )

# Do not call ``load_dotenv()`` without an explicit path here. Its stack-based
# search can discover an unrelated parent project's secrets when Arforge is
# launched from an installed wheel or test environment.

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

# Product test baseline. End users can override this non-secret identifier with
# DEEPSEEK_MODEL in their private environment file.
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")

# ── Multi-provider support (T21) ────────────────────────────────────────
# Active provider: "deepseek" (default), "openai", or "anthropic"
ARFORGE_PROVIDER = os.getenv("ARFORGE_PROVIDER", "deepseek").lower()

# OpenAI
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")

# External provider (Anthropic API)
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "external-compatible-model")

# Provider context windows
MODEL_CONTEXT_WINDOW = {
    # DeepSeek V4 official API catalog (1M context).
    "deepseek-v4-flash": 1_000_000,
    "deepseek-v4-pro": 1_000_000,
    # Backward-compatible API aliases remain routable for existing profiles.
    # Keep their conservative historical window until the configured endpoint
    # advertises a larger model-specific limit.
    "deepseek-chat": 65_536,
    "deepseek-reasoner": 65_536,
    "deepseek-coder": 65_536,
    # OpenAI
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "o3-mini": 200000,
    "o1": 200000,
    # External provider (Anthropic API)
    "external-compatible-model": 200000,
}

# Recognised model names — used by the doctor to flag obviously wrong overrides.
KNOWN_DEEPSEEK_MODELS = {
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-coder",
}

CHAT_MAX_TOKENS = int(os.getenv("CHAT_MAX_TOKENS", "16384"))
TEMPERATURE = float(os.getenv("TEMPERATURE", "0.7"))
CHAT_TEMPERATURE = float(os.getenv("CHAT_TEMPERATURE", str(TEMPERATURE)))
CODE_TEMPERATURE = float(os.getenv("CODE_TEMPERATURE", str(TEMPERATURE)))

# Hook 中间件总线总开关（HK-1/HK-2）。置 0/false/no/off 时 run_tool_loop 完全旁路所有事件钩子，
# 行为与无钩子完全一致（安全气囊）。默认开启；但未注册任何 handler 时本身零开销、零行为改变。
HOOKS_ENABLED = os.getenv("ARFORGE_HOOKS_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}

# 上下文自动压缩（CC-1/CC-3）。各模型上下文窗口（token）；达到 (窗口 - 输出预留) * 阈值 时
# 自动压缩较旧历史。AUTO_COMPACT_ENABLED 可单独关闭压缩（独立于 HOOKS_ENABLED）。

COMPACT_THRESHOLD = float(os.getenv("ARFORGE_COMPACT_THRESHOLD", "0.85"))  # preserve output headroom across providers
AUTO_COMPACT_ENABLED = os.getenv("ARFORGE_AUTO_COMPACT", "1").strip().lower() not in {"0", "false", "no", "off"}

# 运行级 token 预算（HK-4）。>0 时 arforge code 单次 run 累计 token 超此值即中止（防失控花费）；
# 默认 0=不限。可用 ARFORGE_RUN_TOKEN_BUDGET 覆盖。
RUN_TOKEN_BUDGET = int(os.getenv("ARFORGE_RUN_TOKEN_BUDGET", "0"))

# Provider calls inherit the Agent's cooperative cancellation and have no
# wall-clock cutoff by default. Set a positive value only for an explicit
# deployment-level network deadline.
MODEL_TIMEOUT = max(0.0, float(os.getenv("ARFORGE_MODEL_TIMEOUT", "0")))

# 多 Agent：单个子 Agent 工具循环的运行级 token 预算（HK-4 续）。>0 时累计超此值即中止该子 Agent；
# 默认 600 秒。只限制轻量子 Agent 的整段运行，不限制主任务；正常成功路径没有
# 额外轮询或降级。可显式设为 0 恢复无限等待。子 Agent 的自动上下文压缩始终启用。
SUBAGENT_RUN_TOKEN_BUDGET = int(os.getenv("ARFORGE_SUBAGENT_RUN_TOKEN_BUDGET", "0"))
SUBAGENT_TIMEOUT_SECONDS = max(
    0.0,
    float(os.getenv("ARFORGE_SUBAGENT_TIMEOUT_SECONDS", "600")),
)

# Agent wall-clock deadlines are opt-in. Zero keeps long multi-agent work alive
# until it completes, fails explicitly, or receives a cooperative cancellation.
MULTIAGENT_TOTAL_TIMEOUT = max(
    0.0,
    float(os.getenv("ARFORGE_MULTIAGENT_TOTAL_TIMEOUT", "0")),
)

# ── 数据库配置（仅 PostgreSQL）──────────────────────────────────────────
# ARFORGE_DB_URL 在 .env 中配置:
#   ARFORGE_DB_URL=postgresql://user:pass@host:5432/arforge
ARFORGE_DB_URL = os.getenv("ARFORGE_DB_URL", "")
ARFORGE_MULTIAGENT_DB_URL = os.getenv("ARFORGE_MULTIAGENT_DB_URL", "")

# -- 3.2: LLM-driven reflection --
LLM_REFLECT_ENABLED = False  # Set True to enable LLM-powered reflection on failures
