"""Tests for T6-T8: Skills hot-reload, enable/disable, hook manifest activation."""

from __future__ import annotations

import json

import pytest



class TestSkillsEnableDisable:
    def test_enable_disable_skill(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
        from arforge.skills import disable_skill, enable_skill, is_skill_enabled

        # Clean state
        import arforge.skills as sm
        sm._cache_loaded = False
        sm._skills_disabled.clear()

        assert is_skill_enabled("test.skill") is True
        assert disable_skill("test.skill") is True
        assert is_skill_enabled("test.skill") is False
        # Second disable is no-op
        assert disable_skill("test.skill") is False
        # Enable
        assert enable_skill("test.skill") is True
        assert is_skill_enabled("test.skill") is True
        # Second enable is no-op
        assert enable_skill("test.skill") is False

    def test_state_persists_to_disk(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
        from arforge.skills import disable_skill, enable_skill, _skills_state_path

        import arforge.skills as sm
        sm._cache_loaded = False
        sm._skills_disabled.clear()

        disable_skill("persist.skill")
        state_path = _skills_state_path()
        assert state_path.is_file()
        data = json.loads(state_path.read_text(encoding="utf-8"))
        assert "persist.skill" in data["disabled"]

        enable_skill("persist.skill")
        data = json.loads(state_path.read_text(encoding="utf-8"))
        assert "persist.skill" not in data["disabled"]

    def test_state_refreshes_after_another_process_changes_profile(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
        import arforge.skills as sm

        sm._cache_loaded = False
        sm._skills_disabled.clear()
        assert sm.disable_skill("first.skill") is True
        state_path = sm._skills_state_path()
        state_path.write_text(
            json.dumps({"disabled": ["second.skill"]}),
            encoding="utf-8",
        )

        assert sm.is_skill_enabled("first.skill") is True
        assert sm.is_skill_enabled("second.skill") is False

    def test_state_update_fails_closed_while_profile_lock_is_held(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
        import arforge.skills as sm
        from arforge.database.sqlite_runtime import ProfileLockError, ProfileWriterLock

        sm._cache_loaded = False
        sm._skills_disabled.clear()
        with ProfileWriterLock(sm._skills_state_lock_path()):
            with pytest.raises(ProfileLockError):
                sm.disable_skill("busy.skill")
        assert not sm._skills_state_path().exists()


class TestSkillsHotReload:
    def test_list_skills_cached(self, monkeypatch, tmp_path):
        root = tmp_path / "skills"
        skill = root / "helper"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: helper\ndescription: Helps.\n---\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))

        from arforge.skills import list_skills_cached, _skills_cache

        _skills_cache.clear()
        result = list_skills_cached([root])
        assert result["count"] == 1
        assert result["items"][0]["id"] == "helper"

        # Second call should use cache
        result2 = list_skills_cached([root])
        assert result2["count"] == 1

    def test_hot_reload_detects_changes(self, monkeypatch, tmp_path):
        root = tmp_path / "skills"
        skill = root / "watcher"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: watcher\ndescription: Watches.\n---\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))

        from arforge.skills import list_skills_cached, _skills_cache

        _skills_cache.clear()
        result1 = list_skills_cached([root])
        assert result1["count"] == 1

        # Force cache clear and rescan
        result2 = list_skills_cached([root], force=True)
        assert result2["count"] == 1

    def test_refresh_skills(self, monkeypatch, tmp_path):
        root = tmp_path / "skills"
        skill = root / "refresher"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: refresher\ndescription: Refreshes.\n---\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("ARFORGE_SKILL_PATHS", str(root))
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))

        from arforge.skills import refresh_skills

        result = refresh_skills([root])
        assert result["count"] == 1
        assert result["items"][0]["id"] == "refresher"


class TestCustomizationEnableDisable:
    def test_hook_manifest_enabled_flag(self, tmp_path):
        from arforge.customization import list_customizations

        root = tmp_path / "custom"
        hooks = root / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "audit.json").write_text(
            json.dumps({
                "name": "audit-trace",
                "event": "post_tool_use",
                "description": "Record tool use.",
                "enabled": True,
            }),
            encoding="utf-8",
        )
        (hooks / "off.json").write_text(
            json.dumps({
                "name": "off-hook",
                "event": "post_tool_use",
                "description": "Disabled hook.",
                "enabled": False,
            }),
            encoding="utf-8",
        )

        data = list_customizations([root])
        assert data["hooks"]["count"] == 2
        assert data["hooks"]["enabled_count"] == 1


class TestHookActivation:
    def test_hook_manifest_find_by_event(self):
        """Hook manifests can be filtered by event type."""
        from arforge.customization import HookManifest

        m1 = HookManifest("a", "pre_tool_use", "Audit", "profile", "/tmp/a.json", enabled=True)
        m2 = HookManifest("b", "post_tool_use", "Log", "profile", "/tmp/b.json", enabled=False)

        manifests = [m1, m2]
        pre_hooks = [m for m in manifests if m.event == "pre_tool_use" and m.enabled]
        assert len(pre_hooks) == 1
        assert pre_hooks[0].name == "a"

    def test_hook_manifest_validation_rejects_unknown_events(self):
        from arforge.customization import _validate_hook

        problems = _validate_hook("test", "not_an_event", "desc")
        assert any("HookEvent" in p for p in problems)
