"""P1 3.2: Real Git tool wrappers — structured, safe, agent-accessible.

Not just run_cmd("git ...").  Each tool wraps subprocess with proper
argument handling and structured output.  Read tools are low-risk;
write tools require category=workspace_cmd for permission gating.
"""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path

from arforge.tool_registry import ParamSchema, register_tool


def _git(args: list[str], *, cwd: Path | None = None, timeout: int = 30) -> tuple[int, str, str]:
    """Run git with structured output. Returns (returncode, stdout, stderr)."""
    # Resolve WORKSPACE dynamically so tests can monkeypatch it
    from arforge.tools.file_tools import get_workspace
    target_cwd = str(cwd or get_workspace())
    command = [
        "git",
        "-c",
        f"core.hooksPath={os.devnull}",
        "-c",
        "core.fsmonitor=false",
        *args,
    ]
    environment = os.environ.copy()
    environment.update({
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "Never",
    })
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        process = subprocess.Popen(
            command,
            cwd=target_cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            creationflags=creation_flags,
        )
        timed_out = threading.Event()

        def terminate_if_running() -> None:
            if process.poll() is not None:
                return
            timed_out.set()
            try:
                process.kill()
            except OSError:
                pass

        watchdog = threading.Timer(max(float(timeout), 0.01), terminate_if_running)
        watchdog.daemon = True
        watchdog.start()
        try:
            stdout, stderr = process.communicate()
        finally:
            watchdog.cancel()
        if timed_out.is_set():
            return 1, "", "git command timed out"
        return process.returncode, stdout.strip(), stderr.strip()
    except subprocess.TimeoutExpired:  # pragma: no cover - Popen watchdog is authoritative
        return 1, "", "git command timed out"
    except FileNotFoundError:
        return 1, "", "git is not available on this system"
    except Exception as exc:
        return 1, "", str(exc)


# ---------------------------------------------------------------------------
# Read-only tools (category=read)
# ---------------------------------------------------------------------------

@register_tool(
    "git_diff",
    "Show staged and unstaged changes (git diff). Returns structured diff output.",
    params=[
        ParamSchema("staged", "boolean", "Show staged changes only (default: false)", required=False, default=False),
        ParamSchema("path", "string", "Limit diff to this file path (optional)", required=False, default=""),
    ],
    category="read",
    risk="low",
    priority=60,
)
def git_diff(staged: bool = False, path: str = "") -> str:
    args = ["diff"]
    if staged:
        args.append("--staged")
    if path:
        args.append("--")
        args.append(path)
    code, out, err = _git(args)
    if code != 0:
        return f"git diff failed: {err}"[:2000]
    return out[:8000] or "(no changes)"


@register_tool(
    "git_log",
    "Show recent commit history (git log --oneline).",
    params=[
        ParamSchema("count", "integer", "Number of commits to show (default: 10, max: 50)", required=False, default=10),
        ParamSchema("path", "string", "Limit log to this file path (optional)", required=False, default=""),
    ],
    category="read",
    risk="low",
    priority=60,
)
def git_log(count: int = 10, path: str = "") -> str:
    n = min(max(int(count), 1), 50)
    args = ["log", f"-{n}", "--oneline", "--decorate"]
    if path:
        args.append("--")
        args.append(path)
    code, out, err = _git(args)
    if code != 0:
        return f"git log failed: {err}"[:2000]
    return out[:4000] or "(no commits)"


@register_tool(
    "git_blame",
    "Show line-by-line authorship for a file (git blame).",
    params=[
        ParamSchema("path", "string", "Path to the file to blame (required)"),
    ],
    category="read",
    risk="low",
    priority=50,
)
def git_blame(path: str) -> str:
    if not path:
        return "ERROR: path is required"
    code, out, err = _git(["blame", "--", path])
    if code != 0:
        return f"git blame failed: {err}"[:2000]
    return out[:6000] or "(empty file)"


