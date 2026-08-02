"""User custom commands and hook manifests.

G16 deliberately starts with a non-executing customization layer:

* custom commands render prompt templates for the REPL slash dispatcher;
* hook manifests are indexed for governance and can opt into controlled local
  execution only after an explicit environment and workspace-trust check.

This gives users and future plugins a stable contract without opening an
arbitrary-code execution surface.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from arforge.paths import get_arforge_home

_SAFE_NAME = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$")
_TEMPLATE_VAR = re.compile(r"{{\s*(args|input)\s*}}")
_HOOK_ALLOWED_BINARIES = frozenset({
    "python", "python.exe", "python3", "py", "py.exe", "pytest", "pytest.exe",
    "ruff", "ruff.exe", "node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd",
})
_HOOK_MAX_TIMEOUT_SECONDS = 60
_HOOK_OUTPUT_LIMIT = 4_000


@dataclass(frozen=True)
class CustomCommand:
    name: str
    description: str
    template: str
    source: str
    path: str
    category: str = "custom"
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["template"] = self.template[:500]
        return data


@dataclass(frozen=True)
class HookManifest:
    name: str
    event: str
    description: str
    source: str
    path: str
    priority: int = 100
    enabled: bool = False
    command: tuple[str, ...] = ()
    matcher: str = "*"
    timeout_seconds: int = 15
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("command", None)
        data["command_configured"] = bool(self.command)
        data["executable"] = self.command[0] if self.command else ""
        return data


def default_custom_roots() -> list[Path]:
    roots: list[Path] = []
    env_roots = os.getenv("ARFORGE_CUSTOM_PATHS", "").strip()
    if env_roots:
        roots.extend(Path(part).expanduser() for part in env_roots.split(os.pathsep) if part.strip())
    roots.append(get_arforge_home())
    roots.append(Path.cwd() / ".arforge")
    return _dedupe_roots(roots)


def list_customizations(roots: list[Path] | None = None) -> dict[str, Any]:
    resolved = roots or default_custom_roots()
    scanned = [Path(r).expanduser().resolve() if not isinstance(r, Path) else r.expanduser().resolve() for r in resolved]
    commands: list[CustomCommand] = []
    hooks: list[HookManifest] = []
    for root in scanned:
        commands.extend(_load_commands(root / "commands", root=root))
        hooks.extend(_load_hooks(root / "hooks", root=root))
    commands = _dedupe_commands(commands)
    hooks = _dedupe_hooks(hooks)
    return {
        "commands": {
            "count": len(commands),
            "enabled_count": sum(1 for item in commands if not item.problems),
            "items": [item.to_dict() for item in commands],
        },
        "hooks": {
            "count": len(hooks),
            "enabled_count": sum(1 for item in hooks if item.enabled and not item.problems),
            "items": [item.to_dict() for item in hooks],
        },
        "roots": [str(root) for root in scanned],
    }


def render_custom_command(name: str, args: str = "", roots: list[Path] | None = None) -> str | None:
    command = find_custom_command(name, roots=roots)
    if command is None:
        return None
    if command.problems:
        return f"Custom command /{name} is invalid: {'; '.join(command.problems)}"
    rendered = _TEMPLATE_VAR.sub(args.strip(), command.template).strip()
    return rendered or args.strip()


def find_custom_command(name: str, roots: list[Path] | None = None) -> CustomCommand | None:
    target = name.strip().casefold()
    for item in _commands_from_listing(list_customizations(roots)):
        if item.name.casefold() == target:
            return item
    return None


def _commands_from_listing(data: dict[str, Any]) -> list[CustomCommand]:
    result: list[CustomCommand] = []
    for row in data.get("commands", {}).get("items", []):
        result.append(
            CustomCommand(
                name=str(row.get("name", "")),
                description=str(row.get("description", "")),
                template=str(row.get("template", "")),
                source=str(row.get("source", "")),
                path=str(row.get("path", "")),
                category=str(row.get("category", "custom")),
                problems=list(row.get("problems") or []),
            )
        )
    return result


def _load_commands(path: Path, *, root: Path) -> list[CustomCommand]:
    if not path.is_dir():
        return []
    items: list[CustomCommand] = []
    for file in sorted(path.iterdir(), key=lambda item: item.name.casefold()):
        if file.suffix.lower() not in {".md", ".json"} or not file.is_file():
            continue
        data, body, problems = _load_manifest_file(file)
        name = str(data.get("name") or file.stem).strip()
        description = str(data.get("description") or "").strip()
        template = str(data.get("template") or body or "").strip()
        category = str(data.get("category") or "custom").strip() or "custom"
        problems.extend(_validate_command(name, description, template))
        items.append(
            CustomCommand(
                name=name,
                description=description,
                template=template,
                source=_source_for(file, root),
                path=str(file.resolve()),
                category=category,
                problems=problems,
            )
        )
    return items


def _load_hooks(path: Path, *, root: Path) -> list[HookManifest]:
    if not path.is_dir():
        return []
    items: list[HookManifest] = []
    for file in sorted(path.iterdir(), key=lambda item: item.name.casefold()):
        if file.suffix.lower() not in {".md", ".json"} or not file.is_file():
            continue
        data, _body, problems = _load_manifest_file(file)
        name = str(data.get("name") or file.stem).strip()
        event = str(data.get("event") or "").strip()
        description = str(data.get("description") or "").strip()
        enabled = _as_bool(data.get("enabled"), default=False)
        command = _parse_hook_command(data.get("command"), problems)
        matcher = str(data.get("matcher") or "*").strip() or "*"
        try:
            priority = int(data.get("priority", 100))
        except (TypeError, ValueError):
            priority = 100
            problems.append("priority must be an integer")
        try:
            timeout_seconds = int(data.get("timeout_seconds", 15))
        except (TypeError, ValueError):
            timeout_seconds = 15
            problems.append("timeout_seconds must be an integer")
        problems.extend(_validate_hook(name, event, description, command, matcher, timeout_seconds))
        items.append(
            HookManifest(
                name=name,
                event=event,
                description=description,
                source=_source_for(file, root),
                path=str(file.resolve()),
                priority=priority,
                enabled=enabled,
                command=command,
                matcher=matcher,
                timeout_seconds=timeout_seconds,
                problems=problems,
            )
        )
    return items


def _load_manifest_file(path: Path) -> tuple[dict[str, Any], str, list[str]]:
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return {}, "", [str(exc)]
    if path.suffix.lower() == ".json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            return {}, "", [f"invalid JSON: {exc.msg}"]
        if not isinstance(data, dict):
            return {}, "", ["manifest must be a JSON object"]
        return data, "", []
    data, body = _front_matter(text)
    return data, body, problems


def _front_matter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    data: dict[str, Any] = {}
    for line in text[4:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = _parse_scalar(value.strip())
    return data, text[end + 4 :].strip()


def _parse_scalar(value: str) -> Any:
    value = value.strip().strip("'\"")
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    return value


def _validate_command(name: str, description: str, template: str) -> list[str]:
    problems: list[str] = []
    if not _SAFE_NAME.match(name):
        problems.append("name must match ^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$")
    if not description:
        problems.append("description is required")
    if not template:
        problems.append("template is required")
    return problems


def _validate_hook(
    name: str,
    event: str,
    description: str,
    command: tuple[str, ...] = (),
    matcher: str = "*",
    timeout_seconds: int = 15,
) -> list[str]:
    from arforge.core.hooks import HookEvent

    problems: list[str] = []
    if not _SAFE_NAME.match(name):
        problems.append("name must match ^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$")
    if not description:
        problems.append("description is required")
    try:
        HookEvent(event)
    except ValueError:
        problems.append("event must be a known HookEvent")
    if not matcher or len(matcher) > 128:
        problems.append("matcher must be between 1 and 128 characters")
    if not 1 <= timeout_seconds <= _HOOK_MAX_TIMEOUT_SECONDS:
        problems.append(f"timeout_seconds must be between 1 and {_HOOK_MAX_TIMEOUT_SECONDS}")
    if command:
        executable = Path(command[0]).name.casefold()
        if executable not in _HOOK_ALLOWED_BINARIES:
            problems.append("command executable is not allowed for custom hooks")
    return problems


def _parse_hook_command(value: Any, problems: list[str]) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if isinstance(value, list) and all(isinstance(item, str) and item for item in value):
        return tuple(value)
    if isinstance(value, str):
        try:
            return tuple(shlex.split(value, posix=os.name != "nt"))
        except ValueError as exc:
            problems.append(f"invalid command: {exc}")
            return ()
    problems.append("command must be a string or an array of strings")
    return ()


def _as_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _source_for(path: Path, root: Path) -> str:
    cwd_arforge = (Path.cwd() / ".arforge").resolve()
    try:
        path.resolve().relative_to(cwd_arforge)
        return "workspace"
    except ValueError:
        return "profile" if root == get_arforge_home().resolve() else "custom"


def _dedupe_roots(roots: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for root in roots:
        key = str(root.expanduser().resolve()).casefold()
        if key not in seen:
            seen.add(key)
            result.append(root)
    return result


def _dedupe_commands(items: list[CustomCommand]) -> list[CustomCommand]:
    seen: set[str] = set()
    result: list[CustomCommand] = []
    for item in items:
        key = item.name.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _dedupe_hooks(items: list[HookManifest]) -> list[HookManifest]:
    seen: set[tuple[str, str]] = set()
    result: list[HookManifest] = []
    for item in items:
        key = (item.name.casefold(), item.event.casefold())
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def install_custom_hooks(roots: list[Path] | None = None) -> dict[str, Any]:
    """Register explicitly enabled local hook manifests with the global hook bus.

    Custom hook commands are intentionally dormant unless both
    ARFORGE_ENABLE_CUSTOM_HOOKS=1 and workspace trust are present. Commands run
    without a shell, from a small executable allowlist, in the workspace, with
    a bounded timeout. Their JSON result can only make a gating hook proceed,
    ask, or block; it cannot rewrite tool arguments or bypass policy.
    """
    if not _custom_hook_execution_allowed():
        return {
            "installed": 0,
            "skipped": 0,
            "reason": "custom hook execution requires ARFORGE_ENABLE_CUSTOM_HOOKS=1 and a trusted workspace",
        }

    from arforge.core.hooks import get_hook_manager

    resolved = roots or default_custom_roots()
    manifests: list[HookManifest] = []
    for root in resolved:
        expanded = Path(root).expanduser().resolve()
        manifests.extend(_load_hooks(expanded / "hooks", root=expanded))
    manifests = _dedupe_hooks(manifests)
    manager = get_hook_manager()
    installed = 0
    skipped = 0
    for manifest in manifests:
        handler_name = f"custom_hook:{manifest.path}"
        if (
            not manifest.enabled
            or manifest.problems
            or not manifest.command
            or handler_name in manager.handler_names(manifest.event)
        ):
            skipped += 1
            continue
        manager.register(
            manifest.event,
            _build_custom_hook_handler(manifest),
            priority=manifest.priority,
            name=handler_name,
        )
        installed += 1
    return {"installed": installed, "skipped": skipped, "reason": ""}


def _custom_hook_execution_allowed() -> bool:
    enabled = os.getenv("ARFORGE_ENABLE_CUSTOM_HOOKS", "").strip().casefold()
    if enabled not in {"1", "true", "yes", "on"}:
        return False
    try:
        from arforge.trust_screen import _auto_trust_enabled, is_workspace_trusted

        return _auto_trust_enabled() or is_workspace_trusted()
    except Exception:
        return False


def _build_custom_hook_handler(manifest: HookManifest):
    def handler(ctx):
        from arforge.core.hooks import GATING_EVENTS, HookDecision

        if manifest.matcher != "*" and not _matches_hook(manifest.matcher, ctx.tool_name or ""):
            return HookDecision.proceed()
        payload = {
            "event": ctx.event.value,
            "tool_name": ctx.tool_name or "",
            "tool_args": _redact_hook_value(ctx.tool_args or {}),
            "metadata": _safe_hook_metadata(ctx.metadata),
        }
        outcome = _run_custom_hook(manifest, payload)
        ctx.metadata.setdefault("custom_hook_runs", []).append(outcome)
        if not outcome["success"]:
            return HookDecision.proceed()
        decision = outcome.get("decision") or {}
        action = decision.get("action")
        reason = str(decision.get("reason") or "")[:500]
        if ctx.event in GATING_EVENTS and action == "block":
            return HookDecision.block(reason or f"blocked by custom hook {manifest.name}")
        if ctx.event in GATING_EVENTS and action == "ask":
            return HookDecision.ask(reason or f"approval requested by custom hook {manifest.name}")
        feedback = decision.get("feedback")
        if isinstance(feedback, str) and feedback.strip() and ctx.event not in GATING_EVENTS:
            ctx.feedback.append({"role": "user", "content": feedback.strip()[:2_000]})
        return HookDecision.proceed()

    return handler


def _run_custom_hook(manifest: HookManifest, payload: dict[str, Any]) -> dict[str, Any]:
    command_text = " ".join(manifest.command)
    try:
        from arforge.security.sandbox_enforce import SandboxDecision, check_command_safety

        sandbox_decision, reason = check_command_safety(command_text, sandbox_mode="workspace-write")
        if sandbox_decision is not SandboxDecision.ALLOWED:
            return {"name": manifest.name, "success": False, "status": sandbox_decision.value, "reason": reason}
    except Exception:
        pass
    environment = {
        key: value
        for key, value in os.environ.items()
        if not any(token in key.casefold() for token in ("api_key", "token", "secret", "password"))
    }
    try:
        completed = subprocess.run(
            manifest.command,
            cwd=Path.cwd(),
            env=environment,
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=manifest.timeout_seconds,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return {"name": manifest.name, "success": False, "status": "timeout", "reason": "hook timed out"}
    except OSError as exc:
        return {"name": manifest.name, "success": False, "status": "spawn_error", "reason": str(exc)[:500]}
    if completed.returncode != 0:
        return {
            "name": manifest.name,
            "success": False,
            "status": "failed",
            "reason": (completed.stderr or completed.stdout or "hook returned non-zero")[:500],
        }
    decision = _parse_hook_decision(completed.stdout)
    return {"name": manifest.name, "success": True, "status": "completed", "decision": decision}


def _parse_hook_decision(stdout: str) -> dict[str, str]:
    try:
        payload = json.loads(stdout.strip() or "{}")
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}
    action = str(payload.get("action") or "").casefold()
    decision: dict[str, str] = {}
    if action in {"proceed", "ask", "block"}:
        decision["action"] = action
    for key in ("reason", "feedback"):
        value = payload.get(key)
        if isinstance(value, str):
            decision[key] = value
    return decision


def _matches_hook(pattern: str, tool_name: str) -> bool:
    import fnmatch

    return fnmatch.fnmatchcase(tool_name.casefold(), pattern.casefold())


def _safe_hook_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in metadata.items():
        lowered = str(key).casefold()
        if any(token in lowered for token in ("adapter", "key", "token", "secret", "password")):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            safe[str(key)] = value
    return safe


def _redact_hook_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "***" if any(token in str(key).casefold() for token in ("key", "token", "secret", "password"))
            else _redact_hook_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_hook_value(item) for item in value]
    if isinstance(value, str):
        return value[:2_000]
    return value
