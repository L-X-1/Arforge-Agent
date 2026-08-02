"""Interactive terminal input with live Arforge mode shortcuts."""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any, MutableMapping


SCHEMA_VERSION = 1
THINKING_ACTION = "cli:thinking-cycle"
DEFAULT_THINKING_CHORD = "ctrl+t"
PERMISSION_MODES = ("requestApproval", "autoApprove", "fullAccess")
THINKING_EFFORTS = ("low", "medium", "high", "ultra")

_PERMISSION_ALIASES = {
    "plan": "requestApproval",
    "acceptEdits": "autoApprove",
    "auto": "fullAccess",
}
_RESERVED_CHORDS = {
    "shift+tab",
    "ctrl+c",
    "ctrl+d",
    "ctrl+q",
    "ctrl+s",
    "ctrl+z",
}
_CTRL_CHORD = re.compile(r"^ctrl\+([a-z])$")
_ALT_CHORD = re.compile(r"^(?:alt|meta)\+([a-z0-9,./])$")
_FUNCTION_CHORD = re.compile(r"^f(?:[2-9]|1[0-2])$")


class CliKeybindingError(ValueError):
    """Stable validation error for CLI-only keybindings."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_permission_mode(mode: str | None) -> str:
    value = str(mode or "autoApprove")
    value = _PERMISSION_ALIASES.get(value, value)
    return value if value in PERMISSION_MODES else "autoApprove"


def cycle_value(current: str, values: tuple[str, ...]) -> str:
    try:
        index = values.index(current)
    except ValueError:
        index = 0
    return values[(index + 1) % len(values)]


def validate_thinking_chord(value: str) -> str:
    chord = str(value or "").strip().casefold().replace("control+", "ctrl+")
    if chord in _RESERVED_CHORDS:
        raise CliKeybindingError("RESERVED_KEYBINDING", f"{chord} is reserved by the terminal")
    if "ctrl+shift+" in chord:
        raise CliKeybindingError(
            "AMBIGUOUS_KEYBINDING",
            "terminal input cannot reliably distinguish Ctrl+Shift+letter from Ctrl+letter",
        )
    if not (_CTRL_CHORD.fullmatch(chord) or _ALT_CHORD.fullmatch(chord) or _FUNCTION_CHORD.fullmatch(chord)):
        raise CliKeybindingError(
            "INVALID_KEYBINDING",
            "use ctrl+letter, alt+key, or f2-f12",
        )
    return chord.replace("meta+", "alt+")


def prompt_toolkit_keys(chord: str) -> tuple[str, ...]:
    canonical = validate_thinking_chord(chord)
    ctrl = _CTRL_CHORD.fullmatch(canonical)
    if ctrl:
        return (f"c-{ctrl.group(1)}",)
    alt = _ALT_CHORD.fullmatch(canonical)
    if alt:
        return ("escape", alt.group(1))
    return (canonical,)


class CliKeybindingRuntime:
    """Persist the CLI thinking shortcut without changing desktop bindings."""

    def __init__(self, path: Path):
        self.path = Path(path).resolve()

    def get(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._public(DEFAULT_THINKING_CHORD)
        if not self.path.is_file() or self.path.stat().st_size > 16 * 1024:
            raise CliKeybindingError("KEYBINDINGS_CORRUPT", "CLI keybinding configuration is invalid")
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
                raise ValueError("unsupported schema")
            bindings = value.get("bindings")
            if not isinstance(bindings, dict) or set(bindings) != {THINKING_ACTION}:
                raise ValueError("invalid bindings")
            chord = validate_thinking_chord(bindings[THINKING_ACTION])
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            raise CliKeybindingError("KEYBINDINGS_CORRUPT", "CLI keybinding configuration is unreadable") from None
        return self._public(chord)

    def set_thinking_chord(self, chord: str) -> dict[str, Any]:
        canonical = validate_thinking_chord(chord)
        document = {
            "schema_version": SCHEMA_VERSION,
            "bindings": {THINKING_ACTION: canonical},
        }
        self._atomic_write(document)
        return self._public(canonical)

    def reset(self) -> dict[str, Any]:
        return self.set_thinking_chord(DEFAULT_THINKING_CHORD)

    @staticmethod
    def _public(chord: str) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "bindings": {THINKING_ACTION: chord},
            "actions": {
                THINKING_ACTION: {
                    "label": "Cycle CLI thinking mode",
                    "default": DEFAULT_THINKING_CHORD,
                }
            },
        }

    def _atomic_write(self, document: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(document, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            try:
                temporary.chmod(0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)


def load_thinking_chord(path: Path) -> str:
    try:
        return CliKeybindingRuntime(path).get()["bindings"][THINKING_ACTION]
    except CliKeybindingError:
        return DEFAULT_THINKING_CHORD


class CliPromptSession:
    """Prompt-toolkit line editor with live permission and thinking cycles."""

    live_input = True

    def __init__(
        self,
        state: MutableMapping[str, str],
        *,
        lang: str,
        thinking_chord: str,
        history_path: Path,
        input_stream: Any = None,
        output_stream: Any = None,
    ) -> None:
        self.state = state
        self.lang = "zh" if lang == "zh" else "en"
        self.thinking_chord = validate_thinking_chord(thinking_chord)
        self.history_path = Path(history_path)
        self._session = None
        self.enhanced = bool(input_stream is not None or output_stream is not None or self._is_tty())
        if not self.enhanced:
            return
        try:
            from prompt_toolkit import PromptSession
            from prompt_toolkit.history import FileHistory
            from prompt_toolkit.key_binding import KeyBindings
            from prompt_toolkit.styles import Style
        except ImportError:
            self.enhanced = False
            return

        bindings = KeyBindings()

        @bindings.add("s-tab")
        def _cycle_permission(event) -> None:
            current = normalize_permission_mode(self.state.get("permission_mode"))
            self.state["permission_mode"] = cycle_value(current, PERMISSION_MODES)
            event.app.invalidate()

        @bindings.add(*prompt_toolkit_keys(self.thinking_chord))
        def _cycle_thinking(event) -> None:
            current = self.state.get("effort", "medium")
            self.state["effort"] = cycle_value(current, THINKING_EFFORTS)
            event.app.invalidate()

        @bindings.add("c-x")
        def _toggle_input_mode(event) -> None:
            self.state["input_mode"] = (
                "agent" if self.state.get("input_mode", "agent") == "shell" else "shell"
            )
            event.app.invalidate()

        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        kwargs: dict[str, Any] = {
            "history": FileHistory(str(self.history_path)),
            "key_bindings": bindings,
            "enable_history_search": True,
            "complete_while_typing": False,
            "style": Style.from_dict({
                "bottom-toolbar": "bg:#1f1f1f #a0a0a0",
                "bottom-toolbar.mode": "bg:#1f1f1f #f0c75e bold",
                "prompt": "#f0c75e bold",
            }),
        }
        if input_stream is not None:
            kwargs["input"] = input_stream
        if output_stream is not None:
            kwargs["output"] = output_stream
        self._session = PromptSession(**kwargs)

    @staticmethod
    def _is_tty() -> bool:
        return bool(
            hasattr(sys.stdin, "isatty")
            and sys.stdin.isatty()
            and hasattr(sys.stdout, "isatty")
            and sys.stdout.isatty()
        )

    def toolbar_text(self) -> str:
        mode = normalize_permission_mode(self.state.get("permission_mode"))
        effort = self.state.get("effort", "medium")
        input_mode = self.state.get("input_mode", "agent")
        if self.lang == "zh":
            mode_label = {
                "requestApproval": "请求批准",
                "autoApprove": "替我审批",
                "fullAccess": "完全访问",
            }[mode]
            effort_label = {
                "low": "低深度思考",
                "medium": "中等深度思考",
                "high": "高深度思考",
                "ultra": "超高深度思考",
            }.get(effort, effort)
            input_label = "安全 Shell" if input_mode == "shell" else "Agent"
            return (
                f"  {input_label}  Ctrl+X 切换  ·  {mode_label}  Shift+Tab 切换"
                f"  ·  {effort_label}  {self.thinking_chord.upper()} 切换"
            )
        mode_label = {
            "requestApproval": "request approval",
            "autoApprove": "auto approve",
            "fullAccess": "full access",
        }[mode]
        effort_label = {
            "low": "low",
            "medium": "medium",
            "high": "high",
            "ultra": "ultra",
        }.get(effort, effort)
        input_label = "safe shell" if input_mode == "shell" else "agent"
        return (
            f"  {input_label}  Ctrl+X to switch  ·  {mode_label}  Shift+Tab to cycle"
            f"  ·  {effort_label} thinking  {self.thinking_chord.upper()} to cycle"
        )

    def read(self) -> str:
        prompt = "$ " if self.state.get("input_mode") == "shell" else "❯ "
        if self._session is None:
            return input(prompt)
        return self._session.prompt(
            [("class:prompt", prompt)],
            bottom_toolbar=lambda: [("class:bottom-toolbar.mode", self.toolbar_text())],
            reserve_space_for_menu=0,
        )
