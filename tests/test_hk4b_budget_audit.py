"""HK-4 续：budget（运行级 token 预算守卫）+ audit（工具执行审计）入中间件链 验收测试。"""

from types import SimpleNamespace

import pytest

from arforge.core import budget
from arforge.core.agentic import run_tool_loop
from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.multiagent import security
from arforge.tool_registry import ToolResult


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))  # 隔离审计日志
    reset_hook_manager()
    budget._run_budget.set(None)
    yield
    reset_hook_manager()
    budget._run_budget.set(None)


# ----------------------------- budget -----------------------------


class _Resp:
    def __init__(self, content="", tool_calls=None, usage=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = usage or {"total_tokens": 100}
        self.finish_reason = "stop"


def test_budget_accumulate_and_guard():
    with budget.budget_scope(150):
        post = HookContext(HookEvent.POST_LLM_CALL, metadata={"usage": {"total_tokens": 100}})
        budget._accumulate_hook(post)
        assert budget.budget_guard_hook(HookContext(HookEvent.PRE_LLM_CALL)) is None  # 100<150
        budget._accumulate_hook(post)  # used=200
        dec = budget.budget_guard_hook(HookContext(HookEvent.PRE_LLM_CALL))
        assert dec is not None and dec.action == "block"


def test_budget_guard_noop_without_scope():
    assert budget.budget_guard_hook(HookContext(HookEvent.PRE_LLM_CALL)) is None


def test_budget_zero_max_is_unlimited():
    with budget.budget_scope(0):
        budget._run_budget.get()["used"] = 999_999
        assert budget.budget_guard_hook(HookContext(HookEvent.PRE_LLM_CALL)) is None


def test_budget_scope_exposes_remaining_tokens():
    with budget.budget_scope(150):
        assert budget.remaining_tokens() == 150
        state = budget.current_usage()
        assert state is not None
        state["used"] = 40
        assert budget.remaining_tokens() == 110

    assert budget.remaining_tokens() is None


def test_budget_preflight_reserves_prompt_and_tool_tokens():
    with budget.budget_scope(500):
        allowance = budget.safe_completion_allowance(
            [{"role": "user", "content": "x" * 400}],
            [{"type": "function", "function": {"name": "tool", "description": "y" * 200}}],
        )
        assert allowance is not None
        assert 0 <= allowance < 500


class _BudgetAdapter:
    model_name = "x"

    def __init__(self):
        self.calls = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        self.calls += 1
        # 每步不同参数（避免死循环熔断抢先），每次 usage=100 token
        tc = SimpleNamespace(id=f"c{self.calls}", name="noop", arguments=f'{{"i": {self.calls}}}')
        return _Resp(tool_calls=[tc], usage={"total_tokens": 100})


def test_run_tool_loop_aborts_on_budget():
    budget.install_budget_hooks()
    adapter = _BudgetAdapter()
    result = None
    with budget.budget_scope(150):  # 累计 200 > 150 → 第3步 PRE_LLM_CALL 中止
        result = run_tool_loop(
            adapter, [{"role": "user", "content": "go"}], tools=[], max_steps=20,
            executor=lambda name, args: ToolResult(name, True, "ok"),
        )
    assert "运行中止" in result.answer
    assert adapter.calls <= 3  # 提前中止，而非跑满 20 步


# ----------------------------- audit -----------------------------


def test_audit_hook_writes_log(tmp_path):
    security.install_audit_hook()
    assert get_hook_manager().handler_count(HookEvent.POST_TOOL_USE) == 1
    ctx = HookContext(
        HookEvent.POST_TOOL_USE, tool_name="write_file",
        tool_result=ToolResult("write_file", True, "ok"), metadata={"step": 1},
    )
    security.audit_hook(ctx)
    audit = tmp_path / "multiagent_audit.log"
    assert audit.exists()
    assert "tool:write_file" in audit.read_text(encoding="utf-8")


def test_audit_hook_records_failure(tmp_path):
    security.install_audit_hook()
    ctx = HookContext(
        HookEvent.POST_TOOL_USE, tool_name="run_cmd",
        tool_result=ToolResult("run_cmd", False, "", "blocked"), metadata={"step": 2},
    )
    security.audit_hook(ctx)
    txt = (tmp_path / "multiagent_audit.log").read_text(encoding="utf-8")
    assert "tool:run_cmd" in txt and "allowed=False" in txt


def test_install_security_hooks_registers_sandbox_and_audit():
    security.install_security_hooks()
    mgr = get_hook_manager()
    assert mgr.handler_count(HookEvent.PRE_TOOL_USE) == 1   # sandbox
    assert mgr.handler_count(HookEvent.POST_TOOL_USE) == 1  # audit
