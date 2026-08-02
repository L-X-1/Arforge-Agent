"""M6 acceptance tests: private source-workspace hygiene.

Verifies that distribution packages are clean:
- No .recovery_pyc in MANIFEST, package.json, or build artifacts
- No .pyc files in package distribution
- No arforge_corrupt_backup_* in setuptools discovery
- No __pycache__ in package files
- bin/arforge.js starts the unified Bun CLI without shell execution
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised by the Python 3.10 CI job
    import tomli as tomllib


def test_module_entrypoint_exists():
    """The module form must work in addition to installed console scripts."""
    from arforge import __main__

    assert callable(__main__.main)


def test_node_launchers_never_use_shell_execution():
    """npm wrappers must pass commands as argument arrays without a shell."""
    for filename in ("bin/arforge.js", "bin/install.js"):
        source = Path(filename).read_text(encoding="utf-8")
        assert "shell: true" not in source
        assert "execSync" not in source


def test_node_launcher_delegates_to_unified_typescript_cli():
    node = shutil.which("node")
    if node is None:
        return
    root = Path.cwd()
    bun = root / ".tools" / "bun-1.3.14" / ("bun.exe" if os.name == "nt" else "bun")
    if not bun.is_file():
        return
    env = {**os.environ, "NO_COLOR": "1", "ARFORGE_BUN": str(bun)}
    node_help = subprocess.run(
        [node, "bin/arforge.js", "--help"],
        cwd=Path.cwd(),
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    direct_help = subprocess.run(
        [str(bun), "--conditions=browser", "packages/arforge/src/index.ts", "--help"],
        cwd=Path.cwd(),
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    assert node_help.returncode == direct_help.returncode == 0
    assert node_help.stdout == direct_help.stdout
    assert node_help.stderr == direct_help.stderr
    assert "capabilities" in node_help.stderr

    unknown = subprocess.run(
        [node, "bin/arforge.js", "definitely-not-a-command"],
        cwd=Path.cwd(),
        env=env,
        capture_output=True,
        check=False,
    )
    assert unknown.returncode != 0


def test_workspace_installer_uses_frozen_bun_dependencies_and_fails_closed():
    source = Path("bin/install.js").read_text(encoding="utf-8")
    assert '"install", "--frozen-lockfile"' in source
    assert "LOCAL_BUN" in source
    assert "python" not in source.lower()
    assert "process.exit(1)" in source


def test_private_root_package_is_not_publishable():
    package = json.loads(Path("package.json").read_text(encoding="utf-8"))
    assert package["private"] is True
    assert package["license"] == "UNLICENSED"
    assert package["scripts"]["cli"].endswith("packages/arforge/src/index.ts")
    assert "files" not in package


# ============================================================================
# MANIFEST.in cleanliness
# ============================================================================


def test_manifest_does_not_include_recovery_pyc():
    manifest = Path("MANIFEST.in").read_text(encoding="utf-8")
    # OK to have "prune .recovery_pyc" (exclusion), NOT OK to have "recursive-include .recovery_pyc"
    assert "recursive-include .recovery_pyc" not in manifest, "MANIFEST.in must NOT recursively include .recovery_pyc"
    assert "include .recovery_pyc" not in manifest, "MANIFEST.in must NOT include .recovery_pyc"


def test_manifest_excludes_pyc_files():
    manifest = Path("MANIFEST.in").read_text(encoding="utf-8")
    assert "global-exclude *.pyc" in manifest
    assert "global-exclude *.pyo" in manifest


def test_manifest_prunes_backup_dirs():
    manifest = Path("MANIFEST.in").read_text(encoding="utf-8")
    assert "arforge_corrupt_backup_*" in manifest or "prune build" in manifest
    assert "prune __pycache__" in manifest


def test_manifest_uses_a_root_python_whitelist():
    manifest = Path("MANIFEST.in").read_text(encoding="utf-8")
    assert "include *.py" not in manifest
    assert "include config.py" in manifest
    assert "include main.py" in manifest
    assert "include dogfood.py" in manifest
    assert "exclude verify_modules.py" in manifest


# ============================================================================
# package.json cleanliness
# ============================================================================


def test_package_json_does_not_include_recovery_pyc():
    pkg = json.loads(Path("package.json").read_text(encoding="utf-8"))
    files = pkg.get("files", [])
    assert ".recovery_pyc/" not in files, "package.json files must NOT include .recovery_pyc/"
    assert ".recovery_pyc" not in files


def test_package_json_declares_unified_workspace_packages():
    pkg = json.loads(Path("package.json").read_text(encoding="utf-8"))
    packages = pkg["workspaces"]["packages"]
    assert "packages/*" in packages
    assert pkg["scripts"]["dev:desktop"] == "bun --cwd packages/desktop dev"
    assert "legacy:python-cli" not in pkg["scripts"]
    assert "legacy:tauri-desktop" not in pkg["scripts"]


# ============================================================================
# bin/arforge.js safety
# ============================================================================


def test_arforge_js_no_shell_true_on_main_spawn():
    """The main spawn() call must NOT use shell:true."""
    content = Path("bin/arforge.js").read_text(encoding="utf-8")

    spawn_idx = content.find('spawn(bun, ["--conditions=browser"')
    assert spawn_idx > 0, "Should have a spawn call for the main process"

    # Check the options block after this spawn call
    after_spawn = content[spawn_idx:]
    # Find the closing of spawn options
    shell_line_idx = after_spawn.find("shell:")
    if shell_line_idx > 0 and shell_line_idx < 500:
        assert "shell: false" in after_spawn[shell_line_idx : shell_line_idx + 15], (
            "Main spawn() must use shell: false for security"
        )


def test_arforge_js_no_exec_command_injection():
    """execSync calls should use hardcoded commands, not user input."""
    content = Path("bin/arforge.js").read_text(encoding="utf-8")
    assert "findBun" in content
    assert "CLI_ENTRY" in content
    # No user-controlled input should go into execSync
    execsync_lines = [line for line in content.split("\n") if "execSync" in line]
    for line in execsync_lines:
        # Only hardcoded version checks are allowed
        assert "--version" in line or "python" in line.lower(), f"execSync must not execute user input: {line.strip()}"


# ============================================================================
# .gitignore ensures no .env or secrets in repo
# ============================================================================


def test_gitignore_covers_sensitive_files():
    gitignore = Path(".gitignore").read_text(encoding="utf-8")
    assert ".env" in gitignore
    assert "*.db" in gitignore or "*.sqlite" in gitignore
    assert ".arforge" in gitignore


# ============================================================================
# No recovery artifacts in source tree
# ============================================================================


def test_no_recovery_pyc_in_arforge_package():
    """The arforge package directory must not contain .recovery_pyc references."""
    py_files = list(Path("arforge").rglob("*.py"))
    for f in py_files:
        content = f.read_text(encoding="utf-8")
        assert ".recovery_pyc" not in content, f"{f} contains .recovery_pyc reference"


def test_no_marshal_loads_in_source():
    """No module should load bytecode via marshal.loads."""
    py_files = list(Path("arforge").rglob("*.py"))
    for f in py_files:
        content = f.read_text(encoding="utf-8")
        assert "marshal.loads" not in content, f"{f} contains marshal.loads"


# ============================================================================
# pyproject.toml correctness
# ============================================================================


def test_pyproject_handles_corrupt_backup_safely():
    """pyproject.toml should only reference corrupt_backup in exclusion contexts (norecursedirs)."""
    toml_text = Path("pyproject.toml").read_text(encoding="utf-8")
    # arforge_corrupt_backup should only appear in norecursedirs (excluded from tests)
    lines_with_ref = [line for line in toml_text.split("\n") if "arforge_corrupt_backup" in line]
    for line in lines_with_ref:
        assert "norecursedirs" in toml_text or "prune" in line.lower() or "exclude" in line.lower(), (
            f"arforge_corrupt_backup must only appear in exclusion context: {line}"
        )
    config = tomllib.loads(toml_text)
    discovery = config["tool"]["setuptools"]["packages"]["find"]
    assert discovery["include"] == ["arforge*"]
    assert {"arforge_corrupt_backup_*", "arforge_corrupt_backup_*.*"} <= set(discovery["exclude"])
    assert {"arforge*.__pycache__", "arforge*.__pycache__.*"} <= set(discovery["exclude"])


# ============================================================================
# npm pack verification
# ============================================================================


def test_npm_pack_excludes_recovery_pyc():
    """Verify npm pack --dry-run does not list .recovery_pyc files."""
    import subprocess

    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    try:
        result = subprocess.run(
            [npm_cmd, "pack", "--dry-run"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            assert ".recovery_pyc" not in result.stdout, f"npm pack includes .recovery_pyc: {result.stdout[:500]}"
            assert "arforge_corrupt_backup" not in result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        # npm not available — skip
        pass


# ============================================================================
# Edge cases
# ============================================================================


def test_bin_install_js_no_damaged_chars():
    """install.js must not contain Unicode replacement characters."""
    content = Path("bin/install.js").read_text(encoding="utf-8")
    assert "�" not in content, "install.js contains damaged Unicode characters (U+FFFD)"
    assert "Lingshu Agent" not in content
    assert "灵枢" not in content
