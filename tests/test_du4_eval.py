"""DU-4 真实 eval 框架 验收测试（注入 fake runner，离线）。"""

from arforge.eval import EvalTask, builtin_tasks, judge_answer, run_code_check, run_eval


class FakeResult:
    def __init__(self, summary, answer="", incomplete_report=None):
        self.observability = {"summary": summary}
        self.answer = answer
        self.incomplete_report = incomplete_report


class FakeJudge:
    """generate 返回固定 JSON，模拟 LLM-judge 结构化输出。"""

    model_name = "judge"

    def __init__(self, payload):
        self.payload = payload

    def generate(self, messages, max_tokens=None, temperature=None, response_format=None):
        return self.payload


def test_run_eval_success_rate_and_metrics():
    tasks = [EvalTask("t1", "p1", lambda: True), EvalTask("t2", "p2", lambda: False)]

    def runner(prompt):
        return FakeResult({"total_tokens": 100, "cost_cny": 0.01, "llm_calls": 2, "tool_calls": 1})

    report = run_eval(tasks, runner)
    assert report.total == 2
    assert report.passed == 1
    assert report.success_rate == 0.5
    assert report.total_tokens == 200
    assert round(report.total_cost_cny, 4) == 0.02


def test_run_eval_runner_exception_is_failure():
    def runner(prompt):
        raise RuntimeError("model down")

    report = run_eval([EvalTask("t", "p", lambda: True)], runner)
    assert report.passed == 0
    assert "model down" in report.cases[0].error


def test_formal_eval_persists_verified_artifact_and_signed_outcome(
    tmp_path, monkeypatch
):
    from arforge.core.dogfood import load_outcomes
    import arforge.product.model_config_runtime as model_runtime

    class Runtime:
        def get_resolved_config(self):
            return {
                "resolved": True,
                "provider": "deepseek",
                "model": "deepseek-chat",
            }

    monkeypatch.setattr(model_runtime, "get_model_config", lambda: Runtime())

    def setup(workspace):
        (workspace / "input.txt").write_text("seed", encoding="utf-8")

    def verify(workspace):
        return (workspace / "output.txt").read_text(encoding="utf-8") == "done"

    def runner(task, workspace):
        (workspace / "output.txt").write_text("done", encoding="utf-8")
        return FakeResult(
            {
                "total_tokens": 50,
                "cost_cny": 0.01,
                "llm_calls": 4,
                "tool_calls": 3,
            }
        )

    report = run_eval(
        [
            EvalTask(
                "formal-1",
                "complete the fixture",
                setup=setup,
                verify=verify,
                category="python",
            )
        ],
        runner,
        suite="release",
        formal=True,
        formal_artifacts_dir=tmp_path / "artifacts",
    )

    assert report.passed == 1
    artifact = __import__("pathlib").Path(report.cases[0].artifact_path)
    assert (artifact / "formal-evidence.json").is_file()
    assert (artifact / "output.txt").read_text(encoding="utf-8") == "done"
    rows = load_outcomes()
    assert len(rows) == 1
    assert rows[0]["formal"] is True
    assert rows[0]["real_model"] is True
    assert rows[0]["verification_passed"] is True
    assert len(rows[0]["record_hash"]) == 64


def test_run_eval_check_exception_is_failure():
    def boom():
        raise ValueError("bad check")

    report = run_eval([EvalTask("t", "p", boom)], lambda p: FakeResult({}))
    assert report.passed == 0


def test_builtin_check_tasks_fail_before_anything_created(tmp_path):
    tasks = builtin_tasks(workspace=tmp_path)
    assert len(tasks) >= 3
    check_tasks = [t for t in tasks if t.check is not None]
    assert check_tasks  # 至少有确定性核对任务
    for t in check_tasks:
        assert t.check() is False  # 尚未产出任何文件


def test_builtin_task_check_passes_when_file_present(tmp_path):
    tasks = builtin_tasks(workspace=tmp_path)
    hello = next(t for t in tasks if t.task_id == "write_hello")
    (tmp_path / "eval_hello.txt").write_text("... HELLO_ARFORGE ...", encoding="utf-8")
    assert hello.check() is True


