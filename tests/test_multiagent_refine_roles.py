"""P1-4 评估与精炼的角色分配修正 验收测试。

覆盖：_role_for_missing 语义映射 / _refine 按缺失项分配角色 /
_has_critical_review 识别严重问题 / _evaluate 在 Reviewer critical 时不满意 /
正常情况仍满意（零回归）。
"""

from arforge.multiagent.master_agent import MasterAgent, QualityAssessment, TaskUnderstanding
from arforge.multiagent.protocol import Conversation, Task, TaskResult


def _u():
    return TaskUnderstanding(intent="x", complexity="medium", suggested_roles=[], estimated_steps=1, needs_multiagent=True)


def test_role_for_missing_mapping():
    assert MasterAgent._role_for_missing("补充单元测试") == "TesterAgent"
    assert MasterAgent._role_for_missing("缺少文档说明") == "DocAgent"
    assert MasterAgent._role_for_missing("需要检索相关代码") == "SearcherAgent"
    assert MasterAgent._role_for_missing("修复异常 bug") == "DebuggerAgent"
    assert MasterAgent._role_for_missing("安全审查") == "ReviewerAgent"
    assert MasterAgent._role_for_missing("实现登录功能") == "CoderAgent"  # 其余 → Coder


def test_refine_assigns_roles_by_missing_semantics():
    m = MasterAgent(None)
    conv = Conversation(master_goal="g")
    q = QualityAssessment(
        satisfied=False, score=0.4,
        missing=["缺少单元测试", "缺少文档", "需要检索相关代码", "实现登录"],
    )
    m._refine(q, conv, _u())
    roles = [t.role for t in conv.tasks]
    assert "TesterAgent" in roles
    assert "DocAgent" in roles
    assert "SearcherAgent" in roles
    assert "CoderAgent" in roles
    # "缺少单元测试" 不再被错误地分给 CoderAgent
    tester_goals = [t.goal for t in conv.tasks if t.role == "TesterAgent"]
    assert any("测试" in g for g in tester_goals)


def test_has_critical_review():
    conv = Conversation(master_goal="g")
    conv.results = [TaskResult(task_id="s1", role="ReviewerAgent", success=True, output="发现 critical 安全漏洞")]
    assert MasterAgent._has_critical_review(conv) is True

    conv2 = Conversation(master_goal="g")
    conv2.results = [TaskResult(task_id="s1", role="ReviewerAgent", success=True, output="代码良好，无明显问题")]
    assert MasterAgent._has_critical_review(conv2) is False

    conv3 = Conversation(master_goal="g")
    conv3.results = [
        TaskResult(
            task_id="s1",
            role="ReviewerAgent",
            success=True,
            output="Review approved: 0 critical issues and no blockers.",
        )
    ]
    assert MasterAgent._has_critical_review(conv3) is False


def test_evaluate_critical_review_triggers_unsatisfied():
    m = MasterAgent(None)
    conv = Conversation(master_goal="g")
    conv.tasks = [Task(task_id="s1", role="CoderAgent", goal="g"), Task(task_id="s2", role="ReviewerAgent", goal="审查")]
    conv.results = [
        TaskResult(task_id="s1", role="CoderAgent", success=True, output="代码"),
        TaskResult(task_id="s2", role="ReviewerAgent", success=True, output="存在 critical 漏洞"),
    ]
    q = m._evaluate(conv, "原目标")
    assert q.satisfied is False  # 全成功但 critical review → 不满意，触发下一轮


def test_evaluate_all_ok_still_satisfied():
    m = MasterAgent(None)
    conv = Conversation(master_goal="g")
    conv.tasks = [Task(task_id="s1", role="CoderAgent", goal="g")]
    conv.results = [TaskResult(task_id="s1", role="CoderAgent", success=True, output="done")]
    q = m._evaluate(conv, "x")
    assert q.satisfied is True  # 无 critical、全成功 → 满意（行为不变）