@register_tool(
    "git_add",
    "Stage file(s) for commit (git add). Requires permission in non-auto modes.",
    params=[
        ParamSchema("path", "string", "File path or pattern to stage (default: current workspace)", required=False, default="."),
    ],
    category="workspace_cmd",
    risk="medium",
    priority=55,
)
def git_add(path: str = ".") -> str:
    if not path or not path.strip():
        return "ERROR: path is required for git add"
    code, out, err = _git(["add", path])
    if code != 0:
        return f"git add failed: {err}"[:2000]
    return f"Staged: {path}"

@register_tool(
    "git_status",
    "Show working tree status (git status --porcelain).",
    category="read",
    risk="low",
    priority=80,
)
def git_status() -> str:
    code, out, err = _git(["status", "--porcelain"])
    if code != 0:
        return f"git status failed: {err}"[:2000]
    if not out:
        return "Working tree clean."
    return out[:4000]


# ---------------------------------------------------------------------------
# Write tools (category=workspace_cmd — permission-gated)
# ---------------------------------------------------------------------------

@register_tool(
    "git_branch",
    "Create or list branches. Requires permission in non-auto modes.",
    params=[
        ParamSchema("name", "string", "Branch name to create (omit to list all branches)", required=False, default=""),
    ],
    category="workspace_cmd",
    risk="medium",
    priority=55,
)
def git_branch(name: str = "") -> str:
    if not name:
        code, out, err = _git(["branch", "--list"])
        return out[:4000] if code == 0 else f"git branch failed: {err}"[:2000]

    # Validate branch name safety
    if not name or ".." in name or name.startswith("-"):
        return "ERROR: invalid branch name"

    code, out, err = _git(["checkout", "-b", name])
    if code != 0:
        return f"git checkout -b failed: {err}"[:2000]
    return f"Created and switched to branch '{name}'."


@register_tool(
    "git_commit",
    "Stage all changes and commit with a message. Conventional commit format recommended.",
    params=[
        ParamSchema("message", "string", "Commit message (required, conventional commit format recommended)"),
    ],
    category="workspace_cmd",
    risk="medium",
    priority=55,
)
def git_commit(message: str) -> str:
    if not message or not message.strip():
        return "ERROR: commit message is required"

    # Stage all
    code1, _, err1 = _git(["add", "."])
    if code1 != 0:
        return f"git add failed: {err1}"[:2000]

    # Commit
    code2, _, err2 = _git(["commit", "-m", message])
    if code2 != 0:
        return f"git commit failed: {err2}"[:2000]

    # Show the commit
    code3, out, _ = _git(["log", "-1", "--oneline"])
    return f"Committed: {out.strip()}"[:2000]


@register_tool(
    "git_checkout",
    "Switch to an existing branch. Requires permission in non-auto modes.",
    params=[
        ParamSchema("branch", "string", "Branch name to switch to (required)"),
    ],
    category="workspace_cmd",
    risk="medium",
    priority=55,
)
def git_checkout(branch: str) -> str:
    if not branch or not branch.strip():
        return "ERROR: branch name is required"

    code, out, err = _git(["checkout", branch])
    if code != 0:
        return f"git checkout failed: {err}"[:2000]
    return f"Switched to branch '{branch}'."


# ---------------------------------------------------------------------------
# Smart commit helper (not a tool, callable from agentic context)
# ---------------------------------------------------------------------------

def generate_commit_message(diff_text: str) -> str:
    """Generate a conventional commit message from diff content.

    Heuristic only — no model calls.  The agent should generate better
    messages using its own reasoning; this is a fallback.
    """
    if not diff_text or not diff_text.strip():
        return "chore: empty commit"

    lines = [line for line in diff_text.splitlines() if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))]
    added = sum(1 for line in lines if line.startswith("+"))
    removed = sum(1 for line in lines if line.startswith("-"))

    if "test" in diff_text.lower():
        prefix = "test"
    elif "fix" in diff_text.lower() or "bug" in diff_text.lower():
        prefix = "fix"
    elif "refactor" in diff_text.lower():
        prefix = "refactor"
    elif added > removed * 3:
        prefix = "feat"
    else:
        prefix = "chore"

    return f"{prefix}: {added} additions, {removed} deletions"


__all__ = [
    "git_diff",
    "git_log",
    "git_blame",
    "git_status",
    "git_branch",
    "git_commit",
    "git_checkout",
    "generate_commit_message",
]