def test_builtin_two_files_task_requires_both(tmp_path):
    tasks = builtin_tasks(workspace=tmp_path)
    two = next(t for t in tasks if t.task_id == "two_files")
    (tmp_path / "eval_a.txt").write_text("AAA", encoding="utf-8")
    assert two.check() is False  # 只有一个文件 → 未通过
    (tmp_path / "eval_b.txt").write_text("BBB", encoding="utf-8")
    assert two.check() is True


def test_report_to_dict():
    report = run_eval([EvalTask("t", "p", lambda: True)], lambda p: FakeResult({"total_tokens": 5}))
    d = report.to_dict()
    assert d["total"] == 1 and d["passed"] == 1 and d["success_rate"] == 1.0
    assert d["cases"][0]["task_id"] == "t"


# ----------------------------- LLM-judge -----------------------------


def test_judge_answer_no_adapter_fails():
    v = judge_answer("some answer", "rubric", None)
    assert v["passed"] is False


def test_judge_answer_with_adapter():
    judge = FakeJudge('{"passed": true, "score": 0.9, "reason": "ok"}')
    v = judge_answer("递归是函数调用自身", "正确解释递归", judge)
    assert v["passed"] is True and v["score"] == 0.9


def test_run_eval_judge_task_pass():
    tasks = [EvalTask("explain", "解释递归", judge="正确解释递归")]
    judge = FakeJudge('{"passed": true, "score": 0.95, "reason": "准确"}')
    report = run_eval(tasks, lambda p: FakeResult({"total_tokens": 50}, answer="递归是函数调用自身"), judge_adapter=judge)
    assert report.passed == 1
    assert report.cases[0].judge_reason == "准确"
    assert report.cases[0].score == 0.95


def test_judge_accepts_fenced_json_from_compatible_provider():
    judge = FakeJudge('```json\n{"passed": true, "score": 0.8, "reason": "ok"}\n```')

    verdict = judge_answer("answer", "rubric", judge)

    assert verdict == {"passed": True, "score": 0.8, "reason": "ok"}


def test_run_eval_judge_task_fail():
    tasks = [EvalTask("explain", "解释递归", judge="正确解释递归")]
    judge = FakeJudge('{"passed": false, "score": 0.1, "reason": "答非所问"}')
    report = run_eval(tasks, lambda p: FakeResult({}, answer="天气不错"), judge_adapter=judge)
    assert report.passed == 0


def test_run_eval_check_and_judge_both_required():
    # check 通过但 judge 不过 → 整体失败
    tasks = [EvalTask("both", "p", check=lambda: True, judge="必须达标")]
    judge = FakeJudge('{"passed": false, "score": 0.0, "reason": "no"}')
    report = run_eval(tasks, lambda p: FakeResult({}, answer="x"), judge_adapter=judge)
    assert report.passed == 0


def test_builtin_tasks_include_judge_and_code_tasks(tmp_path):
    tasks = builtin_tasks(workspace=tmp_path)
    judged = [t for t in tasks if t.judge]
    code_tested = [t for t in tasks if t.code_test]
    assert len(judged) >= 1  # explain_recursion（LLM-judge）
    assert len(code_tested) >= 1  # fib_code（真实执行判分）
    assert all(t.check is None for t in judged + code_tested)


def test_avg_score():
    tasks = [EvalTask("a", "p", judge="r"), EvalTask("b", "p", judge="r")]
    judge = FakeJudge('{"passed": true, "score": 0.8, "reason": "ok"}')
    report = run_eval(tasks, lambda p: FakeResult({}, answer="x"), judge_adapter=judge)
    assert report.avg_score == 0.8


# ----------------------------- 真实代码执行判分 -----------------------------

_FIB_CODE = "```python\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n```"


def test_run_code_check_pass():
    r = run_code_check(_FIB_CODE, "assert fib(0) == 0\nassert fib(10) == 55\nprint('OK')")
    assert r["passed"] is True and r["score"] == 1.0


def test_run_code_check_fail_on_wrong_logic():
    r = run_code_check("def fib(n):\n    return 123", "assert fib(10) == 55")
    assert r["passed"] is False


def test_run_code_check_no_code():
    assert run_code_check("", "assert True")["passed"] is False


