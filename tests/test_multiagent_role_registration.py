"""P1-5 确认 8 角色真正注册 验收测试。

覆盖：create_agent(role) 对 8 个角色返回对应具体子类（而非回退通用 SubAgent）；
pool.get(role) 返回具体类；reset 后再取仍能重注册。
"""

from arforge.multiagent import agents as A
from arforge.multiagent.sub_agent import SubAgent
from arforge.multiagent.sub_agent_pool import SubAgentPool, get_sub_agent_pool

_ROLES = {
    "PlannerAgent": A.PlannerAgent,
    "CoderAgent": A.CoderAgent,
    "ReviewerAgent": A.ReviewerAgent,
    "TesterAgent": A.TesterAgent,
    "SearcherAgent": A.SearcherAgent,
    "DocAgent": A.DocAgent,
    "DebuggerAgent": A.DebuggerAgent,
    "DataAgent": A.DataAgent,
}


def test_all_8_roles_create_concrete_subclass():
    pool = get_sub_agent_pool()
    for role, cls in _ROLES.items():
        inst = pool.create_agent(role)
        assert isinstance(inst, cls), f"{role} 应返回 {cls.__name__}，实得 {type(inst).__name__}"
        assert type(inst) is not SubAgent, f"{role} 不应回退通用 SubAgent"


def test_pool_get_returns_concrete_class():
    pool = get_sub_agent_pool()
    assert pool.get("TesterAgent") is A.TesterAgent
    assert pool.get("SearcherAgent") is A.SearcherAgent


def test_direct_singleton_access_initializes_builtin_roles():
    """The documented singleton API must not expose a half-loaded registry."""
    pool = SubAgentPool.instance()
    assert pool.get("CoderAgent") is A.CoderAgent
    assert isinstance(pool.create_agent("ReviewerAgent"), A.ReviewerAgent)


def test_reset_then_reload_reregisters():
    pool = get_sub_agent_pool()
    pool.reset()
    pool2 = get_sub_agent_pool()  # reset 清了标志 → 重新注册
    assert pool2.get("CoderAgent") is A.CoderAgent
    assert isinstance(pool2.create_agent("TesterAgent"), A.TesterAgent)
