"""Enterprise-grade regression tests for the three "code agent unblock" fixes.

These tests lock in the behaviour that turned Arforge from "can write a file but
cannot run it" into a real local code agent:

1. run_cmd executes in WORKSPACE (cwd parity with read_file/write_file).
2. ARFORGE_WORKSPACE=trust-cwd / . binds file+shell tools to the real cwd
   (modern terminal-agent parity) while preserving the sandbox default.
3. The command layer expands the whitelist, runs safe single-level pipelines,
   and hard-rejects dangerous args / shell metacharacters / non-whitelisted stages.

Safety properties (each must hold for a release):
- No command path ever invokes a shell (structural injection impossibility).
- Every destructive pattern in DENY_ARG_PATTERNS returns 126 with a reason.
- A dangerous stage never executes even when an earlier stage is benign.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_workspace(tmp_path, monkeypatch):
    """A throwaway workspace directory + auto-approve, isolated per test."""
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    # Force re-import of file_tools so WORKSPACE rebinds to tmp_path.
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools") or mod.startswith("arforge.tools.basic_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools  # noqa: F401

    importlib.reload(arforge.tools.file_tools)
    return tmp_path


# ===========================================================================
# FIX 1 — run_cmd cwd parity (the original "writes a file then cannot run it" bug)
# ===========================================================================


def test_run_cmd_runs_files_written_into_workspace(fresh_workspace):
    """The canonical regression: write hello.py, run it, see its output.

    Before the fix this failed with "can't open file '<process-cwd>/hello.py'".
    """
    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import WORKSPACE, write_file

    assert WORKSPACE == fresh_workspace.resolve()
    write_file("hello.py", "print('hello from arforge')")
    result = run_cmd("python hello.py")
    assert "hello from arforge" in result


def test_run_cmd_cwd_matches_file_tool_workspace(fresh_workspace):
    """cwd of run_cmd must equal the file tools' WORKSPACE root."""
    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import WORKSPACE, write_file

    write_file("whereami.py", "import os; print(os.getcwd())")
    cwd_reported = run_cmd("python whereami.py").strip()
    # Both are absolute, resolved paths — they must agree.
    assert Path(cwd_reported).resolve() == Path(WORKSPACE).resolve()


def test_run_cmd_runs_relative_script_without_absolute_path(fresh_workspace):
    """Relative-path execution is the whole point of cwd parity."""
    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import write_file

    write_file("calc.py", "print(2 + 3)")
    assert run_cmd("python calc.py").strip() == "5"


def test_write_docx_creates_real_word_document(fresh_workspace):
    from arforge.tools.file_tools import write_docx

    result = write_docx("arc", "hello, world")
    target = fresh_workspace / "arc.docx"

    assert "wrote" in result
    assert target.exists()
    with zipfile.ZipFile(target) as docx:
        names = set(docx.namelist())
        document_xml = docx.read("word/document.xml").decode("utf-8")
    assert "[Content_Types].xml" in names
    assert "_rels/.rels" in names
    assert "hello, world" in document_xml


def test_write_docx_applies_requested_font_and_size(fresh_workspace):
    from arforge.tools.file_tools import write_docx

    write_docx("styled.docx", "你好，我是Arforge", font_name="宋体", font_size_pt=12)
    target = fresh_workspace / "styled.docx"

    with zipfile.ZipFile(target) as docx:
        document_xml = docx.read("word/document.xml").decode("utf-8")

    assert 'w:eastAsia="宋体"' in document_xml
    assert '<w:sz w:val="24"/>' in document_xml
    assert "你好，我是Arforge" in document_xml


