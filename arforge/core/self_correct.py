"""P0 1.2: Self-correction engine ??failure ??diagnosis ??strategy change.

Classifies tool errors, detects repeated same-class failures, and injects
structured reflection prompts into the agentic loop instead of blindly
retrying.  This is the semantic difference between "it retried" and "it
understood the error and tried something different".

Includes enhanced error detail parsing (traceback extraction) and
post-edit consistency verification (sc8).
"""

from __future__ import annotations

import ast as _ast
import hashlib
import json as _json
import os
import re
import time as _time
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path as _Path


class ErrorClass(Enum):
    SYNTAX = auto()           # SyntaxError, IndentationError
    IMPORT = auto()            # ModuleNotFoundError, ImportError
    NAME = auto()              # NameError, UnboundLocalError
    TYPE = auto()              # TypeError, ValueError, AttributeError
    TEST_FAILURE = auto()      # pytest/assertion failures
    COMMAND = auto()           # non-zero exit from run_cmd
    TOOL = auto()              # tool-level error (file not found, permission, etc.)
    TRANSIENT = auto()         # timeout, rate-limit, connection — retryable
    UNKNOWN = auto()


_ERROR_RULES: list[tuple[re.Pattern, ErrorClass]] = [
    (re.compile(r"(?i)syntaxerror|indentationerror|unterminated|E999"), ErrorClass.SYNTAX),
    (re.compile(r"(?i)modulenotfounderror|importerror|cannot import|no module named"), ErrorClass.IMPORT),
    (re.compile(r"(?i)nameerror|unboundlocalerror|is not defined|undefined name"), ErrorClass.NAME),
    (re.compile(r"(?i)typeerror|valueerror|attributeerror|wrong type|invalid literal"), ErrorClass.TYPE),
    (re.compile(r"(?i)assertionerror|assertionerror|assert |FAILED|failed.*test|test.*fail|pytest"), ErrorClass.TEST_FAILURE),
    (re.compile(r"(?i)exit code [1-9]|command failed|non-zero|returned [1-9]"), ErrorClass.COMMAND),
    (re.compile(r"(?i)timeout|timed.?out|rate.?limit|too many requests|429|connection refused|connection reset|service unavailable|503|temporary|try again|retry"), ErrorClass.TRANSIENT),
    (re.compile(r"(?i)file not found|no such file|permission denied|ENOENT|access denied"), ErrorClass.TOOL),
]

_STRATEGY_HINTS: dict[ErrorClass, str] = {
    ErrorClass.SYNTAX: "syntax error ??re-read the file you edited and check for typos or missing colons before retrying",
    ErrorClass.IMPORT: "import error ??the module or symbol may not exist; verify the module path, package name, and import statement",
    ErrorClass.NAME: "undefined name ??the variable or function does not exist in scope; check its spelling, scope, or whether it should be defined first",
    ErrorClass.TYPE: "type/value error ??the operation received an unexpected type or value; check argument types and consider adding a guard/narrowing check",
    ErrorClass.TEST_FAILURE: "test failure ??do not retry the same fix; read the specific assertion that failed and understand the expected vs actual value",
    ErrorClass.COMMAND: "command error ??the shell command failed; inspect its stderr output, check preconditions (file exists, deps installed, cwd correct) and try correcting the command or its arguments",
    ErrorClass.TOOL: "tool error ??the tool could not complete its operation; check whether the target file/path exists and whether permissions are sufficient",
    ErrorClass.TRANSIENT: "transient error \u2014 this is likely a temporary condition (timeout, rate limit, connection); the system will auto-retry with backoff before asking you to change approach",
    ErrorClass.UNKNOWN: "unexpected error ??stop and read the full error message; identify the root cause before attempting any change",
}


def classify(error_text: str) -> ErrorClass:
    """Classify an error message into one of the known error categories."""
    for pattern, cls in _ERROR_RULES:
        if pattern.search(error_text):
            return cls
    return ErrorClass.UNKNOWN


# ---------------------------------------------------------------------------
# Cross-session learning: persist fingerprint \u2192 successful fix mappings
# ---------------------------------------------------------------------------

_CROSS_SESSION_STORE: dict[str, list[dict]] = {}
_CROSS_SESSION_LOADED: bool = False


def _cross_session_path() -> str:
    """Return the path to the cross-session learning data file."""
    base = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return os.path.join(base, "self_correct_learning.json")


def _ensure_cross_session_loaded() -> None:
    """Lazy-load the cross-session store from disk."""
    global _CROSS_SESSION_STORE, _CROSS_SESSION_LOADED
    if _CROSS_SESSION_LOADED:
        return
    _CROSS_SESSION_LOADED = True
    try:
        path = _cross_session_path()
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                data = _json.load(f)
                if isinstance(data, dict):
                    _CROSS_SESSION_STORE = data
    except Exception:
        _CROSS_SESSION_STORE = {}


