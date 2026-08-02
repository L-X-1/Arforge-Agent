"""Mandatory per-project ARFORGE.md discovery and prompt injection."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from arforge.workspace_context import current_workspace

_PROJECT_MARKERS = (
    ".git",
    "pyproject.toml",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "src",
)


class ProjectRulesError(RuntimeError):
    """Raised when mandatory project rules cannot be loaded safely."""


@dataclass(frozen=True)
class ProjectRules:
    path: Path
    content: str

    def to_system_prompt(self) -> str:
        return (
            "## Project Rules — Read First\n"
            f"Source: {self.path}\n"
            "Read the complete document below before analyzing or acting on the request. "
            "Treat it as mandatory project-level instructions, subject to higher-priority "
            "system, safety, and user instructions.\n"
            '<project_rules filename="ARFORGE.md">\n'
            f"{self.content.rstrip()}\n"
            "</project_rules>"
        )


def find_project_rules(start: str | Path | None = None) -> Path | None:
    """Find the nearest ARFORGE.md from the active workspace upward."""
    workspace = current_workspace(start or Path.cwd()).expanduser().resolve()
    directory = workspace.parent if workspace.is_file() else workspace
    for candidate_dir in (directory, *directory.parents):
        candidate = candidate_dir / "ARFORGE.md"
        if candidate.is_file():
            return candidate
    return None


def is_project_workspace(start: str | Path | None = None) -> bool:
    """Return whether the active workspace is inside a recognizable project."""
    workspace = current_workspace(start or Path.cwd()).expanduser().resolve()
    directory = workspace.parent if workspace.is_file() else workspace
    return any(
        (candidate_dir / marker).exists()
        for candidate_dir in (directory, *directory.parents)
        for marker in _PROJECT_MARKERS
    )


def load_project_rules(
    start: str | Path | None = None,
    *,
    required: bool = False,
) -> ProjectRules | None:
    """Read ARFORGE.md fresh for this turn; no content cache is used."""
    path = find_project_rules(start)
    if path is None:
        if required:
            workspace = current_workspace(start or Path.cwd()).expanduser().resolve()
            raise ProjectRulesError(
                "Project development is blocked because ARFORGE.md was not found "
                f"from workspace {workspace} or any parent directory."
            )
        return None
    try:
        content = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise ProjectRulesError(f"Unable to read mandatory project rules at {path}: {exc}") from exc
    if not content.strip():
        raise ProjectRulesError(f"Mandatory project rules are empty: {path}")
    return ProjectRules(path=path, content=content)


def build_project_rules_system_prompt(
    start: str | Path | None = None,
    *,
    required: bool = False,
) -> str:
    rules = load_project_rules(start, required=required)
    return rules.to_system_prompt() if rules is not None else ""


__all__ = [
    "ProjectRules",
    "ProjectRulesError",
    "build_project_rules_system_prompt",
    "find_project_rules",
    "is_project_workspace",
    "load_project_rules",
]