def test_write_docx_emits_a4_sections_styles_toc_and_page_numbers(fresh_workspace):
    from arforge.tools.file_tools import write_docx

    write_docx(
        "structured.docx",
        "# 论文题目\n\n## 目录\n\n## 第一章 绪论\n\n正文内容",
        font_name="宋体",
        font_size_pt=12,
    )

    with zipfile.ZipFile(fresh_workspace / "structured.docx") as docx:
        names = set(docx.namelist())
        document_xml = docx.read("word/document.xml").decode("utf-8")
        styles_xml = docx.read("word/styles.xml").decode("utf-8")
        footer_xml = docx.read("word/footer1.xml").decode("utf-8")

    assert {
        "word/styles.xml",
        "word/settings.xml",
        "word/footer1.xml",
        "word/_rels/document.xml.rels",
    } <= names
    assert '<w:pgSz w:w="11906" w:h="16838"/>' in document_xml
    assert '<w:pgMar w:top="1440"' in document_xml
    assert 'w:styleId="Title"' in styles_xml
    assert 'w:styleId="Heading2"' in styles_xml
    assert ' TOC \\o "1-3" \\h \\z \\u ' in document_xml
    assert "目录将在 Word 中更新" not in document_xml
    assert " PAGE " in footer_xml


def test_open_file_uses_default_app_for_an_existing_workspace_file(fresh_workspace, monkeypatch):
    from arforge.tools import file_tools

    target = fresh_workspace / "111.docx"
    target.write_bytes(b"docx-placeholder")
    opened = []
    monkeypatch.setattr(file_tools, "_open_with_default_app", lambda path: opened.append(path))

    result = file_tools.open_file("111.docx")

    assert result.startswith(f"opened {target.resolve()}; launch_only=true")
    assert "no content, runtime, rendering, or visual validation was performed" in result
    assert opened == [target.resolve()]


def test_open_file_rejects_missing_target_without_launching(fresh_workspace, monkeypatch):
    from arforge.tools import file_tools

    opened = []
    monkeypatch.setattr(file_tools, "_open_with_default_app", lambda path: opened.append(path))

    with pytest.raises(FileNotFoundError):
        file_tools.open_file("missing.docx")

    assert opened == []


def test_full_access_can_read_and_edit_workspace_batch_but_cannot_launch_it(
    fresh_workspace, monkeypatch
):
    from arforge.tools import file_tools

    target = fresh_workspace / "start.bat"
    target.write_text("@echo off\r\necho before\r\n", encoding="utf-8")
    monkeypatch.setattr(file_tools, "_uses_local_computer_paths", lambda: True)

    assert "echo before" in file_tools.read_file("start.bat")
    assert "wrote" in file_tools.write_file("start.bat", "@echo off\r\necho after\r\n")
    assert "echo after" in target.read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="protected path"):
        file_tools.open_file("start.bat")


# ===========================================================================
# FIX 2 — ARFORGE_WORKSPACE=trust-cwd / . binds tools to the real cwd
# ===========================================================================


def test_workspace_defaults_to_workspace_subdir(tmp_path, monkeypatch):
    """No env → ./workspace sandbox (safe default preserved)."""
    monkeypatch.delenv("ARFORGE_WORKSPACE", raising=False)
    monkeypatch.chdir(tmp_path)
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools as ft

    importlib.reload(ft)
    assert ft.WORKSPACE == (tmp_path / "workspace").resolve()


def test_workspace_dot_trusts_cwd(tmp_path, monkeypatch):
    """ARFORGE_WORKSPACE=. → WORKSPACE == resolved cwd."""
    monkeypatch.setenv("ARFORGE_WORKSPACE", ".")
    monkeypatch.chdir(tmp_path)
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools as ft

    importlib.reload(ft)
    assert ft.WORKSPACE == tmp_path.resolve()


def test_workspace_trust_cwd_alias_trusts_cwd(tmp_path, monkeypatch):
    """ARFORGE_WORKSPACE=trust-cwd → WORKSPACE == resolved cwd (semantic alias)."""
    monkeypatch.setenv("ARFORGE_WORKSPACE", "trust-cwd")
    monkeypatch.chdir(tmp_path)
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools as ft

    importlib.reload(ft)
    assert ft.WORKSPACE == tmp_path.resolve()


