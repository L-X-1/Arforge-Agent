"""Fifty real-workspace tasks for sustained formal dogfood runs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys
from typing import Callable

from arforge.eval.runner import EvalTask


@dataclass(frozen=True)
class Scenario:
    family: str
    category: str
    prompt: str
    source: str
    tests: str
    module: str
    required_fragment: str


def _write(workspace: Path, relative: str, content: str) -> None:
    target = workspace / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _pricing(index: int) -> Scenario:
    threshold = 80 + index * 10
    return Scenario(
        "pricing",
        "bug_fix",
        (
            f"修复 app/pricing_{index}.py 的订单计价。小计达到 {threshold} 时先应用折扣，"
            "再计算税费，结果保留两位小数；拒绝负数条目。保持现有 API，新增 "
            "tests/test_regression.py 覆盖阈值边界和负数，并运行全部 pytest。"
        ),
        f"""def compute_total(items, tax_rate=0.1, discount_threshold={threshold}, discount_rate=0.05):
    # BUG: policies are ignored.
    return round(sum(items), 2)
""",
        f"""import pytest
from app.pricing_{index} import compute_total

def test_discount_then_tax():
    assert compute_total([{threshold}, 20], tax_rate=0.1, discount_threshold={threshold}, discount_rate=0.05) == {round((threshold + 20) * .95 * 1.1, 2)!r}

def test_below_threshold_has_no_discount():
    assert compute_total([20, 30], tax_rate=0.1, discount_threshold={threshold}) == 55.0
""",
        f"pricing_{index}",
        "discount_threshold",
    )


def _inventory(index: int) -> Scenario:
    initial = 10 + index
    return Scenario(
        "inventory",
        "feature_add",
        (
            f"完善 app/inventory_{index}.py 的 Inventory.reserve：数量必须为正且不能超过库存，"
            "成功时扣减库存并记录 (sku, qty) 到 audit。异常使用 ValueError。新增 "
            "tests/test_regression.py 覆盖原子失败和连续预留，运行全部 pytest。"
        ),
        """class Inventory:
    def __init__(self, stock):
        self.stock = dict(stock)
        self.audit = []

    def reserve(self, sku, qty):
        return self.stock.get(sku, 0) >= qty
""",
        f"""import pytest
from app.inventory_{index} import Inventory

def test_reserve_updates_stock_and_audit():
    inv = Inventory({{"A": {initial}}})
    assert inv.reserve("A", 3) is True
    assert inv.stock["A"] == {initial - 3}
    assert inv.audit == [("A", 3)]

def test_insufficient_is_atomic():
    inv = Inventory({{"A": 2}})
    with pytest.raises(ValueError):
        inv.reserve("A", 3)
    assert inv.stock["A"] == 2 and inv.audit == []
""",
        f"inventory_{index}",
        "self.audit",
    )


def _slug(index: int) -> Scenario:
    limit = 20 + index
    return Scenario(
        "slug",
        "data_processing",
        (
            f"实现 app/slug_{index}.py 的 slugify(value, max_length={limit})：Unicode 字母数字保留并"
            "转小写，连续空白或标点折叠为一个连字符，去掉首尾连字符，按 max_length 截断后再次"
            "清理尾部。新增 tests/test_regression.py 覆盖中文、连续标点和截断，运行全部 pytest。"
        ),
        """def slugify(value, max_length=80):
    return value.lower().replace(" ", "-")
""",
        f"""from app.slug_{index} import slugify

def test_collapses_separators_and_keeps_unicode():
    assert slugify("  Arforge，中文  Agent!! ") == "arforge-中文-agent"

def test_respects_limit_without_trailing_dash():
    value = slugify("alpha beta gamma", max_length={limit})
    assert len(value) <= {limit} and not value.endswith("-")
""",
        f"slug_{index}",
        "max_length",
    )


def _retry(index: int) -> Scenario:
    retries = 2 + index % 3
    return Scenario(
        "retry",
        "test_write",
        (
            f"修复 app/retry_{index}.py 的 run_with_retry。retries={retries} 表示首次调用之外最多"
            "再试该次数；只重试 retry_on 指定异常，成功立即返回，耗尽后重抛最后异常。新增 "
            "tests/test_regression.py 覆盖非重试异常与精确调用次数，运行全部 pytest。"
        ),
        """def run_with_retry(operation, retries=2, retry_on=(RuntimeError,)):
    for _ in range(retries):
        try:
            return operation()
        except Exception:
            pass
    return None
""",
        f"""import pytest
from app.retry_{index} import run_with_retry

def test_succeeds_after_retry():
    calls = []
    def operation():
        calls.append(1)
        if len(calls) <= {retries}:
            raise RuntimeError("temporary")
        return "ok"
    assert run_with_retry(operation, retries={retries}) == "ok"
    assert len(calls) == {retries + 1}
""",
        f"retry_{index}",
        "retry_on",
    )


def _state(index: int) -> Scenario:
    return Scenario(
        "state",
        "multi_file",
        (
            f"修复 app/state_{index}.py 的订单状态机，并让 app/service_{index}.py 继续使用它。"
            "合法转换为 draft+submit→submitted、submitted+pay→paid、submitted+cancel→cancelled；"
            "其他组合抛 ValueError。新增 tests/test_regression.py 覆盖终态和服务层，运行全部 pytest。"
        ),
        """TRANSITIONS = {}

