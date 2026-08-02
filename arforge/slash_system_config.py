"""System config slash helpers."""

from __future__ import annotations

import config


def show_system_config(_: str = "") -> str:
    return f"model={config.DEEPSEEK_MODEL}\nbase_url={config.DEEPSEEK_BASE_URL}"
