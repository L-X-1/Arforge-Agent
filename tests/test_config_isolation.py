"""Configuration source isolation tests."""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path


def test_config_has_no_implicit_dotenv_search():
    source = Path("config.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    implicit_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "load_dotenv"
        and not node.args
        and not node.keywords
    ]
    assert not implicit_calls
    assert "find_dotenv" not in source
    assert "get_config_file_status" in source
    dotenv_calls = [
        call
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "load_dotenv"
    ]
    assert all(call.args for call in dotenv_calls)


def test_arforge_home_isolates_user_configuration(tmp_path):
    isolated_home = tmp_path / "profile"
    isolated_home.mkdir()
    (isolated_home / ".env").write_text(
        "DEEPSEEK_MODEL=custom-user-model\n", encoding="utf-8"
    )
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    env = os.environ.copy()
    env["ARFORGE_HOME"] = str(isolated_home)
    env.pop("DEEPSEEK_MODEL", None)

    result = subprocess.run(
        [sys.executable, "-c", "import config; print(config.DEEPSEEK_MODEL)"],
        cwd=workdir,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "custom-user-model"


def test_private_profile_configuration_precedes_workspace_dotenv(tmp_path):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / ".env").write_text(
        "DEEPSEEK_MODEL=private-profile-model\n", encoding="utf-8"
    )
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / ".env").write_text(
        "DEEPSEEK_MODEL=workspace-model\n", encoding="utf-8"
    )
    env = os.environ.copy()
    env["ARFORGE_HOME"] = str(profile)
    env.pop("ARFORGE_ENV_FILE", None)
    env.pop("DEEPSEEK_MODEL", None)

    result = subprocess.run(
        [sys.executable, "-c", "import config; print(config.DEEPSEEK_MODEL)"],
        cwd=workdir,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "private-profile-model"


def test_explicit_configuration_precedes_profile_and_workspace(tmp_path):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / ".env").write_text(
        "DEEPSEEK_MODEL=private-profile-model\n", encoding="utf-8"
    )
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / ".env").write_text(
        "DEEPSEEK_MODEL=workspace-model\n", encoding="utf-8"
    )
    explicit = tmp_path / "operator.env"
    explicit.write_text("DEEPSEEK_MODEL=explicit-model\n", encoding="utf-8")
    env = os.environ.copy()
    env["ARFORGE_HOME"] = str(profile)
    env["ARFORGE_ENV_FILE"] = str(explicit)
    env.pop("DEEPSEEK_MODEL", None)

    result = subprocess.run(
        [sys.executable, "-c", "import config; print(config.DEEPSEEK_MODEL)"],
        cwd=workdir,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "explicit-model"


def test_missing_explicit_configuration_fails_closed(tmp_path):
    env = os.environ.copy()
    env["ARFORGE_HOME"] = str(tmp_path / "profile")
    env["ARFORGE_ENV_FILE"] = str(tmp_path / "missing.env")

    result = subprocess.run(
        [sys.executable, "-c", "import config"],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "ARFORGE_ENV_FILE does not exist" in result.stderr


def test_default_model_is_product_test_baseline(tmp_path):
    env = os.environ.copy()
    env["ARFORGE_HOME"] = str(tmp_path / "empty-profile")
    env.pop("DEEPSEEK_MODEL", None)
    result = subprocess.run(
        [sys.executable, "-c", "import config; print(config.DEEPSEEK_MODEL)"],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "deepseek-v4-flash"