def _save_cross_session_store() -> None:
    """Persist the cross-session store to disk."""
    try:
        path = _cross_session_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            _json.dump(_CROSS_SESSION_STORE, f, ensure_ascii=False, indent=2)
    except Exception:
        pass  # best-effort, never block the loop


def record_successful_recovery(
    fingerprint: str,
    error_class: ErrorClass,
    tool_name: str,
    fix_description: str = "",
) -> None:
    """Record that a failure was successfully recovered, for future reference."""
    _ensure_cross_session_loaded()
    entry = {
        "fingerprint": fingerprint,
        "error_class": error_class.name,
        "tool": tool_name,
        "fix": fix_description[:500],
        "timestamp": _time.time(),
    }
    key = fingerprint[:16]
    if key not in _CROSS_SESSION_STORE:
        _CROSS_SESSION_STORE[key] = []
    _CROSS_SESSION_STORE[key].append(entry)
    # Keep only the 5 most recent entries per fingerprint
    _CROSS_SESSION_STORE[key] = _CROSS_SESSION_STORE[key][-5:]
    _save_cross_session_store()


def lookup_past_recoveries(
    fingerprint: str, max_results: int = 3
) -> list[str]:
    """Find past successful recoveries for a similar error fingerprint."""
    _ensure_cross_session_loaded()
    results: list[str] = []
    key = fingerprint[:16]
    entries = _CROSS_SESSION_STORE.get(key, [])
    for entry in entries[-max_results:]:
        fix = entry.get("fix", "")
        if fix:
            cls = entry.get("error_class", "UNKNOWN")
            results.append(f"[{cls}] {fix}")
    return results


# ---------------------------------------------------------------------------
# Adaptive strategy hints: track success rates and adjust
# ---------------------------------------------------------------------------

_HINT_PERFORMANCE: dict[ErrorClass, dict[str, int]] = {}  # {ErrorClass: {"success": n, "failure": n}}


def record_hint_outcome(error_class: ErrorClass, success: bool) -> None:
    """Record whether following a strategy hint led to success or failure."""
    if error_class not in _HINT_PERFORMANCE:
        _HINT_PERFORMANCE[error_class] = {"success": 0, "failure": 0}
    key = "success" if success else "failure"
    _HINT_PERFORMANCE[error_class][key] += 1
    # Persist alongside cross-session store
    _ensure_cross_session_loaded()
    _CROSS_SESSION_STORE.setdefault("_hint_performance", {}).setdefault(
        error_class.name, {"success": 0, "failure": 0}
    )[key] = _HINT_PERFORMANCE[error_class][key]
    _save_cross_session_store()


def get_adaptive_strategies(error_class: ErrorClass, limit: int = 3) -> list[str]:
    """Return past successful fix descriptions for this error class, most recent first."""
    _ensure_cross_session_loaded()
    results: list[str] = []
    # Collect all entries for this error class across all fingerprints
    for key, entries in _CROSS_SESSION_STORE.items():
        if key.startswith("_"):
            continue
        for entry in entries:
            if entry.get("error_class") == error_class.name:
                fix = entry.get("fix", "")
                if fix and fix not in results:
                    results.append(fix)
    # Most recent first (entries are already in order)
    return results[-limit:]


def hint_success_rate(error_class: ErrorClass) -> float | None:
    """Return the success rate for a strategy hint, or None if no data."""
    perf = _HINT_PERFORMANCE.get(error_class)
    if not perf:
        return None
    total = perf.get("success", 0) + perf.get("failure", 0)
    if total == 0:
        return None
    return perf["success"] / total


# ---------------------------------------------------------------------------
# Transient error retry configuration
# ---------------------------------------------------------------------------

_TRANSIENT_RETRY_CONFIG: dict = {
    "max_retries": 5,  # generous retry for transient errors
    "base_delay_sec": 1.0,
    "backoff_factor": 2.0,
    "max_delay_sec": 30.0,
}


def is_transient(error_text: str) -> bool:
    """Quick check: is this error likely transient and retryable?"""
    return classify(error_text) == ErrorClass.TRANSIENT


def retry_config() -> dict:
    """Return the current retry configuration."""
    return dict(_TRANSIENT_RETRY_CONFIG)
# ---------------------------------------------------------------------------
# Structured error detail ??traceback parsing (sc8)
# ---------------------------------------------------------------------------

_TRACEBACK_LINE_RE = re.compile(
    r'^\s*File\s+"(?P<file>[^"]+)",\s*line\s+(?P<line>\d+)(?:,\s*in\s+(?P<func>\S+))?',
    re.MULTILINE,
)
_ERROR_LINE_RE = re.compile(
    r'^(?P<type>\w+(?:Error|Warning|Exception))\s*:\s*(?P<message>.+)$',
    re.MULTILINE,
)
_NAME_HINT_RE = re.compile(r"name\s+'?(?P<name>\w+)'?\s+is\s+not\s+defined")
_IMPORT_HINT_RE = re.compile(r"(?:No\s+module\s+named|cannot\s+import\s+name)\s+'?(?P<name>[\w.]+)'?")
_ATTR_HINT_RE = re.compile(r"'(?P<type>\w+)'\s+object\s+has\s+no\s+attribute\s+'?(?P<attr>\w+)'?")


