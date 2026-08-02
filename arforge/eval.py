"""真实 eval（DU-4）—— 可重复任务集 → 任务成功率 + 成本/token 度量。

每个任务带可验证的 check()，runner 跑完后核对真实产出（如文件内容），聚合成功率与成本。
成本/token 复用 run_agentic 的可观测汇总（trace 度量，P1-8）。可经 `arforge eval` 对真实模型运行，
也可注入 fake runner 离线单测。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class EvalTask:
    task_id: str
    prompt: str
    check: Callable[[], bool] | None = None  # 确定性核对（如文件是否按预期产出）
    description: str = ""
    judge: str = ""  # LLM-judge 评分标准（用于无法机械核对的回答质量）
    code_test: str = ""  # 真实执行判分：从回答抽取代码 + 此断言代码，子进程跑通才算过
    setup: Callable[[], None] | None = None  # 跑任务前的准备（如清旧产物 / 预置待读文件），保证可重复


@dataclass
class EvalCase:
    task_id: str
    success: bool
    score: float = 1.0
    tokens: int = 0
    cost_cny: float = 0.0
    llm_calls: int = 0
    tool_calls: int = 0
    judge_reason: str = ""
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "success": self.success,
            "score": self.score,
            "tokens": self.tokens,
            "cost_cny": self.cost_cny,
            "llm_calls": self.llm_calls,
            "tool_calls": self.tool_calls,
            "judge_reason": self.judge_reason,
            "error": self.error,
        }


@dataclass
class EvalReport:
    cases: list = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.cases)

    @property
    def passed(self) -> int:
        return sum(1 for c in self.cases if c.success)

    @property
    def success_rate(self) -> float:
        return round(self.passed / self.total, 4) if self.total else 0.0

    @property
    def total_tokens(self) -> int:
        return sum(c.tokens for c in self.cases)

    @property
    def total_cost_cny(self) -> float:
        return round(sum(c.cost_cny for c in self.cases), 6)

    @property
    def avg_score(self) -> float:
        return round(sum(c.score for c in self.cases) / self.total, 4) if self.total else 0.0

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "passed": self.passed,
            "success_rate": self.success_rate,
            "avg_score": self.avg_score,
            "total_tokens": self.total_tokens,
            "total_cost_cny": self.total_cost_cny,
            "cases": [c.to_dict() for c in self.cases],
        }


_JUDGE_SYS = (
    "你是 eval 评判员。依据评分标准判断 Agent 回答是否达标，只返回 JSON："
    '{"passed": true/false, "score": 0到1的浮点, "reason": "简述"}。'
)


def judge_answer(answer: str, rubric: str, adapter) -> dict:
    """用 LLM 依据 rubric 评判 answer。无 adapter / 解析失败 → 不通过（保守）。"""
    if adapter is None:
        return {"passed": False, "score": 0.0, "reason": "no judge adapter"}
    from arforge.models.structured import generate_structured

    messages = [
        {"role": "system", "content": _JUDGE_SYS},
        {"role": "user", "content": f"评分标准：{rubric}\n\nAgent 回答：\n{(answer or '')[:3000]}"},
    ]
    data = generate_structured(adapter, messages, required_keys=["passed"], max_tokens=200, temperature=0.0)
    if not data:
        return {"passed": False, "score": 0.0, "reason": "judge unavailable"}
    return {
        "passed": bool(data.get("passed", False)),
        "score": float(data.get("score", 0.0) or 0.0),
        "reason": str(data.get("reason", ""))[:200],
    }


def _extract_code(answer: str) -> str:
    """从回答中抽取代码：优先 ```python/``` 围栏，否则取全文。"""
    import re

    m = re.search(r"```(?:python|py)?\s*(.+?)```", answer or "", re.S)
    return (m.group(1) if m else (answer or "")).strip()


def run_code_check(answer: str, test_code: str, timeout: int = 10) -> dict:
    """真实执行判分：抽取回答中的代码 + 追加断言，在隔离子进程跑通(exit 0)才算过。

    注意：会执行模型生成的代码，仅用于受信任的 eval 任务/CI；子进程 + 超时是基本隔离。
    """
    import os
    import subprocess
    import sys
    import tempfile

    code = _extract_code(answer)
    if not code:
        return {"passed": False, "score": 0.0, "reason": "no code in answer"}
    script = code + "\n\n" + test_code

    tmp = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8")
    try:
        tmp.write(script)
        tmp.close()
        proc = subprocess.run(
            [sys.executable, tmp.name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        if proc.returncode == 0:
            return {"passed": True, "score": 1.0, "reason": "code ran, assertions passed"}
        return {"passed": False, "score": 0.0, "reason": (proc.stderr.strip() or "assertion failed")[:200]}
    except subprocess.TimeoutExpired:
        return {"passed": False, "score": 0.0, "reason": f"timeout after {timeout}s"}
    except Exception as exc:  # noqa: BLE001
        return {"passed": False, "score": 0.0, "reason": f"{type(exc).__name__}: {exc}"}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def run_eval(tasks: list, runner: Callable, judge_adapter=None) -> EvalReport:
    """对每个任务调用 runner(prompt)，按 check（确定性）与/或 judge（LLM 评判）判定，聚合报告。

    runner(prompt) 返回对象需有 .observability（成本/token）与 .answer（供 LLM-judge）。
    任务可只有 check、只有 judge、或两者皆有（皆有则需都通过）；单任务异常被隔离记为失败。
    """
    report = EvalReport()
    for t in tasks:
        try:
            if t.setup is not None:
                t.setup()  # 准备（清旧产物 / 预置待读文件），保证可重复
            result = runner(t.prompt)
            summary = (getattr(result, "observability", None) or {}).get("summary", {}) or {}
            answer = getattr(result, "answer", "") or ""

            passed = True
            score = 1.0
            reason = ""
            if t.check is not None:
                passed = passed and bool(t.check())
            if t.judge:
                verdict = judge_answer(answer, t.judge, judge_adapter)
                passed = passed and verdict["passed"]
                score = verdict["score"]
                reason = verdict["reason"]
            if t.code_test:
                cc = run_code_check(answer, t.code_test)
                passed = passed and cc["passed"]
                score = cc["score"]
                reason = reason or cc["reason"]
            if t.check is None and not t.judge and not t.code_test:
                passed, reason = False, "no check/judge/code_test defined"

            report.cases.append(
                EvalCase(
                    task_id=t.task_id,
                    success=passed,
                    score=score,
                    tokens=int(summary.get("total_tokens", 0)),
                    cost_cny=float(summary.get("cost_cny", 0.0)),
                    llm_calls=int(summary.get("llm_calls", 0)),
                    tool_calls=int(summary.get("tool_calls", 0)),
                    judge_reason=reason,
                )
            )
        except Exception as exc:  # noqa: BLE001 - 单任务失败不影响整体 eval
            report.cases.append(EvalCase(task_id=t.task_id, success=False, score=0.0, error=f"{type(exc).__name__}: {exc}"))
    return report


def default_runner(prompt: str):
    """默认 runner：用单 Agent agentic 循环跑任务（真实模型）。"""
    import arforge.tools.basic_tools  # noqa: F401
    import arforge.tools.file_tools  # noqa: F401
    import arforge.tools.task_tools  # noqa: F401
    from arforge.core.agent_core import ArforgeAgent
    from arforge.core.agent_loop_v2 import AgentLoopV2

    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    return AgentLoopV2(agent).run_agentic(prompt, max_steps=12)


def builtin_tasks(workspace=None) -> list:
    """内置可验证任务集（~20 个）：确定性文件核对 + 真实代码执行 + LLM-judge 三类混合。

    每个任务带 setup（清旧产物 / 预置待读文件），保证可重复运行不被上一轮残留影响。
    """
    from arforge.tools.file_tools import WORKSPACE

    ws = Path(workspace) if workspace else WORKSPACE

    def _contains(name: str, expect: str) -> Callable[[], bool]:
        def _check() -> bool:
            p = ws / name
            if not p.exists():
                return False
            try:
                return expect in p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                return False

        return _check

    def _reset(*names: str) -> Callable[[], None]:
        def _s() -> None:
            for n in names:
                try:
                    (ws / n).unlink()
                except OSError:
                    pass

        return _s

    def _seed(name: str, content: str, *clears: str) -> Callable[[], None]:
        def _s() -> None:
            ws.mkdir(parents=True, exist_ok=True)
            (ws / name).write_text(content, encoding="utf-8")
            for n in clears:
                try:
                    (ws / n).unlink()
                except OSError:
                    pass

        return _s

    code = lambda asrt: asrt  # noqa: E731 - 仅为下方可读性

    return [
        # ---- 确定性文件产出（check）----
        EvalTask("write_hello", "在工作区创建文件 eval_hello.txt，写入内容：HELLO_ARFORGE。完成后用一句话确认。",
                 check=_contains("eval_hello.txt", "HELLO_ARFORGE"), description="基础写文件", setup=_reset("eval_hello.txt")),
        EvalTask("calc_to_file", "计算 21 乘以 2 等于多少，然后在工作区创建文件 eval_calc.txt，写入计算结果的数字。完成后确认。",
                 check=_contains("eval_calc.txt", "42"), description="计算+写文件(多步)", setup=_reset("eval_calc.txt")),
        EvalTask("two_files", "在工作区创建两个文件：eval_a.txt 写入 AAA，eval_b.txt 写入 BBB。完成后确认。",
                 check=lambda: _contains("eval_a.txt", "AAA")() and _contains("eval_b.txt", "BBB")(),
                 description="多文件产出", setup=_reset("eval_a.txt", "eval_b.txt")),
        EvalTask("sum_to_file", "计算 1 加到 10 的总和，把结果数字写入工作区文件 eval_sum.txt。完成后确认。",
                 check=_contains("eval_sum.txt", "55"), description="求和+写文件", setup=_reset("eval_sum.txt")),
        EvalTask("upper_to_file", "在工作区创建 eval_upper.txt，写入单词 ARFORGE（全大写）。完成后确认。",
                 check=_contains("eval_upper.txt", "ARFORGE"), description="写指定内容", setup=_reset("eval_upper.txt")),
        EvalTask("json_file", '在工作区创建 eval_conf.json，内容为 JSON：{"name": "arforge", "ok": true}。完成后确认。',
                 check=_contains("eval_conf.json", "arforge"), description="写 JSON 文件", setup=_reset("eval_conf.json")),
        EvalTask("read_copy", "读取工作区文件 eval_src.txt 的内容，把它原样写入新文件 eval_dst.txt。完成后确认。",
                 check=_contains("eval_dst.txt", "TOKEN_9988"), description="读+拷贝(多步)",
                 setup=_seed("eval_src.txt", "TOKEN_9988", "eval_dst.txt")),
        EvalTask("read_number", "读取工作区文件 eval_num.txt，提取其中的数字，写入新文件 eval_out.txt。完成后确认。",
                 check=_contains("eval_out.txt", "314"), description="读+抽取(多步)",
                 setup=_seed("eval_num.txt", "the value is 314 ok", "eval_out.txt")),
        # ---- 真实代码执行判分（code_test）----
        EvalTask("fib_code", "写一个 Python 函数 fib(n) 返回斐波那契数列第 n 项（约定 fib(0)=0, fib(1)=1），直接在回答里给出完整代码。",
                 code_test=code("assert fib(0)==0\nassert fib(1)==1\nassert fib(10)==55\nprint('OK')"), description="斐波那契"),
        EvalTask("factorial_code", "写一个 Python 函数 fact(n) 返回 n 的阶乘（fact(0)=1），直接在回答里给出完整代码。",
                 code_test=code("assert fact(0)==1\nassert fact(5)==120\nprint('OK')"), description="阶乘"),
        EvalTask("is_prime_code", "写一个 Python 函数 is_prime(n) 判断 n 是否为素数，返回布尔值，直接在回答里给出完整代码。",
                 code_test=code("assert is_prime(7) is True\nassert is_prime(8) is False\nassert is_prime(2) is True\nprint('OK')"), description="素数判定"),
        EvalTask("reverse_string_code", "写一个 Python 函数 reverse(s) 返回字符串 s 的反转，直接在回答里给出完整代码。",
                 code_test=code("assert reverse('abc')=='cba'\nassert reverse('')==''\nprint('OK')"), description="字符串反转"),
        EvalTask("sum_list_code", "写一个 Python 函数 total(lst) 返回列表 lst 所有元素之和，直接在回答里给出完整代码。",
                 code_test=code("assert total([1,2,3,4])==10\nassert total([])==0\nprint('OK')"), description="列表求和"),
        EvalTask("max_list_code", "写一个 Python 函数 maxv(lst) 返回列表中的最大值，直接在回答里给出完整代码。",
                 code_test=code("assert maxv([3,9,2])==9\nassert maxv([-1,-5])==-1\nprint('OK')"), description="求最大值"),
        EvalTask("palindrome_code", "写一个 Python 函数 is_pal(s) 判断字符串 s 是否为回文，返回布尔值，直接在回答里给出完整代码。",
                 code_test=code("assert is_pal('level') is True\nassert is_pal('abc') is False\nprint('OK')"), description="回文判定"),
        EvalTask("fizzbuzz_code",
                 "写一个 Python 函数 fizzbuzz(n)：n 能被 15 整除返回字符串 'FizzBuzz'，能被 3 整除返回 'Fizz'，"
                 "能被 5 整除返回 'Buzz'，否则返回 str(n)。直接在回答里给出完整代码。",
                 code_test=code("assert fizzbuzz(15)=='FizzBuzz'\nassert fizzbuzz(3)=='Fizz'\nassert fizzbuzz(5)=='Buzz'\nassert fizzbuzz(7)=='7'\nprint('OK')"),
                 description="FizzBuzz"),
        # ---- 开放式回答（LLM-judge）----
        EvalTask("explain_recursion", "用一两句话简洁解释什么是递归（recursion）。",
                 judge="回答正确解释了递归（函数/过程调用自身，或把问题分解为同类子问题），无明显概念错误。", description="解释递归"),
        EvalTask("explain_hashmap", "用一两句话简洁解释什么是哈希表（hash table / 哈希map）。",
                 judge="回答正确解释了哈希表（用哈希函数把键映射到桶/槽位，支持近似 O(1) 的增删查），无明显概念错误。", description="解释哈希表"),
        EvalTask("explain_rest", "用一两句话简洁解释什么是 REST API。",
                 judge="回答正确解释了 REST API（基于 HTTP、以资源为中心、用 GET/POST 等方法操作，通常无状态），无明显概念错误。", description="解释 REST"),
        EvalTask("explain_async", "用一两句话简洁解释 Python 中 async/await 的作用。",
                 judge="回答正确解释了 async/await（用于异步/协程并发，await 在等待 IO 时让出控制权以提高并发），无明显概念错误。", description="解释 async"),
    ]
