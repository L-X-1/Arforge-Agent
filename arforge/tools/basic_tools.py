"""Basic utility tools — calculator, time, command execution."""

from __future__ import annotations

import ast
import operator
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Mapping, Sequence

from arforge.memory import load_memories
from arforge.models.token_tracker import list_token_usage
from arforge.tool_registry import ParamSchema, adapt_command, adapt_first_arg, register_tool


_COMMAND_CANCEL_EVENT: ContextVar[threading.Event | None] = ContextVar(
    "arforge_command_cancel_event",
    default=None,
)
_FROZEN_SCRIPT_MODE = "--arforge-run-python-script"
_FROZEN_SCRIPT_TOKEN_ENV = "ARFORGE_INTERNAL_SCRIPT_TOKEN"
_FROZEN_SCRIPT_WORKSPACE_ENV = "ARFORGE_INTERNAL_SCRIPT_WORKSPACE"


@contextmanager
def command_cancellation_scope(cancel_event: threading.Event):
    """Bind a cooperative task-cancellation signal to command tools."""
    token = _COMMAND_CANCEL_EVENT.set(cancel_event)
    try:
        yield
    finally:
        _COMMAND_CANCEL_EVENT.reset(token)


def current_command_cancellation_event() -> threading.Event | None:
    """Return the operation cancellation signal visible to command-like tools."""
    return _COMMAND_CANCEL_EVENT.get()


def _python_script_command(
    executable: str,
    script_path: Path,
    process_env: dict[str, str],
    workspace: Path,
) -> list[str]:
    """Build a Python invocation that also works inside the frozen Sidecar."""
    if not getattr(sys, "frozen", False):
        return [str(executable), str(script_path)]
    token = secrets.token_urlsafe(32)
    process_env[_FROZEN_SCRIPT_TOKEN_ENV] = token
    process_env[_FROZEN_SCRIPT_WORKSPACE_ENV] = str(workspace.resolve())
    return [str(executable), _FROZEN_SCRIPT_MODE, token, str(script_path)]


# ---------------------------------------------------------------------------
# Safe calculator (AST whitelist — no eval)
# ---------------------------------------------------------------------------

OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
}