def test_workspace_explicit_path_respected(tmp_path, monkeypatch):
    """An explicit absolute path still wins (no behaviour change)."""
    target = tmp_path / "custom"
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(target))
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools as ft

    importlib.reload(ft)
    assert ft.WORKSPACE == target


def test_trust_cwd_can_edit_existing_real_file(tmp_path, monkeypatch):
    """In trust-cwd the agent can read+edit a file that already existed in cwd
    (the modern terminal-agent workflow), not just create new ones in a sandbox."""
    monkeypatch.setenv("ARFORGE_WORKSPACE", "trust-cwd")
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    monkeypatch.chdir(tmp_path)
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools"):
            del sys.modules[mod]
    import importlib

    import arforge.tools.file_tools as ft

    importlib.reload(ft)

    preexisting = tmp_path / "existing.py"
    preexisting.write_text('def f():\n    return "old"\n', encoding="utf-8")
    # edit_file must find the real file in cwd and replace in place.
    ft.edit_file("existing.py", 'return "old"', 'return "new"')
    assert '"new"' in preexisting.read_text(encoding="utf-8")


def test_delete_file_removes_workspace_file_safely(fresh_workspace):
    from arforge.tools.file_tools import delete_file, write_file

    target = fresh_workspace / "temp_script.py"
    write_file("temp_script.py", "print('temporary')")

    result = delete_file("temp_script.py")

    assert "deleted temp_script.py" in result
    assert not target.exists()


def test_delete_file_refuses_directories(fresh_workspace):
    import pytest

    from arforge.tools.file_tools import delete_file

    (fresh_workspace / "temp_dir").mkdir()

    with pytest.raises(IsADirectoryError):
        delete_file("temp_dir")


# ===========================================================================
# FIX 3 — expanded whitelist + safe pipelines + danger guards
# ===========================================================================


def test_whitelist_is_broad_enough_for_real_work():
    """The whitelist must cover read-only inspection + common build/test tools,
    not just the original 8 binaries."""
    from arforge.tools.basic_tools import ALLOWED_BINARIES

    required = {
        "python",
        "node",
        "npm",
        "git",
        "pip",
        "pytest",
        "cargo",
        "go",
        "java",
        "javac",
        "dotnet",
        "gcc",
        "g++",
        "ruby",
        "sqlite3",
    }
    assert required.issubset(ALLOWED_BINARIES)
    # read-only inspectors must be present now
    assert {"ls", "cat", "grep", "find", "head", "tail"} <= ALLOWED_BINARIES
    # destructive binaries must NOT be present (use file tools with backups instead)
    for forbidden in ("rm", "del", "format", "mkfs", "diskpart", "reg", "shutdown"):
        assert forbidden not in ALLOWED_BINARIES


def test_compiled_artifact_may_run_only_from_active_workspace(fresh_workspace, tmp_path):
    from arforge.tools.basic_tools import check_cmd_permission

    local_binary = fresh_workspace / "contract.exe"
    local_binary.write_bytes(b"MZ")
    local_binary.chmod(0o755)
    outside_binary = tmp_path.parent / f"{tmp_path.name}-outside.exe"
    outside_binary.write_bytes(b"MZ")
    try:
        assert check_cmd_permission("contract.exe")["allowed"] is True
        assert check_cmd_permission(str(outside_binary))["allowed"] is False
    finally:
        outside_binary.unlink(missing_ok=True)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows path resolution")
def test_relative_workspace_executable_is_resolved_before_create_process(
    fresh_workspace,
):
    from arforge.tools.basic_tools import _resolve_workspace_executable_args

    local_binary = fresh_workspace / "contract.exe"
    local_binary.write_bytes(b"MZ")

    resolved = _resolve_workspace_executable_args(
        [r".\contract.exe", "--verify"],
        cwd=fresh_workspace,
    )

    assert resolved == [str(local_binary.resolve()), "--verify"]


