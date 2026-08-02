from __future__ import annotations

from pathlib import Path

import pytest

from arforge.tool_registry import REGISTRY
from arforge.tools import load_builtin_tools
from arforge.tools.computer_tools import ComputerToolError, _capture_screenshot, _perform_interaction


class FakeImage:
    size = (1920, 1080)

    def save(self, path: Path, format: str) -> None:
        assert format == "PNG"
        path.write_bytes(b"png")


class FakeController:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def click(self, *args, **kwargs) -> None:
        self.calls.append(("click", args, kwargs))

    def doubleClick(self, *args, **kwargs) -> None:  # noqa: N802 - external backend API spelling
        self.calls.append(("doubleClick", args, kwargs))

    def moveTo(self, *args, **kwargs) -> None:  # noqa: N802 - external backend API spelling
        self.calls.append(("moveTo", args, kwargs))

    def write(self, *args, **kwargs) -> None:
        self.calls.append(("write", args, kwargs))

    def press(self, *args, **kwargs) -> None:
        self.calls.append(("press", args, kwargs))

    def hotkey(self, *args, **kwargs) -> None:
        self.calls.append(("hotkey", args, kwargs))

    def scroll(self, *args, **kwargs) -> None:
        self.calls.append(("scroll", args, kwargs))


def test_capture_screenshot_writes_only_a_local_png_artifact(tmp_path: Path):
    destination = tmp_path / "screen.png"

    result = _capture_screenshot(destination, grabber=lambda **_kwargs: FakeImage())

    assert destination.read_bytes() == b"png"
    assert result == {"path": str(destination), "width": 1920, "height": 1080, "mime": "image/png"}


def test_local_interaction_dispatches_one_validated_action_to_backend():
    controller = FakeController()

    result = _perform_interaction("hotkey", 0, 0, "", "ctrl+s", 1, controller=controller)

    assert result["completed"] is True
    assert controller.calls == [("hotkey", ("ctrl", "s"), {})]


@pytest.mark.parametrize(
    ("action", "x", "y", "text", "key", "amount"),
    [
        ("unknown", 0, 0, "", "", 1),
        ("click", -1, 0, "", "", 1),
        ("type", 0, 0, "", "", 1),
        ("press", 0, 0, "", "ctrl;rm", 1),
        ("scroll", 0, 0, "", "", 51),
    ],
)
def test_local_interaction_rejects_invalid_or_overbroad_requests(action: str, x: int, y: int, text: str, key: str, amount: int):
    with pytest.raises(ComputerToolError):
        _perform_interaction(action, x, y, text, key, amount, controller=FakeController())


def test_builtin_registration_marks_local_computer_tools_as_confirmation_gated():
    load_builtin_tools()

    screenshot = REGISTRY.get("capture_screen")
    interaction = REGISTRY.get("computer_interact")

    assert screenshot is not None and screenshot.schema.requires_confirmation is True
    assert screenshot.schema.category == "system"
    assert interaction is not None and interaction.schema.requires_confirmation is True
    assert interaction.schema.category == "dangerous"
