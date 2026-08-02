from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop launcher uses PowerShell")


def test_desktop_launcher_resolves_default_workspace_without_starting_app(tmp_path):
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(root / "scripts" / "run_desktop.ps1"),
            "-ValidateOnly",
        ],
        cwd=tmp_path,
        env={**os.environ, "LOCALAPPDATA": str(tmp_path / "local-app-data")},
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert f"workspace={root}" in completed.stdout
    assert "mode=Dev" in completed.stdout
    assert "desktop=Electron" in completed.stdout
    assert str(root / ".tools" / "bun-1.3.14" / "bun.exe") in completed.stdout
    assert "electron.exe" in completed.stdout


def test_python_desktop_launcher_is_pycharm_safe(tmp_path):
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [sys.executable, str(root / "run_desktop.py"), "--validate-only"],
        cwd=tmp_path,
        env={**os.environ, "LOCALAPPDATA": str(tmp_path / "local-app-data")},
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert f"workspace={root}" in completed.stdout
    assert "mode=Dev" in completed.stdout
    assert "desktop=Electron" in completed.stdout
    private_config_exists = (Path.home() / ".arforge" / ".env").is_file()
    assert f"private_config_exists={private_config_exists}" in completed.stdout


def test_legacy_installed_mode_is_not_a_unified_launcher_option(tmp_path):
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(root / "scripts" / "run_desktop.ps1"), "-Mode", "Installed", "-ValidateOnly",
        ],
        cwd=tmp_path,
        env={**os.environ, "LOCALAPPDATA": str(tmp_path / "local-app-data")},
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode != 0
    assert "Installed" in completed.stderr
