"""Markdown-defined response styles for CLI and desktop model calls.

Styles are data-only prompt fragments.  They are discovered from trusted local
directories and never execute code.  A project style with the same identifier
overrides the user-level style so repositories can carry their own response
conventions without changing the user's global preference.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from arforge.paths import get_arforge_home

_SAFE_STYLE_ID = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$")
_MAX_STYLE_CHARS = 20_000
_ACTIVE_PATH = "config/output_style.json"


@dataclass(frozen=True)
class OutputStyle:
    style_id: str
    name: str
    description: str
    prompt: str
    source: str
    path: str
    keep_coding_instructions: bool | None = None
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_output_style_roots(cwd: Path | None = None) -> list[tuple[Path, str]]:
    """Return style directories in lowest-to-highest precedence order."""
    workspace = (cwd or Path.cwd()).resolve()
    project_dirs: list[tuple[Path, str]] = []
    for directory in (workspace, *workspace.parents):
        project_dirs.append((directory / ".arforge" / "output-styles", "workspace"))
    return [(get_arforge_home() / "output-styles", "profile"), *reversed(project_dirs)]


def list_output_styles(roots: list[tuple[Path, str]] | None = None) -> dict[str, Any]:
    """Discover style files, applying source precedence by style identifier."""
    resolved = roots or default_output_style_roots()
    items: dict[str, OutputStyle] = {}
    scanned: list[str] = []
    for root, source in resolved:
        root = root.expanduser().resolve()
        scanned.append(str(root))
        if not root.is_dir():
            continue
        for path in sorted(root.glob("*.md"), key=lambda item: item.name.casefold()):
            style = _load_style(path, source)
            items[style.style_id.casefold()] = style
    ordered = sorted(items.values(), key=lambda item: item.name.casefold())
    return {
        "count": len(ordered),
        "active_style_id": get_active_output_style_id(),
        "roots": scanned,
        "items": [item.to_dict() for item in ordered],
    }


def get_active_output_style_id() -> str | None:
    path = get_arforge_home() / _ACTIVE_PATH
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    style_id = data.get("style_id") if isinstance(data, dict) else None
    return style_id if isinstance(style_id, str) and _SAFE_STYLE_ID.match(style_id) else None


def set_active_output_style(style_id: str, roots: list[tuple[Path, str]] | None = None) -> dict[str, Any]:
    target = style_id.strip()
    if not _SAFE_STYLE_ID.match(target):
        raise ValueError("style_id must match ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$")
    style = find_output_style(target, roots=roots)
    if style is None:
        raise ValueError(f"unknown output style: {target}")
    if style.problems:
        raise ValueError(f"output style '{target}' is invalid: {'; '.join(style.problems)}")
    path = get_arforge_home() / _ACTIVE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"style_id": style.style_id}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return {"style_id": style.style_id, "name": style.name}


def clear_active_output_style() -> dict[str, bool]:
    path = get_arforge_home() / _ACTIVE_PATH
    path.unlink(missing_ok=True)
    return {"cleared": True}


def find_output_style(style_id: str, roots: list[tuple[Path, str]] | None = None) -> OutputStyle | None:
    target = style_id.strip().casefold()
    for item in list_output_styles(roots).get("items", []):
        if str(item["style_id"]).casefold() == target:
            return OutputStyle(**item)
    return None


def get_active_output_style_prompt() -> str:
    style_id = get_active_output_style_id()
    if not style_id:
        return ""
    style = find_output_style(style_id)
    if style is None or style.problems:
        return ""
    return style.prompt


def _load_style(path: Path, source: str) -> OutputStyle:
    problems: list[str] = []
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return OutputStyle(path.stem, path.stem, "", "", source, str(path), problems=[str(exc)])
    metadata, prompt = _front_matter(raw)
    style_id = str(metadata.get("id") or path.stem).strip()
    name = str(metadata.get("name") or style_id).strip()
    description = str(metadata.get("description") or _description_from(prompt)).strip()
    keep = _as_optional_bool(metadata.get("keep-coding-instructions"))
    if not _SAFE_STYLE_ID.match(style_id):
        problems.append("id must match ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$")
    if not description:
        problems.append("description is required")
    if not prompt:
        problems.append("prompt is required")
    if len(prompt) > _MAX_STYLE_CHARS:
        problems.append(f"prompt exceeds {_MAX_STYLE_CHARS} characters")
    return OutputStyle(style_id, name, description, prompt, source, str(path.resolve()), keep, problems)


def _front_matter(raw: str) -> tuple[dict[str, Any], str]:
    if not raw.startswith("---\n"):
        return {}, raw.strip()
    end = raw.find("\n---", 4)
    if end < 0:
        return {}, raw.strip()
    data: dict[str, Any] = {}
    for line in raw[4:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip("'\"")
    return data, raw[end + 4 :].strip()


def _description_from(prompt: str) -> str:
    for line in prompt.splitlines():
        clean = line.strip().lstrip("#").strip()
        if clean:
            return clean[:160]
    return ""


def _as_optional_bool(value: Any) -> bool | None:
    if value is None:
        return None
    lowered = str(value).strip().casefold()
    if lowered in {"true", "1", "yes", "on"}:
        return True
    if lowered in {"false", "0", "no", "off"}:
        return False
    return None
