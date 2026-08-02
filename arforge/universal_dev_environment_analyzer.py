"""Universal development environment analyzer."""

from __future__ import annotations

from arforge.config_environment_indexer import config_environment_status
from arforge.git_intelligence import git_available, is_git_repo


def analyze_universal_dev_environment() -> dict:
    return {"config": config_environment_status(), "git_available": git_available(), "is_git_repo": is_git_repo()}


def dev_environment_status():
    return analyze_universal_dev_environment()


def show_dev_environment_profile() -> str:
    return str(analyze_universal_dev_environment())


def list_dev_environment_components(limit: int = 200):
    env = analyze_universal_dev_environment()
    return [{"name": key, "value": value} for key, value in env.items()][:limit]


def list_dev_environment_components_by_type(component_type: str):
    return [item for item in list_dev_environment_components() if component_type in item["name"]]
