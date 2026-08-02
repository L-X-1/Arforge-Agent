"""Explicit, approval-gated local screen capture and computer interaction tools."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from arforge.paths import data_path
from arforge.tool_registry import ParamSchema, register_tool

_MAX_TYPED_CHARS = 4_000
_MAX_CLICKS = 3
_MAX_SCROLL_CLICKS = 50
_KEY_PATTERN = re.compile(r"^[a-z0-9_+\-]+$", re.IGNORECASE)
_ACTIONS = {"click", "double_click", "move", "type", "press", "hotkey", "scroll"}
UTC = timezone.utc


class ComputerToolError(ValueError):
    """Raised when a requested local interaction is unsafe or unsupported."""


class ScreenshotImage(Protocol):
    size: tuple[int, int]

    def save(self, path: Path, format: str) -> None: ...


def _screenshot_destination() -> Path:
    destination = data_path("artifacts", "screenshots")
    destination.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    return destination / f"screen-{timestamp}-{uuid.uuid4().hex[:8]}.png"


def _capture_screenshot(destination: Path, *, grabber: Any | None = None) -> dict[str, object]:
    """Capture exactly one screenshot and return only local artifact metadata."""
    if grabber is None:
        try:
            from PIL import ImageGrab
        except ImportError as exc:
            raise ComputerToolError("screen capture requires Pillow with ImageGrab support") from exc
        grabber = ImageGrab.grab
    try:
        image: ScreenshotImage = grabber(all_screens=True)
    except TypeError:
        image = grabber()
    except Exception as exc:  # noqa: BLE001 - platform capture errors are backend specific
        raise ComputerToolError(f"screen capture failed: {exc}") from None
    if not getattr(image, "size", None):
        raise ComputerToolError("screen capture backend returned an invalid image")
    image.save(destination, format="PNG")
    return {
        "path": str(destination),
        "width": int(image.size[0]),
        "height": int(image.size[1]),
        "mime": "image/png",
    }


@register_tool(
    "capture_screen",
    "Capture the current local screen as a PNG artifact for explicit diagnostic review.",
    keywords=["capture screen", "take screenshot", "screen shot", "截图", "截屏"],
    risk="high",
    requires_confirmation=True,
    timeout=15,
    category="system",
    source=__name__,
)
def capture_screen() -> str:
    """Capture the local screen only after the tool confirmation boundary."""
    metadata = _capture_screenshot(_screenshot_destination())
    return json.dumps(metadata, ensure_ascii=False)


def _validate_interaction(action: str, x: int, y: int, text: str, key: str, amount: int) -> None:
    if action not in _ACTIONS:
        raise ComputerToolError(f"action must be one of: {', '.join(sorted(_ACTIONS))}")
    if not isinstance(x, int) or not isinstance(y, int):
        raise ComputerToolError("x and y must be integers")
    if not isinstance(amount, int):
        raise ComputerToolError("amount must be an integer")
    if action in {"click", "double_click", "move"} and (x < 0 or y < 0):
        raise ComputerToolError("screen coordinates must be non-negative")
    if action == "type" and (not text or len(text) > _MAX_TYPED_CHARS):
        raise ComputerToolError(f"text must contain between 1 and {_MAX_TYPED_CHARS} characters")
    if action in {"press", "hotkey"} and (not key or not _KEY_PATTERN.fullmatch(key)):
        raise ComputerToolError("key must contain only letters, numbers, underscore, plus, or hyphen")
    if action in {"click", "double_click"} and not 1 <= amount <= _MAX_CLICKS:
        raise ComputerToolError(f"amount must be between 1 and {_MAX_CLICKS} for pointer actions")
    if action == "scroll" and not -_MAX_SCROLL_CLICKS <= amount <= _MAX_SCROLL_CLICKS:
        raise ComputerToolError(f"amount must be between {-_MAX_SCROLL_CLICKS} and {_MAX_SCROLL_CLICKS} for scroll")


def _perform_interaction(
    action: str,
    x: int,
    y: int,
    text: str,
    key: str,
    amount: int,
    *,
    controller: Any | None = None,
) -> dict[str, object]:
    _validate_interaction(action, x, y, text, key, amount)
    if controller is None:
        try:
            import pyautogui as controller
        except ImportError as exc:
            raise ComputerToolError("local interaction requires the optional pyautogui package") from exc
    if action == "click":
        controller.click(x=x, y=y, clicks=amount)
    elif action == "double_click":
        controller.doubleClick(x=x, y=y, interval=0.12)
    elif action == "move":
        controller.moveTo(x=x, y=y, duration=0.2)
    elif action == "type":
        controller.write(text, interval=0.01)
    elif action == "press":
        controller.press(key)
    elif action == "hotkey":
        controller.hotkey(*key.split("+"))
    else:
        controller.scroll(amount, x=x, y=y)
    return {"action": action, "x": x, "y": y, "amount": amount, "completed": True}


@register_tool(
    "computer_interact",
    "Perform one explicit local keyboard or pointer interaction after user approval.",
    keywords=["click screen", "type text", "press key", "move mouse", "computer control", "操作电脑"],
    params=[
        ParamSchema("action", "string", "click, double_click, move, type, press, hotkey, or scroll"),
        ParamSchema("x", "int", "Screen x coordinate", required=False, default=0),
        ParamSchema("y", "int", "Screen y coordinate", required=False, default=0),
        ParamSchema("text", "string", "Text for type action", required=False, default=""),
        ParamSchema("key", "string", "Key or plus-separated hotkey", required=False, default=""),
        ParamSchema("amount", "int", "Click count or scroll amount", required=False, default=1),
    ],
    risk="high",
    requires_confirmation=True,
    timeout=15,
    category="dangerous",
    source=__name__,
)
def computer_interact(
    action: str,
    x: int = 0,
    y: int = 0,
    text: str = "",
    key: str = "",
    amount: int = 1,
) -> str:
    """Execute one narrow local interaction after confirmation has been granted."""
    return json.dumps(_perform_interaction(action, x, y, text, key, amount), ensure_ascii=False)
