"""Configuration and environment indexing."""

from __future__ import annotations

import os
from pathlib import Path


def index_config_environment() -> dict:
    return {"success": True, "config_files": len(list_config_files()), "env_vars": len(list_environment_variables())}


def list_config_files() -> list[str]:
    names = [".env", "pyproject.toml", "package.json", "requirements.txt"]
    return [name for name in names if Path(name).exists()]


def list_environment_variables() -> list[dict]:
    keys = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "CHAT_MAX_TOKENS"]
    return [{"name": key, "set": bool(os.getenv(key))} for key in keys]


def list_config_items():
    return [{"file": file} for file in list_config_files()] + list_environment_variables()


def list_config_items_by_category(category: str):
    if category == "file":
        return [{"file": file} for file in list_config_files()]
    if category == "env":
        return list_environment_variables()
    return list_config_items()


def config_environment_status() -> dict:
    return index_config_environment()
