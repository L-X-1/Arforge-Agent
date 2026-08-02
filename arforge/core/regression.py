"""v1-G11：回归保护——改动文件 → 定位关联测试 → 只跑这批。

补强 G10 交付门禁：不只静态语法校验，还真跑受影响的 pytest 测试，指出本次改动
是否回归。定位策略（Python/pytest）：改 test_*.py 跑自身；改 foo.py 找
test_foo.py（同目录 / tests/ / 工作区根）。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

_PASS_RE = re.compile(r"(\d+) passed")
_FAIL_RE = re.compile(r"(\d+) failed")


def locate_impacted_tests(changed_files, workspace) -> list[str]:
    """对改动文件定位关联 pytest 测试（存在的绝对路径，去重保序）。"""
    ws = Path(workspace)
    found: list[str] = []

    def _add(p: Path) -> None:
        s = str(p)
        if p.is_file() and s not in found:
            found.append(s)

    for f in changed_files or []:
        pf = Path(f)
        name = pf.name
        if not name.endswith(".py"):
            continue
        if name.startswith("test_"):
            _add(ws / f)  # 改的就是测试 → 跑自身
            continue
        stem = pf.stem
        for cand in (
            ws / pf.parent / f"test_{stem}.py",
            ws / "tests" / f"test_{stem}.py",
            ws / f"test_{stem}.py",
        ):
            _add(cand)
    return found


def run_pytest(test_files, workspace, timeout: int = 120) -> dict:
    """子进程跑 pytest，返回 {ran, passed, failed, returncode, summary}。"""
    if not test_files:
        return {"ran": False, "passed": 0, "failed": 0, "returncode": 0, "summary": "无关联测试"}
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", *test_files],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ran": True, "passed": 0, "failed": 0, "returncode": -1, "summary": f"测试超时（>{timeout}s）"}
    except OSError as exc:
        return {"ran": True, "passed": 0, "failed": 0, "returncode": -1, "summary": f"测试运行出错：{exc}"}
    out = (proc.stdout or "") + (proc.stderr or "")
    pm = _PASS_RE.search(out)
    fm = _FAIL_RE.search(out)
    passed = int(pm.group(1)) if pm else 0
    failed = int(fm.group(1)) if fm else 0
    lines = [ln for ln in out.strip().splitlines() if ln.strip()]
    summary = lines[-1] if lines else "（无输出）"
    return {"ran": True, "passed": passed, "failed": failed, "returncode": proc.returncode, "summary": summary}