def test_list_files_excludes_generated_dependency_and_build_trees(fresh_workspace):
    from arforge.tools.file_tools import list_files

    (fresh_workspace / "src").mkdir()
    (fresh_workspace / "src" / "lib.rs").write_text("pub fn ready() {}\n", encoding="utf-8")
    for directory in ("target", "node_modules", ".git", "__pycache__"):
        generated = fresh_workspace / directory
        generated.mkdir()
        (generated / "artifact.bin").write_text("generated", encoding="utf-8")

    output = list_files()

    assert "src\\lib.rs" in output or "src/lib.rs" in output
    assert "artifact.bin" not in output


def test_system_prompt_explains_no_shell_workspace_command_contract():
    from arforge.prompt import build_system_prompt

    prompt = build_system_prompt()

    assert "already rooted at the active workspace" in prompt
    assert "Never use" in prompt and "`cd`" in prompt
    assert "captures stdout and stderr itself" in prompt
    assert "dedicated `list_files` tool" in prompt
    assert "Never invoke `dir`, `cmd`, `powershell`, `ls`, `find`, or `grep`" in prompt
    assert "Do not use `run_script` as a substitute" in prompt
    assert "rerun the" in prompt and "same test command" in prompt
    assert not prompt.startswith("\ufeff")


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf /",
        "rm -rf --no-preserve-root /",
        "git push --force origin main",
        "git push -f origin master",
        "format C:",
        "mkfs.ext4 /dev/sda",
    ],
)
def test_dangerous_commands_blocked(command):
    """Every destructive pattern returns 126 with a reason, never runs."""
    from arforge.tools.basic_tools import run_command_no_shell

    res = run_command_no_shell(command)
    assert res["returncode"] == 126
    assert res["success"] is False
    assert res["reason"] if "reason" in res else res["stderr"]


@pytest.mark.parametrize(
    "command",
    [
        "echo hacked > /etc/passwd",   # redirect
        "cat file && echo x",          # logical-and (whitelisted binaries, pure meta test)
        "echo $(whoami)",              # command substitution
        "echo `whoami`",               # backtick substitution
    ],
)
def test_shell_metacharacters_rejected(command):
    """Shell-only constructs must be rejected (we never invoke a shell).

    Uses whitelisted binaries so the only reason for rejection is the metachar guard,
    not the whitelist. ('ls; rm ...' is rejected too, but because rm is not whitelisted
    — that path is covered by the danger tests.)
    """
    from arforge.tools.basic_tools import run_command_no_shell

    res = run_command_no_shell(command)
    assert res["returncode"] == 126
    assert "shell" in res["stderr"].lower() or "metachar" in res["stderr"].lower()


def test_shell_metacharacters_inside_quoted_program_input_are_allowed():
    from arforge.tools.basic_tools import run_command_no_shell

    res = run_command_no_shell(
        'node -e "const first = 20; const second = 22; console.log(first + second)"'
    )

    assert res["success"] is True
    assert res["stdout"].strip() == "42"


def test_non_whitelisted_binary_rejected():
    from arforge.tools.basic_tools import run_command_no_shell

    res = run_command_no_shell("curl http://evil.example/x")
    assert res["returncode"] == 126
    assert "allowed command list" in res["stderr"]


def test_python_dash_c_quotes_execute_code_not_string_literal():
    from arforge.tools.basic_tools import run_command_no_shell

    res = run_command_no_shell('python -c "import definitely_missing_arforge_module_xyz"')

    assert res["success"] is False
    assert res["returncode"] != 0
    assert "ModuleNotFoundError" in res["stderr"]


