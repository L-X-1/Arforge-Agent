"""Canonical read-only product data exposed to every user interface."""

from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from arforge import __brand__, __version__


_SAFE_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
_SAFE_WORKTREE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _optional_string(value: Any, field: str, *, max_len: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = value.strip()
    if len(cleaned) > max_len:
        raise ValueError(f"{field} must be at most {max_len} characters")
    return cleaned


def _provided_string(params: dict[str, Any], field: str, *, max_len: int, allow_empty: bool = False) -> str | None:
    if field not in params:
        return None
    value = params[field]
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = value.strip()
    if not allow_empty and not cleaned:
        raise ValueError(f"{field} must not be empty")
    if len(cleaned) > max_len:
        raise ValueError(f"{field} must be at most {max_len} characters")
    return cleaned


def _optional_int(value: Any, field: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be an integer") from None
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return parsed


def _required_id_list(value: Any, field: str, *, maximum: int) -> list[int]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if len(value) > maximum:
        raise ValueError(f"{field} must include at most {maximum} items")
    ids: list[int] = []
    seen: set[int] = set()
    for raw_id in value:
        if isinstance(raw_id, bool):
            raise ValueError(f"{field} entries must be positive integers")
        try:
            parsed = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError(f"{field} entries must be positive integers") from None
        if parsed < 1:
            raise ValueError(f"{field} entries must be positive integers")
        if parsed not in seen:
            ids.append(parsed)
            seen.add(parsed)
    return ids


def _optional_string_list(value: Any, field: str, *, maximum: int, max_len: int) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    if len(value) > maximum:
        raise ValueError(f"{field} must include at most {maximum} items")
    items: list[str] = []
    seen: set[str] = set()
    for raw_item in value:
        if not isinstance(raw_item, str):
            raise ValueError(f"{field} entries must be strings")
        item = raw_item.strip()
        if not item:
            continue
        if len(item) > max_len:
            raise ValueError(f"{field} entries must be at most {max_len} characters")
        if item not in seen:
            seen.add(item)
            items.append(item)
    return items


class ProductService:
    """Return structured backend facts without terminal formatting or ANSI."""

    def health(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": "ok",
            "brand": __brand__,
            "version": __version__,
            "python": platform.python_version(),
            "python_supported": sys.version_info >= (3, 10),
        }

    def status(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.status import get_status
        from arforge.security_guard import sanitize_log_message

        try:
            return get_status()
        except Exception as exc:
            return {
                "brand": __brand__,
                "status": "degraded",
                "warning": sanitize_log_message(str(exc)) or "status subsystem unavailable",
            }

    def tools(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.tool_executor import list_tools

        tools = list_tools()
        return {"count": len(tools), "items": tools}

    def agents(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

        agents = [role.to_dict() for role in get_sub_agent_pool().list_roles()]
        return {"count": len(agents), "enabled": bool(agents), "items": agents}

    def subagent_roles(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.core.subagent import list_subagent_roles

        roles = list_subagent_roles()
        return {"count": len(roles), "items": roles}

    def capabilities(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.capability.capability_registry import list_capabilities

        capabilities = list_capabilities()
        return {"count": len(capabilities), "items": capabilities}

    def skills(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.skills import list_skills, list_skills_cached

        if params.get("cached"):
            return list_skills_cached()
        return list_skills()

    def skills_read(self, params: dict[str, Any]) -> dict[str, Any]:
        skill_id = _provided_string(params, "skill_id", max_len=128)
        max_chars = _optional_int(params.get("max_chars", 60000), "max_chars", minimum=1000, maximum=120000)
        from arforge.skills import read_skill

        return read_skill(skill_id or "", max_chars=max_chars)

    def skills_route(self, params: dict[str, Any]) -> dict[str, Any]:
        request = _provided_string(params, "request", max_len=100_000)
        from arforge.skill_runtime import route_skills

        return route_skills(request or "").to_dict()

    def skills_enable(self, params: dict[str, Any]) -> dict[str, Any]:
        skill_id = _provided_string(params, "skill_id", max_len=128)
        from arforge.skills import enable_skill, list_skills

        changed = enable_skill(skill_id or "")
        return {"skill_id": skill_id, "enabled": True, "changed": changed, "skills": list_skills()}

    def skills_disable(self, params: dict[str, Any]) -> dict[str, Any]:
        skill_id = _provided_string(params, "skill_id", max_len=128)
        from arforge.skills import disable_skill, list_skills

        changed = disable_skill(skill_id or "")
        return {"skill_id": skill_id, "enabled": False, "changed": changed, "skills": list_skills()}

    def skills_refresh(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.skills import refresh_skills

        return refresh_skills()

    def feature_flags(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.feature_flags import get_feature_flags

        return get_feature_flags().list()

    def feature_flag_set(self, params: dict[str, Any]) -> dict[str, Any]:
        flag_id = _provided_string(params, "flag_id", max_len=64)
        enabled = params.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        from arforge.feature_flags import FeatureFlagError, get_feature_flags

        try:
            return get_feature_flags().set_override(flag_id or "", enabled)
        except FeatureFlagError as exc:
            raise ValueError(str(exc)) from None

    def feature_flag_clear(self, params: dict[str, Any]) -> dict[str, Any]:
        flag_id = _provided_string(params, "flag_id", max_len=64)
        from arforge.feature_flags import FeatureFlagError, get_feature_flags

        try:
            return get_feature_flags().clear_override(flag_id or "")
        except FeatureFlagError as exc:
            raise ValueError(str(exc)) from None

    def feature_flag_refresh(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.feature_flags import FeatureFlagError, get_feature_flags

        try:
            return get_feature_flags().refresh_remote_config()
        except FeatureFlagError as exc:
            raise ValueError(str(exc)) from None

    def customizations(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.customization import list_customizations

        return list_customizations()

    def customizations_render(self, params: dict[str, Any]) -> dict[str, Any]:
        name = _provided_string(params, "name", max_len=64)
        args = _optional_string(params.get("args"), "args", max_len=20000)
        from arforge.customization import render_custom_command

        rendered = render_custom_command(name or "", args)
        if rendered is None:
            raise ValueError(f"custom command not found: {name}")
        return {"name": name, "rendered": rendered}

    def file_state_list(self, params: dict[str, Any]) -> dict[str, Any]:
        limit = _optional_int(params.get("limit", 100), "limit", minimum=1, maximum=1000)
        from arforge.core.file_state import get_file_state_tracker, snapshot_file

        items = []
        for observed in get_file_state_tracker().list()[:limit]:
            current = None
            missing = False
            changed = False
            try:
                current_snapshot = snapshot_file(Path(observed.path))
                current = current_snapshot.to_dict()
                changed = current_snapshot.sha256 != observed.sha256
            except OSError:
                missing = True
                changed = True
            items.append(
                {
                    "path": observed.path,
                    "observed": observed.to_dict(),
                    "current": current,
                    "changed_since_observed": changed,
                    "missing": missing,
                }
            )
        return {"count": len(items), "items": items}

    def cost_optimization(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return advisory repeated-read/context-cost opportunities."""
        limit = _optional_int(params.get("limit", 100), "limit", minimum=1, maximum=1000)
        from arforge.core.cost_optimization import build_cost_optimization_report

        return build_cost_optimization_report(limit=limit)

    def repo_scale(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return bounded large-repository scan/search telemetry."""
        root = Path.cwd().resolve()
        path = _optional_string(params.get("path", "."), "path", max_len=500) or "."
        max_files = _optional_int(params.get("max_files", 5000), "max_files", minimum=1, maximum=100000)
        limit = _optional_int(params.get("limit", 20), "limit", minimum=1, maximum=100)
        query = _optional_string(params.get("query"), "query", max_len=300)
        target = _resolve_workspace_path(root, path) if path != "." else root

        from arforge.core.large_repo import build_repo_scale_report

        return build_repo_scale_report(
            target,
            query=query,
            max_files=max_files,
            limit=limit,
        )

    def quality_assess(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return delivery quality gate results for files and optional patch text."""
        files = _optional_string_list(
            params.get("files", []),
            "files",
            maximum=200,
            max_len=500,
        )
        patch_text = _optional_string(params.get("patch_text"), "patch_text", max_len=500_000)
        from arforge.core.quality_gate import assess_quality_change

        root = Path.cwd().resolve()
        return assess_quality_change(
            files,
            patch_text=patch_text,
            resolver=lambda filename: _resolve_workspace_path(root, filename),
        )

    def permission_rules(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.permission_profile import list_rules

        return list_rules()

    def sandbox_status(self, params: dict[str, Any]) -> dict[str, Any]:
        limit = _optional_int(params.get("limit", 20), "limit", minimum=1, maximum=200)
        from arforge.security.sandbox_enforce import current_sandbox_report

        return current_sandbox_report(limit=limit)

    def permission_rule_add(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.permission_profile import add_rule, list_rules

        subject = _provided_string(params, "subject", max_len=192)
        category = _provided_string(params, "category", max_len=192)
        decision = _provided_string(params, "decision", max_len=32)
        scope = _optional_string(params.get("scope", "workspace"), "scope", max_len=192) or "workspace"
        reason = _optional_string(params.get("reason"), "reason", max_len=500)
        ttl_raw = params.get("ttl_seconds")
        ttl_seconds = None
        if ttl_raw is not None:
            ttl_seconds = _optional_int(ttl_raw, "ttl_seconds", minimum=1, maximum=86_400)
        rule = add_rule(
            subject=subject or "",
            category=category or "",
            scope=scope,
            decision=decision or "",
            reason=reason,
            ttl_seconds=ttl_seconds,
        )
        return {"schema_version": 1, "rule": rule.to_dict() | {"active": rule.active}, "rules": list_rules()}

    def permission_rule_revoke(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.permission_profile import revoke_rule

        rule_id = _provided_string(params, "rule_id", max_len=128)
        rule = revoke_rule(rule_id or "")
        return {
            "schema_version": 1,
            "rule_id": rule_id,
            "revoked": rule is not None,
            "rule": None if rule is None else rule.to_dict() | {"active": rule.active},
        }

    def permission_mode_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.core.permission import PermissionMode, get_permission_manager, install_permission_hooks

        manager = get_permission_manager()
        mode = manager.get_mode()
        if mode is None:
            # Keep routine project work flowing by default. Workspace-local edits
            # and commands run in the background, while network, system and
            # dangerous actions still require an explicit decision.
            manager.set_mode(PermissionMode.AUTO_APPROVE)
            install_permission_hooks(manager.get_mode())
            mode = manager.get_mode()
        mode_value = mode.value if isinstance(mode, PermissionMode) else mode
        return {"mode": mode_value}

    def permission_mode_set(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.core.permission import (
            PermissionMode,
            get_permission_manager,
            install_permission_hooks,
        )

        mode = params.get("mode")
        manager = get_permission_manager()
        # Normalize null/empty → deactivate (mode=None, allow everything).
        if mode is None or mode == "":
            manager.set_mode(None)
            return {"mode": None}
        if mode not in {m.value for m in PermissionMode}:
            raise ValueError(f"unknown permission mode: {mode}")
        manager.set_mode(mode)
        install_permission_hooks(manager.get_mode())
        current = manager.get_mode()
        return {"mode": current.value if isinstance(current, PermissionMode) else current}

    def config(self, _params: dict[str, Any]) -> dict[str, Any]:
        from sqlalchemy.engine import make_url

        from arforge.database.config import (
            describe_database_url,
            get_database_mode,
            get_database_url,
            get_multiagent_database_url,
        )
        from arforge.paths import get_arforge_home
        from arforge.product.model_config_runtime import get_model_config

        try:
            database_mode = get_database_mode()
            database_url = get_database_url()
            multiagent_url = get_multiagent_database_url()
            database_driver = make_url(database_url).drivername.split("+", 1)[0]
            multiagent_driver = make_url(multiagent_url).drivername.split("+", 1)[0]
            database = {
                "configured": True,
                "valid": True,
                "mode": database_mode,
                "driver": database_driver,
                "target": describe_database_url(database_url),
                "issue": None,
            }
            multiagent_configured = True
            multiagent_issue = None
        except Exception as exc:
            database_mode = os.getenv("ARFORGE_DATABASE_MODE", "auto")
            database = {
                "configured": bool(os.getenv("ARFORGE_DB_URL", "").strip()),
                "valid": False,
                "mode": database_mode,
                "driver": None,
                "target": None,
                "issue": str(exc),
            }
            multiagent_driver = None
            multiagent_configured = False
            multiagent_issue = str(exc)
        model_runtime = get_model_config()
        active_provider = model_runtime.get_active_provider()
        resolved_model = model_runtime.get_resolved_config(active_provider)
        return {
            "profile": str(get_arforge_home()),
            "provider": active_provider,
            "model": resolved_model.get("model", ""),
            "base_url": resolved_model.get("base_url", ""),
            "api_key_configured": bool(resolved_model.get("resolved")),
            "key_source": resolved_model.get("key_source", "none"),
            "model_configuration_valid": not bool(resolved_model.get("error")),
            "model_configuration_issue": resolved_model.get("error") or None,
            "configuration_authority": "model_config_runtime",
            "database": database,
            "multiagent_database_configured": multiagent_configured,
            "multiagent": {
                "available": True,
                "mode": "durable" if multiagent_configured else "ephemeral",
                "durable": multiagent_configured,
                "driver": multiagent_driver,
                "issue": multiagent_issue,
            },
        }

    def memory_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return local memories for Desktop governance without mutating them."""
        try:
            from arforge.memory import get_memory_stats, query_memories

            stats = get_memory_stats()
            items = query_memories(limit=10)
            return {
                "schema_version": 1,
                "enabled": True,
                "degraded": False,
                "issue": None,
                "stats": {
                    "count": stats["count"],
                    "important": stats["important"],
                },
                "items": items,
            }
        except Exception as exc:  # noqa: BLE001 - governance view must not brick Desktop
            return {
                "schema_version": 1,
                "enabled": False,
                "degraded": True,
                "issue": str(exc) or "memory status unavailable",
                "stats": {
                    "count": 0,
                    "important": 0,
                },
                "items": [],
            }

    def memory_search(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return a filtered local memory view without mutating memory records."""
        query = _optional_string(params.get("query"), "query", max_len=200)
        mem_type = _optional_string(params.get("mem_type"), "mem_type", max_len=60)
        tag = _optional_string(params.get("tag"), "tag", max_len=80)
        source = _optional_string(params.get("source"), "source", max_len=80)
        project_id = _optional_string(params.get("project_id"), "project_id", max_len=120)
        workspace_path = _optional_string(params.get("workspace_path"), "workspace_path", max_len=500)
        importance_min = _optional_int(params.get("importance_min", 0), "importance_min", minimum=0, maximum=5)
        limit = _optional_int(params.get("limit", 20), "limit", minimum=1, maximum=50)
        try:
            from arforge.memory import get_memory_stats, query_memories

            stats = get_memory_stats()
            items = query_memories(
                query_text=query,
                mem_type=mem_type,
                tag_filter=tag,
                source_filter=source,
                project_id=project_id,
                workspace_path=workspace_path,
                importance_min=importance_min,
                limit=limit,
            )
            return {
                "schema_version": 1,
                "enabled": True,
                "degraded": False,
                "issue": None,
                "filters": {
                    "query": query,
                    "mem_type": mem_type,
                    "tag": tag,
                    "source": source,
                    "project_id": project_id,
                    "workspace_path": workspace_path,
                    "importance_min": importance_min,
                    "limit": limit,
                },
                "stats": {
                    "count": stats["count"],
                    "important": stats["important"],
                },
                "items": items,
            }
        except Exception as exc:  # noqa: BLE001 - governance view must not brick Desktop
            return {
                "schema_version": 1,
                "enabled": False,
                "degraded": True,
                "issue": str(exc) or "memory search unavailable",
                "filters": {
                    "query": query,
                    "mem_type": mem_type,
                    "tag": tag,
                    "source": source,
                    "project_id": project_id,
                    "workspace_path": workspace_path,
                    "importance_min": importance_min,
                    "limit": limit,
                },
                "stats": {
                    "count": 0,
                    "important": 0,
                },
                "items": [],
            }

    def memory_facets(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return memory project/source/type/tag navigation facets."""
        limit = _optional_int(params.get("limit", 10000), "limit", minimum=1, maximum=20000)
        try:
            from arforge.memory import memory_facets

            return {
                **memory_facets(limit=limit),
                "enabled": True,
                "degraded": False,
                "issue": None,
            }
        except Exception as exc:  # noqa: BLE001 - advisory facets must not brick Desktop
            return {
                "schema_version": 1,
                "enabled": False,
                "degraded": True,
                "issue": str(exc) or "memory facets unavailable",
                "total": 0,
                "projects": [],
                "workspaces": [],
                "types": [],
                "sources": [],
                "tags": [],
            }

    def memory_governance_preview(self, params: dict[str, Any]) -> dict[str, Any]:
        """Preview unsafe automatic memories without changing stored data."""
        limit = _optional_int(params.get("limit", 10000), "limit", minimum=1, maximum=20000)
        sample_limit = _optional_int(params.get("sample_limit", 100), "sample_limit", minimum=0, maximum=500)
        from arforge.memory import memory_governance_audit

        return memory_governance_audit(limit=limit, sample_limit=sample_limit)

    def memory_governance_apply(self, params: dict[str, Any]) -> dict[str, Any]:
        """Apply the reversible automatic-memory quarantine policy."""
        limit = _optional_int(params.get("limit", 10000), "limit", minimum=1, maximum=20000)
        from arforge.memory import apply_memory_governance

        return apply_memory_governance(limit=limit)

    def memory_semantic_search(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return scoped local hybrid/vector memory recall."""
        query = _optional_string(params.get("query"), "query", max_len=300)
        project_id = _optional_string(params.get("project_id"), "project_id", max_len=120)
        workspace_path = _optional_string(params.get("workspace_path"), "workspace_path", max_len=500)
        top_k = _optional_int(params.get("top_k", 5), "top_k", minimum=1, maximum=20)
        limit = _optional_int(params.get("limit", 200), "limit", minimum=1, maximum=1000)
        try:
            from arforge.memory import semantic_search_memories

            return {
                **semantic_search_memories(
                    query,
                    project_id=project_id,
                    workspace_path=workspace_path,
                    top_k=top_k,
                    limit=limit,
                ),
                "enabled": True,
                "degraded": False,
                "issue": None,
            }
        except Exception as exc:  # noqa: BLE001 - advisory recall must not brick Desktop
            return {
                "schema_version": 1,
                "enabled": False,
                "degraded": True,
                "issue": str(exc) or "memory semantic search unavailable",
                "algorithm": "hybrid_bm25_hashing_vector",
                "scope": {
                    "project_id": project_id,
                    "workspace_path": workspace_path,
                    "top_k": top_k,
                    "limit": limit,
                },
                "indexed": 0,
                "items": [],
                "note": "Local hybrid memory recall using BM25 plus deterministic hashing embeddings; no external provider is required.",
            }

    def memory_recall_quality(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return deterministic local memory recall quality telemetry."""
        project_id = _optional_string(params.get("project_id"), "project_id", max_len=120)
        workspace_path = _optional_string(params.get("workspace_path"), "workspace_path", max_len=500)
        limit = _optional_int(params.get("limit", 50), "limit", minimum=1, maximum=200)
        raw_min_score = params.get("min_score", 0.01)
        if isinstance(raw_min_score, bool):
            raise ValueError("min_score must be a number")
        try:
            min_score = float(raw_min_score)
        except (TypeError, ValueError):
            raise ValueError("min_score must be a number") from None
        if min_score < 0 or min_score > 1:
            raise ValueError("min_score must be between 0 and 1")
        try:
            from arforge.semantic_memory import recall_quality_report

            report = recall_quality_report(
                limit=limit,
                project_id=project_id,
                workspace_path=workspace_path,
                min_score=min_score,
            )
            return {
                **report,
                "enabled": True,
                "degraded": False,
                "issue": None,
            }
        except Exception as exc:  # noqa: BLE001 - governance view must not brick Desktop
            return {
                "schema_version": 1,
                "enabled": False,
                "degraded": True,
                "issue": str(exc) or "memory recall quality unavailable",
                "algorithm": "bm25_self_recall",
                "scope": {
                    "project_id": project_id,
                    "workspace_path": workspace_path,
                    "limit": limit,
                    "min_score": min_score,
                },
                "indexed": 0,
                "evaluated": 0,
                "top1_hits": 0,
                "top1_hit_rate": 0.0,
                "mrr": 0.0,
                "no_result": 0,
                "examples": [],
                "note": "Operational BM25 self-recall baseline; not an external embedding benchmark.",
            }

    def memory_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        """Delete one local memory through an explicit user action."""
        raw_id = params.get("memory_id")
        if isinstance(raw_id, bool):
            raise ValueError("memory_id must be a positive integer")
        try:
            memory_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("memory_id must be a positive integer") from None
        if memory_id < 1:
            raise ValueError("memory_id must be a positive integer")

        from arforge.memory import delete_memory

        deleted = delete_memory(memory_id)
        return {
            "schema_version": 1,
            "memory_id": memory_id,
            "deleted": deleted,
            "status": "deleted" if deleted else "not_found",
        }

    def memory_bulk_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        """Delete explicit local memory IDs through an explicit user action."""
        memory_ids = _required_id_list(params.get("memory_ids"), "memory_ids", maximum=50)

        from arforge.memory import delete_memories

        result = delete_memories(memory_ids)
        return {
            "schema_version": 1,
            "requested": result["requested"],
            "deleted": len(result["deleted"]),
            "not_found": len(result["not_found"]),
            "deleted_ids": result["deleted"],
            "not_found_ids": result["not_found"],
            "status": "deleted" if result["deleted"] else "not_found",
        }

    def memory_update(self, params: dict[str, Any]) -> dict[str, Any]:
        """Edit one local memory through an explicit user action."""
        raw_id = params.get("memory_id")
        if isinstance(raw_id, bool):
            raise ValueError("memory_id must be a positive integer")
        try:
            memory_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("memory_id must be a positive integer") from None
        if memory_id < 1:
            raise ValueError("memory_id must be a positive integer")

        content = _provided_string(params, "content", max_len=4000)
        mem_type = _provided_string(params, "mem_type", max_len=50)
        tags = _provided_string(params, "tags", max_len=300, allow_empty=True)
        source = _provided_string(params, "source", max_len=50)
        importance = (
            _optional_int(params["importance"], "importance", minimum=0, maximum=5)
            if "importance" in params
            else None
        )
        if content is None and mem_type is None and tags is None and source is None and importance is None:
            raise ValueError("at least one editable memory field is required")

        from arforge.memory import update_memory_fields

        item = update_memory_fields(
            memory_id,
            content=content,
            mem_type=mem_type,
            tags=tags,
            importance=importance,
            source=source,
        )
        return {
            "schema_version": 1,
            "memory_id": memory_id,
            "updated": item is not None,
            "status": "updated" if item is not None else "not_found",
            "item": item,
        }

    def learning_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return structured learning status for Desktop and machine clients."""
        try:
            from arforge.core.dogfood import stats as dogfood_stats
            from arforge.learning_system import get_learning_system

            learning = get_learning_system()
            stats = learning.get_stats()
            impact = learning.get_injection_impact()
            patterns = learning.get_patterns(limit=5)
            recent = stats.recent_learnings
            return {
                "schema_version": 1,
                "enabled": True,
                "degraded": False,
                "issue": None,
                "stats": {
                    "total_turns": stats.total_turns,
                    "successful_turns": stats.successful_turns,
                    "failed_turns": stats.failed_turns,
                    "success_rate": stats.success_rate,
                    "patterns_discovered": stats.patterns_discovered,
                    "fix_strategies_learned": stats.fix_strategies_learned,
                    "regressions_caught": stats.regressions_caught,
                    "user_corrections": stats.user_corrections,
                    "injections_per_turn": stats.injections_per_turn,
                    "top_tags": stats.top_tags,
                },
                "recent_learnings": recent,
                "patterns": patterns,
                "injection": {
                    "participates": any(item.get("injected") for item in recent) or bool(patterns),
                    "recent_injected": sum(1 for item in recent if item.get("injected")),
                    "patterns_available": len(patterns),
                    "impact": {
                        "status": impact.status,
                        "min_sample": impact.min_sample,
                        "injected_turns": impact.injected_turns,
                        "injected_successes": impact.injected_successes,
                        "injected_success_rate": impact.injected_success_rate,
                        "baseline_turns": impact.baseline_turns,
                        "baseline_successes": impact.baseline_successes,
                        "baseline_success_rate": impact.baseline_success_rate,
                        "uplift": impact.uplift,
                    },
                },
                "dogfood": dogfood_stats(),
            }
        except Exception as exc:  # noqa: BLE001 - advisory status must never brick Desktop
            return {
                "schema_version": 1,
                "enabled": False,
                "degraded": True,
                "issue": str(exc) or "learning status unavailable",
                "stats": {
                    "total_turns": 0,
                    "successful_turns": 0,
                    "failed_turns": 0,
                    "success_rate": 0.0,
                    "patterns_discovered": 0,
                    "fix_strategies_learned": 0,
                    "regressions_caught": 0,
                    "user_corrections": 0,
                    "injections_per_turn": 0.0,
                    "top_tags": [],
                },
                "recent_learnings": [],
                "patterns": [],
                "injection": {
                    "participates": False,
                    "recent_injected": 0,
                    "patterns_available": 0,
                    "impact": {
                        "status": "unavailable",
                        "min_sample": 3,
                        "injected_turns": 0,
                        "injected_successes": 0,
                        "injected_success_rate": 0.0,
                        "baseline_turns": 0,
                        "baseline_successes": 0,
                        "baseline_success_rate": 0.0,
                        "uplift": 0.0,
                    },
                },
                "dogfood": {
                    "total": 0,
                    "passed": 0,
                    "failed": 0,
                    "success_rate": 0.0,
                    "avg_steps": 0.0,
                    "total_tokens": 0,
                    "total_cost_cny": 0.0,
                },
            }

    def learning_undo(self, params: dict[str, Any]) -> dict[str, Any]:
        """Delete one recorded learning outcome through an explicit user action."""
        raw_id = params.get("learning_id")
        if isinstance(raw_id, bool):
            raise ValueError("learning_id must be a positive integer")
        try:
            learning_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("learning_id must be a positive integer") from None
        if learning_id < 1:
            raise ValueError("learning_id must be a positive integer")

        from arforge.learning_system import get_learning_system

        result = get_learning_system().delete_outcome_with_related(learning_id)
        deleted = bool(result["deleted"])
        return {
            "schema_version": 1,
            "learning_id": learning_id,
            "deleted": deleted,
            "status": "deleted" if deleted else "not_found",
            "linked_patterns": result["linked_patterns"],
        }

    def learning_dogfood_sync(self, params: dict[str, Any]) -> dict[str, Any]:
        """Explicitly import append-only dogfood outcomes into learning records."""
        limit = _optional_int(params.get("limit", 200), "limit", minimum=1, maximum=1000)
        from arforge.core.dogfood import sync_to_learning

        return sync_to_learning(limit=limit)

    def runtime_stats(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return cost/cache/quality telemetry without leaking prompts or keys."""
        token_error: str | None = None
        dogfood_error: str | None = None
        try:
            from arforge.models.token_tracker import cumulative_usage

            tokens = cumulative_usage()
        except Exception as exc:  # noqa: BLE001 - stats must never brick the UI
            tokens = {
                "calls": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "prompt_cache_hit_tokens": 0,
                "prompt_cache_miss_tokens": 0,
                "cache_hit_rate": 0.0,
            }
            token_error = str(exc) or "token tracker unavailable"
        try:
            from arforge.core.dogfood import stats as dogfood_stats

            dogfood = dogfood_stats()
        except Exception as exc:  # noqa: BLE001 - telemetry is advisory
            dogfood = {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "success_rate": 0.0,
                "avg_steps": 0.0,
                "total_tokens": 0,
                "total_cost_cny": 0.0,
            }
            dogfood_error = str(exc) or "dogfood stats unavailable"
        return {
            "tokens": tokens,
            "dogfood": dogfood,
            "degraded": token_error is not None or dogfood_error is not None,
            "issues": {
                "tokens": token_error,
                "dogfood": dogfood_error,
            },
        }

    def self_correct_eval(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return deterministic self-correction capability eval results."""
        from arforge.core.capability_eval import report_to_dict, run_capability_eval, self_correct_eval_tasks

        report = run_capability_eval(self_correct_eval_tasks(), suite="self_correct")
        data = report_to_dict(report)
        data["schema_version"] = 1
        return data

    def runtime_metrics(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return windowed dashboard telemetry for charts and alerts."""
        from arforge.core.runtime_metrics import build_runtime_metrics

        return build_runtime_metrics(
            window_hours=int(params.get("window_hours", 24)),
            bucket=str(params.get("bucket", "hour")),
            limit=int(params.get("limit", 500)),
        )

    def workflows_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        """List validated project graph definitions without executing them."""
        from arforge.workflow_runtime import (
            WorkflowValidationError,
            discover_workflows,
            load_workflow,
        )

        workspace = Path.cwd().resolve()
        items: list[dict[str, Any]] = []
        for path in discover_workflows(workspace):
            relative = path.relative_to(workspace).as_posix()
            try:
                definition = load_workflow(path, workspace=workspace)
                items.append(
                    {
                        "path": relative,
                        "valid": True,
                        "name": definition.name,
                        "description": definition.description,
                        "schema_version": definition.schema_version,
                        "nodes": len(definition.steps),
                        "edges": sum(len(step.depends_on) for step in definition.steps),
                        "has_approval": any(
                            step.kind == "approval" for step in definition.steps
                        ),
                    }
                )
            except WorkflowValidationError as exc:
                items.append({"path": relative, "valid": False, "error": str(exc)})
        return {"schema_version": 1, "items": items, "count": len(items)}

    def workflow_preview(self, params: dict[str, Any]) -> dict[str, Any]:
        path = _provided_string(params, "path", max_len=1000)
        from arforge.workflow_runtime import load_workflow, preview_workflow

        definition = load_workflow(path or "", workspace=Path.cwd())
        return preview_workflow(definition).public() | {
            "schema_version": definition.schema_version,
            "edges": [
                {"from": dependency, "to": step.id}
                for step in definition.steps
                for dependency in step.depends_on
            ],
            "node_kinds": {step.id: step.kind for step in definition.steps},
        }

    @staticmethod
    def _workflow_graph_runtime():
        from arforge.workflow_graph_runtime import get_workflow_graph_runtime

        return get_workflow_graph_runtime()

    def workflow_graph_list(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _optional_string(
            params.get("session_id"),
            "session_id",
            max_len=256,
        )
        limit = _optional_int(params.get("limit", 50), "limit", minimum=1, maximum=200)
        return self._workflow_graph_runtime().list_runs(
            session_id=session_id,
            limit=limit,
        )

    def workflow_graph_get(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        return self._workflow_graph_runtime().get_run(run_id or "")

    def workflow_graph_events(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        after = _optional_int(
            params.get("after", 0),
            "after",
            minimum=0,
            maximum=10_000_000,
        )
        limit = _optional_int(params.get("limit", 200), "limit", minimum=1, maximum=1000)
        return self._workflow_graph_runtime().events(
            run_id or "",
            after=after,
            limit=limit,
        )

    def workflow_graph_start(self, params: dict[str, Any]) -> dict[str, Any]:
        path = _provided_string(params, "path", max_len=1000)
        session_id = _optional_string(
            params.get("session_id"),
            "session_id",
            max_len=256,
        )
        permission_mode = _optional_string(
            params.get("permission_mode", "acceptEdits"),
            "permission_mode",
            max_len=32,
        )
        max_parallel = _optional_int(
            params.get("max_parallel", 4),
            "max_parallel",
            minimum=1,
            maximum=8,
        )
        from arforge.product.goal_runtime import workspace_goal_session_id
        from arforge.product.model_config_runtime import get_model_config
        from arforge.workflow_runtime import load_workflow

        workspace = Path.cwd().resolve()
        definition = load_workflow(path or "", workspace=workspace)
        if (
            any(step.kind == "agent" for step in definition.steps)
            and not get_model_config().get_resolved_config().get("resolved")
        ):
            raise ValueError("a configured model provider is required to run agent nodes")
        runtime = self._workflow_graph_runtime()
        created = runtime.create_run(
            definition,
            session_id=session_id or workspace_goal_session_id(workspace),
            workspace=workspace,
            permission_mode=permission_mode or "acceptEdits",
            max_parallel=max_parallel,
        )
        return runtime.start(created["run_id"])

    def workflow_graph_pause(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        return self._workflow_graph_runtime().pause(run_id or "")

    def workflow_graph_resume(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        return self._workflow_graph_runtime().resume(run_id or "")

    def workflow_graph_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        return self._workflow_graph_runtime().cancel(run_id or "")

    def workflow_graph_approve(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        node_id = _provided_string(params, "node_id", max_len=64)
        approved = params.get("approved")
        if not isinstance(approved, bool):
            raise ValueError("approved must be a boolean")
        comment = _optional_string(params.get("comment"), "comment", max_len=1000)
        return self._workflow_graph_runtime().decide_approval(
            run_id or "",
            node_id or "",
            approved=approved,
            comment=comment,
        )

    def workflow_graph_retry(self, params: dict[str, Any]) -> dict[str, Any]:
        run_id = _provided_string(params, "run_id", max_len=128)
        node_id = _provided_string(params, "node_id", max_len=64)
        include_descendants = params.get("include_descendants", True)
        if not isinstance(include_descendants, bool):
            raise ValueError("include_descendants must be a boolean")
        return self._workflow_graph_runtime().retry_node(
            run_id or "",
            node_id or "",
            include_descendants=include_descendants,
        )

    def run_list(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return recent persisted agentic run report summaries."""
        limit = _optional_int(params.get("limit", 20), "limit", minimum=1, maximum=100)
        from arforge.core.run_transaction import list_run_reports

        items = list_run_reports(limit=limit)
        return {
            "schema_version": 1,
            "count": len(items),
            "items": items,
        }

    def plan_preview(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return a structured, read-only Plan Mode preview contract."""
        task = _optional_string(params.get("task"), "task", max_len=2000)
        plan_text = _optional_string(params.get("plan_text"), "plan_text", max_len=20000)
        if not task:
            raise ValueError("task must not be empty")
        if not plan_text:
            raise ValueError("plan_text must not be empty")
        explored = params.get("explored_files", [])
        if not isinstance(explored, list) or any(not isinstance(item, str) for item in explored):
            raise ValueError("explored_files must be an array of strings")
        estimated_raw = params.get("estimated_steps")
        estimated_steps = None
        if estimated_raw is not None:
            estimated_steps = _optional_int(estimated_raw, "estimated_steps", minimum=1, maximum=100)
        from arforge.core.plan_mode import build_structured_plan

        return build_structured_plan(
            task,
            plan_text,
            explored_files=explored[:50],
            estimated_steps=estimated_steps,
        )

    def run_report(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return one persisted agentic run report."""
        run_id = _optional_string(params.get("run_id"), "run_id", max_len=120)
        from arforge.core.run_transaction import build_run_report, list_replay_run_ids

        if not run_id:
            ids = list_replay_run_ids()
            if not ids:
                return {
                    "schema_version": 1,
                    "found": False,
                    "run_id": "",
                    "report": None,
                }
            run_id = ids[-1]
        try:
            report = build_run_report(run_id)
        except FileNotFoundError:
            return {
                "schema_version": 1,
                "found": False,
                "run_id": run_id,
                "report": None,
            }
        return {
            "schema_version": 1,
            "found": True,
            "run_id": run_id,
            "report": report,
        }

    def run_trace_export(self, params: dict[str, Any]) -> dict[str, Any]:
        """Export one persisted run trace as a portable versioned JSON document."""

        run_id = _optional_string(params.get("run_id"), "run_id", max_len=120)
        if not run_id:
            raise ValueError("run_id must not be empty")
        from arforge.core.run_transaction import export_run_trace

        try:
            return export_run_trace(run_id)
        except FileNotFoundError:
            return {
                "format": "json",
                "mime_type": "application/json",
                "filename": "",
                "content": "",
                "trace_events": 0,
                "found": False,
            }

    def run_trace_import(self, params: dict[str, Any]) -> dict[str, Any]:
        """Import a validated portable trace without executing or reverting it."""

        content = _optional_string(
            params.get("content"),
            "content",
            max_len=5 * 1024 * 1024,
        )
        if not content:
            raise ValueError("content must not be empty")
        from arforge.core.run_transaction import import_run_trace

        return import_run_trace(content)

    def run_revert(self, params: dict[str, Any]) -> dict[str, Any]:
        """Revert a persisted agentic run transaction."""
        run_id = _optional_string(params.get("run_id"), "run_id", max_len=120)
        if not run_id:
            raise ValueError("run_id must not be empty")
        from arforge.core.run_transaction import revert_run

        try:
            restored, deleted, skipped = revert_run(run_id)
        except FileNotFoundError:
            return {
                "schema_version": 1,
                "run_id": run_id,
                "reverted": False,
                "status": "not_found",
                "restored": 0,
                "deleted": 0,
                "skipped": 0,
            }
        return {
            "schema_version": 1,
            "run_id": run_id,
            "reverted": True,
            "status": "reverted",
            "restored": restored,
            "deleted": deleted,
            "skipped": skipped,
        }

    def release_gates(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return ordered release gate status without performing release actions."""
        from arforge.core.release_gates import build_release_gates

        return build_release_gates(Path.cwd())

    def release_remediation_plan(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return ordered remediation guidance without writing evidence files."""
        from arforge.core.release_remediation_plan import build_release_remediation_plan

        return build_release_remediation_plan(Path.cwd())

    def multimodal_diagnose(self, params: dict[str, Any]) -> dict[str, Any]:
        """Run the local screenshot/document diagnostic chain inside the workspace."""
        from arforge.feature_flags import get_feature_flags

        if not get_feature_flags().enabled("multimodal_diagnosis"):
            raise ValueError("multimodal diagnosis is disabled by feature policy")
        from arforge.core.multimodal_diagnosis import diagnose_multimodal_file

        filename = params.get("filename")
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError("filename is required")
        extracted_text = params.get("extracted_text")
        if extracted_text is not None and not isinstance(extracted_text, str):
            raise ValueError("extracted_text must be a string")
        limit = int(params.get("limit", 8))
        if limit < 1 or limit > 50:
            raise ValueError("limit must be between 1 and 50")
        root = Path.cwd().resolve()
        target = _resolve_workspace_path(root, filename)
        return diagnose_multimodal_file(
            target,
            root=root,
            extracted_text=extracted_text or None,
            max_search_results=limit,
        )

    def workspace(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return the canonical workspace root used by path-confined actions."""
        root = Path.cwd().resolve()
        return {"root": str(root), "exists": root.is_dir(), "writable": os.access(root, os.W_OK)}

    def git_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return the current Git branch surface for the desktop branch picker."""
        root = Path.cwd().resolve()
        top = _git(["rev-parse", "--show-toplevel"], root, allow_error=True)
        if top.returncode != 0:
            return {
                "available": False,
                "root": str(root),
                "current_branch": None,
                "branches": [],
                "modified_count": 0,
                "untracked_count": 0,
                "clean": True,
                "detached": False,
                "issue": "workspace is not a git repository",
            }

        branch_result = _git(["branch", "--show-current"], root, allow_error=True)
        current = branch_result.stdout.strip()
        detached = current == ""
        if detached:
            head = _git(["rev-parse", "--short", "HEAD"], root, allow_error=True).stdout.strip()
            current = head or "DETACHED"

        branches_result = _git(
            ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            root,
            allow_error=True,
        )
        branch_names = [
            line.strip()
            for line in branches_result.stdout.splitlines()
            if line.strip()
        ]
        if current and not detached and current not in branch_names:
            branch_names.append(current)
        status_result = _git(["status", "--porcelain=v1"], root, allow_error=True)
        modified_count = 0
        untracked_count = 0
        for line in status_result.stdout.splitlines():
            if line.startswith("??"):
                untracked_count += 1
            elif line.strip():
                modified_count += 1

        return {
            "available": True,
            "root": top.stdout.strip() or str(root),
            "current_branch": current,
            "branches": [
                {"name": name, "is_current": name == current}
                for name in sorted(branch_names, key=str.casefold)
            ],
            "modified_count": modified_count,
            "untracked_count": untracked_count,
            "clean": modified_count == 0 and untracked_count == 0,
            "detached": detached,
            "issue": None,
        }

    def git_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return the live working-tree diff used by the desktop Code dock."""
        max_chars = int(params.get("max_chars", 240_000))
        if max_chars < 1_000 or max_chars > 1_000_000:
            raise ValueError("max_chars must be between 1000 and 1000000")
        status = self.git_status({})
        if not status["available"]:
            return {
                "available": False,
                "root": status["root"],
                "branch": None,
                "files": [],
                "patch": "",
                "truncated": False,
                "issue": status["issue"],
            }

        root = Path(str(status["root"]))
        numstat = _git(["diff", "--no-ext-diff", "--numstat", "HEAD", "--"], root, allow_error=True)
        patch_result = _git(
            ["diff", "--no-ext-diff", "--unified=3", "--no-color", "HEAD", "--"],
            root,
            allow_error=True,
            timeout=30,
        )
        if numstat.returncode != 0 or patch_result.returncode != 0:
            message = (
                patch_result.stderr
                or numstat.stderr
                or "unable to read the working-tree diff"
            ).strip()
            raise ValueError(message)

        files: list[dict[str, Any]] = []
        known: set[str] = set()
        for line in numstat.stdout.splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            added, deleted, path = parts
            known.add(path)
            files.append({
                "path": path,
                "additions": None if added == "-" else int(added),
                "deletions": None if deleted == "-" else int(deleted),
                "untracked": False,
            })
        porcelain = _git(["status", "--porcelain=v1", "--untracked-files=all"], root, allow_error=True)
        untracked_files: list[tuple[str, dict[str, Any]]] = []
        for line in porcelain.stdout.splitlines():
            if not line.startswith("?? "):
                continue
            path = line[3:].strip()
            if path and path not in known:
                entry = {"path": path, "additions": None, "deletions": 0, "untracked": True}
                files.append(entry)
                untracked_files.append((path, entry))

        full_patch = patch_result.stdout
        canonical_root = root.resolve()
        for path, entry in untracked_files:
            candidate = (root / path).resolve()
            try:
                candidate.relative_to(canonical_root)
            except ValueError:
                continue
            if not candidate.is_file() or candidate.stat().st_size > 512_000:
                continue
            payload = candidate.read_bytes()
            if b"\0" in payload:
                continue
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError:
                continue
            lines = text.splitlines()
            entry["additions"] = len(lines)
            body = "\n".join(f"+{line}" for line in lines)
            full_patch += (
                f"diff --git a/{path} b/{path}\n"
                "new file mode 100644\n"
                "--- /dev/null\n"
                f"+++ b/{path}\n"
                f"@@ -0,0 +1,{len(lines)} @@\n"
                f"{body}\n"
            )
        truncated = len(full_patch) > max_chars
        patch = full_patch[:max_chars]
        if truncated:
            patch += "\n\n... diff truncated by Arforge ...\n"
        return {
            "available": True,
            "root": str(root),
            "branch": status["current_branch"],
            "files": files,
            "patch": patch,
            "truncated": truncated,
            "issue": None,
        }

    def git_checkout(self, params: dict[str, Any]) -> dict[str, Any]:
        """Checkout an existing branch or create a new branch with strict validation."""
        branch = str(params.get("branch", "")).strip()
        create = bool(params.get("create", False))
        if not _valid_branch_name(branch):
            raise ValueError("invalid branch name")

        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        if branch == status["current_branch"]:
            return status
        if not create and not status["clean"]:
            raise ValueError("commit or stash local changes before switching branches")

        root = Path(str(status["root"]))
        args = ["switch", "-c", branch] if create else ["switch", branch]
        result = _git(args, root, allow_error=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git switch failed").strip()
            raise ValueError(message)
        return self.git_status({})

    def git_worktree_create(self, params: dict[str, Any]) -> dict[str, Any]:
        """Create an isolated Git worktree with a new branch in a controlled path."""
        branch = _provided_string(params, "branch", max_len=128)
        if not _valid_branch_name(branch or ""):
            raise ValueError("invalid branch name")
        requested_name = _provided_string(params, "name", max_len=64)
        name = requested_name or re.sub(r"[^A-Za-z0-9._-]+", "-", branch or "")
        if not _SAFE_WORKTREE_NAME.fullmatch(name):
            raise ValueError("invalid worktree name")
        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        if not status["clean"]:
            raise ValueError("commit or stash local changes before creating a worktree")
        root = Path(str(status["root"])).resolve()
        target = (root.parent / ".arforge-worktrees" / name).resolve()
        if target.exists():
            raise ValueError("worktree destination already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        result = _git(["worktree", "add", "-b", branch or "", str(target)], root, allow_error=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git worktree creation failed").strip()
            raise ValueError(message)
        return {"root": str(target), "branch": branch, "name": name, "created": True}

    def git_worktree_prepare_remove(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Validate the active managed worktree before the desktop leaves it."""
        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        if not status["clean"]:
            raise ValueError("commit or stash local changes before removing the worktree")

        target = Path(str(status["root"])).resolve()
        common = _git(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            target,
            allow_error=True,
        )
        if common.returncode != 0:
            message = (common.stderr or common.stdout or "unable to resolve worktree owner").strip()
            raise ValueError(message)
        common_dir = Path(common.stdout.strip()).resolve()
        primary_root = common_dir.parent
        if target == primary_root:
            raise ValueError("the primary worktree cannot be removed")
        managed_root = (primary_root.parent / ".arforge-worktrees").resolve()
        if not target.is_relative_to(managed_root):
            raise ValueError("refusing to remove a worktree outside the managed directory")

        return {
            "root": str(primary_root),
            "removed_root": str(target),
            "branch": status["current_branch"],
            "ready": True,
        }

    def git_worktree_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        """Remove a managed worktree after the desktop has switched to its owner."""
        target_value = _provided_string(params, "root", max_len=4096)
        if not target_value:
            raise ValueError("root is required")
        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        primary_root = Path(str(status["root"])).resolve()
        target = Path(target_value).resolve()
        managed_root = (primary_root.parent / ".arforge-worktrees").resolve()
        if not target.is_relative_to(managed_root) or target == managed_root:
            raise ValueError("refusing to remove a worktree outside the managed directory")
        if not target.is_dir():
            raise ValueError("managed worktree no longer exists")
        target_status = _git(["status", "--porcelain=v1"], target, allow_error=True)
        if target_status.returncode != 0:
            message = (target_status.stderr or target_status.stdout or "unable to inspect worktree").strip()
            raise ValueError(message)
        if target_status.stdout.strip():
            raise ValueError("commit or stash local changes before removing the worktree")
        branch = _git(["branch", "--show-current"], target, allow_error=True).stdout.strip() or None
        result = _git(["worktree", "remove", str(target)], primary_root, allow_error=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git worktree removal failed").strip()
            raise ValueError(message)
        return {
            "root": str(primary_root),
            "removed_root": str(target),
            "branch": branch,
            "removed": True,
        }

    def methods(self) -> dict[str, Callable[[dict[str, Any]], dict[str, Any]]]:
        return {
            "health": self.health,
            "status.get": self.status,
            "tools.list": self.tools,
            "agents.list": self.agents,
            "subagents.roles": self.subagent_roles,
            "capabilities.list": self.capabilities,
            "skills.list": self.skills,
            "skills.read": self.skills_read,
            "skills.route": self.skills_route,
            "skills.enable": self.skills_enable,
            "skills.disable": self.skills_disable,
            "skills.refresh": self.skills_refresh,
            "features.list": self.feature_flags,
            "features.set": self.feature_flag_set,
            "features.clear": self.feature_flag_clear,
            "features.refresh": self.feature_flag_refresh,
            "customizations.list": self.customizations,
            "customizations.render": self.customizations_render,
            "file_state.list": self.file_state_list,
            "cost.optimization": self.cost_optimization,
            "repo.scale": self.repo_scale,
            "quality.assess": self.quality_assess,
            "permissions.rules": self.permission_rules,
            "sandbox.status": self.sandbox_status,
            "permissions.rule.add": self.permission_rule_add,
            "permissions.rule.revoke": self.permission_rule_revoke,
            "permissions.mode.get": self.permission_mode_get,
            "permissions.mode.set": self.permission_mode_set,
            "config.get": self.config,
            "memory.status": self.memory_status,
            "memory.search": self.memory_search,
            "memory.facets": self.memory_facets,
            "memory.governance.preview": self.memory_governance_preview,
            "memory.governance.apply": self.memory_governance_apply,
            "memory.semantic_search": self.memory_semantic_search,
            "memory.recall_quality": self.memory_recall_quality,
            "memory.delete": self.memory_delete,
            "memory.bulk_delete": self.memory_bulk_delete,
            "memory.update": self.memory_update,
            "learning.status": self.learning_status,
            "learning.undo": self.learning_undo,
            "learning.dogfood_sync": self.learning_dogfood_sync,
            "self_correct.eval": self.self_correct_eval,
            "runtime.stats": self.runtime_stats,
            "runtime.metrics": self.runtime_metrics,
            "workflows.list": self.workflows_list,
            "workflows.preview": self.workflow_preview,
            "workflow.graph.list": self.workflow_graph_list,
            "workflow.graph.get": self.workflow_graph_get,
            "workflow.graph.events": self.workflow_graph_events,
            "workflow.graph.start": self.workflow_graph_start,
            "workflow.graph.pause": self.workflow_graph_pause,
            "workflow.graph.resume": self.workflow_graph_resume,
            "workflow.graph.cancel": self.workflow_graph_cancel,
            "workflow.graph.approve": self.workflow_graph_approve,
            "workflow.graph.retry": self.workflow_graph_retry,
            "plan.preview": self.plan_preview,
            "run.list": self.run_list,
            "run.report": self.run_report,
            "run.trace.export": self.run_trace_export,
            "run.trace.import": self.run_trace_import,
            "run.revert": self.run_revert,
            "release.gates": self.release_gates,
            "release.remediation_plan": self.release_remediation_plan,
            "multimodal.diagnose": self.multimodal_diagnose,
            "workspace.get": self.workspace,
            "git.status": self.git_status,
            "git.diff": self.git_diff,
            "git.checkout": self.git_checkout,
            "git.worktree.create": self.git_worktree_create,
            "git.worktree.prepare_remove": self.git_worktree_prepare_remove,
            "git.worktree.remove": self.git_worktree_remove,
        }


def _git(
    args: list[str],
    cwd: Path,
    *,
    allow_error: bool = False,
    timeout: int = 8,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GIT_CEILING_DIRECTORIES"] = str(cwd.parent)
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0 and not allow_error:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result


def _valid_branch_name(value: str) -> bool:
    if not _SAFE_BRANCH.match(value):
        return False
    invalid = ("..", "@{", "\\", "//")
    return not any(part in value for part in invalid) and not value.endswith(("/", ".", ".lock"))


def _resolve_workspace_path(root: Path, value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        raise ValueError("absolute paths are not allowed")
    resolved = (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("path escapes workspace")
    return resolved
