"""v1-G13 运行中可打断（interrupt）测试。"""

from __future__ import annotations

import time

import pytest

from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.core.interrupt import (
    InterruptControlFile,
    InterruptState,
    get_interrupt_state,
    install_interrupt_hook,
    interrupt_hook,
    reset_interrupt_state,
    start_interrupt_control_file,
)


@pytest.fixture(autouse=True)
def _iso():
    reset_interrupt_state()
    yield
    reset_interrupt_state()


def test_request_and_should_stop():
    s = InterruptState()
    assert s.should_stop() is False
    s.request_stop()
    assert s.should_stop() is True


def test_add_drain_instructions():
    s = InterruptState()
    s.add_instruction("  do X  ")
    s.add_instruction("")  # 空忽略
    assert s.has_instructions()
    assert s.drain_instructions() == ["do X"]
    assert s.drain_instructions() == []  # drain 清空


def test_hook_blocks_on_stop():
    get_interrupt_state().request_stop()
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=[])
    assert interrupt_hook(ctx).action == "block"


def test_hook_injects_instructions():
    get_interrupt_state().add_instruction("换个方法")
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=[{"role": "system", "content": "x"}])
    dec = interrupt_hook(ctx)
    assert dec.action == "modify"
    assert any("换个方法" in m["content"] for m in ctx.messages)


def test_hook_proceeds_by_default():
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=[])
    assert interrupt_hook(ctx).action == "proceed"


def test_stop_takes_priority_over_instructions():
    s = get_interrupt_state()
    s.add_instruction("x")
    s.request_stop()
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=[])
    assert interrupt_hook(ctx).action == "block"  # stop 优先于指令注入


def test_install_registered():
    reset_hook_manager()
    install_interrupt_hook()
    names = [e.name for e in get_hook_manager()._handlers.get(HookEvent.PRE_LLM_CALL, [])]
    assert "interrupt" in names


def test_install_is_idempotent():
    reset_hook_manager()
    install_interrupt_hook()
    install_interrupt_hook()
    names = [e.name for e in get_hook_manager()._handlers.get(HookEvent.PRE_LLM_CALL, [])]
    assert names.count("interrupt") == 1


def test_fire_blocks_run_end_to_end():
    reset_hook_manager()
    install_interrupt_hook()
    get_interrupt_state().request_stop()
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=[])
    assert get_hook_manager().fire(ctx).action == "block"


def test_control_file_queues_instruction(tmp_path):
    control = tmp_path / "arforge-control.txt"
    watcher = start_interrupt_control_file(control, poll_interval=0.05)
    try:
        with control.open("a", encoding="utf-8") as handle:
            handle.write("instruction: change approach\n")
        deadline = time.time() + 2
        while time.time() < deadline and not get_interrupt_state().has_instructions():
            time.sleep(0.02)
        assert get_interrupt_state().drain_instructions() == ["change approach"]
    finally:
        watcher.stop()
        watcher.stop()


def test_control_file_requests_stop(tmp_path):
    control = tmp_path / "arforge-control.txt"
    watcher = start_interrupt_control_file(control, poll_interval=0.05)
    try:
        with control.open("a", encoding="utf-8") as handle:
            handle.write("stop\n")
        deadline = time.time() + 2
        while time.time() < deadline and not get_interrupt_state().should_stop():
            time.sleep(0.02)
        assert get_interrupt_state().should_stop() is True
    finally:
        watcher.stop()


def test_control_file_poll_once_treats_plain_line_as_instruction(tmp_path):
    control = tmp_path / "arforge-control.txt"
    control.write_text("", encoding="utf-8")
    watcher = InterruptControlFile(control)
    watcher.start()
    watcher.stop()

    with control.open("a", encoding="utf-8") as handle:
        handle.write("please inspect tests first\n")
    watcher.poll_once()

    assert get_interrupt_state().drain_instructions() == ["please inspect tests first"]