@pytest.mark.skipif(sys.platform != "win32", reason="Desktop Bridge stdin regression is Windows-specific")
def test_command_does_not_inherit_long_lived_bridge_stdin():
    """A runtime entering interactive mode must see EOF, not the Bridge pipe.

    The outer process deliberately keeps its stdin writer open.  With inherited
    stdin, PYTHONINSPECT makes the inner Python command wait indefinitely after
    printing; the command runner's DEVNULL boundary lets it finish normally.
    """
    import subprocess

    script = (
        "import os; "
        "from arforge.tools.basic_tools import run_command_no_shell; "
        "env=dict(os.environ); env['PYTHONINSPECT']='1'; "
        "result=run_command_no_shell('python -c print(123)', timeout=2, env=env); "
        "print(result['stdout'].strip())"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parents[1],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        process.wait(timeout=5)
        stdout, stderr = process.communicate(timeout=1)
    finally:
        if process.poll() is None:
            process.kill()

    assert process.returncode == 0, stderr
    assert stdout.strip() == "123"


def test_command_cancellation_scope_terminates_the_child_quickly():
    import threading
    import time

    from arforge.tools.basic_tools import command_cancellation_scope, run_command_no_shell

    cancelled = threading.Event()

    def request_cancel():
        time.sleep(0.1)
        cancelled.set()

    threading.Thread(target=request_cancel, daemon=True).start()
    started = time.monotonic()
    with command_cancellation_scope(cancelled):
        result = run_command_no_shell(
            'python -c "import time; time.sleep(5)"',
            timeout=10,
        )

    assert time.monotonic() - started < 2
    assert result["success"] is False
    assert result["returncode"] == 130
    assert "cancelled" in result["stderr"]


def test_run_script_without_deadline_still_honors_user_cancellation():
    import threading
    import time

    from arforge.tools.basic_tools import command_cancellation_scope, run_script

    cancelled = threading.Event()

    def request_cancel():
        time.sleep(0.1)
        cancelled.set()

    threading.Thread(target=request_cancel, daemon=True).start()
    started = time.monotonic()
    with command_cancellation_scope(cancelled):
        with pytest.raises(InterruptedError, match="cancelled by user"):
            run_script("python", "import time\ntime.sleep(5)")

    assert time.monotonic() - started < 2


def test_windows_npm_shim_resolves_to_node_cli_without_shell(tmp_path, monkeypatch):
    from arforge.tools import basic_tools

    node_dir = tmp_path / "node"
    npm_bin = node_dir / "node_modules" / "npm" / "bin"
    npm_bin.mkdir(parents=True)
    node_exe = node_dir / "node.exe"
    npm_cmd = node_dir / "npm.cmd"
    npm_cli = npm_bin / "npm-cli.js"
    for path in (node_exe, npm_cmd, npm_cli):
        path.write_text("fixture", encoding="utf-8")

    def fake_which(name):
        return {
            "node.exe": str(node_exe),
            "npm.cmd": str(npm_cmd),
        }.get(name)

    monkeypatch.setattr(basic_tools.shutil, "which", fake_which)

    resolved = basic_tools._resolve_command_args(
        ["npm", "test", "--", "--watch=false"],
        platform="nt",
    )

    assert resolved == [
        str(node_exe),
        str(npm_cli),
        "test",
        "--",
        "--watch=false",
    ]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows npm shim regression")
def test_windows_npm_command_runs_without_shell():
    from arforge.tools.basic_tools import run_command_no_shell

    result = run_command_no_shell("npm --version")

    assert result["success"] is True
    assert result["returncode"] == 0
    assert result["stdout"].strip()


def test_run_cmd_failure_includes_stdout_and_exit_code(fresh_workspace):
    import pytest

    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import write_file

    write_file("fail_stdout.py", "print('useful failure evidence')\nraise SystemExit(7)\n")

    with pytest.raises(RuntimeError) as excinfo:
        run_cmd("python fail_stdout.py")

    message = str(excinfo.value)
    assert "useful failure evidence" in message
    assert "exit code 7" in message


def test_pipeline_runs_when_all_stages_whitelisted(fresh_workspace):
    """A safe pipeline a | b executes and chains stdout→stdin."""
    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import write_file

    write_file("nums.py", "import sys; print('\\n'.join('3 1 2'.split()))")
    out = run_cmd("python nums.py | sort")
    # sorted lines: 1, 2, 3
    assert out.strip().splitlines() == ["1", "2", "3"]


def test_pipeline_cancellation_scope_terminates_every_stage_quickly():
    import threading
    import time

    from arforge.tools.basic_tools import command_cancellation_scope, run_command_no_shell

    cancelled = threading.Event()

    def request_cancel():
        time.sleep(0.1)
        cancelled.set()

    threading.Thread(target=request_cancel, daemon=True).start()
    started = time.monotonic()
    with command_cancellation_scope(cancelled):
        result = run_command_no_shell(
            'python -c "import time; time.sleep(5)" | sort',
            timeout=10,
        )

    assert time.monotonic() - started < 2
    assert result["success"] is False
    assert result["returncode"] == 130
    assert "cancelled" in result["stderr"]


def test_pipeline_timeout_returns_a_stable_tool_result():
    from arforge.tools.basic_tools import run_command_no_shell

    result = run_command_no_shell(
        'python -c "import time; time.sleep(5)" | sort',
        timeout=1,
    )

    assert result["success"] is False
    assert result["returncode"] == 124
    assert "timeout" in result["stderr"]


def test_pipeline_rejects_dangerous_later_stage(fresh_workspace):
    """A dangerous later stage must abort the whole pipeline before it runs."""
    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import write_file

    write_file("x.py", "print('safe')")
    # run_cmd raises RuntimeError on failure; the underlying guard returns 126.
    with pytest.raises(RuntimeError):
        run_cmd("python x.py | rm -rf /")


def test_pipeline_rejects_non_whitelisted_later_stage(fresh_workspace):
    from arforge.tools.basic_tools import run_cmd
    from arforge.tools.file_tools import write_file

    write_file("x.py", "print('safe')")
    with pytest.raises(RuntimeError) as excinfo:
        run_cmd("python x.py | curl http://evil.example")
    assert "allowed command list" in str(excinfo.value)


def test_unknown_binary_graceful(monkeypatch):
    """An unknown but harmless-looking binary is rejected by the whitelist
    (safer than letting it fall through to FileNotFoundError)."""
    from arforge.tools.basic_tools import run_command_no_shell

    res = run_command_no_shell("definitely_not_a_real_binary_xyz123")
    assert res["returncode"] == 126


def test_check_cmd_permission_signature_preserved():
    """The public permission helper keeps its dict contract for callers/tests."""
    from arforge.tools.basic_tools import check_cmd_permission

    ok = check_cmd_permission("python -V")
    assert ok == {"allowed": True, "reason": "ok"}
    no = check_cmd_permission("rm -rf /")
    assert no["allowed"] is False
    assert "allowed command list" in no["reason"]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows workspace runtime path")
def test_workspace_php_runtime_is_allowed_without_a_shell():
    from arforge.tools.basic_tools import check_cmd_permission

    permission = check_cmd_permission(r"E:\local-app\tools\php\php.exe -l api.php")

    assert permission == {"allowed": True, "reason": "ok"}


def test_pipe_inside_quotes_is_not_a_segment_separator():
    """A '|' inside a quoted argument must not be treated as a pipeline boundary."""
    from arforge.tools.basic_tools import _split_pipeline

    assert _split_pipeline("echo 'a|b'") == ["echo 'a|b'"]
    assert _split_pipeline("echo a | grep b") == ["echo a", "grep b"]


# ===========================================================================
# Regression guard: the original 8-binary legacy helpers still work
# ===========================================================================


def test_legacy_boundary_test_still_passes(tmp_path):
    """The pre-existing permission/sandbox modules are untouched by these fixes."""
    from arforge.permission import check_command_permission
    from arforge.sandbox import run_command_no_shell as legacy_run
    from arforge.verifier import verify_python_file

    target = tmp_path / "ok.py"
    target.write_text("x = 1\n", encoding="utf-8")
    assert not check_command_permission("rm -rf /").allowed
    assert legacy_run(["python", "--version"]).returncode == 0
    assert verify_python_file(target)["success"]
