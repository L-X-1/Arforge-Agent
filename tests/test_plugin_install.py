from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from arforge.plugin_install import PluginInstallError, PluginInstallRuntime


def _plugin(root: Path, name: str = "sample", version: str = "1.0.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "entry.py").write_text(
        "def create_plugin(manifest):\n"
        "    raise RuntimeError('installation must not execute plugin code')\n",
        encoding="utf-8",
    )
    (root / "plugin.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": version,
                "description": "Test plugin",
                "entrypoint": "entry.py:create_plugin",
                "enabled": True,
            }
        ),
        encoding="utf-8",
    )
    return root


def test_local_plugin_install_is_inspected_and_installed_disabled(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    source = _plugin(tmp_path / "source")
    runtime = PluginInstallRuntime(profile)

    inspection = runtime.inspect(str(source))
    result = runtime.apply(inspection["token"])

    assert inspection["selection_required"] is False
    assert inspection["candidates"][0]["name"] == "sample"
    assert result["enabled"] is False
    assert (profile / "plugins" / "sample" / "plugin.json").is_file()
    state = json.loads((profile / "config" / "plugin_state.json").read_text(encoding="utf-8"))
    assert next(iter(state["enabled_overrides"].values())) is False


def test_multi_plugin_package_requires_selection(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    package = tmp_path / "package"
    _plugin(package / "alpha", "alpha")
    _plugin(package / "beta", "beta")
    runtime = PluginInstallRuntime(profile)

    inspection = runtime.inspect(str(package))

    assert inspection["selection_required"] is True
    with pytest.raises(PluginInstallError, match="select one plugin"):
        runtime.apply(inspection["token"])
    installed = runtime.apply(inspection["token"], "beta")
    assert installed["name"] == "beta"


def test_inspection_token_cannot_apply_mutated_staging_files(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    runtime = PluginInstallRuntime(profile)
    inspection = runtime.inspect(str(_plugin(tmp_path / "source")))
    staged_entry = profile / "cache" / "plugin-installs" / inspection["token"] / "payload" / "entry.py"
    staged_entry.write_text("raise RuntimeError('changed after inspection')\n", encoding="utf-8")

    with pytest.raises(PluginInstallError, match="changed before installation"):
        runtime.apply(inspection["token"])

    assert not (profile / "plugins" / "sample").exists()


def test_update_and_remove_keep_recoverable_copies(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    runtime = PluginInstallRuntime(profile)
    first = runtime.inspect(str(_plugin(tmp_path / "v1", version="1.0.0")))
    runtime.apply(first["token"])
    second = runtime.inspect(str(_plugin(tmp_path / "v2", version="2.0.0")))

    updated = runtime.apply(second["token"], replace=True)
    removed = runtime.remove("sample")
    restored = runtime.restore(removed["recovery"]["recovery_id"])

    assert updated["updated"] is True
    assert updated["recovery"]["reason"] == "update"
    assert removed["recoverable"] is True
    assert restored["restored"] is True
    manifest = json.loads((profile / "plugins" / "sample" / "plugin.json").read_text(encoding="utf-8"))
    assert manifest["version"] == "2.0.0"


def test_zip_path_traversal_is_rejected(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("../outside.txt", "escape")

    with pytest.raises(PluginInstallError, match="path traversal"):
        PluginInstallRuntime(profile).inspect(str(archive))

    assert not (tmp_path / "outside.txt").exists()


def test_valid_zip_and_insecure_remote_source_contract(monkeypatch, tmp_path):
    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    source = _plugin(tmp_path / "zip-source")
    archive = tmp_path / "plugin.zip"
    with zipfile.ZipFile(archive, "w") as package:
        for path in source.rglob("*"):
            if path.is_file():
                package.write(path, path.relative_to(source).as_posix())

    runtime = PluginInstallRuntime(profile)
    inspected = runtime.inspect(str(archive))
    assert runtime.apply(inspected["token"])["name"] == "sample"
    with pytest.raises(PluginInstallError, match="HTTPS"):
        runtime.inspect("http://example.test/plugin.zip")


def test_git_source_supports_explicit_ref_and_safe_subdirectory(monkeypatch, tmp_path):
    import urllib.parse
    import arforge.plugin_install as installer_module

    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    seen = {}

    monkeypatch.setattr(
        installer_module,
        "_ensure_public_https",
        lambda source: urllib.parse.urlsplit(source),
    )

    def fake_clone(source, target, *, ref=""):
        seen.update(source=source, ref=ref)
        _plugin(target / "plugins" / "chosen", "chosen")

    monkeypatch.setattr(installer_module, "_clone_git", fake_clone)
    runtime = PluginInstallRuntime(profile)

    inspected = runtime.inspect(
        "https://extensions.example.test/repository.git#ref=develop&subdir=plugins/chosen"
    )

    assert seen == {"source": "https://extensions.example.test/repository.git", "ref": "develop"}
    assert inspected["candidates"][0]["name"] == "chosen"


def test_bridge_install_remove_and_restore_contract(monkeypatch, tmp_path):
    from arforge.bridge import dispatch

    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    source = _plugin(tmp_path / "source")

    inspected = dispatch(
        {"id": "inspect", "version": "1.2", "method": "plugins.install.inspect", "params": {"source": str(source)}}
    )
    installed = dispatch(
        {
            "id": "apply",
            "version": "1.2",
            "method": "plugins.install.apply",
            "params": {"token": inspected["data"]["token"], "name": "", "replace": False},
        }
    )
    removed = dispatch(
        {"id": "remove", "version": "1.2", "method": "plugins.remove", "params": {"name": "sample"}}
    )
    restored = dispatch(
        {
            "id": "restore",
            "version": "1.2",
            "method": "plugins.restore",
            "params": {"recovery_id": removed["data"]["transaction"]["recovery"]["recovery_id"]},
        }
    )

    assert installed["ok"] is True
    assert installed["data"]["plugins"]["items"][0]["managed"] is True
    assert removed["ok"] is True
    assert restored["data"]["transaction"]["enabled"] is False

    described = dispatch({"id": "describe", "version": "1.2", "method": "protocol.describe", "params": {}})
    assert "plugins.install.apply" in described["data"]["mutating_methods"]
    assert "plugins.remove" in described["data"]["mutating_methods"]


def test_cli_installs_and_removes_profile_plugin(monkeypatch, tmp_path, capsys):
    from arforge.cli import _run_plugins

    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    source = _plugin(tmp_path / "source")

    assert _run_plugins(["install", str(source)], json_output=True) == 0
    installed = json.loads(capsys.readouterr().out)
    assert installed["name"] == "sample"
    assert installed["enabled"] is False

    assert _run_plugins(["remove", "sample"], json_output=True) == 0
    removed = json.loads(capsys.readouterr().out)
    assert removed["recoverable"] is True
