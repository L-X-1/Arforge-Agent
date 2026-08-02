"""P1 2.1: Built-in eval tasks.

All fixtures are created as real files in a temp workspace.  Verification
checks file contents, existence, test output, or structural properties.
No external dependencies beyond Python stdlib.
"""

from __future__ import annotations

from dataclasses import replace
import ast
from pathlib import Path

from arforge.eval.runner import EvalTask


def _write(workspace: Path, path: str, content: str) -> None:
    full = workspace / path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def _file_contains(workspace: Path, path: str, fragment: str) -> bool:
    try:
        return fragment in (workspace / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False


def _file_exists(workspace: Path, path: str) -> bool:
    return (workspace / path).is_file()


def _read_file(workspace: Path, path: str) -> str:
    return (workspace / path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Category 1: Bug fix
# ---------------------------------------------------------------------------

def _setup_bug_typo(workspace: Path) -> None:
    _write(workspace, "calc.py", "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    retrun a - b  # bug: typo\n")

def _verify_bug_typo(workspace: Path) -> bool:
    if not _file_exists(workspace, "calc.py"):
        return False
    content = _read_file(workspace, "calc.py")
    return "retrun" not in content and "def sub" in content


def _setup_bug_reversed_logic(workspace: Path) -> None:
    _write(workspace, "utils.py", 'def is_valid_age(age):\n    return age < 0 and age < 120  # bug: negative ages are treated as valid\n')

def _verify_bug_reversed_logic(workspace: Path) -> bool:
    content = _read_file(workspace, "utils.py")
    return "age >= 0" in content or "age < 0" in content or "age <= 0" in content or "not age >" in content


# ---------------------------------------------------------------------------
# Category 2: Feature add
# ---------------------------------------------------------------------------

def _setup_feature_greet(workspace: Path) -> None:
    _write(workspace, "greet.py", 'def greet(name):\n    return f"Hello, {name}!"\n')

def _verify_feature_greet(workspace: Path) -> bool:
    try:
        content = _read_file(workspace, "greet.py")
        tree = ast.parse(content)
        greet = next(
            node for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "greet"
        )
        return bool(greet.args.defaults) and isinstance(greet.args.defaults[-1], ast.Constant) and greet.args.defaults[-1].value == "World"
    except (OSError, UnicodeDecodeError, SyntaxError, StopIteration):
        return False


def _setup_feature_average(workspace: Path) -> None:
    _write(workspace, "stats.py", "def mean(nums):\n    return sum(nums) / len(nums)\n")

def _verify_feature_average(workspace: Path) -> bool:
    content = _read_file(workspace, "stats.py")
    return "median" in content.lower()


# ---------------------------------------------------------------------------
# Category 3: Write tests
# ---------------------------------------------------------------------------

def _setup_write_test_calculator(workspace: Path) -> None:
    _write(workspace, "mathlib.py", "def multiply(a, b):\n    return a * b\n\ndef divide(a, b):\n    if b == 0:\n        raise ValueError('cannot divide by zero')\n    return a / b\n")

def _verify_write_test_calculator(workspace: Path) -> bool:
    if not _file_exists(workspace, "test_mathlib.py"):
        return False
    c = _read_file(workspace, "test_mathlib.py")
    return "def test" in c and "multiply" in c and ("divide" in c or "ValueError" in c)


def _setup_write_test_utils(workspace: Path) -> None:
    _write(workspace, "helpers.py", "def flatten(items):\n    result = []\n    for item in items:\n        if isinstance(item, list):\n            result.extend(flatten(item))\n        else:\n            result.append(item)\n    return result\n")

def _verify_write_test_utils(workspace: Path) -> bool:
    if not _file_exists(workspace, "test_helpers.py"):
        return False
    c = _read_file(workspace, "test_helpers.py")
    return "def test" in c and "flatten" in c


# ---------------------------------------------------------------------------
# Category 4: Refactor
# ---------------------------------------------------------------------------

def _setup_refactor_split(workspace: Path) -> None:
    _write(workspace, "big_module.py", "import math\n\n\ndef circle_area(r): return math.pi * r * r\n\ndef rectangle_area(w, h): return w * h\n\ndef clamp(value, low, high): return max(low, min(high, value))\n\ndef is_valid_age(age): return age >= 0 and age <= 150\n")

def _verify_refactor_split(workspace: Path) -> bool:
    has_shapes = _file_exists(workspace, "shapes.py") or _file_exists(workspace, "geometry.py")
    shapes_file = "shapes.py" if _file_exists(workspace, "shapes.py") else "geometry.py"
    big = _read_file(workspace, "big_module.py")
    if has_shapes:
        shapes_content = _read_file(workspace, shapes_file)
        shapes_ok = "circle_area" in shapes_content or "rectangle_area" in shapes_content
        big_ok = "import" in big
        return shapes_ok and big_ok
    return False


# ---------------------------------------------------------------------------
# Category 5: Architecture QA
# ---------------------------------------------------------------------------

def _setup_architecture_qa(workspace: Path) -> None:
    _write(workspace, "README.md", "# My Project\n\nThis project does data processing and web serving.\n")
    _write(workspace, "models.py", "class User:\n    def __init__(self, name, email):\n        self.name = name\n        self.email = email\n")

def _verify_architecture_qa(workspace: Path) -> bool:
    return True


# ---------------------------------------------------------------------------
# Category 6: Data processing
# ---------------------------------------------------------------------------

def _setup_data_csv(workspace: Path) -> None:
    _write(workspace, "scores.csv", "name,score\nAlice,85\nBob,92\nCharlie,78\nDiana,88\n")

def _verify_data_csv(workspace: Path) -> bool:
    try:
        py_files = list(workspace.glob("*.py"))
        for pyf in py_files:
            content = pyf.read_text(encoding="utf-8")
            if "scores.csv" in content or "csv" in content.lower():
                if "mean" in content.lower() or "sum" in content.lower() or "average" in content.lower():
                    return True
        return False
    except (OSError, UnicodeDecodeError):
        return False


# ---------------------------------------------------------------------------
# Category 7: Multi-file change
# ---------------------------------------------------------------------------

def _setup_multi_constants(workspace: Path) -> None:
    _write(workspace, "constants.py", "VERSION = '1.0'\nDEBUG = True\n")
    _write(workspace, "app.py", "from constants import VERSION\n\nprint(f'App version {VERSION}')\n")
    _write(workspace, "worker.py", "from constants import DEBUG\n\nif DEBUG:\n    print('Debug mode')\n")

def _verify_multi_constants(workspace: Path) -> bool:
    const = _read_file(workspace, "constants.py")
    app = _read_file(workspace, "app.py")
    worker = _read_file(workspace, "worker.py")
    version_bumped = "'2.0'" in const or '"2.0"' in const
    app_ok = "import" in app and "VERSION" in app
    worker_ok = "import" in worker and "DEBUG" in worker
    return version_bumped and app_ok and worker_ok


# ---------------------------------------------------------------------------
# Test-compatible check tasks (for test_du4_eval.py)
# ---------------------------------------------------------------------------

def _make_setup_check(wspace: Path):
    """Build test-compatible tasks that need a workspace."""
    return [
        EvalTask("write_hello", "Write a file eval_hello.txt with content '... HELLO_ARFORGE ...'",
                 check=lambda: _file_contains(wspace, "eval_hello.txt", "HELLO_ARFORGE")),
        EvalTask("read_copy", "Read eval_src.txt and copy the token into eval_dest.txt",
                 check=lambda: _file_contains(wspace, "eval_dest.txt", "TOKEN_9988"),
                 setup=lambda wk=wspace: (_write(wk, "eval_src.txt", "TOKEN_9988"), _write(wk, "eval_dest.txt", "EMPTY"))),
        EvalTask("two_files", "Create two files: eval_a.txt and eval_b.txt with any content",
                 check=lambda: _file_exists(wspace, "eval_a.txt") and _file_exists(wspace, "eval_b.txt")),
        EvalTask("calc_to_file", "Write the result of 21 * 2 to eval_calc.txt",
                 check=lambda: _file_contains(wspace, "eval_calc.txt", "42")),
        EvalTask("sum_to_file", "Write the sum of integers 1 through 10 to eval_sum.txt",
                 check=lambda: _file_contains(wspace, "eval_sum.txt", "55")),
        EvalTask("json_file", "Create eval_conf.json containing the Arforge product name",
                 check=lambda: _file_contains(wspace, "eval_conf.json", "arforge")),
    ]


# ---------------------------------------------------------------------------
# Task registry
# ---------------------------------------------------------------------------

_AGENTIC_TASKS: list[EvalTask] = [
    EvalTask(task_id="bug-typo", category="bug_fix",
             prompt="Fix the bug in calc.py. There is a typo in the 'sub' function that prevents it from running.",
             setup=_setup_bug_typo,
             verify=_verify_bug_typo, expected_files=["calc.py"], timeout_steps=10),
    EvalTask(task_id="bug-reversed", category="bug_fix",
             prompt="Fix the bug in utils.py. The is_valid_age function should reject negative ages.",
             setup=_setup_bug_reversed_logic,
             verify=_verify_bug_reversed_logic, expected_files=["utils.py"], timeout_steps=10),
    EvalTask(task_id="feat-greet", category="feature_add",
             prompt="Add a default parameter to the greet function in greet.py so that calling greet() without arguments returns 'Hello, World!'.",
             setup=_setup_feature_greet,
             verify=_verify_feature_greet, expected_files=["greet.py"], timeout_steps=15),
    EvalTask(task_id="feat-median", category="feature_add",
             prompt="Add a median(nums) function to stats.py that computes the median of a list of numbers.",
             setup=_setup_feature_average,
             verify=_verify_feature_average, expected_files=["stats.py"], timeout_steps=15),
    EvalTask(task_id="test-calc", category="test_write",
             prompt="Write unit tests in test_mathlib.py for the multiply and divide functions in mathlib.py. Use pytest style.",
             setup=_setup_write_test_calculator,
             verify=_verify_write_test_calculator, expected_files=["test_mathlib.py"], timeout_steps=15),
    EvalTask(task_id="test-helpers", category="test_write",
             prompt="Write tests in test_helpers.py for the flatten function in helpers.py. Test with nested lists and empty input.",
             setup=_setup_write_test_utils,
             verify=_verify_write_test_utils, expected_files=["test_helpers.py"], timeout_steps=15),
    EvalTask(task_id="refactor-split", category="refactor",
             prompt="Split big_module.py: move geometry functions (circle_area, rectangle_area) into a new shapes.py file and update big_module.py to import from it.",
             setup=_setup_refactor_split,
             verify=_verify_refactor_split, expected_files=["big_module.py", "shapes.py"], timeout_steps=40),
    EvalTask(task_id="arch-qa", category="architecture_qa",
             prompt="Review the project in this workspace. What modules exist? What is the architecture? Report your findings.",
             setup=_setup_architecture_qa,
             verify=_verify_architecture_qa, timeout_steps=10),
    EvalTask(task_id="data-csv", category="data_processing",
             prompt="Read scores.csv and write a Python script that calculates and prints the average score.",
             setup=_setup_data_csv,
             verify=_verify_data_csv, expected_files=["scores.csv"], timeout_steps=15),
    EvalTask(task_id="multi-const", category="multi_file",
             prompt="Bump the VERSION constant in constants.py from 1.0 to 2.0. Make sure app.py and worker.py still import correctly.",
             setup=_setup_multi_constants,
             verify=_verify_multi_constants, expected_files=["constants.py", "app.py", "worker.py"], timeout_steps=15),
]


# Judge/code-test tasks (no file fixtures needed)
_JUDGE_TASKS: list[EvalTask] = [
    EvalTask(task_id="explain_recursion", prompt="Explain what recursion is in programming",
             judge="Correctly explains recursion as a function calling itself with a base case",
             category="architecture_qa"),
    EvalTask(task_id="fib_code", prompt="Write a Python function fib(n) that returns the nth Fibonacci number",
             code_test="assert fib(0) == 0\nassert fib(10) == 55\nprint('OK')",
             category="feature_add"),
    EvalTask(task_id="explain_hashmap", prompt="Explain how a hash map works internally",
             judge="Correctly describes hashing, buckets, and collision resolution",
             category="architecture_qa"),
    EvalTask(task_id="explain_test_isolation", prompt="Explain why tests should isolate external state",
             judge="Correctly explains determinism, independence, and avoiding shared external state",
             category="architecture_qa"),
    EvalTask(task_id="write_sort", prompt="Write a Python function sort_list(lst) that returns a sorted list",
             code_test="assert sort_list([3,1,2]) == [1,2,3]\nassert sort_list([]) == []\nprint('OK')",
             category="feature_add"),
    EvalTask(task_id="write_reverse", prompt="Write a Python function reverse_str(s) that reverses a string",
             code_test="assert reverse_str('abc') == 'cba'\nassert reverse_str('') == ''\nprint('OK')",
             category="feature_add"),
    EvalTask(task_id="write_is_palindrome", prompt="Write a Python function is_palindrome(s) that checks if a string is a palindrome",
             code_test="assert is_palindrome('racecar') == True\nassert is_palindrome('hello') == False\nprint('OK')",
             category="feature_add"),
    EvalTask(task_id="write_factorial", prompt="Write a Python function factorial(n) that returns n!",
             code_test="assert factorial(5) == 120\nassert factorial(0) == 1\nprint('OK')",
             category="feature_add"),
    EvalTask(task_id="write_gcd", prompt="Write a Python function gcd(a, b) using the Euclidean algorithm",
             code_test="assert gcd(48, 18) == 6\nassert gcd(7, 13) == 1\nprint('OK')",
             category="feature_add"),
]


def builtin_tasks(workspace: Path | None = None) -> list[EvalTask]:
    """Return the built-in eval task suite.

    Args:
        workspace: Optional workspace path. When provided, tasks that need
                   fixture files will have setup configured for that workspace.
    """
    # EvalTask is mutable, so repeated eval runs must not share setup bindings
    # or other caller mutations through the process-global task templates.
    tasks = [replace(task) for task in (*_AGENTIC_TASKS, *_JUDGE_TASKS)]

    if workspace is not None:
        # Keep the historical zero-argument setup contract when callers bind a
        # concrete workspace explicitly.
        for t in tasks:
            if t.setup is not None:
                fn = t.setup
                t.setup = lambda ws=workspace, f=fn: f(ws)

        # Add test-compatible check-based tasks
        tasks.extend(_make_setup_check(workspace))

    return tasks
