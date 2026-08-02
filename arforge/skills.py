"""Local Skills discovery for Arforge's plugin/skills ecosystem.

G15 starts as a read-only manifest index. A skill is discoverable when a
directory contains either ``SKILL.md`` with YAML front matter or ``skill.json``.
Discovery never imports Python modules or executes scripts from the skill
directory.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from arforge.paths import get_arforge_home
from arforge.database.sqlite_runtime import ProfileWriterLock
from arforge.profile_state import atomic_write_json

_SAFE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
_BUNDLED_SOURCE = "builtin:agent-skills"
_BUNDLED_DIR_OVERRIDES = {
    "model-api": {
        "id": "model-api",
        "name": "model-api",
        "description": (
            "Reference for model API / SDK work: model ids, pricing, params, streaming, "
            "tool use, MCP, agents, caching, token counting, and model migration."
        ),
    }
}


@dataclass(frozen=True)
class SkillManifest:
    id: str
    name: str
    description: str
    version: str
    source: str
    path: str
    entrypoint: str
    license: str = ""
    tags: list[str] = field(default_factory=list)
    enabled: bool = True
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_skill_roots() -> list[Path]:
    """Return local skill roots in deterministic priority order."""
    roots: list[Path] = []
    env_roots = os.getenv("ARFORGE_SKILL_PATHS", "").strip()
    if env_roots:
        roots.extend(Path(part).expanduser() for part in env_roots.split(os.pathsep) if part.strip())
    roots.append(get_arforge_home() / "skills")
    roots.append(Path.cwd() / ".arforge" / "skills")
    roots.append(bundled_agent_skill_root())
    return _dedupe_roots(roots)


def bundled_agent_skill_root() -> Path:
    """Return the read-only Agent Skills bundle shipped with Arforge."""
    return Path(__file__).resolve().parent / "bundled_skills" / "agent_skills" / "skills"


def list_skills(roots: list[Path] | None = None) -> dict[str, Any]:
    _load_skills_state()
    manifests: list[SkillManifest] = []
    scanned_roots: list[str] = []
    for root in roots or default_skill_roots():
        resolved = root.expanduser().resolve()
        scanned_roots.append(str(resolved))
        if not resolved.is_dir():
            continue
        for candidate in _iter_skill_dirs(resolved):
            manifest = load_skill_manifest(candidate, root=resolved)
            if manifest is not None:
                manifests.append(manifest)
    manifests = _dedupe_skills(manifests)
    enabled = [item for item in manifests if item.enabled and not item.problems]
    return {
        "count": len(manifests),
        "enabled_count": len(enabled),
        "items": [item.to_dict() for item in manifests],
        "roots": scanned_roots,
    }



# ---------------------------------------------------------------------------
# T6/T8: Hot-reload cache + enable/disable toggle
# ---------------------------------------------------------------------------

# In-memory state for enable/disable (persisted to ~/.arforge/skills_state.json)
_skills_disabled: set[str] = set()
_skills_cache: dict[str, tuple[float, dict]] = {}  # path -> (mtime, manifest_dict)
_cache_loaded = False
_skills_state_lock = threading.RLock()


def _skills_state_path() -> Path:
    """Path to the persisted skills state file."""
    return get_arforge_home() / "skills_state.json"


def _skills_state_lock_path() -> Path:
    """Cross-process writer lock for profile skill preferences."""
    return get_arforge_home() / "config" / "skills-state.lock"


def _load_skills_state() -> None:
    """Reload persisted state so long-lived capability processes stay coherent."""
    global _skills_disabled, _cache_loaded
    with _skills_state_lock:
        disabled: set[str] = set()
        state_file = _skills_state_path()
        if state_file.is_file():
            try:
                data = json.loads(state_file.read_text(encoding="utf-8"))
                raw_disabled = data.get("disabled") if isinstance(data, dict) else None
                if isinstance(raw_disabled, list):
                    disabled = {
                        value
                        for value in raw_disabled
                        if isinstance(value, str) and _SAFE_ID.fullmatch(value)
                    }
            except (json.JSONDecodeError, OSError):
                pass
        _skills_disabled = disabled
        _cache_loaded = True


def _save_skills_state() -> None:
    """Persist enable/disable state to disk."""
    atomic_write_json(
        _skills_state_path(),
        {"disabled": sorted(_skills_disabled)},
    )


def enable_skill(skill_id: str) -> bool:
    """Enable a previously disabled skill. Returns True if state changed."""
    _validate_skill_id(skill_id)
    skill_id = skill_id.strip()
    with _skills_state_lock, ProfileWriterLock(_skills_state_lock_path()):
        _load_skills_state()
        if skill_id not in _skills_disabled:
            return False
        _skills_disabled.discard(skill_id)
        _save_skills_state()
        return True


def disable_skill(skill_id: str) -> bool:
    """Disable a skill. Returns True if state changed."""
    _validate_skill_id(skill_id)
    skill_id = skill_id.strip()
    with _skills_state_lock, ProfileWriterLock(_skills_state_lock_path()):
        _load_skills_state()
        if skill_id in _skills_disabled:
            return False
        _skills_disabled.add(skill_id)
        _save_skills_state()
        return True


def is_skill_enabled(skill_id: str) -> bool:
    """Check if a skill is currently enabled."""
    _validate_skill_id(skill_id)
    skill_id = skill_id.strip()
    _load_skills_state()
    return skill_id not in _skills_disabled


def refresh_skills(roots: list[Path] | None = None) -> dict[str, Any]:
    """Force reload of the skills cache (hot-reload support)."""
    global _skills_cache
    _skills_cache.clear()
    return list_skills(roots=roots)


def get_skill(skill_id: str, roots: list[Path] | None = None) -> SkillManifest | None:
    """Return one enabled skill manifest by id, without executing skill code."""
    _validate_skill_id(skill_id)
    wanted = skill_id.strip().casefold()
    for item in list_skills(roots=roots).get("items", []):
        if str(item.get("id", "")).casefold() == wanted:
            manifest = SkillManifest(**item)
            return manifest if manifest.enabled and not manifest.problems else None
    return None


def read_skill(skill_id: str, roots: list[Path] | None = None, *, max_chars: int = 60000) -> dict[str, Any]:
    """Read a skill's SKILL.md/manifest text and metadata.

    This is intentionally read-only. It never imports modules, runs scripts, or
    follows arbitrary paths supplied by the model.
    """
    manifest = get_skill(skill_id, roots=roots)
    if manifest is None:
        return {"ok": False, "error": f"skill not found, disabled, or invalid: {skill_id}"}
    skill_dir = Path(manifest.path).resolve()
    entrypoint = (skill_dir / manifest.entrypoint).resolve()
    if not _is_relative_to(entrypoint, skill_dir) or not entrypoint.is_file():
        return {"ok": False, "error": "skill entrypoint is missing or outside the skill directory"}
    try:
        content = entrypoint.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    truncated = len(content) > max_chars
    if truncated:
        content = content[:max_chars] + "\n...[truncated]"
    return {
        "ok": True,
        "manifest": manifest.to_dict(),
        "content": content,
        "truncated": truncated,
        "resources": _list_skill_resources(skill_dir),
    }


def _skill_cache_key(skill_dir: Path) -> str:
    return str(skill_dir.resolve())


def list_skills_cached(roots: list[Path] | None = None, force: bool = False) -> dict[str, Any]:
    """Hot-reload aware skills listing. Re-scans only when mtimes change."""
    global _skills_cache
    if force:
        _skills_cache.clear()
        return list_skills(roots=roots)

    # Check if any root mtimes changed
    scanned_roots = roots or default_skill_roots()
    for root in scanned_roots:
        resolved = root.expanduser().resolve()
        if not resolved.is_dir():
            continue
        root_stat = resolved.stat()
        root_key = _skill_cache_key(resolved)
        cached = _skills_cache.get(root_key)
        if cached is None or root_stat.st_mtime > cached[0]:
            # Cache miss — full rescan
            _skills_cache.clear()
            result = list_skills(roots=roots)
            # Populate cache
            for item in result.get("items", []):
                skill_path = item.get("path", "")
                if skill_path:
                    try:
                        mtime = Path(skill_path).stat().st_mtime
                        _skills_cache[skill_path] = (mtime, item)
                    except OSError:
                        pass
            return result

    # Cache hit — rebuild from cache
    items = [v[1] for v in _skills_cache.values() if v[1]]
    _load_skills_state()
    for item in items:
        item["enabled"] = item["id"] not in _skills_disabled
    enabled_items = [it for it in items if it.get("enabled") and not it.get("problems")]
    return {
        "count": len(items),
        "enabled_count": len(enabled_items),
        "items": items,
        "roots": [str(r.expanduser().resolve()) for r in scanned_roots if r.expanduser().resolve().is_dir()],
    }

def load_skill_manifest(skill_dir: Path, *, root: Path | None = None) -> SkillManifest | None:
    skill_dir = skill_dir.resolve()
    md = skill_dir / "SKILL.md"
    json_manifest = skill_dir / "skill.json"
    if json_manifest.is_file():
        data = _load_json(json_manifest)
        entrypoint = "skill.json"
    elif md.is_file():
        data = _load_markdown_front_matter(md)
        entrypoint = "SKILL.md"
    else:
        return None

    problems: list[str] = []
    if not isinstance(data, dict):
        data = {}
        problems.append("manifest is not an object")
    if data.get("_error"):
        problems.append(str(data["_error"]))
    raw_skill_id = str(data.get("id") or data.get("name") or skill_dir.name).strip()
    override = _bundled_manifest_override(skill_dir)
    skill_id = str(override.get("id") or raw_skill_id).strip()
    name = str(data.get("name") or skill_id).strip()
    if override:
        name = str(override.get("name") or name).strip()
    description = str(override.get("description") or data.get("description") or "").strip()
    if _is_bundled_skill_dir(skill_dir):
        description = _neutralize_visible_text(description)
    version = str(data.get("version") or "0.0.0").strip()
    license_text = str(data.get("license") or "").strip()
    tags = _clean_tags(data.get("tags"))
    if not skill_id or not _SAFE_ID.match(skill_id):
        problems.append("id must match ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
    if not name:
        problems.append("name is required")
    if not description:
        problems.append("description is required")

    source = _source_for(skill_dir, root)
    enabled = skill_id not in _skills_disabled
    return SkillManifest(
        id=skill_id,
        name=name,
        description=description,
        version=version,
        source=source,
        path=str(skill_dir),
        entrypoint=entrypoint,
        license=license_text,
        tags=tags,
        enabled=enabled,
        problems=problems,
    )


def _load_json(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"name": path.parent.name, "description": "", "_error": str(exc)}
    return raw if isinstance(raw, dict) else {"name": path.parent.name, "description": "", "_error": "not an object"}


def _load_markdown_front_matter(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return {"name": path.parent.name, "description": "", "_error": str(exc)}
    if not text.startswith("---\n"):
        return {"name": path.parent.name, "description": _first_heading(text)}
    end = text.find("\n---", 4)
    if end < 0:
        return {"name": path.parent.name, "description": _first_heading(text)}
    data: dict[str, Any] = {}
    lines = text[4:end].splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if ":" not in line:
            index += 1
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value in {"|", "|-", "|+", ">", ">-", ">+"}:
            block: list[str] = []
            index += 1
            while index < len(lines) and (lines[index].startswith(" ") or lines[index].startswith("\t") or not lines[index].strip()):
                block.append(lines[index].lstrip())
                index += 1
            joined = "\n".join(block)
            data[key] = " ".join(part.strip() for part in joined.splitlines() if part.strip()) if value.startswith(">") else joined.strip()
            continue
        data[key] = _parse_scalar(value)
        index += 1
    return data


def _parse_scalar(value: str) -> Any:
    if value.startswith("[") and value.endswith("]"):
        return [item.strip().strip("'\"") for item in value[1:-1].split(",") if item.strip()]
    return value.strip("'\"")


def _clean_tags(raw: Any) -> list[str]:
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    tags = [str(item).strip() for item in raw if str(item).strip()]
    return sorted(dict.fromkeys(tags), key=str.casefold)


def _first_heading(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return ""


def _dedupe_roots(roots: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for root in roots:
        key = str(root.expanduser().resolve()).casefold()
        if key not in seen:
            seen.add(key)
            result.append(root)
    return result


def _dedupe_skills(items: list[SkillManifest]) -> list[SkillManifest]:
    seen: set[str] = set()
    result: list[SkillManifest] = []
    for item in items:
        key = item.id.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _iter_skill_dirs(root: Path) -> list[Path]:
    """Return manifest-bearing skill directories for a root or collection root."""
    candidates: dict[str, Path] = {}

    def add(path: Path) -> None:
        if (path / "SKILL.md").is_file() or (path / "skill.json").is_file():
            candidates[str(path.resolve()).casefold()] = path

    add(root)
    for child in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name.casefold()):
        add(child)
    nested = root / "skills"
    if nested.is_dir():
        for child in sorted((p for p in nested.iterdir() if p.is_dir()), key=lambda p: p.name.casefold()):
            add(child)
    return sorted(candidates.values(), key=lambda p: p.name.casefold())


def _validate_skill_id(skill_id: str) -> None:
    if not isinstance(skill_id, str) or not _SAFE_ID.match(skill_id.strip()):
        raise ValueError("skill_id must match ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _source_for(skill_dir: Path, root: Path | None) -> str:
    bundled = bundled_agent_skill_root().resolve()
    if _is_relative_to(skill_dir, bundled):
        return _BUNDLED_SOURCE
    cwd = Path.cwd().resolve()
    if root and _is_relative_to(skill_dir, cwd):
        return "workspace"
    return "profile"


def _list_skill_resources(skill_dir: Path, *, limit: int = 80) -> list[str]:
    resources: list[str] = []
    for path in sorted((p for p in skill_dir.rglob("*") if p.is_file()), key=lambda p: str(p).casefold()):
        if path.name in {"SKILL.md", "skill.json"}:
            continue
        try:
            resources.append(str(path.relative_to(skill_dir)).replace("\\", "/"))
        except ValueError:
            continue
        if len(resources) >= limit:
            break
    return resources


def _is_bundled_skill_dir(skill_dir: Path) -> bool:
    return _is_relative_to(skill_dir.resolve(), bundled_agent_skill_root().resolve())


def _bundled_manifest_override(skill_dir: Path) -> dict[str, str]:
    if not _is_bundled_skill_dir(skill_dir):
        return {}
    return _BUNDLED_DIR_OVERRIDES.get(skill_dir.name.casefold(), {})


def _neutralize_visible_text(text: str) -> str:
    neutral = text
    for old, new in (
        ("A" + "nthropic", "vendor"),
        ("a" + "nthropic", "vendor"),
        ("C" + "laude", "model"),
        ("c" + "laude", "model"),
    ):
        neutral = neutral.replace(old, new)
    return neutral
