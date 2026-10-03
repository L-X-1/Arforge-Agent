"""Compatibility launcher for the unified TypeScript Arforge CLI.

The Python package is still shipped for migration-time helpers and embedded
callers, but it must not expose a second user-facing CLI/runtime owner.  The
installed ``arforge`` console script, ``python -m arforge`` and migration-era
``python -m arforge.cli`` module entry all enter here and forward to
``packages/arforge/src/index.ts`` through the repository's Bun runtime.  The
legacy :mod:`arforge.cli` module remains importable for old Python integrations
and tests only; its executable module path is deliberately redirected here.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


_MIN_BUN_VERSION = (1, 3, 14)
_TS_ENTRY_RELATIVE = Path("packages") / "arforge" / "src" / "index.ts"
_BUN_DIR = Path(".tools") / "bun-1.3.14"


class UnifiedCliUnavailable(RuntimeError):
    """Raised when the canonical TypeScript CLI cannot be started."""


@dataclass(frozen=True)
class CliInvocationResult:
    """Captured result for Python embedders calling the canonical TS CLI.

    This is a transport result rather than a Python command result: the child
    process owns parsing, domain state, permissions and side-effects. Keeping
    the original argv and command gives a host enough evidence to log or
    compare a call without exposing a second parser or a shell boundary.
    """

    argv: tuple[str, ...]
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


def _source_root() -> Path:
    """Find the source workspace that owns the Python compatibility package."""

    package_root = Path(__file__).resolve().parent.parent
    candidates = [package_root, Path.cwd().resolve()]
    for candidate in candidates:
        if (candidate / _TS_ENTRY_RELATIVE).is_file():
            return candidate
    # Keep the diagnostic deterministic even when an installed wheel omits
    # the private TypeScript workspace.
    return package_root


def _resolve_entry(root: Path) -> Path:
    explicit = os.environ.get("ARFORGE_TS_CLI", "").strip()
    entry = Path(explicit).expanduser() if explicit else root / _TS_ENTRY_RELATIVE
    if not entry.is_absolute():
        entry = (Path.cwd() / entry).resolve()
    else:
        entry = entry.resolve()
    if not entry.is_file():
        raise UnifiedCliUnavailable(
            "统一 TypeScript CLI 入口不存在: "
            f"{entry}. 请设置 ARFORGE_TS_CLI，或在 Arforge 源码工作区运行。"
        )
    return entry


def _version_tuple(value: str) -> tuple[int, int, int] | None:
    match = re.search(r"(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)", value)
    if match is None:
        return None
    return tuple(int(part) for part in match.groups())


def _probe_bun(candidate: str) -> tuple[bool, str]:
    """Validate one Bun candidate without invoking a shell."""

    try:
        result = subprocess.run(
            [candidate, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
            check=False,
            shell=False,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"{candidate}: {exc}"

    version = _version_tuple(result.stdout or result.stderr or "")
    if result.returncode != 0 or version is None:
        detail = (result.stderr or result.stdout or "unknown version").strip()
        return False, f"{candidate}: {detail}"
    if version < _MIN_BUN_VERSION:
        return False, f"{candidate}: Bun {version[0]}.{version[1]}.{version[2]} is older than 1.3.14"
    return True, candidate


def _bun_candidates(root: Path) -> list[str]:
    explicit = os.environ.get("ARFORGE_BUN", "").strip()
    local = root / _BUN_DIR / ("bun.exe" if os.name == "nt" else "bun")
    candidates: list[str] = []
    if explicit:
        candidates.append(str(Path(explicit).expanduser()))
    candidates.append(str(local))
    discovered = shutil.which("bun")
    if discovered:
        candidates.append(discovered)

    # Preserve order while avoiding duplicate probes (for example when
    # ARFORGE_BUN already points at the pinned local runtime).
    return list(dict.fromkeys(candidates))


def resolve_unified_cli() -> tuple[str, Path]:
    """Resolve and validate ``(bun_executable, typescript_entry)``."""

    root = _source_root()
    entry = _resolve_entry(root)
    errors: list[str] = []
    for candidate in _bun_candidates(root):
        ok, detail = _probe_bun(candidate)
        if ok:
            return detail, entry
        errors.append(detail)

    searched = "; ".join(errors) if errors else "未找到 Bun 可执行文件"
    raise UnifiedCliUnavailable(
        "无法启动统一 TypeScript CLI：需要 Bun 1.3.14 或更高版本。"
        f" 已检查：{searched}。可设置 ARFORGE_BUN 指向 Bun。"
    )


def build_command(bun: str, entry: Path, argv: Sequence[str]) -> list[str]:
    """Build the argument-vector used for the canonical CLI process."""

    return [bun, "--conditions=browser", str(entry), *[str(item) for item in argv]]


def _child_environment(bun: str, overrides: Mapping[str, str] | None) -> dict[str, str]:
    """Build an explicit child environment without mutating the parent."""

    environment = os.environ.copy()
    if overrides is not None:
        environment.update({str(key): str(value) for key, value in overrides.items()})
    if Path(bun).is_absolute():
        environment["PATH"] = os.pathsep.join(
            [str(Path(bun).parent), environment.get("PATH", "")]
        ).rstrip(os.pathsep)
    return environment


def _text_output(value: object) -> str:
    """Normalize completed/timeout output across text and bytes subprocess APIs."""

    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def invoke(
    argv: Sequence[str] | None = None,
    *,
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    input_text: str | None = None,
    timeout: float | None = None,
) -> CliInvocationResult:
    """Invoke the canonical TypeScript CLI for an embedded Python host.

    Unlike :func:`run`, this adapter captures stdout/stderr and returns a
    structured result suitable for IDEs, test harnesses and service hosts.
    ``shell`` is always disabled, argv is preserved exactly, and a missing
    Bun/TS entry returns an explicit non-zero result instead of falling back
    to :mod:`arforge.cli`. ``input_text`` is optional; when omitted the child
    receives EOF so an embedded host cannot accidentally block on stdin.
    """

    arguments = tuple(str(item) for item in (sys.argv[1:] if argv is None else argv))
    try:
        bun, entry = resolve_unified_cli()
    except UnifiedCliUnavailable as exc:
        return CliInvocationResult(
            argv=arguments,
            command=(),
            returncode=1,
            stdout="",
            stderr=f"[Arforge] {exc}\n",
        )

    command = tuple(build_command(bun, entry, arguments))
    run_kwargs: dict[str, object] = {
        "cwd": str(cwd) if cwd is not None else os.getcwd(),
        "env": _child_environment(bun, env),
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "shell": False,
        "check": False,
    }
    if input_text is None:
        run_kwargs["stdin"] = subprocess.DEVNULL
    else:
        run_kwargs["input"] = input_text
    if timeout is not None:
        run_kwargs["timeout"] = timeout

    try:
        completed = subprocess.run(list(command), **run_kwargs)
    except subprocess.TimeoutExpired as exc:
        stdout = _text_output(exc.stdout)
        stderr = _text_output(exc.stderr)
        timeout_message = f"[Arforge] unified TypeScript CLI timed out after {timeout:g}s\n"
        return CliInvocationResult(
            argv=arguments,
            command=command,
            returncode=124,
            stdout=stdout,
            stderr=stderr + timeout_message,
            timed_out=True,
        )
    except OSError as exc:
        return CliInvocationResult(
            argv=arguments,
            command=command,
            returncode=1,
            stdout="",
            stderr=f"[Arforge] 无法启动统一 TypeScript CLI: {exc}\n",
        )

    return CliInvocationResult(
        argv=arguments,
        command=command,
        returncode=int(completed.returncode),
        stdout=_text_output(completed.stdout),
        stderr=_text_output(completed.stderr),
    )


def _forward_signals(process: subprocess.Popen[bytes | str]):
    """Install temporary parent handlers that forward termination to Bun."""

    previous: dict[int, object] = {}

    def forward(signum: int, _frame: object) -> None:
        if process.poll() is not None:
            return
        try:
            process.send_signal(signum)
        except (OSError, ValueError):
            # The child may have exited between poll() and send_signal().
            return

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, forward)
        except (OSError, RuntimeError, ValueError):
            # Non-main-thread embedders cannot install process handlers.  The
            # normal wait path remains safe and the child still owns its stdio.
            continue
    return previous


def _restore_signals(previous: dict[int, object]) -> None:
    for signum, handler in previous.items():
        try:
            signal.signal(signum, handler)  # type: ignore[arg-type]
        except (OSError, RuntimeError, ValueError):
            continue


def run(argv: Sequence[str] | None = None) -> int:
    """Run the TypeScript CLI and return its exit code."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        bun, entry = resolve_unified_cli()
    except UnifiedCliUnavailable as exc:
        print(f"[Arforge] {exc}", file=sys.stderr)
        return 1

    command = build_command(bun, entry, arguments)
    environment = _child_environment(bun, None)

    try:
        process = subprocess.Popen(
            command,
            cwd=os.getcwd(),
            env=environment,
            stdin=None,
            stdout=None,
            stderr=None,
            shell=False,
        )
    except OSError as exc:
        print(f"[Arforge] 无法启动统一 TypeScript CLI: {exc}", file=sys.stderr)
        return 1

    previous = _forward_signals(process)
    try:
        return int(process.wait())
    except KeyboardInterrupt:
        # The temporary SIGINT handler normally catches this; keep a fallback
        # for embedders that install their own handler.
        try:
            process.send_signal(signal.SIGINT)
        except (OSError, ValueError):
            pass
        return int(process.wait())
    finally:
        _restore_signals(previous)


def main(argv: Sequence[str] | None = None) -> int:
    """Console-script/module entrypoint for the unified TypeScript CLI."""

    return run(argv)


__all__ = [
    "UnifiedCliUnavailable",
    "build_command",
    "main",
    "resolve_unified_cli",
    "run",
]