def test_run_eval_code_test_task():
    tasks = [EvalTask("fib", "写斐波那契", code_test="assert fib(10) == 55\nprint('OK')")]
    report = run_eval(tasks, lambda p: FakeResult({"total_tokens": 30}, answer=_FIB_CODE))
    assert report.passed == 1
    assert report.cases[0].score == 1.0


# ----------------------------- 扩充任务集 + setup -----------------------------


def test_builtin_tasks_count_and_categories(tmp_path):
    tasks = builtin_tasks(workspace=tmp_path)
    assert len(tasks) >= 18
    assert sum(1 for t in tasks if t.check) >= 6       # 确定性文件
    assert sum(1 for t in tasks if t.code_test) >= 6   # 真实代码执行
    assert sum(1 for t in tasks if t.judge) >= 3       # LLM-judge


def test_read_task_setup_seeds_source(tmp_path):
    tasks = builtin_tasks(workspace=tmp_path)
    read_copy = next(t for t in tasks if t.task_id == "read_copy")
    assert read_copy.setup is not None
    read_copy.setup()
    assert (tmp_path / "eval_src.txt").read_text(encoding="utf-8") == "TOKEN_9988"


def test_run_eval_calls_setup():
    calls = []
    task = EvalTask("x", "p", check=lambda: True, setup=lambda: calls.append("setup"))
    run_eval([task], lambda p: FakeResult({}))
    assert calls == ["setup"]


def test_run_eval_passes_isolated_workspace_to_fixture_setup():
    seen = []

    def setup(workspace):
        seen.append(workspace)
        (workspace / "seed.txt").write_text("ready", encoding="utf-8")

    def runner(task, workspace):
        assert (workspace / "seed.txt").read_text(encoding="utf-8") == "ready"
        return FakeResult({})

    report = run_eval([EvalTask("seeded", "p", check=lambda: True, setup=setup)], runner)

    assert report.passed == 1
    assert len(seen) == 1


def test_run_eval_isolates_changed_file_evidence_between_tasks():
    from arforge.core.change_tracker import get_change_tracker

    seen_before_record = []

    def runner(task, _workspace):
        tracker = get_change_tracker()
        seen_before_record.append(tracker.changed())
        tracker.record(f"{task.task_id}.txt")
        return FakeResult({})

    report = run_eval(
        [
            EvalTask("first", "p", check=lambda: True),
            EvalTask("second", "p", check=lambda: True),
        ],
        runner,
    )

    assert report.passed == 2
    assert seen_before_record == [[], []]


def test_run_eval_does_not_pass_unjudged_rubric_task():
    task = EvalTask("needs-judge", "p", judge="must be correct")

    report = run_eval([task], lambda p: FakeResult({}, answer="anything"))

    assert report.passed == 0
    assert report.cases[0].error == "judge adapter was not configured"


def test_run_eval_does_not_pass_incomplete_agent_result_even_if_check_passes():
    task = EvalTask("incomplete", "p", check=lambda: True)
    result = FakeResult({}, incomplete_report={"stop_reason": "verification_missing"})

    report = run_eval([task], lambda _prompt: result)

    assert report.passed == 0


def test_run_eval_restores_file_tool_workspace(tmp_path):
    from arforge.tools.file_tools import get_workspace, set_workspace

    original = tmp_path / "original"
    set_workspace(original)

    report = run_eval(
        [EvalTask("isolated", "p", check=lambda: True)],
        lambda _task, workspace: FakeResult({}, answer=str(workspace)),
    )

    assert report.passed == 1
    assert get_workspace() == original.resolve()


def test_failed_eval_preserves_isolated_artifacts_for_diagnosis(tmp_path):
    def setup(workspace):
        (workspace / "broken.py").write_text("broken = True\n", encoding="utf-8")

    task = EvalTask("broken-task", "p", check=lambda: False, setup=setup)
    report = run_eval(
        [task],
        lambda _task, _workspace: FakeResult({}, answer="not fixed"),
        failure_artifacts_dir=tmp_path / "failures",
    )

    artifact = __import__("pathlib").Path(report.cases[0].artifact_path)
    assert artifact.is_dir()
    assert (artifact / "broken.py").is_file()
    assert (artifact / "eval-result.json").is_file()
