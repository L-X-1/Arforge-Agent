"""Contract tests for the Python-to-TypeScript CLI compatibility boundary."""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 CI uses the already locked dependency.
    import tomli as tomllib


def _target_bun(root: Path) -> Path:
    bun = root / ".tools" / "bun-1.3.14" / ("bun.exe" if os.name == "nt" else "bun")
    if not bun.is_file():
        message = f"TS CLI integration requires the target-owned Bun runtime: {bun}"
        if os.environ.get("CI", "").lower() == "true":
            pytest.fail(message)
        pytest.skip(message)
    return bun


def test_missing_target_bun_is_not_reported_as_a_pass(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(pytest.skip.Exception, match="target-owned Bun"):
        _target_bun(tmp_path)
    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception, match="target-owned Bun"):
        _target_bun(tmp_path)


def test_python_entrypoints_use_the_unified_typescript_launcher() -> None:
    from arforge import __main__
    from arforge import cli_bridge

    assert __main__.main is cli_bridge.main
    assert "from arforge.cli_bridge import main" in Path("main.py").read_text(encoding="utf-8")
    launcher = Path("arforge.cmd").read_text(encoding="utf-8")
    assert 'node "%ARFORGE_ROOT%bin\\arforge.js" %*' in launcher
    assert "MAIN_PY" not in launcher
    assert "main.py" not in launcher
    assert "endlocal & exit /b %ARFORGE_EXIT%" in launcher
    project = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["scripts"]["arforge"] == "arforge.cli_bridge:main"


