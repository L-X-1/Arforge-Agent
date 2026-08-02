from __future__ import annotations

import json
from pathlib import Path

import pytest

from arforge.bridge import dispatch
from arforge.product.keybinding_runtime import KeybindingRuntime, KeybindingRuntimeError


DEFAULTS = {
    "session:new": "ctrl+n",
    "history:search": "ctrl+shift+f",
    "settings:open": "ctrl+,",
}


def _runtime(tmp_path: Path) -> KeybindingRuntime:
    return KeybindingRuntime(tmp_path / "keybindings.json")


def test_keybindings_are_revisioned_canonical_and_can_disable_action(tmp_path: Path):
    runtime = _runtime(tmp_path)
    initial = runtime.get()
    updated = runtime.update(
        {"session:new": "SHIFT+CTRL+N", "history:search": None, "settings:open": "meta+,"},
        initial["revision"],
    )

    assert updated["revision"] == 1
    assert updated["bindings"] == {
        "session:new": "ctrl+shift+n",
        "history:search": None,
        "settings:open": "meta+,",
    }
    assert json.loads((tmp_path / "keybindings.json").read_text(encoding="utf-8"))["bindings"] == updated["bindings"]

    with pytest.raises(KeybindingRuntimeError) as conflict:
        runtime.update(DEFAULTS, 0)
    assert conflict.value.code == "REVISION_CONFLICT"


@pytest.mark.parametrize(
    ("bindings", "code"),
    [
        ({**DEFAULTS, "settings:open": "ctrl+r"}, "RESERVED_KEYBINDING"),
        ({**DEFAULTS, "settings:open": "ctrl+n"}, "KEYBINDING_CONFLICT"),
        ({**DEFAULTS, "settings:open": "n"}, "INVALID_KEYBINDING"),
        ({"session:new": "ctrl+n"}, "INVALID_PARAMS"),
    ],
)
def test_keybindings_reject_unsafe_or_incomplete_documents(tmp_path: Path, bindings: dict, code: str):
    with pytest.raises(KeybindingRuntimeError) as caught:
        _runtime(tmp_path).update(bindings, 0)
    assert caught.value.code == code


def test_keybindings_corruption_fails_closed_without_overwrite(tmp_path: Path):
    path = tmp_path / "keybindings.json"
    path.write_text('{"schema_version":1,"revision":0,"bindings":{"session:new":"ctrl+r"}}', encoding="utf-8")
    original = path.read_bytes()

    with pytest.raises(KeybindingRuntimeError) as caught:
        _runtime(tmp_path).get()

    assert caught.value.code == "KEYBINDINGS_CORRUPT"
    assert path.read_bytes() == original


def test_bridge_exposes_keybindings_and_stable_validation_errors(tmp_path: Path):
    runtime = _runtime(tmp_path)
    described = dispatch({"version": "1.2", "method": "protocol.describe"})
    initial = dispatch({"version": "1.2", "method": "keybindings.get"}, keybindings=runtime)
    rejected = dispatch(
        {
            "version": "1.2",
            "method": "keybindings.update",
            "params": {"bindings": {**DEFAULTS, "settings:open": "ctrl+r"}, "expected_revision": 0},
        },
        keybindings=runtime,
    )
    reset = dispatch(
        {"version": "1.2", "method": "keybindings.reset", "params": {"expected_revision": 0}},
        keybindings=runtime,
    )

    assert "keybindings.get" in described["data"]["methods"]
    assert "keybindings.update" in described["data"]["mutating_methods"]
    assert initial["data"]["bindings"] == DEFAULTS
    assert rejected["error"]["code"] == "RESERVED_KEYBINDING"
    assert reset["data"]["revision"] == 1