@dataclass
class ErrorDetail:
    """Structured error information extracted from tracebacks and tool output."""
    error_class: ErrorClass = ErrorClass.UNKNOWN
    source_file: str = ""
    source_line: int = 0
    source_func: str = ""
    error_type: str = ""       # e.g. "SyntaxError", "NameError"
    error_message: str = ""    # the error message body
    symbol_hint: str = ""      # extracted symbol name
    raw: str = ""

    @property
    def location(self) -> str:
        if self.source_file and self.source_line:
            base = f"{self.source_file}:{self.source_line}"
            if self.source_func:
                base += f" in {self.source_func}"
            return base
        return ""


def parse_error_detail(error_text: str) -> ErrorDetail:
    """Parse a tool error / traceback into a structured ErrorDetail."""
    text = (error_text or "").strip()

    tb_match = _TRACEBACK_LINE_RE.search(text)
    source_file = ""
    source_line = 0
    source_func = ""
    if tb_match:
        source_file = tb_match.group("file") or ""
        try:
            source_line = int(tb_match.group("line") or 0)
        except ValueError:
            pass
        source_func = tb_match.group("func") or ""

    err_match = _ERROR_LINE_RE.search(text)
    error_type = ""
    error_message = ""
    if err_match:
        error_type = err_match.group("type") or ""
        error_message = (err_match.group("message") or "").strip()

    symbol_hint = ""
    for pattern in [_NAME_HINT_RE, _IMPORT_HINT_RE, _ATTR_HINT_RE]:
        m = pattern.search(text)
        if m:
            groups = m.groupdict()
            symbol_hint = groups.get("name") or groups.get("attr") or ""
            if symbol_hint:
                break

    return ErrorDetail(
        error_class=classify(text),
        source_file=source_file,
        source_line=source_line,
        source_func=source_func,
        error_type=error_type,
        error_message=error_message,
        symbol_hint=symbol_hint,
        raw=text[:500],
    )


def format_error_feedback(detail: ErrorDetail) -> str:
    """Build a human-readable self-correction feedback from an ErrorDetail."""
    parts: list[str] = []
    if detail.location:
        parts.append(f"Location: {detail.location}")
    if detail.error_type:
        msg = detail.error_type
        if detail.error_message:
            msg += f": {detail.error_message[:200]}"
        parts.append(msg)
    if detail.symbol_hint:
        parts.append(f"Offending symbol: '{detail.symbol_hint}'")
    if not parts:
        parts.append(detail.raw[:300] if detail.raw else "Unknown error")

    hint = _STRATEGY_HINTS.get(detail.error_class, _STRATEGY_HINTS[ErrorClass.UNKNOWN])
    loc = f" ({detail.location})" if detail.location else ""
    return (
        f"[SelfCorrect] {detail.error_class.name}{loc}: "
        + "; ".join(parts)
        + f"\nHint: {hint}"
    )


# ---------------------------------------------------------------------------
# Failure tracking and state
# ---------------------------------------------------------------------------


@dataclass
class FailureRecord:
    error_class: ErrorClass
    tool_name: str
    message: str   # first 300 chars of the error
    step: int
    fingerprint: str = ""


