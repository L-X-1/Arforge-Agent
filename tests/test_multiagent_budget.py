"""P2-7 任务级成本门禁 验收测试。

覆盖：累计 token 超 Conversation.max_total_tokens → 熔断剩余层、剩余任务标 aborted；
正常预算不误熔断；与 P0-1 单角色 token 检查形成双层防护。
"""

from arforge.multiagent.dispatcher import TaskDispatcher
from arforge.multiagent.protocol import Conversation, Task, TaskResult


def _linear_tasks(n):
    tasks = []
    for i in range(1, n + 1):
        deps = [f"s{i-1}"] if i > 1 else []
        tasks.append(Task(task_id=f"s{i}", role="CoderAgent", goal=f"g{i}", depends_on=deps))
    return tasks


def test_total_budget_circuit_breaks(monkeypatch):
    disp = TaskDispatcher()
    # 每个任务消耗 100 token
    disp._execute_one = lambda task, conv: TaskResult(
        task_id=task.task_id, role=task.role, success=True, output="ok", tokens_used=100
    )
    conv = Conversation(master_goal="g", max_total_tokens=150)  # 第2层累计200>150
    results = disp.dispatch([Task(task_id="t1", role="A", goal="a", depends_on=[]), Task(task_id="t2", role="A", goal="b", depends_on=[]), Task(task_id="t3", role="A", goal="c", depends_on=["t1"])], conv)

    aborted = [r for r in results if not r.success and "total budget" in (r.error or "")]
    assert aborted, "应有任务因总预算熔断被标 aborted"
    # s3 未执行（被熔断）
    s3 = next(r for r in results if r.task_id == "t3")
    assert not s3.success and "total budget" in s3.error


def test_normal_budget_no_false_break():
    disp = TaskDispatcher()
    disp._execute_one = lambda task, conv: TaskResult(
        task_id=task.task_id, role=task.role, success=True, output="ok", tokens_used=10
    )
    conv = Conversation(master_goal="g", max_total_tokens=50000)
    results = disp.dispatch([Task(task_id="t1", role="A", goal="a", depends_on=[]), Task(task_id="t2", role="A", goal="b", depends_on=[]), Task(task_id="t3", role="A", goal="c", depends_on=["t1"])], conv)

    assert all(r.success for r in results)  # 30 token << 50000，不熔断
    assert not any("total budget" in (r.error or "") for r in results)


def test_conversation_has_default_budget():
    assert Conversation(master_goal="g").max_total_tokens == 50000
