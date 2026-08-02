from __future__ import annotations

import json

from arforge.bridge import dispatch


def _request(method: str, params: dict | None = None) -> dict:
    return dispatch(
        {
            "id": method,
            "version": "1.2",
            "method": method,
            **({"params": params} if params is not None else {}),
        }
    )


def test_bridge_discovers_and_toggles_local_plugins_without_importing_code(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    plugin = tmp_path / "plugins" / "sample"
    plugin.mkdir(parents=True)
    (plugin / "entry.py").write_text("raise RuntimeError('must not execute during discovery')\n", encoding="utf-8")
    (plugin / "plugin.json").write_text(
        json.dumps(
            {
                "name": "sample",
                "version": "1.0.0",
                "description": "sample extension",
                "entrypoint": "entry.py:create_plugin",
                "hooks": ["before_call"],
                "enabled": True,
            }
        ),
        encoding="utf-8",
    )

    listed = _request("plugins.list")
    assert listed["ok"] is True
    assert listed["data"]["items"][0]["name"] == "sample"
    assert listed["data"]["items"][0]["enabled"] is True

    disabled = _request("plugins.set_enabled", {"name": "sample", "enabled": False})
    assert disabled["ok"] is True
    assert disabled["data"]["items"][0]["enabled"] is False
    state = json.loads((tmp_path / "config" / "plugin_state.json").read_text(encoding="utf-8"))
    assert next(iter(state["enabled_overrides"].values())) is False


def test_bridge_lists_reads_selects_and_clears_response_styles(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    styles = tmp_path / "output-styles"
    styles.mkdir()
    (styles / "concise.md").write_text(
        "---\nid: concise\nname: Concise\ndescription: Short direct answers\n---\nAnswer directly.",
        encoding="utf-8",
    )

    listed = _request("output_styles.list")
    assert listed["ok"] is True
    assert listed["data"]["active_style_id"] is None
    assert listed["data"]["items"][0]["style_id"] == "concise"

    read = _request("output_styles.read", {"style_id": "concise"})
    assert read["data"]["prompt"] == "Answer directly."

    selected = _request("output_styles.set", {"style_id": "concise"})
    assert selected["data"]["active_style_id"] == "concise"
    assert (tmp_path / "config" / "output_style.json").is_file()

    cleared = _request("output_styles.clear")
    assert cleared["data"]["active_style_id"] is None
    assert not (tmp_path / "config" / "output_style.json").exists()


def test_extension_bridge_rejects_unknown_or_invalid_targets(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

    missing_plugin = _request("plugins.set_enabled", {"name": "missing", "enabled": True})
    missing_style = _request("output_styles.set", {"style_id": "missing"})
    invalid = _request("plugins.set_enabled", {"name": "", "enabled": "yes"})

    assert missing_plugin["error"]["code"] == "PLUGIN_NOT_FOUND"
    assert missing_style["error"]["code"] == "INVALID_OUTPUT_STYLE"
    assert invalid["error"]["code"] == "INVALID_PARAMS"


def test_bridge_discovers_data_only_ui_themes_and_filters_unsafe_colors(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    themes = tmp_path / "themes"
    themes.mkdir()
    (themes / "ember.json").write_text(
        json.dumps(
            {
                "name": "ember",
                "displayName": "Ember",
                "base": "dark",
                "colors": {
                    "primary": "#FE8019",
                    "text": "#EBDBB2",
                    "unknown": "#ffffff",
                    "error": "url(javascript:alert(1))",
                },
            }
        ),
        encoding="utf-8",
    )

    response = _request("themes.list")

    assert response["ok"] is True
    theme = response["data"]["items"][0]
    assert theme["theme_id"] == "ember"
    assert theme["colors"] == {"primary": "#fe8019", "text": "#ebdbb2"}
    assert "unknown color token: unknown" in theme["problems"]
    assert "invalid color for error" in theme["problems"]


def test_bridge_lists_validated_project_agents_without_executing_project_code(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARFORGE_ENABLE_CUSTOM_AGENTS", "1")
    agents = tmp_path / ".arforge" / "agents"
    agents.mkdir(parents=True)
    (agents / "reviewer.json").write_text(
        json.dumps(
            {
                "name": "reviewer",
                "description": "Review local changes",
                "system_prompt": "Review the supplied changes and report evidence.",
                "tools": ["read_file"],
                "capabilities": ["code_review"],
            }
        ),
        encoding="utf-8",
    )
    (agents / "invalid.json").write_text('{"name":"INVALID"}', encoding="utf-8")

    response = _request("custom_agents.list")

    assert response["ok"] is True
    assert response["data"]["profiles"][0]["name"] == "reviewer"
    assert response["data"]["enabled"] is False
    assert response["data"]["workspace_trusted"] is False
    assert response["data"]["activation"] == "ARFORGE_ENABLE_CUSTOM_AGENTS=1"
    assert response["data"]["errors"][0]["path"].endswith("invalid.json")
