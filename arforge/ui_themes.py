"""Data-only desktop color theme discovery and validation."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from arforge.paths import get_arforge_home

_SAFE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
COLOR_TOKENS = {
    "primary",
    "accent",
    "text",
    "textStrong",
    "textDim",
    "textMuted",
    "border",
    "borderFocus",
    "success",
    "warning",
    "error",
    "diffAdded",
    "diffRemoved",
    "diffAddedStrong",
    "diffRemovedStrong",
    "diffGutter",
    "diffMeta",
    "roleUser",
    "shellMode",
}


@dataclass(frozen=True)
class UITheme:
    theme_id: str
    display_name: str
    base: str
    colors: dict[str, str]
    source: str
    path: str
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_theme_roots(cwd: Path | None = None) -> list[tuple[Path, str]]:
    workspace = (cwd or Path.cwd()).resolve()
    project_roots = [(directory / ".arforge" / "themes", "workspace") for directory in (workspace, *workspace.parents)]
    return [(get_arforge_home() / "themes", "profile"), *reversed(project_roots)]


def list_ui_themes(roots: list[tuple[Path, str]] | None = None) -> dict[str, Any]:
    """Discover JSON themes without evaluating code or accepting raw CSS."""
    resolved_roots = roots or default_theme_roots()
    items: dict[str, UITheme] = {}
    scanned: list[str] = []
    for root, source in resolved_roots:
        resolved = root.expanduser().resolve()
        scanned.append(str(resolved))
        if not resolved.is_dir():
            continue
        for path in sorted(resolved.glob("*.json"), key=lambda item: item.name.casefold()):
            theme = _load_theme(path, source)
            items[theme.theme_id.casefold()] = theme
    ordered = sorted(items.values(), key=lambda item: item.display_name.casefold())
    return {
        "count": len(ordered),
        "tokens": sorted(COLOR_TOKENS),
        "roots": scanned,
        "items": [item.to_dict() for item in ordered],
    }


def _load_theme(path: Path, source: str) -> UITheme:
    fallback = path.stem
    problems: list[str] = []
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return UITheme(fallback, fallback, "dark", {}, source, str(path.resolve()), [f"invalid JSON: {exc}"])
    if not isinstance(value, dict):
        return UITheme(fallback, fallback, "dark", {}, source, str(path.resolve()), ["theme must be a JSON object"])
    theme_id = value.get("name", fallback)
    display_name = value.get("displayName", theme_id)
    base = value.get("base", "dark")
    raw_colors = value.get("colors", {})
    if not isinstance(theme_id, str) or not _SAFE_ID.fullmatch(theme_id):
        problems.append("name must be a safe identifier")
        theme_id = fallback
    if theme_id.casefold() != fallback.casefold():
        problems.append("name must match the file name")
    if not isinstance(display_name, str) or not display_name.strip() or len(display_name) > 80:
        problems.append("displayName must be a non-empty string up to 80 characters")
        display_name = theme_id
    if base not in {"dark", "light"}:
        problems.append("base must be dark or light")
        base = "dark"
    if not isinstance(raw_colors, dict):
        problems.append("colors must be an object")
        raw_colors = {}
    colors: dict[str, str] = {}
    for token, color in raw_colors.items():
        if token not in COLOR_TOKENS:
            problems.append(f"unknown color token: {token}")
            continue
        if not isinstance(color, str) or not _HEX.fullmatch(color):
            problems.append(f"invalid color for {token}")
            continue
        colors[token] = color.lower()
    return UITheme(
        theme_id,
        display_name.strip(),
        base,
        colors,
        source,
        str(path.resolve()),
        problems,
    )


__all__ = ["COLOR_TOKENS", "UITheme", "default_theme_roots", "list_ui_themes"]