@pytest.mark.skipif(os.name != "nt", reason="The CMD wrapper is Windows-only")
@pytest.mark.parametrize(
    ("arguments", "expected_code"),
    [(["capabilities", "evaluate", "--json"], 0), (["definitely-not-a-command"], 2)],
)
def test_windows_cmd_matches_direct_ts_cli(arguments, expected_code, tmp_path: Path) -> None:
    """Exercise parsing/output/exit through CMD, not just the wrapper text."""
    root = Path.cwd()
    bun = _target_bun(root)
    profile = tmp_path / "isolated-home"
    workspace = tmp_path / "项目 with spaces"
    workspace.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(profile),
        "ARFORGE_TEST_HOME": str(profile),
        "ARFORGE_DISABLE_MODELS_FETCH": "true",
    }
    argv = [*arguments, "--workspace", str(workspace)] if expected_code == 0 else arguments
    results = [
        subprocess.run(
            command,
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        for command in (
            [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "arforge.cmd", *argv],
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        )
    ]
    wrapped, direct = results
    assert wrapped.returncode == direct.returncode == expected_code
    assert wrapped.stdout == direct.stdout
    assert wrapped.stderr == direct.stderr
    if expected_code == 0:
        assert json.loads(wrapped.stdout)["workspace"] == str(workspace)
    else:
        assert "未知命令" in wrapped.stderr


def test_python_legacy_cli_module_entry_uses_the_unified_typescript_launcher() -> None:
    """Executing the legacy module must not resurrect its old parser owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_module = subprocess.run(
        [sys.executable, "-m", "arforge.cli", "learning", "status", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "learning", "status", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_module.returncode == typescript.returncode == 0
    assert python_module.stdout == typescript.stdout
    assert python_module.stderr == typescript.stderr
    assert "Python" not in python_module.stderr


def test_frozen_legacy_cli_import_does_not_boot_workspace_state_modules() -> None:
    """Importing the compatibility module must not initialize Python state owners."""

    root = Path.cwd()
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys, arforge.cli; "
                "print(any(name.startswith('arforge.') and "
                "name.rsplit('.', 1)[-1] in {'trust_screen', 'workspace_roots'} "
                "for name in sys.modules))"
            ),
        ],
        cwd=root,
        env={**os.environ, "ARFORGE_DB": ":memory:"},
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert probe.returncode == 0
    assert probe.stdout.strip() == "False"
    assert probe.stderr == ""


def test_non_legacy_python_runtime_has_no_direct_cli_owner() -> None:
    """The old parser may remain importable, but runtime code cannot invoke it."""

    root = Path("arforge")
    violations: list[str] = []
    for source in root.rglob("*.py"):
        # These are the explicit compatibility implementation and its launcher
        # documentation; all other Python runtime files must stay off this API.
        if source.name in {"cli.py", "cli_bridge.py"}:
            continue
        text = source.read_text(encoding="utf-8-sig")
        try:
            tree = ast.parse(text, filename=str(source))
        except SyntaxError as exc:  # pragma: no cover - repository invariant
            violations.append(f"{source}: syntax error: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "arforge.cli":
                violations.append(f"{source}:{node.lineno}: from arforge.cli import ...")
            elif isinstance(node, ast.Import) and any(alias.name == "arforge.cli" for alias in node.names):
                violations.append(f"{source}:{node.lineno}: import arforge.cli")
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                if re.search(r"(?:python(?:\.exe)?\s+)?-m\s+arforge\.cli\b", node.value):
                    violations.append(f"{source}:{node.lineno}: legacy CLI subprocess")

    assert violations == []


def test_non_test_python_sources_have_no_direct_legacy_cli_api_callers() -> None:
    """Only the explicit compatibility module may reference ``arforge.cli``.

    ``arforge.cli`` stays importable for migration-era embedded callers and
    Python tests, but a product script must enter the TypeScript CLI through
    ``arforge.cli_bridge``.  Keep this repository-wide guard separate from the
    runtime-only check above so a new helper, fixture runner, or root launcher
    cannot quietly become a second CLI owner.
    """

    root = Path.cwd()
    violations: list[str] = []
    # Keep the roots explicit: a repository-wide rglob would walk archived
    # desktop bundles and user snapshots that are not product sources (and
    # may be ACL-protected on Windows).
    sources = list((root / "arforge").rglob("*.py"))
    sources.extend(root.glob("*.py"))
    sources.extend((root / "scripts").glob("*.py"))
    for source in sources:
        relative = source.relative_to(root)
        if relative.as_posix() in {"arforge/cli.py", "arforge/cli_bridge.py"}:
            continue
        try:
            text = source.read_text(encoding="utf-8-sig")
        except OSError:
            # Generated/archive trees can contain ACL-protected snapshots;
            # they are not product sources and are already outside the scan
            # roots above when the repository provides a normal checkout.
            continue
        try:
            tree = ast.parse(text, filename=str(source))
        except SyntaxError as exc:  # pragma: no cover - repository invariant
            violations.append(f"{relative}: syntax error: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "arforge.cli":
                violations.append(f"{relative}:{node.lineno}: from arforge.cli import ...")
            elif isinstance(node, ast.Import) and any(alias.name == "arforge.cli" for alias in node.names):
                violations.append(f"{relative}:{node.lineno}: import arforge.cli")
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                if re.search(r"(?:python(?:\.exe)?\s+)?-m\s+arforge\.cli\b", node.value):
                    violations.append(f"{relative}:{node.lineno}: legacy CLI subprocess")

    assert violations == []


def test_unowned_file_observation_commands_fail_closed_at_the_ts_boundary(tmp_path: Path) -> None:
    """Do not route process-local Python reports through a fake TS owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(tmp_path / "home"),
        "ARFORGE_TEST_HOME": str(tmp_path / "home"),
    }
    for command in ("file-state", "cost-optimization"):
        python_result = subprocess.run(
            [sys.executable, "-m", "arforge", command, "--json"],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_result = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", command, "--json"],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        assert python_result.returncode == typescript_result.returncode == 2
        assert python_result.stdout == typescript_result.stdout == ""
        assert python_result.stderr == typescript_result.stderr
        assert "TypeScript/Core" in python_result.stderr
        assert "Python 历史命令" in python_result.stderr

    home = tmp_path / "home"
    # App bootstrap may provision empty profile directories before the CLI
    # guard runs; the fail-closed contract is that no report, database, or
    # other file state is created.
    assert not any(item.is_file() for item in home.rglob("*") if item.exists())


def test_bridge_preserves_cli_arguments_as_an_argument_vector(tmp_path: Path) -> None:
    from arforge.cli_bridge import build_command

    entry = tmp_path / "index.ts"
    command = build_command("bun", entry, ["--workspace", "C:\\a path", "$(touch", "x)"])
    assert command == ["bun", "--conditions=browser", str(entry), "--workspace", "C:\\a path", "$(touch", "x)"]


def test_external_embedding_facade_aliases_the_unified_bridge() -> None:
    """New Python hosts must have one explicit adapter, never a second parser."""

    from arforge import cli_bridge, cli_compat

    assert cli_compat.main is cli_bridge.main
    assert cli_compat.run is cli_bridge.run
    assert cli_compat.invoke is cli_bridge.invoke
    assert cli_compat.resolve_unified_cli is cli_bridge.resolve_unified_cli


def test_bridge_capture_adapter_preserves_argv_and_disables_shell(monkeypatch, tmp_path: Path) -> None:
    """Embedded callers receive deterministic captured output from the TS child."""

    import arforge.cli_bridge as bridge

    entry = tmp_path / "index.ts"
    observed: dict[str, object] = {}

    class Completed:
        returncode = 7
        stdout = "captured stdout\n"
        stderr = "captured stderr\n"

    def fake_run(command, **kwargs):
        observed["command"] = command
        observed["kwargs"] = kwargs
        return Completed()

    monkeypatch.setattr(bridge, "resolve_unified_cli", lambda: ("bun", entry))
    monkeypatch.setattr(bridge.subprocess, "run", fake_run)

    result = bridge.invoke(
        ["--help", "$(not-a-shell-command)"],
        cwd=tmp_path,
        env={"ARFORGE_EMBED_TEST": "1"},
        input_text="hello\n",
    )

    assert result.argv == ("--help", "$(not-a-shell-command)")
    assert result.command == (
        "bun",
        "--conditions=browser",
        str(entry),
        "--help",
        "$(not-a-shell-command)",
    )
    assert result.returncode == 7
    assert result.stdout == "captured stdout\n"
    assert result.stderr == "captured stderr\n"
    assert result.timed_out is False
    assert observed["command"] == list(result.command)
    kwargs = observed["kwargs"]
    assert kwargs["shell"] is False
    assert kwargs["capture_output"] is True
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["input"] == "hello\n"
    assert "stdin" not in kwargs
    assert kwargs["env"]["ARFORGE_EMBED_TEST"] == "1"


def test_bridge_capture_adapter_fails_closed_without_python_fallback(monkeypatch) -> None:
    import arforge.cli_bridge as bridge

    monkeypatch.setattr(
        bridge,
        "resolve_unified_cli",
        lambda: (_ for _ in ()).throw(bridge.UnifiedCliUnavailable("missing TS entry")),
    )

    result = bridge.invoke(["--help"])

    assert result.returncode == 1
    assert result.argv == ("--help",)
    assert result.command == ()
    assert result.stdout == ""
    assert "missing TS entry" in result.stderr
    assert result.timed_out is False


def test_bridge_capture_adapter_keeps_partial_bytes_on_timeout(monkeypatch, tmp_path: Path) -> None:
    """Timeout diagnostics stay readable even when subprocess returns bytes."""

    import arforge.cli_bridge as bridge

    entry = tmp_path / "index.ts"

    def fake_run(_command, **_kwargs):
        raise bridge.subprocess.TimeoutExpired(
            cmd="bun",
            timeout=0.25,
            output=b"partial stdout\n",
            stderr=b"partial stderr\n",
        )

    monkeypatch.setattr(bridge, "resolve_unified_cli", lambda: ("bun", entry))
    monkeypatch.setattr(bridge.subprocess, "run", fake_run)

    result = bridge.invoke(["run"], cwd=tmp_path, timeout=0.25)

    assert result.returncode == 124
    assert result.timed_out is True
    assert result.stdout == "partial stdout\n"
    assert "partial stderr\n" in result.stderr
    assert "timed out after 0.25s" in result.stderr


def test_root_python_launcher_matches_ts_unknown_command_boundary() -> None:
    """A bare typo must not be masked by the default no-TTY TUI diagnostic."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_unknown = subprocess.run(
        [sys.executable, "main.py", "definitely-not-a-command"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_unknown = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "definitely-not-a-command"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_unknown.returncode == typescript_unknown.returncode == 2
    assert python_unknown.stdout == typescript_unknown.stdout == ""
    assert python_unknown.stderr == typescript_unknown.stderr
    assert "未知命令" in python_unknown.stderr
    assert "不是 TTY" not in python_unknown.stderr


def test_bridge_spawns_typescript_without_shell_and_returns_child_code(monkeypatch, tmp_path: Path) -> None:
    import arforge.cli_bridge as bridge

    entry = tmp_path / "index.ts"
    observed: dict[str, object] = {}

    class FakeProcess:
        def poll(self):
            return None

        def send_signal(self, signum):
            observed["signal"] = signum

        def wait(self):
            return 17

    def fake_popen(command, **kwargs):
        observed["command"] = command
        observed["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(bridge, "resolve_unified_cli", lambda: ("bun", entry))
    monkeypatch.setattr(bridge.subprocess, "Popen", fake_popen)

    assert bridge.run(["--help", "$(not-a-shell-command)"]) == 17
    assert observed["command"] == ["bun", "--conditions=browser", str(entry), "--help", "$(not-a-shell-command)"]
    assert observed["kwargs"]["shell"] is False
    assert observed["kwargs"]["cwd"]


def test_bridge_fails_closed_without_falling_back_to_python(monkeypatch, capsys) -> None:
    import arforge.cli_bridge as bridge

    monkeypatch.setattr(
        bridge,
        "resolve_unified_cli",
        lambda: (_ for _ in ()).throw(bridge.UnifiedCliUnavailable("missing TS entry")),
    )
    assert bridge.run(["--help"]) == 1
    assert "missing TS entry" in capsys.readouterr().err


def test_python_module_help_is_the_same_ts_cli_help() -> None:
    """The compatibility entrypoint must expose the exact canonical help surface."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_help = subprocess.run(
        [sys.executable, "-m", "arforge", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_help = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_help.returncode == typescript_help.returncode == 0
    assert python_help.stdout == typescript_help.stdout
    assert python_help.stderr == typescript_help.stderr


def test_python_module_print_command_uses_the_ts_owner() -> None:
    """The historical print command is parsed and executed by the TS owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_print = subprocess.run(
        [sys.executable, "-m", "arforge", "print", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_print = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "print", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_print.returncode == typescript_print.returncode == 0
    assert python_print.stdout == typescript_print.stdout
    assert python_print.stderr == typescript_print.stderr
    assert "--input-format" in python_print.stderr
    assert "Python" not in python_print.stderr


def test_python_module_learning_command_uses_the_ts_owner() -> None:
    """Learning compatibility invocations must expose the canonical TS command."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_learning = subprocess.run(
        [sys.executable, "-m", "arforge", "learning", "status", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_learning = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "learning", "status", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_learning.returncode == typescript_learning.returncode == 0
    assert python_learning.stdout == typescript_learning.stdout
    assert python_learning.stderr == typescript_learning.stderr
    assert "sync-dogfood" in python_learning.stderr
    assert "Python" not in python_learning.stderr


def test_python_module_learning_recall_uses_the_ts_owner(tmp_path: Path) -> None:
    """The historical read-only recall leaf must use the canonical TS composition."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "learning-recall.db"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
    }
    args = ["learning", "recall", "--workspace", str(tmp_path), "--json"]
    python_recall = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_recall = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_recall.returncode == typescript_recall.returncode == 0
    assert json.loads(python_recall.stdout) == json.loads(typescript_recall.stdout)
    assert python_recall.stderr == typescript_recall.stderr
    assert json.loads(python_recall.stdout)["execution_mode"] == "read-only-composition"


def test_python_module_learning_dream_uses_the_ts_owner(tmp_path: Path) -> None:
    """The read-only dream projection must be served by the canonical TS/Core owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "learning-dream.db"
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    args = ["learning", "dream", "--workspace", str(tmp_path), "--json"]
    python_dream = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_dream = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_dream.returncode == typescript_dream.returncode == 0
    python_payload = json.loads(python_dream.stdout)
    typescript_payload = json.loads(typescript_dream.stdout)
    # The projection records observation time; compare all semantic fields while
    # allowing the two separately spawned processes to have different clocks.
    python_payload["dream"].pop("timestamp", None)
    typescript_payload["dream"].pop("timestamp", None)
    assert python_payload == typescript_payload
    assert python_dream.stderr == typescript_dream.stderr
    assert python_payload["executionMode"] == "read-only-core-projection"
    assert python_payload["sideEffects"] == "none"
    assert python_payload["consolidation"]["status"] == "not_run"
    assert python_payload["consolidation"]["patternsFound"] == 0


def test_python_module_memory_digest_help_uses_the_ts_owner() -> None:
    """The historical digest leaf must expose the canonical TS options."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_digest = subprocess.run(
        [sys.executable, "-m", "arforge", "memory", "digest", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_digest = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "memory", "digest", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_digest.returncode == typescript_digest.returncode == 0
    assert python_digest.stdout == typescript_digest.stdout
    assert python_digest.stderr == typescript_digest.stderr
    assert "--category" in python_digest.stderr
    assert "--digest-limit" in python_digest.stderr
    assert "--path" in python_digest.stderr
    assert "Python" not in python_digest.stderr


def test_python_module_memory_digest_executes_the_ts_owner(tmp_path: Path) -> None:
    """The old memory digest invocation must read and render the TS/Core store."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "memory-digest.db"
    home = tmp_path / "home"
    home.mkdir()
    workflow_dir = tmp_path / ".arforge" / "workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "checkpoint.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "name": "checkpoint_flow",
                "steps": [{"id": "done", "title": "Done", "kind": "checkpoint", "prompt": "finished"}],
            }
        ),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    seed = subprocess.run(
        [
            str(bun),
            "--conditions=browser",
            "packages/arforge/src/index.ts",
            "memory",
            "create",
            "Bridge digest identity",
            "--type",
            "identity",
            "--workspace",
            str(tmp_path),
            "--json",
        ],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert seed.returncode == 0, seed.stderr

    args = ["memory", "digest", "--category", "identity", "--workspace", str(tmp_path), "--json"]
    python_digest = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_digest = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_digest.returncode == typescript_digest.returncode == 0
    assert python_digest.stderr == typescript_digest.stderr
    python_data = json.loads(python_digest.stdout)
    typescript_data = json.loads(typescript_digest.stdout)
    python_data.pop("generated_at", None)
    typescript_data.pop("generated_at", None)
    assert python_data == typescript_data
    assert python_data["total"] == 1
    assert python_data["categories"][0]["category"] == "identity"
    assert python_data["categories"][0]["items"][0]["content"] == "Bridge digest identity"


def test_python_module_memory_conflict_help_uses_the_ts_owner() -> None:
    """The historical conflict leaf must expose the canonical read-only options."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_conflict = subprocess.run(
        [sys.executable, "-m", "arforge", "memory", "conflict", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_conflict = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "memory", "conflict", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_conflict.returncode == typescript_conflict.returncode == 0
    assert python_conflict.stdout == typescript_conflict.stdout
    assert python_conflict.stderr == typescript_conflict.stderr
    assert "--conflict-limit" in python_conflict.stderr
    assert "只读" in python_conflict.stderr or "read-only" in python_conflict.stderr
    assert "Python" not in python_conflict.stderr


def test_python_module_memory_conflict_executes_the_ts_owner_without_scanning(tmp_path: Path) -> None:
    """The old conflict invocation shares the TS/Core report and remains non-mutating."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "memory-conflict.db"
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    seed = subprocess.run(
        [
            str(bun),
            "--conditions=browser",
            "packages/arforge/src/index.ts",
            "memory",
            "create",
            "Bridge conflict identity",
            "--type",
            "identity",
            "--workspace",
            str(tmp_path),
            "--json",
        ],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert seed.returncode == 0, seed.stderr

    args = ["memory", "conflict", "--workspace", str(tmp_path), "--json"]
    python_conflict = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_conflict = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_conflict.returncode == typescript_conflict.returncode == 0
    assert python_conflict.stderr == typescript_conflict.stderr
    python_data = json.loads(python_conflict.stdout)
    typescript_data = json.loads(typescript_conflict.stdout)
    assert python_data == typescript_data
    assert python_data["execution_mode"] == "read-only-core-conflict-report"
    assert python_data["persisted"]["count"] == 0
    assert python_data["relation_coverage"]["status"] == "not_comparable"
    assert not (home / "memory_conflict_benchmark.jsonl").exists()


def test_python_module_memory_metrics_help_uses_the_ts_owner() -> None:
    """The historical metrics leaf exposes the canonical read-only Core contract."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_metrics = subprocess.run(
        [sys.executable, "-m", "arforge", "memory", "metrics", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_metrics = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "memory", "metrics", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_metrics.returncode == typescript_metrics.returncode == 0
    assert python_metrics.stdout == typescript_metrics.stdout
    assert python_metrics.stderr == typescript_metrics.stderr
    assert "metrics" in python_metrics.stderr
    assert "--json" in python_metrics.stderr
    assert "Python" not in python_metrics.stderr


def test_python_module_memory_metrics_executes_the_ts_owner_without_legacy_writes(tmp_path: Path) -> None:
    """The old metrics invocation shares the Core read-only projection."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "memory-metrics.db"
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    args = ["memory", "metrics", "--workspace", str(tmp_path), "--json"]
    python_metrics = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_metrics = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_metrics.returncode == typescript_metrics.returncode == 0
    assert python_metrics.stderr == typescript_metrics.stderr
    python_data = json.loads(python_metrics.stdout)
    typescript_data = json.loads(typescript_metrics.stdout)
    python_data.pop("generated_at", None)
    typescript_data.pop("generated_at", None)
    assert python_data == typescript_data
    assert python_data["execution_mode"] == "read-only-core-memory-metrics"
    assert python_data["side_effects"] == "none"
    assert python_data["status"]["total"] == 0
    assert python_data["golden_eval"]["status"] == "not_comparable"
    assert python_data["history"]["status"] == "not_read"
    assert not (home / "memory_metrics.jsonl").exists()


def test_python_module_memory_write_stats_help_uses_the_ts_owner() -> None:
    """The historical write-stats leaf exposes the canonical read-only contract."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_stats = subprocess.run(
        [sys.executable, "-m", "arforge", "memory", "write-stats", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_stats = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "memory", "write-stats", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_stats.returncode == typescript_stats.returncode == 0
    assert python_stats.stdout == typescript_stats.stdout
    assert python_stats.stderr == typescript_stats.stderr
    assert "write-stats" in python_stats.stderr
    assert "--clear" in python_stats.stderr
    assert "read-only" in python_stats.stderr
    assert "Python" not in python_stats.stderr


def test_python_module_memory_write_stats_executes_the_ts_owner_without_legacy_writes(tmp_path: Path) -> None:
    """The old write-stats report shares the Core database projection only."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "memory-write-stats.db"
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    args = ["memory", "write-stats", "--workspace", str(tmp_path), "--json"]
    python_stats = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_stats = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_stats.returncode == typescript_stats.returncode == 0
    assert python_stats.stderr == typescript_stats.stderr
    python_data = json.loads(python_stats.stdout)
    typescript_data = json.loads(typescript_stats.stdout)
    python_data.pop("generated_at", None)
    typescript_data.pop("generated_at", None)
    assert python_data == typescript_data
    assert python_data["execution_mode"] == "read-only-core-memory-write-stats"
    assert python_data["side_effects"] == "none"
    assert python_data["database"]["total"] == 0
    assert python_data["decision_log"] == {
        "status": "not_read",
        "file": "memory_writes.jsonl",
        "reason": "TypeScript/Core 尚未接管旧 Python 写入决策事件 producer；不读取或创建该文件。",
    }
    assert python_data["clear"]["status"] == "unsupported"
    assert not (home / "memory_writes.jsonl").exists()


def test_python_module_memory_recovery_help_uses_the_ts_owner() -> None:
    """The historical recovery leaf exposes the canonical read-only contract."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_recovery = subprocess.run(
        [sys.executable, "-m", "arforge", "memory", "recovery", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_recovery = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "memory", "recovery", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_recovery.returncode == typescript_recovery.returncode == 0
    assert python_recovery.stdout == typescript_recovery.stdout
    assert python_recovery.stderr == typescript_recovery.stderr
    assert "recovery" in python_recovery.stderr
    assert "--clear" in python_recovery.stderr
    assert "read-only" in python_recovery.stderr
    assert "Python" not in python_recovery.stderr


def test_python_module_memory_recovery_executes_the_ts_owner_without_writes(tmp_path: Path) -> None:
    """The old recovery report shares the TS read-only log aggregation."""

    root = Path.cwd()
    bun = _target_bun(root)

    database = tmp_path / "memory-recovery.db"
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(database),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    args = ["memory", "recovery", "--workspace", str(tmp_path), "--json"]
    python_recovery = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_recovery = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_recovery.returncode == typescript_recovery.returncode == 0
    assert python_recovery.stderr == typescript_recovery.stderr
    assert json.loads(python_recovery.stdout) == json.loads(typescript_recovery.stdout)
    data = json.loads(python_recovery.stdout)
    assert data["execution_mode"] == "read-only-core-memory-recovery"
    assert data["side_effects"] == "none"
    assert data["source"] == {
        "status": "missing",
        "file": "recovery_outcomes.jsonl",
        "rows": 0,
        "corrupt_rows": 0,
    }
    assert data["events_total"] == 0
    assert data["clear"]["status"] == "unsupported"
    assert not (home / "recovery_outcomes.jsonl").exists()


def test_python_module_memory_feedback_help_uses_the_ts_owner() -> None:
    """The historical recall-feedback leaf exposes one explicit TS boundary."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_feedback = subprocess.run(
        [sys.executable, "-m", "arforge", "memory", "feedback", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_feedback = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "memory", "feedback", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_feedback.returncode == typescript_feedback.returncode == 0
    assert python_feedback.stdout == typescript_feedback.stdout
    assert python_feedback.stderr == typescript_feedback.stderr
    assert "retrieval-uid" in python_feedback.stderr
    assert "useful" in python_feedback.stderr
    assert "irrelevant" in python_feedback.stderr
    assert "Python" not in python_feedback.stderr


def test_python_module_memory_feedback_stays_fail_closed_without_legacy_writes(tmp_path: Path) -> None:
    """Both bridge and direct TS invocations reject unproven recall writes."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(tmp_path / "memory-feedback.db"),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    args = [
        "memory",
        "feedback",
        "retrieval-uid",
        "--useful",
        "1,2",
        "--irrelevant",
        "3",
        "--json",
    ]
    python_feedback = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_feedback = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_feedback.returncode == typescript_feedback.returncode == 2
    assert python_feedback.stdout == typescript_feedback.stdout == ""
    assert python_feedback.stderr == typescript_feedback.stderr
    assert "durable retrieval event" in python_feedback.stderr
    assert "不会写入 recall feedback" in python_feedback.stderr
    assert not (home / "memory_retrieval_events.jsonl").exists()


def test_python_module_memory_feedback_contract_audit_uses_the_ts_owner(tmp_path: Path) -> None:
    """The structured feedback audit must share the TS/Core report across entry points."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(tmp_path / "memory-feedback-audit.db"),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    args = ["memory", "feedback", "--contract-audit", "--workspace", str(home), "--json"]
    python_feedback = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_feedback = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_feedback.returncode == typescript_feedback.returncode == 0
    assert python_feedback.stdout == typescript_feedback.stdout
    assert python_feedback.stderr == typescript_feedback.stderr == ""
    payload = json.loads(python_feedback.stdout)
    assert payload["workspace"] == str(home)
    assert payload["execution_mode"] == "read-only-memory-feedback-contract-audit"
    assert payload["status"] == "not_ready"
    assert payload["side_effects"] == "none"
    assert payload["writes"] == 0
    assert "returned_set_validation" in payload["missing_requirements"]
    assert not (home / "memory_retrieval_events.jsonl").exists()


def test_python_module_multimodal_diagnose_help_uses_the_ts_owner() -> None:
    """The historical multimodal command exposes the canonical TS options."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_diagnose = subprocess.run(
        [sys.executable, "-m", "arforge", "multimodal-diagnose", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_diagnose = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "multimodal-diagnose", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_diagnose.returncode == typescript_diagnose.returncode == 0
    assert python_diagnose.stdout == typescript_diagnose.stdout
    assert python_diagnose.stderr == typescript_diagnose.stderr
    assert "--workspace" in python_diagnose.stderr
    assert "--text" in python_diagnose.stderr
    assert "--limit" in python_diagnose.stderr
    assert "--mode" in python_diagnose.stderr
    assert "Python" not in python_diagnose.stderr


def test_python_module_multimodal_diagnose_executes_the_ts_owner(tmp_path: Path) -> None:
    """Python and direct Bun entrypoints return the same typed local report."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "HOME": str(home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_AUTOCOMPACT": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    text = 'Traceback (most recent call last):\n  File "src/app.py", line 12, in main\nNameError: token is not defined'
    args = [
        "multimodal-diagnose",
        "diagnostic.txt",
        "--workspace",
        str(home),
        "--text",
        text,
        "--mode",
        "error",
        "--limit",
        "3",
        "--json",
    ]
    python_diagnose = subprocess.run(
        [sys.executable, "-m", "arforge", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_diagnose = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_diagnose.returncode == typescript_diagnose.returncode == 0
    assert python_diagnose.stderr == typescript_diagnose.stderr == ""
    assert json.loads(python_diagnose.stdout) == json.loads(typescript_diagnose.stdout)
    report = json.loads(python_diagnose.stdout)
    assert report["schemaVersion"] == 1
    assert report["localOnly"] is True
    assert report["modelCalls"] == 0
    assert report["source"]["type"] == "provided_text"
    assert report["summary"]["matches"] <= 3
    assert not (home / "diagnostic.txt").exists()


def test_python_module_features_help_uses_the_ts_owner() -> None:
    """The historical features command exposes the canonical TS options."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_features = subprocess.run(
        [sys.executable, "-m", "arforge", "features", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_features = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "features", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_features.returncode == typescript_features.returncode == 0
    assert python_features.stdout == typescript_features.stdout
    assert python_features.stderr == typescript_features.stderr
    assert "features" in python_features.stderr
    assert "--workspace" in python_features.stderr
    assert "--json" in python_features.stderr
    assert "Python" not in python_features.stderr


def test_python_module_features_executes_the_ts_owner_and_stays_fail_closed(tmp_path: Path) -> None:
    """Feature listing is shared; legacy mutations cannot write Python state."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "HOME": str(home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_AUTOCOMPACT": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    list_args = ["features", "list", "--workspace", str(home), "--json"]
    python_list = subprocess.run(
        [sys.executable, "-m", "arforge", *list_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_list = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *list_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_list.returncode == typescript_list.returncode == 0
    assert python_list.stderr == typescript_list.stderr == ""
    assert json.loads(python_list.stdout) == json.loads(typescript_list.stdout)
    payload = json.loads(python_list.stdout)
    assert payload["source"] == "typescript-core"
    assert any(item["flag_id"] == "file_history" for item in payload["items"])

    audit_args = ["features", "--contract-audit", "--workspace", str(home), "--json"]
    python_audit = subprocess.run(
        [sys.executable, "-m", "arforge", *audit_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_audit = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *audit_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_audit.returncode == typescript_audit.returncode == 0
    assert python_audit.stderr == typescript_audit.stderr == ""
    assert json.loads(python_audit.stdout) == json.loads(typescript_audit.stdout)
    audit_payload = json.loads(python_audit.stdout)
    assert audit_payload["execution_mode"] == "read-only-feature-policy-contract-audit"
    assert audit_payload["status"] == "not_ready"
    assert audit_payload["writes"] == 0
    assert "transactional_update" in audit_payload["missing_requirements"]
    assert "feature_flags.json" in audit_payload["caveat"]

    mutation_args = ["features", "set", "file_history", "off", "--workspace", str(home), "--json"]
    python_set = subprocess.run(
        [sys.executable, "-m", "arforge", *mutation_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_set = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *mutation_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_set.returncode == typescript_set.returncode == 2
    assert python_set.stdout == typescript_set.stdout == ""
    assert python_set.stderr == typescript_set.stderr
    assert "fail-closed" in python_set.stderr
    assert not (home / "feature_flags.json").exists()


def test_python_module_permissions_help_uses_the_ts_owner() -> None:
    """The historical permissions command exposes the canonical TS options."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_permissions = subprocess.run(
        [sys.executable, "-m", "arforge", "permissions", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_permissions = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "permissions", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_permissions.returncode == typescript_permissions.returncode == 0
    assert python_permissions.stdout == typescript_permissions.stdout
    assert python_permissions.stderr == typescript_permissions.stderr
    assert "permissions" in python_permissions.stderr
    assert "--workspace" in python_permissions.stderr
    assert "--json" in python_permissions.stderr
    assert "Python" not in python_permissions.stderr


def test_python_module_permissions_executes_the_ts_owner_and_stays_fail_closed(tmp_path: Path) -> None:
    """Saved-rule listing is shared; legacy writes cannot recreate Python state."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "HOME": str(home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_AUTOCOMPACT": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    list_args = ["permissions", "list", "--workspace", str(home), "--json"]
    python_list = subprocess.run(
        [sys.executable, "-m", "arforge", *list_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_list = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *list_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_list.returncode == typescript_list.returncode == 0
    assert python_list.stderr == typescript_list.stderr == ""
    assert json.loads(python_list.stdout) == json.loads(typescript_list.stdout)
    payload = json.loads(python_list.stdout)
    assert payload == {"schema_version": 1, "count": 0, "items": []}

    audit_args = ["permissions", "--contract-audit", "--workspace", str(home), "--json"]
    python_audit = subprocess.run(
        [sys.executable, "-m", "arforge", *audit_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_audit = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *audit_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_audit.returncode == typescript_audit.returncode == 0
    assert python_audit.stderr == typescript_audit.stderr == ""
    assert json.loads(python_audit.stdout) == json.loads(typescript_audit.stdout)
    audit_payload = json.loads(python_audit.stdout)
    assert audit_payload["execution_mode"] == "read-only-permission-policy-contract-audit"
    assert audit_payload["status"] == "not_ready"
    assert audit_payload["writes"] == 0
    assert "optimistic_revision" in audit_payload["missing_requirements"]
    assert "permission_rules.json" in audit_payload["caveat"]

    mutation_args = ["permissions", "add", "shell", "command", "allow", "--workspace", str(home)]
    python_add = subprocess.run(
        [sys.executable, "-m", "arforge", *mutation_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_add = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *mutation_args],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_add.returncode == typescript_add.returncode == 2
    assert python_add.stdout == typescript_add.stdout == ""
    assert python_add.stderr == typescript_add.stderr
    assert "fail-closed" in python_add.stderr
    assert "permissions list" in python_add.stderr


def test_python_module_feedback_command_uses_the_ts_owner() -> None:
    """Feedback compatibility invocations must expose the canonical TS command."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_feedback = subprocess.run(
        [sys.executable, "-m", "arforge", "feedback", "list", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_feedback = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "feedback", "list", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_feedback.returncode == typescript_feedback.returncode == 0
    assert python_feedback.stdout == typescript_feedback.stdout
    assert python_feedback.stderr == typescript_feedback.stderr
    assert "--feedback-id" in python_feedback.stderr
    assert "Python" not in python_feedback.stderr


def test_python_module_skills_command_uses_the_ts_owner() -> None:
    """The historical plural skills spelling must resolve to the TS owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_skills = subprocess.run(
        [sys.executable, "-m", "arforge", "skills", "route", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_skill = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "skill", "route", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_skills.returncode == typescript_skill.returncode == 0
    assert python_skills.stdout == typescript_skill.stdout
    assert python_skills.stderr == typescript_skill.stderr
    assert "route" in python_skills.stderr
    assert "Python" not in python_skills.stderr


def test_python_module_skills_list_executes_the_ts_owner(tmp_path: Path) -> None:
    """The historical plural skills list must return the canonical manifest projection."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
        "ARFORGE_CONFIG_CONTENT": '{"provider":{},"mcp":{}}',
    }
    legacy = ["skills", "list", "--json"]
    canonical = ["skill", "list", "--json"]
    python_skills = subprocess.run(
        [sys.executable, "-m", "arforge", *legacy],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_skills = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *canonical],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_skills.returncode == typescript_skills.returncode == 0
    assert python_skills.stderr == typescript_skills.stderr
    assert json.loads(python_skills.stdout) == json.loads(typescript_skills.stdout)
    payload = json.loads(python_skills.stdout)
    assert payload["count"] == payload["enabled_count"]
    assert any(item["id"] == "superpowers" for item in payload["items"])
    assert not (isolated_home / "skills_state.json").exists()


def test_python_module_plugins_command_uses_the_ts_owner() -> None:
    """The historical plural plugins spelling must expose the same help contract."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_plugins = subprocess.run(
        [sys.executable, "-m", "arforge", "plugins", "install", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_plugins = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "plugin-manager", "install", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_plugins.returncode == typescript_plugins.returncode == 0
    assert python_plugins.stdout == typescript_plugins.stdout
    assert python_plugins.stderr == typescript_plugins.stderr
    assert "install" in python_plugins.stderr
    assert "--name" in python_plugins.stderr
    assert "Python" not in python_plugins.stderr


def test_python_module_plugins_list_executes_the_ts_owner(tmp_path: Path) -> None:
    """The old plugins list/default/root forms must share one TS/Core report."""

    root = Path.cwd()
    bun = _target_bun(root)

    workspace = tmp_path / "workspace"
    plugin = workspace / ".arforge" / "plugins" / "bridge-tools"
    plugin.mkdir(parents=True)
    (plugin / "plugin.json").write_text(
        json.dumps(
            {
                "name": "bridge-tools",
                "version": "1.0.0",
                "description": "Bridge compatibility fixture.",
                "tools": [],
            }
        ),
        encoding="utf-8",
    )
    isolated_home = tmp_path / "home"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    legacy = ["plugins", "list", str(workspace / ".arforge" / "plugins"), "--json"]
    canonical = ["plugin-manager", "list", "--workspace", str(workspace), "--json"]
    python_plugins = subprocess.run(
        [sys.executable, "-m", "arforge", *legacy],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_plugins = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *canonical],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_plugins.returncode == typescript_plugins.returncode == 0
    assert python_plugins.stderr == typescript_plugins.stderr
    assert json.loads(python_plugins.stdout) == json.loads(typescript_plugins.stdout)
    assert json.loads(python_plugins.stdout)["items"][0]["name"] == "bridge-tools"


def test_python_module_agent_metrics_help_uses_the_ts_owner() -> None:
    """The historical agent-metrics entry must expose the typed TS contract."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_metrics = subprocess.run(
        [sys.executable, "-m", "arforge", "agent-metrics", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_metrics = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "agent-metrics", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_metrics.returncode == typescript_metrics.returncode == 0
    assert python_metrics.stdout == typescript_metrics.stdout
    assert python_metrics.stderr == typescript_metrics.stderr
    assert "history" in python_metrics.stderr
    assert "--clear" in python_metrics.stderr
    assert "Python" not in python_metrics.stderr


def test_python_module_agent_metrics_executes_the_ts_owner(tmp_path: Path) -> None:
    """The old report spelling reads the same profile-local TS/Core telemetry."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    (isolated_home / "dogfood.jsonl").write_text(
        "".join(
            json.dumps(row, ensure_ascii=False) + "\n"
            for row in (
                {"task": "one", "success": True, "tool_calls": 3, "modified_files": 0},
                {"task": "two", "success": False, "tool_calls": 1, "modified_files": 0},
            )
        ),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ["agent-metrics", "--json"]
    python_metrics = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_metrics = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_metrics.returncode == typescript_metrics.returncode == 0
    assert python_metrics.stderr == typescript_metrics.stderr
    python_data = json.loads(python_metrics.stdout)
    typescript_data = json.loads(typescript_metrics.stdout)
    python_data.pop("generated_at", None)
    typescript_data.pop("generated_at", None)
    assert python_data == typescript_data
    assert python_data["metrics"]["success_rate"]["value"] == 0.5
    assert python_data["metrics"]["avg_tool_calls"]["value"] == 2.0


def test_python_module_capabilities_test_help_uses_the_ts_owner() -> None:
    """The historical capability probe exposes the canonical TS preview help."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_capabilities = subprocess.run(
        [sys.executable, "-m", "arforge", "capabilities", "test", "plan", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_capabilities = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "capabilities", "test", "plan", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_capabilities.returncode == typescript_capabilities.returncode == 0
    assert python_capabilities.stdout == typescript_capabilities.stdout
    assert python_capabilities.stderr == typescript_capabilities.stderr
    assert "route-preview" in python_capabilities.stderr
    assert "--execute" in python_capabilities.stderr
    assert "Python" not in python_capabilities.stderr


def test_python_module_capabilities_test_executes_the_ts_route_owner(tmp_path: Path) -> None:
    """The old capabilities test spelling and direct TS invocation share one report."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ["capabilities", "test", "plan", "architecture", "and", "design", "--limit", "1", "--json"]
    python_capabilities = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_capabilities = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_capabilities.returncode == typescript_capabilities.returncode == 0
    assert python_capabilities.stderr == typescript_capabilities.stderr
    assert json.loads(python_capabilities.stdout) == json.loads(typescript_capabilities.stdout)
    report = json.loads(python_capabilities.stdout)
    assert report["execution_mode"] == "route-preview"
    assert report["executed"] == 0
    assert report["capabilities_used"] == ["planning"]


def test_python_module_capabilities_overview_uses_the_ts_owner(tmp_path: Path) -> None:
    """The overview projection must be identical through Python and direct Bun."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ["capabilities", "overview", "--workspace", str(tmp_path), "--json"]
    python_overview = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_overview = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_overview.returncode == typescript_overview.returncode == 0
    assert python_overview.stderr == typescript_overview.stderr
    assert json.loads(python_overview.stdout) == json.loads(typescript_overview.stdout)
    report = json.loads(python_overview.stdout)
    assert report["workspace"] == str(tmp_path)
    sections = {section["id"]: section for section in report["sections"]}
    assert sections["cost-optimization"]["data"]["execution_mode"] == (
        "read-only-cost-optimization-contract-audit"
    )
    assert sections["cost-optimization"]["data"]["status"] == "not_ready"
    assert sections["cost-optimization"]["data"]["side_effects"] == "none"


def test_python_module_privacy_json_uses_the_ts_owner_without_creating_profile_files(tmp_path: Path) -> None:
    """Privacy metadata is a read-only TS projection through every entrypoint."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ["privacy", "--json"]
    python_privacy = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_privacy = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_privacy.returncode == typescript_privacy.returncode == 0
    assert python_privacy.stdout == typescript_privacy.stdout
    assert python_privacy.stderr == typescript_privacy.stderr
    report = json.loads(python_privacy.stdout)
    assert report["schemaVersion"] == 1
    assert report["localFirst"] is True
    assert report["arforgeHome"] == str(isolated_home.resolve())
    assert report["inventory"]["files"] == 0
    assert report["inventory"]["bytes"] == 0
    assert not any(item.is_file() for item in isolated_home.rglob("*") if item.exists())


def test_python_module_role_tool_and_model_catalogs_use_the_ts_owner(tmp_path: Path) -> None:
    """Role, tool, and model catalogs share the canonical TS/Core runtime."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    config = {
        "model": "test/test-model",
        "formatter": False,
        "lsp": False,
        "provider": {
            "test": {
                "name": "Test",
                "id": "test",
                "env": [],
                "npm": "@ai-sdk/openai-compatible",
                "models": {
                    "test-model": {
                        "id": "test-model",
                        "name": "Test Model",
                        "attachment": False,
                        "reasoning": False,
                        "temperature": False,
                        "tool_call": True,
                        "release_date": "2025-01-01",
                        "limit": {"context": 100_000, "output": 10_000},
                        "cost": {"input": 0, "output": 0},
                        "options": {},
                    }
                },
                "options": {"apiKey": "test-key", "baseURL": "http://127.0.0.1:1"},
            }
        },
    }
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "HOME": str(isolated_home),
        "ARFORGE_CONFIG_CONTENT": json.dumps(config, ensure_ascii=False, separators=(",", ":")),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
        "ARFORGE_AUTH_CONTENT": "{}",
    }

    for argv in (("agents", "--json"), ("tools", "--json")):
        python_result = subprocess.run(
            [sys.executable, "-m", "arforge", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_result = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

        assert python_result.returncode == typescript_result.returncode == 0
        assert python_result.stderr == typescript_result.stderr
        assert json.loads(python_result.stdout) == json.loads(typescript_result.stdout)
        report = json.loads(python_result.stdout)
        assert report["count"] > 0
        assert report["items"]
        if argv[0] == "tools":
            assert report["agent"] == "build"
            assert report["provider"] == "test"
            assert report["model"] == "test-model"
        else:
            assert any(item["name"] == "build" for item in report["items"])
        assert "Python" not in python_result.stderr

    for argv in (("models",), ("agent", "list")):
        python_result = subprocess.run(
            [sys.executable, "-m", "arforge", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_result = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

        assert python_result.returncode == typescript_result.returncode == 0
        assert python_result.stdout == typescript_result.stdout
        assert python_result.stderr == typescript_result.stderr
        assert "Python" not in python_result.stderr
        if argv[0] == "models":
            assert "test/test-model" in python_result.stdout
        else:
            assert "build (primary)" in python_result.stdout


def test_python_module_doctor_and_status_help_use_the_ts_owner(tmp_path: Path) -> None:
    """Help inspection proves the aliases share TS parsing without live checks."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }

    for argv in (("doctor", "--help"), ("status", "--help")):
        python_result = subprocess.run(
            [sys.executable, "-m", "arforge", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_result = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

        assert python_result.returncode == typescript_result.returncode == 0
        assert python_result.stdout == typescript_result.stdout
        assert python_result.stderr == typescript_result.stderr
        assert "require-postgres" in python_result.stderr
        assert "Python" not in python_result.stderr


def test_python_module_mcp_list_empty_config_uses_the_ts_owner(tmp_path: Path) -> None:
    """An empty MCP catalog is a local read-only projection with no pings."""

    root = Path.cwd()
    bun = _target_bun(root)

    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "HOME": str(isolated_home),
        "ARFORGE_CONFIG_CONTENT": json.dumps({"mcp": {}}, separators=(",", ":")),
        "ARFORGE_AUTH_CONTENT": "{}",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ("mcp", "list")
    python_result = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_result = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_result.returncode == typescript_result.returncode == 0
    assert python_result.stdout == typescript_result.stdout
    assert python_result.stderr == typescript_result.stderr
    assert "No MCP servers configured" in python_result.stdout
    assert "Python" not in python_result.stderr


def test_python_module_sandbox_status_uses_the_ts_owner_without_running_a_task(tmp_path: Path) -> None:
    """The historical sandbox-status entry is a read-only TS/Core report."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home.mkdir()
    workspace.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "HOME": str(home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
        # Keep the Windows report deterministic and prove the unavailable
        # backend remains visible instead of being treated as full isolation.
        "ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE": "1",
    }
    argv = [
        "sandbox-status",
        "--workspace",
        str(workspace),
        "--cwd",
        str(workspace),
        "--profile",
        "read-only",
        "--network",
        "none",
        "--json",
    ]
    python_result = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_result = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_result.returncode == typescript_result.returncode == 0
    assert python_result.stdout == typescript_result.stdout
    assert python_result.stderr == typescript_result.stderr
    report = json.loads(python_result.stdout)
    assert report["runtime"] == "typescript"
    assert report["policy"] == {
        "profile": "read-only",
        "network": "none",
        "approved_roots": [str(workspace)],
    }
    assert report["enforcement"] == "unavailable"
    assert "不准备或执行子进程" in report["caveat"]
    assert "Python" not in python_result.stderr
    assert not any(item.is_file() for item in home.rglob("*") if item.exists())


def test_python_module_custom_agents_read_only_uses_the_typescript_owner(tmp_path: Path) -> None:
    """Custom-agent profile inspection is now a data-only TS/Core command."""

    root = Path.cwd()
    bun = _target_bun(root)

    profile_dir = tmp_path / ".arforge" / "agents"
    profile_dir.mkdir(parents=True)
    profile_path = profile_dir / "review.json"
    profile_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "name": "release-reviewer",
                "description": "Reviews release changes against the established engineering policy.",
                "system_prompt": "Review the supplied change carefully. Report concrete issues with evidence and do not bypass the active permission policy.",
                "tools": ["read_file"],
                "capabilities": ["code_review"],
                "max_steps": 6,
                "max_tokens": 2048,
                "timeout_seconds": 45,
            }
        ),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(tmp_path / "home"),
        "ARFORGE_TEST_HOME": str(tmp_path / "home"),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }

    for argv in (
        ["custom-agents", "list", "--workspace", str(tmp_path), "--json"],
        ["custom-agents", "validate", str(profile_path), "--workspace", str(tmp_path), "--json"],
    ):
        python_profiles = subprocess.run(
            [sys.executable, "-m", "arforge", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_profiles = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        assert python_profiles.returncode == typescript_profiles.returncode == 0
        assert python_profiles.stdout == typescript_profiles.stdout
        assert python_profiles.stderr == typescript_profiles.stderr == ""
        payload = json.loads(python_profiles.stdout)
        if argv[1] == "list":
            assert payload["profiles"][0]["role"] == "CustomAgent.release-reviewer"
            assert payload["errors"] == []
        else:
            assert payload["valid"] is True
            assert payload["profile"]["tools"] == ["read_file"]

    assert not (tmp_path / "home" / "state" / "bridge_state.db").exists()


def test_python_module_workspace_list_uses_the_typescript_owner(tmp_path: Path) -> None:
    """Workspace authorization inspection is a read-only TS/Core projection."""

    root = Path.cwd()
    bun = _target_bun(root)

    extra = tmp_path.parent / f"{tmp_path.name}-authorized-root"
    extra.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    (home / "trusted_workspaces.json").write_text(
        json.dumps({"workspaces": [str(tmp_path.resolve()), str(extra.resolve())]}),
        encoding="utf-8",
    )
    (home / "workspace_roots.json").write_text(
        json.dumps({"schema_version": 1, "roots": [str(extra), str(extra), str(tmp_path / "missing")]}),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
        "ARFORGE_TRUST_WORKSPACE": "",
    }
    argv = ["workspace", "list", "--workspace", str(tmp_path), "--json"]
    python_result = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_result = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_result.returncode == typescript_result.returncode == 0
    assert python_result.stdout == typescript_result.stdout
    assert python_result.stderr == typescript_result.stderr == ""
    payload = json.loads(python_result.stdout)
    assert payload == {
        "primary": str(tmp_path.resolve()),
        "roots": [
            {"path": str(tmp_path.resolve()), "primary": True, "trusted": True},
            {"path": str(extra.resolve()), "primary": False, "trusted": True},
        ],
    }

    audit_argv = ["workspace", "--contract-audit", "--workspace", str(tmp_path), "--json"]
    python_audit = subprocess.run(
        [sys.executable, "-m", "arforge", *audit_argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_audit = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *audit_argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_audit.returncode == typescript_audit.returncode == 0
    assert python_audit.stdout == typescript_audit.stdout
    assert python_audit.stderr == typescript_audit.stderr == ""
    audit = json.loads(python_audit.stdout)
    assert audit["execution_mode"] == "read-only-workspace-root-mutation-contract-audit"
    assert audit["writes"] == 0
    assert audit["decision"] == "fail-closed"

    missing_argv = ["workspace", "list", "--workspace", str(tmp_path / "missing"), "--json"]
    python_missing = subprocess.run(
        [sys.executable, "-m", "arforge", *missing_argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_missing = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *missing_argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_missing.returncode == typescript_missing.returncode == 2
    assert python_missing.stdout == typescript_missing.stdout == ""
    assert python_missing.stderr == typescript_missing.stderr
    assert "workspace must be an existing directory" in python_missing.stderr
    assert not (home / "state" / "bridge_state.db").exists()


def test_legacy_workspace_handler_delegates_to_typescript_without_local_state(monkeypatch, tmp_path, capsys) -> None:
    """Direct legacy callers must not regain a Python workspace writer."""

    from arforge import cli, cli_compat

    observed: dict[str, object] = {}

    def fake_invoke(argv, **kwargs):
        observed["argv"] = list(argv)
        observed["kwargs"] = kwargs
        return SimpleNamespace(returncode=3, stdout="ts-output\n", stderr="ts-error\n")

    monkeypatch.setattr(cli_compat, "invoke", fake_invoke)
    monkeypatch.chdir(tmp_path)

    assert cli._run_workspace(["trust", str(tmp_path)], json_output=True) == 3
    assert observed["argv"] == ["workspace", "trust", str(tmp_path), "--json"]
    kwargs = observed["kwargs"]
    assert kwargs["cwd"] == str(tmp_path.resolve())
    assert kwargs["env"]["ARFORGE_DB"] == ":memory:"
    assert kwargs["env"]["DATABASE_URL"] == ""
    captured = capsys.readouterr()
    assert captured.out == "ts-output\n"
    assert captured.err == "ts-error\n"


def test_legacy_entry_flow_uses_typescript_trust_projection_and_fails_closed(monkeypatch, tmp_path, capsys) -> None:
    """The importable Python entry helper must not resurrect the trust screen writer."""

    from arforge import cli
    import arforge.custom_agent_profiles as profiles

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(profiles, "typescript_workspace_trusted", lambda _workspace: False)

    assert cli._entry_flow("zh", quiet=True) is False
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "不会再写入工作区信任状态" in captured.err
    assert "TypeScript CLI/Core" in captured.err
    assert not (tmp_path / "trusted_workspaces.json").exists()


def test_cli_compat_capture_adapter_runs_the_real_ts_help(tmp_path: Path, monkeypatch) -> None:
    """The documented facade works for an actual embedded host, not only mocks."""

    from arforge import cli_compat

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    monkeypatch.setenv("ARFORGE_BUN", str(bun))
    result = cli_compat.invoke(
        ["--help"],
        cwd=root,
        env={"NO_COLOR": "1", "ARFORGE_HOME": str(home)},
    )

    assert result.returncode == 0
    assert result.argv == ("--help",)
    assert result.command[0] == str(bun)
    assert result.stdout == ""
    assert "arforge" in result.stderr.lower()
    assert "Python" not in result.stderr
    assert result.timed_out is False
    assert not any(item.is_file() for item in home.rglob("*") if item.exists())


def test_python_module_repo_scale_legacy_syntax_uses_the_ts_owner() -> None:
    """The historical path/--query form must expose the canonical TS command."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_repo_scale = subprocess.run(
        [sys.executable, "-m", "arforge", "repo-scale", "legacy-repo", "--query", "needle", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_repo_scale = subprocess.run(
        [
            str(bun),
            "--conditions=browser",
            "packages/arforge/src/index.ts",
            "repo-scale",
            "legacy-repo",
            "--query",
            "needle",
            "--help",
        ],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_repo_scale.returncode == typescript_repo_scale.returncode == 0
    assert python_repo_scale.stdout == typescript_repo_scale.stdout
    assert python_repo_scale.stderr == typescript_repo_scale.stderr
    assert "--query" in python_repo_scale.stderr


def test_python_module_repo_scale_legacy_path_executes_the_ts_owner(tmp_path: Path) -> None:
    """The old path/--query invocation must scan through the TS Core owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    target = tmp_path / "legacy-repo"
    target.mkdir()
    (target / "index.ts").write_text("export const legacyNeedle = true\n", encoding="utf-8")
    isolated_home = tmp_path / "home"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = [
        "repo-scale",
        str(target),
        "--query",
        "legacyNeedle",
        "--max-files",
        "10",
        "--limit",
        "5",
        "--json",
    ]
    python_repo_scale = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_repo_scale = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_repo_scale.returncode == typescript_repo_scale.returncode == 0
    assert python_repo_scale.stderr == typescript_repo_scale.stderr
    python_data = json.loads(python_repo_scale.stdout)
    typescript_data = json.loads(typescript_repo_scale.stdout)
    # Scan duration is intentionally measured at runtime and can differ by a
    # few milliseconds between the bridge child and the direct TS child. All
    # report semantics must still be identical.
    python_scan_time = python_data["scan"].pop("scan_time_ms")
    typescript_scan_time = typescript_data["scan"].pop("scan_time_ms")
    assert isinstance(python_scan_time, int) and python_scan_time >= 0
    assert isinstance(typescript_scan_time, int) and typescript_scan_time >= 0
    assert python_data == typescript_data
    assert python_data["root"] == str(target.resolve())
    assert python_data["search"]["items"][0]["path"] == "index.ts"


def test_python_module_quality_legacy_patch_help_uses_the_ts_owner() -> None:
    """The historical quality patch spelling must expose the canonical help surface."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    python_quality = subprocess.run(
        [sys.executable, "-m", "arforge", "quality", "change.diff", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_quality = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "quality", "change.diff", "--help"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_quality.returncode == typescript_quality.returncode == 0
    assert python_quality.stdout == typescript_quality.stdout
    assert python_quality.stderr == typescript_quality.stderr
    assert ".diff" in python_quality.stderr
    assert "--patch-file" in python_quality.stderr


def test_python_module_quality_legacy_patch_executes_the_ts_owner(tmp_path: Path) -> None:
    """The old positional patch invocation must read and assess through TS/Core."""

    root = Path.cwd()
    bun = _target_bun(root)

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "module.ts").write_text("export const answer = 42\n", encoding="utf-8")
    patch = workspace / "change.diff"
    patch.write_text(
        """diff --git a/module.ts b/module.ts
index 1111111..2222222 100644
--- a/module.ts
+++ b/module.ts
@@ -1 +1 @@
-export const answer = 41
+export const answer = 42
""",
        encoding="utf-8",
    )
    isolated_home = tmp_path / "home"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(isolated_home),
        "ARFORGE_TEST_HOME": str(isolated_home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ["quality", str(patch), "--workspace", str(workspace), "--json"]
    python_quality = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_quality = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_quality.returncode == typescript_quality.returncode == 0
    assert python_quality.stderr == typescript_quality.stderr
    assert json.loads(python_quality.stdout) == json.loads(typescript_quality.stdout)
    report = json.loads(python_quality.stdout)
    assert report["diff_stats"]["files"] == ["module.ts"]
    assert report["diff_stats"]["additions"] == 1
    assert report["diff_stats"]["deletions"] == 1
    assert report["files_checked"] == 1


def test_python_module_workflows_supported_actions_use_the_ts_owner(tmp_path: Path) -> None:
    """The supported historical workflows actions share the typed workflow owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(tmp_path / "workflows.db"),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }

    for argv in (
        ["workflows", "list", "--workspace", str(tmp_path), "--json"],
        ["workflows", "--workspace", str(tmp_path), "--json"],
        ["workflows", "validate", ".arforge/workflows/checkpoint.json", "--workspace", str(tmp_path), "--json"],
        ["workflows", "runs", "--workspace", str(tmp_path), "--json"],
        ["workflows", "events", "run_missing", "--workspace", str(tmp_path), "--json"],
    ):
        python_workflows = subprocess.run(
            [sys.executable, "-m", "arforge", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_workflows = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        assert python_workflows.returncode == typescript_workflows.returncode
        assert python_workflows.stdout == typescript_workflows.stdout
        assert python_workflows.stderr == typescript_workflows.stderr
        assert "Python 历史命令" not in python_workflows.stderr

    assert json.loads(
        subprocess.run(
            [sys.executable, "-m", "arforge", "workflows", "list", "--workspace", str(tmp_path), "--json"],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        ).stdout,
    )["schema_version"] == 1


def test_python_module_workflows_run_report_uses_the_typescript_owner(tmp_path: Path) -> None:
    """The historical run/report spelling shares the typed workflow owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    workflow_dir = tmp_path / ".arforge" / "workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "checkpoint.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "name": "checkpoint_flow",
                "steps": [{"id": "done", "title": "Done", "kind": "checkpoint", "prompt": "finished"}],
            }
        ),
        encoding="utf-8",
    )
    report_path = tmp_path / "reports" / "preview.json"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(tmp_path / "home"),
        "ARFORGE_TEST_HOME": str(tmp_path / "home"),
        "ARFORGE_DB": str(tmp_path / "workflows.db"),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = [
        "workflows",
        "run",
        ".arforge/workflows/checkpoint.json",
        "--workspace",
        str(tmp_path),
        "--report",
        str(report_path),
        "--json",
    ]
    python_workflows = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_workflows = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert python_workflows.returncode == typescript_workflows.returncode == 0
    assert python_workflows.stdout == typescript_workflows.stdout
    assert python_workflows.stderr == typescript_workflows.stderr
    assert "Python 历史命令" not in python_workflows.stderr
    assert json.loads(python_workflows.stdout) == {
        "name": "checkpoint_flow",
        "source_path": ".arforge/workflows/checkpoint.json",
        "success": True,
        "dry_run": True,
        "steps": [
            {
                "id": "done",
                "title": "Done",
                "status": "planned",
                "output": "depends_on: none",
                "error": "",
            }
        ],
        "report_path": str(report_path),
    }


def test_python_module_db_current_uses_the_typescript_migration_owner(tmp_path: Path) -> None:
    """The read-only database revision query must not reopen the Python migration loop."""

    root = Path.cwd()
    bun = _target_bun(root)

    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(tmp_path / "home"),
        "ARFORGE_TEST_HOME": str(tmp_path / "home"),
        "ARFORGE_DB": str(tmp_path / "db-current.sqlite"),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }

    bootstrap = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "db", "select 1"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert bootstrap.returncode == 0

    for argv in (
        ["db", "current", "--json"],
        ["db-current", "--json"],
    ):
        python_current = subprocess.run(
            [sys.executable, "-m", "arforge", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        typescript_current = subprocess.run(
            [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
            cwd=root,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )
        assert python_current.returncode == typescript_current.returncode == 0
        assert python_current.stdout == typescript_current.stdout
        assert python_current.stderr == typescript_current.stderr == ""
        payload = json.loads(python_current.stdout)
        assert payload["database"] == "main"
        assert payload["schema_version"] == 1
        assert payload["source"] == "typescript-migration-ledger"
        assert payload["pending"] == []

    blocked = subprocess.run(
        [sys.executable, "-m", "arforge", "db-current", "multiagent", "--json"],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert blocked.returncode == 2
    assert blocked.stdout == ""
    assert "multiagent" in blocked.stderr
    assert "TypeScript" in blocked.stderr


def test_python_module_db_path_uses_the_typescript_database_owner(tmp_path: Path) -> None:
    """The legacy ``db path`` spelling must resolve through the TS database owner."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DB": str(tmp_path / "db-path.sqlite"),
        "ARFORGE_DB_URL": "",
        "ARFORGE_DB_ADMIN_URL": "",
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }
    argv = ["db", "path"]
    python_path = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_path = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_path.returncode == typescript_path.returncode == 0
    assert python_path.stdout == typescript_path.stdout
    assert python_path.stderr == typescript_path.stderr == ""
    database_path = python_path.stdout.strip()
    assert database_path == str(tmp_path / "db-path.sqlite")
    assert not (home / "state" / "bridge_state.db").exists()


def test_python_module_replay_alias_uses_the_run_history_typescript_owner(tmp_path: Path) -> None:
    """The historical replay spelling must be the same read-only Core report."""

    root = Path.cwd()
    bun = _target_bun(root)

    home = tmp_path / "home"
    runs = home / "runs"
    runs.mkdir(parents=True)
    (runs / "run-replay-alias.json").write_text(
        json.dumps(
            {
                "run_id": "run-replay-alias",
                "created": "2026-09-01 10:00:00",
                "entries": [{"path": "workspace/note.txt", "original": "before"}],
            }
        ),
        encoding="utf-8",
    )
    (runs / "run-replay-alias.trace.json").write_text(
        json.dumps(
            {
                "run_id": "run-replay-alias",
                "created": "2026-09-01 10:00:00",
                "trace": [{"event": "tool", "tool": "read_file", "success": True}],
                "answer": "already completed",
            }
        ),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "ARFORGE_BUN": str(bun),
        "ARFORGE_HOME": str(home),
        "ARFORGE_TEST_HOME": str(home),
        "ARFORGE_DISABLE_PROJECT_CONFIG": "1",
        "ARFORGE_PURE": "1",
        "ARFORGE_DISABLE_AUTOUPDATE": "1",
        "ARFORGE_DISABLE_MODELS_FETCH": "1",
    }

    argv = ["replay", "run-replay-alias", "--json"]
    python_replay = subprocess.run(
        [sys.executable, "-m", "arforge", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    typescript_replay = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", *argv],
        cwd=root,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert python_replay.returncode == typescript_replay.returncode == 0
    assert python_replay.stdout == typescript_replay.stdout
    assert python_replay.stderr == typescript_replay.stderr
    payload = json.loads(python_replay.stdout)
    assert payload["found"] is True
    assert payload["report"]["trace_events"] == 1
    assert payload["report"]["changed_files"] == ["workspace/note.txt"]
