"""Prompt builders — loads ARFORGE.md as the canonical system prompt.

Also provides reasoning-enhanced prompt builders via arforge.reasoning.
"""

from __future__ import annotations

import os
from pathlib import Path


def _load_arforge_rules() -> str:
    """Load ARFORGE.md from the project root as the base system prompt."""
    candidates = [
        Path(__file__).resolve().parent.parent / "ARFORGE.md",  # repo root
        Path(os.getcwd()) / "ARFORGE.md",
    ]
    for p in candidates:
        if p.is_file():
            return p.read_text(encoding="utf-8-sig").strip()
    # Fallback — keep the original concise prompt alive
    return (
        "You are Arforge Agent, a local-first capability-enhanced agent. "
        "Use tools, memory, verification, and concise evidence."
    )


_RULES = _load_arforge_rules()

_TOOL_EXECUTION_POLICY = """
## Workspace command contract

- File and command tools are already rooted at the active workspace. Never use
  `cd`, `pushd`, or an assumed `/workspace` prefix.
- Discover an unfamiliar workspace with the dedicated `list_files` tool, then
  narrow with `code_search` and inspect known files with `read_file` or
  `code_read`. Never invoke `dir`, `cmd`, `powershell`, `ls`, `find`, or `grep`
  through `run_cmd` merely to discover or read project files; those commands
  are platform-dependent and the dedicated tools are the portable contract.
- `run_cmd` executes without a shell and captures stdout and stderr itself. Do
  not add shell redirection or chaining such as `2>&1`, `>`, `&&`, or `;`.
- Use `run_script` for disposable Python or JavaScript validation instead of
  writing `_check`, `_review`, or similar helper scripts into the project.
  Do not use `run_script` as a substitute for ordinary directory listing or
  file reading when `list_files` and `read_file` already provide that evidence.
- `open_file` only launches the operating system application. It does not prove
  that content, JavaScript runtime behavior, responsive layout, or visuals work.
  Use read-only `test_browser` and report concrete browser evidence for webpage claims.
  Browser clicks, typing, selection, touch, and key input can change application
  state and must use the approval-gated `interact_browser` tool.
- Run the project's native test command directly. After editing code, rerun the
  same test command; a workspace change makes that a valid new verification.
- Do not download substitute runtimes just to bypass a command error. Inspect
  the error and use the installed project toolchain.
- Once the requested change has concrete passing verification, return the
  result and stop instead of adding unrelated checks.
- Follow an execution-first coding loop: build a minimal project map, run an
  applicable baseline early, inspect only files implicated by evidence, make
  the smallest justified change, and rerun the same validation. For review
  tasks, do not exhaustively read the repository before attempting a baseline.
"""


def _runtime_command_contract() -> str:
    """Describe the actual no-shell host contract to the model.

    Generic cross-platform advice was not enough: on Windows, models emitted
    mixed commands such as ``which ... || where ...``.  The runtime knows its
    host, so make the valid executable-discovery form explicit.
    """
    if os.name == "nt":
        return """## Current command environment

- The current host is Windows. `run_cmd` starts executables directly; it is not
  PowerShell, cmd.exe, Bash, Git Bash, or WSL.
- To locate an executable, use one direct command such as `where php` or
  `where python`. Never use `which`, `/dev/null`, shell redirection, `&&`, or
  `||` on this host.
- For syntax baselines, prefer shell-free forms such as `node --check assets/app.js`
  and `php -l index.php`. If project files document a bundled executable, invoke
  that executable path directly; do not wrap it in `cmd /c` merely to test existence.
- Resolve paths and localhost URLs from project launch scripts literally and relative
  to the directory containing that script. Preserve `..` segments until normal path
  resolution; never replace a documented path with a guessed drive or installation.
  Before declaring a runtime missing, try the exact resolved executable and the exact
  health/application URL printed by the project script.
- Put multi-statement JavaScript or Python checks in `run_script`; do not pass
  source containing semicolons through `node -e` or `python -c`.
- Use Windows paths when a path is required, but prefer workspace-relative
  paths for project tools."""
    return """## Current command environment

- The current host is POSIX. `run_cmd` starts executables directly; it is not a
  shell.
- To locate an executable, use one direct command such as `which php`. Never
  add shell redirection, `&&`, or `||`.
- Prefer workspace-relative paths for project tools."""


SYSTEM_PROMPT = (
    f"{_RULES}\n\n{_TOOL_EXECUTION_POLICY.strip()}\n\n"
    f"{_runtime_command_contract()}"
)

# Everything before this marker must be deterministic for a fixed reasoning
# tier and product version. Request-specific memory, skill routing and output
# style fragments are appended after it so provider prefix caches can reuse the
# large invariant policy block.
VOLATILE_CONTEXT_MARKER = "\n\n## Volatile Request Context\n"


def build_system_prompt(extra: str = "", with_reasoning: bool = False, user_input: str = "") -> str:
    """Build the system prompt, optionally including reasoning instructions.

    When with_reasoning is True, the structured reasoning pipeline
    (UNDERSTAND → THINK → GATHER → VERIFY → ANSWER) is injected.
    """
    base = SYSTEM_PROMPT
    if with_reasoning:
        from arforge.reasoning.prompts import build_reasoning_system_prompt
        base = build_reasoning_system_prompt(
            user_input=user_input,
            base_system_prompt=base,
        )
    if extra:
        # Preserve the complete request-specific instructions while keeping
        # the large policy + reasoning prefix byte-identical across requests.
        # DeepSeek performs provider-side prefix matching; this marker changes
        # only observability boundaries and never truncates model input.
        base = f"{base}{VOLATILE_CONTEXT_MARKER}{extra.strip()}"
    return base.strip()


def build_user_prompt(user_input: str, context: str = "") -> str:
    """Build the user prompt with optional context."""
    return f"Context:\n{context}\n\nUser:\n{user_input}".strip() if context else user_input