def safe_calculate(expression: str) -> int | float:
    def eval_node(node):
        if isinstance(node, ast.Expression):
            return eval_node(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in OPS:
            return OPS[type(node.op)](eval_node(node.left), eval_node(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in OPS:
            return OPS[type(node.op)](eval_node(node.operand))
        raise ValueError("unsupported expression — only arithmetic allowed")

    return eval_node(ast.parse(expression, mode="eval"))


# ---------------------------------------------------------------------------
# Registered tools
# ---------------------------------------------------------------------------


@register_tool(
    "calculate",
    "Safely calculate an arithmetic expression (AST whitelist, no eval)",
    keywords=["calculate", "计算", "compute", "math"],
    params=[ParamSchema("expression", "string", "arithmetic expression e.g. 2+3*4")],
    input_adapter=adapt_first_arg,
    source=__name__,
)
def calculate(expression: str) -> str:
    return str(safe_calculate(expression))


@register_tool(
    "time",
    "Show current date and time",
    keywords=["time", "时间", "date", "now", "几点"],
    params=[],
    source=__name__,
)
def get_current_time() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Command execution (whitelisted binaries, no shell, safe pipelining)
# ---------------------------------------------------------------------------
#
# 安全模型（企业级）：
#   1. 永不使用 shell=True —— 杜绝 shell 元字符注入（`rm x; curl evil`、`$(...)`、反引号等）。
#   2. 仅允许白名单二进制；其余直接 126 拒绝。
#   3. 管道通过 Python 串接多个 subprocess（subprocess.Popen + stdout→stdin），
#      每一段仍走白名单 + 危险参数守卫；shell 的 `|` 只是解析提示，不会被交给系统 shell。
#   4. 危险参数守卫（DENY_ARG_PATTERNS）：对 rm/del/rmdir 的根删除、git 强推到保护分支、
#      --no-preserve-root、`> /dev/sd*` 等做硬拒绝。
#   5. 重定向/后台/逻辑连接符（> >> < & ; && ||）被显式拒绝 —— 这些只有 shell 能解释，
#      既然我们不进 shell，就必须拒绝，避免语义被悄悄丢弃或误解析。

# 白名单：开发/构建/只读查看常用二进制。危险破坏性命令（rm/del/format/mkfs/diskpart/
# reg/schtasks/shutdown）一律不列入；需要删除请走 file 工具（safe_delete 有备份+确认）。
ALLOWED_BINARIES = {
    # 解释器/运行时
    "python", "python3", "py", "node", "node.exe", "deno", "bun", "php", "php.exe",
    # 包管理
    "npm", "npx", "pnpm", "yarn", "pip", "pip3", "uv", "poetry", "pipx",
    # 编译器 / 语言工具链（只允许直接进程执行；shell 元字符和危险参数仍由下层守卫拦截）
    "cargo", "go",
    "java", "java.exe", "javac", "javac.exe",
    "dotnet", "dotnet.exe", "csc", "csc.exe",
    "gcc", "gcc.exe", "g++", "g++.exe",
    "clang", "clang.exe", "clang++", "clang++.exe",
    "ruby", "ruby.exe", "sqlite3", "sqlite3.exe",
    "kotlinc", "kotlinc.exe", "swift", "swiftc",
    # 版本控制（只读 + 常规写操作；强推由 DENY_ARG_PATTERNS 守卫）
    "git", "gh", "gh.exe",
    # 构建工具
    "make", "cmake", "ctest", "ninja", "msbuild",
    "gradle", "mvn", "tsc", "eslint", "prettier",
    "ruff", "black", "mypy", "pylint", "flake8",
    # 测试
    "pytest", "jest", "vitest", "playwright",
    # 只读查看/导航（跨平台）
    "ls", "dir", "find", "grep", "rg", "rg.exe", "cat", "head", "tail", "wc", "sort", "uniq", "tr", "cut",
    "tree", "where", "where.exe", "which", "echo", "type", "Get-ChildItem",
    # 目录/文件元信息（不删除）
    "mkdir", "touch", "test", "stat", "file", "basename", "dirname", "pwd",
}

# 平台特例：Windows 下 find/grep/cat/ls 等通常不存在，避免误放行；但用户若装了 Git Bash /
# WSL 工具链则可用。白名单按名称放行，运行时由 PATH 解析；找不到会得到正常的 127 错误。

# 危险参数守卫：对 (binary, 全命令文本) 做正则黑名单匹配，命中即拒绝。
# 这些模式无论在命令哪一段出现都会被拦截，防止 `git push --force origin main` 或
# `rm -rf /` 这类不可逆操作。
DENY_ARG_PATTERNS = [
    (r"(^|\s)--no-preserve-root(\s|$)", "refusing --no-preserve-root (would delete root)"),
    (r"(^|\s)rm\b.*\s-rf?\s*/(\s|$)", "refusing recursive delete of root"),
    (r"(^|\s)rmdir\b.*\s/s\b.*\s/[a-z]:?(\\|/|$)", "refusing recursive rmdir of drive root (Windows)"),
    (r"(^|\s)del\b.*\s/[sqs]+\s*/(\s|$)", "refusing recursive del of root (Windows)"),
    (r"\bgit\s+push\b.*(--force|-f\b)(\s|$)", "refusing force-push (use a feature branch instead)"),
    (r"\bgit\s+push\b.*origin\s+(main|master|trunk|release)(\s|$)", "refusing push to a protected branch"),
    (r"(^|\s)(format|mkfs|diskpart|reg|regedit|schtasks|shutdown|halt|reboot|poweroff)(\s|$)", "destructive system binary blocked"),
    (r"(>|\s)(/dev/s[d-z]+|\\\\\.\\)([a-z]:)?", "refusing write to a raw device"),
]

# shell 专属元字符：我们不进 shell，所以必须显式拒绝，而不是静默忽略或误传。
# `|` 被单独抽出用于安全管道解析，因此不在此集合中。
SHELL_METACHAR_REJECT = re.compile(r"(?:>>|>|<|;|&&|\|\||&|^~|\$\(|`)")


class CommandSyntaxError(ValueError):
    pass


def _normalize_binary(name: str) -> str:
    """Lowercased, basename binary name for whitelist lookup (e.g. 'python.exe' → 'python.exe')."""
    base = os.path.basename(name).lower()
    # Windows: strip a trailing .exe only for the python family where both forms are common.
    return base


def _is_workspace_executable(name: str) -> bool:
    """Allow a compiled artifact only when it exists inside the active workspace.

    A universal code agent must be able to run the C/C++/Rust binary it just
    built. This is intentionally narrower than adding arbitrary executable
    names to the global whitelist: absolute paths outside the workspace,
    scripts interpreted by a shell, and nonexistent guessed binaries remain
    blocked.
    """
    try:
        from arforge.tools.file_tools import get_workspace

        workspace = get_workspace().resolve()
        candidate = Path(name)
        resolved = (
            candidate.resolve()
            if candidate.is_absolute()
            else (workspace / candidate).resolve()
        )
        if os.name == "nt" and not resolved.is_file() and not resolved.suffix:
            for suffix in (".exe", ".com"):
                executable = resolved.with_suffix(suffix)
                if executable.is_file():
                    resolved = executable
                    break
        resolved.relative_to(workspace)
    except (ImportError, OSError, RuntimeError, ValueError):
        return False
    if not resolved.is_file():
        return False
    if os.name == "nt":
        return resolved.suffix.casefold() in {".exe", ".com"}
    return os.access(resolved, os.X_OK)


def _split_command_args(command: str) -> list[str]:
    """Split command text for no-shell execution.

    On Windows, ``shlex.split(..., posix=False)`` preserves surrounding quotes.
    Passing those quotes through to ``python -c "code"`` makes Python execute a
    string literal and exit 0, which can create false-positive dependency checks.
    Strip only balanced outer quotes from each argv item while preserving normal
    Windows backslash path semantics.
    """
    args = shlex.split(command, posix=os.name != "nt")
    if os.name == "nt":
        cleaned: list[str] = []
        for arg in args:
            if len(arg) >= 2 and arg[0] == arg[-1] and arg[0] in {"'", '"'}:
                cleaned.append(arg[1:-1])
            else:
                cleaned.append(arg)
        return cleaned
    return args


def _resolve_command_args(
    args: list[str],
    *,
    platform: str | None = None,
) -> list[str]:
    """Resolve safe Windows Node package-manager shims without a shell.

    ``npm`` and ``npx`` are ``.cmd`` wrappers on Windows.  ``CreateProcess``
    cannot execute those wrappers directly, and invoking ``cmd.exe`` would
    break this module's no-shell security boundary.  Resolve their trusted JS
    entry points and launch them through ``node.exe`` instead.

    ``platform`` exists for deterministic cross-platform tests; production
    callers always use the current operating system.
    """
    if not args or (platform or os.name) != "nt":
        return args
    binary = _normalize_binary(args[0])
    cli_names = {"npm": "npm-cli.js", "npx": "npx-cli.js"}
    cli_name = cli_names.get(binary)
    if cli_name is None:
        return args

    node_executable = shutil.which("node.exe") or shutil.which("node")
    shim = shutil.which(f"{binary}.cmd") or shutil.which(binary)
    if not node_executable or not shim:
        return args

    roots = (Path(shim).resolve().parent, Path(node_executable).resolve().parent)
    for root in roots:
        cli_path = root / "node_modules" / "npm" / "bin" / cli_name
        if cli_path.is_file():
            return [node_executable, str(cli_path), *args[1:]]
    return args


def _resolve_workspace_executable_args(
    args: list[str],
    *,
    cwd: str | Path | None,
) -> list[str]:
    """Resolve a validated Windows workspace executable before CreateProcess.

    On Windows, ``subprocess.Popen(..., cwd=workspace)`` does not reliably use
    that child working directory when resolving ``.\\program.exe``. The
    permission guard already restricts ad-hoc executables to the active
    workspace; resolve that same candidate to an absolute path so the command
    that passed the guard is also the command that is executed.
    """
    if os.name != "nt" or not args or Path(args[0]).is_absolute():
        return args
    try:
        from arforge.tools.file_tools import get_workspace

        workspace = get_workspace().resolve()
        base = Path(cwd).resolve() if cwd is not None else workspace
        resolved = (base / args[0]).resolve()
        if not resolved.is_file() and not resolved.suffix:
            for suffix in (".exe", ".com"):
                candidate = resolved.with_suffix(suffix)
                if candidate.is_file():
                    resolved = candidate
                    break
        resolved.relative_to(workspace)
    except (ImportError, OSError, RuntimeError, ValueError):
        return args
    if not resolved.is_file() or resolved.suffix.casefold() not in {".exe", ".com"}:
        return args
    return [str(resolved), *args[1:]]


def check_cmd_permission(command: str) -> dict:
    """Permission check on the FIRST binary of a single command segment.

    Returns {"allowed": bool, "reason": str}. Used both for direct commands and for
    each segment of a pipeline. Does NOT evaluate the full arg list — that is the job
    of the dangerous-arg guard in _validate_segment.
    """
    tokens = _split_command_args(str(command)) if command.strip() else []
    if not tokens:
        return {"allowed": False, "reason": "empty command"}
    first = _normalize_binary(tokens[0])
    if first not in ALLOWED_BINARIES and not _is_workspace_executable(tokens[0]):
        return {"allowed": False, "reason": f"'{tokens[0]}' is not in the allowed command list"}
    return {"allowed": True, "reason": "ok"}


def _has_unquoted_shell_metacharacters(segment: str) -> bool:
    """Return whether shell-only syntax occurs outside a quoted argument.

    ``run_cmd`` never invokes a shell, so characters inside an argument such as
    ``node -e "a(); b()"`` are ordinary program input, not command chaining.
    The previous raw-regex scan rejected these safe calls and produced frequent
    false tool failures.  Unquoted redirection/chaining/substitution remains
    rejected because silently passing it as argv would violate user intent.
    """
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(segment):
        char = segment[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if char == "\\" and quote is not None:
            escaped = True
            index += 1
            continue
        if quote is not None:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"'):
            quote = char
            index += 1
            continue
        if char in "><;&`":
            return True
        if char == "$" and index + 1 < len(segment) and segment[index + 1] == "(":
            return True
        if char == "|" and index + 1 < len(segment) and segment[index + 1] == "|":
            return True
        index += 1
    return False


def _validate_segment(segment: str) -> tuple[bool, str]:
    """Validate a single (non-piped) command segment: whitelist + dangerous-arg guard.

    Returns (ok, reason). reason is empty when ok.
    """
    segment = segment.strip()
    if not segment:
        return False, "empty command segment in pipeline"
    perm = check_cmd_permission(segment)
    if not perm["allowed"]:
        return False, perm["reason"]
    # Dangerous-arg guard: scan the whole segment text (robust against tokenization edge cases).
    for pattern, reason in DENY_ARG_PATTERNS:
        if re.search(pattern, segment, flags=re.IGNORECASE):
            return False, reason
    # Reject shell metacharacters we cannot honour without a real shell.
    if _has_unquoted_shell_metacharacters(segment):
        return False, (
            "shell metacharacters (>, <, ;, &&, ||, &, $(), backtick) are not supported; "
            "use the file tools or a separate run_cmd instead"
        )
    return True, ""


def _split_pipeline(command: str) -> list[str]:
    """Split a command on top-level '|' into segments, ignoring '|' inside quotes.

    We do NOT use a real shell, so this parser only needs to handle quoted pipes —
    not subshells, escapes beyond shlex's handling, or brace expansion (all of which
    would be rejected by the metachar guard anyway).
    """
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    prev = ""
    for ch in command:
        if quote:
            current.append(ch)
            if ch == quote and prev != "\\":
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            current.append(ch)
        elif ch == "|":
            # '||' is a shell logical-or and must have been rejected already; a lone '|' is a pipe.
            if prev == "|":
                current.append(ch)  # defensive; SHELL_METACHAR_REJECT catches '||'
            else:
                segments.append("".join(current))
                current = []
        else:
            current.append(ch)
        prev = ch
    segments.append("".join(current))
    return [s for s in (seg.strip() for seg in segments) if s]


def run_command_no_shell(
    command: str | Sequence[str],
    *,
    timeout: int | None = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    encoding: str = "utf-8",
):
    """Run a whitelisted command (or a safe pipeline of them) without a shell.

    Supports a single-level pipeline `a | b | c` by spawning one process per segment
    and chaining stdout→stdin. Each segment is independently whitelisted and
    danger-checked. No shell is ever invoked, so shell injection is structurally
    impossible.
    """
    # Normalize: a pre-split argv is always a single (non-piped) command.
    if isinstance(command, (list, tuple)) and not isinstance(command, str):
        command = " ".join(shlex.quote(str(a)) for a in command)
    command = str(command).strip()
    if not command:
        raise CommandSyntaxError("empty command")

    segments = _split_pipeline(command)
    # Validate every segment up front so a dangerous later stage never runs.
    for seg in segments:
        ok, reason = _validate_segment(seg)
        if not ok:
            return {"success": False, "stdout": "", "stderr": reason, "returncode": 126}

    # Single command (the common case) — keep the simple, fast path.
    if len(segments) == 1:
        return _run_single(segments[0], timeout=timeout, cwd=cwd, env=env, encoding=encoding)

    # Pipeline: chain processes. Use a fixed total timeout spread across stages.
    return _run_pipeline(segments, total_timeout=timeout, cwd=cwd, env=env, encoding=encoding)


def _run_single(segment: str, *, timeout: int, cwd, env, encoding: str):
    args = _resolve_command_args(_split_command_args(segment))
    args = _resolve_workspace_executable_args(args, cwd=cwd)
    # ``echo`` is a shell builtin on Windows. Implementing it directly keeps
    # the no-shell security boundary while providing identical CLI behaviour.
    if _normalize_binary(args[0]) == "echo":
        return {"success": True, "stdout": " ".join(args[1:]) + os.linesep, "stderr": "", "returncode": 0}
    try:
        process = subprocess.Popen(
            args,
            cwd=cwd,
            env=env,
            # Desktop Bridge requests arrive over a long-lived stdin pipe. A
            # child command must never inherit that protocol stream: runtimes
            # such as Python can otherwise enter interactive mode after the
            # requested script and wait forever for the next Bridge request.
            stdin=subprocess.DEVNULL,
            text=True,
            encoding=encoding,
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        return {"success": False, "stdout": "", "stderr": f"command not found: {args[0]}", "returncode": 127}
    cancel_event = _COMMAND_CANCEL_EVENT.get()
    watcher_stop = threading.Event()
    cancelled = threading.Event()

    def watch_for_cancel() -> None:
        if cancel_event is None:
            return
        while not watcher_stop.wait(0.03):
            if cancel_event.is_set():
                cancelled.set()
                try:
                    process.kill()
                except OSError:
                    pass
                return

    watcher = threading.Thread(target=watch_for_cancel, name="arforge-command-cancel", daemon=True)
    watcher.start()
    try:
        stdout, stderr = process.communicate(
            timeout=timeout if timeout is not None and timeout > 0 else None
        )
    except subprocess.TimeoutExpired as exc:
        process.kill()
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(exc.cmd, exc.timeout, output=stdout, stderr=stderr) from None
    finally:
        watcher_stop.set()
        watcher.join(timeout=0.1)
    if cancelled.is_set():
        return {
            "success": False,
            "stdout": stdout,
            "stderr": "command cancelled by user",
            "returncode": 130,
        }
    return {
        "success": process.returncode == 0,
        "stdout": stdout,
        "stderr": stderr,
        "returncode": process.returncode,
    }


def _run_pipeline(segments: list[str], *, total_timeout: int | None, cwd, env, encoding: str):
    """Chain whitelisted commands a | b | c without a shell."""
    procs: list[subprocess.Popen] = []
    stderr_chunks: list[list[str]] = []
    stderr_readers: list[threading.Thread] = []
    output_chunks: list[str] = []
    output_reader: threading.Thread | None = None
    prev_stdout = None
    deadline = (
        time.monotonic() + total_timeout
        if total_timeout is not None and total_timeout > 0
        else None
    )
    cancel_event = _COMMAND_CANCEL_EVENT.get()

    def drain(stream, chunks: list[str]) -> None:
        try:
            data = stream.read()
            if data:
                chunks.append(data)
        except (OSError, ValueError):
            pass

    def stop_all() -> None:
        # Stop every stage: leaving an upstream producer alive after cancelling
        # the final consumer would keep a desktop task running invisibly.
        for proc in reversed(procs):
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass

    try:
        for i, seg in enumerate(segments):
            if cancel_event is not None and cancel_event.is_set():
                stop_all()
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": "pipeline cancelled by user",
                    "returncode": 130,
                }
            args = _resolve_command_args(_split_command_args(seg))
            last = i == len(segments) - 1
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {"success": False, "stdout": "", "stderr": "pipeline timeout", "returncode": 124}
            proc = subprocess.Popen(
                args,
                cwd=cwd,
                env=env,
                # The first stage is non-interactive too. Later stages receive
                # only the previous stage's stdout, never the Bridge protocol.
                stdin=prev_stdout if prev_stdout is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE if not last else subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding=encoding,
                errors="replace",
            )
            if prev_stdout is not None:
                prev_stdout.close()  # let the upstream producer receive SIGPIPE on exit
            prev_stdout = proc.stdout
            procs.append(proc)

            chunks: list[str] = []
            stderr_chunks.append(chunks)
            if proc.stderr is not None:
                reader = threading.Thread(
                    target=drain,
                    args=(proc.stderr, chunks),
                    name=f"arforge-pipeline-stderr-{i}",
                    daemon=True,
                )
                reader.start()
                stderr_readers.append(reader)

        # Drain the final output concurrently and poll all stages. This avoids
        # pipe-buffer deadlocks while still making cancellation and the total
        # pipeline deadline apply immediately to every process.
        if procs[-1].stdout is not None:
            output_reader = threading.Thread(
                target=drain,
                args=(procs[-1].stdout, output_chunks),
                name="arforge-pipeline-stdout",
                daemon=True,
            )
            output_reader.start()

        cancelled = False
        timed_out = False
        while any(proc.poll() is None for proc in procs):
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                stop_all()
                break
            if deadline is not None and time.monotonic() >= deadline:
                timed_out = True
                stop_all()
                break
            time.sleep(0.03)

        return_codes = []
        for proc in procs:
            try:
                return_codes.append(proc.wait(timeout=1))
            except subprocess.TimeoutExpired:
                proc.kill()
                return_codes.append(proc.wait(timeout=1))

        if output_reader is not None:
            output_reader.join(timeout=1)
        for reader in stderr_readers:
            reader.join(timeout=1)

        out = "".join(output_chunks)
        stderr_parts = []
        for proc, chunks in zip(procs, stderr_chunks):
            err = "".join(chunks).strip()
            if err:
                stderr_parts.append(f"[{proc.args[0]}] {err}")
        if cancelled:
            stderr_parts.append("pipeline cancelled by user")
            returncode = 130
        elif timed_out:
            stderr_parts.append("pipeline timeout")
            returncode = 124
        else:
            returncode = return_codes[-1]
        # A pipeline succeeds only if every stage succeeded.
        success = not cancelled and not timed_out and all(rc == 0 for rc in return_codes)
        return {
            "success": success,
            "stdout": out,
            "stderr": "\n".join(stderr_parts) if stderr_parts else ("" if success else f"pipeline failed (exit codes: {return_codes})"),
            "returncode": returncode,
        }
    except FileNotFoundError as exc:
        return {"success": False, "stdout": "", "stderr": f"command not found: {exc.filename}", "returncode": 127}
    finally:
        stop_all()
        for p in procs:
            for stream in (p.stdin, p.stdout, p.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass


@register_tool(
    "run_cmd",
    "Run a whitelisted command (no shell, no pipes) in the workspace directory. "
    "Commands run from the workspace root, so relative paths resolve against the same "
    "directory that read_file/write_file/edit_file operate in — you can write a file "
    "and then run it in the same task. The default allows package installs, builds, and "
    "test suites to finish; use run_background_cmd for servers and other persistent work.",
    keywords=["run", "cmd", "exec", "运行", "执行"],
    params=[
        ParamSchema("command", "string", "whitelisted command to run"),
        ParamSchema(
            "timeout_seconds",
            "int",
            "optional runtime limit in seconds; 0 means no timeout",
            required=False,
            default=0,
        ),
    ],
    input_adapter=adapt_command,
    risk="medium",
    requires_confirmation=True,
    timeout=0,
    category="workspace_cmd",
    source=__name__,
)
def run_cmd(command: str, timeout_seconds: int = 0) -> str:
    # CRITICAL: commands must run in WORKSPACE (where read_file/write_file resolve),
    # otherwise the agent writes a file then cannot run it by relative path.
    # Previously cwd defaulted to the process dir, so `python hello.py` failed with
    # "can't open file 'E:\\Arforge-Agent\\hello.py'" even though hello.py was written
    # into the workspace sandbox. Resolve cwd to the workspace root explicitly.
    from arforge.tools.file_tools import get_workspace

    if isinstance(timeout_seconds, bool):
        raise ValueError("timeout_seconds must be a non-negative integer")
    try:
        requested_timeout = int(timeout_seconds)
    except (TypeError, ValueError):
        raise ValueError("timeout_seconds must be a non-negative integer") from None
    if requested_timeout < 0:
        raise ValueError("timeout_seconds must be a non-negative integer")
    result = run_command_no_shell(
        command,
        cwd=get_workspace(),
        timeout=requested_timeout or None,
    )
    if not result["success"]:
        detail = "\n".join(
            part
            for part in [
                result.get("stdout", "").strip(),
                result.get("stderr", "").strip(),
                f"command failed with exit code {result['returncode']}",
            ]
            if part
        )
        raise RuntimeError(detail)
    return result["stdout"] or result["stderr"]


_PYTHON_MUTATING_CALLS = frozenset(
    {
        "copy2",
        "copyfile",
        "copytree",
        "create_symlink",
        "makedirs",
        "mkdir",
        "removedirs",
        "renames",
        "rmdir",
        "rmtree",
        "symlink",
        "touch",
        "unlink",
        "write_bytes",
        "write_text",
    }
)
_PYTHON_MUTATING_DOTTED_CALLS = frozenset(
    {
        "os.chmod",
        "os.link",
        "os.remove",
        "os.rename",
        "os.replace",
        "os.unlink",
        "shutil.copy",
        "shutil.move",
    }
)
_PYTHON_DYNAMIC_CALLS = frozenset({"compile", "eval", "exec", "__import__"})
_JAVASCRIPT_MUTATION_RE = re.compile(
    r"(?:\bchild_process\b|\bDeno\s*\.\s*(?:write|remove|rename|mkdir)|"
    r"\bBun\s*\.\s*write|\b(?:writeFile|appendFile|unlink|rm|rmdir|rename|mkdir|"
    r"copyFile|chmod|symlink|link|createWriteStream)(?:Sync)?\s*\()",
    flags=re.IGNORECASE,
)
_DESTRUCTIVE_VALIDATION_RE = re.compile(
    r"(?:\btruncate\s+(?:table\s+)?|\bdrop\s+(?:table|database)\b|\bdelete\s+from\b|"
    r"['\"]?clear_week['\"]?\s*[:=]\s*['\"]?1\b|"
    r"\b(?:clear|reset)[_-]?(?:all|database|workspace)\b|"
    r"\bmethod\s*=\s*['\"]DELETE['\"])",
    flags=re.IGNORECASE,
)


def _dotted_call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def _constant_file_mode(call: ast.Call) -> str | None:
    mode_node: ast.AST | None = call.args[1] if len(call.args) > 1 else None
    for keyword in call.keywords:
        if keyword.arg == "mode":
            mode_node = keyword.value
            break
    if mode_node is None:
        return "r"
    if isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str):
        return mode_node.value
    return None


def _validate_read_only_python(code: str) -> None:
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        return  # The runtime will report the ordinary syntax failure.

    denied_imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".", 1)[0] == "subprocess":
                    denied_imports.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".", 1)[0] == "subprocess":
            denied_imports.update(alias.asname or alias.name for alias in node.names)

    if denied_imports:
        raise PermissionError(
            "run_script is read-only and cannot spawn subprocesses; use run_cmd or a dedicated validation tool"
        )

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _dotted_call_name(node.func)
        leaf = name.rsplit(".", 1)[-1]
        if leaf in _PYTHON_DYNAMIC_CALLS:
            raise PermissionError(f"run_script blocks dynamic execution via {leaf}()")
        if leaf in _PYTHON_MUTATING_CALLS or name in _PYTHON_MUTATING_DOTTED_CALLS:
            raise PermissionError(
                f"run_script is read-only and cannot call {leaf}(); use the dedicated file tools"
            )
        if leaf == "open":
            mode = _constant_file_mode(node)
            if mode is None or any(flag in mode for flag in "wax+"):
                raise PermissionError(
                    "run_script is read-only and cannot open files in a writable or dynamic mode"
                )


def _validate_read_only_script(language: str, code: str) -> None:
    if _DESTRUCTIVE_VALIDATION_RE.search(code):
        raise PermissionError(
            "run_script blocks destructive persistent-data validation; use a dry-run/preview path "
            "or an isolated fixture database with explicit backup and rollback"
        )
    if language in {"python", "py"}:
        _validate_read_only_python(code)
        return
    if _JAVASCRIPT_MUTATION_RE.search(code):
        raise PermissionError(
            "run_script is read-only and cannot mutate files or spawn child processes; "
            "use the dedicated file tools or run_cmd"
        )


@register_tool(
    "run_script",
    "Run read-only disposable Python or JavaScript validation code from an operating-system "
    "temporary file, with the workspace as its current directory. File creation, modification, "
    "deletion, subprocess spawning, and dynamic code execution are rejected; use the dedicated "
    "file tools or run_cmd for those operations. Bulk clear/reset/delete operations against "
    "persistent application data are also rejected: use an isolated fixture database or a "
    "dry-run/preview path. The temporary file is always removed.",
    keywords=["run script", "inline python", "inline javascript", "temporary validation"],
    params=[
        ParamSchema("language", "string", "python or javascript"),
        ParamSchema("code", "string", "complete disposable script source"),
        ParamSchema(
            "timeout_seconds",
            "int",
            "optional runtime limit in seconds; 0 disables the limit",
            required=False,
            default=0,
        ),
    ],
    risk="medium",
    requires_confirmation=True,
    timeout=0,
    output_limit=16000,
    category="workspace_cmd",
    source=__name__,
)
def run_script(language: str, code: str, timeout_seconds: int = 0) -> str:
    """Execute disposable validation code without polluting the workspace."""
    normalized = str(language or "").strip().lower()
    if normalized in {"python", "py"}:
        executable = sys.executable
        suffix = ".py"
    elif normalized in {"javascript", "js", "node"}:
        executable = shutil.which("node.exe") or shutil.which("node")
        suffix = ".js"
        if executable is None:
            raise RuntimeError("Node.js is not installed or not available on PATH")
    else:
        raise ValueError("language must be 'python' or 'javascript'")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code must not be empty")
    _validate_read_only_script(normalized, code)
    try:
        bounded_timeout = int(timeout_seconds)
    except (TypeError, ValueError):
        raise ValueError("timeout_seconds must be a non-negative integer") from None
    if bounded_timeout < 0:
        raise ValueError("timeout_seconds must be a non-negative integer")

    from arforge.tools.file_tools import get_workspace

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=suffix,
            prefix="arforge-validation-",
            encoding="utf-8",
            delete=False,
        ) as handle:
            handle.write(code)
            temp_path = Path(handle.name)
        process_env = os.environ.copy()
        if normalized in {"python", "py"}:
            # A temporary Python script uses its OS temp directory as
            # sys.path[0].  cwd alone does not make workspace modules
            # importable, so expose the trusted workspace explicitly.
            workspace_path = str(get_workspace())
            existing_pythonpath = process_env.get("PYTHONPATH", "")
            process_env["PYTHONPATH"] = os.pathsep.join(
                part for part in (workspace_path, existing_pythonpath) if part
            )
        workspace = get_workspace()
        command = (
            _python_script_command(str(executable), temp_path, process_env, workspace)
            if normalized in {"python", "py"}
            else [str(executable), str(temp_path)]
        )
        process = subprocess.Popen(
            command,
            cwd=workspace,
            env=process_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        cancel_event = _COMMAND_CANCEL_EVENT.get()
        deadline = (
            time.monotonic() + bounded_timeout
            if bounded_timeout > 0
            else None
        )
        stdout = ""
        stderr = ""
        while True:
            if cancel_event is not None and cancel_event.is_set():
                process.kill()
                process.communicate()
                raise InterruptedError("script cancelled by user")
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                process.kill()
                stdout, stderr = process.communicate()
                raise subprocess.TimeoutExpired(
                    [str(executable), str(temp_path)],
                    bounded_timeout,
                    output=stdout,
                    stderr=stderr,
                )
            try:
                # communicate() drains both pipes while the child is still
                # running.  Polling for exit first deadlocks once either pipe
                # fills its small OS buffer (especially on Windows).
                stdout, stderr = process.communicate(
                    timeout=0.05 if remaining is None else min(0.05, remaining)
                )
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode != 0:
            detail = "\n".join(
                part
                for part in (
                    stdout.strip(),
                    stderr.strip(),
                    f"script failed with exit code {process.returncode}",
                )
                if part
            )
            raise RuntimeError(detail)
        return stdout or stderr or "script completed successfully with no output"
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@register_tool(
    "run_background_cmd",
    "Start a whitelisted no-shell command in the workspace and return a task id for later output reads.",
    params=[
        ParamSchema("command", "string", "whitelisted command to run in the background"),
        ParamSchema("timeout_seconds", "int", "optional runtime limit in seconds; 0 means no timeout", required=False, default=0),
    ],
    risk="medium",
    requires_confirmation=True,
    timeout=0,
    category="workspace_cmd",
    source=__name__,
)
def run_background_cmd(command: str, timeout_seconds: int = 0) -> str:
    """Start one validated background command in the active workspace."""
    from arforge.background_command_runtime import get_background_command_runtime
    from arforge.tools.file_tools import get_workspace

    record = get_background_command_runtime().start(
        command,
        workspace=get_workspace(),
        timeout_seconds=timeout_seconds,
    )
    return f"background task started: {record['task_id']}"


@register_tool(
    "get_background_output",
    "Read bounded output and status from a background command started in this process.",
    params=[
        ParamSchema("task_id", "string", "background task id"),
        ParamSchema("max_chars", "int", "maximum output characters, from 200 to 16000", required=False, default=8000),
    ],
    category="read",
    source=__name__,
)
def get_background_output(task_id: str, max_chars: int = 8000) -> str:
    """Return a bounded task output snapshot without exposing its original command."""
    from arforge.background_command_runtime import get_background_command_runtime

    snapshot = get_background_command_runtime().output(task_id, max_chars=max_chars)
    return (
        f"status: {snapshot['status']}\n"
        f"exit_code: {snapshot['exit_code']}\n"
        f"output:\n{snapshot['output']}"
    )


@register_tool(
    "cancel_background_cmd",
    "Request cancellation of a background command owned by the current agent process.",
    params=[ParamSchema("task_id", "string", "background task id")],
    risk="medium",
    requires_confirmation=True,
    category="workspace_cmd",
    source=__name__,
)
def cancel_background_cmd(task_id: str) -> str:
    """Request process-tree cancellation for one owned background command."""
    from arforge.background_command_runtime import get_background_command_runtime

    record = get_background_command_runtime().cancel(task_id)
    return f"background task {record['task_id']} status: {record['status']}"


@register_tool(
    "list_background_commands",
    "List bounded metadata for background commands owned by the current agent process.",
    params=[ParamSchema("limit", "int", "maximum number of tasks, from 1 to 200", required=False, default=50)],
    category="read",
    source=__name__,
)
def list_background_commands(limit: int = 50) -> str:
    """List process-local task state without persisting commands or output."""
    import json

    from arforge.background_command_runtime import get_background_command_runtime

    return json.dumps(get_background_command_runtime().list(limit=limit), ensure_ascii=False)


@register_tool(
    "compact_context",
    "Summarize older conversation history to free up the context window. Call this when the "
    "conversation is getting long and you want to keep going without losing the recent thread.",
    keywords=["compact context", "compress history", "压缩上下文"],
    params=[],
    category="read",
    source=__name__,
)
def compact_context() -> str:
    from arforge.core.compaction import request_force_compact

    request_force_compact()
    return "context will be compacted before the next model step"


# ---------------------------------------------------------------------------
# Info / debug helpers (not registered as tools — called by slash commands)
# ---------------------------------------------------------------------------


def show_memories() -> str:
    memories = load_memories()
    return "\n".join(memories) if memories else "No memories."


def query_knowledge(question: str = "") -> str:
    memories = load_memories()
    return "\n".join(memories) if memories else "No knowledge found."


def show_token_usage() -> str:
    rows = list_token_usage()
    return "\n".join(f"{row['model_name']}: {row['total_tokens']}" for row in rows) if rows else "No token usage."


def show_logs() -> str:
    from arforge.paths import data_path

    log = data_path("logs", "arforge.log")
    return log.read_text(encoding="utf-8")[-4000:] if log.exists() else "No logs."


def planner_create_tasks(goal: str) -> str:
    return f"Task planning skeleton captured: {goal}"


def executor_create_tasks_from_plan(plan_text: str) -> str:
    return f"Task plan captured: {plan_text}"