def fingerprint(error_text: str) -> str:
    """Return a stable, privacy-conscious fingerprint for repeated failures."""
    normalized = re.sub(r"\b\d+\b", "<n>", (error_text or "").lower())
    normalized = re.sub(r"[a-z]:[\\/][^\s)]+", "<path>", normalized)
    normalized = re.sub(r"/[^\s)]+", "<path>", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()[:500]
    return hashlib.sha256(normalized.encode("utf-8", errors="replace")).hexdigest()[:16]


@dataclass
class SelfCorrectState:
    """Tracks failures across an agentic run to detect repetition and hopelessness."""

    # Architecture note: self-correction has two orthogonal paths that coexist
    # without conflict:
    #
    # 1. INLINE (this class in agentic.py:129 run_tool_loop):
    #    - Pre-LLM: reflection_needed() injects strategy change prompts before
    #      the model generates, triggered by repeated same-class errors.
    #    - is_hopeless() / abort_hint() force an early stop before the LLM call.
    #    - Post-tool: failure_feedback() provides immediate per-failure guidance.
    #    - Signature dedup blocks identical repeat calls at the loop level.
    #
    # 2. HOOK (module-level _STATE singleton, installed via cli.py):
    #    - POST_TOOL_USE: _self_correct_hook calls on_tool() which tracks per-tool
    #      escalation (2nd failure -> warning, 3rd -> strategy change prompt).
    #    - This path is secondary/complementary; it catches tool-level patterns
    #      the inline loop might miss when multiple tools fail in sequence.
    #
    # Both paths use separate SelfCorrectState instances and do not share
    # mutable state, avoiding race conditions in the agentic loop.

    failures: list[FailureRecord] = field(default_factory=list)
    _injection_step: int = 0
    _injection_failure_count: int = 0
    _last_success_step: int = 0
    _compat_escalated_tools: set[str] = field(default_factory=set)

    def record(self, *, error_text: str, tool_name: str, step: int) -> None:
        self.failures.append(
            FailureRecord(
                error_class=classify(error_text),
                tool_name=tool_name,
                message=error_text[:300].strip(),
                step=step,
                fingerprint=fingerprint(error_text),
            )
        )

    def record_success(self, *, tool_name: str, step: int) -> None:
        # Cross-session learning: if any failures preceded this success,
        # record the recovery for future reference
        if self.failures:
            last = self.failures[-1]
            try:
                record_successful_recovery(
                    fingerprint=last.fingerprint,
                    error_class=last.error_class,
                    tool_name=last.tool_name,
                    fix_description=f"Recovered at step {step} via {tool_name}",
                )
                record_hint_outcome(last.error_class, success=True)
            except Exception:
                pass
        self._last_success_step = max(self._last_success_step, step)

    def failure_feedback(self, *, error_text: str, tool_name: str, step: int) -> str:
        """Immediate recovery instruction after a failed tool call."""
        cls = classify(error_text)
        hint = _STRATEGY_HINTS.get(cls, _STRATEGY_HINTS[ErrorClass.UNKNOWN])
        fp = fingerprint(error_text)
        repeats = sum(1 for item in self.failures if item.fingerprint == fp)
        repeat_note = (
            f"This exact failure signature has occurred {repeats} time(s); do not repeat the same call."
            if repeats >= 2
            else "This is the first occurrence of this exact failure signature."
        )

        # Cross-session: look up past successful recoveries for this fingerprint
        past_fixes: list[str] = []
        try:
            past_fixes = lookup_past_recoveries(fp, max_results=2)
        except Exception:
            pass

        past_section = ""
        if past_fixes:
            past_section = ("\nPast successful fixes for similar errors:\n" +
                "\n".join(f"  \u2022 {f}" for f in past_fixes) + "\n")

        return (
            "\n[SelfCorrect] Tool failure recovery required.\n"
            f"Failed tool: {tool_name} at step {step}\n"
            f"Error class: {cls.name}\n"
            f"Strategy hint: {hint}\n"
            f"{repeat_note}\n"
            f"{past_section}"
            "Before your next tool call, identify the likely root cause from the error, "
            "then choose a different command, arguments, file read, or edit. Do not "
            "blindly retry the same operation.\n"
        )

    def on_tool(self, tool_name: str, success: bool, message: str) -> str | None:
        """Compatibility helper used by the POST_TOOL_USE hook."""
        if success:
            self.failures.clear()
            self._compat_escalated_tools.clear()
            self._injection_step = 0
            self._injection_failure_count = 0
            self._last_success_step = 0
            return None

        self.record(error_text=message, tool_name=tool_name, step=len(self.failures) + 1)
        tool_failures = self._count_tool(tool_name)
        if tool_name in self._compat_escalated_tools:
            return None
        if tool_failures == 2:
            return (
                "[SelfCorrect] Same tool failed twice. Analyze the root cause, "
                "do not retry the same approach. Read error output and change strategy."
            )
        if tool_failures == 3:
            self._compat_escalated_tools.add(tool_name)
            return (
                "[SelfCorrect] Same tool failed three times. The current approach "
                "is not working. Change strategy or explain the blocking issue."
            )
        return None

    def _count_class(self, cls: ErrorClass) -> int:
        return sum(1 for f in self.failures if f.error_class is cls)

    def _count_tool(self, tool_name: str) -> int:
        return sum(1 for f in self.failures if f.tool_name == tool_name)

    def _active_failures(self) -> list[FailureRecord]:
        return [failure for failure in self.failures if failure.step > self._last_success_step]

    def reflection_needed(self, current_step: int) -> str | None:
        """Return a structured reflection prompt if the agent is stuck, else None."""
        if self._injection_step == current_step:
            return None
        active_failures = self._active_failures()
        if len(active_failures) < 2:
            return None
        if len(self.failures) == self._injection_failure_count:
            return None

        worst_cls: ErrorClass | None = None
        worst_cnt = 0
        for cls in ErrorClass:
            cnt = sum(1 for failure in active_failures if failure.error_class is cls)
            if cnt > worst_cnt:
                worst_cnt = cnt
                worst_cls = cls

        tool_counts: dict[str, int] = {}
        for f in active_failures:
            tool_counts[f.tool_name] = tool_counts.get(f.tool_name, 0) + 1
        worst_tool = max(tool_counts, key=lambda k: tool_counts[k])
        worst_tool_cnt = tool_counts[worst_tool]

        trigger = False
        hint = ""
        if worst_cls and worst_cnt >= 2:
            trigger = True
            hint = _STRATEGY_HINTS.get(worst_cls, _STRATEGY_HINTS[ErrorClass.UNKNOWN])
        if worst_tool_cnt >= 3:
            trigger = True

        if not trigger:
            return None

        recent = active_failures[-3:] if len(active_failures) >= 3 else active_failures
        recent_summary = "; ".join(
            f"step {f.step} {f.tool_name}: {f.message[:120]}" for f in recent
        )

        self._injection_step = current_step
        self._injection_failure_count = len(self.failures)
        return (
            f"\n[SelfCorrect] You have repeated the same class of error ({worst_cls.name if worst_cls else 'unknown'}) "
            f"{worst_cnt} time(s) and tool '{worst_tool}' has failed {worst_tool_cnt} time(s).\n"
            f"Strategy hint: {hint}\n"
            f"Recent failures: {recent_summary}\n"
            f"Do NOT retry the same fix. Analyze the root cause, change your approach, "
            f"and if the problem is outside your control, explain why and stop.\n"
        )

    def is_hopeless(self) -> bool:
        # Thresholds removed per user requirement — never abort due to error counts.
        # The agent is allowed unlimited retries for self-correction.
        # active_failures tracking still works for reflection_needed() and feedback,
        # but we never force-stop the agent.
        return False

    def abort_hint(self) -> str:
        return (
            "\n[SelfCorrect] You have encountered too many repeated errors. "
            "Pause, explain the root cause clearly, and state what external help or "
            "permission you need.  Do not continue making additional changes.\n"
        )


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Post-edit consistency verification (sc8)
# ---------------------------------------------------------------------------

def check_file_syntax(filepath: str) -> tuple[bool, str]:
    """Compile-check a Python file for syntax errors. Returns (ok, detail)."""
    path = _Path(filepath)
    if not path.exists():
        return False, f"File not found: {path}"
    if path.suffix != ".py":
        return True, ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            source = f.read()
        _ast.parse(source, filename=str(path))
        return True, ""
    except SyntaxError as e:
        return False, f"{path}:{e.lineno}: SyntaxError: {e.msg}"
    except Exception as e:
        return False, f"{path}: {type(e).__name__}: {e}"


def verify_edited_files(
    modified_files: list[str], workspace_root: str = "."
) -> tuple[bool, list[str]]:
    """Run syntax checks on recently edited files. Returns (all_ok, issues).

    This is a programmatic consistency gate ??it doesn't rely on the model
    to self-report. Call it after a batch of file writes to catch obvious
    errors before the model declares completion.
    """
    all_ok = True
    issues: list[str] = []
    seen: set[str] = set()

    for filepath in modified_files:
        resolved = str(_Path(filepath).resolve())
        if resolved in seen:
            continue
        seen.add(resolved)

        ok, detail = check_file_syntax(resolved)
        if not ok:
            all_ok = False
            issues.append(detail)

    return all_ok, issues


def build_consistency_feedback(issues: list[str]) -> str:
    """Build a self-correction feedback message from consistency issues."""
    if not issues:
        return ""
    header = "[SelfCorrect] Post-edit consistency check found issues:\n"
    body = "\n".join(f"  - {issue}" for issue in issues[:10])
    footer = (
        "\nFix these issues before declaring the task complete. "
        "Re-read the affected files, correct the problems, then re-verify."
    )
    return header + body + footer

# Hook and singleton
# ---------------------------------------------------------------------------

_STATE = SelfCorrectState()


def reset_self_correct() -> None:
    """Reset the run-scoped self-correction state."""
    global _STATE
    _STATE = SelfCorrectState()


def _self_correct_hook(ctx) -> object:
    from arforge.core.hooks import HookDecision

    result = ctx.tool_result
    if result is None:
        return HookDecision.proceed()

    success = bool(getattr(result, "success", False))
    message = getattr(result, "error", "") or getattr(result, "output", "") or ""
    feedback = _STATE.on_tool(ctx.tool_name or "unknown", success, message)
    if feedback:
        ctx.feedback.append({"role": "user", "content": feedback})
    return HookDecision.proceed()


def install_self_correct_hook() -> None:
    """Install the POST_TOOL_USE self-correction hook once."""
    from arforge.core.hooks import HookEvent, get_hook_manager

    manager = get_hook_manager()
    names = [entry.name for entry in manager._handlers.get(HookEvent.POST_TOOL_USE, [])]
    if "self_correct" not in names:
        manager.register(
            HookEvent.POST_TOOL_USE,
            _self_correct_hook,
            priority=80,
            name="self_correct",
        )



# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Cross-file import resolution (sc10)
# ---------------------------------------------------------------------------

# stdlib top-level modules (Python 3.11+)
_STDLIB_TOP_LEVEL: set[str] = {
    "abc", "aifc", "argparse", "array", "ast", "asyncio", "atexit",
    "base64", "bdb", "binascii", "bisect", "builtins", "bz2",
    "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code",
    "codecs", "codeop", "collections", "colorsys", "compileall",
    "concurrent", "configparser", "contextlib", "contextvars", "copy",
    "copyreg", "cProfile", "crypt", "csv", "ctypes", "curses",
    "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis",
    "distutils", "doctest", "email", "encodings", "enum", "errno",
    "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch",
    "fractions", "ftplib", "functools", "gc", "getopt", "getpass",
    "gettext", "glob", "graphlib", "grp", "gzip",
    "hashlib", "heapq", "hmac", "html", "http",
    "idlelib", "imaplib", "imghdr", "imp", "importlib", "inspect",
    "io", "ipaddress", "itertools",
    "json",
    "keyword",
    "lib2to3", "linecache", "locale", "logging", "lzma",
    "mailbox", "mailcap", "marshal", "math", "mimetypes", "mmap",
    "modulefinder", "multiprocessing",
    "netrc", "nis", "nntplib", "numbers",
    "operator", "optparse", "os", "ossaudiodev",
    "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil",
    "platform", "plistlib", "poplib", "posix", "posixpath", "pprint",
    "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr",
    "pydoc", "queue",
    "random", "re", "readline", "reprlib", "resource", "rlcompleter",
    "runpy",
    "sched", "secrets", "select", "selectors", "shelve", "shlex",
    "shutil", "signal", "site", "smtpd", "smtplib", "sndhdr",
    "socket", "socketserver", "sqlite3", "ssl", "stat", "statistics",
    "string", "stringprep", "struct", "subprocess", "sunau",
    "symtable", "sys", "sysconfig", "syslog",
    "tabnanny", "tarfile", "telnetlib", "tempfile", "termios",
    "test", "textwrap", "threading", "time", "timeit", "tkinter",
    "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc",
    "tty", "turtle", "types", "typing",
    "unicodedata", "unittest", "urllib", "uu", "uuid",
    "venv",
    "warnings", "wave", "weakref", "webbrowser", "winreg",
    "winsound", "wsgiref",
    "xdrlib", "xml", "xmlrpc",
    "zipapp", "zipfile", "zipimport", "zlib",
    "zoneinfo",
}


def _find_module_in_workspace(
    module_name: str, workspace_root: str
) -> str | None:
    """Resolve a dotted module name to a filesystem path within the workspace.
    Returns the path if found, None otherwise.
    """
    root = _Path(workspace_root).resolve()
    parts = module_name.split(".")

    # Try as package: pkg/__init__.py
    pkg_path = root.joinpath(*parts) / "__init__.py"
    if pkg_path.exists():
        return str(pkg_path)

    # Try as module: mod.py or pkg/mod.py
    mod_path = root.joinpath(*parts[:-1]) / (parts[-1] + ".py")
    if mod_path.exists():
        return str(mod_path)

    # Try flat module at workspace root
    flat_path = root / (module_name + ".py")
    if flat_path.exists():
        return str(flat_path)

    return None


def _extract_top_level_symbols(filepath: str) -> set[str]:
    """Extract all publicly-accessible symbols from a Python module.

    Collects: function/class defs, module-level assignments, imported names,
    and __all__ entries.
    """
    symbols: set[str] = set()
    try:
        with open(filepath, "r", encoding="utf-8-sig") as f:
            source = f.read()
        tree = _ast.parse(source, filename=str(filepath))
    except Exception:
        return symbols

    # Walk ALL nodes to catch symbols regardless of nesting
    for node in _ast.walk(tree):
        # Function and class definitions
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
            symbols.add(node.name)
        # Module-level and class-level assignments
        elif isinstance(node, _ast.Assign):
            for target in node.targets:
                if isinstance(target, _ast.Name):
                    symbols.add(target.id)
                elif isinstance(target, _ast.Tuple):
                    for elt in target.elts:
                        if isinstance(elt, _ast.Name):
                            symbols.add(elt.id)
        elif isinstance(node, _ast.AnnAssign) and isinstance(node.target, _ast.Name):
            symbols.add(node.target.id)
        # Imported names are re-exportable
        elif isinstance(node, _ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name
                symbols.add(name.split(".")[0])
        elif isinstance(node, _ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                name = alias.asname or alias.name
                symbols.add(name)

    return symbols


def _is_installed_package(name: str) -> bool:
    """Check if a package can be imported from site-packages."""
    # Use a cache to avoid repeated import attempts
    cache = getattr(_is_installed_package, "_cache", None)
    if cache is None:
        cache = {}
        _is_installed_package._cache = cache
    if name in cache:
        return cache[name]
    try:
        __import__(name)
        cache[name] = True
        return True
    except ImportError:
        cache[name] = False
        return False


def verify_imports_resolve(
    filepath: str | _Path, workspace_root: str | _Path
) -> tuple[bool, list[str]]:
    """Verify that imports in a Python file can resolve.

    Checks:
    1. For import X / rom X import Y: does module X exist?
    2. For rom X import Y: does module X export symbol Y?

    Returns (all_ok, list_of_issues).
    """
    path = _Path(filepath)
    if not path.exists() or path.suffix != ".py":
        return True, []

    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            source = f.read()
        tree = _ast.parse(source, filename=str(path))
    except Exception:
        return True, []  # syntax errors caught by verify_edited_files

    root = _Path(workspace_root).resolve()
    issues: list[str] = []

    for node in _ast.walk(tree):
        if isinstance(node, _ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in _STDLIB_TOP_LEVEL:
                    continue
                # Check workspace first, then site-packages
                ws_path = _find_module_in_workspace(alias.name, str(root))
                if ws_path is None and not _is_installed_package(top):
                    issues.append(
                        f"{path.name}:{node.lineno}: import '{alias.name}' not found "
                        f"in workspace or site-packages"
                    )

        elif isinstance(node, _ast.ImportFrom):
            if node.module is None:
                continue  # relative import without module ??skip
            module = node.module
            top = module.split(".")[0] if module else ""
            level = node.level or 0

            if level > 0:
                continue  # relative imports ??skip for now

            if top in _STDLIB_TOP_LEVEL:
                continue

            # Resolve the module
            ws_path = _find_module_in_workspace(module, str(root))
            if ws_path is None and not _is_installed_package(top):
                issues.append(
                    f"{path.name}:{node.lineno}: from '{module}' import ... ??"
                    f"module not found in workspace or site-packages"
                )
                continue

            # If module is in workspace, check symbol exports
            if ws_path is not None:
                exported = _extract_top_level_symbols(ws_path)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    if alias.name not in exported:
                        issues.append(
                            f"{path.name}:{node.lineno}: from '{module}' import '{alias.name}' ??"
                            f"symbol not found in {os.path.basename(ws_path)}"
                        )

    return len(issues) == 0, issues


def verify_all_imports(
    modified_files: list[str], workspace_root: str = "."
) -> tuple[bool, list[str]]:
    """Run import resolution checks on modified files. Returns (all_ok, issues)."""
    all_ok = True
    all_issues: list[str] = []

    for filepath in modified_files:
        ok, issues = verify_imports_resolve(filepath, workspace_root)
        if not ok:
            all_ok = False
            all_issues.extend(issues)

    return all_ok, all_issues


def build_import_feedback(issues: list[str]) -> str:
    """Build self-correction feedback from import resolution issues."""
    if not issues:
        return ""
    header = "[SelfCorrect] Cross-file import check found unresolved references:\n"
    body = "\n".join(f"  - {issue}" for issue in issues[:10])
    footer = (
        "\nFix these imports before continuing. "
        "Check that the referenced modules exist and that symbols are correctly named."
    )
    return header + body + footer

# Automated test-fix loop (sc9)
# ---------------------------------------------------------------------------


_TEST_FAILURE_RE = re.compile(
    r"(?P<file>[^\s:]+):(?P<line>\d+):\s*(?P<rest>.+)"
)
_PYTEST_FAIL_RE = re.compile(
    r"FAILED\s+(?P<node>[^\s]+)(?:\s*-\s*(?P<message>.+))?"
)
_E_ASSERT_RE = re.compile(
    r"E\s+assert\s+(?P<left>.+?)\s*==\s*(?P<right>.+?)(?:\s*\+ where.*)?$", re.MULTILINE
)


@dataclass
class TestFailure:
    """A single test failure extracted from test output."""
    test_node: str = ""       # e.g. "tests/test_foo.py::test_bar"
    file: str = ""
    line: int = 0
    message: str = ""
    expected: str = ""
    actual: str = ""


def parse_test_failures(test_output: str) -> list[TestFailure]:
    """Extract structured test failures from pytest output.

    Handles pytest v7+ output format: session header with FAILED/PASSED,
    then FAILURES section with detailed tracebacks, then summary.
    Only parses failures from the detailed FAILURES section.
    """
    failures: list[TestFailure] = []
    lines = test_output.split("\n")

    # Phase 1: find the FAILURES section boundary
    in_failures = False
    for i, line in enumerate(lines):
        if line.strip().startswith("=") and "FAILURES" in line:
            in_failures = True
            continue

    if not in_failures:
        # No FAILURES section ??try parsing from full output anyway
        pass

    # Phase 2: parse each failure block
    # A failure block starts with a separator line like "__________ test_name __________"
    # and contains the traceback with file:line and assert details.
    current: TestFailure | None = None
    separator_re = re.compile(r"^_+\s+(?P<name>\S+)\s+_+$")
    loc_re = re.compile(r"^(?P<file>[^\s:]+):(?P<line>\d+):\s*(?P<rest>.+)")

    for line in lines:
        # Detect failure block separator ??start a new failure
        sm = separator_re.match(line.strip())
        if sm:
            if current is not None and (current.file or current.message):
                failures.append(current)
            current = TestFailure(test_node=sm.group("name") or "")
            continue

        # Look for traceback location: "file.py:NN: in func" or "file.py:NN: ErrorType: msg"
        lm = loc_re.match(line.strip())
        if lm and current is not None:
            f = lm.group("file") or ""
            if f and not current.file:
                current.file = f
            try:
                ln = int(lm.group("line") or 0)
                if ln and not current.line:
                    current.line = ln
            except ValueError:
                pass
            rest = lm.group("rest") or ""
            if "Error" in rest and not current.message:
                current.message = rest[:200]

        # Extract assert expected/actual
        em = _E_ASSERT_RE.search(line)
        if em and current is not None:
            current.expected = (em.group("right") or "").strip()
            current.actual = (em.group("left") or "").strip()

    if current is not None and (current.file or current.message):
        failures.append(current)

    # Phase 3: if we found nothing from the FAILURES section, fall back to
    # matching FAILED lines from the summary
    if not failures:
        for line in lines:
            pm = _PYTEST_FAIL_RE.search(line)
            if pm:
                failures.append(TestFailure(test_node=pm.group("node") or ""))

    return failures


def build_test_fix_feedback(failures: list[TestFailure]) -> str:
    """Build self-correction feedback from test failures."""
    if not failures:
        return ""

    parts: list[str] = []
    parts.append(
        f"[SelfCorrect] {len(failures)} test(s) failed. "
        "Analyze each failure, fix the root cause, then re-run tests."
    )
    for i, f in enumerate(failures[:5]):
        loc = f"{f.file}:{f.line}" if f.file else f.test_node
        parts.append(f"  {i+1}. {loc}")
        if f.message:
            parts.append(f"     {f.message[:150]}")
        if f.expected and f.actual:
            parts.append(f"     Expected: {f.expected}")
            parts.append(f"     Actual:   {f.actual}")
    if len(failures) > 5:
        parts.append(f"  ... and {len(failures) - 5} more failures")
    parts.append(
        "\nFix all failures. Each fix should address the specific assertion. "
        "After fixing, re-run the tests to verify. Do not stop until all tests pass."
    )
    return "\n".join(parts)

# Self-correction dashboard report
# ---------------------------------------------------------------------------


_EVENT_LABELS: dict[str, str] = {
    "feedback": "Failure feedback injected",
    "repeat_blocked": "Repeat tool calls blocked",
    "reflections": "Reflection prompts injected",
    "abort_injected": "Abort signals sent",
    "consistency_checks": "Post-edit consistency check failures",
    "test_fix_feedback": "Test-fix feedback rounds",
    "unexecuted_tool_text": "Unexecuted tool text blocked",
    "verification_required": "Verification gate activations",
}


def format_self_correct_report(data: dict | None) -> str:
    """Render a structured self-correction dashboard from run data."""
    if not data:
        return ""

    lines: list[str] = []
    total = data.get("total_failures", 0)
    successes = data.get("successes", 0)
    total_calls = data.get("total_tool_calls", 0)
    rate = (successes / total_calls * 100) if total_calls > 0 else 100
    aborted = data.get("aborted", False)

    lines.append("  \u2500\u2500 Self-Correction Dashboard " + "\u2500" * 40)
    lines.append(f"  Tool calls: {total_calls} ({successes} OK, {total} failed)")
    lines.append(f"  Success rate: {rate:.0f}%")

    if aborted:
        lines.append("  Status: ABORTED (hopeless state reached)")
    elif total > 0:
        lines.append("  Status: Self-corrected (recovery attempted)")
    else:
        lines.append("  Status: Clean run (no failures)")

    # Per-class breakdown
    per_class: dict[str, int] = data.get("per_class", {})
    if per_class:
        max_count = max(per_class.values()) if per_class else 1
        lines.append("  Failure classes:")
        for cls_name in sorted(per_class.keys()):
            count = per_class[cls_name]
            bar_width = max(1, int(count / max(max_count, 1) * 12))
            bar = "\u2588" * bar_width
            lines.append(f"    {cls_name:<14s} {count:>3d} {bar}")

    # Failed tools
    failed_tools: list[str] = data.get("failed_tools", [])
    if failed_tools:
        lines.append(f"  Failed tools: {', '.join(failed_tools[:8])}")
        lines.append("")

    # Self-correct events
    events: dict[str, int] = data.get("events", {})
    active_events = {k: v for k, v in events.items() if v > 0}
    if active_events:
        lines.append("  Interventions:")
        for key, count in sorted(active_events.items()):
            label = _EVENT_LABELS.get(key, key)
            lines.append(f"    {label:<40s} {count:>3d}")

    lines.append("  " + "\u2500" * 58)
    return "\n".join(lines)

__all__ = [
    "ErrorClass",
    "ErrorDetail",
    "FailureRecord",
    "SelfCorrectState",
    "classify",
    "fingerprint",
    "parse_error_detail",
    "format_error_feedback",
    "install_self_correct_hook",
    "reset_self_correct",
    "format_self_correct_report",
    "record_successful_recovery",
    "lookup_past_recoveries",
    "record_hint_outcome",
    "get_adaptive_strategies",
    "hint_success_rate",
    "is_transient",
    "retry_config",
    "_TRANSIENT_RETRY_CONFIG",
    "_STRATEGY_HINTS",
]