def transition(state, event):
    return event
""",
        f"""import pytest
from app.state_{index} import transition
from app.service_{index} import OrderService

def test_happy_path():
    assert transition("draft", "submit") == "submitted"
    assert transition("submitted", "pay") == "paid"

def test_service_uses_transition():
    service = OrderService()
    assert service.apply("draft", "submit") == "submitted"
""",
        f"state_{index}",
        "TRANSITIONS",
    )


def _refactor(index: int) -> Scenario:
    return Scenario(
        "refactor",
        "refactor",
        (
            f"重构 app/legacy_{index}.py：把 normalize_name 移到新的 app/text_{index}.py，"
            "legacy 模块保留兼容导入，process 的外部行为不能改变。新增 tests/test_regression.py "
            "覆盖兼容入口、空白折叠和 Unicode 名称，运行全部 pytest。"
        ),
        """def normalize_name(value):
    return " ".join(value.strip().split()).title()

def process(record):
    return {**record, "name": normalize_name(record["name"])}
""",
        f"""from app.legacy_{index} import process, normalize_name

def test_process_normalizes_name():
    assert process({{"name": "  ada   lovelace "}})["name"] == "Ada Lovelace"

def test_legacy_export_remains():
    assert normalize_name("grace hopper") == "Grace Hopper"
""",
        f"legacy_{index}",
        f"from app.text_{index}",
    )


def _architecture(index: int) -> Scenario:
    return Scenario(
        "architecture",
        "architecture_qa",
        (
            f"修复 app/api_{index}.py 与 app/store_{index}.py 的循环依赖，把共享 User 模型移到"
            f" app/models_{index}.py，保持 create_user 和 save_user API。新增 ARCHITECTURE.md "
            "说明依赖方向，并新增 tests/test_regression.py 验证模块可独立导入，运行全部 pytest。"
        ),
        f"""from app.store_{index} import save_user

class User:
    def __init__(self, name):
        self.name = name

def create_user(name):
    user = User(name)
    save_user(user)
    return user
""",
        f"""from app.api_{index} import create_user

def test_create_user():
    assert create_user("Ada").name == "Ada"
""",
        f"api_{index}",
        "",
    )


BUILDERS: tuple[Callable[[int], Scenario], ...] = (
    _pricing,
    _inventory,
    _slug,
    _retry,
    _state,
    _refactor,
    _architecture,
)

FAMILY_COUNTS = {
    "pricing": 8,
    "inventory": 7,
    "slug": 7,
    "retry": 7,
    "state": 7,
    "refactor": 7,
    "architecture": 7,
}


def _setup(scenario: Scenario, index: int, workspace: Path) -> None:
    _write(workspace, "pyproject.toml", "[tool.pytest.ini_options]\ntestpaths=['tests']\n")
    _write(workspace, "app/__init__.py", "")
    _write(workspace, f"app/{scenario.module}.py", scenario.source)
    if scenario.family == "state":
        _write(
            workspace,
            f"app/service_{index}.py",
            f"from app.state_{index} import transition\n\nclass OrderService:\n    def apply(self, state, event):\n        return transition(state, event)\n",
        )
    if scenario.family == "architecture":
        _write(
            workspace,
            f"app/store_{index}.py",
            f"from app.api_{index} import User\n\nSAVED = []\n\ndef save_user(user: User):\n    SAVED.append(user)\n",
        )
    _write(workspace, "tests/test_contract.py", scenario.tests)


def _verify(scenario: Scenario, workspace: Path) -> bool:
    source = workspace / f"app/{scenario.module}.py"
    regression = workspace / "tests/test_regression.py"
    if not source.is_file() or not regression.is_file():
        return False
    if (
        scenario.required_fragment
        and scenario.required_fragment not in source.read_text(encoding="utf-8")
    ):
        return False
    if scenario.family == "architecture" and not (
        workspace / "ARCHITECTURE.md"
    ).is_file():
        return False
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", "-q"],
        cwd=workspace,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    return completed.returncode == 0


def builtin_formal_tasks() -> list[EvalTask]:
    """Return 50 isolated, build-and-test programming tasks."""
    tasks: list[EvalTask] = []
    for builder in BUILDERS:
        family = builder(1).family
        for index in range(1, FAMILY_COUNTS[family] + 1):
            scenario = builder(index)
            task_id = f"formal-{scenario.family}-{index:02d}"
            tasks.append(
                EvalTask(
                    task_id=task_id,
                    category=scenario.category,
                    prompt=scenario.prompt,
                    setup=lambda workspace, s=scenario, i=index: _setup(
                        s, i, workspace
                    ),
                    verify=lambda workspace, s=scenario: _verify(s, workspace),
                    expected_files=[
                        f"app/{scenario.module}.py",
                        "tests/test_regression.py",
                    ],
                    timeout_steps=30,
                )
            )
    return tasks
